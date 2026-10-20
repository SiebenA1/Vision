import type { CadInspection } from '../services/engineeringBackend';
import type { MaterialSpec } from '../core/materials';
import { measurementValue } from '../core/cad/measurementLabels';
import { SelectionInsight } from './SelectionInsight';
import { useState } from 'react';
import { useInspectionStore, inspectionContext } from '../state/inspectionStore';

export function MeasurementHud({ result, busy, error, material, onRetry }: {
  result: CadInspection | null; busy: boolean; error: string; material: MaterialSpec; onRetry: () => void;
}) {
  const state = useInspectionStore();
  const selected = state.context === inspectionContext() && state.selection.length > 0 && !state.section;
  const selectionKey = selected ? `${state.context}:${state.selection.join(',')}` : '';
  const kinds = [...new Set(state.result?.selection.map(id => state.result?.catalog.find(item => item.id === id)?.kind) ?? [])];
  const bodiesOnly = selected && kinds.length === 1 && kinds[0] === 'body';
  const [tab, setTab] = useState<{ selection: string; value: 'geometry' | 'physical' } | null>(null);
  const showSelected = selected && (tab?.selection === selectionKey ? tab.value === 'geometry' : !bodiesOnly);
  const properties = result?.properties.filter(property => bodiesOnly
    ? property.label !== '测量范围' && !/^包围尺寸 [XYZ]$/.test(property.label)
    : !property.anchor && !property.panelOnly) ?? [];
  const essential = properties.filter(property => !property.label.includes('惯性'));
  if (bodiesOnly) {
    const order = ['对象类型', '实体体积', '质量', '表面积', '轴对齐包围尺寸 XYZ', '质量中心 XYZ', '部件数'];
    essential.sort((a, b) => (order.indexOf(a.label) < 0 ? order.length : order.indexOf(a.label)) - (order.indexOf(b.label) < 0 ? order.length : order.indexOf(b.label)));
  }
  const advanced = properties.filter(property => property.label.includes('惯性'));
  const kindNames = { body: '体', face: '面', edge: '边', vertex: '顶点' };
  const physicalScope = result?.properties.find(property => property.label === '测量范围')?.value
    ?? (result?.selection.length ? '所选体' : '整个模型');
  return <aside className="measurement-hud" aria-label="模型属性 HUD">
    <details open>
      <summary><span className="measurement-hud__light" />模型数据 <span className="measurement-hud__code">MODEL DATA</span></summary>
      <div className="measurement-hud__body">
        {selected && <div className="measurement-hud__tabs" role="tablist" aria-label="数据显示范围">
          <button role="tab" aria-selected={showSelected} onClick={() => setTab({ selection: selectionKey, value: 'geometry' })}>所选几何</button>
          <button role="tab" aria-selected={!showSelected} onClick={() => setTab({ selection: selectionKey, value: 'physical' })}>{result?.selection.length ? '所选体参数' : '整体物性'}</button>
        </div>}
        {showSelected ? <>
          <p className="measurement-hud__scope">测量范围：所选 {state.selection.length} 个对象<br />对象类型：{kinds.map(kind => kind ? kindNames[kind] : '读取中').join('、')}</p>
          {state.smart ? <SelectionInsight compact /> : <dl>{state.result?.properties.filter(property => !['对象类型', '测量范围'].includes(property.label)).map((property, i) => <div key={i}><dt>{property.label}</dt><dd>{measurementValue(property, true)}</dd></div>)}</dl>}
          <footer>类型来自原生拓扑 · 识别名称为智能解读<br />面与边不单独计算实体质量</footer>
        </> : <>
        <p className="measurement-hud__scope">物性范围：{String(physicalScope)} · 按均匀材料计算</p>
        <div className="measurement-hud__material">{material.name}<span>ρ {material.rho} kg/m³ · 均匀材料</span></div>
        {busy && <p role="status">正在更新测量…</p>}
        {error && <div className="measurement-hud__error" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>重新查询</button></div>}
        {result && <>
          <dl>{essential.map((property, i) => <div key={`${property.label}-${i}`}><dt>{property.label}</dt><dd>{measurementValue(property)}</dd></div>)}</dl>
          {advanced.length > 0 && <details><summary>惯性参数</summary><dl>{advanced.map(property => <div key={property.label}><dt>{property.label}</dt><dd>{measurementValue(property)}</dd></div>)}</dl></details>}
          <footer>原生几何 · ε {result.relativeAccuracy}<br />几何参数见模型标注 · 物性按上述对象范围</footer>
        </>}
        </>}
      </div>
    </details>
  </aside>;
}
