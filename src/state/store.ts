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
  ProjectRecord,
  SolidFeature,
  SolidShape,
  ToastMessage,
  ValidationResult,
  WorkspaceId,
} from '../core/types';
import type { SolveProgress } from '../core/fea/client';
import { BRACKET_MODEL, cloneModel } from '../core/presets';
import {
  isModelDocument,
  loadProjectLibrary,
  makeProjectRecord,
  nextProjectCode,
  persistProjectLibrary,
} from '../core/projects';
import { createBlankModel, createStarterModel, createBrakePedalModel, csgFeatures } from '../core/templates';
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
  projects: ProjectRecord[];
  activeProjectId: string;
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
  agentSource: 'local' | 'deepseek' | null;

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

  syncProject: () => void;
  switchProject: (id: string, preserveChat?: boolean) => void;
  createProject: (name: string, code: string) => boolean;
  createBlankProject: (name: string, code: string) => boolean;
  createBrakePedalProject: (preserveChat?: boolean) => void;
  initializeStarter: (template: 'plate' | 'block' | 'cylinder') => void;
  addSolidFeature: (
    shape: SolidShape,
    operation: 'add' | 'subtract',
    overrides?: Partial<Omit<SolidFeature, 'id' | 'shape' | 'operation'>>,
  ) => void;
  updateSolidFeature: (id: string, patch: Partial<SolidFeature>) => void;
  deleteSolidFeature: (id: string) => void;
  duplicateProject: (id: string) => void;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string, code: string) => void;
  importProject: (model: ModelDocument) => boolean;

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
  setAgentSource: (source: 'local' | 'deepseek' | null) => void;

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

const initialLibrary = loadProjectLibrary();
const initialProject =
  initialLibrary.projects.find((project) => project.id === initialLibrary.activeProjectId) ??
  initialLibrary.projects[0];
const initialModel = cloneModel(initialProject.model);

function chatSeedFor(model: ModelDocument): ChatMessage[] {
  const template = model.template ?? 'bracket';
  const blank = template === 'empty';
  const starter = template === 'plate' || template === 'block' || template === 'cylinder';
  const csg = template === 'csg';
  const solidCount = model.solidFeatures?.length ?? 0;
  const content = blank
    ? `${model.code} · ${model.name} 空白工程已创建。当前没有几何体。\n\n请在左侧选择 **基础板 / 基础块 / 圆柱体**，设置材料、边界条件与载荷，然后运行第一次静力校核。`
    : csg
      ? `${model.code} · ${model.name} 已载入。CSG 特征图包含 **${solidCount} 个实体/切除特征**，材料 ${getMaterial(model.materialId).shortName}，固定 ${model.supports[0]?.face ?? '—'}，载荷 ${model.loads[0]?.face ?? '—'} · ${model.loads[0]?.magnitude ?? 0} N。\n\n可运行基线校核、追问危险区域，或继续叠加特征。`
      : starter
        ? `${model.code} · ${model.name} 已载入。基础体 ${model.variables.map((variable) => `${variable.label} ${variable.value} mm`).join(' · ')}；材料 ${getMaterial(model.materialId).shortName}，顶面载荷 ${model.loads[0]?.magnitude ?? 0} N。\n\n下一步：运行基线校核，或继续在参数面板中调整几何。`
        : `${model.code} · ${model.name} 已载入。${model.variables.length} 个参数化变量、${getMaterial(model.materialId).shortName} 材料与 ${model.loads[0]?.magnitude ?? 0} N 端载边界条件已同步。\n\n我建议先做一次基线校核，再以质量最小为目标搜索悬臂厚度。你也可以直接用自然语言改变几何、载荷或材料。`;
  return [
    {
      id: `msg_seed_${Date.now().toString(36)}`,
      role: 'assistant',
      content,
      createdAt: Date.now() - 42_000,
      meta: {
        kind: 'insight',
        chips: blank ? [] : csg ? ['应力集中在哪？', '检查结构风险', '继续加特征'] : ['基线校核', '轻量化优化', '哪里最危险？'],
      },
    },
  ];
}

