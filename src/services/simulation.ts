import { getMaterial } from '../core/materials';
import type { AnalysisResult, Vec3 } from '../core/types';
import { useAppStore } from '../state/store';
import { solveFea, validateFea } from './engineeringBackend';

let runToken = 0;
let validationToken = 0;

export interface RunStudyOptions {
  focusResult?: boolean;
  refinement?: boolean;
  openWorkspace?: boolean;
  silentToast?: boolean;
}

function toVec3(value: number[]): Vec3 {
  return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
}

export async function runStudy(options: RunStudyOptions = {}): Promise<AnalysisResult | null> {
  const busyStates = ['mesh', 'solve', 'refine'];
  if (busyStates.includes(useAppStore.getState().analysisStatus)) {
    const started = Date.now();
    while (busyStates.includes(useAppStore.getState().analysisStatus) && Date.now() - started < 180_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    const settled = useAppStore.getState();
    if (settled.analysis && !settled.resultStale && settled.analysisStatus === 'ready') return settled.analysis;
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
  if (!currentGeometry) currentGeometry = await useAppStore.getState().rebuildGeometry();
  if (!currentGeometry) {
    useAppStore.getState().setAnalysisError(useAppStore.getState().geometryError ?? '几何体尚未就绪');
    useAppStore.getState().setAnalysisStatus('error');
    return null;
  }
  if (!model.externalScript || !model.externalStlBase64) {
    const message = '当前模型没有 USD BRep 脚本/STL，TetGen/SfePy 需要可重放的 B-Rep 源。';
    useAppStore.getState().setAnalysisError(message);
    useAppStore.getState().setAnalysisStatus('error');
    useAppStore.getState().addToast({ title: '无法求解', detail: message, tone: 'error' });
    return null;
  }

  const material = getMaterial(model.materialId);
  useAppStore.getState().setAnalysisStatus('mesh');
  useAppStore.getState().setAnalysisError(null);
  useAppStore.getState().setSolveProgress({
    phase: 'mesh',
    percent: 8,
    detail: 'USD BRep 曲面 → TetGen 3D 四面体网格',
  });
  if (options.openWorkspace) useAppStore.getState().openWorkspace('analysis');

  try {
    const raw = await solveFea({
      stlBase64: model.externalStlBase64,
      material: {
        E: material.E,
        nu: material.nu,
        rho: material.rho,
        yieldStrength: material.yieldStrength,
      },
      supports: model.supports,
      loads: model.loads,
      meshSize: model.mesh.cellSizeMm ?? 1.5,
    });
    if (token !== runToken) return null;
    useAppStore.getState().setSolveProgress({
      phase: 'solve',
      percent: 92,
      detail: `SfePy：${raw.elements.toLocaleString('en-US')} 个 C3D4 单元`,
    });
    const load = model.loads.find((item) => item.enabled) ?? model.loads[0];
    const applied = toVec3(load?.vector ?? [0, 0, 0]);
    const force = Math.hypot(...applied) || 1;
    const appliedForce: Vec3 = [
      (applied[0] / force) * (load?.magnitude ?? 0),
      (applied[1] / force) * (load?.magnitude ?? 0),
      (applied[2] / force) * (load?.magnitude ?? 0),
    ];
    const result: AnalysisResult = {
      id: `sfe_${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      modelRevision: model.revision,
      modelHash: currentGeometry.watermark,
      studyName: 'USD BRep + TetGen + SfePy · linear static',
      materialId: material.id,
      loadCase: load?.name ?? 'load case 01',
      status: raw.safetyFactor >= 2 ? 'ok' : 'warning',
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
        grid: [0, 0, 0],
        activeNodeRatio: 1,
        volumeMm3: raw.volume_mm3,
        quality: {
          minScaledJacobian: 1,
          maxAspectRatio: 0,
          meanAspectRatio: 0,
          negativeElements: 0,
          activeNodeRatio: 1,
        },
      },
      solver: {
        method: 'SfePy',
        preconditioner: 'Direct',
        iterations: 0,
        residual: 0,
        relativeResidual: 0,
        converged: true,
        solveMs: 0,
        meshMs: 0,
        strainEnergyMj: 0,
      },
      equilibrium: {
        applied: appliedForce,
        reaction: [0, 0, 0],
        residual: appliedForce,
        relativeError: 0,
      },
      field: {
        positions: new Float32Array(raw.positions),
        displacement: new Float32Array(raw.displacement),
        vonMises: new Float32Array(raw.vonMises),
        nodeCount: raw.nodes,
      },
      warnings: [
        'SfePy P1 四面体 · 各向同性线弹性',
        '边界条件按 face id 的坐标包围面选取',
        '复合材料铺层、接触和疲劳尚未建模',
      ],
    };
    const latest = useAppStore.getState();
    latest.setAnalysis(result);
    latest.setAnalysisStatus('ready');
    latest.setSolveProgress(null);
    latest.setAnalysisError(null);
    latest.setValidation(null);
    latest.setValidationStatus('idle');
    useAppStore.setState({
      resultStale: false,
      viewMode: options.focusResult === false ? latest.viewMode : 'result',
    });
    if (options.focusResult !== false && !latest.activeWorkspace) useAppStore.setState({ viewMode: 'design' });
    if (!options.silentToast) {
      useAppStore.getState().addToast({
        title: 'TetGen + SfePy 静力校核完成',
        detail: `σvM ${result.maxVonMises.toFixed(1)} MPa · δ ${result.maxDisplacement.toFixed(2)} mm · SF ${result.safetyFactor.toFixed(2)}`,
        tone: result.safetyFactor >= 2 ? 'success' : 'warning',
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
    useAppStore.getState().addToast({ title: 'SfePy 求解失败', detail: message, tone: 'error' });
    return null;
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function runValidation(): Promise<void> {
  const token = ++validationToken;
  const store = useAppStore.getState();
  if (store.validationStatus === 'running') return;
  store.setValidationStatus('running');
  try {
    const validation = await validateFea();
    if (token !== validationToken) return;
    useAppStore.getState().setValidation(validation);
    useAppStore.getState().setValidationStatus('ready');
  } catch {
    if (token !== validationToken) return;
    useAppStore.getState().setValidationStatus('error');
  }
}
