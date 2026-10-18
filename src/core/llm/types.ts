export type DeepSeekModel = 'deepseek-flash' | 'deepseek-v4-pro';
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface LlmSettings {
  preferDeepSeek: boolean;
  model: DeepSeekModel;
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  streaming: boolean;
  temperature: number;
  maxTokens: number;
  rememberKey: boolean;
}

export type LlmConnectionStatus = 'unknown' | 'checking' | 'connected' | 'error';

export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
}

export interface DeepSeekTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamCallbacks {
  onContent?: (delta: string, accumulated: string) => void;
  onReasoning?: (delta: string, accumulated: string) => void;
  onToolCalls?: (calls: DeepSeekToolCall[]) => void;
  onUsage?: (usage: LlmTokenUsage) => void;
  signal?: AbortSignal;
}

export interface DeepSeekCompletion {
  content: string;
  reasoning: string;
  toolCalls: DeepSeekToolCall[];
  finishReason: string;
  usage: LlmTokenUsage;
  model: string;
  latencyMs: number;
}

export interface GatewayStatus {
  provider: string;
  gateway: string;
  hasServerKey: boolean;
  target: string;
  models: string[];
}
