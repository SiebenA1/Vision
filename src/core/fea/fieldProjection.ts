import type { AnalysisResult, FieldKind, GeometryData, Vec3 } from '../types';

export interface FieldMeta {
  label: string;
  labelEn: string;
  unit: string;
  decimals: number;
  reversed: boolean;
}

export interface ProjectedField {
  positions: Float32Array;
  colors: Float32Array;
  range: { min: number; max: number };
  meta: FieldMeta;
  maxDisplacement: number;
}

const RAMP: Array<[number, number, number]> = [
  [0.16, 0.23, 0.55],
  [0.18, 0.44, 0.85],
  [0.22, 0.65, 0.86],
  [0.39, 0.85, 0.74],
  [0.78, 0.91, 0.42],
  [1.0, 0.77, 0.31],
  [1.0, 0.29, 0.22],
];

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function rampColor(t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (RAMP.length - 1);
  const index = Math.min(RAMP.length - 2, Math.floor(scaled));
  const local = scaled - index;
  return [
    mix(RAMP[index][0], RAMP[index + 1][0], local),
    mix(RAMP[index][1], RAMP[index + 1][1], local),
    mix(RAMP[index][2], RAMP[index + 1][2], local),
  ];
}

export function rampCss(t: number): string {
  const [r, g, b] = rampColor(t);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

export function fieldMeta(field: FieldKind, yieldStrength: number): FieldMeta {
  if (field === 'displacement') {
    return { label: '合位移', labelEn: 'DISPLACEMENT', unit: 'mm', decimals: 3, reversed: false };
  }
  if (field === 'safety') {
    return {
      label: '安全系数',
      labelEn: 'SAFETY FACTOR',
      unit: `SF / σy=${yieldStrength} MPa`,
      decimals: 2,
      reversed: true,
    };
  }
  return { label: 'von Mises 等效应力', labelEn: 'VON MISES STRESS', unit: 'MPa', decimals: 1, reversed: false };
}

function fieldValues(result: AnalysisResult, field: FieldKind, yieldStrength: number): Float32Array {
  const n = result.field.nodeCount;
  if (field === 'displacement') {
    const values = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      values[i] = Math.hypot(
        result.field.displacement[i * 3],
        result.field.displacement[i * 3 + 1],
        result.field.displacement[i * 3 + 2],
      );
    }
    return values;
  }
  if (field === 'safety') {
    const values = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      values[i] = yieldStrength / Math.max(1e-6, result.field.vonMises[i]);
    }
    return values;
  }
  return result.field.vonMises;
}

interface NodeHash {
  map: Map<string, number[]>;
  cell: number;
}

function hashKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
}

function buildNodeHash(result: AnalysisResult, cell: number): NodeHash {
  const map = new Map<string, number[]>();
  for (let i = 0; i < result.field.nodeCount; i += 1) {
    const x = Math.floor(result.field.positions[i * 3] / cell);
    const y = Math.floor(result.field.positions[i * 3 + 1] / cell);
    const z = Math.floor(result.field.positions[i * 3 + 2] / cell);
    const key = hashKey(x, y, z);
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  }
  return { map, cell };
}

