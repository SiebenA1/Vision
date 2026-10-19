import type { Load, Support, Vec3 } from '../types';
import type { RegionSelection } from './types';
import { useAppStore } from '../../state/store';
const faces = ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'];
function vector(value: unknown): value is Vec3 { return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v)); }
function regionValid(region: RegionSelection | undefined): boolean {
  if (!region) return true;
  if (region.type === 'cad-face') return /^[a-f0-9]{64}$/.test(region.artifactId) && Array.isArray(region.faceIds) && region.faceIds.length > 0 && region.faceIds.every((id) => /^body-[0-9]+\/face-[0-9]+$/.test(id)) && Number.isFinite(region.toleranceMm) && region.toleranceMm > 0;
  if (region.type === 'box') return vector(region.min) && vector(region.max) && region.min.every((v, i) => v <= region.max[i]);
  return region.type === 'sphere' && vector(region.center) && Number.isFinite(region.radius) && region.radius > 0;
}
export function applyStudyConfiguration(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工况必须为对象');
  const patch = value as { supports?: Support[]; loads?: Load[]; meshSize?: number; bodyIds?: string[] };
  const state = useAppStore.getState();
  const supports = patch.supports ?? state.model.supports;
  const loads = patch.loads ?? state.model.loads;
  for (const items of [supports, loads]) {
    if (!Array.isArray(items) || !items.length || items.length > 64) throw new Error('工况需要 1–64 项');
    if (!items.some((item) => item.enabled)) throw new Error('至少启用一项工况');
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('工况编号不能重复');
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.enabled !== 'boolean' || !faces.includes(item.face) || !regionValid(item.region)) throw new Error('无效的工况或区域');
    }
  }
  if (supports.some((item) => item.type !== 'fixed')) throw new Error('仅支持固定约束');
  if (loads.some((item) => !vector(item.vector) || Math.hypot(...item.vector) === 0 || !Number.isFinite(item.magnitude) || item.magnitude <= 0)) throw new Error('载荷必须包含正合力和非零三维方向');
  for (const item of [...supports, ...loads]) {
    if (item.region?.type === 'cad-face' && (item.region.artifactId !== state.model.cad?.artifactId || item.region.faceIds.some((id) => !state.model.cad?.bodies.some((body) => body.faces.some((face) => face.id === id))))) throw new Error('几何已变化，请重新选择原生面');
  }
  const meshSize = patch.meshSize ?? state.model.mesh.cellSizeMm ?? 1.5;
  if (!Number.isFinite(meshSize) || meshSize <= 0) throw new Error('网格尺寸必须为正');
  const bodyIds = patch.bodyIds ?? state.model.studyBodyIds;
  if (bodyIds && (!Array.isArray(bodyIds) || !bodyIds.length || new Set(bodyIds).size !== bodyIds.length || bodyIds.some((id) => !state.model.cad?.bodies.some((body) => body.id === id && body.kind === 'solid')))) throw new Error('请选择有效的分析实体');
  state.configureStudy({ supports, loads, mesh: { ...state.model.mesh, cellSizeMm: meshSize }, studyBodyIds: bodyIds });
}
