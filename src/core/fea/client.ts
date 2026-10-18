import type {
  AnalysisResult,
  GeometryData,
  MeshSettings,
  ModelDocument,
  ValidationResult,
} from '../types';
import type { MaterialSpec } from '../materials';
import { getMaterial } from '../materials';

export interface SolveProgress {
  phase: 'mesh' | 'solve' | 'refine';
  percent: number;
  detail: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onProgress?: (progress: SolveProgress) => void;
}

interface SolveOptions {
  refinement?: boolean;
  meshOverride?: Partial<MeshSettings>;
  onProgress?: (progress: SolveProgress) => void;
  studyName?: string;
}

export class SimulationClient {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();
  private sequence = 0;

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent) => {
        const message = event.data as Record<string, unknown>;
        const requestId = String(message.requestId ?? '');
        const entry = this.pending.get(requestId);
        if (!entry) return;
        if (message.type === 'progress') {
          entry.onProgress?.({
            phase: message.phase as SolveProgress['phase'],
            percent: Number(message.percent),
            detail: String(message.detail),
          });
          return;
        }
        if (message.type === 'error') {
          this.pending.delete(requestId);
          entry.reject(new Error(String(message.message)));
          return;
        }
        if (message.type === 'result') {
          this.pending.delete(requestId);
          entry.resolve(message.result);
          return;
        }
        if (message.type === 'validated') {
          this.pending.delete(requestId);
          entry.resolve(message.validation);
        }
      };
      this.worker.onerror = (event) => {
        const error = new Error(event.message || 'FEA worker crashed');
        for (const entry of this.pending.values()) entry.reject(error);
        this.pending.clear();
      };
    }
    return this.worker;
  }

  solve(
    geometry: GeometryData,
    model: ModelDocument,
    material: MaterialSpec,
    options: SolveOptions = {},
  ): Promise<AnalysisResult> {
    const worker = this.ensureWorker();
    const requestId = `solve_${Date.now()}_${this.sequence++}`;
    const meshSettings: MeshSettings = {
      ...model.mesh,
      ...options.meshOverride,
    };
    return new Promise<AnalysisResult>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as AnalysisResult),
        reject,
        onProgress: options.onProgress,
      });
      const positions = geometry.positions.slice();
      const indices = geometry.indices.slice();
      worker.postMessage(
        {
          type: 'solve',
          requestId,
          geometry: {
            positions,
            indices,
            bbox: geometry.bbox,
            volumeMm3: geometry.volumeMm3,
          },
          material: getMaterial(material.id),
          supports: model.supports,
          loads: model.loads,
          meshSettings,
          context: {
            modelRevision: model.revision,
            modelHash: geometry.watermark,
            studyName: options.studyName ?? 'LC-01 · 线性静力',
          },
          refinement: options.refinement ?? false,
        },
        [positions.buffer, indices.buffer],
      );
    });
  }

  validate(): Promise<ValidationResult> {
    const worker = this.ensureWorker();
    const requestId = `validate_${Date.now()}_${this.sequence++}`;
    return new Promise<ValidationResult>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as ValidationResult),
        reject,
      });
      worker.postMessage({ type: 'validate', requestId });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.pending.values()) {
      entry.reject(new Error('Simulation client disposed'));
    }
    this.pending.clear();
  }
}

let sharedClient: SimulationClient | null = null;

export function getSimulationClient(): SimulationClient {
  if (!sharedClient) sharedClient = new SimulationClient();
  return sharedClient;
}
