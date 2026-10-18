import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Save,
  ShieldCheck,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useLlmStore, llmModelLabel } from '../state/llmStore';
import { getApiKey, maskApiKey } from '../core/llm/settings';
import type { DeepSeekModel, ReasoningEffort } from '../core/llm/types';

interface LlmSettingsModalProps {
  onClose: () => void;
}

export function LlmSettingsModal({ onClose }: LlmSettingsModalProps) {
  const settings = useLlmStore((state) => state.settings);
  const serverKey = useLlmStore((state) => state.serverKey);
  const apiKeyPresent = useLlmStore((state) => state.apiKeyPresent);
  const gatewayReachable = useLlmStore((state) => state.gatewayReachable);
  const gatewayStatus = useLlmStore((state) => state.gatewayStatus);
  const connectionStatus = useLlmStore((state) => state.connectionStatus);
  const connectionError = useLlmStore((state) => state.connectionError);
  const usage = useLlmStore((state) => state.usage);
  const lastLatencyMs = useLlmStore((state) => state.lastLatencyMs);
  const updateSettings = useLlmStore((state) => state.updateSettings);
  const saveKey = useLlmStore((state) => state.saveKey);
  const removeKey = useLlmStore((state) => state.removeKey);
  const testConnection = useLlmStore((state) => state.testConnection);

  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [remember, setRemember] = useState(settings.rememberKey);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    void useLlmStore.getState().refreshGateway();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    if (keyInput.trim()) saveKey(keyInput.trim(), remember);
    const ok = await testConnection();
    setTesting(false);
    const state = useLlmStore.getState();
    setTestResult({
      ok,
      message: ok
        ? `连接成功 · ${lastLatencyMs ? `${lastLatencyMs} ms` : `${state.lastLatencyMs ?? 0} ms`} · ${llmModelLabel(settings)}`
        : state.connectionError ?? '连接失败',
    });
  };

  const handleSave = async () => {
    if (keyInput.trim()) saveKey(keyInput.trim(), remember);
    else if (apiKeyPresent && remember !== settings.rememberKey) saveKey(getApiKey(), remember);
    updateSettings({ rememberKey: remember });
    if (!keyInput.trim() && !serverKey && !apiKeyPresent) {
      setTestResult({ ok: false, message: '请输入 DeepSeek API Key，或在 .env 中配置 DEEPSEEK_API_KEY。' });
      return;
    }
    if (!serverKey && (keyInput.trim() || apiKeyPresent)) {
      const ok = await testConnection();
      if (!ok) {
        setTestResult({ ok: false, message: useLlmStore.getState().connectionError ?? '连接测试未通过' });
        return;
      }
    }
    onClose();
  };

  const statusLabel = serverKey
    ? 'SERVER KEY ACTIVE'
    : apiKeyPresent
      ? 'LOCAL KEY PRESENT'
      : 'NO CREDENTIALS';
  const statusTone = serverKey || apiKeyPresent ? 'good' : 'warn';

  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="llm-settings-title">
        <header className="settings-modal__head">
          <div className="settings-modal__title">
            <span className="settings-modal__mark"><Cpu size={18} /></span>
            <div>
              <span className="eyebrow">AI ENGINE / DEEPSEEK</span>
              <h2 id="llm-settings-title">大模型能力配置</h2>
            </div>
          </div>
          <div className="settings-modal__head-right">
            <span className={`chip chip--${statusTone}`}>{statusLabel}</span>
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭设置">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="settings-modal__body">
          <section className="settings-section">
            <div className="settings-section__head">
              <div>
                <span className="eyebrow">CONNECTION</span>
                <h3>DeepSeek API</h3>
              </div>
              <span className={`gateway-pill ${gatewayReachable ? 'is-ok' : 'is-warn'}`}>
                <span />
                {gatewayReachable ? 'LOCAL GATEWAY ONLINE' : 'GATEWAY NOT DETECTED'}
              </span>
            </div>
            <p className="settings-copy">
              请求经本地 Vite 网关转发到 <code>{gatewayStatus?.target ?? 'https://api.deepseek.com'}</code>，避免浏览器
              CORS。Key 不会写入报告、几何文件或聊天记录。
            </p>
            {serverKey ? (
              <div className="settings-callout settings-callout--good">
                <ShieldCheck size={15} />
                <div>
                  <b>服务器已注入 Key</b>
                  <span>检测到 <code>DEEPSEEK_API_KEY</code> 环境变量；浏览器无需保存密钥，网关会注入 Authorization。</span>
                </div>
              </div>
            ) : (
              <>
                <label className="settings-label">
                  <span>API Key</span>
                  <div className={`settings-key ${apiKeyPresent ? 'has-key' : ''}`}>
                    <KeyRound size={14} />
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={keyInput}
                      onChange={(event) => setKeyInput(event.target.value)}
                      placeholder={apiKeyPresent ? `已保存 ${maskApiKey('sk-xxxxxxxxxxxxxxxx')} · 输入新 key 可替换` : 'sk-...'}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button type="button" className="icon-button icon-button--small" onClick={() => setShowKey((visible) => !visible)} title={showKey ? '隐藏' : '显示'}>
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </label>
                <div className="settings-row settings-row--between">
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(event) => setRemember(event.target.checked)}
                    />
                    <span>在本机记住 Key（localStorage）</span>
                  </label>
                  <div className="settings-row">
                    {apiKeyPresent && (
                      <button type="button" className="text-button text-button--danger" onClick={() => { removeKey(); setKeyInput(''); setTestResult(null); }}>
                        <Trash2 size={13} /> 清除
                      </button>
                    )}
                    <a className="text-button" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
                      <ExternalLink size={12} /> 获取 Key
                    </a>
                  </div>
                </div>
              </>
            )}
            <div className="settings-test-row">
              <button type="button" className="button" onClick={() => void handleTest()} disabled={testing || (!serverKey && !apiKeyPresent && !keyInput.trim())}>
                {testing ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
                {testing ? '测试中' : '测试连接'}
              </button>
              {testResult && (
                <span className={`settings-test-result ${testResult.ok ? 'is-ok' : 'is-bad'}`}>
                  {testResult.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                  {testResult.message}
                </span>
              )}
              {!testResult && connectionError && (
                <span className="settings-test-result is-bad"><AlertTriangle size={13} />{connectionError}</span>
              )}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__head">
              <div>
                <span className="eyebrow">MODEL ROUTING</span>
                <h3>推理与工具调用</h3>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.preferDeepSeek}
                  onChange={(event) => updateSettings({ preferDeepSeek: event.target.checked })}
                />
                <span className="switch__track"><span /></span>
              </label>
            </div>
            <p className="settings-copy">
              启用 DeepSeek 后，ATLAS 使用流式工具调用进行规划与解释；关闭或连接失败时回退到本地确定性规划器。
            </p>
            <div className="settings-grid">
              <label className="settings-label">
                <span>模型</span>
                <select
                  className="select"
                  value={settings.model}
                  onChange={(event) => updateSettings({ model: event.target.value as DeepSeekModel })}
                >
                  <option value="deepseek-flash">deepseek-flash · V4.1 Flash</option>
                  <option value="deepseek-v4-pro">deepseek-v4-pro · V4 Pro</option>
                </select>
              </label>
              <label className="settings-label">
                <span>思考强度</span>
                <select
                  className="select"
                  value={settings.reasoningEffort}
                  onChange={(event) => updateSettings({ reasoningEffort: event.target.value as ReasoningEffort })}
                  disabled={!settings.thinking}
                >
                  <option value="low">low · 快速</option>
                  <option value="high">high · 默认</option>
                  <option value="max">max · 深度</option>
                </select>
              </label>
            </div>
            <div className="settings-toggle-grid">
              <label className="settings-switch-line">
                <span className="settings-switch-line__icon"><Brain size={15} /></span>
                <span>
                  <b>思考模式</b>
                  <small>展示 reasoning_content；工具调用仍可用</small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={settings.thinking}
                    onChange={(event) => updateSettings({ thinking: event.target.checked })}
                  />
                  <span className="switch__track"><span /></span>
                </span>
              </label>
              <label className="settings-switch-line">
                <span className="settings-switch-line__icon"><Zap size={15} /></span>
                <span>
                  <b>流式输出</b>
                  <small>SSE token 流；失败时回退非流式解析</small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={settings.streaming}
                    onChange={(event) => updateSettings({ streaming: event.target.checked })}
                  />
                  <span className="switch__track"><span /></span>
                </span>
              </label>
            </div>
            <div className="settings-grid settings-grid--three">
              <label className="settings-label">
                <span>Temperature <small>非思考模式</small></span>
                <div className="settings-range">
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={settings.temperature}
                    onChange={(event) => updateSettings({ temperature: Number(event.target.value) })}
                  />
                  <b>{settings.temperature.toFixed(2)}</b>
                </div>
              </label>
              <label className="settings-label">
                <span>Max tokens</span>
                <input
                  className="input"
                  type="number"
                  min={512}
                  max={131072}
                  step={512}
                  value={settings.maxTokens}
                  onChange={(event) => updateSettings({ maxTokens: Number(event.target.value) })}
                />
              </label>
              <div className="settings-usage">
                <span className="eyebrow">SESSION USAGE</span>
                <b>{usage.totalTokens.toLocaleString('en-US')}</b>
                <small>
                  {usage.promptTokens.toLocaleString('en-US')} in / {usage.completionTokens.toLocaleString('en-US')} out
                  {usage.reasoningTokens ? ` / ${usage.reasoningTokens.toLocaleString('en-US')} think` : ''}
                </small>
                <small>{lastLatencyMs ? `last ${lastLatencyMs} ms` : 'no requests yet'}</small>
              </div>
            </div>
          </section>

          <section className="settings-section settings-section--security">
            <ShieldCheck size={16} />
            <div>
              <b>安全边界</b>
              <p>
                本地网关只代理 DeepSeek 固定域名，不接受任意目标 URL。工具参数在浏览器内校验；模型不能执行任意代码。
                若使用服务器 Key，浏览器永远看不到密钥。请勿在共享设备上勾选“记住 Key”。
              </p>
            </div>
          </section>
        </div>

        <footer className="settings-modal__footer">
          <span className="settings-model-badge"><span /> {llmModelLabel(settings)}</span>
          <div className="settings-modal__footer-actions">
            <button type="button" className="button" onClick={onClose}>取消</button>
            <button type="button" className="button button--primary" onClick={() => void handleSave()}>
              <Save size={14} /> 保存并启用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

