import { ChevronDown, RefreshCw } from 'lucide-react';
import { useAppStore } from '../state/store';
import { fmt } from '../lib/format';
import type { FieldKind } from '../core/types';

export function ResultStrip({ onRun }: { onRun: () => void }) {
  const analysis = useAppStore((state) => state.analysis);
  const status = useAppStore((state) => state.analysisStatus);
  const progress = useAppStore((state) => state.solveProgress);
  const error = useAppStore((state) => state.analysisError);
  const stale = useAppStore((state) => state.resultStale);
  const viewMode = useAppStore((state) => state.viewMode);
  const field = useAppStore((state) => state.field);
  const scale = useAppStore((state) => state.deformationScale);
  const busy = ['mesh', 'solve', 'refine', 'queued'].includes(status);
  if (!analysis && !busy && !error) return null;
  return (
    <section className={`result-strip ${analysis && !busy ? 'has-results' : ''}`} aria-label="分析摘要" aria-busy={busy}>
      <div className="result-strip__summary">
      <div className="result-strip__head">
        <b role="status">{busy ? '正在分析…' : error ? '分析未完成' : stale ? '结果已过期' : '分析结果'}</b>
        {busy && <progress max={100} value={progress?.percent ?? undefined} aria-label="求解进度" />}
        {error && <span className="text-bad">{error}</span>}
        {stale && !busy && <button type="button" className="button" onClick={onRun}><RefreshCw size={16} />重新求解</button>}
      </div>
      {analysis && !busy &&
        <dl className={`metric-row ${stale ? 'is-stale' : ''}`}>
          {[
            ['最大应力', fmt(analysis.maxVonMises, 1), 'MPa'],
            ['最大位移', fmt(analysis.maxDisplacement, 3), 'mm'],
            ['安全系数', fmt(analysis.safetyFactor, 2), 'SF'],
          ].map(([label, value, unit]) => (
            <div className="metric" key={label}><dt className="metric__label">{label}</dt>
              <dd className="metric__value"><b>{value}</b><small>{unit}</small></dd></div>
          ))}
        </dl>}
      </div>
      {analysis && !busy && !stale && <div className="result-strip__actions">
          <div className="segmented" role="group" aria-label="显示模式">
            <button type="button" aria-pressed={viewMode === 'design'} className={viewMode === 'design' ? 'is-active' : ''} onClick={() => useAppStore.getState().setViewMode('design')}>模型</button>
            <button type="button" aria-pressed={viewMode === 'result'} className={viewMode === 'result' ? 'is-active' : ''} onClick={() => useAppStore.getState().setViewMode('result')}>结果场</button>
          </div>
          {viewMode === 'result' && <div className="result-strip__field-controls">
            <select className="select select--compact" value={field} aria-label="结果场" onChange={(event) => useAppStore.getState().setField(event.target.value as FieldKind)}>
              <option value="vonMises">等效应力</option><option value="displacement">位移</option><option value="safety">安全系数</option>
            </select>
            <details className="display-options"><summary>变形 ×{scale}<ChevronDown size={16} aria-hidden="true" /></summary><label>变形放大倍数
              <select className="select" value={scale} onChange={(event) => useAppStore.getState().setDeformationScale(Number(event.target.value))}>
                {[1, 10, 50].map((value) => <option value={value} key={value}>×{value}</option>)}
              </select></label></details>
          </div>}
      </div>}
    </section>
  );
}
