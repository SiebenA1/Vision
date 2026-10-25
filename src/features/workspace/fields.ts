import { rampColor } from '../../core/fea/fieldProjection';

export interface SurfaceField {
  positions: Float32Array; displacement: Float32Array; stress: Float32Array; indices: Uint32Array;
}
export type ResultField = 'displacement' | 'vonMises';
export function parseSurface(buffer: ArrayBuffer): SurfaceField {
  if (buffer.byteLength < 16 || new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'VSURF001') throw new Error('结果场格式无效');
  const header = new DataView(buffer), n = header.getUint32(8, true), triangles = header.getUint32(12, true);
  if (!n || !triangles || n > 500000 || triangles > 1000000 || buffer.byteLength !== 16 + n * 28 + triangles * 12) throw new Error('结果场尺寸超出预算或不完整');
  // Decode explicitly: artifacts are little-endian on every host.
  let offset = 16;
  const floats = (count: number) => { const array = new Float32Array(count); for (let i = 0; i < count; i++, offset += 4) {
    array[i] = header.getFloat32(offset, true); if (!Number.isFinite(array[i])) throw new Error('结果场包含非有限值');
  } return array; };
  const positions = floats(n * 3), displacement = floats(n * 3), stress = floats(n);
  if (stress.some(value => value < 0)) throw new Error('结果场包含无效应力');
  const indices = new Uint32Array(triangles * 3);
  for (let i = 0; i < indices.length; i++, offset += 4) { indices[i] = header.getUint32(offset, true); if (indices[i] >= n) throw new Error('结果场拓扑索引越界'); }
  return { positions, displacement, stress, indices };
}
export function surfaceColors(data: SurfaceField, field: ResultField) {
  const values = field === 'vonMises' ? data.stress : Float32Array.from(data.stress, (_, i) => Math.hypot(...data.displacement.subarray(i * 3, i * 3 + 3)));
  let min = Infinity, max = -Infinity;
  for (const value of values) { min = Math.min(min, value); max = Math.max(max, value); }
  const colors = new Float32Array(values.length * 3);
  values.forEach((value, i) => colors.set(rampColor(max > min ? (value - min) / (max - min) : 0), i * 3));
  return { colors, min, max };
}
