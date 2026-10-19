import type { FaceId, Vec3 } from '../core/types';

export function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtCompact(value: number, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${fmt(value / 1_000_000, digits)}M`;
  if (abs >= 10_000) return `${fmt(value / 1000, digits)}k`;
  return fmt(value, digits);
}

export function faceLabel(face: FaceId): string {
  const labels: Record<FaceId, string> = {
    'x-min': '−X / 背面',
    'x-max': '+X / 自由端',
    'y-min': '−Y / 前侧',
    'y-max': '+Y / 后侧',
    'z-min': '−Z / 底面',
    'z-max': '+Z / 顶面',
  };
  return labels[face];
}

export function faceShort(face: FaceId): string {
  return face.replace('-', '−');
}

export function vectorLabel(vector: Vec3): string {
  const [x, y, z] = vector;
  if (z < 0 && x === 0 && y === 0) return '竖直向下';
  if (z > 0 && x === 0 && y === 0) return '竖直向上';
  if (x > 0 && y === 0 && z === 0) return '沿 +X';
  if (x < 0 && y === 0 && z === 0) return '沿 −X';
  if (y > 0 && x === 0 && z === 0) return '沿 +Y';
  if (y < 0 && x === 0 && z === 0) return '沿 −Y';
  return `[${vector.join(', ')}]`;
}

export function formatBytes(bytes: number): string {
  if (bytes > 1024 * 1024) return `${fmt(bytes / (1024 * 1024), 1)} MB`;
  if (bytes > 1024) return `${fmt(bytes / 1024, 0)} KB`;
  return `${bytes} B`;
}

export function percent(value: number, digits = 0): string {
  return `${fmt(value, digits)}%`;
}
