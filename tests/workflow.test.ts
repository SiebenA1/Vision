import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProjectModel } from '../src/core/projects';
import { geometryFingerprint, studyFingerprint } from '../src/core/provenance';
import { useAppStore } from '../src/state/store';
import { runStudy, runValidation } from '../src/services/simulation';
import { solveFea, validateFea, type FeaSolveResult } from '../src/services/engineeringBackend';
import { buildReportMarkdown } from '../src/core/report/report';
import { toolAction } from '../src/services/deepseekAgent';
import { getMaterial } from '../src/core/materials';
import type { GeometryData } from '../src/core/types';

vi.mock('../src/services/engineeringBackend', () => ({ solveFea: vi.fn(), validateFea: vi.fn() }));
const geometry: GeometryData = {
  positions: new Float32Array([0, 0, 0]), indices: new Uint32Array(),
  bbox: { min: [0, 0, 0], max: [10, 10, 10] }, volumeMm3: 1000, areaMm2: 600,
  triangleCount: 1, vertexCount: 1, buildMs: 0, watermark: 'STL-TEST',
};
const raw: FeaSolveResult = {
  schema: 'vision.fea/1', nodes: 1, elements: 1, dofs: 3, h: 4, volume_mm3: 1000,
  mass_kg: 0.0027, maxVonMises: 10, maxVonMisesLocation: [0, 0, 0],
  maxDisplacement: 0.1, maxDisplacementLocation: [0, 0, 0], safetyFactor: 27.6,
  positions: [0, 0, 0], displacement: [0, 0, -0.1], vonMises: [10], loadArea: 100,
};
const initial = useAppStore.getState();

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: vi.fn() });
  const model = createBlankProjectModel();
  model.template = 'external';
  model.externalScript = 'result = body';
  const bytes = new Uint8Array(134);
  new DataView(bytes.buffer).setUint32(80, 1, true);
  model.externalStlBase64 = btoa(String.fromCharCode(...bytes));
  useAppStore.setState({ ...initial, model, geometry, activeProjectId: 'project-a',
    analysis: null, analysisStatus: 'idle', resultStale: false, validationStatus: 'idle' });
  vi.mocked(solveFea).mockReset();
  vi.mocked(validateFea).mockReset().mockImplementation(() => new Promise(() => {}));
});
afterEach(() => { useAppStore.setState(initial); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('engineering workflow integrity', () => {
  it('fingerprints geometry content independently of project labels and study inputs', () => {
    const model = structuredClone(useAppStore.getState().model);
    const hash = studyFingerprint(model);
    const geom = geometryFingerprint(model);
    model.name = 'renamed'; model.code = 'CAD-RENAMED';
    expect(studyFingerprint(model)).toBe(hash);
    model.loads[0].magnitude += 1;
    expect(studyFingerprint(model)).not.toBe(hash);
    expect(geometryFingerprint(model)).toBe(geom);
    model.externalStlBase64 = 'STL-B';
    expect(geometryFingerprint(model)).not.toBe(geom);
  });

  it('deduplicates an active solve and invalidates completed evidence immediately', async () => {
    const job = deferred<FeaSolveResult>();
    vi.mocked(solveFea).mockReturnValue(job.promise);
    const first = runStudy({ silentToast: true });
    const second = runStudy({ silentToast: true });
    expect(first).toBe(second);
    job.resolve(raw);
    const result = await first;
    expect(solveFea).toHaveBeenCalledTimes(1);
    expect(result?.equilibrium.relativeError).toBeNull();
    expect(result?.solver.converged).toBeNull();
    expect(result?.mesh.quality.minScaledJacobian).toBeNull();
    expect(useAppStore.getState().resultStale).toBe(false);
    useAppStore.getState().setLoadMagnitude(123);
    expect(useAppStore.getState().resultStale).toBe(true);
    expect(() => buildReportMarkdown(useAppStore.getState().model, result!, null)).toThrow('不一致');
  });

  it('discards success after an input change even if transport ignores abort', async () => {
    const job = deferred<FeaSolveResult>();
    vi.mocked(solveFea).mockReturnValue(job.promise);
    const study = runStudy({ silentToast: true });
    await Promise.resolve();
    const signal = vi.mocked(solveFea).mock.calls[0][1];
    useAppStore.getState().setLoadMagnitude(321);
    expect(signal?.aborted).toBe(true);
    job.resolve(raw);
    expect(await study).toBeNull();
    expect(useAppStore.getState().analysis).toBeNull();
    expect(useAppStore.getState().analysisStatus).toBe('idle');
  });

  it('does not write an old failure into a different project', async () => {
    const job = deferred<FeaSolveResult>();
    vi.mocked(solveFea).mockReturnValue(job.promise);
    const study = runStudy({ silentToast: true });
    await Promise.resolve();
    useAppStore.setState({ activeProjectId: 'project-b' });
    job.reject(new Error('old job failed'));
    expect(await study).toBeNull();
    expect(useAppStore.getState().analysisError).toBeNull();
  });

  it('keeps prior results distinct from an active run and publishes completion atomically', async () => {
    vi.mocked(solveFea).mockResolvedValueOnce(raw);
    const previous = await runStudy({ silentToast: true });
    const job = deferred<FeaSolveResult>();
    vi.mocked(solveFea).mockReturnValueOnce(job.promise);
    const observed: Array<{status: string; progress: unknown}> = [];
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.analysis && state.analysis !== previous) observed.push({status: state.analysisStatus, progress: state.solveProgress});
    });
    const next = runStudy({ silentToast: true });
    await Promise.resolve();
    expect(useAppStore.getState().analysis).toBe(previous);
    expect(useAppStore.getState().analysisStatus).toBe('solve');
    expect(useAppStore.getState().solveProgress?.percent).toBeNull();
    job.resolve({...raw,maxVonMises:12});
    const result = await next;
    unsubscribe();
    expect(result?.maxVonMises).toBe(12);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(state => state.status === 'ready' && state.progress === null)).toBe(true);
  });

  it('clears progress when an externally cancelled transport still returns a result', async () => {
    const job = deferred<FeaSolveResult>();
    vi.mocked(solveFea).mockReturnValue(job.promise);
    const cancel = new AbortController();
    const study = runStudy({ signal: cancel.signal, silentToast: true });
    await Promise.resolve();
    cancel.abort();
    job.resolve(raw);
    expect(await study).toBeNull();
    expect(useAppStore.getState().analysis).toBeNull();
    expect(useAppStore.getState().analysisStatus).toBe('idle');
    expect(useAppStore.getState().solveProgress).toBeNull();
  });

  it('runs distinct coarse/fine solves and records an actual comparison', async () => {
    vi.mocked(solveFea).mockResolvedValueOnce(raw).mockResolvedValueOnce({ ...raw, h: 2.2, elements: 3, maxDisplacement: 0.11 });
    const result = await runStudy({ refinement: true, silentToast: true });
    expect(vi.mocked(solveFea).mock.calls.map(([input]) => input.meshSize)).toEqual([4, 4 / 1.8]);
    expect(result?.convergence?.deltaPercent).toBeCloseTo(9.0909, 3);
    const report = buildReportMarkdown(useAppStore.getState().model, result!, null);
    expect(report).toContain('UNVERIFIED');
    expect(report).toContain('TetGen');
    expect(report).not.toContain('OCCT');
  });

  it('rejects refinement when the backend clamps to the same mesh size', async () => {
    vi.mocked(solveFea).mockResolvedValue(raw);
    expect(await runStudy({ refinement: true, silentToast: true })).toBeNull();
    expect(useAppStore.getState().analysisError).toContain('不能宣称');
  });

  it('does not strand a running benchmark when requested twice', async () => {
    const job = deferred<Awaited<ReturnType<typeof validateFea>>>();
    vi.mocked(validateFea).mockReturnValue(job.promise);
    const first = runValidation();
    await runValidation();
    job.resolve({ caseId: 'beam', name: 'beam', reference: 1, computed: 1,
      errorPercent: 0, passed: true, tolerancePercent: 8, formula: 'PL^3/3EI', meshElements: 10, solveMs: 1 });
    await first;
    expect(validateFea).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().validationStatus).toBe('ready');
  });

  it('preserves load direction ratios and rejects non-finite edits', () => {
    useAppStore.getState().setLoadDirection([1, 2, -3]);
    expect(useAppStore.getState().model.loads[0].vector).toEqual([1, 2, -3]);
    expect(() => useAppStore.getState().setLoadDirection([0, 0, 0])).toThrow();
    expect(() => useAppStore.getState().setLoadMagnitude(NaN)).toThrow();
  });

  it('keeps the current material when a CAD tool call omits it', () => {
    useAppStore.getState().setMaterial('STEEL-4340');
    const action = toolAction({ id: 'cad', type: 'function', function: {
      name: 'run_usd_brep', arguments: JSON.stringify({ script: 'result = body' }),
    } });
    expect(action.args.materialId).toBe('STEEL-4340');
  });

  it('preserves engineering setup and history during in-place CAD adoption', () => {
    const bytes = new Uint8Array(134);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, 1, true);
    view.setFloat32(108, 10, true); view.setFloat32(124, 10, true);
    const source = structuredClone(useAppStore.getState().model);
    source.materialId = 'STEEL-4340';
    source.loads[0].magnitude = 432;
    useAppStore.setState({ model: source, projects: [{ id: 'project-a', model: source, createdAt: '', updatedAt: '' }] });
    useAppStore.getState().adoptExternalModel({ name: 'ignored', script: 'new script',
      stlBase64: btoa(String.fromCharCode(...bytes)), metrics: { volume_mm3: 1000, area_mm2: 600,
        bbox_mm: { min: [0, 0, 0], max: [10, 10, 10], size: [10, 10, 10] } } });
    const state = useAppStore.getState();
    expect(state.model.loads).toEqual(source.loads);
    expect(state.model.mesh).toEqual(source.mesh);
    expect(state.model.materialId).toBe(source.materialId);
    expect(state.geometryMetrics?.massKg).toBeCloseTo(getMaterial(source.materialId).rho * 1e-6);
    state.undo();
    expect(useAppStore.getState().model.externalScript).toBe(source.externalScript);
  });
});
