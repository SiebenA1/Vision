import { create } from 'zustand';
import { useAppStore } from '../state/store';
import { getMaterial } from '../core/materials';
import type { ModelDocument } from '../core/types';
import type { DeepSeekMessage } from '../core/llm/types';
import { geometryFingerprint } from '../core/provenance';

export type MemoryKind = 'requirement' | 'decision' | 'assumption' | 'preference';
export interface MemoryItem {
  id: string; topic: string; kind: MemoryKind; content: string; target: string;
  artifact: string | null; status: string; source: string; sourceText: string; version: number; epistemic: 'declared';
}
export interface MemorySnapshot {
  modelId: string; name: string; artifactId: string | null; topologyIds: string[];
  material: Record<string, unknown>; designIntent: string; study: Record<string, unknown>; geometryKey: string;
}
export interface MemoryScope { projectId: string; snapshot: MemorySnapshot }
export interface TaskCheckpoint {
  goal: string; answer?: string; snapshotId?: string; messages?: DeepSeekMessage[];
}
export interface TaskIntent {
  eventId: string; sourceEventId: string; originalRequest: string; goal: string;
  relation: 'new' | 'continue' | 'revise' | 'cancel' | 'clarify';
  rootTaskId: string; basedOnEventIds: string[]; unresolved: string[]; epistemic: 'agent_interpretation';
}
export interface DialogueSource { eventId: string; role: string; text: string; selection: string[]; artifactId: string | null; meaning: string }
export interface EffectiveOutput { eventId: string; tool: string; validity: 'current' | 'historical'; origin: 'tool_executor'; summary: string; state: unknown }
export interface MemoryContext {
  schema: 'vision.context/1'; contextId: string; projectId: string; snapshotId: string; revision: number; epoch: number;
  memories: MemoryItem[]; excluded: Array<{ id: string; reason: string }>;
  resume: TaskCheckpoint | null; taskStatus: string | null; budgetChars: number; usedChars: number; rules: string;
  executions: Array<{ eventId: string; tool: string; status: string; detail: string }>;
  intent: TaskIntent | null; dialogue: DialogueSource[]; outcomes: EffectiveOutput[];
  retrievedHistory: Array<{ eventId: string; kind: string; excerpt: string; truncated: boolean; snapshotId: string }>;
}
export const useMemoryStatus = create<{
  error: string; revision: number; epoch: number; projectId: string; lastContext: MemoryContext | null; changed: number;
}>(() => ({ error: '', revision: 0, epoch: 0, projectId: '', lastContext: null, changed: 0 }));

export const memoryId = () => crypto.randomUUID();
export function memoryScope(model: ModelDocument = useAppStore.getState().model, extraTopology: string[] = []): MemoryScope {
  const material = getMaterial(model.materialId);
  return {
    // Both IDs are persisted, unlike the editable project code. Including the
    // model ID also isolates reset/import from the original blank project.
    projectId: `${useAppStore.getState().activeProjectId}.${model.id}`,
    snapshot: {
      modelId: model.id, name: model.name, artifactId: model.cad?.artifactId ?? null,
      topologyIds: [...new Set([...(model.cad?.bodies.map(body => body.id) ?? []), ...extraTopology])],
      geometryKey: geometryFingerprint(model),
      material: { id: material.id, rho: material.rho, E: material.E, nu: material.nu, yieldStrength: material.yieldStrength },
      designIntent: model.meta.designIntent,
      study: { supports: model.supports, loads: model.loads, mesh: model.mesh, bodyIds: model.studyBodyIds ?? [] },
    },
  };
}

