import { afterEach, expect, it, vi } from 'vitest';
import { loadCadApiIndex, queryCadApi } from '../src/services/engineeringBackend';

afterEach(() => vi.unstubAllGlobals());

it('conditionally reuses the kernel index and invalidates cached signatures when its fingerprint changes', async () => {
  const catalog = (fingerprint: string) => ({ schema: 'vision.cad.api-index/1', fingerprint, version: fingerprint, groups: [], entries: [], total: 0, usage: '' });
  const docs = (version: string) => ({ version, python: '', groups: [], entries: [{ group: 'usd_brep', name: 'create_box', symbol: 'usd_brep.create_box', kind: 'function', documentation: version }] });
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(catalog('v1')))
    .mockResolvedValueOnce(Response.json(docs('v1')))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(Response.json(catalog('v2')))
    .mockResolvedValueOnce(Response.json(docs('v2')));
  vi.stubGlobal('fetch', fetcher);
  await loadCadApiIndex();
  expect((await queryCadApi('usd_brep.create_box')).version).toBe('v1');
  expect((await queryCadApi('usd_brep.create_box')).version).toBe('v1');
  await loadCadApiIndex();
  expect(fetcher.mock.calls[2][1].headers['If-None-Match']).toBe('"v1"');
  await loadCadApiIndex();
  expect((await queryCadApi('usd_brep.create_box')).version).toBe('v2');
  expect(fetcher).toHaveBeenCalledTimes(5);
});
