import type { GeometryData } from '../types';

function readFloat32(view: DataView, offset: number): number {
  return view.getFloat32(offset, true);
}

/**
 * Parses a binary STL into the triangle mesh consumed by the viewport and the
 * voxel FE mesher. Build123d exports binary STL by default.
 */
export function parseBinaryStl(bytes: Uint8Array, watermark: string): GeometryData {
  if (bytes.byteLength < 84) throw new Error('STL 文件过短。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  const expected = 84 + triangleCount * 50;
  if (triangleCount <= 0 || expected > bytes.byteLength) {
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
