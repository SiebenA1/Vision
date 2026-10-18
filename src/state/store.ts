import { create } from 'zustand';
import type {
  AnalysisResult,
  ChatMessage,
  DesignVariable,
  FieldKind,
  GeometryData,
  GeometryMetrics,
  ModelDocument,
  OptimizationResult,
  ToastMessage,
  ValidationResult,
  WorkspaceId,
} from '../core/types';
import type { SolveProgress } from '../core/fea/client';
import { BRACKET_MODEL, cloneModel } from '../core/presets';
import { getMaterial, massFromVolume, type MaterialSpec } from '../core/materials';
import { buildGeometry } from '../core/geometry/kernel';
import type { OptimizerProgress } from '../core/optimization/optimizer';

export type AnalysisStatus = 'idle' | 'queued' | 'mesh' | 'solve' | 'refine' | 'ready' | 'error';
export type OverlayWorkspace = 'analysis' | 'optimize' | null;

interface OptimizationSeed {
  variableKey: string;
  targetSafety: number;
  displacementLimit: number;
  autoRun: boolean;
}

interface AppState {
  model: ModelDocument;
  geometry: GeometryData | null;
  geometryMetrics: GeometryMetrics | null;
  geometryError: string | null;
  building: boolean;
  buildSeq: number;
  featureLog: string[];

  analysis: AnalysisResult | null;
  analysisStatus: AnalysisStatus;
  analysisError: string | null;
  solveProgress: SolveProgress | null;
  resultStale: boolean;
  validation: ValidationResult | null;
  validationStatus: 'idle' | 'running' | 'ready' | 'error';

  activeWorkspace: OverlayWorkspace;
  rail: WorkspaceId;
  selectedFeatureId: string;
  selectedVariableKey: string;
  leftCollapsed: boolean;
  copilotCollapsed: boolean;

  viewMode: 'design' | 'result';
  field: FieldKind;
  deformationScale: number;
  showEdges: boolean;
  showAnnotations: boolean;

  chat: ChatMessage[];
  chatBusy: boolean;

  history: Array<{ model: ModelDocument; label: string }>;
  future: Array<{ model: ModelDocument; label: string }>;

  toasts: ToastMessage[];
  optimizationSeed: OptimizationSeed;
  optimization: OptimizationResult | null;
  optimizationProgress: OptimizerProgress | null;
  optimizationStatus: 'idle' | 'running' | 'ready' | 'error';
  optimizationError: string | null;

  setGeometry: (geometry: GeometryData | null) => void;
  rebuildGeometry: () => Promise<GeometryData | null>;
  setBuilding: (building: boolean) => void;

  setVariable: (key: string, value: number, label?: string, record?: boolean) => void;
  applyRecommendedVariable: (key: string, value: number) => void;
  setMaterial: (materialId: string, record?: boolean) => void;
  setLoadMagnitude: (magnitude: number, record?: boolean) => void;
  setLoadFace: (face: ModelDocument['loads'][number]['face'], record?: boolean) => void;
  setLoadDirection: (vector: [number, number, number], record?: boolean) => void;
  setSupportFace: (face: ModelDocument['supports'][number]['face'], record?: boolean) => void;

  setAnalysis: (analysis: AnalysisResult | null) => void;
  setAnalysisStatus: (status: AnalysisStatus) => void;
  setAnalysisError: (message: string | null) => void;
  setSolveProgress: (progress: SolveProgress | null) => void;
  setValidation: (validation: ValidationResult | null) => void;
  setValidationStatus: (status: 'idle' | 'running' | 'ready' | 'error') => void;

  openWorkspace: (workspace: OverlayWorkspace) => void;
  setRail: (rail: WorkspaceId) => void;
  selectFeature: (id: string) => void;
  selectVariable: (key: string) => void;
  toggleLeft: () => void;
  toggleCopilot: () => void;

  setViewMode: (mode: 'design' | 'result') => void;
  setField: (field: FieldKind) => void;
  setDeformationScale: (scale: number) => void;
  toggleEdges: () => void;
  toggleAnnotations: () => void;

  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  setChatBusy: (busy: boolean) => void;

  undo: () => void;
  redo: () => void;

