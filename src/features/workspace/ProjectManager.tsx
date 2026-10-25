import { useEffect, useRef, useState } from 'react';
import { CoreApiError, coreArtifactUrl, coreCommand, coreRequest, type CoreRevision, type CoreJob } from './api';
import { ProjectImport } from './ProjectImport';

export function ProjectManager({ selected, onOpen, onChanged, onClose, onDeleted, initialAction = 'create' }: {
  selected: string; onOpen: (id: string) => void; onChanged: () => Promise<void>; onClose: () => void; onDeleted: (id: string) => void; initialAction?: 'create' | 'search';
}) {
  const [projects, setProjects] = useState<CoreRevision[]>([]);
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [rename, setRename] = useState<CoreRevision | null>(null);
  const [nextName, setNextName] = useState('');
  const [deleting, setDeleting] = useState<CoreRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (deleting) cancelDelete.current?.focus(); }, [deleting]);
  const load = async () => setProjects(await coreRequest<CoreRevision[]>('/projects'));
  useEffect(() => {
    dialog.current?.showModal();
    if (initialAction === 'search') searchInput.current?.focus();
    void load().catch(failure => setError(String(failure)));
    return () => dialog.current?.close();
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setStatus('');
    try { await action(); } catch (failure) { setError(String(failure)); await load().catch(() => {}); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!deleting) return;
    const item = deleting;
    await coreRequest(`/projects/${item.project_id}/stop`, coreCommand(item.revision_id));
    setStatus('正在停止工程作业…');
    let stopped = false;
    for (let i = 0; i < 30; i++) {
      const jobs = await coreRequest<CoreJob[]>(`/projects/${item.project_id}/jobs`);
      if (!jobs.some(job => ['queued', 'running', 'cancelling'].includes(job.state))) { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!stopped) throw new Error('作业仍在停止中，工程尚未删除。请稍后重新确认。');
    let result: { warnings: string[] };
    try {
      result = await coreRequest<{ warnings: string[] }>(`/projects/${item.project_id}/delete`, {
        ...coreCommand(item.revision_id), confirmed_name: item.document.name });
    } catch (failure) {
      if (!(failure instanceof CoreApiError) || (failure.status !== 0 && failure.status < 500)) throw failure;
      // A lost response or post-commit cleanup error does not undo deletion.
      // Reconcile against the authoritative list without resubmitting a delete.
      let current: CoreRevision[];
      try { current = await coreRequest<CoreRevision[]>('/projects'); }
      catch { throw failure; }
      if (current.some(project => project.project_id === item.project_id)) throw failure;
      result = { warnings: ['工程已删除。服务响应异常，本地文件清理状态尚未确认。'] };
    }
    onDeleted(item.project_id);
    setDeleting(null); setRename(null);
    setStatus(result.warnings.length ? result.warnings.join(' ') : '工程已永久删除。');
    await onChanged(); await load();
  };
  return <dialog ref={dialog} className="core-modal project-manager" aria-label="工程管理" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="core-modal-heading"><div><h2>工程管理</h2><p>打开已保存工程，或新建一项设计。</p></div><button disabled={busy} onClick={onClose}>关闭</button></div>
    {error && <p role="alert" className="core-error">{error}</p>}
    {status && <p role="status">{status}</p>}
    <form className="workspace-project-create" onSubmit={event => { event.preventDefault(); void run(async () => {
      const created = await coreRequest<CoreRevision>('/projects', { ...coreCommand(), name: name.trim() });
      await onChanged(); onOpen(created.project_id); onClose();
    }); }}>
      <label>新工程名称<input autoFocus aria-label="新工程名称" maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="例如：电机安装支架" /></label>
      <button className="core-primary" disabled={busy || !name.trim()}>新建工程</button>
    </form>
    <ProjectImport busy={busy} workspaceEmpty={projects.length === 0} run={run} onImported={async revision => { await onChanged(); onOpen(revision.project_id); onClose(); }} />
    <label>查找工程<input ref={searchInput} aria-label="查找工程" value={search} onChange={event => setSearch(event.target.value)} placeholder="按工程名称搜索" /></label>
    <div className="workspace-project-list">
      {projects.filter(item => item.document.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(item => <article key={item.project_id} className="project-row">
        <div><h3>{item.document.name}{selected === item.project_id && <small> · 当前打开</small>}</h3><p>{item.document.geometry ? '已有三维模型' : '空白工程'} · 更新于 {new Date(item.created_at * 1000).toLocaleString()}</p></div>
        <div className="project-row-actions">
          <button disabled={busy} onClick={() => { onOpen(item.project_id); onClose(); }}>打开</button>
          <button disabled={busy} onClick={() => { setRename(item); setNextName(item.document.name); setDeleting(null); }}>重命名</button>
          <details className="project-export"><summary>导出</summary><div>
            <a href={`/api/v2/projects/${item.project_id}/export`}>完整工程包</a>
            {item.document.geometry && <><a href={coreArtifactUrl(item.document.geometry, 'model.usda')}>USD 模型</a><a href={coreArtifactUrl(item.document.geometry, 'preview.stl')}>STL 网格</a></>}
            <a href={`/api/v2/projects/${item.project_id}/report?revision_id=${item.revision_id}`}>指标核验报告</a>
            {item.document.legacy_source && <a href={coreArtifactUrl(item.document.legacy_source, 'model.json')}>原始迁移记录</a>}
          </div></details>
          <button disabled={busy} className="core-danger" onClick={() => { setDeleting(item); setRename(null); }}>删除</button>
        </div>
      </article>)}
      {!projects.length && <p>尚无工程。输入名称即可新建。</p>}
      {projects.length > 0 && !projects.some(item => item.document.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && <p>没有匹配的工程。</p>}
    </div>
    {rename && <form className="project-confirm" onSubmit={event => { event.preventDefault(); void run(async () => {
      await coreRequest(`/projects/${rename.project_id}/rename`, { ...coreCommand(rename.revision_id), name: nextName.trim(), require_idle: true });
      setRename(null); await onChanged(); await load(); setStatus('工程名称已更新。');
    }); }}>
      <h3>重命名「{rename.document.name}」</h3><label>新的工程名称<input autoFocus aria-label="新的工程名称" maxLength={200} value={nextName} onChange={event => setNextName(event.target.value)} /></label>
      <button className="core-primary" disabled={busy || !nextName.trim()}>保存名称</button><button type="button" disabled={busy} onClick={() => setRename(null)}>取消重命名</button>
    </form>}
    {deleting && <section className="project-confirm" role="alertdialog" aria-label="确认永久删除工程">
      <h3>永久删除「{deleting.document.name}」？</h3>
      <p>将停止该工程的执行，并永久删除工程、所有版本、对话、作业记录及未被其他工程使用的模型与结果文件。此操作不提供恢复，已导出的工程包及历史备份不受影响。</p>
      <button className="core-danger" disabled={busy} onClick={() => void run(remove)}>确认永久删除</button>
      <button ref={cancelDelete} disabled={busy} onClick={() => setDeleting(null)}>取消删除</button>
    </section>}
  </dialog>;
}
