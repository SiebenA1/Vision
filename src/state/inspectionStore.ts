import { create } from 'zustand';
import { getMaterial } from '../core/materials';
import { inspectCad, type CadInspection, type CadPick, type CadSection, type InspectionKind } from '../services/engineeringBackend';
import { useAppStore } from './store';
import { planSelectionMeasurements, type SelectionAnalysis } from '../services/selectionAnalysis';
import { useMemoryStatus } from '../services/agentMemory';

export function inspectionContext() {
  const { model } = useAppStore.getState();
  return `${model.id}:${model.cad?.artifactId ?? ''}:${model.materialId}`;
}

let controller: AbortController | undefined;
let sequence = 0;
let analysisController: AbortController | undefined;
let analysisSequence = 0;
interface InspectionState {
  context: string;
  enabled: boolean;
  showDimensions: boolean;
  showHud: boolean;
  mode: InspectionKind;
  selection: string[];
  accuracy: number;
  busy: boolean;
  error: string;
  result: CadInspection | null;
  summary: CadInspection | null;
  smart: boolean;
  focus: string;
  analysis: SelectionAnalysis | null;
  analysisStatus: 'idle' | 'planning' | 'measuring' | 'ready' | 'error';
  analysisError: string;
  section?: CadSection;
  pick?: CadPick;
  setEnabled: (enabled: boolean) => void;
  setDisplay: (key: 'showDimensions' | 'showHud', value: boolean) => void;
  setMode: (mode: InspectionKind) => void;
  reset: () => void;
  setSmart: (smart: boolean) => void;
  setFocus: (focus: string) => void;
  analyze: () => Promise<void>;
  measure: (selection: string[], pick?: CadPick, accuracy?: number, section?: CadSection) => Promise<void>;
}

export const useInspectionStore = create<InspectionState>((set, get) => ({
  context: '', enabled: false, showDimensions: true, showHud: true, mode: 'face', selection: [], accuracy: 1e-4,
  busy: false, error: '', result: null, summary: null,
  smart: true, focus: '', analysis: null, analysisStatus: 'idle', analysisError: '',
  setEnabled: (enabled) => set({ enabled }),
  setDisplay: (key, value) => set({ [key]: value }),
  setMode: (mode) => set({ mode }),
  setSmart: (smart) => {
    analysisController?.abort(); analysisSequence += 1;
    set({ smart, analysis: null, analysisStatus: 'idle', analysisError: '' });
    if (smart) void get().analyze();
  },
  setFocus: (focus) => {
    analysisController?.abort(); analysisSequence += 1;
    set({ focus: focus.slice(0, 1000), analysis: null, analysisStatus: 'idle', analysisError: '' });
  },
  reset: () => {
    controller?.abort();
    analysisController?.abort(); analysisSequence += 1;
    sequence += 1;
    set({ context: inspectionContext(), selection: [], result: null, summary: null, error: '', busy: false, section: undefined, pick: undefined,
      focus: '', analysis: null, analysisStatus: 'idle', analysisError: '' });
  },
  measure: async (selection, pick, accuracy = get().accuracy, section) => {
    const { model } = useAppStore.getState();
    const context = inspectionContext();
    if (!model.cad) return;
    controller?.abort();
    analysisController?.abort(); analysisSequence += 1;
    controller = new AbortController();
    const current = ++sequence;
    set({ context, selection, accuracy, section, pick, busy: true, error: '', result: null, analysis: null, analysisStatus: 'idle', analysisError: '' });
    try {
      const result = await inspectCad(model.cad.artifactId, selection, getMaterial(model.materialId).rho, accuracy, controller.signal, pick, section);
      if (current !== sequence || context !== inspectionContext()) return;
      set({ selection: result.selection, result, busy: false,
        ...(!result.selection.length && !section ? { summary: result } : {}),
      });
      if (get().smart && result.selection.length && !section) void get().analyze();
    } catch (error) {
      if (current !== sequence || context !== inspectionContext()) return;
      set({ error: error instanceof Error ? error.message : String(error), busy: false });
    }
  },
  analyze: async () => {
    const { result, context, focus, pick, accuracy, smart, section } = get();
    const model = useAppStore.getState().model;
    if (!smart || !result?.selection.length || section || context !== inspectionContext()) return;
    analysisController?.abort();
    const task = new AbortController(); analysisController = task;
    const current = ++analysisSequence;
    const fresh = () => {
      if (current !== analysisSequence || get().result !== result || inspectionContext() !== context) return false;
      if (useAppStore.getState().model !== model) {
        set({ analysis: null, analysisStatus: 'idle', analysisError: '设计上下文已更新，请重新分析' });
        return false;
      }
      return true;
    };
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; task.abort(); }, 60000);
    set({ analysis: null, analysisStatus: 'planning', analysisError: '' });
    try {
      const plan = await planSelectionMeasurements(model, result, focus, task.signal);
      if (!fresh()) return;
      set({ analysisStatus: 'measuring' });
      const ids = plan.parameters.map(parameter => parameter.metricId);
      const measured = ids.length ? await inspectCad(result.artifactId, result.selection, getMaterial(model.materialId).rho, accuracy, task.signal, pick, undefined, ids)
        : { ...result, properties: [], metricErrors: [] };
      if (!fresh()) return;
      if (ids.length && (measured.inspectionSchema !== 'vision.inspection/2' || JSON.stringify(measured.requestedMetricIds) !== JSON.stringify(ids))) {
        throw new Error('几何后端未启用按需测量接口，请重启本地后端后点击“分析所选几何”');
      }
      if (measured.artifactId !== result.artifactId || JSON.stringify(measured.selection) !== JSON.stringify(result.selection)) throw new Error('测量返回的几何范围已变化，请重新选择');
      let primaryCount = 0;
      const properties = plan.parameters.flatMap(parameter => {
        const property = measured.properties.find(item => item.id === parameter.metricId);
        if (!property) {
          if (!measured.metricErrors?.some(item => item.id === parameter.metricId)) throw new Error('几何内核未返回所请求的测量项');
          return [];
        }
        const values = Array.isArray(property.value) ? property.value : [property.value];
        if (values.some(value => typeof value === 'number' && !Number.isFinite(value))) throw new Error('几何内核返回了非有限数值');
        const annotation = parameter.display !== 'detail' && primaryCount < 3 ? 'primary' as const : 'detail' as const;
        if (annotation === 'primary') primaryCount += 1;
        return [{ ...property, label: parameter.label, nativeLabel: property.label, reason: parameter.reason, annotation, panelOnly: false }];
      });
      const considerations = [...plan.considerations, ...(measured.metricErrors ?? []).map(item => ({ name: plan.parameters.find(p => p.metricId === item.id)?.label ?? item.id,
        reason: '所请求的几何测量未能完成', requiredData: item.error, status: 'unsupported' as const }))];
      set({ analysis: { ...plan, considerations, properties }, analysisStatus: 'ready' });
    } catch (error) {
      if (!fresh()) return;
      set({ analysis: null, analysisStatus: 'error', analysisError: timedOut ? '智能分析超过 60 秒，请重新分析' : error instanceof Error ? error.message : String(error) });
    } finally { clearTimeout(timeout); }
  },
}));

// Declarations are part of interpretation context. A withdrawal/forget must
// also remove current viewport explanations, including an in-flight response.
useMemoryStatus.subscribe((state, previous) => {
  if (state.changed === previous.changed) return;
  const inspection = useInspectionStore.getState();
  inspection.setFocus(inspection.focus);
});
