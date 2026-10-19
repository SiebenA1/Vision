import { useState } from 'react';
import { useAppStore } from '../state/store';
import { applyStudyConfiguration } from '../core/cad/study';
import type { FaceId, Load, Support, Vec3 } from '../core/types';
import type { RegionSelection } from '../core/cad/types';
const faces: FaceId[] = ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'];
function VectorInput({ label, value, change }: { label: string; value: Vec3; change: (v: Vec3) => void }) {
  return <fieldset className="study-vector"><legend>{label}</legend>{value.map((v, axis) => <label key={axis}>{'XYZ'[axis]}<input type="number" className="input" aria-label={`${label} ${'XYZ'[axis]}`} value={v} onChange={(event) => change(value.map((item, i) => i === axis ? Number(event.target.value) : item) as Vec3)} /></label>)}</fieldset>;
}
function Selection({ item, change }: { item: Support | Load; change: (patch: { face?: FaceId; region?: RegionSelection }) => void }) {
  const region = item.region;
  const cad = useAppStore((state) => state.model.cad);
  return <>
    <label>作用区域<select className="select" value={region?.type ?? 'face'} onChange={(event) => {
      change({ region: event.target.value === 'cad-face' && cad ? { type: 'cad-face', artifactId: cad.artifactId, faceIds: [cad.bodies[0].faces[0].id], toleranceMm: Number((cad.settings.tolerance_mm * 1.5).toPrecision(8)) } : event.target.value === 'box' ? { type: 'box', min: [0, 0, 0], max: [10, 10, 10] } : event.target.value === 'sphere' ? { type: 'sphere', center: [0, 0, 0], radius: 10 } : undefined });
    }}><option value="face">包围盒极值面</option>{cad && <option value="cad-face">原生 BRep 面</option>}<option value="box">局部盒选区域</option><option value="sphere">局部球选区域</option></select></label>
    {!region && <select className="select" aria-label="极值面" value={item.face} onChange={(event) => change({ face: event.target.value as FaceId })}>{faces.map((face) => <option key={face}>{face}</option>)}</select>}
    {region?.type === 'cad-face' && <>
      <label>选择原生面（可多选）<select className="select" multiple size={5} value={region.faceIds} onChange={(event) => change({ region: { ...region, artifactId: cad?.artifactId ?? region.artifactId, faceIds: [...event.target.selectedOptions].map((option) => option.value) } })}>
        {cad?.bodies.map((body) => <optgroup key={body.id} label={body.name}>{body.faces.map((face) => <option value={face.id} key={face.id}>{face.id} · {face.area_mm2.toFixed(1)} mm²</option>)}</optgroup>)}
      </select></label>
      <label>面匹配容差 mm<input className="input" type="number" min={0.000001} step={0.01} value={region.toleranceMm} onChange={(event) => change({ region: { ...region, toleranceMm: Number(event.target.value) } })} /></label>
      {region.artifactId !== cad?.artifactId && <p role="alert">几何已变化，请重新选择面。</p>}
    </>}
    {region?.type === 'box'  && <><VectorInput label="区域下界 mm" value={region.min} change={(v) => change({ region: { ...region, min: v } })} /><VectorInput label="区域上界 mm" value={region.max} change={(v) => change({ region: { ...region, max: v } })} /></>}
    {region?.type === 'sphere' && <><VectorInput label="区域中心 mm" value={region.center} change={(v) => change({ region: { ...region, center: v } })} /><label>半径 mm<input className="input" type="number" min={0.001} value={region.radius} onChange={(event) => change({ region: { ...region, radius: Number(event.target.value) } })} /></label></>}
  </>;
}
export function StudyEditor() {
  const model = useAppStore((state) => state.model);
  const [supports, setSupports] = useState(() => structuredClone(model.supports));
  const [loads, setLoads] = useState(() => structuredClone(model.loads));
  const [bodyIds, setBodyIds] = useState(model.studyBodyIds);
  const [meshSize, setMeshSize] = useState(model.mesh.cellSizeMm ?? 1.5);
  const [message, setMessage] = useState('');
  const patchSupport = (index: number, patch: Partial<Support>) => setSupports(supports.map((item, i) => i === index ? { ...item, ...patch } : item));
  const patchLoad = (index: number, patch: Partial<Load>) => setLoads(loads.map((item, i) => i === index ? { ...item, ...patch } : item));
  return <details className="study-editor"><summary>分析实体与工况</summary>
    <p>独立零件不会自动粘接。每个不相连实体都需要充分约束。区域坐标使用 mm。</p>
    {model.cad && <fieldset><legend>参与分析的实体</legend>{model.cad.bodies.map((body) => <label key={body.id}><input type="checkbox" disabled={body.kind !== 'solid'} checked={bodyIds?.includes(body.id) ?? false} onChange={(event) => setBodyIds(event.target.checked ? [...(bodyIds ?? []), body.id] : bodyIds?.filter((id) => id !== body.id))} />{body.name}{body.kind !== 'solid' ? '（曲面体）' : ''}</label>)}</fieldset>}
    {supports.map((item, index) => <details key={item.id}><summary>{item.name || `约束 ${index + 1}`}</summary>
      <label>名称<input className="input" value={item.name} onChange={(event) => patchSupport(index, { name: event.target.value })} /></label>
      <label><input type="checkbox" checked={item.enabled} onChange={(event) => patchSupport(index, { enabled: event.target.checked })} />启用固定约束</label>
      <Selection item={item} change={(patch) => patchSupport(index, patch)} />
      <button type="button" className="button" onClick={() => setSupports(supports.filter((_, i) => i !== index))}>移除此约束</button>
    </details>)}
    <button type="button" className="button" onClick={() => setSupports([...supports, { id: crypto.randomUUID(), name: `固定约束 ${supports.length + 1}`, face: 'x-min', type: 'fixed', enabled: true }])}>添加约束</button>
    {loads.map((item, index) => <details key={item.id}><summary>{item.name || `载荷 ${index + 1}`}</summary>
      <label>名称<input className="input" value={item.name} onChange={(event) => patchLoad(index, { name: event.target.value })} /></label>
      <label><input type="checkbox" checked={item.enabled} onChange={(event) => patchLoad(index, { enabled: event.target.checked })} />启用载荷</label>
      <label>合力 N<input className="input" type="number" min={0.001} value={item.magnitude} onChange={(event) => patchLoad(index, { magnitude: Number(event.target.value) })} /></label>
      <VectorInput label="载荷方向" value={item.vector} change={(v) => patchLoad(index, { vector: v })} />
      <Selection item={item} change={(patch) => patchLoad(index, patch)} />
      <button type="button" className="button" onClick={() => setLoads(loads.filter((_, i) => i !== index))}>移除此载荷</button>
    </details>)}
    <button type="button" className="button" onClick={() => setLoads([...loads, { id: crypto.randomUUID(), name: `载荷 ${loads.length + 1}`, face: 'x-max', vector: [0, 0, -1], magnitude: 100, enabled: true }])}>添加载荷</button>
    <label>请求网格尺寸 mm<input className="input" type="number" min={0.001} value={meshSize} onChange={(event) => setMeshSize(Number(event.target.value))} /></label>
    <button type="button" className="button button--primary" onClick={() => {
      try { applyStudyConfiguration({ supports, loads, bodyIds, meshSize }); setMessage('工况已保存，重新求解后生效。'); }
      catch (error) { setMessage(String(error)); }
    }}>保存工况</button><p role="status">{message}</p>
  </details>;
}
