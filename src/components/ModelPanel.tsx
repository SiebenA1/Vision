import { useEffect, useState, type CSSProperties } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  ChevronRight,
  Circle,
  CircleDot,
  CircleSlash2,
  Cuboid,
  History,
  Info,
  Layers3,
  Minus,
  Plus,
  RotateCcw,
  Square,
  Undo2,
  Redo2,
} from 'lucide-react';
import type { FeatureDescriptor } from '../core/types';
import { MATERIALS, materialOptionsByFamily } from '../core/materials';
import { useAppStore } from '../state/store';
import { fmt } from '../lib/format';

function VariableRow({ variableKey }: { variableKey: string }) {
  const model = useAppStore((state) => state.model);
  const selectedVariableKey = useAppStore((state) => state.selectedVariableKey);
  const selectVariable = useAppStore((state) => state.selectVariable);
  const setVariable = useAppStore((state) => state.setVariable);
  const variable = model.variables.find((item) => item.key === variableKey);
  const [draft, setDraft] = useState(variable ? String(variable.value) : '');
  useEffect(() => {
    if (variable) setDraft(String(variable.value));
  }, [variable?.value, variable]);
  if (!variable) return null;
  const percent = ((variable.value - variable.min) / (variable.max - variable.min)) * 100;
  const selected = selectedVariableKey === variable.key;
  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) setVariable(variable.key, parsed, variable.label);
    else setDraft(String(variable.value));
  };
  return (
    <div className={`variable-row ${selected ? 'is-selected' : ''}`} onFocus={() => selectVariable(variable.key)}>
      <div className="variable-row__head">
        <div className="variable-row__label">
          <span>{variable.label}</span>
          <small>{variable.labelEn}</small>
        </div>
        <label className="variable-row__input">
          <input
            type="number"
            value={draft}
            step={variable.step}
            min={variable.min}
            max={variable.max}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit();
                (event.target as HTMLInputElement).blur();
              }
            }}
            aria-label={variable.label}
          />
          <span>{variable.unit}</span>
        </label>
      </div>
      <div className="variable-row__track">
        <input
          type="range"
          min={variable.min}
          max={variable.max}
          step={variable.step}
          value={variable.value}
          style={{ '--pct': `${percent}%` } as CSSProperties}
          onChange={(event) => setVariable(variable.key, Number(event.target.value), variable.label, false)}
          aria-label={`${variable.label} 滑杆`}
        />
        <div className="variable-row__limits">
          <span>{variable.min}</span>
          <span>{variable.max}</span>
        </div>
      </div>
    </div>
  );
}

function featureIcon(feature: FeatureDescriptor) {
  if (feature.operation === 'subtract') return <Minus size={12} />;
  if (feature.kind === 'pattern') return <Layers3 size={12} />;
  if (feature.kind === 'boss') return <CircleDot size={12} />;
  return <Plus size={12} />;
}

function BlankStarter() {
  const addStarter = useAppStore((state) => state.initializeStarter);
  const starters = [
    {
      id: 'plate' as const,
      label: '基础板',
      en: 'PLATE',
      description: '矩形板 · 120 × 80 × 10 mm',
      icon: Square,
    },
    {
      id: 'block' as const,
      label: '基础块',
      en: 'BLOCK',
      description: '实体块 · 100 × 80 × 60 mm',
      icon: Box,
    },
    {
      id: 'cylinder' as const,
      label: '圆柱体',
      en: 'CYLINDER',
      description: '圆柱 · Ø60 × 100 mm',
      icon: Circle,
    },
  ];
  return (
    <div className="blank-starter">
      <div className="blank-starter__head">
        <span className="eyebrow">BLANK PROJECT</span>
        <h3>从基础体开始</h3>
        <p>
          当前项目没有几何。选择一个参数化基础体，创建后可在下方继续编辑尺寸、材料和边界条件。
        </p>
      </div>
      <div className="blank-starter__grid">
        {starters.map((starter) => {
          const Icon = starter.icon;
          return (
            <button key={starter.id} type="button" onClick={() => addStarter(starter.id)}>
              <span className="blank-starter__icon"><Icon size={18} /></span>
              <span>
                <b>{starter.label}</b>
                <small>{starter.en}</small>
              </span>
              <em>{starter.description}</em>
              <ChevronRight size={13} />
            </button>
          );
        })}
      </div>
      <div className="blank-starter__note">
        <Info size={13} />
        <span>
          空白工程会保留材料、单位和工程元数据，但不会提交任何几何或求解结果。当前版本尚未提供自由草图器，基础体是起点。
        </span>
      </div>
    </div>
  );
}

