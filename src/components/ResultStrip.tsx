import { ArrowUpRight, Activity, ChevronRight, Gauge, Play, RefreshCw, Waves } from 'lucide-react';
import { useAppStore } from '../state/store';
import { fmt } from '../lib/format';
import type { FieldKind } from '../core/types';

interface ResultStripProps {
  onRun: () => void;
  onOpenAnalysis: () => void;
}

const FIELD_LABELS: Record<FieldKind, string> = {
  vonMises: 'von Mises',
  displacement: '位移',
  safety: '安全系数',
};

export function ResultStrip({ onRun, onOpenAnalysis }: ResultStripProps) {
  const analysis = useAppStore((state) => state.analysis);
  const status = useAppStore((state) => state.analysisStatus);
  const progress = useAppStore((state) => state.solveProgress);
  const stale = useAppStore((state) => state.resultStale);
  const metrics = useAppStore((state) => state.geometryMetrics);
  const viewMode = useAppStore((state) => state.viewMode);
  const field = useAppStore((state) => state.field);
  const deformationScale = useAppStore((state) => state.deformationScale);
  const setViewMode = useAppStore((state) => state.setViewMode);
  const setField = useAppStore((state) => state.setField);
  const setDeformationScale = useAppStore((state) => state.setDeformationScale);
  const busy = ['mesh', 'solve', 'refine', 'queued'].includes(status);
  const sf = analysis?.safetyFactor ?? 0;
  const sfTone = sf >= 2 ? 'good' : sf >= 1 ? 'warn' : 'bad';
  const mass = analysis?.massKg ?? metrics?.massKg;
  const isBlank = useAppStore((state) => (state.model.template ?? 'bracket') === 'empty');
  const progressPercent = Math.min(100, Math.max(2, progress?.percent ?? (status === 'ready' ? 100 : 0)));

  return (
    <section className={`result-strip ${busy ? 'is-busy' : ''}`} aria-label="分析结果">
      <div className="result-strip__lead">
        <div className="study-state">
          <span className={`study-state__dot study-state__dot--${busy ? 'busy' : analysis ? 'ready' : 'idle'}`} />
          <div>
            <span className="eyebrow">STATIC STUDY / LC-01</span>
            <b>{busy ? '求解进行中' : analysis ? (stale ? '结果已过期' : '校核完成') : '尚未校核'}</b>
          </div>
        </div>
        {busy ? (
          <div className="solve-progress">
            <div className="solve-progress__bar">
              <span style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="solve-progress__meta">
              <span>{progress?.detail ?? '初始化求解器'}</span>
              <b>{progressPercent.toFixed(0)}%</b>
            </div>
          </div>
        ) : (
          <div className="study-meta">
            <span>{analysis ? `${analysis.solver.method} · ${analysis.mesh.elements.toLocaleString('en-US')} EL` : 'TETGEN / SFEPY'}</span>
            <span>{analysis ? 'TETGEN + SFEPY' : 'NO RESULT'}</span>
            {analysis?.convergence && <span>Δh {fmt(analysis.convergence.deltaPercent, 1)}%</span>}
          </div>
        )}
      </div>

      <div className="metric-row">
        <div className="metric">
          <div className="metric__icon"><Gauge size={14} /></div>
          <div>
            <span className="metric__label">质量 MASS</span>
            <div className="metric__value">
              <b>{mass !== undefined ? fmt(mass, 3) : '—'}</b>
              <small>kg</small>
            </div>
          </div>
        </div>
        <div className="metric">
          <div className="metric__icon"><Activity size={14} /></div>
          <div>
            <span className="metric__label">最大应力 σvM</span>
            <div className="metric__value">
              <b>{analysis ? fmt(analysis.maxVonMises, 1) : '—'}</b>
              <small>MPa</small>
            </div>
          </div>
        </div>
        <div className="metric">
          <div className="metric__icon"><Waves size={14} /></div>
          <div>
            <span className="metric__label">最大位移 δmax</span>
            <div className="metric__value">
              <b>{analysis ? fmt(analysis.maxDisplacement, 3) : '—'}</b>
              <small>mm</small>
            </div>
          </div>
        </div>
        <div className={`metric metric--safety metric--${sfTone}`}>
          <div className="metric__icon"><span>SF</span></div>
          <div>
            <span className="metric__label">安全系数 SAFETY</span>
            <div className="metric__value">
              <b>{analysis ? fmt(analysis.safetyFactor, 2) : '—'}</b>
              <small>/ 2.00</small>
            </div>
          </div>
        </div>
      </div>

      <div className="result-strip__actions">
        {analysis && (
          <div className="result-controls">
            <div className="segmented segmented--small" role="group" aria-label="显示模式">
              <button
                type="button"
                className={viewMode === 'design' ? 'is-active' : ''}
                onClick={() => setViewMode('design')}
              >
                设计
              </button>
              <button
                type="button"
                className={viewMode === 'result' ? 'is-active' : ''}
                onClick={() => setViewMode('result')}
              >
                结果场
              </button>
            </div>
            {viewMode === 'result' && (
              <>
                <select
                  className="select select--compact"
                  value={field}
                  onChange={(event) => setField(event.target.value as FieldKind)}
                  aria-label="结果场"
                >
                  {(Object.keys(FIELD_LABELS) as FieldKind[]).map((key) => (
                    <option key={key} value={key}>
                      {FIELD_LABELS[key]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="scale-chip"
                  title="循环变形放大系数"
                  onClick={() => {
                    const next = deformationScale >= 50 ? 1 : deformationScale >= 10 ? 50 : 10;
                    setDeformationScale(next);
                  }}
                >
                  ×{deformationScale}
                </button>
              </>
            )}
          </div>
        )}
        {stale && (
          <button type="button" className="button button--ghost" onClick={onRun}>
            <RefreshCw size={13} /> 刷新结果
          </button>
        )}
        {!analysis && !busy && !isBlank && (
          <button type="button" className="button button--ghost" onClick={onRun}>
            <Play size={13} /> 运行基线校核
          </button>
        )}
        {isBlank && !busy && (
          <span className="result-strip__hint">空白工程 · 请先添加基础体</span>
        )}
        <button type="button" className="button button--dark" onClick={onOpenAnalysis}>
          分析工作台 <ArrowUpRight size={14} />
        </button>
        <button type="button" className="icon-button result-strip__chevron" onClick={onOpenAnalysis} aria-label="打开分析">
          <ChevronRight size={15} />
        </button>
      </div>
    </section>
  );
}
