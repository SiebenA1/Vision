import type {
  AgentAction,
  ChatMessage,
  ChatPlanStep,
} from '../core/types';
import type { DeepSeekMessage, DeepSeekToolCall } from '../core/llm/types';
import { createDeepSeekCompletion, DeepSeekApiError, describeApiError } from '../core/llm/client';
import { buildSystemPrompt } from '../core/llm/prompt';
import { buildDeepSeekTools, buildModelContext } from '../core/llm/tools';
import { isLlmConfigured, useLlmStore } from '../state/llmStore';
import { useAppStore } from '../state/store';
import { executeTool, labelForAction, type LastResultRef } from './agentTools';
import { wait } from './simulation';
import { EngineeringBackendError, loadCadApiIndex } from './engineeringBackend';
import { boundedHistory, changeMemory, checkpoint, compileMemoryContext, memoryData, memoryFailure, memoryId, memoryRequest, memoryScope, recordMemoryEvent, rememberQuote, type MemoryContext, type MemoryKind } from './agentMemory';
import { useInspectionStore } from '../state/inspectionStore';

export class AgentAbortedError extends Error {
  constructor() {
    super('Agent request aborted');
    this.name = 'AgentAbortedError';
  }
}

export class AgentTaskError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentTaskError'; }
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * DeepSeek thinking mode requires the full chain of assistant
 * `reasoning_content` to be replayed when tools are present. We therefore keep
 * the exact API conversation (including tool calls/results) in a module-level
 * log instead of reconstructing it from display messages.
 */
let deepseekHistory: DeepSeekMessage[] = [];
let deepseekHistoryModel = '';
let deepseekHistoryThinking: boolean | null = null;
let historyProject = '';
let historyEpoch = 0;
let historyRevision = -1;

export function resetDeepSeekConversation(): void {
  deepseekHistory = [];
  deepseekHistoryModel = '';
  deepseekHistoryThinking = null;
  historyProject = '';
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`工具参数不是合法 JSON：${raw.slice(0, 120)}`);
  }
}

function asNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`参数 ${name} 必须是有限数值`);
  return number;
}

export function toolAction(call: DeepSeekToolCall): AgentAction {
  const name = call.function.name;
  const args = parseArguments(call.function.arguments);
  const model = useAppStore.getState().model;
  const faces = ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'];
  const face = (value: unknown) => {
    const candidate = String(value ?? '');
    if (!faces.includes(candidate)) throw new Error(`无效的 face：${candidate}`);
    return candidate;
  };

  if (name === 'set_variable') {
    const key = String(args.key ?? '');
    const variable = model.variables.find((item) => item.key === key);
    if (!variable) throw new Error(`未知设计变量：${key}`);
    return {
      tool: 'set_variable',
      args: {
        key,
        value: asNumber(args.value, 'value'),
        label: variable.label,
        unit: variable.unit,
      },
      label: '',
    };
  }
  if (name === 'set_material') {
    return {
      tool: 'set_material',
      args: {
        materialId: String(args.materialId ?? ''),
        reason: String(args.reason ?? ''),
      },
      label: '',
    };
  }
  if (name === 'set_load') {
    const direction = String(args.direction ?? 'down');
    if (!['down', 'up', 'left', 'right', 'forward', 'backward'].includes(direction)) {
      throw new Error(`无效的载荷方向：${direction}`);
    }
    return {
      tool: 'set_load',
      args: {
        magnitude: asNumber(args.magnitude, 'magnitude'),
        face: face(args.face ?? 'x-max'),
        direction,
      },
      label: '',
    };
  }
  if (name === 'set_support') {
    return {
      tool: 'set_support',
      args: { face: face(args.face ?? 'x-min') },
      label: '',
    };
  }
  if (name === 'run_analysis') {
    return {
      tool: 'run_analysis',
      args: { refinement: Boolean(args.refinement) },
      label: '',
    };
  }
  if (name === 'query_usd_brep') return { tool: 'query_usd_brep', args: { query: String(args.query ?? ''), offset: asNumber(args.offset ?? 0, 'offset') }, label: '' };
  if (name === 'configure_study') return { tool: 'configure_study', args: { study_json: String(args.study_json ?? '{}') }, label: '' };
  if (name === 'run_usd_brep') {
    const script = String(args.script ?? '');
    if (!script.trim()) throw new Error('USD BRep 脚本为空');
    return {
      tool: 'run_usd_brep',
      args: {
        script,
        options_json: String(args.options_json ?? '{}'),
        use_current: args.use_current !== false,
        name: String(args.name ?? 'AI B-Rep 模型'),
        code: String(args.code ?? ''),
        new_project: args.new_project === true,
        materialId: String(args.materialId ?? (args.new_project === true ? 'AL6061-T6' : model.materialId)),
      },
      label: '',
    };
  }
  if (name === 'explain_risk') {
    return { tool: 'explain_risk', args: {}, label: '' };
  }
  if (name === 'export_report') {
    return { tool: 'export_report', args: {}, label: '' };
  }
  throw new Error(`模型请求了未注册的工具：${name}`);
}

