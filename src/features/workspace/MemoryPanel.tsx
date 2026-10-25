import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { coreCommand, coreRequest, type CoreRequirement } from './api';

export interface MemorySeed { id: string; text: string }
interface Memory { source_id: string; kind: string; text: string; status: string; scope: string; applicable: boolean; confirmed: boolean; authored_by: string; derived_from: string[]; revision_id: string }
interface Source { source_id: string; origin: string; text: string }
interface ProjectState { revision_id: string; name: string; geometry_available: boolean; study_configured: boolean; requirements: CoreRequirement[] }
interface ContextView { mode: string; available?: boolean; notice?: string; context?: Record<string, unknown>; request?: Record<string, unknown>; metadata?: { characters?: number; source_ids?: string[]; layers?: Record<string, { used_characters: number; omitted_entries: number }>; retrieval?: { mode?: string; result_cache_hit?: boolean; degraded_reason?: string | null } }; provider_confirmed?: boolean; model?: string; epoch?: number }
const kinds: Record<string, string> = { requirement: '工程要求', decision: '已定方案', open_question: '待解决问题', stage: '阶段摘要' };
const scopes: Record<string, string> = { project: '整个工程', geometry: '当前几何', revision: '当前版本' };
const layerNames: Record<string, string> = { recent_tool_groups:'近期工具证据',long_term_memory:'要求与方案',stage_memory:'阶段摘要',historical_sources:'历史召回',conversation_messages:'对话',cad_api_reference:'接口说明',cad_api_signatures:'接口签名' };