function freshAnalysisState() {
  return {
    analysis: null,
    analysisStatus: 'idle' as const,
    analysisError: null,
    solveProgress: null,
    resultStale: false,
    validation: null,
    validationStatus: 'idle' as const,
    geometry: null,
    geometryMetrics: null,
    geometryError: null,
    building: false,
    featureLog: [] as string[],
    viewMode: 'design' as const,
    history: [],
    future: [],
    optimization: null,
    optimizationProgress: null,
    optimizationStatus: 'idle' as const,
    optimizationError: null,
    activeWorkspace: null,
    chatBusy: false,
    agentSource: null as 'local' | 'deepseek' | null,
  };
}

export const useAppStore = create<AppState>()((set, get) => ({
  model: initialModel,
  projects: initialLibrary.projects,
  activeProjectId: initialProject.id,
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

  chat: chatSeedFor(initialModel),
  chatBusy: false,
  agentSource: null,

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
    if ((model.template ?? 'bracket') === 'empty') {
      set({
        buildSeq: seq,
        geometry: null,
        geometryMetrics: null,
        geometryError: null,
        featureLog: [],
        building: false,
        resultStale: false,
      });
      return null;
    }
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

  syncProject: () => {
    const state = get();
    if (!state.activeProjectId) return;
    const now = new Date().toISOString();
    const projects = state.projects.map((project) =>
      project.id === state.activeProjectId
        ? { ...project, model: cloneModel(state.model), updatedAt: now }
        : project,
    );
    set({ projects });
    persistProjectLibrary(projects, state.activeProjectId);
  },

  switchProject: (id, preserveChat = false) => {
    const state = get();
    if (id === state.activeProjectId) return;
    const now = new Date().toISOString();
    const withCurrent = state.projects.map((project) =>
      project.id === state.activeProjectId
        ? { ...project, model: cloneModel(state.model), updatedAt: now }
        : project,
    );
    const target = withCurrent.find((project) => project.id === id);
    if (!target) return;
    const model = cloneModel(target.model);
    set({
      ...freshAnalysisState(),
      model,
      projects: withCurrent,
      activeProjectId: target.id,
      selectedFeatureId:
        model.solidFeatures?.[0]?.id ??
        model.features.find((feature) => feature.id === 'arm')?.id ??
        model.features[0]?.id ??
        'base',
      selectedVariableKey:
        model.variables.find((variable) => variable.key === 'armThickness')?.key ??
        model.variables[0]?.key ??
        '',
      chat: preserveChat ? state.chat.slice(-2) : chatSeedFor(model),
    });
    persistProjectLibrary(withCurrent, target.id);
    window.setTimeout(() => {
      void get().rebuildGeometry();
    }, 0);
  },

  createProject: (name, code) => {
    const state = get();
    const cleanName = name.trim() || '未命名支架';
    const cleanCode = (code.trim() || nextProjectCode(state.projects)).toUpperCase();
    if (state.projects.some((project) => project.model.code === cleanCode)) {
      get().addToast({ title: '项目编号已存在', detail: cleanCode, tone: 'warning' });
      return false;
    }
    const model = cloneModel(state.model);
    model.id = `mdl_${Date.now().toString(36)}`;
    model.code = cleanCode;
    model.name = cleanName;
    model.revision = 'R01';
    model.subtitle = 'New parametric bracket project';
    model.meta.created = new Date().toISOString().slice(0, 10);
    const record = makeProjectRecord(model);
    set({ projects: [...state.projects, record] });
    get().switchProject(record.id);
    return true;
  },

  createBlankProject: (name, code) => {
    const state = get();
    const cleanName = name.trim() || '空白工程';
    const cleanCode = (code.trim() || nextProjectCode(state.projects)).toUpperCase();
    if (state.projects.some((project) => project.model.code === cleanCode)) {
      get().addToast({ title: '项目编号已存在', detail: cleanCode, tone: 'warning' });
      return false;
    }
    const model = createBlankModel(cleanName, cleanCode);
    const record = makeProjectRecord(model);
    set({ projects: [...state.projects, record] });
    get().switchProject(record.id);
    return true;
  },

  initializeStarter: (template) => {
    const state = get();
    const model = createStarterModel(template, state.model);
    const projects = state.projects.map((project) =>
      project.id === state.activeProjectId
        ? { ...project, model: cloneModel(model), updatedAt: new Date().toISOString() }
        : project,
    );
    const starterLabel = template === 'plate' ? '基础板' : template === 'block' ? '基础块' : '圆柱体';
    const systemMessage: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: `已添加 **${starterLabel}**。${model.variables.map((variable) => `${variable.label} ${variable.value} mm`).join(' · ')}。\n\n可运行基线校核，或继续修改参数。`,
      createdAt: Date.now(),
      meta: { kind: 'insight', source: 'system' },
    };
    set({
      ...freshAnalysisState(),
      model,
      projects,
      activeProjectId: state.activeProjectId,
      selectedFeatureId: 'base',
      selectedVariableKey: model.variables[0]?.key ?? 'length',
      chat: [...state.chat, systemMessage],
    });
    persistProjectLibrary(projects, state.activeProjectId);
    window.setTimeout(() => {
      void get().rebuildGeometry();
    }, 0);
  },

  createBrakePedalProject: (preserveChat = false) => {
    const state = get();
    let index = 1;
    const codes = new Set(state.projects.map((project) => project.model.code));
    while (codes.has(`PEDAL-${String(index).padStart(2, '0')}`)) index += 1;
    const code = `PEDAL-${String(index).padStart(2, '0')}`;
    const model = createBrakePedalModel(code, '刹车踏板支架');
    const record = makeProjectRecord(model);
    set({ projects: [...state.projects, record] });
    get().switchProject(record.id, preserveChat);
  },

  addSolidFeature: (shape, operation, overrides) => {
    const state = get();
    if ((state.model.template ?? 'bracket') !== 'csg') return;
    const current = state.model.solidFeatures ?? [];
    const index = current.length + 1;
    const shapeName = shape === 'box' ? '方块' : shape === 'cylinder' ? '圆柱' : '球体';
    const feature: SolidFeature = {
      id: `sf_${Date.now().toString(36)}_${index}`,
      name: `${operation === 'subtract' ? '切除' : ''}${shapeName} ${index}`,
      shape,
      operation,
      enabled: true,
      position: [65, 0, 45],
      rotation: [0, 0, 0],
      size: [40, 30, 20],
      radius: shape === 'sphere' ? 18 : 15,
      height: 40,
      axis: 'z',
      ...overrides,
    };
    const solidFeatures = [...current, feature];
    const model = cloneModel(state.model);
    model.solidFeatures = solidFeatures;
    model.features = csgFeatures(solidFeatures);
    state.history.push({ model: cloneModel(state.model), label: `${feature.name} · ${operation === 'subtract' ? '切除' : '添加'}` });
    set({
      model,
      history: [...state.history],
      future: [],
      selectedFeatureId: feature.id,
    });
  },

  updateSolidFeature: (id, patch) => {
    const state = get();
    const current = state.model.solidFeatures ?? [];
    if (!current.some((feature) => feature.id === id)) return;
    const solidFeatures = current.map((feature) =>
      feature.id === id ? { ...feature, ...patch, id: feature.id } : feature,
    );
    const model = cloneModel(state.model);
    model.solidFeatures = solidFeatures;
    model.features = csgFeatures(solidFeatures);
    set({ model, selectedFeatureId: id });
  },

  deleteSolidFeature: (id) => {
    const state = get();
    const current = state.model.solidFeatures ?? [];
    if (current.length <= 1) {
      get().addToast({ title: '至少保留一个 CSG 特征', tone: 'warning' });
      return;
    }
    const solidFeatures = current.filter((feature) => feature.id !== id);
    const model = cloneModel(state.model);
    model.solidFeatures = solidFeatures;
    model.features = csgFeatures(solidFeatures);
    state.history.push({ model: cloneModel(state.model), label: '删除 CSG 特征' });
    set({
      model,
      history: [...state.history],
      future: [],
      selectedFeatureId:
        state.selectedFeatureId === id ? solidFeatures[0]?.id ?? '' : state.selectedFeatureId,
    });
  },

  duplicateProject: (id) => {
    const state = get();
    const source = state.projects.find((project) => project.id === id);
    if (!source) return;
    let suffix = 1;
    let code = `${source.model.code}-C`;
    const codes = new Set(state.projects.map((project) => project.model.code));
    while (codes.has(code)) {
      suffix += 1;
      code = `${source.model.code}-C${suffix}`;
    }
    const model = cloneModel(source.model);
    model.id = `mdl_${Date.now().toString(36)}`;
    model.code = code;
    model.name = `${source.model.name} 副本`;
    model.revision = 'R01';
    model.meta.created = new Date().toISOString().slice(0, 10);
    const record = makeProjectRecord(model);
    set({ projects: [...state.projects, record] });
    get().switchProject(record.id);
  },

  deleteProject: (id) => {
    get().syncProject();
    const state = get();
    if (state.projects.length <= 1) {
      get().addToast({ title: '至少保留一个项目', tone: 'warning' });
      return;
    }
    const remaining = state.projects.filter((project) => project.id !== id);
    if (id !== state.activeProjectId) {
      set({ projects: remaining });
      persistProjectLibrary(remaining, state.activeProjectId);
      return;
    }
    const fallback = remaining[0];
    const model = cloneModel(fallback.model);
    set({
      ...freshAnalysisState(),
      model,
      projects: remaining,
      activeProjectId: fallback.id,
      selectedFeatureId:
        model.solidFeatures?.[0]?.id ??
        model.features.find((feature) => feature.id === 'arm')?.id ??
        model.features[0]?.id ??
        'base',
      selectedVariableKey:
        model.variables.find((variable) => variable.key === 'armThickness')?.key ??
        model.variables[0]?.key ??
        '',
      chat: chatSeedFor(model),
    });
    persistProjectLibrary(remaining, fallback.id);
    window.setTimeout(() => {
      void get().rebuildGeometry();
    }, 0);
  },

  renameProject: (id, name, code) => {
    const state = get();
    const cleanName = name.trim();
    const cleanCode = code.trim().toUpperCase();
    if (!cleanName || !cleanCode) return;
    if (state.projects.some((project) => project.id !== id && project.model.code === cleanCode)) {
      get().addToast({ title: '项目编号已存在', detail: cleanCode, tone: 'warning' });
      return;
    }
    const now = new Date().toISOString();
    const projects = state.projects.map((project) =>
      project.id === id
        ? {
            ...project,
            updatedAt: now,
            model: { ...cloneModel(project.model), name: cleanName, code: cleanCode },
          }
        : project,
    );
    if (id === state.activeProjectId) {
      const model = cloneModel(state.model);
      model.name = cleanName;
      model.code = cleanCode;
      set({ model, projects });
    } else {
      set({ projects });
    }
    persistProjectLibrary(projects, state.activeProjectId);
  },

  importProject: (model) => {
    if (!isModelDocument(model)) {
      get().addToast({ title: '导入失败', detail: '文件不是 VISION model/1 文档。', tone: 'error' });
      return false;
    }
    const state = get();
    const imported = cloneModel(model);
    imported.id = imported.id || `mdl_${Date.now().toString(36)}`;
    if (state.projects.some((project) => project.model.code === imported.code)) {
      imported.code = `${imported.code}-I`;
    }
    const record = makeProjectRecord(imported);
    set({ projects: [...state.projects, record] });
    get().switchProject(record.id);
    return true;
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
  setAgentSource: (agentSource) => set({ agentSource }),

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

  resetProject: () => {
    const state = get();
    const model = cloneModel(BRACKET_MODEL);
    const projects = state.projects.map((project) =>
      project.id === state.activeProjectId
        ? { ...project, model: cloneModel(model), updatedAt: new Date().toISOString() }
        : project,
    );
    set({
      ...freshAnalysisState(),
      model,
      projects,
      selectedFeatureId: 'arm',
      selectedVariableKey: 'armThickness',
      chat: chatSeedFor(model),
      chatBusy: false,
      agentSource: null,
    });
    persistProjectLibrary(projects, state.activeProjectId);
    window.setTimeout(() => {
      void get().rebuildGeometry();
    }, 0);
  },
}));

export function currentMaterial(): MaterialSpec {
  return getMaterial(useAppStore.getState().model.materialId);
}
