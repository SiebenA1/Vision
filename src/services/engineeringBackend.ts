import { isCadArtifact } from '../core/cad/schema';
import type { CadArtifact, CadBuildOptions, RegionSelection } from '../core/cad/types';
/**
 * Client for the local open-source engineering backend.
 *
 * The backend executes a caller-supplied NVIDIA USD BRep script. It is a generic
 * B-Rep CAD service; this client deliberately contains no model presets.
 */

export interface EngineeringBackendHealth {
  ok: boolean;
  cad_kernel: string;
  usd_brep: string | null;
  usd_python: string;
  tetgen: string | null;
  'scikit-fem': string | null;
  python: string;
}

export interface CadExecutionMetrics {
  volume_mm3: number;
  area_mm2: number;
  mass_kg?: number;
  density_kg_m3?: number;
  bbox_mm: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  center_mm: [number, number, number];
  triangles?: number;
  tessellation_tolerance_mm?: number;
  kernel?: string;
}

export interface CadExecutionResult {
  schema: 'vision.cad/2' | 'vision.cad/3';
  artifactId?: string;
  bodies?: CadArtifact['bodies'];
  kernelVersion?: string;
  nativeSha256?: string;
  parameters?: CadArtifact['parameters'];
  settings?: CadArtifact['settings'];
  warnings?: string[];
  metrics: CadExecutionMetrics;
  stlBase64: string;
  stlBytes: number;
}

export interface FeaSolveResult {
  schema: 'vision.fea/1';
  surfaceStlBase64?: string;
  solverMethod?: 'scikit-fem' | 'SfePy';
  solverAlgorithm?: 'Direct' | 'CG';
  preconditioner?: 'Direct' | 'Jacobi';
  iterations?: number | null;
  relativeResidual?: number;
  converged?: boolean;
  strainEnergyMj?: number;
  reaction?: [number, number, number];
  equilibriumResidual?: [number, number, number];
  equilibriumError?: number;
  appliedForce?: [number, number, number];
  solveMs?: number;
  meshMs?: number;
  quality?: { minScaledJacobian: number; negativeElements: number };
  boundaries?: Array<{ kind: string; name: string; nodes: number; facets?: number; areaMm2?: number; force?: number[] }>;
  nodes: number;
  elements: number;
  dofs: number;
  h: number;
  volume_mm3: number;
  mass_kg: number;
  maxVonMises: number;
  maxVonMisesLocation: [number, number, number];
  maxDisplacement: number;
  maxDisplacementLocation: [number, number, number];
  safetyFactor: number;
  positions: number[];
  displacement: number[];
  vonMises: number[];
  loadArea: number;
}

export interface FeaValidation {
  caseId: string;
  name: string;
  reference: number;
  computed: number;
  errorPercent: number;
  passed: boolean;
  tolerancePercent: number;
  formula: string;
  meshElements: number;
  solveMs: number;
}

export class EngineeringBackendError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status = 0, detail?: string) {
    super(message);
    this.name = 'EngineeringBackendError';
    this.status = status;
    this.detail = detail;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text for the error below.
  }
  if (!response.ok) {
    const body = payload as { error?: string; trace?: string } | null;
    throw new EngineeringBackendError(
      body?.error || `Engineering backend returned HTTP ${response.status}`,
      response.status,
      body?.trace,
    );
  }
  return payload as T;
}

export async function engineeringBackendHealth(): Promise<EngineeringBackendHealth> {
  const response = await fetch('/api/engineering/health', { cache: 'no-store' });
  return parseResponse<EngineeringBackendHealth>(response);
}

export async function executeNvidiaBrep(
  script: string,
  densityKgM3 = 2700,
  signal?: AbortSignal,
  options?: CadBuildOptions,
  sourceArtifact?: string,
): Promise<CadExecutionResult> {
  const response = await fetch('/api/engineering/cad/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, density_kg_m3: densityKgM3, options, sourceArtifact }),
    signal,
  });
  return parseResponse<CadExecutionResult>(response);
}

export interface FeaSolveInput {
  stlBase64: string;
  artifactId?: string;
  bodyIds?: string[];
  material: {
    E: number;
    nu: number;
    rho: number;
    yieldStrength: number;
  };
  supports: Array<{ face: string; enabled?: boolean; region?: RegionSelection }>;
  loads: Array<{
    face: string;
    vector: [number, number, number];
    magnitude: number;
    region?: RegionSelection;
    enabled?: boolean;
  }>;
  meshSize: number;
}

