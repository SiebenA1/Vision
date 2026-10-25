import { useEffect, useRef, useState } from 'react';
import { coreCommand, coreRequest } from './api';

interface Settings { model: string; models: string[]; configured: boolean; endpoint: string; timeout_seconds: number; max_output_tokens: number }
export function ModelSettingsModal({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!embedded) dialog.current?.showModal(); const abort = new AbortController();
    void coreRequest<Settings>('/model-settings', undefined, abort.signal).then(value => { setSettings(value); setModel(value.model); }).catch(failure => { if (!abort.signal.aborted) setError(String(failure)); });
    return () => { abort.abort(); dialog.current?.close(); };
  }, []);
  const content = <>
    <div className="core-modal-heading"><div><h2>模型配置</h2><p>选择与你一起工作的智能体模型。</p></div>{!embedded && <button disabled={busy} onClick={onClose}>关闭</button>}</div>
    {error && <p role="alert" className="core-error">{error}</p>}
    {settings && <form onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); setSaved(false);
      void coreRequest<Settings>('/model-settings', { ...coreCommand(), model }).then(value => { setSettings(value); setSaved(true); }).catch(failure => setError(String(failure))).finally(() => setBusy(false));
    }}>
      <p>DeepSeek 官方服务 · {settings.configured ? '后端密钥已配置' : '后端尚未配置密钥'}</p>
      <label>智能体模型<select aria-label="智能体模型" value={model} onChange={event => { setModel(event.target.value); setSaved(false); }}>{settings.models.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <p>保存后用于新任务及下一条对话消息；正在执行的任务保留启动时的模型。</p>
      <details><summary>连接与执行设置</summary><p>服务地址：{settings.endpoint}</p><p>单次网络总超时：{settings.timeout_seconds} 秒 · 单次输出上限：{settings.max_output_tokens} token。</p><p>默认快速推理，复杂分件规划或构建失败修复时提高推理强度。每步依据工具结果继续，当前使用非流式响应。</p></details>
      <p>密钥只从后端 DEEPSEEK_API_KEY 或仓库 .env 读取。此窗口不读取或显示密钥，不使用旧浏览器中的密钥配置。</p>
      <button className="core-primary" disabled={busy || !model}>保存模型配置</button>
      {saved && <p role="status">模型配置已保存。</p>}
    </form>}
  </>;
  return embedded ? <section className="settings-model" aria-label="模型配置">{content}</section> : <dialog ref={dialog} className="core-modal model-settings" aria-label="模型配置" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{content}</dialog>;
}
