import type { Vec3 } from '../types';

export interface CadBounds { min: Vec3; max: Vec3; size: Vec3 }
export interface CadBody {
  id: string; name: string; kind: 'solid' | 'sheet'; manifold: boolean;
  volume_mm3: number; area_mm2: number; mass_kg: number;
  bbox_mm: CadBounds; triangles: number; stlFile: string;
  faces: Array<{ id: string; index: number; area_mm2: number; bbox_mm: CadBounds }>;
  edges: Array<{ id: string; index: number; length_mm: number; bbox_mm: CadBounds }>;
}
export interface CadSettings { tolerance_mm: number; angle_deg: number; relative_accuracy: number }
export interface CadArtifact {
  artifactId: string; kernelVersion: string; nativeSha256: string; bodies: CadBody[];
  parameters: Record<string, number | string | boolean>; settings: CadSettings; warnings: string[];
  sourceArtifact?: string;
}
export interface CadBuildOptions {
  parameters?: Record<string, number | string | boolean>;
  tolerance_mm?: number; angle_deg?: number; relative_accuracy?: number; heal?: boolean;
}
export type RegionSelection = { type: 'cad-face'; artifactId: string; faceIds: string[]; toleranceMm: number } | { type: 'box'; min: Vec3; max: Vec3 } | { type: 'sphere'; center: Vec3; radius: number };