function FeatureTree() {
  const model = useAppStore((state) => state.model);
  const selectedFeatureId = useAppStore((state) => state.selectedFeatureId);
  const selectFeature = useAppStore((state) => state.selectFeature);
  const selected = model.features.find((feature) => feature.id === selectedFeatureId) ?? model.features[0];
  return (
    <>
      <div className="panel-section">
        <div className="panel-section__head">
          <span>特征图 / FEATURE GRAPH</span>
          <span className="chip chip--tiny">{model.features.length} FEAT</span>
        </div>
        <div className="feature-tree">
          {model.features.map((feature) => (
            <button
              key={feature.id}
              type="button"
              className={`feature-row ${feature.id === selectedFeatureId ? 'is-selected' : ''}`}
              onClick={() => selectFeature(feature.id)}
            >
              <span className="feature-row__index">{feature.index}</span>
              <span className={`feature-row__icon feature-row__icon--${feature.operation}`}>{featureIcon(feature)}</span>
              <span className="feature-row__body">
                <span className="feature-row__name">{feature.name}</span>
                <span className="feature-row__en">{feature.nameEn}</span>
              </span>
              <ChevronRight size={13} className="feature-row__chevron" />
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div className="selected-feature">
          <div className="selected-feature__head">
            <div>
              <span className="eyebrow">SELECTED FEATURE</span>
              <h3>
                {selected.index} · {selected.name}
              </h3>
            </div>
            <span className={`op-badge op-badge--${selected.operation}`}>
              {selected.operation === 'add' ? 'UNION' : 'SUBTRACT'}
            </span>
          </div>
          <p>{selected.description}</p>
          <div className="selected-feature__vars">
            {selected.variableKeys.map((key) => {
              const variable = model.variables.find((item) => item.key === key);
              if (!variable) return null;
              return (
                <button key={key} type="button" onClick={() => useAppStore.getState().selectVariable(key)}>
                  {variable.label}
                  <b>{variable.value}</b>
                  <small>{variable.unit}</small>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="panel-section panel-section--variables">
        <div className="panel-section__head">
          <span>设计变量 / PARAMETERS</span>
          <span className="panel-section__hint">实时重建</span>
        </div>
        <div className="variable-list">
          {model.variables
            .filter((variable) => variable.role === 'primary')
            .map((variable) => (
              <VariableRow key={variable.key} variableKey={variable.key} />
            ))}
        </div>
      </div>
    </>
  );
}

function MaterialPanel() {
  const model = useAppStore((state) => state.model);
  const setMaterial = useAppStore((state) => state.setMaterial);
  const materials = MATERIALS;
  const groups = materialOptionsByFamily();
  return (
    <div className="materials-panel">
      <div className="panel-intro">
        <span className="eyebrow">ISOTROPIC · ROOM TEMP</span>
        <h3>工程材料库</h3>
        <p>线性静力分析使用名义各向同性参数。材料切换立即更新质量与结果有效性标记。</p>
      </div>
      {groups.map((group) => (
        <div key={group.family} className="material-group">
          <div className="panel-section__head">
            <span>{group.label}</span>
            <span className="panel-section__hint">{group.items.length}</span>
          </div>
          {group.items.map((materialItem) => (
            <button
              key={materialItem.id}
              type="button"
              className={`material-card ${model.materialId === materialItem.id ? 'is-selected' : ''}`}
              onClick={() => setMaterial(materialItem.id)}
            >
              <span className="material-card__swatch" style={{ background: materialItem.color }} />
              <span className="material-card__body">
                <span className="material-card__name">
                  {materialItem.name}
                  {!materialItem.validated && <span className="chip chip--warn">EQUIV</span>}
                </span>
                <span className="material-card__meta">
                  E {fmt(materialItem.E / 1000, 1)} GPa · σy {materialItem.yieldStrength} MPa · ρ{' '}
                  {materialItem.rho}
                </span>
              </span>
              <span className="material-card__radio" />
            </button>
          ))}
        </div>
      ))}
      <div className="panel-note">
        <Info size={14} />
        <span>材料数据用于初步选型，不构成材料认证或许用值批准。</span>
      </div>
      <div className="material-count">{materials.length} MATERIALS · TRACEABLE</div>
    </div>
  );
}

function HistoryPanel() {
  const history = useAppStore((state) => state.history);
  const future = useAppStore((state) => state.future);
  const undo = useAppStore((state) => state.undo);
  const redo = useAppStore((state) => state.redo);
  return (
    <div className="history-panel">
      <div className="panel-intro">
        <span className="eyebrow">DETERMINISTIC REBUILD</span>
        <h3>特征历史</h3>
        <p>每次参数编辑记录为可撤销快照。分析结果通过模型指纹与几何版本绑定。</p>
      </div>
      <div className="history-actions">
        <button type="button" className="button" onClick={undo} disabled={history.length === 0}>
          <Undo2 size={14} /> 撤销
        </button>
        <button type="button" className="button" onClick={redo} disabled={future.length === 0}>
          <Redo2 size={14} /> 重做
        </button>
      </div>
      <div className="timeline">
        <div className="timeline-item is-current">
          <span className="timeline-item__dot" />
          <div>
            <b>当前工作状态</b>
            <small>PARAMETRIC HEAD · LIVE</small>
          </div>
        </div>
        {[...history].reverse().map((entry, index) => (
          <div key={`${entry.label}-${index}`} className="timeline-item">
            <span className="timeline-item__dot" />
            <div>
              <b>{entry.label}</b>
              <small>SNAPSHOT {String(history.length - index).padStart(2, '0')}</small>
            </div>
          </div>
        ))}
        {history.length === 0 && (
          <div className="empty-state">
            <History size={24} />
            <span>编辑参数后，历史快照会显示在这里。</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ModelPanel() {
  const rail = useAppStore((state) => state.rail);
  const geometry = useAppStore((state) => state.geometry);
  const metrics = useAppStore((state) => state.geometryMetrics);
  const building = useAppStore((state) => state.building);
  const error = useAppStore((state) => state.geometryError);
  const model = useAppStore((state) => state.model);
  const material = MATERIALS.find((item) => item.id === model.materialId) ?? MATERIALS[0];
  const toggleLeft = useAppStore((state) => state.toggleLeft);
  const blank = (model.template ?? 'bracket') === 'empty' || model.features.length === 0;

  return (
    <aside className="model-panel">
      <div className="model-panel__head">
        <div>
          <span className="eyebrow">
            {rail === 'materials' ? 'MATERIALS' : rail === 'history' ? 'HISTORY' : 'MODEL GRAPH'}
          </span>
          <h2>
            {rail === 'materials' ? '材料' : rail === 'history' ? '版本' : blank ? '空白工程' : '参数化支架'}
          </h2>
        </div>
        <div className="model-panel__head-right">
          <span className={`build-state ${building ? 'is-building' : error ? 'is-error' : ''}`}>
            <span /> {building ? 'REBUILD' : error ? 'ERROR' : 'SYNCED'}
          </span>
          <button type="button" className="icon-button icon-button--small" onClick={toggleLeft} title="收起面板">
            <ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
        </div>
      </div>

      <div className="model-panel__scroll">
        {error && (
          <div className="inline-alert inline-alert--error">
            <CircleSlash2 size={15} />
            <div>
              <b>几何重建失败</b>
              <span>{error}</span>
            </div>
          </div>
        )}
        {rail === 'materials' ? (
          <MaterialPanel />
        ) : rail === 'history' ? (
          <HistoryPanel />
        ) : (
          <>
            <div className="design-intent">
              <span className="design-intent__label">DESIGN INTENT</span>
              <p>{model.meta.designIntent}</p>
              <div className="design-intent__meta">
                <span>{model.meta.client}</span>
                <span>{model.meta.discipline}</span>
              </div>
            </div>
            {blank ? <BlankStarter /> : <FeatureTree />}
            {!blank && (
              <div className="geometry-readout">
                <div className="panel-section__head">
                  <span>几何健康 / GEOMETRY</span>
                  <span className="chip chip--good">{geometry ? 'WATERTIGHT' : 'WAITING'}</span>
                </div>
                <div className="readout-grid">
                  <div>
                    <span>体积</span>
                    <b>{metrics ? fmt(metrics.volumeCm3, 1) : '—'}</b>
                    <small>cm³</small>
                  </div>
                  <div>
                    <span>质量</span>
                    <b>{metrics ? fmt(metrics.massKg, 3) : '—'}</b>
                    <small>kg</small>
                  </div>
                  <div>
                    <span>表面</span>
                    <b>{metrics ? fmt(metrics.surfaceCm2, 0) : '—'}</b>
                    <small>cm²</small>
                  </div>
                  <div>
                    <span>面片</span>
                    <b>{metrics ? metrics.triangleCount.toLocaleString('en-US') : '—'}</b>
                    <small>tri</small>
                  </div>
                </div>
                <div className="hash-row">
                  <span>HASH</span>
                  <code>{metrics?.watermark ?? '—'}</code>
                  <span className="hash-row__time">{metrics ? `${metrics.buildMs.toFixed(0)} ms` : ''}</span>
                </div>
              </div>
            )}
            <div className="material-strip">
              <span className="material-strip__swatch" style={{ background: material.color }} />
              <div>
                <span className="eyebrow">MATERIAL</span>
                <b>{material.shortName}</b>
              </div>
              <div className="material-strip__props">
                <span>E {fmt(material.E / 1000, 0)} GPa</span>
                <span>σy {material.yieldStrength} MPa</span>
                <span>ρ {material.rho}</span>
              </div>
              <button type="button" onClick={() => useAppStore.getState().setRail('materials')}>
                <ChevronRight size={14} />
              </button>
            </div>
            <div className="panel-footnote">
              <Cuboid size={13} />
              <span>Manifold kernel · exact planar / quadric profiles · robust booleans</span>
            </div>
          </>
        )}
      </div>
      <div className="model-panel__footer">
        <span>
          <ArrowDownToLine size={12} /> mm
        </span>
        <span>
          <ArrowUpFromLine size={12} /> N
        </span>
        <span>
          <RotateCcw size={12} /> MPa
        </span>
        <span className="model-panel__footer-right">{model.revision}</span>
      </div>
    </aside>
  );
}
