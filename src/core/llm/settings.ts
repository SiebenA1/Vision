import type { LlmSettings } from '../../core/llm/types';

const SETTINGS_KEY = 'vision.llm.settings.v1';
const SESSION_SECRET = 'vision.deepseek.key.session';
const LOCAL_SECRET = 'vision.deepseek.key.persist';

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  preferDeepSeek: true,
  model: 'deepseek-flash',
  thinking: true,
  reasoningEffort: 'high',
  streaming: true,
  temperature: 0.25,
  maxTokens: 32768,
  rememberKey: false,
};

let memoryKey: string | null = null;

function canUseStorage(): boolean {
  return typeof window !== 'undefined';
}

export function loadLlmSettings(): LlmSettings {
  if (!canUseStorage()) return { ...DEFAULT_LLM_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_LLM_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<LlmSettings>;
    return {
      ...DEFAULT_LLM_SETTINGS,
      ...parsed,
      model: parsed.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
      reasoningEffort:
        parsed.reasoningEffort === 'low' || parsed.reasoningEffort === 'max'
          ? parsed.reasoningEffort
          : 'high',
      temperature:
        typeof parsed.temperature === 'number' ? Math.max(0, Math.min(2, parsed.temperature)) : 0.25,
      maxTokens:
        typeof parsed.maxTokens === 'number' ? Math.max(512, Math.min(131072, parsed.maxTokens)) : 32768,
    };
  } catch {
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

export function persistLlmSettings(settings: LlmSettings): void {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings persistence is best-effort; private browsing can deny it.
  }
}

export function getApiKey(): string {
  if (!canUseStorage()) return memoryKey ?? '';
  if (memoryKey) return memoryKey;
  const remembered = localStorage.getItem(LOCAL_SECRET);
  const session = sessionStorage.getItem(SESSION_SECRET);
  memoryKey = session || remembered || '';
  return memoryKey;
}

export function hasApiKey(): boolean {
  return getApiKey().length > 0;
}

export function setApiKey(key: string, remember: boolean): void {
  const clean = key.trim();
  memoryKey = clean;
  if (!canUseStorage()) return;
  try {
    if (clean) sessionStorage.setItem(SESSION_SECRET, clean);
    else sessionStorage.removeItem(SESSION_SECRET);
    if (clean && remember) localStorage.setItem(LOCAL_SECRET, clean);
    else localStorage.removeItem(LOCAL_SECRET);
  } catch {
    // Storage may be unavailable; memory still works for this session.
  }
}

export function clearApiKey(): void {
  memoryKey = '';
  if (!canUseStorage()) return;
  try {
    sessionStorage.removeItem(SESSION_SECRET);
    localStorage.removeItem(LOCAL_SECRET);
  } catch {
    // Ignore.
  }
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}
