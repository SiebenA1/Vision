import { AlertTriangle, Check, Crosshair, Move3d, Sparkles } from 'lucide-react';
import { SceneViewport } from './SceneViewport';
import { ResultStrip } from './ResultStrip';
import { useAppStore } from '../state/store';
import { getMaterial } from '../core/materials';
import { fieldMeta, rampCss } from '../core/fea/fieldProjection';
import { fmt, vectorLabel } from '../lib/format';

interface ViewportStageProps {
  onRun: () => void;
  onOpenAnalysis: () => void;
}

export function ViewportStage({ onRun, onOpenAnalysis }: ViewportStageProps) {
  const geometry = useAppStore((state) => state.geometry);
  const building = useAppStore((state) => state.building);
  const error = useAppStore((state) => state.geometryError);
  const model = useAppStore((state) => state.model);
  const analysis = useAppStore((state) => state.analysis);
  const material = getMaterial(model.materialId);
  const viewMode = useAppStore((state) => state.viewMode);
  const field = useAppStore((state) => state.field);
  const deformationScale = useAppStore((state) => state.deformationScale);
  const showEdges = useAppStore((state) => state.showEdges);
  const showAnnotations = useAppStore((state) => state.showAnnotations);
  const toggleEdges = useAppStore((state) => state.toggleEdges);
  const toggleAnnotations = useAppStore((state) => state.toggleAnnotations);
  const resultStale = useAppStore((state) => state.resultStale);
  const initializeStarter = useAppStore((state) => state.initializeStarter);
  const blank = (model.template ?? 'bracket') === 'empty';
  const meta = analysis ? fieldMeta(field, material.yieldStrength) : null;
  const fieldMin = field === 'safety' ? analysis?.safetyFactor ?? 0 : 0;
  const fieldMax =
    field === 'displacement'
      ? analysis?.maxDisplacement ?? 0
      : field === 'safety'
        ? Math.max(4, (analysis?.safetyFactor ?? 0) * 1.7)
        : analysis?.maxVonMises ?? 0;

  return (
    <main className="stage">
      <div className="stage-canvas">
        <SceneViewport
          geometry={geometry}
          model={model}
          material={material}
          analysis={analysis}
          viewMode={viewMode}
          field={field}
          deformationScale={deformationScale}
          showEdges={showEdges}
          showAnnotations={showAnnotations}
          onToggleEdges={toggleEdges}
          onToggleAnnotations={toggleAnnotations}
        />

        <div className="stage-overlay stage-overlay--top-left">
          <div className="stage-title">
            <span className="eyebrow">{model.code} / STRUCTURAL STATIC</span>
            <h1>{model.name}</h1>
            <div className="stage-title__meta">
              <span>{model.materialId}</span>
              <span>
                {model.loads[0]?.magnitude} N · {vectorLabel(model.loads[0]?.vector ?? [0, 0, -1])}
              </span>
              <span>{model.revision}</span>
            </div>
          </div>
        </div>

        <div className="stage-overlay stage-overlay--top-right">
          <div className={`calc-badge ${analysis && !resultStale ? 'calc-badge--ready' : ''}`}>
            <span className="calc-badge__icon">
              {analysis && !resultStale ? <Check size={13} /> : <Sparkles size={13} />}
            </span>
            <div>
              <b>
                {analysis && !resultStale
                  ? `SF ${fmt(analysis.safetyFactor, 2)}`
                  : blank
                    ? 'BLANK PROJECT'
                    : 'SOLVER READY'}
              </b>
              <small>
                {analysis && !resultStale
                  ? 'LINEAR STATIC · CONVERGED'
                  : blank
                    ? 'ADD A BASE SOLID'
                    : 'C3D8 · PCG / JACOBI'}
              </small>
            </div>
          </div>
          <div className="dimension-chip">
            <Crosshair size={13} />
            <span>
              {geometry
                ? `${fmt(geometry.bbox.max[0] - geometry.bbox.min[0], 0)} × ${fmt(
                    geometry.bbox.max[1] - geometry.bbox.min[1],
                    0,
                  )} × ${fmt(geometry.bbox.max[2] - geometry.bbox.min[2], 0)} mm`
                : '— × — × — mm'}
            </span>
          </div>
        </div>

        <div className="stage-overlay stage-overlay--bottom-left">
          <div className="scene-legend">
            <div className="scene-legend__row">
              <span className="scene-legend__key scene-legend__key--fixed" /> FIXED
              <span className="scene-legend__key scene-legend__key--load" /> LOAD
              <span className="scene-legend__key scene-legend__key--hot" /> CRITICAL
            </div>
            <div className="scene-legend__meta">
              <span className="mono">{geometry ? 'WATERTIGHT' : 'NO GEOMETRY'}</span>
              <span>{analysis ? `h ${fmt(analysis.mesh.cellSize, 2)} mm` : geometry ? 'MESH PENDING' : 'AWAITING SOLID'}</span>
              <span>{analysis ? `${analysis.mesh.elements.toLocaleString('en-US')} EL` : geometry ? 'MESH PENDING' : '—'}</span>
            </div>
          </div>
          <div className="axis-hint">
            <Move3d size={13} />
            <span>Z-UP · mm</span>
          </div>
        </div>

        {viewMode === 'result' && analysis && meta && (
          <div className="field-legend">
            <div className="field-legend__head">
              <div>
                <span className="eyebrow">RESULT FIELD · NODAL PROJECTION</span>
                <b>{meta.label}</b>
              </div>
              <div className="field-legend__mode">
                <span>{field === 'vonMises' ? 'σvM' : field === 'displacement' ? '|u|' : 'SF'}</span>
                <small>×{deformationScale} 变形显示</small>
              </div>
            </div>
            <div className="field-legend__ramp">
              {Array.from({ length: 24 }).map((_, index) => (
                <span
                  key={index}
                  style={{
                    background: rampCss(field === 'safety' ? 1 - index / 23 : index / 23),
                  }}
                />
              ))}
            </div>
            <div className="field-legend__scale">
              <span>
                {fmt(fieldMin, meta.decimals)} {meta.unit.split(' ')[0]}
              </span>
              <span>
                {fmt(fieldMax, meta.decimals)} {meta.unit.split(' ')[0]}
              </span>
            </div>
            <div className="field-legend__note">
              {resultStale ? '结果对应旧几何版本 · 请重新求解' : '最近节点插值 · 体素 C3D8 结果'}
            </div>
          </div>
        )}

        {building && (
          <div className="rebuild-toast">
            <span className="rebuild-toast__spinner" />
            <div>
              <b>REBUILDING GEOMETRY</b>
              <span>Manifold boolean solve · watertight check</span>
            </div>
          </div>
        )}

        {!geometry && !building && !error && (
          <div className={`stage-empty ${blank ? 'stage-empty--blank' : ''}`}>
            <div className="stage-empty__mark">V</div>
            <b>{blank ? '空白工程' : '几何体未载入'}</b>
            <span>
              {blank
                ? '选择一个参数化基础体，开始第一次工程建模。'
                : '运行重建以初始化参数化特征图。'}
            </span>
            {blank && (
              <div className="stage-empty__starters">
                <button type="button" onClick={() => initializeStarter('plate')}>基础板</button>
                <button type="button" onClick={() => initializeStarter('block')}>基础块</button>
                <button type="button" onClick={() => initializeStarter('cylinder')}>圆柱体</button>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="stage-error">
            <AlertTriangle size={18} />
            <div>
              <b>几何重建失败</b>
              <span>{error}</span>
            </div>
          </div>
        )}
      </div>
      <ResultStrip onRun={onRun} onOpenAnalysis={onOpenAnalysis} />
    </main>
  );
}
