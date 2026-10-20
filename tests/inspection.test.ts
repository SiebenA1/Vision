import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInspectionStore } from '../src/state/inspectionStore';
import { useAppStore } from '../src/state/store';
import { createBlankProjectModel } from '../src/core/projects';
import type { CadArtifact } from '../src/core/cad/types';

const initial = useAppStore.getState();
const result = (selection: string[]) => new Response(JSON.stringify({ artifactId: 'a'.repeat(64), selection, catalog: [], properties: [], notes: [], visual: { lines: [], points: [] }, relativeAccuracy: .0001, source: 'native' }));
beforeEach(() => {
  useAppStore.setState({ model: { ...createBlankProjectModel(), cad: { artifactId: 'a'.repeat(64) } as CadArtifact } });
  useInspectionStore.getState().reset();
});
afterEach(() => { useInspectionStore.getState().reset(); useAppStore.setState(initial); vi.unstubAllGlobals(); });

it('discards out-of-order native measurements even if the transport ignores abort', async () => {
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))));
  const first = useInspectionStore.getState().measure(['body-0/face-0']);
  const last = useInspectionStore.getState().measure(['body-0/edge-0']);
  pending[1](result(['body-0/edge-0'])); await last;
  pending[0](result(['body-0/face-0'])); await first;
  expect(useInspectionStore.getState().result?.selection).toEqual(['body-0/edge-0']);
});

it('clears an old selection and rejects its result after changing geometry', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolve = r; })));
  const pending = useInspectionStore.getState().measure(['body-0']);
  useAppStore.setState({ model: { ...useAppStore.getState().model, cad: { artifactId: 'b'.repeat(64) } as CadArtifact } });
  useInspectionStore.getState().reset();
  resolve(result(['body-0'])); await pending;
  expect(useInspectionStore.getState().selection).toEqual([]);
  expect(useInspectionStore.getState().result).toBeNull();
  expect(useInspectionStore.getState().busy).toBe(false);
});

it('reports backend failures and clears previous physical properties', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(result(['body-0'])).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'native geometry unavailable' }), { status: 400 })));
  await useInspectionStore.getState().measure(['body-0']);
  await useInspectionStore.getState().measure(['body-9']);
  expect(useInspectionStore.getState().result).toBeNull();
  expect(useInspectionStore.getState().error).toContain('native geometry unavailable');
});

it('keeps the whole-model physical summary while inspecting a face and clears it for a new geometry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(result([])).mockResolvedValueOnce(result(['body-0/face-0'])));
  await useInspectionStore.getState().measure([]);
  const summary = useInspectionStore.getState().summary;
  await useInspectionStore.getState().measure(['body-0/face-0']);
  expect(useInspectionStore.getState().summary).toBe(summary);
  expect(useInspectionStore.getState().result?.selection).toEqual(['body-0/face-0']);
  useInspectionStore.getState().reset();
  expect(useInspectionStore.getState().summary).toBeNull();
});
