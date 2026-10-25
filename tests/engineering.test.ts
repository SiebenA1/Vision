import { describe, expect, it } from 'vitest';
import { exportBinaryStl, parseBinaryStl } from '../src/core/cad/stl';
import type { GeometryData } from '../src/core/types';

describe('binary STL transport', () => {
  it('round-trips a closed tetrahedron through STL', async () => {
    const positions = new Float32Array([
      0, 0, 0,
      10, 0, 0,
      0, 10, 0,
      0, 0, 10,
    ]);
    const indices = new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      0, 3, 2,
      1, 2, 3,
    ]);
    const geometry: GeometryData = {
      positions,
      indices,
      bbox: { min: [0, 0, 0], max: [10, 10, 10] },
      volumeMm3: 1000 / 6,
      areaMm2: 0,
      triangleCount: 4,
      vertexCount: 4,
      buildMs: 0,
      watermark: 'TEST-0001',
    };
    const buffer = await exportBinaryStl(geometry);
    const parsed = parseBinaryStl(new Uint8Array(buffer), 'TEST-0001');
    expect(parsed.triangleCount).toBe(4);
    expect(parsed.bbox.max).toEqual([10, 10, 10]);
    expect(parsed.volumeMm3).toBeCloseTo(1000 / 6, 3);
    expect(parsed.watermark).toBe('TEST-0001');
  });
});

describe('STL response boundary', () => {
  it('rejects trailing bytes and non-finite STL coordinates', () => {
    const bytes = new Uint8Array(134);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, 1, true);
    view.setFloat32(96, NaN, true);
    expect(() => parseBinaryStl(bytes, 'invalid')).toThrow('非有限');
    expect(() => parseBinaryStl(new Uint8Array(135), 'invalid')).toThrow();
  });
});
