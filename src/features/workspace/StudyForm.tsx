import { useState } from 'react';
import type { CoreRevision, CoreStudy } from './api';
import { forceComponents, regionLabel } from './simulationHelpers';

const faces = ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'];
const materialFields = { E: '弹性模量 / MPa', nu: '泊松比', rho: '密度 / kg/m³', yieldStrength: '屈服强度 / MPa' };
const meanings = { E: '数值越大，同样受力下通常越不容易变形。', nu: '拉长时横向收缩的比例。普通金属常在 0.3 附近，应以材料数据为准。', rho: '用于质量计算，本次静力分析不会自动施加自重。', yieldStrength: '用于屈服安全系数评估，不会自动启用塑性计算。' };
type Boundary = CoreStudy['supports'][number] | CoreStudy['loads'][number];

/** Forms and graphical selection edit the same draft; saving is explicit. */
export function StudyForm({ text, document, change, pick, preview, disabled }: {
  text: string; document: CoreRevision['document']; change: (text: string) => void;
  pick: (kind: 'support' | 'load', index?: number) => void;
  disabled: boolean;
  preview: (kind: 'support' | 'load', index: number) => void;
}) {
  const [customDirections, setCustomDirections] = useState<Record<string, boolean>>({});
  let study: CoreStudy;
  try {
    study = JSON.parse(text);
    if (!study?.material || !Array.isArray(study.supports) || !Array.isArray(study.loads) ||
      !Object.keys(materialFields).every(key => typeof study.material[key as keyof typeof materialFields] === 'number') ||
      !study.supports.every(item => item && typeof item.id === 'string') ||
      !study.loads.every(item => item && typeof item.id === 'string' && Array.isArray(item.vector) && item.vector.length === 3)) throw new Error('incomplete');
  } catch { return <p>点击“开始图形化设置”，然后在模型上选择固定面和施力面。</p>; }
  const save = (next: CoreStudy) => change(JSON.stringify(next, null, 2));
  const regionEditor = (item: Boundary, patch: (value: Partial<CoreStudy['supports'][number]>) => void, label: string) => {
    const current = item.region?.type === 'semantic-object' ? `object:${item.region.object_id}` : item.region ? 'precise' : item.face ?? 'x-min';
    return <label>{label}作用区域<select aria-label={`${label}作用区域`} value={current} onChange={event => {
      const value = event.target.value;
      if (value === 'precise') return;
      patch(value.startsWith('object:') ? { region: { type: 'semantic-object', object_id: value.slice(7), toleranceMm: .1 } } : { region: undefined, face: value });
    }}>
      {faces.map(face => <option key={face} value={face}>{face} 极值附近区域</option>)}
      {item.region && item.region.type !== 'semantic-object' && <option value="precise">当前图形选区</option>}
      {(document.objects ?? []).map(object => <option key={object.id} value={`object:${object.id}`} disabled={object.binding.artifact_id !== document.geometry}>{object.name}{object.binding.artifact_id !== document.geometry ? ' · 需重绑定' : ''}</option>)}
      {item.region?.type === 'semantic-object' && !document.objects?.some(object => object.id === current.slice(7)) && <option value={current}>对象已不可用</option>}
    </select></label>;
  };
  return <div className="core-study-form" aria-label="工况表单">
    <details className="study-material"><summary>材料参数 · E {study.material.E} MPa</summary>
      <p>请按实际材料核对。展开后可查看每个参数的含义。</p>
      {Object.entries(materialFields).map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="number" step="any" value={study.material[key as keyof typeof materialFields]}
        onChange={event => save({ ...study, material: { ...study.material, [key]: Number(event.target.value) } })} /><small>{meanings[key as keyof typeof meanings]}</small></label>)}
    </details>
    <h3>① 固定哪里？</h3><p>固定面上的节点不能移动，相当于将这里夹紧。只选择真实的安装或夹持位置。</p>
    {!study.supports.length && <p className="study-warning">尚未设置固定位置。</p>}
    {study.supports.map((item, index) => {
      const label = `约束 ${index + 1}`;
      const patch = (value: Partial<typeof item>) => save({ ...study, supports: study.supports.map((source, i) => i === index ? { ...source, ...value } : source) });
      return <article className="study-boundary-card" key={item.id}>
        <header><strong>固定位置 {index + 1}</strong><span>{item.enabled === false ? '已停用' : '已启用'}</span></header>
        <p>{item.region?.type === 'cad-face' && item.region.artifactId === document.geometry ? `已选择 ${item.region.faceIds.length} 个模型面` : regionLabel(item, document)}</p>
        <div className="study-card-actions"><button disabled={disabled} onClick={() => pick('support', index)}>重新选面</button><button disabled={disabled} onClick={() => preview('support', index)}>显示固定位置 {index + 1}</button></div>
        <details><summary>名称、启用与高级选区</summary>
          <label>名称<input aria-label={`${label}名称`} value={item.name ?? ''} onChange={event => patch({ name: event.target.value })} /></label>
          <label className="study-enabled"><input type="checkbox" aria-label={`${label}启用`} checked={item.enabled !== false} onChange={event => patch({ enabled: event.target.checked })} />启用此固定位置</label>
          {regionEditor(item, patch, label)}
        </details>
        <button className="study-remove" onClick={() => save({ ...study, supports: study.supports.filter((_, i) => i !== index) })}>移除固定位置 {index + 1}</button>
      </article>;
    })}
    <button disabled={disabled || study.supports.length >= 64} onClick={() => pick('support')}>＋ 在模型上添加固定位置</button>
    <h3>② 在哪里施力？</h3><p>先选受力面，再填总力和方向。100 N 表示这组面共同承受 100 N，并非每个面各 100 N。</p>
    {!study.loads.length && <p className="study-warning">尚未设置施力位置。</p>}
    {study.loads.map((item, index) => {
      const label = `载荷 ${index + 1}`;
      const patch = (value: Partial<typeof item>) => save({ ...study, loads: study.loads.map((source, i) => i === index ? { ...source, ...value } : source) });
      const axis = item.vector.findIndex(value => value !== 0);
      const direction = !customDirections[item.id] && axis >= 0 && item.vector.filter(value => value !== 0).length === 1 ? `${item.vector[axis] < 0 ? '-' : '+'}${axis}` : 'custom';
      const force = forceComponents(item);
      return <article className="study-boundary-card" key={item.id}>
        <header><strong>施力 {index + 1}</strong><span>{item.enabled === false ? '已停用' : '已启用'}</span></header>
        <p>{item.region?.type === 'cad-face' && item.region.artifactId === document.geometry ? `已选择 ${item.region.faceIds.length} 个模型面` : regionLabel(item, document)}</p>
        <div className="study-card-actions"><button disabled={disabled} onClick={() => pick('load', index)}>重新选受力面</button><button disabled={disabled} onClick={() => preview('load', index)}>显示力箭头 {index + 1}</button></div>
        <label>总力大小 / N<input aria-label={`${label}合力 / N`} type="number" min="0" step="any" value={item.magnitude} onChange={event => patch({ magnitude: Number(event.target.value) })} /></label>
        <label>沿哪个方向？<select aria-label={`${label}施力方向`} value={direction} onChange={event => {
          const value = event.target.value;
          setCustomDirections(previous => ({ ...previous, [item.id]: value === 'custom' }));
          if (value !== 'custom') patch({ vector: [0, 1, 2].map(i => i === Number(value[1]) ? (value[0] === '-' ? -1 : 1) : 0) });
        }}>
          {['X', 'Y', 'Z'].flatMap((axis, i) => [<option key={`+${i}`} value={`+${i}`}>沿 +{axis}</option>, <option key={`-${i}`} value={`-${i}`}>沿 −{axis}</option>])}
          <option value="custom">自定义方向向量</option>
        </select></label>
        <button disabled={!force} onClick={() => patch({ vector: item.vector.map(x => -x) })}>反向</button>
        <small>使用视口左下角的世界坐标轴，不随观察角度改变。</small>
        {direction === 'custom' && <div className="core-vector">{['X', 'Y', 'Z'].map((axis, component) => <label key={axis}>{axis}<input aria-label={`${label}方向 ${axis}`} type="number" step="any" value={item.vector[component]} onChange={event => patch({ vector: item.vector.map((value, i) => i === component ? Number(event.target.value) : value) })} /></label>)}</div>}
        <details><summary>名称、启用与高级选区</summary>
          <label>名称<input aria-label={`${label}名称`} value={item.name ?? ''} onChange={event => patch({ name: event.target.value })} /></label>
          <label className="study-enabled"><input type="checkbox" aria-label={`${label}启用`} checked={item.enabled !== false} onChange={event => patch({ enabled: event.target.checked })} />启用此施力</label>
          {regionEditor(item, patch, label)}
        </details>
        <button className="study-remove" onClick={() => save({ ...study, loads: study.loads.filter((_, i) => i !== index) })}>移除施力 {index + 1}</button>
      </article>;
    })}
    <button disabled={disabled || study.loads.length >= 64} onClick={() => pick('load')}>＋ 在模型上添加施力</button>
    <details><summary>③ 网格精细程度 · {study.mesh_size} mm</summary>
      <label>请求网格尺寸 / mm<input aria-label="请求网格尺寸 / mm" type="number" min="0" step="any" value={study.mesh_size} onChange={event => save({ ...study, mesh_size: Number(event.target.value) })} /></label>
      <p>较小的值通常更精细、耗时更多。此值控制四面体体积，不保证最大边长；结果精度需另做网格检查。</p>
    </details>
    <p>所有操作先修改草稿；点击“保存工况”后才用于求解。</p>
  </div>;
}
