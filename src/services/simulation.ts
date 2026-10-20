import { getMaterial } from '../core/materials';
import type { AnalysisResult, Vec3 } from '../core/types';
import { useAppStore } from '../state/store';
import { base64ToUint8, parseBinaryStl } from '../core/cad/stl';
import { studyKey, studyFingerprint } from '../core/provenance';
import { EngineeringBackendError, solveFea, validateFea } from './engineeringBackend';

let runToken = 0;
let validationToken = 0;
let controller: AbortController | null = null;
let pending: { key: string; refinement: boolean; promise: Promise<AnalysisResult | null> } | null = null;

useAppStore.subscribe((state, previous) => {
  if (state.activeProjectId === previous.activeProjectId &&
      (state.model === previous.model || studyKey(state.model) === studyKey(previous.model))) return;
  if (state.activeProjectId !== previous.activeProjectId || state.model.id !== previous.model.id) validationToken += 1;
  runToken += 1;
  controller?.abort();
  controller = null;
  pending = null;
  if (['mesh', 'solve', 'refine'].includes(state.analysisStatus)) {
    useAppStore.setState({ analysisStatus: 'idle', solveProgress: null });
  }
});

export interface RunStudyOptions {
  signal?: AbortSignal;
  focusResult?: boolean;
  refinement?: boolean;
  openWorkspace?: boolean;
  silentToast?: boolean;
}

function toVec3(value: number[]): Vec3 {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
}

/** Retained output is not evidence that the latest requested run succeeded. */
export function getCurrentAnalysis(): AnalysisResult | null {
  const state = useAppStore.getState();
  return state.analysisStatus === 'ready' && !state.analysisError && !state.resultStale &&
    state.analysis?.inputFingerprint === studyFingerprint(state.model) ? state.analysis : null;
}

export function runStudy(options: RunStudyOptions = {}): Promise<AnalysisResult | null> {
  if (options.signal?.aborted) return Promise.resolve(null);
  const state = useAppStore.getState();
  const key = `${state.activeProjectId}:${studyKey(state.model)}`;
  if (pending?.key === key) {
    if (!options.refinement || pending.refinement) return pending.promise;
    return pending.promise.then((result) => {
      if (!result || options.signal?.aborted) return null;
      const latest = useAppStore.getState();
      return `${latest.activeProjectId}:${studyKey(latest.model)}` === key ? runStudy(options) : null;
    });
  }
  const promise = performStudy(options);
  pending = { key, refinement: Boolean(options.refinement), promise };
  const clearPending = () => { if (pending?.promise === promise) pending = null; };
  void promise.then(clearPending, clearPending);
  return promise;
}

