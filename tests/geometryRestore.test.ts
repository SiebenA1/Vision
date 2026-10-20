import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBlankProjectModel } from '../src/core/projects';
import { useAppStore } from '../src/state/store';
import { loadCadPreview } from '../src/services/engineeringBackend';
import type { CadArtifact } from '../src/core/cad/types';

const initial = useAppStore.getState();
const artifactId = 'a'.repeat(64);
function preview() {
  const bytes = new Uint8Array(134);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  view.setFloat32(108, 10, true);
  view.setFloat32(124, 10, true);
  return new Response(bytes);
}
beforeEach(() => {
  useAppStore.setState({ ...initial, geometry: null, model: { ...createBlankProjectModel(), template: 'external',
    cad: { artifactId, nativeSha256: 'b'.repeat(64) } as CadArtifact } });
});
afterEach(() => { useAppStore.setState(initial); vi.unstubAllGlobals(); });

it('retains the saved model on HTTP 503 and restores it after reconnecting', async () => {
  const source = useAppStore.getState().model;
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: '计算后端不可用（http://127.0.0.1:8111）。' }), { status: 503 }))
    .mockResolvedValueOnce(preview());
  vi.stubGlobal('fetch', fetch);
  expect(await useAppStore.getState().rebuildGeometry()).toBeNull();
  expect(useAppStore.getState().geometryError).toContain('计算后端不可用');
  expect(useAppStore.getState().geometryError).not.toContain('原生制品不可用');
  expect(useAppStore.getState().model).toBe(source);
  expect(await useAppStore.getState().rebuildGeometry()).not.toBeNull();
  expect(useAppStore.getState().geometryError).toBeNull();
  expect(useAppStore.getState().model.cad?.artifactId).toBe(artifactId);
  expect(fetch).toHaveBeenCalledWith(`/api/engineering/cad/artifacts/${artifactId}/preview.stl`, { cache: 'no-store' });
});

it('reports missing artifacts only when the backend actually returns HTTP 404', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
  await expect(loadCadPreview(artifactId)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('HTTP 404') });
});

it('reports a network outage without suggesting the native artifact was deleted', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await useAppStore.getState().rebuildGeometry();
  expect(useAppStore.getState().geometryError).toContain('无法连接几何后端');
  expect(useAppStore.getState().model.cad?.artifactId).toBe(artifactId);
});

it('does not let an older failed restore overwrite a newer successful retry', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; })).mockResolvedValueOnce(preview()));
  const first = useAppStore.getState().rebuildGeometry();
  await useAppStore.getState().rebuildGeometry();
  resolve(new Response('{}', { status: 503 })); await first;
  expect(useAppStore.getState().geometryError).toBeNull();
  expect(useAppStore.getState().geometry?.triangleCount).toBe(1);
  expect(useAppStore.getState().building).toBe(false);
});