  addToast: (toast: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;

  setOptimizationSeed: (seed: Partial<OptimizationSeed>) => void;
  setOptimization: (result: OptimizationResult | null) => void;
  setOptimizationProgress: (progress: OptimizerProgress | null) => void;
  setOptimizationStatus: (status: 'idle' | 'running' | 'ready' | 'error') => void;
  setOptimizationError: (message: string | null) => void;

  resetProject: () => void;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function metricsFor(model: ModelDocument, geometry: GeometryData): GeometryMetrics {
  const material = getMaterial(model.materialId);
  return {
    volumeCm3: geometry.volumeMm3 / 1000,
    massKg: massFromVolume(geometry.volumeMm3, material.rho),
    surfaceCm2: geometry.areaMm2 / 100,
    bbox: geometry.bbox,
    triangleCount: geometry.triangleCount,
    buildMs: geometry.buildMs,
    watermark: geometry.watermark,
  };
}

const initialChat: ChatMessage[] = [
  {
    id: 'msg_seed_1',
    role: 'assistant',
    content:
      'BRK-042 已载入。7 个参数化特征、AL 6061-T6 材料与 600 N 端载边界条件已同步。\n\n我建议先做一次基线校核，再以质量最小为目标搜索悬臂厚度。你也可以直接用自然语言改变几何、载荷或材料。',
    createdAt: Date.now() - 42_000,
    meta: {
      kind: 'insight',
      chips: ['基线校核', '轻量化优化', '哪里最危险？'],
    },
  },
];

export const useAppStore = create<AppState>()((set, get) => ({
  model: cloneModel(BRACKET_MODEL),
  geometry: null,
  geometryMetrics: null,
  geometryError: null,
  building: false,
  buildSeq: 0,
  featureLog: [],

  analysis: null,
  analysisStatus: 'idle',
  analysisError: null,
  solveProgress: null,
  resultStale: false,
  validation: null,
  validationStatus: 'idle',

  activeWorkspace: null,
  rail: 'model',
  selectedFeatureId: 'arm',
  selectedVariableKey: 'armThickness',
  leftCollapsed: false,
  copilotCollapsed: false,

  viewMode: 'design',
  field: 'vonMises',
  deformationScale: 10,
  showEdges: true,
  showAnnotations: true,

  chat: initialChat,
  chatBusy: false,

  history: [],
  future: [],

  toasts: [],
  optimizationSeed: {
    variableKey: 'armThickness',
    targetSafety: 2.0,
    displacementLimit: 2.0,
    autoRun: false,
  },
  optimization: null,
  optimizationProgress: null,
  optimizationStatus: 'idle',
  optimizationError: null,

  setGeometry: (geometry) =>
    set((state) => ({
      geometry,
      geometryMetrics: geometry ? metricsFor(state.model, geometry) : null,
      geometryError: null,
      resultStale: state.analysis
        ? Boolean(geometry && state.analysis.modelHash !== geometry.watermark)
        : false,
    })),

  setBuilding: (building) => set({ building }),

  rebuildGeometry: async () => {
    const model = get().model;
    const seq = get().buildSeq + 1;
    set({ buildSeq: seq, building: true, geometryError: null });
    try {
      const { geometry, featureLog } = await buildGeometry(model);
      if (get().buildSeq !== seq) return geometry;
      set((state) => ({
        geometry,
        geometryMetrics: metricsFor(model, geometry),
        featureLog,
        building: false,
        resultStale: state.analysis ? state.analysis.modelHash !== geometry.watermark : false,
      }));
      return geometry;
    } catch (error) {
      if (get().buildSeq !== seq) return null;
      set({
        building: false,
        geometryError: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },

  setVariable: (key, value, label, record = true) => {
    const state = get();
    const variable = state.model.variables.find((item) => item.key === key);
    if (!variable) return;
    const clamped = Math.min(variable.max, Math.max(variable.min, value));
    if (Math.abs(clamped - variable.value) < 1e-9) return;
    if (record) {
      state.history.push({ model: cloneModel(state.model), label: label ?? `${variable.label} → ${clamped}` });
    }
    const model = cloneModel(state.model);
    const target = model.variables.find((item) => item.key === key) as DesignVariable;
    target.value = Number(clamped.toFixed(4));
    set({
      model,
      history: record ? [...state.history] : state.history,
      future: record ? [] : state.future,
      selectedVariableKey: key,
      selectedFeatureId:
        model.features.find((feature) => feature.variableKeys.includes(key))?.id ?? state.selectedFeatureId,
    });
  },

  applyRecommendedVariable: (key, value) => {
    get().setVariable(key, value, '应用优化推荐解', true);
  },

  setMaterial: (materialId, record = true) => {
    const state = get();
    const material = getMaterial(materialId);
    if (state.model.materialId === material.id) return;
    if (record) {
      state.history.push({ model: cloneModel(state.model), label: `材料 → ${material.shortName}` });
    }
    const model = cloneModel(state.model);
    model.materialId = material.id;
    set((current) => ({
      model,
      history: record ? [...state.history] : current.history,
      future: record ? [] : current.future,
      analysis: current.analysis,
      resultStale: Boolean(current.analysis),
      geometryMetrics: current.geometry ? metricsFor(model, current.geometry) : null,
    }));
  },

  setLoadMagnitude: (magnitude, record = true) => {
    const state = get();
    if (record) {
      state.history.push({ model: cloneModel(state.model), label: `载荷 → ${magnitude} N` });
    }
    const model = cloneModel(state.model);
    model.loads[0].magnitude = Math.max(0, magnitude);
    model.loads[0].description = `悬臂端部竖向工作载荷 · ${magnitude} N`;
    set((current) => ({
      model,
      history: record ? [...state.history] : current.history,
      future: record ? [] : current.future,
      resultStale: Boolean(current.analysis),
    }));
  },

  setLoadFace: (face, record = true) => {
    const state = get();
    if (record) {
      state.history.push({ model: cloneModel(state.model), label: `加载面 → ${face}` });
    }
    const model = cloneModel(state.model);
    model.loads[0].face = face;
    set((current) => ({
      model,
      history: record ? [...state.history] : current.history,
      future: record ? [] : current.future,
      resultStale: Boolean(current.analysis),
    }));
  },

  setLoadDirection: (vector, record = true) => {
    const state = get();
    const clean = vector.map((item) => (Math.abs(item) < 1e-9 ? 0 : Math.sign(item))) as [number, number, number];
    if (state.model.loads[0].vector.join(',') === clean.join(',')) return;
    if (record) {
      state.history.push({ model: cloneModel(state.model), label: '更新载荷方向' });
    }
    const model = cloneModel(state.model);
    model.loads[0].vector = clean;
    set((current) => ({
      model,
      history: record ? [...state.history] : current.history,
      future: record ? [] : current.future,
      resultStale: Boolean(current.analysis),
    }));
  },

  setSupportFace: (face, record = true) => {
    const state = get();
    if (state.model.supports[0].face === face) return;
    if (record) {
      state.history.push({ model: cloneModel(state.model), label: '更新约束面' });
    }
    const model = cloneModel(state.model);
    model.supports[0].face = face;
    model.supports[0].name = face === 'x-min' ? '背板固定面' : `${face} 固定`;
    set((current) => ({
      model,
      history: record ? [...state.history] : current.history,
      future: record ? [] : current.future,
      resultStale: Boolean(current.analysis),
    }));
  },

  setAnalysis: (analysis) => set({ analysis }),
  setAnalysisStatus: (analysisStatus) => set({ analysisStatus }),
  setAnalysisError: (analysisError) => set({ analysisError }),
  setSolveProgress: (solveProgress) => set({ solveProgress }),
  setValidation: (validation) => set({ validation }),
  setValidationStatus: (validationStatus) => set({ validationStatus }),

  openWorkspace: (activeWorkspace) => set({ activeWorkspace }),
  setRail: (rail) => set({ rail }),
  selectFeature: (selectedFeatureId) =>
    set((state) => ({
      selectedFeatureId,
      selectedVariableKey:
        state.model.features.find((feature) => feature.id === selectedFeatureId)?.variableKeys[0] ?? state.selectedVariableKey,
    })),
  selectVariable: (selectedVariableKey) => set({ selectedVariableKey }),
  toggleLeft: () => set((state) => ({ leftCollapsed: !state.leftCollapsed })),
  toggleCopilot: () => set((state) => ({ copilotCollapsed: !state.copilotCollapsed })),

  setViewMode: (viewMode) => set({ viewMode }),
  setField: (field) => set({ field, viewMode: 'result' }),
  setDeformationScale: (deformationScale) => set({ deformationScale }),
  toggleEdges: () => set((state) => ({ showEdges: !state.showEdges })),
  toggleAnnotations: () => set((state) => ({ showAnnotations: !state.showAnnotations })),

  addMessage: (message) => set((state) => ({ chat: [...state.chat, message] })),
  updateMessage: (id, patch) =>
    set((state) => ({
      chat: state.chat.map((message) => (message.id === id ? { ...message, ...patch } : message)),
    })),
  setChatBusy: (chatBusy) => set({ chatBusy }),

  undo: () => {
    const state = get();
    const previous = state.history[state.history.length - 1];
    if (!previous) return;
    set({
      model: previous.model,
      history: state.history.slice(0, -1),
      future: [{ model: cloneModel(state.model), label: 'redo' }, ...state.future],
      resultStale: Boolean(state.analysis),
    });
  },

  redo: () => {
    const state = get();
    const next = state.future[0];
    if (!next) return;
    set({
      model: next.model,
      future: state.future.slice(1),
      history: [...state.history, { model: cloneModel(state.model), label: 'undo' }],
      resultStale: Boolean(state.analysis),
    });
  },

  addToast: (toast) => {
    const id = uid('toast');
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
    }, 4600);
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),

  setOptimizationSeed: (seed) => set((state) => ({ optimizationSeed: { ...state.optimizationSeed, ...seed } })),
  setOptimization: (optimization) => set({ optimization }),
  setOptimizationProgress: (optimizationProgress) => set({ optimizationProgress }),
  setOptimizationStatus: (optimizationStatus) => set({ optimizationStatus }),
  setOptimizationError: (optimizationError) => set({ optimizationError }),

  resetProject: () =>
    set({
      model: cloneModel(BRACKET_MODEL),
      geometry: null,
      geometryMetrics: null,
      geometryError: null,
      analysis: null,
      analysisStatus: 'idle',
      analysisError: null,
      solveProgress: null,
      resultStale: false,
      validation: null,
      validationStatus: 'idle',
      activeWorkspace: null,
      selectedFeatureId: 'arm',
      selectedVariableKey: 'armThickness',
      history: [],
      future: [],
      viewMode: 'design',
      chat: initialChat,
      optimization: null,
      optimizationStatus: 'idle',
      optimizationProgress: null,
    }),
}));

export function currentMaterial(): MaterialSpec {
  return getMaterial(useAppStore.getState().model.materialId);
}
