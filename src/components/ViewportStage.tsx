import { AlertTriangle } from 'lucide-react';
import { SceneViewport } from './SceneViewport';
import { ResultStrip } from './ResultStrip';
import { useAppStore } from '../state/store';
import { getMaterial } from '../core/materials';
import { fieldMeta, rampCss } from '../core/fea/fieldProjection';
import { fmt } from '../lib/format';

interface ViewportStageProps {
  onRun: () => void;
}

export function ViewportStage({ onRun }: ViewportStageProps) {
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
          analysis={resultStale ? null : analysis}
          viewMode={viewMode}
          field={field}
          deformationScale={deformationScale}
          showEdges={showEdges}
          showAnnotations={showAnnotations}
          onToggleEdges={toggleEdges}
          onToggleAnnotations={toggleAnnotations}
        />

        {viewMode === 'result' && analysis && !resultStale && meta && (
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
              {resultStale ? '结果对应旧几何或工况 · 请重新求解' : 'TetGen 四面体 · scikit-fem 节点插值'}
            </div>
          </div>
        )}

        {building && (
          <div className="rebuild-toast">
            <span className="rebuild-toast__spinner" />
            <div>
              <b>正在更新几何</b>
              <span>请稍候…</span>
            </div>
          </div>
        )}

        {!geometry && !building && !error && (
          <div className={`stage-empty ${blank ? 'stage-empty--blank' : ''}`}>
            <div className="stage-empty__mark">V</div>
            <b>{blank ? '开始你的设计' : '几何体未载入'}</b>
            <span>
              {blank
                ? '在右侧描述零件和尺寸，即可开始建模。'
                : '运行重建以初始化参数化特征图。'}
            </span>
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
      <ResultStrip onRun={onRun} />
    </main>
  );
}
