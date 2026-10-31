import { useEffect, useRef, useState } from 'react';
import { coreCommand, coreRequest, type CoreStudy } from './api';
import { objectLabel, modelCompletionLabel, modelCheckValue, type ModelCompletion } from './viewHelpers';
import { ArrowUp, BrainCircuit, ChevronDown, LoaderCircle, Square, Sparkles } from 'lucide-react';
import type { MemorySeed } from './MemoryPanel';

interface Message { id: string; role: string; text: string; revision_id?: string; completion?: ModelCompletion | null; reference?: { artifact_id: string; selection: string[] } | null }
interface Task { id: string; epoch: number; state: string; error: string | null; turns: number; jobs: number; config: { used_tokens?: number }; steps: Array<{ epoch: number; response: { tool: string } | null; receipt?: { revision_id?: string } | null; state: string }> }
interface Conversation { messages: Message[]; task: Task | null }
interface Health { model: { configured: boolean; model: string }; features?: string[] }
const states: Record<string, string> = { created: '准备执行', executing: '正在处理', waiting_job: '原生工程计算中', waiting_user: '等待你的回复或处理', completed: '已回复', cancelled: '已停止' };

export function ConversationPanel({ project, revision, artifact, selection, referenceRequest, onMemory, onModel, settingsVersion, analysisMode, analysisDraft, onStudyConfigured }: { project: string; revision: string; artifact: string | null; selection: string[]; referenceRequest: number; onMemory: (source?: MemorySeed) => void; onModel: () => void; settingsVersion: number; analysisMode?: boolean; analysisDraft?: CoreStudy | null; onStudyConfigured?: (revision: string) => void }) {
  const [data, setData] = useState<Conversation>({ messages: [], task: null });
  const [text, setText] = useState(() => localStorage.getItem(`vision-chat-draft:${project}`) ?? '');
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState<{ artifact: string; revision: string; selection: string[] } | null>(null);
  const [provider, setProvider] = useState<{ configured: boolean; model: string } | null>(null);
  const [analysisSupported, setAnalysisSupported] = useState(false);
  const generation = useRef(0);
  const submittedStudy = useRef<{ task: string; epoch: number; candidate: string } | null>(null);
  const healthCheckedAt = useRef(0);
  const lastReferenceRequest = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const active = !!data.task && ['created', 'executing', 'waiting_job'].includes(data.task.state);
  const step = data.task?.steps.filter(item => item.epoch === data.task!.epoch).at(-1);
  const stale = !!reference && (reference.artifact !== artifact || reference.revision !== revision);
  useEffect(() => {
    if (referenceRequest > 0 && referenceRequest !== lastReferenceRequest.current && artifact && selection.length) {
      lastReferenceRequest.current = referenceRequest;
      setReference({ artifact, revision, selection: [...selection] });
    }
  }, [referenceRequest, artifact, revision, selection]);
  useEffect(() => { localStorage.setItem(`vision-chat-draft:${project}`, text); }, [project, text]);
  useEffect(() => {
    const abort = new AbortController(); let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = generation.current;
      try {
        const result = await coreRequest<Conversation>(`/projects/${project}/conversation`, undefined, abort.signal);
        if (!disposed && current === generation.current) { setData(result); setReady(true); setPollError(''); }
        if (!disposed && Date.now() - healthCheckedAt.current > 10000) {
          const health = await coreRequest<Health>('/health', undefined, abort.signal);
          if (!disposed) { setProvider(health.model); setAnalysisSupported(health.features?.includes('conversation-analysis-draft/1') === true); healthCheckedAt.current = Date.now(); }
        }
      } catch (failure) { if (!disposed) setPollError(String(failure)); }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    };
    void poll(); return () => { disposed = true; abort.abort(); clearTimeout(timer); };
  }, [project]);
  useEffect(() => {
    const abort = new AbortController();
    void coreRequest<Health>('/health', undefined, abort.signal).then(value => { setProvider(value.model); setAnalysisSupported(value.features?.includes('conversation-analysis-draft/1') === true); healthCheckedAt.current = Date.now(); }).catch(() => {});
    return () => abort.abort();
  }, [settingsVersion]);
  useEffect(() => { if (follow) bottom.current?.scrollIntoView({ block: 'nearest' }); }, [data.messages.length, follow]);
  useEffect(() => {
    const handed = submittedStudy.current;
    if (!handed || data.task?.id !== handed.task || data.task.epoch !== handed.epoch || JSON.stringify(analysisDraft) !== handed.candidate) return;
    const configured = data.task.steps.some(item => item.epoch === handed.epoch && item.state === 'succeeded' && item.response?.tool === 'configure_study' && item.receipt?.revision_id === revision);
    if (configured) { submittedStudy.current = null; onStudyConfigured?.(revision); }
  }, [data.task, revision, analysisDraft, onStudyConfigured]);
  const send = async () => {
    if (busy || !ready || !text.trim() || stale || !provider?.configured) return;
    const draft = text;
    generation.current++; setBusy(true); setError('');
    try {
      if (analysisMode && analysisDraft && !analysisSupported) throw new Error('后端仍在运行旧版接口，暂不支持分析工况上下文。请重启本地后端后重试；消息和草稿已保留。');
      const receipt = await coreRequest<{ task_id: string; epoch: number }>(`/projects/${project}/conversation`, { ...coreCommand(revision), text: draft,
        expected_task: data.task?.id ?? null, expected_epoch: data.task?.epoch ?? null,
        artifact_id: reference?.artifact ?? (analysisMode ? artifact : null), selection: reference?.selection ?? (analysisMode ? selection : []),
        ...(analysisMode && analysisDraft ? { analysis_draft: analysisDraft } : {}) });
      submittedStudy.current = analysisMode && analysisDraft ? { task: receipt.task_id, epoch: receipt.epoch, candidate: JSON.stringify(analysisDraft) } : null;
      setText(''); setReference(null); setFollow(true);
      setData(await coreRequest<Conversation>(`/projects/${project}/conversation`));
    } catch (failure) { setError(String(failure)); }
    finally { generation.current++; setBusy(false); }
  };
  return <section className="conversation-panel" aria-label="工程持续对话">
    <div className="conversation-heading"><div><Sparkles size={16} /><h2>工程助手</h2>{active && <LoaderCircle size={14} className="spin" />}</div><button className="icon-button" aria-label="当前工程上下文" title="当前工程上下文" onClick={() => onMemory()}><BrainCircuit size={17} /></button></div>
    <div className="conversation-messages" onScroll={event => { const el = event.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 70); }}>
      {!data.messages.length && <div className="conversation-empty"><Sparkles size={26} strokeWidth={1.3} /><h3>从一个想法开始。</h3><p>描述你想建立的模型，或在视口选择一个对象，告诉我接下来怎么改。</p><p>工程和对话会自动保存。</p></div>}
      {data.messages.map(message => <article className={`conversation-message ${message.role}`} key={message.id}>
        <strong>{message.role === 'user' ? '你' : 'VISION'}</strong><p>{message.text}</p>
        {message.completion && <details><summary>{modelCompletionLabel(message.completion, revision)}</summary>
          <p>{message.completion.notice}</p>
          {message.completion.checks.length > 0 && <ul>{message.completion.checks.map((check, index) => <li key={index}>
            {check.requirement.name} · {check.status === 'pass' ? '通过' : check.status === 'fail' ? '未通过' : '待核验'}
            {check.actual !== null && ` · 实测 ${modelCheckValue(check.actual, check.requirement.metric)}`}
            {check.requirement.minimum !== null && ` · 最小 ${modelCheckValue(check.requirement.minimum, check.requirement.metric)}`}
            {check.requirement.maximum !== null && ` · 最大 ${modelCheckValue(check.requirement.maximum, check.requirement.metric)}`} · {check.reason}
          </li>)}</ul>}
        </details>}
        {message.reference && <small title={message.reference.selection.join('、')}>对象引用 · {message.reference.selection.map(objectLabel).join('、')} · {message.reference.artifact_id === artifact ? '当前几何' : '历史几何，使用前需重新验证'}</small>}
        {message.role === 'user' && <button className="chat-remember" title={active ? '先停止当前执行，再整理要求' : '从这条消息记录工程要求'} disabled={active} onClick={() => onMemory({ id: message.id, text: message.text })}>记为要求</button>}
      </article>)}
      {data.task && <div className="conversation-execution" role="status"><strong>{active && <span className="status-dot online" />}{states[data.task.state] ?? data.task.state}</strong>
        <details><summary>执行记录 · {data.task.turns} 步</summary><p>本轮 {data.task.turns} 次模型请求 · {data.task.jobs} 个原生作业 · 累计已报告 {data.task.config.used_tokens ?? 0} token</p></details>
        {active && <p>{step?.response?.tool ? `当前步骤：${step.response.tool}` : '正在分析需求…'}</p>}
        {data.task.error && <p className="core-error">{data.task.error}</p>}
      </div>}
      <div ref={bottom} />
    </div>
    <form className="conversation-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {selection.length > 0 && artifact && <button type="button" onClick={() => setReference({ artifact, revision, selection: [...selection] })}>引用所选对象（{selection.length}）</button>}
      {reference && <button type="button" className="conversation-reference" title={reference.selection.join('、')} onClick={() => setReference(null)}>{stale ? '引用已失效，请重新选择' : reference.selection.map(objectLabel).join('、')} ×</button>}
      {error && <p className="core-error" role="alert">{error}</p>}
      {pollError && <p className="core-error" role="alert">{pollError}</p>}
      {provider?.configured === false && <p role="status">请在后端配置 DEEPSEEK_API_KEY；不要在对话里填写密钥。</p>}
      {analysisMode && <small className="analysis-chat-context">静力分析 · 自动附带分析范围与候选工况。直接描述分析目的；缺失的材料、载荷或安装条件由助手询问。</small>}
      <label className="conversation-input"><span className="sr-only">你的消息</span><textarea aria-label="对话消息" rows={3} value={text} placeholder={analysisMode ? "例如：分析支撑柱的横向变形，先帮我确定工况…" : "描述模型，或提出修改…"} onChange={event => setText(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }} /></label>
      <div className="conversation-send"><button type="button" className="chat-model" onClick={onModel}>{provider?.model ?? '选择模型'}<ChevronDown size={12} /></button><div>
        {active && <button type="button" className="icon-button" aria-label="停止当前执行" title="停止当前执行" disabled={busy} onClick={async () => {
          setBusy(true); generation.current++;
          try { await coreRequest(`/tasks/${data.task!.id}/cancel`, { ...coreCommand(), expected_epoch: data.task!.epoch }); setData(await coreRequest<Conversation>(`/projects/${project}/conversation`)); }
          catch (failure) { setError(String(failure)); } finally { generation.current++; setBusy(false); }
        }}><Square size={15} /></button>}
        <button className="chat-send" aria-label={active ? '调整并发送' : '发送消息'} title={active ? '停止旧计划，调整并发送' : '发送消息'} disabled={busy || !ready || !text.trim() || stale || !provider?.configured}><ArrowUp size={18} /></button>
      </div></div>
      <small className="composer-hint">{active ? '新消息会停止未完成作业并重新规划。' : 'Enter 发送 · Shift+Enter 换行'}</small>
    </form>
  </section>;
}