export async function memoryRequest<T>(operation: string, scope: MemoryScope, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(8000);
  const response = await fetch(`/api/engineering/memory/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...scope, ...fields }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `工程记忆请求失败 (${response.status})`);
  if (body.revision !== undefined && memoryScope().projectId === scope.projectId) {
    useMemoryStatus.setState({ revision: body.revision, ...(body.epoch !== undefined ? { epoch: body.epoch } : {}), projectId: scope.projectId, error: '' });
  }
  return body as T;
}
export function memoryFailure(error: unknown) {
  useMemoryStatus.setState({ error: `工程记忆暂不可用：${error instanceof Error ? error.message : String(error)}` });
}
export async function compileMemoryContext(scope: MemoryScope, purpose: 'chat' | 'inspection', query: string, selection: string[] = [], signature = '', signal?: AbortSignal) {
  try {
    const context = await memoryRequest<MemoryContext>('context', scope, { purpose, query, selection, signature }, signal);
    if (context.schema !== 'vision.context/1' || !Array.isArray(context.memories)) throw new Error('记忆接口版本不兼容，请重启后端');
    if (memoryScope().projectId === scope.projectId) useMemoryStatus.setState({ lastContext: context });
    return context;
  } catch (error) {
    if (signal?.aborted) throw error;
    memoryFailure(error);
    return null; // Native geometry and tools remain usable; never fake a recall.
  }
}
export const recordMemoryEvent = (scope: MemoryScope, eventId: string, kind: string, payload: Record<string, unknown>, signal?: AbortSignal, expectedRevision?: number) =>
  memoryRequest<{ eventId: string; revision: number }>('event', scope, { eventId, kind, payload, expectedRevision }, signal);

export async function rememberQuote(scope: MemoryScope, sourceEventId: string, content: string, topic: string, kind: MemoryKind, target = 'project', expectedRevision?: number, supersedesId?: string) {
  const result = await memoryRequest<{ id: string; status: string; revision: number }>('remember', scope, { sourceEventId, content, topic, kind, target, expectedRevision, supersedesId });
  useMemoryStatus.setState(state => ({ changed: state.changed + 1 }));
  return result;
}
export async function changeMemory(scope: MemoryScope, id: string, action: string, expectedRevision: number, target?: string) {
  const result = await memoryRequest<{ revision: number }>('change', scope, { id, action, expectedRevision, target });
  useMemoryStatus.setState(state => ({ changed: state.changed + 1, lastContext: null, ...(action === 'forget' ? { epoch: state.epoch + 1 } : {}) }));
  return result;
}

// Preserve whole user/assistant/tool groups, never a dangling tool result.
// ponytail: conservative character budget until provider-specific tokenizers
// exist; it bounds history without pretending characters are actual tokens.
export function boundedHistory(messages: DeepSeekMessage[], maxChars = 40000): DeepSeekMessage[] {
  const groups: DeepSeekMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') groups.push([]);
    groups.at(-1)?.push(message);
  }
  const kept: DeepSeekMessage[][] = [];
  let size = 0;
  for (const group of groups.reverse()) {
    const last = group.at(-1);
    if (last?.role !== 'assistant' || last.tool_calls?.length) continue;
    const chars = JSON.stringify(group).length;
    if (size + chars > maxChars) break;
    kept.unshift(group); size += chars;
  }
  return kept.flat();
}

export async function checkpoint(scope: MemoryScope, turnId: string, signature: string, status: string, payload: TaskCheckpoint, expectedRevision?: number) {
  return memoryRequest('checkpoint', scope, { turnId, signature, status, payload, expectedRevision });
}

export function memoryData(context: MemoryContext | null) {
  if (!context) return { status: 'unavailable', note: '历史工程记忆暂不可用；仅依据本轮输入和当前模型，不能声称恢复了历史要求。' };
  return { contextId: context.contextId, snapshotId: context.snapshotId, memoryRevision: context.revision,
    memories: context.memories, rules: context.rules,
    interpretedIntent: context.intent, recentDialogue: context.dialogue, relevantHistory: context.retrievedHistory, toolOutputs: context.outcomes,
    previousTask: context.resume ? { goal: context.resume.goal, answer: context.resume.answer, answerMeaning: 'assistant_text_not_measurement', status: context.taskStatus, snapshotId: context.resume.snapshotId, executions: context.executions,
      note: '历史任务，仅供连续性参考；未完成工具先查证，不自动重复；历史数值不能替代当前工具证据。' } : null };
}
