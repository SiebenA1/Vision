import { describe, expect, it } from 'vitest';
import { applySelectedFaces, setAnalysisBodies, studyMarkers, boundaryAnchor, forceComponents, regionLabel, requirementStatus } from '../src/features/workspace/simulationHelpers';
import type { CoreAssessment, CoreRevision, CoreStudy } from '../src/features/workspace/api';

describe('simulation review evidence', () => {
  it('resolves column end markers within the selected body, not the taller dial', () => {
    const box = (z0: number, z1: number) => ({ min: [-20, -20, z0], max: [20, 20, z1] });
    const bodies = [{ id: 'body-1', kind: 'solid', bbox_mm: box(15, 230), faces: [
      { id: 'body-1/face-0', bbox_mm: box(15, 230) }, { id: 'body-1/face-1', bbox_mm: box(15, 15) }, { id: 'body-1/face-2', bbox_mm: box(230, 230) }] },
      { id: 'body-2', kind: 'solid', bbox_mm: box(215, 435), faces: [{ id: 'body-2/face-0', bbox_mm: box(435, 435) }] }];
    const study: CoreStudy = { material: { E: 210000, nu: .3, rho: 7850, yieldStrength: 235 }, supports: [{ id: 'fixed', face: 'z-min' }],
      loads: [{ id: 'load', face: 'z-max', magnitude: 50, vector: [1, 0, 0] }], mesh_size: 3, body_ids: ['body-1'], body_artifact_id: 'geometry' };
    const markers = studyMarkers(study, { geometry: 'geometry' } as CoreRevision['document'], bodies, []);
    expect(markers).toHaveLength(2);
    expect(markers[0].region).toMatchObject({ faceIds: ['body-1/face-1'] });
    expect(markers[1].region).toMatchObject({ faceIds: ['body-1/face-2'] });
    expect(markers[1].force).toEqual([50, 0, 0]);
    expect(studyMarkers({ ...study, body_artifact_id: 'old' }, { geometry: 'geometry' } as CoreRevision['document'], bodies, [])).toEqual([]);
  });
  it('sets a draft scope before boundary conditions and preserves existing edits', () => {
    const study: CoreStudy = { material: { E: 200000, nu: .3, rho: 7850, yieldStrength: 235 }, supports: [], loads: [], mesh_size: 2 };
    const scoped = setAnalysisBodies(study, ['body-1'], 'geometry', ['body-0', 'body-1']);
    expect(scoped.body_ids).toEqual(['body-1']);
    expect(scoped.body_artifact_id).toBe('geometry');
    expect(scoped.supports).toEqual([]);
    expect(scoped.material.E).toBe(200000);
    expect(study.body_ids).toBeUndefined();
    expect(setAnalysisBodies(scoped, null, 'geometry', ['body-1'])).toMatchObject({ body_ids: null, body_artifact_id: null, mesh_size: 2 });
    expect(() => setAnalysisBodies(study, ['body-1/face-0'], 'geometry', ['body-1'])).toThrow('闭合实体');
    expect(() => setAnalysisBodies(study, ['body-9'], 'geometry', ['body-1'])).toThrow('闭合实体');
  });
  it('attaches glyphs to selected points instead of an empty centroid', () => {
    const separated = [[-10, 0, 0], [-9, 0, 0], [9, 0, 0], [10, 0, 0]];
    expect(separated).toContainEqual(boundaryAnchor(separated));
    expect(boundaryAnchor(separated)).not.toEqual([0, 0, 0]);
    expect(boundaryAnchor([], [0, 0, 0])).toBeUndefined();
    expect(boundaryAnchor([[NaN, 0, 0]])).toBeUndefined();
  });
  it('binds graphical selections without overwriting other boundaries or loads', () => {
    const study: CoreStudy = { material: { E: 210000, nu: .3, rho: 7850, yieldStrength: 235 }, supports: [], loads: [], mesh_size: 4 };
    const fixed = applySelectedFaces(study, 'support', ['body-0/face-1'], 'geometry', .1, 'fixed');
    const loaded = applySelectedFaces(fixed, 'load', ['body-0/face-2', 'body-0/face-2'], 'geometry', .1, 'load');
    expect(study.supports).toEqual([]);
    expect(loaded.supports).toEqual(fixed.supports);
    expect(loaded.loads[0].region).toMatchObject({ artifactId: 'geometry', faceIds: ['body-0/face-2'] });
    const changed = applySelectedFaces(loaded, 'load', ['body-0/face-3'], 'geometry', .1, 'unused', 0);
    expect(changed.loads[0].id).toBe('load');
    expect(changed.loads[0].magnitude).toBe(100);
    expect(changed.loads[0].vector).toEqual([0, 0, -1]);
    expect(() => applySelectedFaces(study, 'support', ['body-0'], 'geometry', .1, 'bad')).toThrow('选择面');
    expect(() => applySelectedFaces({ ...fixed, body_ids: ['body-0'], body_artifact_id: 'old' }, 'load', ['body-0/face-1'], 'geometry', .1, 'bad')).toThrow('分析体');
    expect(() => applySelectedFaces({ ...fixed, body_ids: ['body-0'], body_artifact_id: 'geometry' }, 'load', ['body-1/face-1'], 'geometry', .1, 'bad')).toThrow('分析体');
  });
  it('uses resultant magnitude and rejects an invalid direction', () => {
    expect(forceComponents({ id: 'force', vector: [0, 3, 4], magnitude: 100 })).toEqual([0, 60, 80]);
    expect(forceComponents({ id: 'force', vector: [0, 0, 0], magnitude: 100 })).toBeNull();
  });
  it('identifies stale native bindings and describes extreme faces as tolerance selections', () => {
    const document = { geometry: 'current', objects: [] } as unknown as CoreRevision['document'];
    expect(regionLabel({ id: 'support', face: 'x-min' }, document)).toContain('容差');
    expect(regionLabel({ id: 'support', region: { type: 'cad-face', artifactId: 'old', faceIds: ['body-0/face-0'], toleranceMm: .1 } }, document)).toContain('需重新绑定');
  });
  it('never turns missing or partial requirements into a pass', () => {
    const assessment = (statuses: string[]) => ({ findings: statuses.map(status => ({ status })) }) as CoreAssessment;
    expect(requirementStatus(null)).toBe('未定义设计指标');
    expect(requirementStatus(assessment(['pass', 'unknown']))).toBe('部分指标未判定');
    expect(requirementStatus(assessment(['pass', 'fail']))).toBe('存在不满足的指标');
    expect(requirementStatus(assessment(['pass']))).toBe('已定义指标满足');
  });
});
