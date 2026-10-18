import type { SolveProgress } from '../core/fea/client';
import { getSimulationClient } from '../core/fea/client';
import { getMaterial } from '../core/materials';
import { runOptimization, type OptimizerProgress } from '../core/optimization/optimizer';
import type { AnalysisResult, OptimizationResult } from '../core/types';
import { useAppStore } from '../state/store';

let runToken = 0;
let validationToken = 0;

function statusForPhase(phase: SolveProgress['phase']): 'mesh' | 'solve' | 'refine' {
  if (phase === 'mesh') return 'mesh';
  if (phase === 'refine') return 'refine';
  return 'solve';
}

export interface RunStudyOptions {
  focusResult?: boolean;
  refinement?: boolean;
  openWorkspace?: boolean;
  silentToast?: boolean;
}

export async function runStudy(options: RunStudyOptions = {}): Promise<AnalysisResult | null> {
  const busyStates = ['mesh', 'solve', 'refine'];
  if (busyStates.includes(useAppStore.getState().analysisStatus)) {
    const started = Date.now();
    while (busyStates.includes(useAppStore.getState().analysisStatus) && Date.now() - started < 120_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    const settled = useAppStore.getState();
    if (settled.analysis && !settled.resultStale && settled.analysisStatus === 'ready') {
      return settled.analysis;
    }
    // The in-flight result belongs to an older geometry. Fall through and run
    // a fresh solve against the current model instead of returning stale data.
  }

  const token = ++runToken;
  const { model, geometry, building } = useAppStore.getState();
  if (building) {
    await new Promise<void>((resolve) => {
      const timer = window.setInterval(() => {
        if (!useAppStore.getState().building) {
          window.clearInterval(timer);
          resolve();
        }
      }, 80);
    });
  }
  let currentGeometry = geometry ?? useAppStore.getState().geometry;
  if (!currentGeometry) {
    currentGeometry = await useAppStore.getState().rebuildGeometry();
  }
  if (!currentGeometry) {
    useAppStore.getState().setAnalysisError(useAppStore.getState().geometryError ?? '几何体尚未就绪');
    useAppStore.getState().setAnalysisStatus('error');
    return null;
  }
  const material = getMaterial(model.materialId);
  const client = getSimulationClient();
  useAppStore.getState().setAnalysisStatus('mesh');
  useAppStore.getState().setAnalysisError(null);
  useAppStore.getState().setSolveProgress({
    phase: 'mesh',
    percent: 4,
    detail: '将 watertight 表面送入体素网格器',
  });
  if (options.openWorkspace) useAppStore.getState().openWorkspace('analysis');

  try {
    const result = await client.solve(currentGeometry, model, material, {
      refinement: options.refinement,
      onProgress: (progress) => {
        if (token !== runToken) return;
        useAppStore.getState().setSolveProgress(progress);
        useAppStore.getState().setAnalysisStatus(statusForPhase(progress.phase));
      },
    });
    if (token !== runToken) return null;
    const latest = useAppStore.getState();
    const stale = latest.geometry ? result.modelHash !== latest.geometry.watermark : true;
    latest.setAnalysis(result);
    latest.setAnalysisStatus('ready');
    latest.setSolveProgress(null);
    latest.setAnalysisError(null);
    useAppStore.setState({
      resultStale: stale,
      viewMode: options.focusResult === false ? latest.viewMode : 'result',
    });
    if (options.focusResult !== false && !latest.activeWorkspace) {
      // Keep the main stage in design mode unless the user explicitly opens analysis.
      useAppStore.setState({ viewMode: 'design' });
    }
    if (!options.silentToast) {
      useAppStore.getState().addToast({
        title: '静力校核完成',
        detail: `σvM ${result.maxVonMises.toFixed(1)} MPa · δ ${result.maxDisplacement.toFixed(2)} mm · SF ${result.safetyFactor.toFixed(2)}`,
        tone: result.safetyFactor >= 2.0 ? 'success' : 'warning',
      });
    }
    void runValidation();
    return result;
  } catch (error) {
    if (token !== runToken) return null;
    const message = error instanceof Error ? error.message : String(error);
    useAppStore.getState().setAnalysisError(message);
    useAppStore.getState().setAnalysisStatus('error');
    useAppStore.getState().setSolveProgress(null);
    useAppStore.getState().addToast({
      title: '求解失败',
      detail: message,
      tone: 'error',
    });
    return null;
  }
}

export async function runValidation(): Promise<void> {
  const token = ++validationToken;
  const store = useAppStore.getState();
  if (store.validationStatus === 'running') return;
  store.setValidationStatus('running');
  try {
    const validation = await getSimulationClient().validate();
    if (token !== validationToken) return;
    useAppStore.getState().setValidation(validation);
    useAppStore.getState().setValidationStatus('ready');
  } catch {
    if (token !== validationToken) return;
    useAppStore.getState().setValidationStatus('error');
  }
}

export async function runOptimizationStudy(options?: {
  variableKey?: string;
  targetSafety?: number;
  displacementLimit?: number;
  autoApply?: boolean;
}): Promise<OptimizationResult | null> {
  const store = useAppStore.getState();
  if (store.optimizationStatus === 'running') return store.optimization;
  const seed = store.optimizationSeed;
  const variableKey = options?.variableKey ?? seed.variableKey;
  const targetSafety = options?.targetSafety ?? seed.targetSafety;
  const displacementLimit = options?.displacementLimit ?? seed.displacementLimit;
  store.setOptimizationStatus('running');
  store.setOptimizationError(null);
  store.setOptimizationProgress({
    stage: 'baseline',
    completed: 0,
    total: 10,
    message: '建立 FE-in-the-loop 搜索空间',
  });
  try {
    const result = await runOptimization(store.model, {
      variableKey,
      targetSafety,
      displacementLimit,
      onProgress: (progress: OptimizerProgress) => {
        useAppStore.getState().setOptimizationProgress(progress);
      },
    });
    const latest = useAppStore.getState();
    latest.setOptimization(result);
    latest.setOptimizationStatus('ready');
    latest.addToast({
      title: result.recommended ? '优化完成' : '优化完成 · 无可行解',
      detail: result.recommended
        ? `${result.variableLabel} = ${result.recommended.value} mm · 质量 ${result.recommended.massKg.toFixed(3)} kg`
        : '当前边界内无满足约束的解，请放宽目标或扩展设计空间。',
      tone: result.recommended ? 'success' : 'warning',
    });
    return result;
  } catch (error) {
    const latest = useAppStore.getState();
    latest.setOptimizationStatus('error');
    latest.setOptimizationError(error instanceof Error ? error.message : String(error));
    latest.addToast({
      title: '优化失败',
      detail: error instanceof Error ? error.message : String(error),
      tone: 'error',
    });
    return null;
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