async function performStudy(options: RunStudyOptions): Promise<AnalysisResult | null> {
  controller?.abort();
  const abort = new AbortController();
  controller = abort;
  const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
  const token = ++runToken;
  const { model } = useAppStore.getState();
  try {
    const currentGeometry = await useAppStore.getState().rebuildGeometry();
    if (token !== runToken || signal.aborted) return null;
    if (!currentGeometry) {
      useAppStore.getState().setAnalysisError(useAppStore.getState().geometryError ?? '几何体尚未就绪');
      useAppStore.getState().setAnalysisStatus('error');
      return null;
    }
    if (!model.cad && (!model.externalScript || !model.externalStlBase64)) {
      const message = '当前模型没有原生 CAD 制品或 STL，无法生成实体网格。';
      useAppStore.getState().setAnalysisError(message);
      useAppStore.getState().setAnalysisStatus('error');
      useAppStore.getState().addToast({ title: '无法求解', detail: message, tone: 'error' });
      return null;
    }

    const material = getMaterial(model.materialId);
    useAppStore.setState({
      analysisStatus: 'solve', analysisError: null, analysisErrorStatus: null,
      solveProgress: { phase: 'solve', percent: null,
        detail: '正在生成网格并求解，完成后将更新本轮结果。' },
    });
    if (options.openWorkspace) useAppStore.getState().openWorkspace('analysis');

    const input = {
      stlBase64: model.cad ? '' : model.externalStlBase64!,
      artifactId: model.cad?.artifactId,
      bodyIds: model.studyBodyIds,
      material: {
        E: material.E,
        nu: material.nu,
        rho: material.rho,
        yieldStrength: material.yieldStrength,
      },
      supports: model.supports,
      loads: model.loads,
      meshSize: model.mesh.cellSizeMm ?? 1.5,
    };
    const coarse = await solveFea(input, signal);
    if (token !== runToken || signal.aborted) return null;
    let raw = coarse;
    if (options.refinement) {
      useAppStore.setState({ analysisStatus: 'refine', solveProgress: { phase: 'refine', percent: null, detail: '粗网格已完成，正在以 h / 1.8 重新生成网格并求解。' } });
      raw = await solveFea({ ...input, meshSize: input.meshSize / 1.8 }, signal);
      if (token !== runToken || signal.aborted) return null;
      if (raw.h >= coarse.h || raw.elements <= coarse.elements) {
        throw new Error('加密未获得更细网格；请检查后端尺寸下限，不能宣称 h 收敛。');
      }
    }
    if (token !== runToken || signal.aborted) return null;
    const load = model.loads.find((item) => item.enabled);
    const appliedForce: Vec3 = raw.appliedForce ?? model.loads.filter((item) => item.enabled).reduce<Vec3>((sum, item) => {
      const length = Math.hypot(...item.vector) || 1;
      return sum.map((value, axis) => value + item.vector[axis] / length * item.magnitude) as Vec3;
    }, [0, 0, 0]);
    const result: AnalysisResult = {
      id: `sfe_${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      modelRevision: model.revision,
      modelHash: currentGeometry.watermark,
      inputFingerprint: studyFingerprint(model),
      surfaceGeometry: raw.surfaceStlBase64 ? parseBinaryStl(base64ToUint8(raw.surfaceStlBase64), currentGeometry.watermark) : undefined,
      boundaryEvidence: raw.boundaries,
      studyName: `USD BRep + TetGen + ${raw.solverMethod ?? 'SfePy'} · linear static`,
      materialId: material.id,
      loadCase: load?.name ?? 'load case 01',
      status: 'warning',
      maxVonMises: raw.maxVonMises,
      maxVonMisesLocation: toVec3(raw.maxVonMisesLocation),
      maxDisplacement: raw.maxDisplacement,
      maxDisplacementLocation: toVec3(raw.maxDisplacementLocation),
      safetyFactor: raw.safetyFactor,
      massKg: raw.mass_kg,
      mesh: {
        nodes: raw.nodes,
        elements: raw.elements,
        dofs: raw.dofs,
        cellSize: raw.h,
        grid: null,
        activeNodeRatio: null,
        volumeMm3: raw.volume_mm3,
        quality: {
          minScaledJacobian: raw.quality?.minScaledJacobian ?? null,
          maxAspectRatio: null,
          meanAspectRatio: null,
          negativeElements: raw.quality?.negativeElements ?? null,
          activeNodeRatio: null,
        },
      },
      solver: {
        method: raw.solverMethod ?? 'SfePy',
        algorithm: raw.solverAlgorithm ?? 'Direct',
        preconditioner: raw.preconditioner ?? 'Direct',
        iterations: raw.iterations ?? null,
        residual: null,
        relativeResidual: raw.relativeResidual ?? null,
        converged: raw.converged ?? null,
        solveMs: raw.solveMs ?? null,
        meshMs: raw.meshMs ?? null,
        strainEnergyMj: raw.strainEnergyMj ?? null,
      },
      equilibrium: {
        applied: appliedForce,
        reaction: raw.reaction ?? null,
        residual: raw.equilibriumResidual ?? null,
        relativeError: raw.equilibriumError ?? null,
      },
      field: {
        positions: new Float32Array(raw.positions),
        displacement: new Float32Array(raw.displacement),
        vonMises: new Float32Array(raw.vonMises),
        nodeCount: raw.nodes,
      },
      convergence: options.refinement ? {
        coarseMaxDisplacement: coarse.maxDisplacement,
        fineMaxDisplacement: raw.maxDisplacement,
        deltaPercent: Math.abs(raw.maxDisplacement - coarse.maxDisplacement) / Math.max(Math.abs(raw.maxDisplacement), 1e-12) * 100,
      } : undefined,
      warnings: [
        ...(raw.equilibriumError == null ? ['反力平衡、残差和能量尚未由后端提供，未验证。'] : []),
        ...(raw.quality ? ['局部峰值应力仍需网格收敛校核。'] : ['网格质量与局部应力收敛仍需核查。']),
        '默认 SF ≥ 2、位移 ≤ 2 mm 仅为界面筛选目标，需按工程需求设定。',
        ...(options.refinement ? ['两级网格位移对比不构成网格无关性证明。'] : []),
        `${raw.solverMethod ?? 'SfePy'} P1 四面体 · 各向同性线弹性`,
        '边界条件按极值面或显式空间区域选取；零件之间未隐式绑定或建立接触',
        '复合材料铺层、接触和疲劳尚未建模',
      ],
    };
    const latest = useAppStore.getState();
    useAppStore.setState({
      analysis: result, analysisStatus: 'ready', solveProgress: null, analysisError: null, analysisErrorStatus: null,
      validation: null, validationStatus: 'idle',
      resultStale: false,
      viewMode: options.focusResult === false ? latest.viewMode : 'result',
    });
    if (options.focusResult !== false && !latest.activeWorkspace) useAppStore.setState({ viewMode: 'design' });
    if (!options.silentToast) {
      useAppStore.getState().addToast({
        title: '有限元静力校核完成',
        detail: `σvM ${result.maxVonMises.toFixed(1)} MPa · δ ${result.maxDisplacement.toFixed(2)} mm · SF ${result.safetyFactor.toFixed(2)}`,
        tone: result.safetyFactor >= 2 ? 'success' : 'warning',
      });
    }
    return result;
  } catch (error) {
    if (token !== runToken) return null;
    if (signal.aborted) { useAppStore.setState({ analysisStatus: 'idle', solveProgress: null }); return null; }
    const message = error instanceof Error ? error.message : String(error);
    useAppStore.setState({ analysisError: message, analysisErrorStatus: error instanceof EngineeringBackendError ? error.status : null, analysisStatus: 'error', solveProgress: null });
    useAppStore.getState().addToast({ title: '有限元求解失败', detail: message, tone: 'error' });
    return null;
  } finally {
    if (token === runToken) {
      controller = null;
      if (['mesh', 'solve', 'refine'].includes(useAppStore.getState().analysisStatus)) {
        useAppStore.setState({ analysisStatus: 'idle', solveProgress: null });
      }
    }
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function runValidation(): Promise<void> {
  const store = useAppStore.getState();
  if (store.validationStatus === 'running') return;
  const token = ++validationToken;
  const projectId = store.activeProjectId;
  const modelId = store.model.id;
  store.setValidationStatus('running');
  try {
    const validation = await validateFea();
    if (token !== validationToken || useAppStore.getState().activeProjectId !== projectId || useAppStore.getState().model.id !== modelId) return;
    useAppStore.getState().setValidation(validation);
    useAppStore.getState().setValidationStatus('ready');
  } catch {
    if (token !== validationToken || useAppStore.getState().activeProjectId !== projectId || useAppStore.getState().model.id !== modelId) return;
    useAppStore.getState().setValidationStatus('error');
  }
}
