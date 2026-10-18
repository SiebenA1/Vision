import { create } from 'zustand';
import type { GatewayStatus, LlmConnectionStatus, LlmSettings, LlmTokenUsage } from '../core/llm/types';
import {
  DEFAULT_LLM_SETTINGS,
  clearApiKey,
  getApiKey,
  hasApiKey,
  loadLlmSettings,
  persistLlmSettings,
  setApiKey,
} from '../core/llm/settings';

interface LlmState {
  settings: LlmSettings;
  settingsOpen: boolean;
  serverKey: boolean;
  gatewayReachable: boolean;
  gatewayStatus: GatewayStatus | null;
  connectionStatus: LlmConnectionStatus;
  connectionError: string | null;
  apiKeyPresent: boolean;
  usage: LlmTokenUsage;
  lastLatencyMs: number | null;

  openSettings: () => void;
  closeSettings: () => void;
  updateSettings: (patch: Partial<LlmSettings>) => void;
  saveKey: (key: string, remember: boolean) => void;
  removeKey: () => void;
  testConnection: () => Promise<boolean>;
  refreshGateway: () => Promise<void>;
  markConnected: (latencyMs?: number) => void;
  markError: (message: string) => void;
  addUsage: (usage: LlmTokenUsage, latencyMs: number) => void;
  resetUsage: () => void;
}

export const useLlmStore = create<LlmState>()((set, get) => ({
  settings: loadLlmSettings(),
  settingsOpen: false,
  serverKey: false,
  gatewayReachable: false,
  gatewayStatus: null,
  connectionStatus: 'unknown',
  connectionError: null,
  apiKeyPresent: hasApiKey(),
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  lastLatencyMs: null,

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  updateSettings: (patch) =>
    set((state) => {
      const next = { ...state.settings, ...patch };
      persistLlmSettings(next);
      return { settings: next };
    }),

  saveKey: (key, remember) => {
    setApiKey(key, remember);
    set((state) => ({
      apiKeyPresent: Boolean(key.trim()),
      settings: { ...state.settings, rememberKey: remember },
      connectionStatus: 'unknown',
      connectionError: null,
    }));
    persistLlmSettings({ ...get().settings, rememberKey: remember });
  },

  removeKey: () => {
    clearApiKey();
    set({ apiKeyPresent: false, connectionStatus: 'unknown', connectionError: null });
  },

  testConnection: async () => {
    set({ connectionStatus: 'checking', connectionError: null });
    const key = getApiKey();
    const serverKey = get().serverKey;
    if (!key && !serverKey) {
      set({
        connectionStatus: 'error',
        connectionError: '未配置 API Key。可在下方输入，或在 .env 中设置 DEEPSEEK_API_KEY。',
      });
      return false;
    }
    const started = performance.now();
    try {
      const response = await fetch('/api/deepseek/models', {
        method: 'GET',
        cache: 'no-store',
        headers: key && !serverKey ? { Authorization: `Bearer ${key}` } : {},
      });
      const text = await response.text();
      if (!response.ok) {
        let message = text;
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          message = parsed.error?.message ?? text;
        } catch {
          // Plain text error.
        }
        set({
          connectionStatus: 'error',
          connectionError: `${response.status} · ${message || '连接失败'}`,
        });
        return false;
      }
      set({
        connectionStatus: 'connected',
        connectionError: null,
        lastLatencyMs: Math.round(performance.now() - started),
      });
      return true;
    } catch (error) {
      set({
        connectionStatus: 'error',
        connectionError: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },

  refreshGateway: async () => {
    try {
      const response = await fetch('/api/llm/status', { cache: 'no-store' });
      if (!response.ok) {
        set({ gatewayReachable: false });
        return;
      }
      const data = (await response.json()) as GatewayStatus;
      set({
        gatewayReachable: true,
        gatewayStatus: data,
        serverKey: Boolean(data.hasServerKey),
      });
    } catch {
      set({ gatewayReachable: false });
    }
  },

  markConnected: (latencyMs) =>
    set({
      connectionStatus: 'connected',
      connectionError: null,
      lastLatencyMs: latencyMs ?? get().lastLatencyMs,
    }),
  markError: (message) => set({ connectionStatus: 'error', connectionError: message }),

  addUsage: (usage, latencyMs) =>
    set((state) => ({
      usage: {
        promptTokens: state.usage.promptTokens + usage.promptTokens,
        completionTokens: state.usage.completionTokens + usage.completionTokens,
        totalTokens: state.usage.totalTokens + usage.totalTokens,
        reasoningTokens: (state.usage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      },
      lastLatencyMs: latencyMs,
    })),

  resetUsage: () => set({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }),
}));

export function isLlmConfigured(): boolean {
  const state = useLlmStore.getState();
  return Boolean(state.serverKey || state.apiKeyPresent);
}

export function llmModelLabel(settings: LlmSettings): string {
  return settings.model === 'deepseek-v4-pro' ? 'DEEPSEEK V4 PRO' : 'DEEPSEEK FLASH';
}

export const LLM_DEFAULTS = DEFAULT_LLM_SETTINGS;

