import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Box, BrainCircuit, Calculator, FlaskConical, ChevronRight, FolderOpen, History, Layers3, ListTree, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, SlidersHorizontal, Workflow, X } from 'lucide-react';
import { activeJob, coreArtifactUrl, coreCommand, coreRequest, type CoreAssessment, type CoreBuildImpact, type CoreInspection, type CoreJob, type CorePick, type CoreRequirement, type CoreRevision, type CoreStudy } from './api';
import { CoreViewport } from './CoreViewport';
import { ScriptDialog } from './ScriptDialog';

import { ConversationPanel } from './ConversationPanel';
import { ProjectManager } from './ProjectManager';
import { MemoryPanel, type MemorySeed } from './MemoryPanel';
import { WorkspaceSettings, type UIPreferences, type SettingsPage } from './WorkspaceSettings';
import { objectLabel } from './viewHelpers';
import type { ResultField } from './fields';
import { VerificationPanel } from './VerificationPanel';
import { StudyForm } from './StudyForm';
import { ComparisonPanel } from './ComparisonPanel';
import { useEditorDrafts, draftPrefix, type EditorDraft } from './drafts';


import './workspace.css';
import './desktop-shell.css';
import './desktop-model.css';
import './desktop-chat.css';
import './desktop-settings.css';
import './desktop-responsive.css';
import './simulation.css';
import './verification.css';
import './viewport-chrome.css';
import './project-context.css';

const labels: Record<CoreJob['state'], string> = { queued: '排队', running: '计算中', cancelling: '正在停止', succeeded: '完成',
  failed: '失败', cancelled: '已取消', timed_out: '超时', interrupted: '执行中断' };
const metrics = { maxDisplacement: ['最大位移', 'mm'], maxVonMises: ['von Mises 应力', 'MPa'], mass_kg: ['质量', 'kg'], safetyFactor: ['屈服安全系数', '1'] };
interface TopologyManifest {
  artifactId: string;
  replay_available?: boolean; parameters: Record<string, number | string | boolean>; settings: { tolerance_mm: number; angle_deg: number };
  bodies: Array<{ id: string; name: string; kind: 'solid' | 'sheet'; faces: Array<{ id: string; area_mm2: number }>; edges: Array<{ id: string; length_mm: number }> }>;
}
function DraftVersion({ base, current, rebase }: { base: string | null; current: string; rebase: () => void }) {
  return base && base !== current ? <div className="core-error" role="status">这份草稿来自旧版本，请核对当前工程再继续。<button onClick={rebase}>以当前版本继续编辑</button></div> : null;
}

