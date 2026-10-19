import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  CircleAlert,
  Download,
  Gauge,
  Info,
  Play,
  RotateCw,
  ShieldCheck,
  Waves,
  X,
} from 'lucide-react';
import { SceneViewport } from '../../components/SceneViewport';
import { useAppStore } from '../../state/store';
import { getMaterial } from '../../core/materials';
import { fieldMeta, rampCss } from '../../core/fea/fieldProjection';
import { fmt } from '../../lib/format';
import { runValidation } from '../../services/simulation';
import type { FieldKind } from '../../core/types';

interface AnalysisWorkspaceProps {
  onClose: () => void;
  onRun: () => void;
  onRefine: () => void;
  onExport: () => void;
}

const FIELD_OPTIONS: Array<{ id: FieldKind; label: string; code: string }> = [
  { id: 'vonMises', label: '等效应力', code: 'σvM' },
  { id: 'displacement', label: '合位移', code: '|u|' },
  { id: 'safety', label: '安全系数', code: 'SF' },
];

export default function AnalysisWorkspace({ onClose, onRun, onRefine, onExport }: AnalysisWorkspaceProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const model = useAppStore((state) => state.model);
  const geometry = useAppStore((state) => state.geometry);
  const analysis = useAppStore((state) => state.analysis);
  const status = useAppStore((state) => state.analysisStatus);
  const progress = useAppStore((state) => state.solveProgress);
  const error = useAppStore((state) => state.analysisError);
  const stale = useAppStore((state) => state.resultStale);
  const validation = useAppStore((state) => state.validation);
  const validationStatus = useAppStore((state) => state.validationStatus);
  const field = useAppStore((state) => state.field);
  const setField = useAppStore((state) => state.setField);
  const viewMode = useAppStore((state) => state.viewMode);
  const deformationScale = useAppStore((state) => state.deformationScale);
  const setDeformationScale = useAppStore((state) => state.setDeformationScale);
  const showEdges = useAppStore((state) => state.showEdges);
  const showAnnotations = useAppStore((state) => state.showAnnotations);
  const toggleEdges = useAppStore((state) => state.toggleEdges);
  const toggleAnnotations = useAppStore((state) => state.toggleAnnotations);
  const setViewMode = useAppStore((state) => state.setViewMode);
  const material = getMaterial(model.materialId);
  const meta = analysis ? fieldMeta(field, material.yieldStrength) : null;
  const busy = ['mesh', 'solve', 'refine'].includes(status);
  const previousResult = Boolean(analysis && (busy || error || stale));
  const resultStatus = busy ? (analysis ? '本轮计算中 · 当前显示上一轮结果' : '本轮计算中 · 尚无结果')
    : error ? '本轮计算失败 · 请查看错误信息' : stale ? '结果已过期 · 请重新计算'
    : analysis ? '本轮分析已完成' : '尚未分析';
  const sfPass = (analysis?.safetyFactor ?? 0) >= 2;
  const dispPass = (analysis?.maxDisplacement ?? Infinity) <= 2;
  const minField = field === 'safety' ? analysis?.safetyFactor ?? 0 : 0;
  const maxField =
    field === 'displacement'
      ? analysis?.maxDisplacement ?? 0
      : field === 'safety'
        ? Math.max(4, (analysis?.safetyFactor ?? 0) * 1.7)
        : analysis?.maxVonMises ?? 0;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    if (useAppStore.getState().analysis) setViewMode('result');
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, setViewMode]);

  return (
    <div className="workspace-overlay analysis-workspace">
      <header className="workspace-bar">
        <div className="workspace-bar__left">
          <button type="button" className="button button--icon-text" onClick={onClose}>
            <ArrowLeft size={15} /> 返回设计
          </button>
          <span className="workspace-bar__divider" />
          <div>
            <span className="eyebrow">ANALYSIS WORKBENCH / LC-01</span>
            <h2>线性静力 · 结果评估</h2>
          </div>
        </div>
        <div className="workspace-bar__meta">
          <span className="chip">{model.code} · {model.revision}</span>
          <span className="chip">C3D4</span>
          <span className={`chip ${stale ? 'chip--warn' : analysis ? 'chip--good' : ''}`}>
            {stale ? 'STALE RESULT' : analysis ? 'HASH ' + analysis.modelHash : 'NOT SOLVED'}
          </span>
        </div>
        <div className="workspace-bar__actions">
          <button type="button" className="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>设置与诊断</button>
          <button type="button" className="button" onClick={onRun} disabled={busy}>
            <Play size={14} /> {analysis ? '重新求解' : '运行校核'}
          </button>
          <button type="button" className="button" onClick={onRefine} disabled={busy || !analysis}>
            <RotateCw size={14} /> h 加密对比
          </button>
          <button type="button" className="button button--primary" onClick={onExport} disabled={!analysis || busy || stale || Boolean(error)}>
            <Download size={14} /> 导出报告
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭分析工作台">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="workspace-body">
        {detailsOpen && <aside className="analysis-left">
          <div className="analysis-section">
            <span className="eyebrow">STUDY TREE</span>
            <div className="study-tree">
              <div className="study-tree__root">
                <span className="study-tree__dot" />
                <div>
                  <b>LC-01 · 端部竖向载荷</b>
                  <small>{model.loads[0]?.magnitude} N · STATIC</small>
                </div>
              </div>
              <div className="study-tree__leaf">
                <span>MAT</span>
                <div>
                  <b>{material.shortName}</b>
                  <small>E {fmt(material.E / 1000, 1)} GPa · ν {material.nu}</small>
                </div>
              </div>
              <div className="study-tree__leaf">
                <span>BC</span>
                <div>
                  <b>{model.supports[0]?.name}</b>
                  <small>{model.supports[0]?.face} · 3 DOF</small>
                </div>
              </div>
              <div className="study-tree__leaf">
                <span>MSH</span>
                <div>
                  <b>C3D4 · {analysis ? analysis.mesh.elements.toLocaleString('en-US') : '—'} EL</b>
                  <small>h {analysis ? fmt(analysis.mesh.cellSize, 2) : '—'} mm · TetGen</small>
                </div>
              </div>
              <div className="study-tree__leaf">
                <span>SLV</span>
                <div>
                  <b>scikit-fem / {analysis?.solver.algorithm ?? 'Direct'}</b>
                  <small>{analysis ? 'linear elastic' : 'not run'}</small>
                </div>
              </div>
            </div>
          </div>

          <details className="analysis-section"><summary>网格诊断</summary>
            <div className="analysis-section__head">
              <span className="chip chip--tiny">{analysis?.mesh.grid?.join('×') ?? '—'}</span>
            </div>
            <div className="stat-grid">
              <div><span>节点</span><b>{analysis?.mesh.nodes.toLocaleString('en-US') ?? '—'}</b></div>
              <div><span>自由度</span><b>{analysis?.mesh.dofs.toLocaleString('en-US') ?? '—'}</b></div>
              <div><span>Scaled Jacobian</span><b>{analysis ? fmt(analysis.mesh.quality.minScaledJacobian, 3) : '—'}</b></div>
              <div><span>负体积单元</span><b>{analysis?.mesh.quality.negativeElements ?? '—'}</b></div>
            </div>
            <div className="mesh-bar">
              <span style={{ width: `${Math.min(100, ((analysis?.mesh.elements ?? 0) / 5000) * 100)}%` }} />
            </div>
            <div className="mesh-bar__label">
              <span>h {model.mesh.cellSizeMm ?? '—'} mm · 请求尺寸</span>
              <span>{analysis?.mesh.activeNodeRatio != null ? `${fmt(analysis.mesh.activeNodeRatio * 100, 1)}% 活跃节点` : '质量未验证'}</span>
            </div>
          </details>

          <details className="analysis-section"><summary>求解器基准</summary>
            <div className="analysis-section__head">
              <span className={`chip ${validation?.passed ? 'chip--good' : validation ? 'chip--warn' : ''}`}>
                {validationStatus === 'running' ? 'RUNNING' : validation?.passed ? 'PASS' : validation ? 'FAIL' : 'PENDING'}
              </span>
            </div>
            <button type="button" className="button" disabled={busy || validationStatus === 'running'} onClick={() => void runValidation()}>
              {validationStatus === 'running' ? '解析基准计算中…' : '运行解析基准'}
            </button>
            {validation ? (
              <>
                <div className="validation-case">
                  <b>{validation.caseId} · {validation.name}</b>
                  <small>{validation.formula}</small>
                </div>
                <div className="validation-values">
                  <div><span>解析解</span><b>{fmt(validation.reference, 5)} mm</b></div>
                  <div><span>求解器</span><b>{fmt(validation.computed, 5)} mm</b></div>
                  <div><span>误差</span><b className={validation.passed ? 'text-good' : 'text-bad'}>{fmt(validation.errorPercent, 2)}%</b></div>
                  <div><span>单元</span><b>{validation.meshElements.toLocaleString('en-US')}</b></div>
                </div>
                <div className="error-meter">
                  <span style={{ width: `${Math.min(100, (validation.errorPercent / validation.tolerancePercent) * 100)}%` }} />
                  <i style={{ left: '100%' }} />
                </div>
                <div className="error-meter__label">
                  <span>0%</span>
                  <span>容限 {validation.tolerancePercent}%</span>
                </div>
              </>
            ) : (
              <div className="panel-loading">
                {validationStatus === 'running' && <span className="spinner" />}
                <span>{validationStatus === 'running' ? '正在计算独立的解析梁基准…' : validationStatus === 'error' ? '解析基准未完成，可手动重试。' : '尚未运行。此检查独立于当前零件分析，按需执行。'}</span>
              </div>
            )}
          </details>

          {analysis && analysis.warnings.length > 0 && (
            <div className="analysis-section">
              <div className="analysis-section__head">
                <span className="eyebrow">AUTOMATED CHECKS</span>
                <span className="chip chip--warn">{analysis.warnings.length}</span>
              </div>
              <div className="warning-list">
                {analysis.warnings.map((warning) => (
                  <div key={warning} className="warning-item">
                    <CircleAlert size={14} />
                    <span>{warning}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>}

        <section className="analysis-stage">
          <div className="analysis-canvas">
            <SceneViewport
              geometry={geometry}
              model={model}
              material={material}
              analysis={stale ? null : analysis}
              viewMode={analysis ? viewMode : 'design'}
              field={field}
              deformationScale={deformationScale}
              showEdges={showEdges}
              showAnnotations={showAnnotations}
              autoFit
              onToggleEdges={toggleEdges}
              onToggleAnnotations={toggleAnnotations}
            />
            <div className="analysis-overlay analysis-overlay--top">
              <div>
                <span className="eyebrow">FIELD / {meta?.labelEn ?? 'DESIGN'}</span>
                <h1>{meta?.label ?? model.name}</h1>
                <div className="analysis-overlay__meta">
                  <span>{analysis ? `MAX ${fmt(maxField, meta?.decimals ?? 1)} ${meta?.unit.split(' ')[0] ?? ''}` : 'NO RESULT'}</span>
                  <span>{analysis ? `HASH ${analysis.modelHash}` : ''}</span>
                  {stale && <span className="text-warn">STALE</span>}
                  <span role="status">{resultStatus}</span>
                </div>
              </div>
              <div className="field-tabs">
                {FIELD_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={field === option.id ? 'is-active' : ''}
                    onClick={() => setField(option.id)}
                  >
                    <small>{option.code}</small>
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {analysis && meta && (
              <div className="analysis-legend">
                <div className="analysis-legend__title">
                  <span>{meta.labelEn}</span>
                  <b>{meta.unit}</b>
                </div>
                <div className="analysis-legend__ramp">
                  {Array.from({ length: 32 }).map((_, index) => (
                    <span
                      key={index}
                      style={{ background: rampCss(field === 'safety' ? 1 - index / 31 : index / 31) }}
                    />
                  ))}
                </div>
                <div className="analysis-legend__scale">
                  <span>{fmt(minField, meta.decimals)}</span>
                  <span>{fmt(maxField, meta.decimals)}</span>
                </div>
                <div className="analysis-legend__footer">
                  <span>×{deformationScale} 变形</span>
                  <div className="scale-buttons">
                    {[1, 10, 50].map((scale) => (
                      <button
                        key={scale}
                        type="button"
                        className={deformationScale === scale ? 'is-active' : ''}
                        onClick={() => setDeformationScale(scale)}
                      >
                        ×{scale}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {busy && (
              <div className="analysis-busy">
                <span className="spinner spinner--large" />
                <div>
                  <b>{status === 'refine' ? 'h-加密计算中' : '网格生成与静力求解中'}</b>
                  <span>{progress?.detail ?? '初始化…'}</span>
                </div>
                {progress?.percent != null && <b className="mono">{Math.round(progress.percent)}%</b>}
              </div>
            )}

            {error && <div className="analysis-status-error" role="alert">本轮分析未完成：{error}{analysis && '。当前显示上一轮结果。'}</div>}

            {!analysis && !busy && (
              <div className="analysis-empty">
                <Gauge size={30} />
                <h3>尚未生成结果</h3>
                <p>运行一次线性静力校核，或从设计工作台触发分析。</p>
                <button type="button" className="button button--primary" onClick={onRun}>
                  <Play size={14} /> 运行基线校核
                </button>
              </div>
            )}
          </div>

          <div className="analysis-bottom">
            <div className="analysis-kpi">
              <span>最大应力</span>
              <b>{analysis ? fmt(analysis.maxVonMises, 1) : '—'}</b>
              <small>MPa</small>
            </div>
            <div className="analysis-kpi">
              <span>最大位移</span>
              <b>{analysis ? fmt(analysis.maxDisplacement, 3) : '—'}</b>
              <small>mm</small>
            </div>
            <div className={`analysis-kpi ${sfPass ? 'is-good' : 'is-warn'}`}>
              <span>安全系数</span>
              <b>{analysis ? fmt(analysis.safetyFactor, 2) : '—'}</b>
              <small>/ 2.00</small>
            </div>
            <div className="analysis-kpi">
              <span>结构质量</span>
              <b>{analysis ? fmt(analysis.massKg, 3) : '—'}</b>
              <small>kg</small>
            </div>
            <div className="convergence-card" title="可选的网格精度检查：分别以 h 和 h/1.8 求解，比较最大位移差异。尚未对比不代表静力分析未完成；两级位移对比也不等同于局部应力收敛验证。">
              <div>
                <span className="convergence-card__label">网格加密对比</span>
                <b>
                  {status === 'refine' ? '正在加密对比' : busy ? '等待本轮完成' : stale ? '需重新对比' : analysis?.convergence ? `位移差 ${fmt(analysis.convergence.deltaPercent, 2)}%` : analysis ? '尚未进行对比' : '尚无分析结果'}
                </b>
              </div>
              <button type="button" onClick={onRefine} disabled={busy || !analysis} aria-label="运行网格加密对比" title="以当前网格尺寸 h 和 h/1.8 分别求解，比较最大位移差异">
                <ArrowUpRight size={13} /> 对比
              </button>
            </div>
          </div>
        </section>

        <aside className="analysis-right">
          <div className="result-hero">
            <span className="eyebrow">{previousResult ? '上一轮结果 · 仅供对照' : 'RESULT SUMMARY'}</span>
            <p className="analysis-result-status" role="status">{resultStatus}</p>
            <div className={`result-hero__sf ${sfPass ? 'is-good' : 'is-warn'}`}>
              <ShieldCheck size={24} />
              <div>
                <b>{analysis ? fmt(analysis.safetyFactor, 2) : '—'}</b>
                <span>SAFETY FACTOR</span>
              </div>
            </div>
            <div className="safety-scale">
              {Array.from({ length: 14 }).map((_, index) => (
                <span
                  key={index}
                  className={
                    analysis && index < Math.min(14, Math.round((analysis.safetyFactor / 4) * 14))
                      ? index < 7
                        ? 'is-safe'
                        : 'is-high'
                      : ''
                  }
                />
              ))}
            </div>
            <div className="safety-scale__labels">
              <span>0</span>
              <span className="safety-scale__target">2.0 TARGET</span>
              <span>4.0+</span>
            </div>
          </div>

          <div className="analysis-section analysis-section--right">
            <span className="eyebrow">UTILIZATION</span>
            <div className="limit-row">
              <div><span>强度 / SF ≥ 2.0</span><b className={sfPass ? 'text-good' : 'text-bad'}>{busy ? '待本轮结果' : previousResult ? '待重新计算' : !analysis ? '未计算' : sfPass ? 'PASS' : 'REVIEW'}</b></div>
              <div className="limit-bar"><span style={{ width: `${Math.min(100, (analysis ? 2 / analysis.safetyFactor : 0) * 100)}%` }} /></div>
              <small>{analysis ? `${fmt((analysis.maxVonMises / material.yieldStrength) * 100, 1)}% 屈服利用率` : '—'}</small>
            </div>
            <div className="limit-row">
              <div><span>刚度 / δ ≤ 2.0 mm</span><b className={dispPass ? 'text-good' : 'text-bad'}>{busy ? '待本轮结果' : previousResult ? '待重新计算' : !analysis ? '未计算' : dispPass ? 'PASS' : 'REVIEW'}</b></div>
              <div className="limit-bar"><span style={{ width: `${Math.min(100, ((analysis?.maxDisplacement ?? 0) / 2) * 100)}%` }} /></div>
              <small>{analysis ? `${fmt(analysis.maxDisplacement, 3)} / 2.000 mm` : '—'}</small>
            </div>
          </div>

          <details className="analysis-section analysis-section--right"><summary>平衡校核</summary>
            <div className="analysis-section__head">
              <span className={`chip ${analysis?.equilibrium.relativeError != null && analysis.equilibrium.relativeError < 1e-4 ? 'chip--good' : 'chip--warn'}`}>
                {analysis?.equilibrium.relativeError?.toExponential(1) ?? '未验证'}
              </span>
            </div>
            <table className="mini-table">
              <thead>
                <tr><th /><th>APPLIED</th><th>REACTION</th><th>RESIDUAL</th></tr>
              </thead>
              <tbody>
                {(['x', 'y', 'z'] as const).map((axis, index) => (
                  <tr key={axis}>
                    <td>{axis.toUpperCase()}</td>
                    <td>{analysis ? fmt(analysis.equilibrium.applied[index], 2) : '—'}</td>
                    <td>{analysis ? fmt(analysis.equilibrium.reaction?.[index], 2) : '—'}</td>
                    <td>{analysis ? fmt(analysis.equilibrium.residual?.[index], 2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="solver-meta">
              <span>scikit-fem {analysis?.solver.algorithm ?? 'Direct'}</span>
              <span>P1 tetra</span>
              <span>{analysis ? `${fmt(analysis.solver.solveMs, 0)} ms` : '—'}</span>
            </div>
          </details>

          <details className="analysis-section analysis-section--right"><summary>输入与追溯</summary>

            <div className="trace-list">
              <div><span>模型指纹</span><code>{analysis?.modelHash ?? '—'}</code></div>
              <div><span>材料</span><b>{material.shortName}</b></div>
              <div><span>求解器</span><b>NVIDIA USD BRep + TetGen + scikit-fem</b></div>
              <div><span>时间</span><b>{analysis ? new Date(analysis.createdAt).toLocaleString('zh-CN') : '—'}</b></div>
            </div>
          </details>

          <div className="analysis-disclaimer">
            <Info size={14} />
            <span>
              线弹性小变形分析。STL 曲面离散、P1 四面体与理想约束限制峰值应力的绝对精度；疲劳、屈曲、接触与塑性未包含。            </span>
          </div>
        </aside>
      </div>

    </div>
  );
}

