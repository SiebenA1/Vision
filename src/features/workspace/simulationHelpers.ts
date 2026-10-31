import type { CoreAssessment, CoreRevision, CoreStudy } from './api';

export type BoundaryEvidence = { id?: string; kind: string; name: string; nodes: number; facets?: number; areaMm2?: number; force?: number[]; center?: number[]; displayNodes?: number[][] };
export type BoundaryPreview = { name: string; kind: 'support' | 'load'; force?: number[]; region?: CoreStudy['supports'][number]['region']; face?: string; evidence?: BoundaryEvidence; bounds?: { min: number[]; max: number[] }; lines?: number[][][] };
type MarkerBody = { id: string; kind: string; bbox_mm?: { min: number[]; max: number[] }; faces: Array<{ id: string; bbox_mm?: { min: number[]; max: number[] } }> };
export function studyMarkers(study: CoreStudy, document: CoreRevision['document'], bodies: MarkerBody[], evidence: BoundaryEvidence[]): BoundaryPreview[] {
  const artifact = document.geometry;
  if (!artifact || (study.body_ids && study.body_artifact_id !== artifact)) return [];
  const selected = bodies.filter(body => body.kind === 'solid' && (!study.body_ids || study.body_ids.includes(body.id)));
  if (!selected.length) return [];
  const boxes = selected.map(body => body.bbox_mm).filter((box): box is NonNullable<MarkerBody['bbox_mm']> => !!box);
  const bounds = boxes.length === selected.length ? { min: [0, 1, 2].map(axis => Math.min(...boxes.map(box => box.min[axis]))), max: [0, 1, 2].map(axis => Math.max(...boxes.map(box => box.max[axis]))) } : undefined;
  return (['support', 'load'] as const).flatMap(kind => (kind === 'support' ? study.supports : study.loads).filter(item => item.enabled !== false).flatMap((item, index) => {
    let region = item.region;
    if (region?.type === 'semantic-object') {
      const objectId = region.object_id;
      const object = document.objects?.find(object => object.id === objectId);
      if (!object || object.binding.artifact_id !== artifact) return [];
      region = { type: 'cad-face', artifactId: artifact, faceIds: object.binding.topology_ids.filter(id => id.includes('/face-')), toleranceMm: region.toleranceMm };
    }
    if (region?.type === 'cad-face' && region.artifactId !== artifact) return [];
    if (!region && bounds) {
      const face = item.face ?? 'x-min', axis = ['x', 'y', 'z'].indexOf(face[0]);
      if (axis >= 0) {
        const limit = (face.endsWith('max') ? bounds.max : bounds.min)[axis];
        const tolerance = Math.max(.001, (bounds.max[axis] - bounds.min[axis]) * 1e-5);
        const ids = selected.flatMap(body => body.faces.filter(surface => surface.bbox_mm && Math.abs(surface.bbox_mm.min[axis] - limit) <= tolerance && Math.abs(surface.bbox_mm.max[axis] - limit) <= tolerance).map(surface => surface.id));
        if (ids.length) region = { type: 'cad-face', artifactId: artifact, faceIds: ids, toleranceMm: .1 };
      }
    }
    return [{ name: item.name || `${kind === 'support' ? '固定位置' : '施力'} ${index + 1}`, kind, region, face: item.face, bounds,
      force: kind === 'load' ? forceComponents(item as CoreStudy['loads'][number]) ?? undefined : undefined,
      evidence: evidence.find(value => value.kind === kind && value.id === item.id) }];
  }));
}
/** Keep glyphs on an observed boundary point, not a centroid in a hole or between parts. */
export function boundaryAnchor(points: number[][], center?: number[]) {
  const valid = points.filter(point => point.length === 3 && point.every(Number.isFinite));
  if (!valid.length) return undefined;
  const target = center ?? [0, 1, 2].map(axis => valid.reduce((sum, point) => sum + point[axis], 0) / valid.length);
  return valid.reduce((best, point) => Math.hypot(...point.map((value, i) => value - target[i])) < Math.hypot(...best.map((value, i) => value - target[i])) ? point : best);
}
export function forceComponents(load: CoreStudy['loads'][number]) {
  const norm = Math.hypot(...load.vector);
  return norm > 0 && Number.isFinite(norm) && Number.isFinite(load.magnitude) ? load.vector.map(x => x / norm * load.magnitude) : null;
}
export function regionLabel(item: CoreStudy['supports'][number], document: CoreRevision['document']) {
  const region = item.region;
  if (!region) return `${item.face ?? 'x-min'} 极值附近区域（容差选区）`;
  if (region.type === 'semantic-object') {
    const object = document.objects?.find(object => object.id === region.object_id);
    return !object ? '对象不存在，需重新绑定' : `${object.name}${object.binding.artifact_id === document.geometry ? '' : ' · 需重新绑定'}`;
  }
  if (region.type === 'cad-face') return `${region.faceIds.join('、')}${region.artifactId === document.geometry ? '' : ' · 需重新绑定'}`;
  return region.type === 'box' ? '空间盒选区域' : '空间球选区域';
}
export function requirementStatus(assessment: CoreAssessment | null) {
  const findings = assessment?.findings ?? [];
  if (!findings.length) return '未定义设计指标';
  if (findings.some(item => item.status === 'fail')) return '存在不满足的指标';
  if (findings.some(item => item.status === 'unknown')) return '部分指标未判定';
  return '已定义指标满足';
}

export function applySelectedFaces(study: CoreStudy, kind: 'support' | 'load', faceIds: string[], artifact: string, toleranceMm: number, id: string, index?: number): CoreStudy {
  if (!faceIds.length || faceIds.length > 256 || faceIds.some(face => !/^body-\d+\/face-\d+$/.test(face))) throw new Error('请先在模型上选择面，不能用实体或边代替。');
  if (study.body_ids && (study.body_artifact_id !== artifact || faceIds.some(face => !study.body_ids!.includes(face.split('/')[0])))) throw new Error('所选面不属于当前分析体，请先核对分析范围。');
  const region = { type: 'cad-face' as const, artifactId: artifact, faceIds: [...new Set(faceIds)], toleranceMm };
  const key = kind === 'support' ? 'supports' : 'loads';
  if (index !== undefined && !study[key][index]) throw new Error('该工况已变化，请重新选择要编辑的条目。');
  if (index === undefined && study[key].length >= 64) throw new Error('最多支持 64 条，请先移除不用的条目。');
  if (kind === 'support') {
    const item = index === undefined ? { id, name: `固定位置 ${study.supports.length + 1}`, type: 'fixed' as const, enabled: true } : study.supports[index];
    return { ...study, supports: index === undefined ? [...study.supports, { ...item, region }] : study.supports.map((value, i) => i === index ? { ...value, region } : value) };
  }
  const item = index === undefined ? { id, name: `施力 ${study.loads.length + 1}`, enabled: true, vector: [0, 0, -1], magnitude: 100 } : study.loads[index];
  return { ...study, loads: index === undefined ? [...study.loads, { ...item, region }] : study.loads.map((value, i) => i === index ? { ...value, region } : value) };
}

export function setAnalysisBodies(study: CoreStudy, ids: string[] | null, artifact: string, solids: string[]): CoreStudy {
  if (ids && (!ids.length || ids.some(id => !solids.includes(id)))) throw new Error('请选择当前几何中的闭合实体，不能使用面、边或片体。');
  return { ...study, body_ids: ids ? [...new Set(ids)] : null, body_artifact_id: ids ? artifact : null };
}
