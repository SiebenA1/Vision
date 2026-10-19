import type { CadArtifact } from './types';
export function isCadArtifact(value: unknown): value is CadArtifact {
  if (!value || typeof value !== 'object') return false;
  const cad = value as CadArtifact;
  const vector = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  const bounds = (box: CadArtifact['bodies'][number]['bbox_mm']) => box && vector(box.min) && vector(box.max) && vector(box.size) && box.min.every((v, i) => v <= box.max[i]);
  return /^[a-f0-9]{64}$/.test(cad.artifactId) && /^[a-f0-9]{64}$/.test(cad.nativeSha256) &&
    typeof cad.kernelVersion === 'string' && Array.isArray(cad.bodies) && cad.bodies.length > 0 &&
    new Set(cad.bodies.map((b) => b?.id)).size === cad.bodies.length &&
    cad.bodies.every((body) => body && /^body-[0-9]+$/.test(body.id) && typeof body.name === 'string' &&
      ['solid', 'sheet'].includes(body.kind) && typeof body.manifold === 'boolean' && bounds(body.bbox_mm) &&
      [body.volume_mm3, body.area_mm2, body.mass_kg].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) &&
      Number.isSafeInteger(body.triangles) && body.triangles > 0 && /^body-[0-9]+\.stl$/.test(body.stlFile) &&
      Array.isArray(body.faces) && body.faces.every((face) => face && typeof face.id === 'string' && bounds(face.bbox_mm) && Number.isFinite(face.area_mm2)) &&
      Array.isArray(body.edges) && body.edges.every((edge) => edge && typeof edge.id === 'string' && bounds(edge.bbox_mm) && Number.isFinite(edge.length_mm))) &&
    Boolean(cad.settings) && [cad.settings.tolerance_mm, cad.settings.angle_deg, cad.settings.relative_accuracy].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) &&
    Boolean(cad.parameters) && typeof cad.parameters === 'object' && !Array.isArray(cad.parameters) && Object.values(cad.parameters).every((v) => typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) &&
    Array.isArray(cad.warnings) && cad.warnings.every((v) => typeof v === 'string');
}
