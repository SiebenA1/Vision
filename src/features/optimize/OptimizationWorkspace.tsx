import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
  FlaskConical,
  Gauge,
  Loader2,
  Play,
  Sparkles,
  Target,
  TrendingDown,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useAppStore } from '../../state/store';
import { runOptimizationStudy, runStudy } from '../../services/simulation';
import { fmt } from '../../lib/format';
import type { OptimizerCandidate } from '../../core/types';

interface OptimizationWorkspaceProps {
  onClose: () => void;
  onOpenAnalysis: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  baseline: '基线',
  screen: '并行',
  refine: '细化',
  verify: '复核',
  done: '完成',
};

function candidateLabel(value: number): string {
  return `${value}`;
}

export default function OptimizationWorkspace({ onClose, onOpenAnalysis }: OptimizationWorkspaceProps) {
  const model = useAppStore((state) => state.model);
  const seed = useAppStore((state) => state.optimizationSeed);
  const setSeed = useAppStore((state) => state.setOptimizationSeed);
  const optimization = useAppStore((state) => state.optimization);
  const status = useAppStore((state) => state.optimizationStatus);
  const progress = useAppStore((state) => state.optimizationProgress);
  const error = useAppStore((state) => state.optimizationError);
  const setVariable = useAppStore((state) => state.setVariable);
  const rebuildGeometry = useAppStore((state) => state.rebuildGeometry);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const addToast = useAppStore((state) => state.addToast);
  const [variableKey, setVariableKey] = useState(seed.variableKey);
  const [targetSafety, setTargetSafety] = useState(seed.targetSafety);
  const [displacementLimit, setDisplacementLimit] = useState(seed.displacementLimit);
  const [liveCandidates, setLiveCandidates] = useState<OptimizerCandidate[]>([]);
  const [log, setLog] = useState<Array<{ id: string; stage: string; message: string }>>([]);
  const autoStarted = useRef(false);
  const busy = status === 'running';
  const variable = model.variables.find((item) => item.key === variableKey) ?? model.variables[0];

  const candidates = useMemo(() => {
    if (optimization) return optimization.candidates;
    return liveCandidates;
  }, [optimization, liveCandidates]);

  useEffect(() => {
    if (!progress) return;
    setLog((current) => [
      ...current.slice(-8),
      { id: `${progress.stage}_${progress.completed}_${progress.message}_${current.length}`, stage: progress.stage, message: progress.message },
    ]);
    if (progress.candidate) {
      setLiveCandidates((current) => {
        const filtered = current.filter((candidate) => candidate.value !== progress.candidate!.value);
        return [...filtered, progress.candidate!];
      });
    }
  }, [progress]);

  const run = async () => {
    setSeed({ variableKey, targetSafety, displacementLimit, autoRun: false });
    setLiveCandidates([]);
    setLog([]);
    await runOptimizationStudy({ variableKey, targetSafety, displacementLimit });
  };

  useEffect(() => {
    if (seed.autoRun && !autoStarted.current) {
      autoStarted.current = true;
      setSeed({ autoRun: false });
      void run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed.autoRun]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, busy]);

  const applyRecommendation = async () => {
    if (!optimization?.recommended) return;
    setVariable(optimization.variableKey, optimization.recommended.value, '应用优化推荐解');
    addToast({
      title: '已应用优化解',
      detail: `${optimization.variableLabel} = ${optimization.recommended.value} mm · 正在重新校核`,
      tone: 'success',
    });
    await rebuildGeometry();
    openWorkspace('analysis');
    await runStudy({ openWorkspace: true, focusResult: true, silentToast: false });
  };

  const plot = useMemo(() => {
    const width = 720;
    const height = 330;
    const padding = { left: 58, right: 28, top: 26, bottom: 46 };
    const points = candidates.length
      ? candidates
      : optimization?.recommended
        ? [optimization.recommended]
        : [];
    const masses = points.map((point) => point.massKg);
    const safety = points.map((point) => point.safetyFactor);
    const minMass = Math.min(...(masses.length ? masses : [0.4]));
    const maxMass = Math.max(...(masses.length ? masses : [0.8]));
    const massSpan = Math.max(0.02, maxMass - minMass);
    const xMin = Math.max(0, minMass - massSpan * 0.18);
    const xMax = maxMass + massSpan * 0.18;
    const yMin = 0;
    const yMax = Math.max(3.2, ...(safety.length ? safety : [0]), targetSafety + 0.7);
    const sx = (mass: number) =>
      padding.left + ((mass - xMin) / Math.max(1e-9, xMax - xMin)) * (width - padding.left - padding.right);
    const sy = (sf: number) =>
      height - padding.bottom - ((sf - yMin) / Math.max(1e-9, yMax - yMin)) * (height - padding.top - padding.bottom);
    return { width, height, padding, xMin, xMax, yMin, yMax, sx, sy };
  }, [candidates, optimization, targetSafety]);

  const recommended = optimization?.recommended ?? null;
  const baseline = optimization?.baseline ?? null;
  const progressPercent = progress ? Math.min(100, Math.round((progress.completed / Math.max(1, progress.total)) * 100)) : 0;
  const feasibleCount = candidates.filter((candidate) => candidate.feasible).length;

  return (
    <div className="workspace-overlay optimization-workspace">
      <header className="workspace-bar">
        <div className="workspace-bar__left">
          <button type="button" className="button button--icon-text" onClick={onClose} disabled={busy}>
            <ArrowLeft size={15} /> 返回设计
          </button>
          <span className="workspace-bar__divider" />
          <div>
            <span className="eyebrow">GENERATIVE DESIGN / MASS MIN</span>
            <h2>FE-in-the-loop 优化</h2>
          </div>
        </div>
        <div className="workspace-bar__meta">
          <span className="chip">BOUNDED PATTERN SEARCH</span>
          <span className="chip">EXACT CAD MASS</span>
          <span className="chip">{model.code} · {model.revision}</span>
        </div>
        <div className="workspace-bar__actions">
          <button type="button" className="button button--primary" onClick={run} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {busy ? '搜索中' : '启动搜索'}
          </button>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭优化工作台">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="workspace-body optimization-body">
        <aside className="optimization-config">
          <div className="optimization-config__head">
            <span className="eyebrow">DESIGN SPACE</span>
            <span className={`chip ${busy ? 'chip--live' : optimization?.recommended ? 'chip--good' : ''}`}>
              {busy ? 'SEARCHING' : optimization?.recommended ? 'FEASIBLE' : 'READY'}
            </span>
          </div>

          <label className="field-label">
            <span>优化变量</span>
            <select
              className="select"
              value={variableKey}
              onChange={(event) => setVariableKey(event.target.value)}
              disabled={busy}
            >
              {model.variables.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label} · {item.labelEn}
                </option>
              ))}
            </select>
          </label>
          <div className="bound-row">
            <span>BOUNDS</span>
            <b>{variable.min} — {variable.max} mm</b>
            <small>step {variable.step}</small>
          </div>

          <div className="config-divider" />

          <div className="objective-card">
            <div className="objective-card__icon"><TrendingDown size={18} /></div>
            <div>
              <span className="eyebrow">OBJECTIVE</span>
              <b>最小化结构质量</b>
              <small>CAD volume × material density</small>
            </div>
          </div>

          <label className="field-label field-label--inline">
            <span>安全系数下限</span>
            <div className="unit-input">
              <input
                type="number"
                min={1}
                max={5}
                step={0.1}
                value={targetSafety}
                onChange={(event) => setTargetSafety(Number(event.target.value))}
                disabled={busy}
              />
              <span>SF</span>
            </div>
          </label>
          <label className="field-label field-label--inline">
            <span>位移上限</span>
            <div className="unit-input">
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={displacementLimit}
                onChange={(event) => setDisplacementLimit(Number(event.target.value))}
                disabled={busy}
              />
              <span>mm</span>
            </div>
          </label>
          <label className="field-label field-label--inline">
            <span>评估网格</span>
            <div className="unit-input">
              <input type="number" value={model.mesh.cellSizeMm ?? 3} readOnly />
              <span>mm</span>
            </div>
          </label>

          <div className="optimization-strategy">
            <div className="optimization-strategy__head">
              <FlaskConical size={14} />
              <b>求解策略</b>
            </div>
            <ol>
              <li className={progress ? 'is-done' : ''}>
                <span>01</span> 基线 + 6 点边界评估
              </li>
              <li className={progress && ['screen', 'refine', 'verify', 'done'].includes(progress.stage) ? 'is-done' : ''}>
                <span>02</span> 6 点边界扫描 + 邻域细化
              </li>
              <li className={progress && ['verify', 'done'].includes(progress.stage) ? 'is-done' : ''}>
                <span>03</span> 推荐解最终复核              </li>
            </ol>
          </div>

          <div className="run-progress">
            <div className="run-progress__head">
              <span>{busy ? 'SEARCH IN PROGRESS' : optimization ? 'SEARCH COMPLETE' : 'AWAITING START'}</span>
              <b>{busy ? `${progressPercent}%` : optimization ? `${(optimization.elapsedMs / 1000).toFixed(1)} s` : '—'}</b>
            </div>
            <div className="run-progress__bar">
              <span style={{ width: `${busy ? progressPercent : optimization ? 100 : 0}%` }} />
            </div>
            <div className="run-progress__message">
              {error ? <span className="text-bad">{error}</span> : progress?.message ?? '每个候选点均运行真实 C3D8 + PCG 求解。'}
            </div>
          </div>

          {log.length > 0 && (
            <div className="optimization-log">
              <span className="eyebrow">SEARCH LOG</span>
              {log.map((entry) => (
                <div key={entry.id}>
                  <span>{STAGE_LABELS[entry.stage] ?? entry.stage}</span>
                  <p>{entry.message}</p>
                </div>
              ))}
            </div>
          )}

          <div className="config-note">
            <Target size={14} />
            <span>推荐解由细网格复核后输出；未通过复核的解不会标记为可行。</span>
          </div>
        </aside>

        <section className="optimization-center">
          <div className="optimization-chart card-surface">
            <div className="card-head">
              <div>
                <span className="eyebrow">DESIGN SPACE / MASS vs SAFETY</span>
                <h3>候选设计分布</h3>
              </div>
              <div className="chart-legend">
                <span><i className="dot dot--feasible" />可行</span>
                <span><i className="dot dot--infeasible" />不可行</span>
                <span><i className="dot dot--baseline" />基线</span>
                <span><i className="dot dot--best" />推荐</span>
              </div>
            </div>
            {candidates.length === 0 && !busy ? (
              <div className="chart-empty">
                <Sparkles size={28} />
                <h4>等待设计空间扫描</h4>
                <p>启动搜索后，每个点代表一次真实有限元求解。质量来自 CAD 精确体积，安全系数来自最大 von Mises 应力。</p>
                <button type="button" className="button button--primary" onClick={run}>
                  <Play size={14} /> 启动优化
                </button>
              </div>
            ) : (
              <svg viewBox={`0 0 ${plot.width} ${plot.height}`} className="optimization-plot" role="img" aria-label="候选设计质量与安全系数分布">
                <defs>
                  <linearGradient id="feasibleFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#9ddc73" stopOpacity="0.16" />
                    <stop offset="100%" stopColor="#9ddc73" stopOpacity="0.025" />
                  </linearGradient>
                </defs>
                {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
                  const y = plot.padding.top + fraction * (plot.height - plot.padding.top - plot.padding.bottom);
                  const value = plot.yMax - fraction * (plot.yMax - plot.yMin);
                  return (
                    <g key={fraction}>
                      <line
                        x1={plot.padding.left}
                        x2={plot.width - plot.padding.right}
                        y1={y}
                        y2={y}
                        className="plot-gridline"
                      />
                      <text x={plot.padding.left - 10} y={y + 3} textAnchor="end" className="plot-tick">
                        {value.toFixed(1)}
                      </text>
                    </g>
                  );
                })}
                {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
                  const x = plot.padding.left + fraction * (plot.width - plot.padding.left - plot.padding.right);
                  const value = plot.xMin + fraction * (plot.xMax - plot.xMin);
                  return (
                    <g key={fraction}>
                      <line
                        x1={x}
                        x2={x}
                        y1={plot.padding.top}
                        y2={plot.height - plot.padding.bottom}
                        className="plot-gridline plot-gridline--v"
                      />
                      <text x={x} y={plot.height - plot.padding.bottom + 18} textAnchor="middle" className="plot-tick">
                        {value.toFixed(2)}
                      </text>
                    </g>
                  );
                })}
                <rect
                  x={plot.padding.left}
                  y={plot.padding.top}
                  width={plot.width - plot.padding.left - plot.padding.right}
                  height={plot.sy(targetSafety) - plot.padding.top}
                  fill="url(#feasibleFill)"
                />
                <line
                  x1={plot.padding.left}
                  x2={plot.width - plot.padding.right}
                  y1={plot.sy(targetSafety)}
                  y2={plot.sy(targetSafety)}
                  className="plot-target"
                />
                <text x={plot.width - plot.padding.right - 4} y={plot.sy(targetSafety) - 8} textAnchor="end" className="plot-target-label">
                  SF ≥ {targetSafety.toFixed(1)} 可行域                </text>
                {candidates.map((candidate) => {
                  const isBaseline = Math.abs(candidate.value - (baseline?.value ?? variable.value)) < 1e-6;
                  const isBest = recommended && Math.abs(candidate.value - recommended.value) < 1e-6;
                  return (
                    <g key={`${candidate.value}-${candidate.status}`}>
                      <circle
                        cx={plot.sx(candidate.massKg)}
                        cy={plot.sy(candidate.safetyFactor)}
                        r={isBest ? 8 : isBaseline ? 6.5 : 5}
                        className={`plot-dot ${
                          isBest ? 'plot-dot--best' : isBaseline ? 'plot-dot--baseline' : candidate.feasible ? 'plot-dot--feasible' : 'plot-dot--infeasible'
                        }`}
                      >
                        <title>
                          {variable.label} {candidate.value} mm · {fmt(candidate.massKg, 3)} kg · SF {fmt(candidate.safetyFactor, 2)}
                        </title>
                      </circle>
                      {(isBest || isBaseline) && (
                        <text
                          x={plot.sx(candidate.massKg) + 11}
                          y={plot.sy(candidate.safetyFactor) - 10}
                          className="plot-point-label"
                        >
                          {isBest ? 'BEST' : 'BASE'} · {candidate.value}mm
                        </text>
                      )}
                    </g>
                  );
                })}
                <text x={plot.width / 2} y={plot.height - 7} textAnchor="middle" className="plot-axis-label">
                  结构质量 / kg
                </text>
                <text
                  transform={`translate(14 ${plot.height / 2}) rotate(-90)`}
                  textAnchor="middle"
                  className="plot-axis-label"
                >
                  安全系数 / SF
                </text>
              </svg>
            )}
            <div className="chart-footer">
              <span><CircleDot size={12} /> {candidates.length} 次 FE 求解</span>
              <span><Check size={12} /> {feasibleCount} 个可行候选</span>
              <span><Gauge size={12} /> 位移约束 {displacementLimit} mm</span>
              <span className="chart-footer__right">
                {progress ? `${STAGE_LABELS[progress.stage] ?? progress.stage} · ${progress.completed}/${progress.total}` : 'IDLE'}
              </span>
            </div>
          </div>

          <div className="optimization-table card-surface">
            <div className="card-head">
              <div>
                <span className="eyebrow">CANDIDATE SET</span>
                <h3>候选解与约束状态</h3>
              </div>
              <span className={`chip ${feasibleCount > 0 ? 'chip--good' : 'chip--warn'}`}>
                {feasibleCount > 0 ? `${feasibleCount} FEASIBLE` : 'NO FEASIBLE'}
              </span>
            </div>
            <div className="candidate-table">
              <div className="candidate-table__head">
                <span>VALUE</span>
                <span>MASS</span>
                <span>SF</span>
                <span>δ MAX</span>
                <span>STATE</span>
                <span />
              </div>
              {(candidates.length ? [...candidates].sort((a, b) => a.value - b.value) : []).map((candidate) => {
                const isBest = recommended && Math.abs(candidate.value - recommended.value) < 1e-6;
                return (
                  <div key={`${candidate.value}-row`} className={`candidate-table__row ${isBest ? 'is-best' : ''}`}>
                    <span className="mono">{candidate.value.toFixed(1)} mm</span>
                    <span>{fmt(candidate.massKg, 3)} kg</span>
                    <span className={candidate.safetyFactor >= targetSafety ? 'text-good' : 'text-bad'}>
                      {fmt(candidate.safetyFactor, 2)}
                    </span>
                    <span className={candidate.maxDisplacement <= displacementLimit ? 'text-good' : 'text-bad'}>
                      {fmt(candidate.maxDisplacement, 3)} mm
                    </span>
                    <span>
                      <i className={`state-pill ${candidate.status === 'verified' ? 'state-pill--verified' : candidate.feasible ? 'state-pill--feasible' : 'state-pill--bad'}`}>
                        {candidate.status === 'verified' ? 'VERIFIED' : candidate.feasible ? 'FEASIBLE' : 'REJECT'}
                      </i>
                    </span>
                    <span className="candidate-table__action">
                      {isBest ? <ArrowUpRight size={13} /> : <ChevronRight size={13} />}
                    </span>
                  </div>
                );
              })}
              {candidates.length === 0 && (
                <div className="candidate-table__empty">搜索完成后，候选解按设计变量排序显示。</div>
              )}
            </div>
          </div>
        </section>

        <aside className="optimization-right">
          <div className="best-card">
            <div className="best-card__head">
              <span className="eyebrow">RECOMMENDED DESIGN</span>
              <span className={`chip ${recommended ? 'chip--good' : 'chip--warn'}`}>
                {recommended ? 'FEASIBLE' : optimization ? 'NO SOLUTION' : 'PENDING'}
              </span>
            </div>
            {recommended ? (
              <>
                <div className="best-value">
                  <span>{variable.label}</span>
                  <div>
                    <b>{recommended.value.toFixed(1)}</b>
                    <small>mm</small>
                  </div>
                </div>
                <div className="best-metrics">
                  <div><span>质量</span><b>{fmt(recommended.massKg, 3)} kg</b></div>
                  <div><span>安全系数</span><b>{fmt(recommended.safetyFactor, 2)}</b></div>
                  <div><span>位移</span><b>{fmt(recommended.maxDisplacement, 3)} mm</b></div>
                  <div><span>状态</span><b className="text-good">细网格复核</b></div>
                </div>
                <div className={`mass-delta ${(optimization?.massDeltaPercent ?? 0) <= 0 ? 'is-good' : 'is-warn'}`}>
                  <TrendingDown size={17} />
                  <div>
                    <b>
                      {optimization?.massDeltaPercent != null
                        ? `${optimization.massDeltaPercent > 0 ? '+' : ''}${fmt(optimization.massDeltaPercent, 1)}%`
                        : '—'}
                    </b>
                    <span>相对基线质量</span>
                  </div>
                  <small>{fmt(baseline?.massKg ?? 0, 3)} → {fmt(recommended.massKg, 3)} kg</small>
                </div>
                <button type="button" className="button button--primary best-apply" onClick={applyRecommendation} disabled={busy}>
                  应用推荐解并复核 <ArrowUpRight size={14} />
                </button>
                <button type="button" className="button button--ghost" onClick={onOpenAnalysis}>
                  打开分析工作台                </button>
              </>
            ) : optimization ? (
              <div className="best-empty">
                <TriangleAlert size={24} />
                <h4>边界内无可行解</h4>
                <p>{optimization.note}</p>
                <button type="button" className="button" onClick={() => setTargetSafety(Math.max(1, targetSafety - 0.2))}>
                  放宽安全系数目标
                </button>
              </div>
            ) : (
              <div className="best-empty">
                <Sparkles size={24} />
                <h4>等待设计空间评估</h4>
                <p>优化器将以精确 CAD 质量为目标，以线弹性 FE 应力与位移为约束，先并行边界评估，再对推荐解做最终复核。</p>
              </div>
            )}
          </div>

          {optimization && (
            <div className="analysis-section analysis-section--right">
              <span className="eyebrow">BASELINE COMPARISON</span>
              <div className="compare-row">
                <span>基线 {variable.label}</span>
                <b>{baseline?.value ?? variable.value} mm</b>
              </div>
              <div className="compare-row">
                <span>基线 SF</span>
                <b>{fmt(baseline?.safetyFactor ?? 0, 2)}</b>
              </div>
              <div className="compare-row">
                <span>目标 SF</span>
                <b>{targetSafety.toFixed(2)}</b>
              </div>
              <div className="compare-row">
                <span>质量变化</span>
                <b className={(optimization.massDeltaPercent ?? 0) <= 0 ? 'text-good' : 'text-warn'}>
                  {optimization.massDeltaPercent == null
                    ? '—'
                    : `${optimization.massDeltaPercent > 0 ? '+' : ''}${fmt(optimization.massDeltaPercent, 1)}%`}
                </b>
              </div>
            </div>
          )}

          <div className="analysis-section analysis-section--right">
            <span className="eyebrow">METHOD & LIMITS</span>
            <p className="method-note">
              有界模式搜索 + FE-in-the-loop 评估。候选点在工作网格精度上并行求解，推荐解再做最终复核。质量来自
              CAD 体积；应力来自单元形心 von Mises；体素边界、理想约束与线弹性假设仍然适用。            </p>
            <div className="method-tags">
              <span>DETERMINISTIC</span>
              <span>NO SURROGATE</span>
              <span>REPRODUCIBLE</span>
            </div>
          </div>

          <div className="analysis-disclaimer">
            <TriangleAlert size={14} />
            <span>
              单变量搜索不等于全局最优。生产设计应扩展到多变量、疲劳、屈曲、连接与制造约束，并完成试验相关性。            </span>
          </div>
        </aside>
      </div>

      <div className="workspace-statusbar">
        <span><FlaskConical size={12} /> {candidates.length} FE RUNS</span>
        <span><Check size={12} /> BEST {recommended ? `${recommended.value.toFixed(1)} mm` : '—'}</span>
        <span><Gauge size={12} /> CONSTRAINT SF ≥ {targetSafety.toFixed(2)}</span>
        <span className="workspace-statusbar__right">ESC 返回 · 所有求解在本地 Worker 内完成</span>
      </div>
    </div>
  );
}

