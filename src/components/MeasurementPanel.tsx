import { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import { inspectionContext, useInspectionStore } from '../state/inspectionStore';
import { getMaterial } from '../core/materials';
import { measurementNumber } from '../core/cad/measurementLabels';
import { SelectionInsight } from './SelectionInsight';

export function MeasurementPanel() {
  const model = useAppStore(state => state.model);
  const { mode, selection, result, busy, error, accuracy, section, pick, context, smart, setEnabled, measure } = useInspectionStore();
  const [catalog, setCatalog] = useState<NonNullable<typeof result>['catalog']>([]);
  const [filter, setFilter] = useState('');
  const [planePoint, setPlanePoint] = useState('0, 0, 0');
  const [planeNormal, setPlaneNormal] = useState('0, 0, 1');
  const [planeError, setPlaneError] = useState('');
  const key = `${model.id}:${model.cad?.artifactId ?? ''}:${model.materialId}`;
  useEffect(() => {
    setCatalog([]);
    setFilter('');
  }, [key]);
  useEffect(() => { if (result && context === inspectionContext()) setCatalog(result.catalog); }, [result, context]);
  if (!model.cad) return <section className="measurement-panel"><h3>测量与物理属性</h3><p>需要原生 B-Rep 几何。导入 USD / 工程包或重建后可查看体、面、边、点属性。</p></section>;
  const visibleResult = context === key ? result : null;
  const objects = catalog.filter(item => item.kind === mode && `${item.id} ${item.label}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="measurement-panel" aria-label="测量与物理属性">
    <details className="measurement-browser"><summary>对象列表与筛选</summary>
    <label>查找对象<input className="input" value={filter} onChange={e => setFilter(e.target.value)} placeholder="部件名称或拓扑编号" /></label>
    <label>原生对象（Ctrl / ⌘ 或 Shift 多选）
      <select className="select measurement-objects" multiple size={5} value={selection} onChange={e => {
        setEnabled(true);
        void measure([...e.target.selectedOptions].map(option => option.value));
      }}>
        {objects.map(item => <option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}
      </select>
    </label>
    </details>
    <div className="measurement-selection" aria-live="polite">{selection.length ? `已选 ${selection.length} 个对象：${selection.join('、')}` : '整个模型'}</div>
    <SelectionInsight />
    <details><summary>计算精度</summary><label>积分相对精度<select className="select" value={accuracy} onChange={e => void measure(selection, pick, Number(e.target.value), section)}>
      <option value={.0001}>0.0001（内核下限）</option><option value={.001}>0.001</option><option value={.01}>0.01</option>
    </select></label></details>
    <details className="measurement-section"><summary>截面与局部质量</summary>
      <p>选择整个模型或实体。平面由一个点和法向定义，计算法向正侧的保留区域。</p>
      <label>平面点 XYZ（mm）<input className="input" value={planePoint} onChange={e => setPlanePoint(e.target.value)} /></label>
      <label>平面法向 XYZ<input className="input" value={planeNormal} onChange={e => setPlaneNormal(e.target.value)} /></label>
      <button type="button" className="button" disabled={busy} onClick={() => {
        const parse = (s: string) => s.trim().split(/[,，\s]+/).map(Number);
        const point = parse(planePoint), normal = parse(planeNormal);
        if (point.length !== 3 || normal.length !== 3 || ![...point, ...normal].every(Number.isFinite) || Math.hypot(...normal) < 1e-12) {
          setPlaneError('请填写三个有限坐标和非零法向，例如 0, 0, 1'); return;
        }
        setPlaneError(''); setEnabled(true);
        void measure(selection, undefined, accuracy, { point: point as [number, number, number], normal: normal as [number, number, number] });
      }}>计算截面与保留区域</button>
      {planeError && <p role="alert">{planeError}</p>}
    </details>
    <p>材料：{getMaterial(model.materialId).name} · 均匀密度 {getMaterial(model.materialId).rho} kg/m³</p>
    {busy && <p role="status">正在查询原生几何…</p>}
    {error && <div className="inline-alert inline-alert--error" role="alert">{error}<button type="button" className="button" onClick={() => void measure(selection, pick, accuracy, section)}>重试</button></div>}
    {visibleResult && <>
      <details className="measurement-raw" open={!smart || !selection.length || !!section}><summary>原生基础测量</summary>
      <dl className="measurement-properties">{visibleResult.properties.map((property, i) => <div key={`${property.label}-${i}`}>
        <dt>{property.label}</dt><dd>{Array.isArray(property.value) ? property.value.map(value => measurementNumber(value)).join(' / ') : typeof property.value === 'number' ? measurementNumber(property.value) : property.value}{property.unit && <span> {property.unit}</span>}</dd>
      </div>)}</dl>
      </details>
      <p className="measurement-source">{visibleResult.source}<br />相对积分精度：{visibleResult.relativeAccuracy}；显示离散公差：{model.cad.settings.tolerance_mm} mm。显示位数不代表测量精度。</p>
      {visibleResult.notes.map(note => <p className="measurement-note" key={note}>{note}</p>)}
    </>}
  </section>;
}
