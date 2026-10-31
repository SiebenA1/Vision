import type { CoreRevision } from './api';
import { forceComponents, regionLabel, type BoundaryEvidence } from './simulationHelpers';

export function SimulationReview({ document, dirty, boundaries, preview, clear, disabled }: {
  document: CoreRevision['document']; dirty: boolean; boundaries: BoundaryEvidence[];
  preview: (kind: 'support' | 'load', index: number) => void; clear: () => void; disabled: boolean;
}) {
  const study = document.study;
  if (!study) return <section className="simulation-review" aria-label="分析参数"><h3>尚无分析参数</h3><p>在右侧说明要判断什么。助手会读取模型、建议工况，并询问缺失的关键条件。</p></section>;
  return <section className="simulation-review" aria-label="分析参数"><h3>{dirty ? '候选参数 · 未保存' : '当前分析参数'}</h3>
    <p>{dirty ? '以下为界面候选值；保存后才用于求解。' : '以下对应当前已保存工况。'}</p>
    <p>分析体：{study.body_ids?.join('、') ?? '全部闭合实体'}{study.body_ids && study.body_artifact_id !== document.geometry ? ' · 选择已失效' : ''}<br />
      E {study.material.E} MPa · ν {study.material.nu} · 密度 {study.material.rho} kg/m³<br />屈服强度 {study.material.yieldStrength} MPa<br />请求网格尺寸 {study.mesh_size} mm（体积控制参数，非最大边长）</p>
    {(['support', 'load'] as const).map(kind => (kind === 'support' ? study.supports : study.loads).map((item, index) => {
      const evidence = boundaries.find(value => value.kind === kind && value.id === item.id);
      const force = kind === 'load' ? forceComponents(study.loads[index]) : null;
      return <article key={`${kind}:${item.id}`}>
        <strong>{kind === 'support' ? '固定位置' : '施力'} · {item.name || index + 1} · {item.enabled === false ? '停用' : '启用'}</strong>
        <p title={regionLabel(item, document)}>{item.region?.type === 'cad-face' && item.region.artifactId === document.geometry ? `${item.region.faceIds.length} 个模型面` : regionLabel(item, document)}{force && <><br />F = [{force.map(x => Number(x.toPrecision(5))).join(', ')}] N</>}</p>
        {evidence ? <details><summary>网格命中详情</summary><p>实际命中 {evidence.nodes} 节点 · {evidence.facets ?? '未知'} 边界面<br />面积 {evidence.areaMm2?.toPrecision(6) ?? '未记录'} mm²</p></details> : null}
        <button disabled={disabled || item.enabled === false} onClick={() => preview(kind, index)}>查看{kind === 'support' ? '约束' : '载荷'} {index + 1}</button>
      </article>;
    }))}
    <button onClick={clear}>隐藏边界示意</button>
    <p>红色箭头：力方向 · 蓝色标记：固定位置。参数调整请告诉右侧助手，或展开高级操作。</p>
  </section>;
}
