import type { CoreRevision, CoreStudy } from './api';

const faces = ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'];
const materialFields = { E: '弹性模量 / MPa', nu: '泊松比', rho: '密度 / kg/m³', yieldStrength: '屈服强度 / MPa' };
type Boundary = CoreStudy['supports'][number] | CoreStudy['loads'][number];

/** One draft: form edits preserve all unknown-to-this-editor region metadata. */
export function StudyForm({ text, document, change }: { text: string; document: CoreRevision['document']; change: (text: string) => void }) {
  let study: CoreStudy;
  try {
    study = JSON.parse(text);
    if (!study || !study.material || !Object.keys(materialFields).every(key => typeof study.material[key as keyof typeof materialFields] === 'number') ||
      !Array.isArray(study.supports) || !Array.isArray(study.loads) || !study.supports.every(item => item && typeof item.id === 'string') ||
      !study.loads.every(item => item && typeof item.id === 'string' && Array.isArray(item.vector) && item.vector.length === 3)) throw new Error('incomplete');
  } catch { return <p>填写或载入工况草稿后可用表单编辑；不完整的 JSON 请先在下方修正。</p>; }
  const save = (next: CoreStudy) => change(JSON.stringify(next, null, 2));
  const regionEditor = (item: Boundary, patch: (value: Partial<CoreStudy['supports'][number]>) => void, label: string) => {
    const current = item.region?.type === 'semantic-object' ? `object:${item.region.object_id}` : item.region ? 'precise' : item.face ?? 'x-min';
    return <label>{label}作用区域<select aria-label={`${label}作用区域`} value={current} onChange={event => {
      const value = event.target.value;
      if (value === 'precise') return;
      patch(value.startsWith('object:') ? { region: { type: 'semantic-object', object_id: value.slice(7), toleranceMm: .1 } } : { region: undefined, face: value });
    }}>
      {faces.map(face => <option key={face} value={face}>{face} 外边界</option>)}
      {item.region && item.region.type !== 'semantic-object' && <option value="precise">保留当前精确区域（JSON 编辑）</option>}
      {(document.objects ?? []).map(object => <option key={object.id} value={`object:${object.id}`} disabled={object.binding.artifact_id !== document.geometry}>{object.name}{object.binding.artifact_id !== document.geometry ? ' · 需重绑定' : ''}</option>)}
      {item.region?.type === 'semantic-object' && !document.objects?.some(object => object.id === current.slice(7)) && <option value={current}>当前对象已不可用，需重新选择</option>}
    </select></label>;
  };
  return <div className="core-study-form" aria-label="工况表单">
    <fieldset><legend>材料参数</legend>{Object.entries(materialFields).map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" step="any" value={study.material[key as keyof typeof materialFields]}
      onChange={event => save({ ...study, material: { ...study.material, [key]: Number(event.target.value) } })} /></label>)}</fieldset>
    {study.supports.map((item, index) => {
      const label = `约束 ${index + 1}`;
      const patch = (value: Partial<typeof item>) => save({ ...study, supports: study.supports.map((source, i) => i === index ? { ...source, ...value } : source) });
      return <fieldset key={item.id}><legend>{label} · 固定约束</legend>
        <label>名称<input aria-label={`${label}名称`} value={item.name ?? ''} onChange={event => patch({ name: event.target.value })} /></label>
        <label><input type="checkbox" aria-label={`${label}启用`} checked={item.enabled !== false} onChange={event => patch({ enabled: event.target.checked })} />启用</label>
        {regionEditor(item, patch, label)}
        <button disabled={study.supports.length <= 1} onClick={() => save({ ...study, supports: study.supports.filter((_, i) => i !== index) })}>移除{label}</button>
      </fieldset>;
    })}
    <button disabled={study.supports.length >= 64} onClick={() => save({ ...study, supports: [...study.supports, { id: crypto.randomUUID(), face: 'x-min', type: 'fixed', enabled: true }] })}>添加固定约束</button>
    {study.loads.map((item, index) => {
      const label = `载荷 ${index + 1}`;
      const patch = (value: Partial<typeof item>) => save({ ...study, loads: study.loads.map((source, i) => i === index ? { ...source, ...value } : source) });
      return <fieldset key={item.id}><legend>{label} · 总合力</legend>
        <label>名称<input aria-label={`${label}名称`} value={item.name ?? ''} onChange={event => patch({ name: event.target.value })} /></label>
        <label><input type="checkbox" aria-label={`${label}启用`} checked={item.enabled !== false} onChange={event => patch({ enabled: event.target.checked })} />启用</label>
        <label>合力 / N<input aria-label={`${label}合力 / N`} type="number" min="0" step="any" value={item.magnitude} onChange={event => patch({ magnitude: Number(event.target.value) })} /></label>
        <div className="core-vector">{['X', 'Y', 'Z'].map((axis, component) => <label key={axis}>方向 {axis}<input aria-label={`${label}方向 ${axis}`} type="number" step="any" value={item.vector[component]} onChange={event => patch({ vector: item.vector.map((value, i) => i === component ? Number(event.target.value) : value) })} /></label>)}</div>
        {regionEditor(item, patch, label)}
        <button disabled={study.loads.length <= 1} onClick={() => save({ ...study, loads: study.loads.filter((_, i) => i !== index) })}>移除{label}</button>
      </fieldset>;
    })}
    <button disabled={study.loads.length >= 64} onClick={() => save({ ...study, loads: [...study.loads, { id: crypto.randomUUID(), face: 'x-max', vector: [1, 0, 0], magnitude: 100, enabled: true }] })}>添加合力</button>
    <label>请求网格尺寸 / mm<input aria-label="请求网格尺寸 / mm" type="number" min="0" step="any" value={study.mesh_size} onChange={event => save({ ...study, mesh_size: Number(event.target.value) })} /></label>
    <p>此处只修改同一份草稿，点击“保存工况”后才生效。方向向量会归一化，总合力单位为 N。</p>
  </div>;
}
