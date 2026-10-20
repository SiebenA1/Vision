import { expect, it } from 'vitest';
import { groupMeasurementLabels, measurementValue, placeMeasurementLabel } from '../src/core/cad/measurementLabels';

it('groups labels at the same native point and keeps physical properties in the HUD', () => {
  const groups = groupMeasurementLabels([
    { label: '边长', value: 12, unit: 'mm', anchor: [1, 2, 3] },
    { label: '局部曲率', value: .5, unit: '1/mm', anchor: [1, 2, 3] },
    { label: '质量', value: .02, unit: 'kg' },
    { label: '距离', value: 2, unit: 'mm', anchor: [1, 2, 3], dimension: { start: [0, 2, 3], end: [2, 2, 3] } },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0].properties).toHaveLength(2);
  expect(groups[1].dimension?.end).toEqual([2, 2, 3]);
  expect(measurementValue({ label: '坐标', value: [0, 1e-7, 2], unit: 'mm' })).toBe('0 / 1.000000e-7 / 2 mm');
});

it('keeps clustered callouts inside the viewport and away from each other and the HUD', () => {
  const viewport = { width: 900, height: 700 };
  const occupied = [{ x: 610, y: 20, width: 270, height: 400 }];
  for (let i = 0; i < 3; i++) {
    const label = placeMeasurementLabel({ x: 450, y: 350 }, { width: 180, height: 75 }, viewport, occupied);
    expect(label).not.toBeNull();
    expect(label!.x).toBeGreaterThanOrEqual(12);
    expect(label!.x + label!.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(Math.hypot(Math.max(label!.x - 450, 0, 450 - label!.x - label!.width), Math.max(label!.y - 350, 0, 350 - label!.y - label!.height))).toBeLessThanOrEqual(180);
    for (const other of occupied) expect(label!.x < other.x + other.width && label!.x + label!.width > other.x && label!.y < other.y + other.height && label!.y + label!.height > other.y).toBe(false);
    occupied.push(label!);
  }
});

it('hides labels that cannot fit instead of covering the corner readout', () => {
  expect(placeMeasurementLabel({ x: 50, y: 50 }, { width: 220, height: 100 }, { width: 180, height: 300 }, [])).toBeNull();
});