export async function solveFea(input: FeaSolveInput, signal?: AbortSignal): Promise<FeaSolveResult> {
  try {
  const response = await fetch('/api/engineering/fea/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stlBase64: input.stlBase64,
      artifactId: input.artifactId,
      bodyIds: input.bodyIds,
      material: input.material,
      supports: input.supports,
      loads: input.loads,
      mesh_size: input.meshSize,
    }),
    signal,
  });
  const result = await parseResponse<FeaSolveResult>(response);
  assertFeaResult(result);
  return result;
  } catch (error) {
    if (error instanceof TypeError && !signal?.aborted) {
      throw new EngineeringBackendError('计算连接中断，未收到本轮结果。后端可能仍在计算，请查看任务状态后再重试，避免重复提交。', 0);
    }
    throw error;
  }
}

/** A successful HTTP response is not sufficient engineering evidence. */
export function assertFeaResult(result: FeaSolveResult): void {
  const fail = () => { throw new EngineeringBackendError('Invalid or non-finite FEA result'); };
  if (!result || result.schema !== 'vision.fea/1') fail();
  for (const value of [result.nodes, result.elements, result.dofs]) {
    if (!Number.isSafeInteger(value) || value <= 0) fail();
  }
  if (result.dofs !== result.nodes * 3) fail();
  for (const [values, length] of [
    [result.positions, result.nodes * 3], [result.displacement, result.nodes * 3],
    [result.vonMises, result.nodes], [result.maxVonMisesLocation, 3], [result.maxDisplacementLocation, 3],
  ] as const) {
    if (!Array.isArray(values) || values.length !== length || !values.every(Number.isFinite)) fail();
  }
  for (const value of [result.h, result.volume_mm3, result.mass_kg, result.safetyFactor, result.loadArea]) {
    if (!Number.isFinite(value) || value <= 0) fail();
  }
  if (result.solverMethod === 'scikit-fem') {
    if (result.solverAlgorithm !== undefined && !['Direct', 'CG'].includes(result.solverAlgorithm)) fail();
    if (result.preconditioner !== undefined && !['Direct', 'Jacobi'].includes(result.preconditioner)) fail();
    if (result.iterations != null && (!Number.isSafeInteger(result.iterations) || result.iterations < 0)) fail();
    for (const value of [result.relativeResidual, result.strainEnergyMj, result.equilibriumError, result.meshMs, result.solveMs]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail();
    }
    for (const vector of [result.reaction, result.equilibriumResidual, result.appliedForce]) {
      if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) fail();
    }
    if (result.converged !== true || result.relativeResidual! > 1e-6) fail();
  }
  for (const value of [result.maxVonMises, result.maxDisplacement, ...result.vonMises]) {
    if (!Number.isFinite(value) || value < 0) fail();
  }
}

export async function validateFea(signal?: AbortSignal): Promise<FeaValidation> {
  const response = await fetch('/api/engineering/fea/validate', { method: 'POST', signal });
  return parseResponse<FeaValidation>(response);
}

export function stlBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface CadApiEntry { group: string; name: string; symbol: string; kind: string; documentation: string }
export interface CadCapabilities { version: string; python: string; groups: string[]; entries: CadApiEntry[]; total?: number; nextOffset?: number | null }
export async function queryCadApi(query = '', offset = 0): Promise<CadCapabilities> {
  return parseResponse<CadCapabilities>(await fetch(`/api/engineering/cad/capabilities?q=${encodeURIComponent(query)}&offset=${offset}`));
}
export async function importNativeCad(dataBase64: string, format: 'usd' | 'zip', densityKgM3: number): Promise<CadExecutionResult> {
  return parseResponse<CadExecutionResult>(await fetch('/api/engineering/cad/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataBase64, format, density_kg_m3: densityKgM3 }),
  }));
}
export function cadArtifactUrl(id: string, file: 'model.usda' | 'archive.zip' | 'manifest.json'): string {
  return `/api/engineering/cad/artifacts/${encodeURIComponent(id)}/${file}`;
}
export function cadArtifactFromResult(result: CadExecutionResult, sourceArtifact?: string): CadArtifact | undefined {
  if (result.schema !== 'vision.cad/3') return undefined;
  if (!result.artifactId || !result.bodies?.length || !result.kernelVersion || !result.nativeSha256 || !result.settings) {
    throw new EngineeringBackendError('CAD response is missing native artifact metadata');
  }
  const artifact: CadArtifact = { artifactId: result.artifactId, kernelVersion: result.kernelVersion, nativeSha256: result.nativeSha256,
    bodies: result.bodies, settings: result.settings, parameters: result.parameters ?? {}, warnings: result.warnings ?? [], sourceArtifact };
  if (!isCadArtifact(artifact)) throw new EngineeringBackendError('Invalid native CAD artifact');
  return artifact;
}
