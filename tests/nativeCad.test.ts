import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProjectModel, persistProjectLibrary } from '../src/core/projects';
import { isCadArtifact } from '../src/core/cad/schema';
import { applyStudyConfiguration } from '../src/core/cad/study';
import { cadArtifactFromResult, type CadExecutionResult } from '../src/services/engineeringBackend';
import { useAppStore } from '../src/state/store';
import { buildModelContext, buildDeepSeekTools } from '../src/core/llm/tools';
import type { CadArtifact } from '../src/core/cad/types';
const bounds = { min: [0, 0, 0], max: [100, 20, 10], size: [100, 20, 10] } as const;
const cad: CadArtifact = {
  artifactId: 'a'.repeat(64), nativeSha256: 'b'.repeat(64), kernelVersion: '1.0.0',
  settings: { tolerance_mm: .05, angle_deg: 10, relative_accuracy: .00001 }, parameters: { length: 100 }, warnings: [],
  bodies: [{ id: 'body-0', name: 'beam', kind: 'solid', manifold: true, volume_mm3: 20000,
    area_mm2: 6400, mass_kg: .054, bbox_mm: JSON.parse(JSON.stringify(bounds)), triangles: 12, stlFile: 'body-0.stl',
    faces: [{ id: 'body-0/face-0', index: 0, area_mm2: 200, bbox_mm: JSON.parse(JSON.stringify(bounds)) }], edges: [] }],
};
const initial = useAppStore.getState();
beforeEach(() => { useAppStore.setState({ ...initial, model: { ...createBlankProjectModel(), cad: structuredClone(cad), studyBodyIds: ['body-0'] } }); });
afterEach(() => { useAppStore.setState(initial); vi.unstubAllGlobals(); });

describe('native CAD and complex study contract', () => {
  it('validates native artifacts and refuses malformed imported metadata', () => {
    expect(isCadArtifact(cad)).toBe(true);
    expect(isCadArtifact({ ...cad, artifactId: '../outside' })).toBe(false);
    expect(isCadArtifact({ ...cad, bodies: 'invalid' })).toBe(false);
    const result = { schema: 'vision.cad/3', ...cad, metrics: {}, stlBase64: '', stlBytes: 0 } as unknown as CadExecutionResult;
    expect(cadArtifactFromResult(result)?.parameters.length).toBe(100);
    expect(() => cadArtifactFromResult({ ...result, nativeSha256: 'invalid' })).toThrow();
  });
  it('atomically saves multiple loads with native and local region selectors', () => {
    const source = useAppStore.getState().model;
    const region = { type: 'cad-face', artifactId: cad.artifactId, faceIds: ['body-0/face-0'], toleranceMm: .075 };
    applyStudyConfiguration({ supports: [{ ...source.supports[0], region }],
      loads: [source.loads[0], { ...source.loads[0], id: 'second', region: { type: 'sphere', center: [50, 0, 0], radius: 10 } }], meshSize: 2 });
    expect(useAppStore.getState().model.loads).toHaveLength(2);
    expect(useAppStore.getState().model.supports[0].region?.type).toBe('cad-face');
    expect(useAppStore.getState().model.mesh.cellSizeMm).toBe(2);
    useAppStore.getState().undo();
    expect(useAppStore.getState().model.loads).toHaveLength(1);
  });
  it('rejects stale native face IDs and invalid directions without partial changes', () => {
    const source = useAppStore.getState().model;
    expect(() => applyStudyConfiguration({ loads: [{ ...source.loads[0], vector: [0, 0, 0] }], meshSize: 2 })).toThrow();
    expect(() => applyStudyConfiguration({ supports: [{ ...source.supports[0], region: {
      type: 'cad-face', artifactId: 'f'.repeat(64), faceIds: ['body-0/face-0'], toleranceMm: .05,
    } }] })).toThrow('重新选择');
    expect(useAppStore.getState().model).toBe(source);
  });
  it('persists native artifact references without duplicating large previews', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => storage.set(key, value) });
    const model = { ...useAppStore.getState().model, externalStlBase64: 'large preview' };
    persistProjectLibrary([{ id: 'native', model, createdAt: '', updatedAt: '' }], 'native');
    const saved = JSON.parse(storage.get('vision.project.library.v2')!);
    expect(saved[0].model.cad.artifactId).toBe(cad.artifactId);
    expect(saved[0].model.externalStlBase64).toBeUndefined();
    expect(model.externalStlBase64).toBe('large preview');
  });
  it('provides runtime discovery tools and complete script context for native edits', () => {
    const model = { ...useAppStore.getState().model, externalScript: '#'.repeat(30000) };
    const names = buildDeepSeekTools(model).map((tool) => tool.function.name);
    expect(names).toContain('query_usd_brep');
    expect(names).toContain('configure_study');
    const context = buildModelContext(model, null, false, null, null);
    expect((context.currentModel as { script: string }).script.length).toBe(30000);
    expect(JSON.stringify(context)).toContain(cad.artifactId);
  });
});