export function MemoryPanel({ project, revision, task, onClose, embedded = false, initialSource }: { project: string; revision: string; task: string | null; onClose: () => void; embedded?: boolean; initialSource?: MemorySeed | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<Memory[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [contextTask, setContextTask] = useState(task);
  const [formOpen, setFormOpen] = useState(!!initialSource);
  const [source, setSource] = useState(initialSource?.id ?? '');
  const [summary, setSummary] = useState(initialSource?.text ?? '');
  const [kind, setKind] = useState('requirement');
  const [scope, setScope] = useState('project');
  const [editing, setEditing] = useState<Memory | null>(null);
  const [expanded, setExpanded] = useState('');
  const [context, setContext] = useState<ContextView | null>(null);
  const [forget, setForget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const base = '/projects/' + project;
  const load = async () => {
    const value = await coreRequest<{ entries: Memory[]; sources: Source[]; can_edit: boolean; task_id: string | null; project: ProjectState }>(base + '/memory');
    setEntries(value.entries); setSources(value.sources ?? []); setCanEdit(value.can_edit); setContextTask(value.task_id ?? task);
    setProjectState(value.project ?? null);
  };
  useEffect(() => { if (!embedded) dialog.current?.showModal(); return () => { dialog.current?.close(); }; }, [embedded]);
  useEffect(() => { void load().catch(failure => setError(String(failure))); }, [project, revision]);
  const action = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  };
  const save = async (value: { text: string; kind: string; scope: string; source: string; replaces?: string }) => {
    await coreRequest(base + '/memory', { ...coreCommand(revision), kind: value.kind, summary: value.text,
      source_ids: value.source ? [value.source] : [], supersedes: value.replaces ? [value.replaces] : [], scope: value.scope });
    setContext(null); await load();
  };
  const edit = (entry?: Memory) => {
    setEditing(entry ?? null); setSummary(entry?.text ?? ''); setKind(entry?.kind ?? 'requirement'); setScope(entry?.scope ?? 'project'); setSource(''); setFormOpen(true);
  };
  const current = entries.filter(entry => entry.applicable && entry.kind !== 'stage');
  const pending = current.filter(entry => !entry.confirmed && entry.kind !== 'open_question');
  const history = entries.filter(entry => !entry.applicable || entry.kind === 'stage');
  const card = (entry: Memory) => <article className={'memory-entry' + (expanded === entry.source_id ? ' is-expanded' : '')} key={entry.source_id}>
    <div className="memory-entry-heading"><strong>{kinds[entry.kind] ?? entry.kind}</strong><span>{entry.status === 'inactive' ? '已停用' : entry.status === 'superseded' ? '已替代' : !entry.applicable ? '历史记录' : entry.kind === 'stage' ? '当前阶段摘要' : entry.confirmed ? '用户记录' : '智能体整理 · 待确认'}</span></div>
    <p className="memory-entry-text">{entry.text}</p>
    <div className="memory-entry-actions">
      <button disabled={busy} onClick={() => setExpanded(expanded === entry.source_id ? '' : entry.source_id)}>{expanded === entry.source_id ? '收起来源' : '来源与适用范围'}</button>
      {entry.status !== 'superseded' && entry.kind !== 'stage' && <>
        {entry.applicable && !entry.confirmed && <button disabled={busy || !canEdit} onClick={() => void action(async () => { await save({ text: entry.text, kind: entry.kind, scope: entry.scope, source: '', replaces: entry.source_id }); setNotice('已采纳为用户记录，计算结论仍需工具证据。'); })}>采纳</button>}
        <button disabled={busy || !canEdit} onClick={() => edit(entry)}>纠正</button>
      </>}
      {entry.status !== 'superseded' && <button disabled={busy || !canEdit} onClick={() => void action(async () => {
        await coreRequest(base + '/memory/state', { ...coreCommand(revision), source_id: entry.source_id, enabled: entry.status === 'inactive' });
        setContext(null); await load(); setNotice(entry.status === 'inactive' ? '已恢复使用，历史记录仍按适用范围处理。' : '已停用该记录，原始对话、来源和工程版本保留。');
      })}>{entry.status === 'inactive' ? '恢复使用' : '停用'}</button>}
    </div>
    {expanded === entry.source_id && <div className="memory-provenance"><p>{scopes[entry.scope] ?? entry.scope} · 版本 {entry.revision_id.slice(0, 8)} · {entry.authored_by === 'user' ? '人工记录' : '模型摘要'}。来源可追溯不等于工程事实已核验。</p>{entry.derived_from.map((id, index) => <a key={id} href={'/api/v2' + base + '/sources/' + id} target="_blank" rel="noreferrer">查看来源 {index + 1}</a>)}</div>}
  </article>;
  const content = <>
    <div className="core-modal-heading"><div><h2>当前工程上下文</h2><p>保留要求、方案和待办。几何与计算事实以当前工程及工具回执为准。</p></div><div className="memory-heading-actions"><button className="icon-button" aria-label="刷新工程上下文" title="刷新" disabled={busy} onClick={() => void action(load)}><RefreshCw size={15} /></button>{!embedded && <button className="icon-button" aria-label="关闭工程上下文" disabled={busy} onClick={onClose}><X size={17} /></button>}</div></div>
    {error && <p className="core-error" role="alert">{error}</p>}
    {notice && <p className="memory-notice" role="status">{notice}</p>}
    {projectState && <div className="memory-project-state"><strong>{projectState.name}</strong><span>版本 {projectState.revision_id.slice(0, 8)} · {projectState.geometry_available ? '已构建模型' : '尚无模型'} · {projectState.study_configured ? '已配置工况' : '未配置工况'}</span></div>}
    {!canEdit && <p className="memory-notice">正在读取或工程任务尚未结束。可先查看；停止执行后刷新，即可整理记录。</p>}
    <div className="memory-summary-bar"><span>{current.filter(entry => entry.confirmed).length} 条用户记录 · {current.filter(entry => entry.kind === 'open_question').length} 项待办</span><button disabled={busy || !canEdit} onClick={() => formOpen ? setFormOpen(false) : edit()}><Plus size={14} />{formOpen ? '收起编辑' : '添加记录'}</button></div>
    {formOpen && <form className="memory-editor" onSubmit={event => { event.preventDefault(); void action(async () => {
      await save({ text: summary, kind, scope, source, replaces: editing?.source_id }); setSummary(''); setEditing(null); setFormOpen(false); setNotice('已保存。');
    }); }}>
      <h3>{editing ? '纠正并替代旧记录' : '添加工程记录'}</h3><div className="memory-form-row"><label>类型<select value={kind} onChange={event => setKind(event.target.value)}>{Object.entries(kinds).filter(([key]) => key !== 'stage').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>适用范围<select value={scope} onChange={event => setScope(event.target.value)}>{Object.entries(scopes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <label>引用来源（可选）<select aria-label="记忆来源" value={source} onChange={event => setSource(event.target.value)}><option value="">直接记录，以本次人工输入为来源</option>{initialSource && !sources.some(item => item.source_id === initialSource.id) && <option value={initialSource.id}>所选对话：{initialSource.text.slice(0, 90)}</option>}{sources.map(item => <option key={item.source_id} value={item.source_id}>{item.origin === 'tool_receipt' ? '工具回执' : '用户输入'}：{item.text.slice(0, 90)}</option>)}</select></label>
      <label>内容<textarea aria-label="记忆内容" rows={4} maxLength={2000} value={summary} onChange={event => setSummary(event.target.value)} /></label><small>{summary.length} / 2000 字符。引用消息不会自动证明记录内容，请保留准确的要求或方案。</small><div className="memory-editor-actions"><button className="core-primary" disabled={busy || !canEdit || !summary.trim() || summary.length > 2000}>保存记录</button><button type="button" disabled={busy} onClick={() => { setFormOpen(false); setEditing(null); }}>取消</button></div>
    </form>}
    {(['requirement','decision','open_question'] as const).map(type => {
      const items = current.filter(entry => entry.kind === type && (entry.confirmed || type === 'open_question'));
      return <section className="memory-section" key={type}><h3>{kinds[type]}<span>{items.length + (type === 'requirement' ? projectState?.requirements.length ?? 0 : 0)}</span></h3>
        {type === 'requirement' && projectState?.requirements.map(item => <article className="memory-entry" key={item.id}><div className="memory-entry-heading"><strong>{item.name}</strong><span>工程版本中的数值指标</span></div><p>{item.comparison === 'le' ? '≤' : '≥'} {item.threshold} {item.unit}</p><a href={'/api/v2' + base + '/sources/' + item.source_event} target="_blank" rel="noreferrer">查看指标来源</a></article>)}
        {items.length ? items.slice().reverse().map(card) : (type !== 'requirement' || !projectState?.requirements.length) && <p className="memory-empty">{type === 'requirement' ? '可从对话中“记为要求”，也可直接添加。' : type === 'decision' ? '已确定的方案会显示在这里。' : '当前没有记录中的待解决问题。'}</p>}</section>;
    })}
    {pending.length > 0 && <details className="memory-history"><summary>智能体整理 · 待确认（{pending.length}）</summary><p>这些是模型整理的线索，可采纳或纠正，不标记为已核验事实。</p>{pending.slice().reverse().map(card)}</details>}
    {history.length > 0 && <details className="memory-history"><summary>阶段摘要与历史记录（{history.length}）</summary><p>过期摘要不作为当前事实；停用记录不再自动召回，但不撤销原始对话或改变工程数据。</p>{history.slice().reverse().map(card)}</details>}
    <details className="memory-diagnostics"><summary>高级：上下文检查与彻底遗忘</summary><p>本地检索模型信息位于“设置 → 连接与数据”。这里的检查不调用 DeepSeek。请求快照仅保存在当前工作区，不包含在工程包中。</p>
      {contextTask && <><div className="memory-diagnostic-actions"><button disabled={busy} onClick={() => void action(async () => setContext(await coreRequest<ContextView>('/tasks/' + contextTask + '/context?view=preview')))}>预览当前上下文</button><button disabled={busy} onClick={() => void action(async () => setContext(await coreRequest<ContextView>('/tasks/' + contextTask + '/context?view=last-request')))}>查看上次请求快照</button></div>
        {context && <div className="memory-context-summary"><p>{context.notice}</p>{context.context && <><p>{context.mode === 'last-request' ? (context.model ?? '') + ' · 第 ' + context.epoch + ' 轮 · ' + (context.provider_confirmed ? '已有供应商回执' : '发送结果未确认') : '当前重新编译预览'} · {context.metadata?.characters ?? '—'} 字符 · {context.metadata?.source_ids?.length ?? 0} 个来源</p><p>召回：{context.metadata?.retrieval?.mode ?? '—'}{context.metadata?.retrieval?.result_cache_hit ? ' · 已复用检索结果' : ''}{context.metadata?.retrieval?.degraded_reason ? ' · 已降级' : ''}</p><dl>{Object.entries(context.metadata?.layers ?? {}).map(([name, value]) => <div key={name}><dt>{layerNames[name] ?? name}</dt><dd>{value.used_characters} 字符{value.omitted_entries ? ' · 省略 ' + value.omitted_entries + ' 项' : ''}</dd></div>)}</dl><pre className="memory-context">{JSON.stringify(context.request ?? context.context, null, 2)}</pre></>}</div>}
      </>}
      <div className="memory-forget"><label>彻底遗忘<select value={forget} onChange={event => setForget(event.target.value)}><option value="">选择需要彻底遗忘的记录</option>{entries.map(entry => <option key={entry.source_id} value={entry.source_id}>{entry.text.slice(0, 80)}</option>)}</select></label><p>会清除相关派生记录、相关任务回执和当前工程请求快照。一般整理请使用“停用”；已提交工程版本仍保留，本地遗忘不会撤回已发送给模型的内容。</p><button disabled={busy || !forget} onClick={() => {
        if (!window.confirm('彻底遗忘所选记录及其派生内容，并清除当前工程请求快照？相关任务会停止，已提交工程版本保留。')) return;
        void action(async () => { await coreRequest(base + '/sources/forget', { ...coreCommand(), source_id: forget }); setForget(''); setContext(null); await load(); setNotice('已按要求遗忘相关内容。'); });
      }}>彻底遗忘所选记录</button></div>
    </details>
  </>;
  return embedded ? <section className="settings-memory" aria-label="当前工程上下文">{content}</section> : <dialog ref={dialog} className="core-modal engineering-memory" aria-label="当前工程上下文" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{content}</dialog>;
}