function modelLabel(): string {
  const model = useLlmStore.getState().settings.model;
  return model === 'deepseek-v4-pro' ? 'DEEPSEEK V4 PRO' : 'DEEPSEEK FLASH';
}

function engineeringContext() {
  const state = useAppStore.getState();
  const metrics = state.geometryMetrics;
  return buildModelContext(state.model, state.analysis, state.resultStale, state.validation,
    metrics ? { volumeCm3: metrics.volumeCm3, massKg: metrics.massKg, bbox: [...metrics.bbox.min, ...metrics.bbox.max], triangles: metrics.triangleCount } : null);
}

export async function runDeepSeekTurn(
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  if (!isLlmConfigured()) throw new DeepSeekApiError('未配置 DeepSeek API Key', 0, 'missing_key');
  const settings = useLlmStore.getState().settings;
  const serverKey = useLlmStore.getState().serverKey;
  const store = useAppStore.getState();
  const model = store.model;
  const selectionState = useInspectionStore.getState();
  let currentSelection = selectionState.result && selectionState.result.artifactId === model.cad?.artifactId ? selectionState.selection : [];
  let scope = memoryScope(model, currentSelection);
  const signature = `${settings.model}:${settings.thinking}:${settings.reasoningEffort}`;
  const turnId = memoryId();
  const sourceEventId = memoryId();
  let memory: MemoryContext | null = await compileMemoryContext(scope, 'chat', prompt, [], signature, signal);
  const apiIndex = await loadCadApiIndex(signal).catch(() => null);
  // Root exports repeat functions from named groups. Send each signature once;
  // retain type/member names so the model can look up exact native symbols.
  const groupedNames = new Set(apiIndex?.entries.filter(entry => entry.group !== 'usd_brep').map(entry => entry.name));
  const kernelApiIndex = apiIndex && { version: apiIndex.version, fingerprint: apiIndex.fingerprint, usage: apiIndex.usage,
    groups: Object.fromEntries(apiIndex.groups.map(group => [group, apiIndex.entries
      .filter(entry => entry.group === group && !(group === 'usd_brep' && entry.kind === 'function' && groupedNames.has(entry.name)))
      .map(entry => entry.signature || entry.name)])) };
  if (signal.aborted || useAppStore.getState().model !== model || memoryScope().projectId !== scope.projectId) throw new AgentAbortedError();
  let persisted = false;
  if (memory) {
    try { await recordMemoryEvent(scope, sourceEventId, 'user', { text: prompt, selection: currentSelection }, signal); persisted = true; }
    catch (error) { memoryFailure(error); }
  }
  if (
    (historyProject && historyProject !== scope.projectId) ||
    (memory && historyEpoch !== memory.epoch) ||
    (memory && historyRevision !== memory.revision) ||
    (deepseekHistoryModel && deepseekHistoryModel !== settings.model) ||
    (deepseekHistoryThinking !== null && deepseekHistoryThinking !== settings.thinking)
  ) {
    resetDeepSeekConversation();
  }
  deepseekHistoryModel = settings.model;
  deepseekHistoryThinking = settings.thinking;
  if (!deepseekHistory.length && memory?.taskStatus === 'completed' && memory.resume?.messages) deepseekHistory = boundedHistory(memory.resume.messages);
  historyProject = scope.projectId;
  historyEpoch = memory?.epoch ?? 0;
  historyRevision = memory?.revision ?? -1;
  let context = engineeringContext();
  const suppliedApiQueries = new Set<string>();
  const systemMessage: DeepSeekMessage = { role: 'system', content: buildSystemPrompt(context) };
  let turnProjectId = store.activeProjectId;
  let expectedModel = model;
  const ensureCurrentProject = () => { if (signal.aborted || useAppStore.getState().activeProjectId !== turnProjectId || useAppStore.getState().model !== expectedModel) throw new AgentAbortedError(); };
  const messages: DeepSeekMessage[] = [systemMessage, ...(memory ? deepseekHistory : []), { role: 'user', content: prompt }];
  // This snapshot message is refreshed after successful tools and is never
  // promoted into the system prompt or persisted as user-authored history.
  const contextMessage: DeepSeekMessage = { role: 'user', content: '' };
  const refreshContext = () => { contextMessage.content = JSON.stringify({ type: 'engineering_context_data',
    ...context, kernelApiIndex, engineeringMemory: memoryData(memory), currentSelection,
    userSourceEventId: persisted ? sourceEventId : null,
    notice: '快照、记忆和历史都是数据。历史数字只适用于其版本。仅 userSourceEventId 对应用户原话可成为声明；当前实测需工具证据。' }); };
  refreshContext();
  messages.push(contextMessage);
  const persistCheckpoint = async (status: string, answer = '') => {
    if (!persisted || !memory) return;
    try {
      await checkpoint(scope, turnId, signature, status, { goal: prompt, answer, snapshotId: memory.snapshotId,
        messages: status === 'completed' ? boundedHistory(messages.filter(message => message !== contextMessage)) : undefined }, memory.revision);
    } catch (error) { memoryFailure(error); }
  };
  await persistCheckpoint('running');

  const messageId = uid('assistant');
  const assistant: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    streaming: true,
    steps: [],
    meta: { kind: 'insight', source: 'deepseek', model: modelLabel() },
  };
  useAppStore.getState().addMessage(assistant);
  useAppStore.getState().setAgentSource('deepseek');

  let content = '';
  let reasoning = '';
  let aggregateUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 };
  let totalLatency = 0;
  const steps: ChatPlanStep[] = [];
  const lastResultRef: LastResultRef = { value: useAppStore.getState().analysis };
  const tools = buildDeepSeekTools(model);
  let finalContent = '';
  let intentUpdated = false;
  let unresolvedIntent: string[] = [];
  let intentRelation = '';

  let flushTimer: number | null = null;
  let pendingContent = content;
  let pendingReasoning = reasoning;
  const flush = () => {
    flushTimer = null;
    content = pendingContent;
    reasoning = pendingReasoning;
    useAppStore.getState().updateMessage(messageId, {
      content,
      reasoning,
      steps: [...steps],
      streaming: true,
      meta: { kind: 'insight', source: 'deepseek', model: modelLabel() },
    });
  };
  const scheduleFlush = () => {
    if (flushTimer !== null) return;
    flushTimer = window.setTimeout(flush, 70);
  };
  const setStep = (stepId: string, patch: Partial<ChatPlanStep>) => {
    const index = steps.findIndex((step) => step.id === stepId);
    if (index < 0) return;
    steps[index] = { ...steps[index], ...patch };
    scheduleFlush();
  };

  try {
    for (let round = 0; round < 32; round += 1) {
      ensureCurrentProject();
      let roundContent = '';
      let roundReasoning = '';
      pendingContent = content;
      pendingReasoning = reasoning;
      const completion = await createDeepSeekCompletion({
        messages,
        tools,
        settings,
        serverKey,
        signal,
        callbacks: {
          onContent: (delta) => {
            roundContent += delta;
            pendingContent = roundContent;
            scheduleFlush();
          },
          onReasoning: (delta) => {
            roundReasoning += delta;
            pendingReasoning = reasoning + roundReasoning;
            scheduleFlush();
          },
        },
      });
      ensureCurrentProject();
      totalLatency += completion.latencyMs;
      aggregateUsage = {
        promptTokens: aggregateUsage.promptTokens + completion.usage.promptTokens,
        completionTokens: aggregateUsage.completionTokens + completion.usage.completionTokens,
        totalTokens: aggregateUsage.totalTokens + completion.usage.totalTokens,
        reasoningTokens:
          (aggregateUsage.reasoningTokens ?? 0) + (completion.usage.reasoningTokens ?? 0),
      };
      if (roundReasoning) reasoning += roundReasoning;
      content = roundContent;
      pendingContent = content;
      pendingReasoning = reasoning;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      useAppStore.getState().updateMessage(messageId, {
        content,
        reasoning,
        steps: [...steps],
        streaming: true,
        meta: { kind: 'insight', source: 'deepseek', model: modelLabel() },
      });

      if (completion.toolCalls.length === 0) {
        finalContent = completion.content || roundContent || finalContent;
        messages.push({
          role: 'assistant',
          content: finalContent,
          reasoning_content: settings.thinking ? completion.reasoning || reasoning || '' : undefined,
        });
        break;
      }

      const assistantMessage: DeepSeekMessage = {
        role: 'assistant',
        content: completion.content || null,
        reasoning_content: settings.thinking ? completion.reasoning || '' : undefined,
        tool_calls: completion.toolCalls,
      };
      messages.push(assistantMessage);

      for (const call of completion.toolCalls) {
        const stepId = `tool_${round}_${call.id}`;
        let action: AgentAction | null = null;
        let step: ChatPlanStep = {
          id: stepId,
          label: `调用 ${call.function.name || 'tool'}`,
          status: 'running',
          detail: '解析参数',
        };
        try {
          if (call.function.name === 'withdraw_engineering_memory') {
            const args = parseArguments(call.function.arguments);
            if (!persisted || !memory || args.sourceEventId !== sourceEventId || !intentUpdated || unresolvedIntent.length || !['revise', 'cancel', 'clarify'].includes(intentRelation) || !['retract', 'forget'].includes(String(args.action))) throw new Error('撤回必须来自本轮明确的用户纠正，不能由 agent 自行删除设计约束');
            await changeMemory(scope, String(args.id), String(args.action), memory.revision);
            memory = await compileMemoryContext(scope, 'chat', prompt, currentSelection, signature, signal);
            if (args.action === 'forget') {
              // Do not re-persist or send the deleted source through the old API
              // transcript after its DB copies have been removed.
              messages.splice(0, messages.length, systemMessage, { role: 'user', content: prompt }, contextMessage,
                { role: 'assistant', content: null, tool_calls: [call], reasoning_content: settings.thinking ? '' : undefined });
              deepseekHistory = [];
              historyEpoch = memory?.epoch ?? historyEpoch;
              intentRelation = 'cancel';
            }
            refreshContext();
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, action: args.action }) });
            if (args.action === 'forget') break;
            continue;
          }
          if (call.function.name === 'read_engineering_source') {
            const args = parseArguments(call.function.arguments);
            const found = await memoryRequest('source', scope, args, signal);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(found) });
            continue;
          }
          if (call.function.name === 'search_engineering_history') {
            const args = parseArguments(call.function.arguments);
            const found = await memoryRequest('search', scope, { query: args.query }, signal);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(found) });
            continue;
          }
          if (call.function.name === 'update_task_intent') {
            const args = parseArguments(call.function.arguments);
            if (!persisted || args.sourceEventId !== sourceEventId) throw new Error('任务理解必须引用本轮用户原话');
            const saved = await memoryRequest<{ intent: { unresolved: string[]; relation: string } }>('intent', scope, {
              ...args, eventId: `${turnId}.${call.id}.intent`, expectedRevision: memory?.revision,
            }, signal);
            unresolvedIntent = saved.intent.unresolved;
            intentRelation = saved.intent.relation;
            intentUpdated = true;
            memory = await compileMemoryContext(scope, 'chat', prompt, currentSelection, signature, signal);
            refreshContext();
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, intent: saved.intent, note: '这是有来源的任务理解，不是用户额外确认或实测。' }) });
            continue;
          }
          if (call.function.name === 'remember_engineering_intent') {
            const args = parseArguments(call.function.arguments);
            const target = String(args.target ?? 'project');
            if (!persisted || args.sourceEventId !== sourceEventId) throw new Error('记忆必须引用本轮已保存的用户声明');
            if (!intentUpdated || unresolvedIntent.length || intentRelation === 'cancel') throw new Error('记录长期要求前必须维护本轮任务理解；歧义和取消不能被写成有效设计要求');
            if (target !== 'project' && !currentSelection.includes(target)) throw new Error('对象用途只能绑定本轮选中对象；其他要求请用 project 范围');
            if (args.supersedesId && (!intentUpdated || intentRelation !== 'revise' || unresolvedIntent.length)) throw new Error('修订旧要求前必须明确识别本轮修订意图，存在歧义时先澄清');
            const saved = await rememberQuote(scope, sourceEventId, String(args.content ?? ''), String(args.topic ?? ''), args.kind as MemoryKind, target, memory?.revision, args.supersedesId ? String(args.supersedesId) : undefined);
            memory = await compileMemoryContext(scope, 'chat', prompt, [], signature, signal);
            refreshContext();
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, memory: saved, meaning: '已保存用户声明，不是实测，也不代表建模已完成' }) });
            continue;
          }
          action = toolAction(call);
          step.label = labelForAction(action);
          steps.push(step);
          scheduleFlush();
          useAppStore.getState().updateMessage(messageId, {
            content,
            reasoning,
            steps: [...steps],
            streaming: true,
            meta: { kind: 'action', source: 'deepseek', model: modelLabel() },
          });
          ensureCurrentProject();
          if (!persisted && action.tool !== 'query_usd_brep') throw new EngineeringBackendError('无法核对当前任务的历史要求，本次工程操作未执行。请恢复本地服务后重试。', 503);
          if (memory && persisted) {
            if (action.tool !== 'query_usd_brep' && (!intentUpdated || unresolvedIntent.length || intentRelation === 'cancel')) throw new Error('必须先用 update_task_intent 维护本轮目标。未确定的指代/约束需要澄清，取消的任务不能继续执行工程操作。');
            const latest = await memoryRequest<MemoryContext>('context', scope, { purpose: 'chat', signature }, signal);
            if (latest.revision !== memory.revision || latest.epoch !== memory.epoch) throw new Error('工程记忆在本轮中已变化，请重新发起操作');
            if (memory.memories.some(item => item.status === 'conflicted') && action.tool !== 'query_usd_brep') throw new Error('存在互斥工程要求。请根据用户最新原话维护修订关系；无法判断哪项生效时向用户澄清，不能凭自己偏好执行。');
            if (memory.executions?.some(item => item.status === 'unknown' && item.tool === action?.tool)) throw new Error('上次相同工具已开始执行但尚无完成证据，不能自动重放。请先核对当前几何和计算状态。');
            await recordMemoryEvent(scope, `${turnId}.${call.id}.start`, 'tool_started', { tool: action.tool, args: action.args }, signal, memory.revision);
          }
          const beforeTool = useAppStore.getState().model;
          const result = await executeTool(action, lastResultRef, signal);
          if (action.tool === 'query_usd_brep') {
            const queryKey = `${String(action.args.query ?? '').trim().toLowerCase()}:${action.args.offset ?? 0}`;
            if (suppliedApiQueries.has(queryKey)) {
              const api = result.state.api as { version?: string; entries?: Array<{ symbol: string }> } | undefined;
              result.state = { apiReference: { query: action.args.query, offset: action.args.offset ?? 0, version: api?.version,
                symbols: api?.entries?.map(entry => entry.symbol), alreadyProvided: true,
                note: '完整签名已在本轮先前工具结果中给出，请复用已有文档。' } };
            } else suppliedApiQueries.add(queryKey);
          }
          if (action.tool === 'run_usd_brep' && action.args.new_project === true) turnProjectId = useAppStore.getState().activeProjectId;
          expectedModel = useAppStore.getState().model;
          ensureCurrentProject();
          if (persisted && memoryScope().projectId === scope.projectId) {
            // Log completion against its actual resulting snapshot, not the old
            // user prompt snapshot. A missing finish remains unknown on resume.
            await recordMemoryEvent(memoryScope(), `${turnId}.${call.id}.finish`, 'tool_succeeded', { tool: action.tool, summary: result.summary, detail: result.detail, state: result.state }, signal, memory?.revision).catch(memoryFailure);
          }
          if (beforeTool !== useAppStore.getState().model) {
            const latest = useAppStore.getState();
            const nextScope = memoryScope(latest.model, beforeTool.cad?.artifactId === latest.model.cad?.artifactId ? currentSelection : []);
            if (nextScope.projectId === scope.projectId) {
              scope = nextScope;
              memory = await compileMemoryContext(scope, 'chat', prompt, [], signature, signal);
            } else {
              await persistCheckpoint('completed', '已按用户要求创建新工程，后续任务在新工程继续。');
              persisted = false;
              scope = nextScope;
              memory = await compileMemoryContext(scope, 'chat', prompt, [], signature, signal);
              deepseekHistory = [];
            }
            if (beforeTool.cad?.artifactId !== latest.model.cad?.artifactId) currentSelection = [];
          }
          context = engineeringContext();
          refreshContext();
          setStep(stepId, { status: 'done', detail: result.detail });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              ok: true,
              tool: action.tool,
              summary: result.summary,
              detail: result.detail,
              state: result.state,
            }),
          });
        } catch (error) {
          if (error instanceof AgentAbortedError || signal.aborted) throw new AgentAbortedError();
          const message = error instanceof Error ? error.message : String(error);
          if (persisted && action) await recordMemoryEvent(scope, `${turnId}.${call.id}.failed`, 'tool_failed', { tool: action.tool, error: message }, undefined, memory?.revision).catch(memoryFailure);
          if (!steps.some((item) => item.id === stepId)) {
            step = { ...step, status: 'error', detail: message };
            steps.push(step);
          } else {
            setStep(stepId, { status: 'error', detail: message });
          }
          useAppStore.getState().updateMessage(messageId, {
            content,
            reasoning,
            steps: [...steps],
            streaming: true,
            meta: { kind: 'action', source: 'deepseek', model: modelLabel() },
          });
          if (error instanceof EngineeringBackendError && [0, 502, 503, 504].includes(error.status)) throw error;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              ok: false,
              error: message,
              state: lastResultRef.value ? { hasResult: true } : { hasResult: false },
            }),
          });
          await wait(120);
        }
      }
      content = '';
      pendingContent = '';
      reasoning = '';
      pendingReasoning = '';
    }

    ensureCurrentProject();
    if (!finalContent) {
      throw new AgentTaskError('本轮已达到工具执行轮数上限，尚未收到最终结果。已保留执行记录，不能将接口查询视为建模完成。');
    }
    if (messages[messages.length - 1]?.role !== 'assistant' || messages[messages.length - 1]?.tool_calls) {
      messages.push({
        role: 'assistant',
        content: finalContent,
        reasoning_content: settings.thinking ? reasoning || '' : undefined,
      });
    }
    deepseekHistory = boundedHistory(messages.filter(message => message !== contextMessage));
    historyRevision = memory?.revision ?? -1;
    if (persisted) await recordMemoryEvent(scope, `${turnId}.answer`, 'assistant', { text: finalContent, turnId }, undefined, memory?.revision).catch(memoryFailure);
    await persistCheckpoint('completed', finalContent);
    const result = useAppStore.getState().analysis;
    const chips = result
      ? ['解释分析限制', '生成工程校核报告']
      : ['运行基线校核', '切换为 7075-T6'];
    useAppStore.getState().updateMessage(messageId, {
      content: finalContent,
      reasoning,
      steps: [...steps],
      streaming: false,
      usage: aggregateUsage,
      latencyMs: Math.round(totalLatency),
      meta: {
        kind: steps.length ? 'action' : 'insight',
        source: 'deepseek',
        model: modelLabel(),
        chips,
      },
    });
    useLlmStore.getState().addUsage(aggregateUsage, Math.round(totalLatency));
    useLlmStore.getState().markConnected(Math.round(totalLatency));
  } catch (error) {
    await persistCheckpoint(signal.aborted ? 'stopped' : 'failed', content);
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    if (error instanceof AgentAbortedError || signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      useAppStore.getState().updateMessage(messageId, {
        content: content ? `${content}\n\n_已停止生成。_` : '_已停止生成。_',
        reasoning,
        steps: steps.map((step) =>
          step.status === 'running' ? { ...step, status: 'error', detail: '已停止' } : step,
        ),
        streaming: false,
        meta: { kind: 'question', source: 'deepseek', model: modelLabel() },
      });
      throw new AgentAbortedError();
    }
    if (error instanceof EngineeringBackendError) {
      useAppStore.getState().updateMessage(messageId, {
        content: `**工程后端调用失败：** ${error.message}\n\n请检查计算服务，恢复后再重试建模。`,
        reasoning, steps: [...steps], streaming: false,
        meta: { kind: 'question', source: 'deepseek', model: modelLabel() },
      });
      throw error;
    }
    if (!(error instanceof DeepSeekApiError)) {
      const message = error instanceof Error ? error.message : String(error);
      useAppStore.getState().updateMessage(messageId, {
        content: `**工程任务未完成：** ${message}`, reasoning, steps: [...steps], streaming: false,
        meta: { kind: 'question', source: 'system' },
      });
      throw error instanceof AgentTaskError ? error : new AgentTaskError(message);
    }
    const { message, retryable } = describeApiError(error);
    const fallbackNote = error.status === 401 || error.status === 403 ? '请检查 API Key 与访问权限。'
      : retryable ? '可检查网络或服务状态后重试。' : '请根据上述服务返回信息检查请求或模型设置。';
    useAppStore.getState().updateMessage(messageId, {
      content: `${content ? `${content}\n\n` : ''}**DeepSeek 调用失败：** ${message}\n\n${fallbackNote}`,
      reasoning,
      steps: steps.map((step) =>
        step.status === 'running' ? { ...step, status: 'error', detail: message } : step,
      ),
      streaming: false,
      meta: { kind: 'question', source: 'deepseek', model: modelLabel() },
    });
    useLlmStore.getState().markError(message);
    throw error;
  }
}
