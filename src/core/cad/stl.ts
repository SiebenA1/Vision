import type { GeometryData } from '../types';

function readFloat32(view: DataView, offset: number): number {
  return view.getFloat32(offset, true);
}

/**
 * Parses a binary STL into the triangle mesh consumed by the viewport and the
 * STL transport. The CAD worker exports binary STL.
 */
export function parseBinaryStl(bytes: Uint8Array, watermark: string): GeometryData {
  if (bytes.byteLength < 84) throw new Error('STL 文件过短。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  const expected = 84 + triangleCount * 50;
  if (triangleCount <= 0 || expected !== bytes.byteLength) {
    throw new Error('不是有效的二进制 STL。');
  }
  const positions = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let signedVolume = 0;
  let area = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = 84 + triangle * 50 + 12;
    const base = triangle * 9;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = readFloat32(view, offset + vertex * 12 + axis * 4);
        if (!Number.isFinite(value)) throw new Error('STL 包含非有限坐标。');
        positions[base + vertex * 3 + axis] = value;
        min[axis] = Math.min(min[axis], value);
        max[axis] = Math.max(max[axis], value);
      }
    }
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];
    signedVolume +=
      (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    area +=
      0.5 * Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
    indices[triangle * 3] = triangle * 3;
    indices[triangle * 3 + 1] = triangle * 3 + 1;
    indices[triangle * 3 + 2] = triangle * 3 + 2;
  }
  if (signedVolume < 0) {
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const base = triangle * 3;
      const tmp = indices[base + 1];
      indices[base + 1] = indices[base + 2];
      indices[base + 2] = tmp;
    }
  }
  return {
    positions,
    indices,
    bbox: { min, max },
    volumeMm3: Math.abs(signedVolume),
    areaMm2: area,
    triangleCount,
    vertexCount: triangleCount * 3,
    buildMs: 0,
    watermark,
  };
}

export function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function exportBinaryStl(geometry: GeometryData): Promise<ArrayBuffer> {
  const triangleCount = geometry.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  const header = 'VISION / watertight STL export';
  for (let i = 0; i < Math.min(header.length, 79); i += 1) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triangleCount, true);
  const p = geometry.positions;
  const idx = geometry.indices;
  let offset = 84;
  for (let t = 0; t < triangleCount; t += 1) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const value of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
}
