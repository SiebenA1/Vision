import { useEffect, useRef, useState } from 'react';
import { coreRequest, type CoreRevision } from './api';

const names: Record<string, string> = { maxDisplacement: '最大位移', maxVonMises: 'von Mises', mass_kg: '质量', safetyFactor: '屈服安全系数' };
interface Comparison {
  comparable: boolean; reasons: string[]; notice: string;
  left: { revision_id: string; evidence_job_id: string | null }; right: { revision_id: string; evidence_job_id: string | null };
  metrics: Array<{ metric: string; unit: string; left: number | null; right: number | null; difference: number | null }>;
}
const value = (number: number | null) => number === null ? '—' : number.toPrecision(6);
export function ComparisonPanel({ project, revisions }: { project: string; revisions: CoreRevision[] }) {
  const [left, setLeft] = useState(''), [right, setRight] = useState('');
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const invalidate = () => { request.current?.abort(); setResult(null); setError(''); setBusy(false); };
  return <section className="core-results"><details><summary>版本数值比较</summary>
    <p>选择同一工程的两个固定版本。此处先提供只读比较；完整方案分支和决策采纳尚未接入。</p>
    <label>基准版本<select aria-label="比较基准版本" value={left} onChange={event => { invalidate(); setLeft(event.target.value); }}>
      <option value="">请选择</option>{revisions.map(revision => <option key={revision.revision_id} value={revision.revision_id}>{revision.revision_id.slice(0, 12)} · {revision.document.name}</option>)}
    </select></label>
    <label>候选版本<select aria-label="比较候选版本" value={right} onChange={event => { invalidate(); setRight(event.target.value); }}>
      <option value="">请选择</option>{revisions.map(revision => <option key={revision.revision_id} value={revision.revision_id}>{revision.revision_id.slice(0, 12)} · {revision.document.name}</option>)}
    </select></label>
    <button disabled={busy || !left || !right || left === right} onClick={() => {
      invalidate(); const abort = new AbortController(); request.current = abort; setBusy(true);
      void coreRequest<Comparison>(`/projects/${project}/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`, undefined, abort.signal)
        .then(response => { if (!abort.signal.aborted) setResult(response); })
        .catch(failure => { if (!abort.signal.aborted) setError(String(failure)); })
        .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    }}>比较所选版本</button>
    {error && <p role="alert">{error}</p>}
    {result && <div data-comparable={result.comparable}>
      <p>{result.comparable ? '输入条件可比，以下为数值差值。' : '条件不足或不兼容，仅展示已有摘要，不计算差值或排名。'}</p>
      {result.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
      <div className="core-table-scroll"><table><thead><tr><th>指标</th><th>基准</th><th>候选</th><th>候选−基准</th><th>单位</th></tr></thead>
        <tbody>{result.metrics.map(metric => <tr key={metric.metric}><td>{names[metric.metric]}</td><td>{value(metric.left)}</td><td>{value(metric.right)}</td><td>{value(metric.difference)}</td><td>{metric.unit}</td></tr>)}</tbody></table></div>
      <p>基准证据：{result.left.evidence_job_id ?? '不可核验'} · 候选证据：{result.right.evidence_job_id ?? '不可核验'}</p>
      <p>{result.notice}</p>
    </div>}
  </details></section>;
}
