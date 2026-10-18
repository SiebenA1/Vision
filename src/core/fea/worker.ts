/// <reference lib="webworker" />

import type {
  Box3,
  Load,
  MeshSettings,
  Support,
} from '../types';
import type { MaterialSpec } from '../materials';
import { voxelMesh } from './mesher';
import { solveVoxelMesh, toAnalysisResult, validateCantilever } from './solver';

interface GeometryPayload {
  positions: Float32Array;
  indices: Uint32Array;
  bbox: Box3;
  volumeMm3: number;
}

interface SolveRequest {
  type: 'solve';
  requestId: string;
  geometry: GeometryPayload;
  material: MaterialSpec;
  supports: Support[];
  loads: Load[];
  meshSettings: MeshSettings;
  context: {
    modelRevision: string;
    modelHash: string;
    studyName: string;
    warnings?: string[];
  };
  refinement?: boolean;
}

interface ValidateRequest {
  type: 'validate';
  requestId: string;
}

type WorkerRequest = SolveRequest | ValidateRequest;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: unknown, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer);
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'solve') {
      handleSolve(message);
    } else if (message.type === 'validate') {
      const started = performance.now();
      const validation = validateCantilever();
      post({
        type: 'validated',
        requestId: message.requestId,
        validation,
        elapsedMs: performance.now() - started,
      });
    }
  } catch (error) {
    post({
      type: 'error',
      requestId: 'requestId' in message ? message.requestId : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
};

function handleSolve(request: SolveRequest) {
  post({
    type: 'progress',
    requestId: request.requestId,
    phase: 'mesh',
    percent: 8,
    detail: '构建体素六面体网格 / conservative boundary',
  });
  const meshStarted = performance.now();
  const mesh = voxelMesh(
    {
      ...request.geometry,
      areaMm2: 0,
      triangleCount: request.geometry.indices.length / 3,
      vertexCount: request.geometry.positions.length / 3,
      buildMs: 0,
      watermark: request.context.modelHash,
    },
    request.meshSettings.targetElements,
    request.meshSettings.cellSizeMm,
  );
  const meshMs = performance.now() - meshStarted;
  post({
    type: 'progress',
    requestId: request.requestId,
    phase: 'mesh',
    percent: 32,
    detail: `${mesh.elementCount.toLocaleString('en-US')} C3D8 · ${mesh.dofs.toLocaleString('en-US')} DOF`,
  });

  const solution = solveVoxelMesh(mesh, {
    material: request.material,
    supports: request.supports,
    loads: request.loads,
    tolerance: request.meshSettings.tolerance,
    maxIterations: request.meshSettings.maxIterations,
    onProgress: (iteration, residual) => {
      post({
        type: 'progress',
        requestId: request.requestId,
        phase: 'solve',
        percent: Math.min(94, 34 + Math.log10(iteration + 1) * 25),
        detail: `PCG ${iteration} iter · ‖r‖/‖f‖ ${residual.toExponential(2)}`,
      });
    },
  });

  const result = toAnalysisResult(solution, {
    material: request.material,
    supports: request.supports,
    loads: request.loads,
    tolerance: request.meshSettings.tolerance,
    maxIterations: request.meshSettings.maxIterations,
  }, {
    modelRevision: request.context.modelRevision,
    modelHash: request.context.modelHash,
    studyName: request.context.studyName,
    cadVolumeMm3: request.geometry.volumeMm3,
    meshMs,
    warnings: request.context.warnings,
  });

  if (request.refinement) {
    post({
      type: 'progress',
      requestId: request.requestId,
      phase: 'refine',
      percent: 95,
      detail: 'h-refinement · 1.8× 网格收敛校核',
    });
    try {
      const fineMesh = voxelMesh(
        {
          ...request.geometry,
          areaMm2: 0,
          triangleCount: request.geometry.indices.length / 3,
          vertexCount: request.geometry.positions.length / 3,
          buildMs: 0,
          watermark: request.context.modelHash,
        },
        Math.round(request.meshSettings.targetElements * 1.8),
        request.meshSettings.cellSizeMm ? request.meshSettings.cellSizeMm * 0.72 : undefined,
      );
      const fine = solveVoxelMesh(fineMesh, {
        material: request.material,
        supports: request.supports,
        loads: request.loads,
        tolerance: request.meshSettings.tolerance,
        maxIterations: request.meshSettings.maxIterations,
      });
      const delta = Math.abs(fine.maxDisplacement - solution.maxDisplacement) / Math.max(solution.maxDisplacement, 1e-9) * 100;
      result.convergence = {
        coarseMaxDisplacement: solution.maxDisplacement,
        fineMaxDisplacement: fine.maxDisplacement,
        deltaPercent: delta,
      };
      if (delta > 8) {
        result.warnings.push(`网格加密后位移变化 ${delta.toFixed(1)}%，建议继续细化。`);
        result.status = 'warning';
      }
    } catch (error) {
      result.warnings.push(`收敛校核失败：${error instanceof Error ? error.message : String(error)}`);
      result.status = 'warning';
    }
  }

  post(
    {
      type: 'result',
      requestId: request.requestId,
      result,
    },
    [
      result.field.positions.buffer,
      result.field.displacement.buffer,
      result.field.vonMises.buffer,
    ],
  );
}
