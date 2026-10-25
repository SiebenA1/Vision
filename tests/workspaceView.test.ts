import { describe, expect, it } from 'vitest';
import { viewRuler, objectLabel } from '../src/features/workspace/viewHelpers';

describe('physical viewport ruler', () => {
  it('tracks perspective depth, zoom and viewport height in mm', () => {
    const first = viewRuler(200, 40, 600)!;
    const mmPerPixel = 400 * Math.tan(20 * Math.PI / 180) / 600;
    expect(first.pixels * mmPerPixel).toBeCloseTo(first.length);
    expect(first.pixels).toBeGreaterThan(40);
    expect(first.pixels).toBeLessThanOrEqual(110);
    expect(viewRuler(400, 40, 600)!.length).toBeGreaterThan(first.length);
    expect(viewRuler(200, 40, 1200)!.length).toBeLessThan(first.length);
    expect(viewRuler(0, 40, 600)).toBeNull();
    expect(viewRuler(200, 40, 0)).toBeNull();
    expect(viewRuler(Infinity, 40, 600)).toBeNull();
  });
  it('labels native IDs without losing their identity', () => {
    expect(objectLabel('body-0/face-3')).toBe('实体 1 · 面 4');
    expect(objectLabel('body-1/edge-0')).toBe('实体 2 · 边 1');
    expect(objectLabel('body-0')).toBe('实体 1');
    expect(objectLabel('unknown')).toBe('unknown');
  });
});
