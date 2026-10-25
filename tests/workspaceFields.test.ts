import { describe, expect, it } from 'vitest';
import { parseSurface, surfaceColors } from '../src/features/workspace/fields';

function fixture() {
  const buffer = new ArrayBuffer(16 + 3 * 28 + 12), view = new DataView(buffer);
  new Uint8Array(buffer).set(new TextEncoder().encode('VSURF001'));
  view.setUint32(8, 3, true); view.setUint32(12, 1, true);
  [0,0,0, 1,0,0, 0,1,0, 0,0,0, .01,0,0, 0,.02,0, 0,5,10].forEach((value, i) => view.setFloat32(16+i*4, value, true));
  [0,1,2].forEach((value, i) => view.setUint32(100+i*4, value, true));
  return buffer;
}
describe('indexed FEM boundary fields', () => {
  it('preserves topology and physical values across displacement/stress display', () => {
    const data = parseSurface(fixture());
    expect([...data.indices]).toEqual([0,1,2]);
    expect(surfaceColors(data, 'displacement').max).toBeCloseTo(.02);
    expect(surfaceColors(data, 'vonMises').max).toBe(10);
    expect([...data.positions]).toEqual([0,0,0,1,0,0,0,1,0]);
  });
  it('rejects corrupt/truncated, oversized, nonfinite and out-of-range arrays', () => {
    expect(() => parseSurface(fixture().slice(0, -1))).toThrow();
    for (const corrupt of [(view: DataView) => view.setUint32(8, 500001, true),
      (view: DataView) => view.setFloat32(16, NaN, true), (view: DataView) => view.setUint32(100, 3, true)]) {
      const buffer = fixture(); corrupt(new DataView(buffer)); expect(() => parseSurface(buffer)).toThrow();
    }
  });
});
