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

export class AgentAbortedError extends Error {
  constructor() {
    super('Agent request aborted');
    this.name = 'AgentAbortedError';
  }
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
let deepseekHistoryCode = '';
let deepseekHistoryModel = '';
let deepseekHistoryThinking: boolean | null = null;

export function resetDeepSeekConversation(): void {
  deepseekHistory = [];
  deepseekHistoryCode = '';
  deepseekHistoryModel = '';
  deepseekHistoryThinking = null;
}

function trimHistory(history: DeepSeekMessage[]): DeepSeekMessage[] {
  if (history.length <= 30) return history;
  const system = history[0]?.role === 'system' ? history[0] : null;
  let tail = history.slice(-28);
  while (tail.length > 0 && (tail[0].role === 'tool' || (tail[0].role === 'assistant' && tail[0].tool_calls))) {
    tail = tail.slice(1);
  }
  return system ? [system, ...tail] : tail;
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

function toolAction(call: DeepSeekToolCall): AgentAction {
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
  if (name === 'run_usd_brep') {
    const script = String(args.script ?? '');
    if (!script.trim()) throw new Error('USD BRep 脚本为空');
    return {
      tool: 'run_usd_brep',
      args: {
        script,
        name: String(args.name ?? 'AI B-Rep 模型'),
        code: String(args.code ?? ''),
        new_project: args.new_project === true,
        density_kg_m3: asNumber(args.density_kg_m3 ?? 2700, 'density_kg_m3'),
        materialId: String(args.materialId ?? 'AL6061-T6'),
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

export async function runDeepSeekTurn(
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  if (!isLlmConfigured()) throw new DeepSeekApiError('未配置 DeepSeek API Key', 0, 'missing_key');
  const settings = useLlmStore.getState().settings;
  const serverKey = useLlmStore.getState().serverKey;
  const store = useAppStore.getState();
  const model = store.model;
  if (
    (deepseekHistoryCode && deepseekHistoryCode !== model.code) ||
    (deepseekHistoryModel && deepseekHistoryModel !== settings.model) ||
    (deepseekHistoryThinking !== null && deepseekHistoryThinking !== settings.thinking)
  ) {
    resetDeepSeekConversation();
  }
  deepseekHistoryCode = model.code;
  deepseekHistoryModel = settings.model;
  deepseekHistoryThinking = settings.thinking;
  const context = buildModelContext(
    model,
    store.analysis,
    store.resultStale,
    store.validation,
    store.geometryMetrics
      ? {
          volumeCm3: store.geometryMetrics.volumeCm3,
          massKg: store.geometryMetrics.massKg,
          bbox: [
            store.geometryMetrics.bbox.min[0],
            store.geometryMetrics.bbox.min[1],
            store.geometryMetrics.bbox.min[2],
            store.geometryMetrics.bbox.max[0],
            store.geometryMetrics.bbox.max[1],
            store.geometryMetrics.bbox.max[2],
          ],
          triangles: store.geometryMetrics.triangleCount,
        }
      : null,
  );
  const systemMessage: DeepSeekMessage = { role: 'system', content: buildSystemPrompt(context) };
  if (deepseekHistory.length === 0) {
    deepseekHistory = [systemMessage];
  } else {
    deepseekHistory[0] = systemMessage;
  }
  const messages: DeepSeekMessage[] = [...deepseekHistory, { role: 'user', content: prompt }];

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
    for (let round = 0; round < 6; round += 1) {
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
          const result = await executeTool(action, lastResultRef);
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
          const message = error instanceof Error ? error.message : String(error);
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

    if (!finalContent) {
      finalContent = content || steps.map((step) => step.detail).filter(Boolean).join('\n') || '工具调用已完成。';
    }
    if (messages[messages.length - 1]?.role !== 'assistant' || messages[messages.length - 1]?.tool_calls) {
      messages.push({
        role: 'assistant',
        content: finalContent,
        reasoning_content: settings.thinking ? reasoning || '' : undefined,
      });
    }
    deepseekHistory = trimHistory(messages);
    const result = useAppStore.getState().analysis;
    const chips = result
      ? ['哪里最危险？', '以 SF ≥ 2.5 优化悬臂厚度', '生成工程校核报告']
      : ['运行基线校核', '把悬臂厚度改为 14 mm', '切换为 7075-T6'];
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
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
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
    const { message, retryable } = describeApiError(error);
    const fallbackNote = retryable ? '可检查网络/API 余额后重试。' : '请检查 API Key 与模型设置。';
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
