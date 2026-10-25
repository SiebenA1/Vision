import { useEffect, useRef, useState } from 'react';
import { Brush, Cpu, Database, Monitor, Moon, Sun, X } from 'lucide-react';
import { coreRequest } from './api';
import { ModelSettingsModal } from './ModelSettingsModal';

export interface UIPreferences { theme: 'system' | 'light' | 'dark'; sidebar_collapsed: boolean; chat_width: number }
export type SettingsPage = 'appearance' | 'model' | 'storage';
interface ServiceInfo { controller: boolean; model: { configured: boolean }; physics: string[] }
interface StorageInfo { database: string; storage_path: string; counts: Record<string, number>; units: string; physics: string }
interface MemoryInfo { embedding: string; reranker: string; cache_present: boolean }

export function WorkspaceSettings({ initialPage, preferences, save, project, onClose }: {
  initialPage: SettingsPage; preferences: UIPreferences; save: (value: UIPreferences) => Promise<void>;
  project: string | null; revision: string | null; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(initialPage);
  const [draft, setDraft] = useState(preferences);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [service, setService] = useState<ServiceInfo | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [memory, setMemory] = useState<MemoryInfo | null>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([coreRequest<ServiceInfo>('/health', undefined, abort.signal), coreRequest<StorageInfo>('/workspace-info', undefined, abort.signal), coreRequest<MemoryInfo>('/memory/status', undefined, abort.signal)])
      .then(([health, info, retrieval]) => { setService(health); setStorage(info); setMemory(retrieval); }).catch(failure => { if (!abort.signal.aborted) setError(String(failure)); });
    return () => abort.abort();
  }, [project]);
  const pages = [{ id: 'appearance', label: '外观与布局', icon: Brush }, { id: 'model', label: '模型配置', icon: Cpu }, { id: 'storage', label: '连接与数据', icon: Database }] as const;
  return <dialog ref={dialog} className="core-modal workspace-settings" aria-label="设置" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <nav className="settings-navigation" aria-label="设置分类"><h2>设置</h2>{pages.map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><item.icon size={17} />{item.label}</button>)}<small>VISION / 本地工作区</small></nav>
    <div className="settings-content"><button className="settings-close icon-button" aria-label="关闭设置" disabled={busy} onClick={onClose}><X size={18} /></button>
      {error && <p className="core-error" role="alert">{error}</p>}
      {page === 'appearance' && <form onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); setSaved(false); void save(draft).then(() => setSaved(true)).catch(failure => setError(String(failure))).finally(() => setBusy(false)); }}>
        <h2>外观与布局</h2><p className="settings-description">让建模工作区适合你的工作方式。</p>
        <div className="settings-row"><div><h3>颜色主题</h3><p>应用于工作区、对话与设置窗口。</p></div><div className="theme-options">{([{ value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '深色', icon: Moon }, { value: 'system', label: '跟随系统', icon: Monitor }] as const).map(item => <button key={item.value} type="button" aria-pressed={draft.theme === item.value} onClick={() => { setDraft({ ...draft, theme: item.value }); setSaved(false); }}><item.icon size={17} />{item.label}</button>)}</div></div>
        <label className="settings-row"><span><strong>对话侧栏宽度</strong><small>中间空间优先留给模型。</small></span><select aria-label="对话侧栏宽度" value={draft.chat_width} onChange={event => { setDraft({ ...draft, chat_width: Number(event.target.value) }); setSaved(false); }}><option value={320}>紧凑 · 320 px</option><option value={380}>标准 · 380 px</option><option value={460}>宽屏 · 460 px</option><option value={520}>扩展 · 520 px</option></select></label>
        <label className="settings-row"><span><strong>收起工程导航</strong><small>保留展开按钮，为模型增加空间。</small></span><input type="checkbox" checked={draft.sidebar_collapsed} onChange={event => { setDraft({ ...draft, sidebar_collapsed: event.target.checked }); setSaved(false); }} /></label>
        <button className="core-primary" disabled={busy}>保存外观设置</button>{saved && <p role="status" className="settings-saved">已保存到本地工作区数据库。</p>}
      </form>}
      {page === 'model' && <ModelSettingsModal embedded onClose={onClose} />}
      {page === 'storage' && <><h2>连接与数据</h2><p className="settings-description">工作区连接的实际状态与数据位置。</p>
        <div className="connection-card"><div><span className={`status-dot ${service?.controller ? 'online' : ''}`} /><strong>本地工程服务</strong></div><p>{service ? service.controller ? '作业控制器运行中' : '服务在线，作业控制器未启动' : '正在检查…'}</p><small>{storage?.physics ?? '正在读取求解能力'}</small></div>
        <div className="connection-card"><strong>DeepSeek</strong><p>{service ? service.model.configured ? '后端密钥已配置' : '后端密钥未配置' : '正在检查…'}</p><small>对话由官方服务处理，工程工具在本机执行。模型选择在“模型配置”中管理。</small></div>
        {storage && <div className="connection-card"><strong>{storage.database} · 本地持久存储</strong><p>{storage.counts.projects} 个工程 · {storage.counts.revisions} 个版本 · {storage.counts.jobs} 项作业</p><code>{storage.storage_path}</code><small>工程、对话和来源由后端保存。计量单位：{storage.units}。在工程管理中导出完整工程包。</small></div>}
        {memory && <div className="connection-card"><strong>本地语义检索</strong><p>{memory.cache_present ? '开源模型权重已安装' : '尚未安装权重，使用关键词检索'}</p><small>{memory.embedding}<br />{memory.reranker}</small></div>}
      </>}
    </div>
  </dialog>;
}
