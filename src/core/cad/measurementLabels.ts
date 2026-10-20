import type { InspectionProperty } from '../../services/engineeringBackend';

export function measurementNumber(value: number, digits = 8) {
  return value === 0 ? '0' : Math.abs(value) < .0001 || Math.abs(value) >= 1e8
    ? value.toExponential(Math.min(6, digits - 1)) : Number(value.toPrecision(digits)).toString();
}
export function measurementValue(property: InspectionProperty, compact = false) {
  const value = Array.isArray(property.value) ? property.value.map(value => measurementNumber(value, compact ? 4 : 8)).join(' / ')
    : typeof property.value === 'number' ? measurementNumber(property.value, compact ? 6 : 8) : property.value;
  return `${value}${property.unit ? ` ${property.unit}` : ''}`;
}

export function groupMeasurementLabels(properties: InspectionProperty[]) {
  const groups: Array<{ anchor: [number, number, number]; dimension?: InspectionProperty['dimension']; properties: InspectionProperty[] }> = [];
  for (const property of properties) {
    if (!property.anchor || property.panelOnly || property.annotation === 'detail' || !property.anchor.every(Number.isFinite)) continue;
    const group = !property.dimension && groups.find(item => !item.dimension && item.anchor.every((v, i) => Math.abs(v - property.anchor![i]) < 1e-7));
    if (group) group.properties.push(property);
    else groups.push({ anchor: property.anchor, dimension: property.dimension, properties: [property] });
  }
  return groups;
}

export interface LabelRect { x: number; y: number; width: number; height: number }
export function placeMeasurementLabel(anchor: { x: number; y: number }, size: { width: number; height: number }, viewport: { width: number; height: number }, occupied: LabelRect[], preferred?: LabelRect): LabelRect | null {
  const margin = 12, gap = 22;
  if (size.width + margin * 2 > viewport.width || size.height + margin * 2 > viewport.height) return null;
  const candidates: LabelRect[] = [];
  if (preferred) candidates.push(preferred);
  for (const x of [anchor.x + gap, anchor.x - size.width - gap]) {
    for (const y of [anchor.y - size.height - gap, anchor.y + gap, anchor.y - size.height / 2]) candidates.push({ x, y, ...size });
  }
  for (const x of [anchor.x - size.width / 2, anchor.x + gap, anchor.x - size.width - gap]) {
    for (const y of [anchor.y - size.height * 2 - gap, anchor.y + size.height + gap]) candidates.push({ x, y, ...size });
  }
  let best: LabelRect | null = null, score = Infinity;
  for (const candidate of candidates) {
    const rect = { ...candidate, x: Math.max(margin, Math.min(candidate.x, viewport.width - size.width - margin)), y: Math.max(margin, Math.min(candidate.y, viewport.height - size.height - margin)) };
    const nearestX = Math.max(rect.x, Math.min(anchor.x, rect.x + rect.width));
    const nearestY = Math.max(rect.y, Math.min(anchor.y, rect.y + rect.height));
    const leaderLength = Math.hypot(nearestX - anchor.x, nearestY - anchor.y);
    if (leaderLength > Math.min(180, viewport.width * .2)) continue;
    if (occupied.some(other => rect.x < other.x + other.width + 8 && rect.x + rect.width + 8 > other.x && rect.y < other.y + other.height + 8 && rect.y + rect.height + 8 > other.y)) continue;
    if (preferred && candidate === preferred) return rect;
    const distance = leaderLength + Math.hypot(rect.x + rect.width / 2 - anchor.x, rect.y + rect.height / 2 - anchor.y) * .1;
    if (distance < score) { score = distance; best = rect; }
  }
  return best;
}