export default function CoreWorkspace() {
  const [scriptOpen, setScriptOpen] = useState(false);
  const [objectListOpen, setObjectListOpen] = useState(false);
  const [regionSettingsOpen, setRegionSettingsOpen] = useState(false);
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [managerAction, setManagerAction] = useState<'create' | 'search'>('create');
  const openProjects = (action: 'create' | 'search') => { setManagerAction(action); setProjectManagerOpen(true); };
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memorySeed, setMemorySeed] = useState<MemorySeed | null>(null);
  const openMemory = (source?: MemorySeed) => { setMemorySeed(source ?? null); setMemoryOpen(true); };
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [preferences, setPreferences] = useState<UIPreferences>({ theme: 'system', sidebar_collapsed: false, chat_width: 380 });
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [chatOpen, setChatOpen] = useState(() => window.innerWidth >= 1000);
  const [bottomTab, setBottomTab] = useState<'results' | 'jobs' | 'versions' | null>(null);
  const [projects, setProjects] = useState<CoreRevision[]>([]);
  const [selected, setSelected] = useState('');
  const [head, setHead] = useState<CoreRevision | null>(null);
  const [history, setHistory] = useState<CoreRevision[]>([]);
  const [jobs, setJobs] = useState<CoreJob[]>([]);
  const [assessment, setAssessment] = useState<CoreAssessment | null>(null);
  const [metric, setMetric] = useState<CoreRequirement['metric']>('maxDisplacement');
  const [threshold, setThreshold] = useState('');
  const [statement, setStatement] = useState('');
  const [script, setScript] = useState('');
  const [buildMode, setBuildMode] = useState('current');
  const [replaySource, setReplaySource] = useState<string | null>(null);
  const [inspectOnly, setInspectOnly] = useState(false);
  const [topology, setTopology] = useState<TopologyManifest | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [referenceRequest, setReferenceRequest] = useState(0);
  const [inspection, setInspection] = useState<CoreInspection | null>(null);
  const [queryBusy, setQueryBusy] = useState(false);
  const [pickMode, setPickMode] = useState<CorePick['kind'] | 'view'>('face');
  const [pickFeedback, setPickFeedback] = useState('点击模型选择面；拖动旋转，滚轮缩放。');
  const [pickReset, setPickReset] = useState(0);
  const [field, setField] = useState<ResultField | 'geometry'>('geometry');
  const [deformation, setDeformation] = useState(0);
  const queryEpoch = useRef(0);
  const [workspacePage, setWorkspacePage] = useState<'model' | 'simulation' | 'verification'>('model');
  const requirementPanel = useRef<HTMLDetailsElement>(null);
  const precisionPanel = useRef<HTMLDetailsElement>(null);
  const [objectName, setObjectName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [parameters, setParameters] = useState('{}');
  const [tolerance, setTolerance] = useState(.05);
  const [angle, setAngle] = useState(10);
  const [scriptHead, setScriptHead] = useState<string | null>(null);
  const [studyHead, setStudyHead] = useState<string | null>(null);
  const [requirementHead, setRequirementHead] = useState<string | null>(null);
  const [studyDirty, setStudyDirty] = useState(false);
  const [draftOwner, setDraftOwner] = useState('');
  const [impact, setImpact] = useState<(CoreBuildImpact & { editorKey: string }) | null>(null);
  const [study, setStudy] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const current = useRef(selected); current.current = selected;
  const generation = useRef(0);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const savePreferences = async (value: UIPreferences) => {
    const saved = await coreRequest<UIPreferences>('/ui-settings', { ...coreCommand(), ...value });
    setPreferences(saved);
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setManagerAction('search'); setProjectManagerOpen(true); }
      if (event.key === 'Escape') setObjectListOpen(false);
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);

  const refreshProjects = async () => {
    const [list, appearance] = await Promise.all([coreRequest<CoreRevision[]>('/projects'), coreRequest<UIPreferences>('/ui-settings')]);
    setPreferences(appearance); setPreferencesReady(true);
    setProjects(list); setConnected(true);
    setSelected(previous => {
      if (list.some(item => item.project_id === previous)) return previous;
      let remembered = '';
      try { remembered = localStorage.getItem('vision.core.active-project') ?? ''; } catch { /* Storage can be unavailable. */ }
      return list.find(item => item.project_id === remembered)?.project_id ?? list[0]?.project_id ?? '';
    });
  };
  useEffect(() => {
    if (selected) {
      try { localStorage.setItem('vision.core.active-project', selected); } catch { /* The backend remains authoritative. */ }
    }
  }, [selected]);
  useEffect(() => { void refreshProjects().catch(failure => setError(String(failure))); }, []);
  useEffect(() => {
    setHead(null); setJobs([]); setHistory([]); setScript(''); setStudy(''); setBuildMode('current'); setInspectOnly(false); setAssessment(null); setThreshold(''); setStatement('');
    setMemoryOpen(false); setMemorySeed(null);
    setReferenceRequest(0);
    setObjectName(''); setPurpose(''); setParameters('{}'); setTolerance(.05); setAngle(10);
    setScriptHead(null); setStudyHead(null); setRequirementHead(null);
    setStudyDirty(false);
    setScriptOpen(false); setObjectListOpen(false);
    setDraftOwner(selected);
    setError('');
    setReplaySource(null);
    setField('geometry'); setDeformation(0);
    setPickMode('face');
    setImpact(null);
    if (!selected) return;
    let cancelled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const dispatched = generation.current;
      try {
        const [revision, nextJobs, revisions, nextAssessment] = await Promise.all([
          coreRequest<CoreRevision>(`/projects/${selected}`, undefined, abort.signal),
          coreRequest<CoreJob[]>(`/projects/${selected}/jobs`, undefined, abort.signal),
          coreRequest<CoreRevision[]>(`/projects/${selected}/revisions`, undefined, abort.signal),
          coreRequest<CoreAssessment>(`/projects/${selected}/assessments`, undefined, abort.signal),
        ]);
        if (cancelled) return;
        if (dispatched === generation.current) {
          setHead(revision); setJobs(nextJobs); setHistory(revisions); setConnected(true);
          setAssessment(nextAssessment.revision_id === revision.revision_id ? nextAssessment : null);
        }
      } catch (failure) { if (!cancelled && dispatched === generation.current) { setConnected(false); setError(String(failure)); } }
      if (!cancelled) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { cancelled = true; abort.abort(); clearTimeout(timer); };
  }, [selected]);
  useEffect(() => {
    if (head && !studyDirty) {
      setStudy(head.document.study ? JSON.stringify(head.document.study, null, 2) : '');
      setStudyHead(head.revision_id);
    }
  }, [head?.revision_id, studyDirty]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    generation.current += 1;
    setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { generation.current += 1; setBusy(false); }
  };
  const base = `/projects/${selected}`;
  const validAssessment = assessment?.revision_id === head?.revision_id ? assessment : null;
  const result = jobs.find(job => job.id === validAssessment?.evidence_job_id) ?? jobs.find(job => job.kind === 'fea' && job.state === 'succeeded');
  const latestAnalysis = jobs.find(job => job.kind === 'fea' && job.revision === head?.revision_id);
  const currentEvidence = result && validAssessment?.evidence_job_id === result.id;
  const displayResult = currentEvidence && result.result && field !== 'geometry' ? { artifact: result.result.artifact_id, field, scale: deformation } : null;
  const geometry = head?.document.geometry ?? null;
  const currentGeometry = useRef(geometry); currentGeometry.current = geometry;
  const buildEditorKey = JSON.stringify([selected, head?.revision_id, scriptHead, script, parameters, tolerance, angle, buildMode, geometry, replaySource]);
  const currentImpact = impact?.editorKey === buildEditorKey ? impact : null;
  const buildInput = () => ({ ...coreCommand(scriptHead ?? head!.revision_id), script,
    parameters: JSON.parse(parameters), tolerance_mm: tolerance, angle_deg: angle,
    use_current: buildMode === 'current', ...(buildMode === 'replay' ? { replay_of: replaySource } : {}) });
  const draft: EditorDraft = {
    ...(scriptHead ? { script: { base: scriptHead, code: script, parameters, tolerance, angle, mode: buildMode, inspectOnly, source: replaySource } } : {}),
    ...(studyDirty && studyHead ? { study: { base: studyHead, text: study } } : {}),
    ...(requirementHead ? { requirement: { base: requirementHead, statement, threshold, metric } } : {}),
  };
  const drafts = useEditorDrafts(draftOwner === selected && head?.project_id === selected ? selected : null, draft);
  const restoreDraft = (content: EditorDraft) => {
    if (!head) return;
    drafts.fork();
    setScript(content.script?.code ?? ''); setScriptHead(content.script?.base ?? null);
    setParameters(content.script?.parameters ?? '{}'); setTolerance(content.script?.tolerance ?? .05); setAngle(content.script?.angle ?? 10);
    const missingReplay = content.script?.mode === 'replay' && !content.script.source;
    setBuildMode(missingReplay ? 'inspect' : content.script?.mode ?? 'current'); setInspectOnly(missingReplay || (content.script?.inspectOnly ?? false));
    setReplaySource(content.script?.source ?? null);
    setStudy(content.study?.text ?? (head.document.study ? JSON.stringify(head.document.study, null, 2) : ''));
    setStudyHead(content.study?.base ?? head.revision_id); setStudyDirty(!!content.study);
    setStatement(content.requirement?.statement ?? ''); setThreshold(content.requirement?.threshold ?? '');
    setMetric(content.requirement?.metric ?? 'maxDisplacement'); setRequirementHead(content.requirement?.base ?? null);
    if (content.script) { setScriptOpen(true); if (precisionPanel.current) precisionPanel.current.open = true; }
    if (content.study || content.requirement) {
      setWorkspacePage('simulation'); setObjectListOpen(false);
      requestAnimationFrame(() => { if (content.requirement && requirementPanel.current) requirementPanel.current.open = true; });
    }
  };
  useEffect(() => {
    setTopology(null); setSelection([]);
    setPickFeedback('点击模型选择对象；拖动旋转，滚轮缩放。');
    queryEpoch.current += 1; setInspection(null); setQueryBusy(false);
    if (!geometry) return;
    const abort = new AbortController();
    void coreRequest<TopologyManifest>(`/artifacts/${geometry}/manifest`, undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) setTopology(value);
    }).catch(failure => { if (!abort.signal.aborted) setError(String(failure)); });
    return () => abort.abort();
  }, [geometry]);
  const clearSelection = (message = '选择已清除。') => {
    queryEpoch.current++; setSelection([]); setInspection(null); setQueryBusy(false);
    setPickFeedback(message); setPickReset(value => value + 1);
  };
  const inspectSelection = async (ids: string[], pick?: CorePick) => {
    if (!head || !topology || topology.artifactId !== geometry || queryBusy) return;
    const epoch = ++queryEpoch.current, artifact = topology.artifactId;
    setQueryBusy(true); setError('');
    if (pick) { setSelection([]); setInspection(null); }
    setPickFeedback('已命中显示模型，正在识别真实几何对象…');
    try {
      const response = await coreRequest<CoreInspection>(`${base}/inspect`, { revision_id: head.revision_id, artifact_id: artifact, selection: ids, ...(pick ? { pick } : {}) });
      if (queryEpoch.current !== epoch || current.current !== selected || currentGeometry.current !== artifact) return;
      setInspection(response);
      if (!pick || response.candidate_count === 1) {
        setSelection(response.selection);
        setPickFeedback(response.selection.length ? `已选中 ${response.selection.length} 个对象` : '未选择对象');
      } else { setSelection([]); setPickFeedback(response.candidate_count ? '此处有多个候选，请选择具体对象。' : '命中显示网格，但未识别到该类型的几何对象。试试选择面或对象列表。'); }
    } catch (failure) {
      if (queryEpoch.current === epoch && current.current === selected) { setError(String(failure)); setPickFeedback('对象识别失败，请重试。'); }
    } finally { if (queryEpoch.current === epoch) setQueryBusy(false); }
  };
  const number = (key: string) => {
    const value = result?.result?.summary?.[key];
    return typeof value === 'number' ? value.toPrecision(6) : '未计算';
  };

  const theme = preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme;
  const activeJobs = jobs.filter(activeJob);
  return <main data-theme={theme} className={`core-workspace desktop-workspace${preferences.sidebar_collapsed ? ' nav-collapsed' : ''}${chatOpen ? '' : ' chat-hidden'}${head ? '' : ' empty-workspace'}`} style={{ '--chat-width': `${preferences.chat_width}px` } as CSSProperties}>
    <nav className="workspace-sidebar" aria-label="工程导航">
      <div className="sidebar-brand"><Box size={24} strokeWidth={1.5} /><strong>VISION</strong><button className="icon-button" aria-label={preferences.sidebar_collapsed ? '展开工程导航' : '收起工程导航'} disabled={!preferencesReady} onClick={() => void savePreferences({ ...preferences, sidebar_collapsed: !preferences.sidebar_collapsed }).catch(failure => setError(String(failure)))}>{preferences.sidebar_collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></div>
      <div className="sidebar-actions"><button onClick={() => openProjects('create')} title="新建工程"><Plus size={17} /><span>新建工程</span></button><button onClick={() => openProjects('search')} title="搜索工程"><Search size={17} /><span>搜索工程</span><kbd>Ctrl K</kbd></button></div>
      <div className="sidebar-section-label"><span>工程</span></div>
      <div className="sidebar-projects">{projects.map(project => <button key={project.project_id} title={project.document.name} aria-current={selected === project.project_id ? 'page' : undefined} onClick={() => setSelected(project.project_id)}><Box size={16} /><span>{project.document.name}</span>{project.project_id === selected && <span className="project-indicator" />}</button>)}{!projects.length && <p>还没有工程</p>}</div>
      <div className="sidebar-footer"><button disabled={!head} onClick={() => openMemory()} title="当前工程上下文" aria-label="当前工程上下文"><BrainCircuit size={17} /><span>工程上下文</span></button><button onClick={() => openProjects('search')} title="工程管理"><Layers3 size={17} /><span>工程管理</span></button><button onClick={() => setSettingsPage('appearance')} title="设置"><Settings2 size={17} /><span>设置</span></button><div className="sidebar-connection" role="status"><span className={`status-dot ${connected ? 'online' : ''}`} /><span>{connected ? '本地工作区' : '服务未连接'}</span></div></div>
    </nav>
    <header className="workspace-titlebar"><div className="workspace-breadcrumb"><FolderOpen size={15} /><span>{head?.document.name ?? '工程工作区'}</span><ChevronRight size={13} /><nav className="workspace-modes" aria-label="工作区页面">{([
        ['model', '建模', Box], ['simulation', 'CAE 仿真', FlaskConical], ['verification', '解析校核', Calculator]
      ] as const).map(([id, label, Icon]) => <button key={id} aria-label={label} title={label} aria-current={workspacePage === id ? 'page' : undefined} onClick={() => { setWorkspacePage(id); setObjectListOpen(false); }}><Icon size={14} /><span>{label}</span></button>)}</nav></div>
      <div className="workspace-title-actions">{head && <span className="revision-badge" title={head.revision_id}>已保存 · {head.revision_id.slice(0, 7)}</span>}<button className="icon-button" aria-label="模型配置" title="模型配置" onClick={() => setSettingsPage('model')}><SlidersHorizontal size={17} /></button><details className="workspace-advanced"><summary aria-label="高级操作" title="高级操作"><Settings2 size={17} /></summary><div><button disabled={!head} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setScriptOpen(true); }}>脚本编辑</button></div></details><button className="icon-button" aria-label={chatOpen ? '收起对话侧栏' : '打开对话侧栏'} title={chatOpen ? '收起对话侧栏' : '打开对话侧栏'} aria-expanded={chatOpen} onClick={() => setChatOpen(value => !value)}><MessageSquare size={17} /></button></div>
    </header>
    {projectManagerOpen && <ProjectManager initialAction={managerAction} selected={selected} onOpen={id => { setSelected(id); setObjectListOpen(false); }} onChanged={refreshProjects}
      onClose={() => setProjectManagerOpen(false)} onDeleted={id => {
        if (current.current === id) { generation.current++; setSelected(''); setHead(null); }
        try {
          localStorage.removeItem(`vision-chat-draft:${id}`);
          for (const key of Object.keys(localStorage)) if (key.startsWith(draftPrefix(id))) localStorage.removeItem(key);
          if (localStorage.getItem('vision.core.active-project') === id) localStorage.removeItem('vision.core.active-project');
        } catch { /* Local cleanup does not determine server deletion. */ }
      }} />}
    {settingsPage && <WorkspaceSettings initialPage={settingsPage} preferences={preferences} save={savePreferences} project={head?.project_id ?? null} revision={head?.revision_id ?? null} onClose={() => { setSettingsPage(null); setSettingsVersion(value => value + 1); }} />}
    {memoryOpen && head && head.project_id === selected && <MemoryPanel key={selected} project={selected} revision={head.revision_id} task={null} initialSource={memorySeed} onClose={() => { setMemoryOpen(false); setMemorySeed(null); }} />}
    {error && <div role="alert" className="core-error">{error}<button onClick={() => void run(refreshProjects)} disabled={busy}>重新连接</button></div>}
    <div className="core-layout">
      {head && <ScriptDialog open={scriptOpen} onClose={() => setScriptOpen(false)}>
        <p>高级编辑：直接修改几何脚本、参数和精度。构建前请核对修改影响。</p>
          {drafts.warning && <p role="alert" className="core-error">{drafts.warning}</p>}
          {drafts.saved && <p role="status">编辑副本已保存到本机；尚未提交的内容不会自动执行。</p>}
          {drafts.saved && <button disabled={busy} onClick={() => restoreDraft({})}>清空编辑器并保留副本</button>}
          {drafts.records.length > 0 && <details><summary>本机草稿（{drafts.records.length}）</summary>
            <p>恢复只填写编辑器，基础版本保持原值；工程和作业不会改变。其他标签页的副本分别保留。</p>
            {drafts.records.map(record => <article className="core-history" key={record.writer}>
              <span>{new Date(record.savedAt).toLocaleString()} · {[record.content.script && '脚本', record.content.study && '工况', record.content.requirement && '要求'].filter(Boolean).join('、')}</span>
              <button disabled={busy} onClick={() => restoreDraft(record.content)}>恢复草稿副本</button>
              <button disabled={busy} onClick={() => drafts.remove(record)}>删除此草稿副本</button>
            </article>)}
          </details>}
          <section className="manual-modeling" aria-label="脚本建模">
            {geometry && <button disabled={busy} onClick={() => void run(async () => {
              const response = await fetch(coreArtifactUrl(geometry, 'source.py'));
              if (!response.ok) throw new Error('保存的脚本暂不可读取');
              const source = await response.text();
              const manifest = await coreRequest<TopologyManifest>(`/artifacts/${geometry}/manifest`);
              if (current.current === selected && currentGeometry.current === geometry) {
                setScript(source); setInspectOnly(manifest.replay_available === false); setBuildMode(manifest.replay_available === false ? 'inspect' : 'replay');
                setParameters(JSON.stringify(manifest.parameters, null, 2)); setTolerance(manifest.settings.tolerance_mm); setAngle(manifest.settings.angle_deg);
                setScriptHead(head.revision_id);
                setReplaySource(geometry);
              }
            })}>载入已保存脚本</button>}
            <label>构建来源<select aria-label="构建来源" value={buildMode} onChange={event => { setBuildMode(event.target.value); setScriptHead(head.revision_id); setReplaySource(geometry); }}>
              {inspectOnly && <option value="inspect">请核对输入并明确选择构建来源</option>}
              <option value="current">在当前模型上增量编辑</option><option value="fresh">从空白开始构建</option>
              {geometry && !inspectOnly && <option value="replay">使用原始构建输入重放</option>}
            </select></label>
            <label>USD BRep Python<textarea aria-label="建模脚本" rows={8} value={script} onChange={event => { setScript(event.target.value); setScriptHead(previous => previous ?? head.revision_id); }} spellCheck={false} placeholder="使用 u 构建几何，并赋值给 result" /></label>
            <DraftVersion base={scriptHead} current={head.revision_id} rebase={() => setScriptHead(head.revision_id)} />
            <details ref={precisionPanel}><summary>参数与离散精度</summary>
              <label>脚本参数 JSON<textarea aria-label="脚本参数 JSON" rows={4} value={parameters} onChange={event => { setParameters(event.target.value); setScriptHead(previous => previous ?? head.revision_id); }} /></label>
              <label>离散容差 / mm<input type="number" min="0.00001" max="10" step="any" value={tolerance} onChange={event => { setTolerance(Number(event.target.value)); setScriptHead(previous => previous ?? head.revision_id); }} /></label>
              <label>离散角度 / °<input type="number" min="0.1" max="45" step="any" value={angle} onChange={event => { setAngle(Number(event.target.value)); setScriptHead(previous => previous ?? head.revision_id); }} /></label>
            </details>
            <button disabled={busy || !script.trim() || buildMode === 'inspect' || (buildMode === 'replay' && !replaySource)} onClick={() => void run(async () => {
              const preview = await coreRequest<CoreBuildImpact>(`${base}/build/preview`, buildInput());
              if (current.current === selected) setImpact({ ...preview, editorKey: buildEditorKey });
            })}>检查修改影响</button>
            {currentImpact && <section aria-label="几何修改影响" className="core-history">
              <strong>已知修改影响</strong>
              <p>{currentImpact.source_artifact ? `构建源：${currentImpact.source_artifact.slice(0, 12)}` : '从空白几何输入开始构建。'}</p>
              {currentImpact.objects.map(item => <p key={item.id}>{item.name}：{item.action === 'rebind' ? '构建后需重新绑定' : '当前已失效，构建不会自动修复'}</p>)}
              {currentImpact.study_regions.map(item => <p key={item.id}>{item.name}：{item.action === 'rebind' ? '作用区域需重新绑定' : '作用区域需复核是否仍覆盖新几何'}</p>)}
              {currentImpact.selected_bodies_to_review.length > 0 && <p>分析体需复核：{currentImpact.selected_bodies_to_review.join('、')}</p>}
              {currentImpact.evidence_action === 'recompute' && <p>现有数值证据不能用于修改后的几何，需要重新计算。</p>}
              <p>{currentImpact.notice}</p>
            </section>}
            {geometry && !currentImpact && <p>修改现有几何前，请先检查此份脚本和参数的影响。</p>}
            <button disabled={busy || !script.trim() || buildMode === 'inspect' || (!!geometry && !currentImpact)} onClick={() => void run(async () => {
              await coreRequest(`${base}/build`, { ...buildInput(), ...(currentImpact ? { expected_impact_digest: currentImpact.digest } : {}) });
            })}>构建几何</button>
          </section>

      </ScriptDialog>}
      <section className="core-main">
        {!head && workspacePage !== 'verification' && <div className="workspace-welcome"><Box size={48} strokeWidth={1} /><h1>把想法，变成可操作的模型。</h1><p>创建或打开一个工程，在右侧与智能体持续协作。</p><button className="core-primary" onClick={() => setProjectManagerOpen(true)}><Plus size={16} />新建或打开工程</button></div>}
        <div hidden={workspacePage !== 'verification'} className="verification-host">{workspacePage === 'verification' && <VerificationPanel />}</div>
        <div className={`engineering-stage${workspacePage === 'simulation' ? ' simulation-stage' : ''}`} hidden={workspacePage === 'verification'}>
        {workspacePage === 'simulation' && head && <>          <section className="simulation-config" aria-label="分析工况"><header><FlaskConical size={17} /><h2>分析工况</h2></header>
            <p>工况保存后生效。请明确材料、约束、合力及网格尺寸；新工程不自动施加载荷。</p>
            <button onClick={() => { setStudy(JSON.stringify(head.document.study ?? { material: { E: 210000, nu: .3, rho: 7850, yieldStrength: 235 },
              supports: [{ id: 'fixed', face: 'x-min' }], loads: [{ id: 'force', face: 'x-max', vector: [1, 0, 0], magnitude: 100 }], mesh_size: 4 }, null, 2)); setStudyHead(head.revision_id); setStudyDirty(!head.document.study); }}>
              {head.document.study ? '载入已保存工况' : '创建示例草稿（请核对）'}</button>
            {geometry && topology && <details className="simulation-regions" open={regionSettingsOpen} onToggle={event => setRegionSettingsOpen(event.currentTarget.open)}><summary>分析体与约束区域{selection.length ? ` · 已选 ${selection.length} 项` : ''}</summary>
              <p>在视口选择实体以限定分析范围，或将已命名的面区域设为固定约束。操作会保存工况；如有未保存的编辑，请先保存或重新载入。</p>
            <button disabled={busy || studyDirty || queryBusy || !head.document.study || !selection.length || !selection.every(id => topology.bodies.some(body => body.id === id && body.kind === 'solid'))} onClick={() => void run(async () => {
              const revision = await coreRequest<CoreRevision>(`${base}/study`, { ...coreCommand(head.revision_id),
                study: { ...head.document.study!, body_ids: selection, body_artifact_id: geometry } });
              if (current.current === selected) { setHead(revision); setStudy(JSON.stringify(revision.document.study, null, 2)); setStudyHead(revision.revision_id); }
            })}>将所选实体用于分析</button>
            <button disabled={busy || studyDirty || !head.document.study?.body_ids} onClick={() => void run(async () => {
              const revision = await coreRequest<CoreRevision>(`${base}/study`, { ...coreCommand(head.revision_id),
                study: { ...head.document.study!, body_ids: null, body_artifact_id: null } });
              if (current.current === selected) { setHead(revision); setStudy(JSON.stringify(revision.document.study, null, 2)); setStudyHead(revision.revision_id); }
            })}>使用全部闭合实体</button>
            {head.document.study?.body_ids && <p>{head.document.study.body_artifact_id === geometry ? `分析体：${head.document.study.body_ids.join('、')}` : '分析体选择已失效，请重新选择当前实体。'}</p>}
              {(head.document.objects ?? []).map(object => {
                const bound = object.binding.artifact_id === geometry;
                const faces = object.binding.topology_ids.every(id => id.includes('/face-'));
                return <div key={object.id}><strong>{object.name}</strong>
                <button disabled={busy || studyDirty || !bound || !faces || !head.document.study} onClick={() => void run(async () => {
                  const nextStudy: CoreStudy = { ...head.document.study!, supports: [{ id: `fixed-${object.id}`, name: object.name, type: 'fixed', face: 'x-min', enabled: true,
                    region: { type: 'semantic-object', object_id: object.id, toleranceMm: Math.min(10, Math.max(.001, topology.settings.tolerance_mm * 2)) } }] };
                  const revision = await coreRequest<CoreRevision>(`${base}/study`, { ...coreCommand(head.revision_id), study: nextStudy });
                  if (current.current === selected) { setHead(revision); setStudy(JSON.stringify(revision.document.study, null, 2)); setStudyHead(revision.revision_id); }
                })}>设为唯一固定约束</button>
                </div>;
              })}
            </details>}
            <StudyForm text={study} document={head.document} change={text => { setStudy(text); setStudyDirty(true); setStudyHead(previous => previous ?? head.revision_id); }} />
            <details><summary>高级工况 JSON</summary><label>工况 JSON<textarea aria-label="工况 JSON" rows={12} value={study} onChange={event => { setStudy(event.target.value); setStudyDirty(true); setStudyHead(previous => previous ?? head.revision_id); }} spellCheck={false} /></label></details>
            <DraftVersion base={studyHead} current={head.revision_id} rebase={() => setStudyHead(head.revision_id)} />
            <button disabled={busy || !study.trim()} onClick={() => void run(async () => {
              const parsed = JSON.parse(study) as CoreStudy;
              const revision = await coreRequest<CoreRevision>(`${base}/study`, { ...coreCommand(studyHead ?? head.revision_id), study: parsed });
              if (current.current === selected) { setHead(revision); setStudyHead(revision.revision_id); setStudyDirty(false); }
            })}>保存工况</button>
          <button className="core-primary" disabled={busy || !geometry || !head.document.study || studyDirty || activeJobs.length > 0} onClick={() => void run(async () => {
            await coreRequest(`${base}/solve`, coreCommand(head.revision_id)); setBottomTab('jobs');
          })}>运行静力分析</button>
          {studyDirty && <p className="study-warning">请先保存并核对工况，再运行分析。</p>}
          <p>当前：各向同性线弹性、小变形、固定约束与总合力。弯曲问题请做网格细化检查。</p>
          <button onClick={() => setBottomTab('results')}>查看数值证据</button>
          <details ref={requirementPanel}><summary>验收指标与要求</summary>
            <label>要求说明<textarea aria-label="要求说明" rows={3} value={statement} onChange={event => { setStatement(event.target.value); setRequirementHead(previous => previous ?? head.revision_id); }} /></label>
            <label>校核指标<select value={metric} onChange={event => { setMetric(event.target.value as CoreRequirement['metric']); setRequirementHead(previous => previous ?? head.revision_id); }}>
              {Object.entries(metrics).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label>{metric === 'safetyFactor' ? '下限' : '上限'}（{metrics[metric][1]}）<input aria-label="要求阈值" type="number" min="0" step="any" value={threshold} onChange={event => { setThreshold(event.target.value); setRequirementHead(previous => previous ?? head.revision_id); }} /></label>
            <button disabled={busy || !statement.trim() || !(Number(threshold) > 0)} onClick={() => void run(async () => {
              const revision = await coreRequest<CoreRevision>(`${base}/requirements`, { ...coreCommand(requirementHead ?? head.revision_id), statement,
                requirement: { name: metrics[metric][0], metric, comparison: metric === 'safetyFactor' ? 'ge' : 'le', threshold: Number(threshold), unit: metrics[metric][1] } });
              if (current.current === selected) { setHead(revision); setStatement(''); setThreshold(''); setRequirementHead(null); }
            })}>保存要求</button>
            <DraftVersion base={requirementHead} current={head.revision_id} rebase={() => setRequirementHead(head.revision_id)} />
            {(head.document.requirements ?? []).map(requirement => <div className="core-history" key={requirement.id}>
              <span>{requirement.name} {requirement.comparison === 'le' ? '≤' : '≥'} {requirement.threshold} {requirement.unit}</span>
              <a href={`/api/v2${base}/sources/${requirement.source_event}`} target="_blank" rel="noreferrer">查看来源</a>
              <button disabled={busy} onClick={() => void run(async () => {
                const revision = await coreRequest<CoreRevision>(`${base}/requirements/remove`, { ...coreCommand(head.revision_id), requirement_id: requirement.id });
                if (current.current === selected) setHead(revision);
              })}>移出当前要求</button>
            </div>)}
          </details>

          </section></>}
        <div className={`model-stage${objectListOpen ? ' object-list-open' : ''}${!head ? ' no-project' : ''}`}>
        {objectListOpen && !displayResult && topology && <section className="viewport-object-list" aria-label="对象列表与多选">
          <div className="core-modal-heading"><strong>对象列表 · 多选</strong><button aria-label="关闭对象列表" onClick={() => setObjectListOpen(false)}><X size={14} /></button></div>
            <label>原生对象<select autoFocus aria-label="原生对象" multiple size={8} disabled={queryBusy} value={selection} onChange={event => void inspectSelection(Array.from(event.target.selectedOptions, item => item.value))}>
              {topology.bodies.map(body => <optgroup label={body.name} key={body.id}>
                <option value={body.id}>体 · {body.id}</option>
                {body.faces.map(face => <option key={face.id} value={face.id}>面 · {face.id} · {face.area_mm2.toFixed(2)} mm²</option>)}
                {body.edges.map(edge => <option key={edge.id} value={edge.id}>边 · {edge.id} · {edge.length_mm.toFixed(2)} mm</option>)}
              </optgroup>)}
            </select></label>
          <p>按 Ctrl / Cmd 多选；列表与视口使用同一份选择。</p>
          {(head?.document.objects ?? []).map(object => <button key={object.id} disabled={queryBusy || object.binding.artifact_id !== geometry} onClick={() => void inspectSelection(object.binding.topology_ids)}>{object.name}{object.binding.artifact_id !== geometry ? ' · 需重新绑定' : ''}</button>)}
        </section>}
        <CoreViewport theme={theme} artifact={geometry} result={displayResult} clearToken={pickReset} onClear={() => clearSelection()} picking={!displayResult && pickMode !== 'view' && !queryBusy && !busy} visual={!displayResult && inspection?.artifact_id === geometry ? inspection.visual : null}
          toolbar={<>
            {currentEvidence ? <select aria-label="结果显示" title="模型与结果显示" value={displayResult ? field : 'geometry'} onChange={event => { setField(event.target.value as typeof field); setObjectListOpen(false); setPickMode(event.target.value === 'geometry' ? 'face' : 'view'); clearSelection(); }}>
              <option value="geometry">三维模型</option><option value="displacement">位移云图</option><option value="vonMises">应力云图</option>
            </select> : <span className="viewport-mode-label">模型</span>}
            {displayResult ? <label className="viewport-deformation" title="仅改变显示的变形倍率">变形 ×<input aria-label="变形倍率" type="number" min="0" max="1000000" step="any" value={deformation} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) setDeformation(Math.max(0, Math.min(1000000, value))); }} /></label> : <>
              <select aria-label="视口操作" title="选择面、边、实体或仅浏览" value={pickMode} onChange={event => { setPickMode(event.target.value as typeof pickMode); clearSelection(event.target.value === 'view' ? '仅查看模式，不选择对象。' : '点击模型选择对象。'); }}>
                <option value="face">选择面</option><option value="edge">选择边</option><option value="body">选择实体</option><option value="view">仅查看</option>
              </select>
              <button className="viewport-icon" aria-label="对象列表与多选" title="对象列表与多选" disabled={!topology} aria-expanded={objectListOpen} onClick={() => setObjectListOpen(value => !value)}><ListTree size={15} /></button>
              {(selection.length > 0 || inspection) && <button className="viewport-icon" aria-label="清除选择" title="清除选择（Esc）" disabled={queryBusy} onClick={() => clearSelection()}><X size={14} /></button>}
            </>}
          </>}
          selectionOverlay={selection.length || inspection || queryBusy ? <><strong>{queryBusy ? '正在识别几何对象…' : pickFeedback}</strong>
            {!displayResult && selection.slice(0, 3).map(id => <p key={id} title={id}><b>{objectLabel(id)}</b></p>)}
            {selection.length > 3 && <small>另有 {selection.length - 3} 项，可在对象列表查看。</small>}
            {!displayResult && inspection?.metrics.slice(0, 3).map(item => <p key={item.id}>{selection.length > 1 && `${objectLabel(item.id)} · `}{item.area_mm2 !== undefined ? `面积 ${item.area_mm2.toPrecision(6)} mm²` : item.length_mm !== undefined ? `长度 ${item.length_mm.toPrecision(6)} mm` : '实体已识别'}</p>)}
            {!displayResult && inspection?.is_pick && inspection.candidate_count > 1 && inspection.candidates.map(item => <button key={item.id} disabled={queryBusy} onClick={() => void inspectSelection([item.id])}>{objectLabel(item.id)} · 距离 {item.distance_mm.toPrecision(3)} mm</button>)}
            {!displayResult && inspection?.is_pick && inspection.candidate_count > 16 && <small>仅显示前 16 个候选，请使用对象列表查看其余对象。</small>}
            {!displayResult && selection.length > 0 && <button onClick={() => { setChatOpen(true); setReferenceRequest(value => value + 1); }}>引用到右侧对话</button>}
            {!displayResult && head && geometry && topology && selection.length > 0 && <details className="selection-actions"><summary>命名与区域绑定</summary>
            <label>对象名称<input value={objectName} onChange={event => setObjectName(event.target.value)} /></label>
            <label>用途说明<textarea aria-label="用途说明" rows={3} value={purpose} onChange={event => setPurpose(event.target.value)} /></label>
            <button disabled={busy || queryBusy || !selection.length || !objectName.trim() || !purpose.trim()} onClick={() => void run(async () => {
              const revision = await coreRequest<CoreRevision>(`${base}/objects`, { ...coreCommand(head.revision_id), artifact_id: topology.artifactId, name: objectName, purpose, topology_ids: selection });
              if (current.current === selected) { setHead(revision); setObjectName(''); setPurpose(''); }
            })}>保存工程对象</button>
            {(head.document.objects ?? []).map(object => {
              const bound = object.binding.artifact_id === geometry;
              return <div className="core-history" key={object.id}>
                <strong>{object.name} · {bound ? '已绑定当前几何' : '需要重新绑定'}</strong><p>{object.purpose}</p>
                <button disabled={busy || queryBusy || !bound} onClick={() => void inspectSelection(object.binding.topology_ids)}>查看绑定轮廓</button>
                <button disabled={busy || queryBusy || !selection.length} onClick={() => void run(async () => {
                  const revision = await coreRequest<CoreRevision>(`${base}/objects/rebind`, { ...coreCommand(head.revision_id), artifact_id: topology.artifactId, object_id: object.id, topology_ids: selection });
                  if (current.current === selected) setHead(revision);
                })}>绑定到当前所选对象</button>

              </div>;
            })}
            </details>}
            {!displayResult && selection.length > 0 && <button onClick={() => { setWorkspacePage('simulation'); setRegionSettingsOpen(true); }}>设置分析体与约束</button>}
          </> : null}
          onMiss={() => clearSelection('未命中模型，选择已清除。')}
          onPick={(point, pixelMm) => { if (pickMode === 'view') return; if (!topology) { setPickFeedback('对象信息尚未准备好，请稍后再试。'); return; } void inspectSelection([], { kind: pickMode, point,
            tolerance_mm: Math.min(10, Math.max(topology.settings.tolerance_mm * 2, pickMode === 'edge' ? pixelMm * 6 : .00001)) }); }} />
        </div>
        </div>
        <div className="workspace-bottom-tabs" hidden={!head || workspacePage === 'verification'} role="tablist" aria-label="工程面板" onKeyDown={event => {
          if ((event.target as HTMLElement).getAttribute('role') !== 'tab') return;
          const tabs = ['results', 'jobs', 'versions'] as const;
          const index = tabs.indexOf(bottomTab ?? 'results');
          const next = event.key === 'ArrowRight' ? tabs[(index + 1) % 3] : event.key === 'ArrowLeft' ? tabs[(index + 2) % 3] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : null;
          if (next) { event.preventDefault(); setBottomTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#${next}-tab`)?.focus(); }
        }}>
          <button role="tab" id="results-tab" aria-selected={bottomTab === 'results'} aria-controls="workspace-panel" onClick={() => setBottomTab(bottomTab === 'results' ? null : 'results')}><Layers3 size={14} />数值证据{validAssessment?.findings.length ? <span>{validAssessment.findings.length}</span> : null}</button>
          <button role="tab" id="jobs-tab" aria-selected={bottomTab === 'jobs'} aria-controls="workspace-panel" onClick={() => setBottomTab(bottomTab === 'jobs' ? null : 'jobs')}><Workflow size={14} />作业{activeJobs.length > 0 && <span>{activeJobs.length}</span>}</button>
          <button role="tab" id="versions-tab" aria-selected={bottomTab === 'versions'} aria-controls="workspace-panel" onClick={() => setBottomTab(bottomTab === 'versions' ? null : 'versions')}><History size={14} />版本</button>
          <span className="workspace-model-status" role="status" title={displayResult ? '有限元边界场 · 应力为节点平均恢复值，变形放大不代表局部收敛 · mm / N / MPa' : '原生几何 · mm / N / MPa'}>
            {topology?.bodies.length ?? 0} 实体{queryBusy ? ' · 识别中…' : selection.length ? ` · 已选 ${selection.length}` : pickFeedback.startsWith('未命中模型') ? ' · 未命中' : ''}
          </span>
          {bottomTab && <button className="icon-button" aria-label="关闭工程面板" onClick={() => setBottomTab(null)}><X size={14} /></button>}
        </div>
        <div id="workspace-panel" className="workspace-bottom-panel" role="tabpanel" aria-labelledby={bottomTab ? `${bottomTab}-tab` : undefined} hidden={!bottomTab || !head || workspacePage === 'verification'}>
        <div hidden={bottomTab !== 'results'}>
        {!result && <div className="panel-empty"><Layers3 size={24} /><h3>尚无求解结果</h3><p>在对话中明确材料、约束与载荷，再运行静力分析。</p></div>}
        {validAssessment && validAssessment.findings.length > 0 && <section className="core-results" aria-label="工程要求校核">
          <h2>已定义指标校核</h2>
          {validAssessment.findings.map(finding => <p key={finding.requirement.id} data-assessment={finding.status}>
            <strong>{finding.requirement.name}：{finding.status === 'pass' ? '满足' : finding.status === 'fail' ? '不满足' : '未判定'}</strong>
            {finding.value !== null && <> · {finding.value.toPrecision(6)} {finding.requirement.unit}</>}<br />{finding.reason}
          </p>)}
          <p>{validAssessment.notice}</p>
        </section>}
        {result && <section className="core-results" aria-label="数值证据">
          <h2>{currentEvidence ? '当前版本数值证据' : '历史版本数值证据'}</h2>
          {result.result?.origin === 'imported' && <p>导入证据：文件完整性已校验，计算尚未在当前环境复跑。</p>}
          {latestAnalysis && activeJob(latestAnalysis) && <p>本轮计算中，当前显示此前的结果。</p>}
          {latestAnalysis && ['failed', 'timed_out', 'interrupted', 'cancelled'].includes(latestAnalysis.state) && <p>最近一次计算未完成，以下结果不代表本轮成功。</p>}
          <p>输入版本 {result.revision.slice(0, 12)} · 当前仅支持各向同性线弹性静力分析。</p>
          <dl><div><dt>最大位移 / mm</dt><dd>{number('maxDisplacement')}</dd></div>
            <div><dt>von Mises / MPa</dt><dd>{number('maxVonMises')}</dd></div>
            <div><dt>相对残差</dt><dd>{number('relativeResidual')}</dd></div>
            <div><dt>反力平衡误差</dt><dd>{number('equilibriumError')}</dd></div></dl>
          <p>{head?.document.requirements?.length ? '数值证据与已定义指标的校核分别显示。' : '计算完成不等同于设计要求已满足。请按工程需要定义校核指标。'}</p>
          {result.result && <a href={coreArtifactUrl(result.result.artifact_id, 'field.npz')}>下载完整结果场</a>}
        </section>}
        </div>
        <div hidden={bottomTab !== 'versions'}>{head && <><div className="version-list">{history.map(revision => <div key={revision.revision_id}><History size={14} /><span>{revision.revision_id.slice(0, 8)}<small>{new Date(revision.created_at * 1000).toLocaleString()}</small></span>{revision.revision_id === head.revision_id ? <small>当前版本</small> : <button disabled={busy} onClick={() => void run(async () => { const next = await coreRequest<CoreRevision>(`${base}/restore`, { ...coreCommand(head.revision_id), revision_id: revision.revision_id }); if (current.current === selected) setHead(next); })}>恢复为新版本</button>}</div>)}</div><ComparisonPanel key={`compare-${selected}`} project={selected} revisions={history} /></>}</div>
      <section className="core-jobs" hidden={bottomTab !== 'jobs'}><h2>后台作业</h2><p>关闭页面后，已提交作业继续在本机执行。</p>
        {jobs.length === 0 && <p>暂无作业。</p>}
        {jobs.map(job => <article key={job.id} data-state={job.state}>
          <strong>{job.kind === 'cad' ? '原生几何构建' : '有限元静力求解'} · {labels[job.state]}</strong>
          <p>输入 {job.revision.slice(0, 12)}</p>
          {activeJob(job) && job.phase && <p>计算阶段：{job.phase}</p>}
          {job.kind === 'cad' && job.state === 'succeeded' && <p>{job.adopted_revision ? '几何已保存为新版本' : '工程已变更，保留为候选结果'}</p>}
          {head && job.kind === 'cad' && job.state === 'succeeded' && job.result?.artifact_id !== geometry && <button disabled={busy} onClick={() => void run(async () => {
            const revision = await coreRequest<CoreRevision>(`${base}/adopt`, { ...coreCommand(head.revision_id), job_id: job.id });
            if (current.current === selected) setHead(revision);
          })}>采纳此几何</button>}
          {job.error && <p className="core-error">{job.error}</p>}
          <details><summary>作业详情</summary>
            <button disabled={busy} onClick={() => void run(async () => {
              const input = await coreRequest<{ command: { script?: string; use_current?: boolean; replay_of?: string | null;
                parameters?: Record<string, number | string | boolean>; tolerance_mm?: number; angle_deg?: number }; document: { study: CoreStudy | null } }>(`/jobs/${job.id}/input`);
              if (current.current !== selected) return;
              if (job.kind === 'cad') {
                setScript(input.command.script ?? '');
                setParameters(JSON.stringify(input.command.parameters ?? {}, null, 2));
                setReplaySource(input.command.replay_of ?? null);
                setTolerance(input.command.tolerance_mm ?? .05); setAngle(input.command.angle_deg ?? 10);
                setScriptHead(job.revision);
                const sameRevision = job.revision === head?.revision_id;
                setInspectOnly(!sameRevision);
                setBuildMode(!sameRevision ? 'inspect' : input.command.replay_of ? 'replay' : input.command.use_current ? 'current' : 'fresh');
              } else { setStudy(input.document.study ? JSON.stringify(input.document.study, null, 2) : ''); setStudyHead(job.revision); setStudyDirty(true); }
            })}>载入作业输入为草稿</button>
            <p><a href={`/api/v2/jobs/${job.id}/logs/stdout`} target="_blank" rel="noreferrer">运行日志</a> · <a href={`/api/v2/jobs/${job.id}/logs/stderr`} target="_blank" rel="noreferrer">错误日志</a></p>
          </details>
          {activeJob(job) && <button disabled={busy || job.state === 'cancelling'} onClick={() => void run(async () => {
            await coreRequest(`/jobs/${job.id}/cancel`, {});
          })}>取消作业</button>}
        </article>)}
      </section>
      </div>
      </section>
      {head && <ConversationPanel key={selected} project={selected} revision={head.revision_id} artifact={geometry} selection={selection} referenceRequest={referenceRequest} onMemory={openMemory} onModel={() => setSettingsPage('model')} settingsVersion={settingsVersion} />}
    </div>
  </main>;
}
