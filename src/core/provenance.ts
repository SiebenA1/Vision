import { getMaterial } from './materials';
import type { ModelDocument } from './types';

/** Display fingerprint, not a cryptographic signature. Compare full keys for jobs. */
export function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

export function geometryFingerprint(model: ModelDocument): string {
  return model.cad ? `USD-${model.cad.nativeSha256.slice(0, 16).toUpperCase()}` : `STL-${fingerprint(model.externalStlBase64 ?? '')}`;
}

/** Only engineering inputs: renaming a project must not invalidate a solve. */
export function studyKey(model: ModelDocument): string {
  const { E, nu, rho, yieldStrength } = getMaterial(model.materialId);
  return JSON.stringify({
    id: model.id, units: model.units, template: model.template,
    cad: model.cad ? { artifactId: model.cad.artifactId, nativeSha256: model.cad.nativeSha256, settings: model.cad.settings } : undefined, bodies: model.studyBodyIds,
    script: model.externalScript, stl: model.cad ? undefined : model.externalStlBase64,
    variables: model.variables, solidFeatures: model.solidFeatures,
    material: { E, nu, rho, yieldStrength },
    supports: model.supports.filter((item) => item.enabled).map(({ face, type, region }) => ({ face, type, region })),
    loads: model.loads.filter((item) => item.enabled).map(({ face, vector, magnitude, region }) => ({ face, vector, magnitude, region })),
    meshSize: model.mesh.cellSizeMm ?? 1.5,
  });
}

export function studyFingerprint(model: ModelDocument): string {
  return `STUDY-${fingerprint(studyKey(model))}`;
}