export function projectField(
  geometry: GeometryData,
  result: AnalysisResult,
  field: FieldKind,
  deformationScale: number,
  yieldStrength: number,
): ProjectedField {
  const meta = fieldMeta(field, yieldStrength);
  const values = fieldValues(result, field, yieldStrength);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || Math.abs(max - min) < 1e-9) {
    min = 0;
    max = Math.max(1e-6, max);
  }
  const hash = buildNodeHash(result, Math.max(4, result.mesh.cellSize * 2.4));
  const vertexCount = geometry.positions.length / 3;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const nodeCount = result.field.nodeCount;
  const displacement = result.field.displacement;

  for (let v = 0; v < vertexCount; v += 1) {
    const px = geometry.positions[v * 3];
    const py = geometry.positions[v * 3 + 1];
    const pz = geometry.positions[v * 3 + 2];
    const cx = Math.floor(px / hash.cell);
    const cy = Math.floor(py / hash.cell);
    const cz = Math.floor(pz / hash.cell);
    let nearest = -1;
    let nearestDist = Number.POSITIVE_INFINITY;
    let dx = 0;
    let dy = 0;
    let dz = 0;
    for (let radius = 0; radius <= 2 && nearest === -1; radius += 1) {
      for (let iz = cz - radius; iz <= cz + radius; iz += 1) {
        for (let iy = cy - radius; iy <= cy + radius; iy += 1) {
          for (let ix = cx - radius; ix <= cx + radius; ix += 1) {
            const list = hash.map.get(hashKey(ix, iy, iz));
            if (!list) continue;
            for (const node of list) {
              const nx = result.field.positions[node * 3];
              const ny = result.field.positions[node * 3 + 1];
              const nz = result.field.positions[node * 3 + 2];
              const dist = (px - nx) ** 2 + (py - ny) ** 2 + (pz - nz) ** 2;
              if (dist < nearestDist) {
                nearestDist = dist;
                nearest = node;
              }
            }
          }
        }
      }
    }
    if (nearest >= 0) {
      let weightSum = 0;
      let valueSum = 0;
      let ux = 0;
      let uy = 0;
      let uz = 0;
      const radius = hash.cell * 1.75;
      for (let iz = cz - 2; iz <= cz + 2; iz += 1) {
        for (let iy = cy - 2; iy <= cy + 2; iy += 1) {
          for (let ix = cx - 2; ix <= cx + 2; ix += 1) {
            const list = hash.map.get(hashKey(ix, iy, iz));
            if (!list) continue;
            for (const node of list) {
              const nx = result.field.positions[node * 3];
              const ny = result.field.positions[node * 3 + 1];
              const nz = result.field.positions[node * 3 + 2];
              const dist = Math.hypot(px - nx, py - ny, pz - nz);
              if (dist > radius) continue;
              const weight = 1 / (dist + 0.35);
              weightSum += weight;
              valueSum += values[node] * weight;
              ux += displacement[node * 3] * weight;
              uy += displacement[node * 3 + 1] * weight;
              uz += displacement[node * 3 + 2] * weight;
            }
          }
        }
      }
      if (weightSum > 0) {
        valueSum /= weightSum;
        ux /= weightSum;
        uy /= weightSum;
        uz /= weightSum;
      } else {
        valueSum = values[nearest];
        ux = displacement[nearest * 3];
        uy = displacement[nearest * 3 + 1];
        uz = displacement[nearest * 3 + 2];
      }
      dx = ux * deformationScale;
      dy = uy * deformationScale;
      dz = uz * deformationScale;
      const normalized = meta.reversed ? 1 - (valueSum - min) / (max - min) : (valueSum - min) / (max - min);
      const [r, g, b] = rampColor(normalized);
      colors[v * 3] = r ** 2.2;
      colors[v * 3 + 1] = g ** 2.2;
      colors[v * 3 + 2] = b ** 2.2;
    } else {
      colors[v * 3] = 0.55;
      colors[v * 3 + 1] = 0.55;
      colors[v * 3 + 2] = 0.5;
    }
    positions[v * 3] = px + dx;
    positions[v * 3 + 1] = py + dy;
    positions[v * 3 + 2] = pz + dz;
  }

  return {
    positions,
    colors,
    range: { min, max },
    meta,
    maxDisplacement: result.maxDisplacement,
  };
}

export function autoDeformationScale(result: AnalysisResult): number {
  if (result.maxDisplacement <= 1e-9) return 1;
  const target = 8;
  return Math.max(1, Math.min(500, Math.round(target / result.maxDisplacement)));
}

export function nearestFieldValue(
  result: AnalysisResult,
  point: Vec3,
  field: FieldKind,
  yieldStrength: number,
): number | null {
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < result.field.nodeCount; i += 1) {
    const dist =
      (result.field.positions[i * 3] - point[0]) ** 2 +
      (result.field.positions[i * 3 + 1] - point[1]) ** 2 +
      (result.field.positions[i * 3 + 2] - point[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  if (best < 0) return null;
  if (field === 'displacement') {
    return Math.hypot(
      result.field.displacement[best * 3],
      result.field.displacement[best * 3 + 1],
      result.field.displacement[best * 3 + 2],
    );
  }
  if (field === 'safety') return yieldStrength / Math.max(1e-6, result.field.vonMises[best]);
  return result.field.vonMises[best];
}
