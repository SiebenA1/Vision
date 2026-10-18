import type {
  DeepSeekCompletion,
  DeepSeekMessage,
  DeepSeekTool,
  DeepSeekToolCall,
  LlmSettings,
  LlmTokenUsage,
  StreamCallbacks,
} from './types';
import { getApiKey } from './settings';

export class DeepSeekApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'DeepSeekApiError';
    this.status = status;
    this.code = code;
  }
}

interface CompletionRequest {
  messages: DeepSeekMessage[];
  tools?: DeepSeekTool[];
  settings: LlmSettings;
  serverKey: boolean;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}

function emptyUsage(): LlmTokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function normalizeUsage(raw: unknown): LlmTokenUsage {
  if (!raw || typeof raw !== 'object') return emptyUsage();
  const usage = raw as Record<string, unknown>;
  return {
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
    totalTokens: Number(usage.total_tokens ?? 0),
    reasoningTokens:
      (usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens !== undefined
        ? Number((usage.completion_tokens_details as Record<string, unknown>).reasoning_tokens)
        : undefined,
  };
}

async function errorFromResponse(response: Response): Promise<DeepSeekApiError> {
  const text = await response.text();
  let message = text;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } };
    message = parsed.error?.message ?? text;
    code = parsed.error?.code ?? parsed.error?.type;
  } catch {
    // Plain text.
  }
  if (response.status === 401) message = message || 'API key 无效或已过期';
  if (response.status === 402) message = message || 'DeepSeek 账户余额不足';
  if (response.status === 429) message = message || 'DeepSeek 请求频率超限';
  return new DeepSeekApiError(message || `DeepSeek HTTP ${response.status}`, response.status, code);
}

interface StreamAccumulator {
  content: string;
  reasoning: string;
  toolCalls: Map<number, DeepSeekToolCall>;
  usage: LlmTokenUsage;
  finishReason: string;
}

function applyDelta(accumulator: StreamAccumulator, payload: Record<string, unknown>, callbacks?: StreamCallbacks) {
  const choices = payload.choices as Array<Record<string, unknown>> | undefined;
  const usage = payload.usage;
  if (usage) {
    accumulator.usage = normalizeUsage(usage);
    callbacks?.onUsage?.(accumulator.usage);
  }
  if (!choices || choices.length === 0) return;
  const choice = choices[0];
  if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
    accumulator.finishReason = choice.finish_reason;
  }
  const delta = (choice.delta ?? {}) as Record<string, unknown>;
  const content = typeof delta.content === 'string' ? delta.content : '';
  if (content) {
    accumulator.content += content;
    callbacks?.onContent?.(content, accumulator.content);
  }
  const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
  if (reasoning) {
    accumulator.reasoning += reasoning;
    callbacks?.onReasoning?.(reasoning, accumulator.reasoning);
  }
  const toolDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolDeltas) {
    for (const toolDelta of toolDeltas) {
      const index = Number(toolDelta.index ?? 0);
      const existing =
        accumulator.toolCalls.get(index) ??
        ({
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        } satisfies DeepSeekToolCall);
      if (typeof toolDelta.id === 'string' && toolDelta.id) existing.id = toolDelta.id;
      const fn = toolDelta.function as Record<string, unknown> | undefined;
      if (fn && typeof fn.name === 'string' && fn.name) existing.function.name += fn.name;
      if (fn && typeof fn.arguments === 'string') existing.function.arguments += fn.arguments;
      accumulator.toolCalls.set(index, existing);
    }
  }
}

function finalizeToolCalls(accumulator: StreamAccumulator): DeepSeekToolCall[] {
  return [...accumulator.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call], index) => ({
      ...call,
      id: call.id || `call_${index}_${Date.now()}`,
      function: { ...call.function, arguments: call.function.arguments || '{}' },
    }));
}

export async function createDeepSeekCompletion({
  messages,
  tools,
  settings,
  serverKey,
  signal,
  callbacks,
}: CompletionRequest): Promise<DeepSeekCompletion> {
  const started = performance.now();
  const key = getApiKey();
  if (!key && !serverKey) {
    throw new DeepSeekApiError('未配置 DeepSeek API Key', 0, 'missing_key');
  }

  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    stream: settings.streaming,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    thinking: { type: settings.thinking ? 'enabled' : 'disabled' },
  };
  if (settings.thinking) body.reasoning_effort = settings.reasoningEffort;
  if (settings.streaming) body.stream_options = { include_usage: true };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: settings.streaming ? 'text/event-stream' : 'application/json',
  };
  if (key && !serverKey) headers.Authorization = `Bearer ${key}`;

  const response = await fetch('/api/deepseek/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new DeepSeekApiError(
      error instanceof Error ? `无法连接 DeepSeek 代理：${error.message}` : String(error),
      0,
      'network',
    );
  });

  if (!response.ok) throw await errorFromResponse(response);

  if (!settings.streaming) {
    const json = (await response.json()) as Record<string, unknown>;
    const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    const calls = (message.tool_calls as DeepSeekToolCall[] | undefined) ?? [];
    const usage = normalizeUsage(json.usage);
    callbacks?.onUsage?.(usage);
    if (typeof message.content === 'string' && message.content) {
      callbacks?.onContent?.(message.content, message.content);
    }
    return {
      content: typeof message.content === 'string' ? message.content : '',
      reasoning: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
      toolCalls: calls,
      finishReason: String(choice?.finish_reason ?? 'stop'),
      usage,
      model: String(json.model ?? settings.model),
      latencyMs: performance.now() - started,
    };
  }

  if (!response.body) throw new DeepSeekApiError('DeepSeek 返回了空流', response.status, 'empty_stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulator: StreamAccumulator = {
    content: '',
    reasoning: '',
    toolCalls: new Map(),
    usage: emptyUsage(),
    finishReason: 'stop',
  };
  let buffer = '';
  let done = false;

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          done = true;
          break;
        }
        try {
          applyDelta(accumulator, JSON.parse(data) as Record<string, unknown>, callbacks);
        } catch {
          // Ignore malformed keep-alive/partial events; the stream will continue.
        }
      }
    }
    if (buffer.trim().startsWith('data:')) {
      const data = buffer.trim().slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          applyDelta(accumulator, JSON.parse(data) as Record<string, unknown>, callbacks);
        } catch {
          // Ignore final malformed fragment.
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  const toolCalls = finalizeToolCalls(accumulator);
  if (toolCalls.length > 0) callbacks?.onToolCalls?.(toolCalls);
  return {
    content: accumulator.content,
    reasoning: accumulator.reasoning,
    toolCalls,
    finishReason: accumulator.finishReason,
    usage: accumulator.usage,
    model: settings.model,
    latencyMs: performance.now() - started,
  };
}

export function describeApiError(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof DeepSeekApiError) {
    const retryable =
      error.status === 0 ||
      error.status === 429 ||
      error.status >= 500 ||
      error.code === 'network' ||
      error.code === 'empty_stream';
    return { message: error.message, retryable };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { message: '请求已停止', retryable: false };
  }
  return { message: error instanceof Error ? error.message : String(error), retryable: false };
}
