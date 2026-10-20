import { create } from 'zustand';
import { geometryFingerprint, studyFingerprint } from '../core/provenance';
import type {
  AnalysisResult,
  ChatMessage,
  DesignVariable,
  FieldKind,
  GeometryData,
  GeometryMetrics,
  ModelDocument,
  ProjectRecord,
  ToastMessage,
  ValidationResult,
  WorkspaceId,
} from '../core/types';
import {
  createBlankProjectModel,
  isModelDocument,
  loadProjectLibrary,
  makeProjectRecord,
  nextProjectCode,
  persistProjectLibrary,
} from '../core/projects';
import { base64ToUint8, parseBinaryStl } from '../core/cad/stl';
import { createExternalModel, type ExternalModelInput } from '../core/cad/external';
import { getMaterial, massFromVolume, type MaterialSpec } from '../core/materials';
import { loadCadPreview } from '../services/engineeringBackend';

export interface SolveProgress {
  phase: 'mesh' | 'solve' | 'refine';
  percent: number | null;
  detail: string;
}

function cloneModel<T>(value: T): T {
  return structuredClone(value);
}

export type AnalysisStatus = 'idle' | 'queued' | 'mesh' | 'solve' | 'refine' | 'ready' | 'error';
export type OverlayWorkspace = 'analysis' | null;

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
  analysisErrorStatus: number | null;
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

  setGeometry: (geometry: GeometryData | null) => void;
  rebuildGeometry: () => Promise<GeometryData | null>;
  setBuilding: (building: boolean) => void;

  syncProject: () => void;
  switchProject: (id: string, preserveChat?: boolean) => void;
  createProject: (name: string, code: string) => boolean;
  createBlankProject: (name: string, code: string) => boolean;
  adoptExternalModel: (input: ExternalModelInput) => void;
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

  configureStudy: (patch: Pick<ModelDocument, 'supports' | 'loads' | 'mesh' | 'studyBodyIds'>) => void;
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

  resetProject: () => void;
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function metricsFor(model: ModelDocument, geometry: GeometryData): GeometryMetrics {
  const material = getMaterial(model.materialId);
  return {
    volumeCm3: model.externalMetrics?.volumeCm3 ?? geometry.volumeMm3 / 1000,
    massKg: massFromVolume((model.externalMetrics?.volumeCm3 ?? geometry.volumeMm3 / 1000) * 1000, material.rho),
    surfaceCm2: model.externalMetrics?.surfaceCm2 ?? geometry.areaMm2 / 100,
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
  const external = model.template === 'external';
  const content =
    model.template === 'empty'
      ? `你好，我是 ATLAS。描述零件、尺寸和设计要求，开始建模。`
      : external
        ? `${model.name} 已载入。可以继续修改模型，或设置工况并运行分析。`
        : `${model.code} · ${model.name} 已载入。`;
  return [
    {
      id: `msg_seed_${Date.now().toString(36)}`,
      role: 'assistant',
      content,
      createdAt: Date.now() - 42_000,
      meta: {
        kind: 'insight',
        chips: model.template === 'empty' ? [] : ['运行基线校核', '哪里最危险？', '生成工程校核报告'],
      },
    },
  ];
}

function freshAnalysisState() {
  return {
    analysis: null,
    analysisStatus: 'idle' as const,
    analysisError: null,
    analysisErrorStatus: null,
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
  analysisErrorStatus: null,
  solveProgress: null,
  resultStale: false,
  validation: null,
  validationStatus: 'idle',

  activeWorkspace: null,
  rail: 'model',
  selectedFeatureId: 'arm',
  selectedVariableKey: 'armThickness',
  leftCollapsed: true,
  copilotCollapsed: false,

  viewMode: 'design',
  field: 'vonMises',
  deformationScale: 10,
  showEdges: true,
  showAnnotations: false,

  chat: chatSeedFor(initialModel),
  chatBusy: false,
  agentSource: null,

  history: [],
  future: [],

  toasts: [],

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
    if (model.template === 'external') {
      try {
        set({ buildSeq: seq, building: true, geometryError: null });
        let bytes: Uint8Array;
        if (model.cad && !model.externalStlBase64) {
          bytes = await loadCadPreview(model.cad.artifactId);
        } else {
          if (!model.externalStlBase64) throw new Error('外部模型缺少 STL 数据，请重新建模。');
          bytes = base64ToUint8(model.externalStlBase64);
        }
        if (get().model !== model || get().buildSeq !== seq) return null;
        const geometry = parseBinaryStl(bytes, geometryFingerprint(model));
        const stored = model.externalMetrics;
        const metrics: GeometryMetrics = {
          volumeCm3: stored?.volumeCm3 ?? geometry.volumeMm3 / 1000,
          massKg: massFromVolume((stored?.volumeCm3 ?? geometry.volumeMm3 / 1000) * 1000, getMaterial(model.materialId).rho),
          surfaceCm2: stored?.surfaceCm2 ?? geometry.areaMm2 / 100,
          bbox: geometry.bbox,
          triangleCount: geometry.triangleCount,
          buildMs: 0,
          watermark: geometry.watermark,
        };
        set({
          buildSeq: seq,
          geometry,
          geometryMetrics: metrics,
          geometryError: null,
          building: false,
          resultStale: Boolean(get().analysis && get().analysis?.inputFingerprint !== studyFingerprint(model)),
        });
        return geometry;
      } catch (error) {
        if (get().model !== model || get().buildSeq !== seq) return null;
        set({
          buildSeq: seq,
          building: false,
          geometryError: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
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
    set({
      buildSeq: seq,
      building: false,
      geometryError: '不支持的几何模板；几何必须由 NVIDIA USD BRep 后端生成。',
    });
    return null;
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
    const model = createBlankProjectModel(cleanCode, cleanName);
    const record = makeProjectRecord(model);
    set({ projects: [...state.projects, record] });
    get().switchProject(record.id);
    return true;
  },

  adoptExternalModel: (input) => {
    const state = get();
    const currentRecord = state.projects.find((project) => project.id === state.activeProjectId);
    const createNew = input.newProject === true || !currentRecord;
    const { model, metrics } = createExternalModel({
      ...input,
      code: createNew ? input.code : state.model.code,
      name: createNew ? input.name : state.model.name,
      materialId: input.materialId ?? (createNew ? undefined : state.model.materialId),
    });
    const geometry = parseBinaryStl(base64ToUint8(input.stlBase64), geometryFingerprint(model));
    const geometryMetrics: GeometryMetrics = {
      ...metrics,
      bbox: geometry.bbox,
      triangleCount: geometry.triangleCount,
      watermark: geometry.watermark,
    };
    model.externalMetrics = geometryMetrics;

    let projects: typeof state.projects;
    let activeProjectId: string;
    if (createNew) {
      const record = makeProjectRecord(model);
      projects = [...state.projects, record];
      activeProjectId = record.id;
    } else {
      model.id = state.model.id;
      model.revision = state.model.revision;
      model.supports = cloneModel(state.model.supports);
      model.loads = cloneModel(state.model.loads);
      model.mesh = cloneModel(state.model.mesh);
      model.meta = { ...state.model.meta, designIntent: model.meta.designIntent };
      const updatedRecord = {
        ...currentRecord,
        model: structuredClone(model),
        updatedAt: new Date().toISOString(),
      };
      projects = state.projects.map((project) =>
        project.id === currentRecord.id ? updatedRecord : project,
      );
      activeProjectId = currentRecord.id;
    }
    persistProjectLibrary(projects, activeProjectId);

    const message: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: `${createNew ? '已创建新工程' : '已更新当前工程'} **${model.code} · ${model.name}**。B-Rep 体积 ${(geometryMetrics.volumeCm3 / 1000).toFixed(3)} L，质量 ${geometryMetrics.massKg.toFixed(3)} kg，${geometry.triangleCount.toLocaleString('en-US')} 三角面。\n\n几何来自本次脚本，不是预设模型。`,
      createdAt: Date.now(),
      meta: { kind: 'insight', source: 'local' },
    };
    set({
      ...freshAnalysisState(),
      history: createNew ? [] : [...state.history, { model: cloneModel(state.model), label: 'USD BRep 几何修改' }],
      chatBusy: state.chatBusy,
      agentSource: state.agentSource,
      model,
      projects,
      activeProjectId,
      geometry,
      geometryMetrics,
      selectedFeatureId: 'backend',
      selectedVariableKey: '',
      chat: [...state.chat, message],
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
    if (!Number.isFinite(value)) throw new Error('设计变量必须是有限数值');
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
    if (!Number.isFinite(magnitude) || magnitude < 0) throw new Error('载荷必须是非负有限数值');
    const state = get();
    if (!state.model.loads[0]) throw new Error('请先定义载荷');
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
    delete model.loads[0].region;
    set((current) => ({
      model,
      history: record ? [...state.history] : current.history,
      future: record ? [] : current.future,
      resultStale: Boolean(current.analysis),
    }));
  },

  setLoadDirection: (vector, record = true) => {
    const state = get();
    if (vector.length !== 3 || !vector.every(Number.isFinite) || Math.hypot(...vector) === 0) throw new Error('载荷方向必须是非零有限三维向量');
    const clean = [...vector] as [number, number, number];
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
    if (state.model.supports[0].face === face && !state.model.supports[0].region) return;
    if (record) {
      state.history.push({ model: cloneModel(state.model), label: '更新约束面' });
    }
    const model = cloneModel(state.model);
    model.supports[0].face = face;
    delete model.supports[0].region;
    model.supports[0].name = face === 'x-min' ? '背板固定面' : `${face} 固定`;
    set((current) => ({
      model,
      history: record ? [...state.history] : current.history,
      future: record ? [] : current.future,
      resultStale: Boolean(current.analysis),
    }));
  },

  configureStudy: (patch) => {
    const state = get();
    set({ model: { ...cloneModel(state.model), ...cloneModel(patch) }, history: [...state.history, { model: cloneModel(state.model), label: '更新分析工况' }], future: [] });
  },

  setAnalysis: (analysis) => set({ analysis }),
  setAnalysisStatus: (analysisStatus) => set({ analysisStatus }),
  setAnalysisError: (analysisError) => set({ analysisError, analysisErrorStatus: null }),
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

  resetProject: () => {
    const state = get();
    const model = createBlankProjectModel(state.model.code, state.model.name);
    const projects = state.projects.map((project) =>
      project.id === state.activeProjectId
        ? { ...project, model: cloneModel(model), updatedAt: new Date().toISOString() }
        : project,
    );
    set({
      ...freshAnalysisState(),
      model,
      projects,
      selectedFeatureId: '',
      selectedVariableKey: '',
      chat: chatSeedFor(model),
      chatBusy: false,
      agentSource: null,
    });
    persistProjectLibrary(projects, state.activeProjectId);
  },
}));

export function currentMaterial(): MaterialSpec {
  return getMaterial(useAppStore.getState().model.materialId);
}

// Keep invalidation independent of React effects and every individual tool caller.
useAppStore.subscribe((state, previous) => {
  if (state.model === previous.model && state.analysis === previous.analysis) return;
  const stale = Boolean(state.analysis && state.analysis.inputFingerprint !== studyFingerprint(state.model));
  if (stale !== state.resultStale) useAppStore.setState({ resultStale: stale });
});
