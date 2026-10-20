import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInspectionStore } from '../src/state/inspectionStore';
import { useAppStore } from '../src/state/store';
import { createBlankProjectModel } from '../src/core/projects';
import { planSelectionMeasurements } from '../src/services/selectionAnalysis';
import type { CadArtifact } from '../src/core/cad/types';

vi.mock('../src/services/selectionAnalysis', async importOriginal => ({ ...await importOriginal<typeof import('../src/services/selectionAnalysis')>(), planSelectionMeasurements: vi.fn() }));
const initial = useAppStore.getState();
const raw = (id: string) => ({ inspectionSchema: 'vision.inspection/2', artifactId: 'a'.repeat(64), selection: [id], catalog: [], properties: [], notes: [], visual: { lines: [], points: [] }, relativeAccuracy: .0001, source: 'native' });
const proposal = (metricId: string) => ({ feature: { name: '孔壁', confidence: 'geometry_evidence' as const, explanation: '原生证据', evidenceIds: ['body-0/face-0'] },
  parameters: [{ metricId, label: '关注的孔径', reason: '配合接口' }], considerations: [], model: 'test-llm' });
const json = (value: unknown) => new Response(JSON.stringify(value));
beforeEach(() => {
  useAppStore.setState({ ...initial, model: { ...createBlankProjectModel(), cad: { artifactId: 'a'.repeat(64) } as CadArtifact } });
  useInspectionStore.getState().reset(); useInspectionStore.setState({ smart: true }); vi.mocked(planSelectionMeasurements).mockReset();
});
afterEach(() => { useInspectionStore.getState().reset(); useAppStore.setState(initial); vi.unstubAllGlobals(); });

it('re-queries the native kernel for planned metrics and takes values and anchors only from that response', async () => {
  vi.mocked(planSelectionMeasurements).mockResolvedValue(proposal('diameter'));
  const fetch = vi.fn().mockResolvedValueOnce(json(raw('body-0/face-0'))).mockResolvedValueOnce(json({ ...raw('body-0/face-0'), requestedMetricIds: ['diameter'], properties: [{ id: 'diameter', label: '原生圆柱直径', value: 12, unit: 'mm', anchor: [1, 2, 3] }] }));
  vi.stubGlobal('fetch', fetch);
  await useInspectionStore.getState().measure(['body-0/face-0']);
  await vi.waitFor(() => expect(useInspectionStore.getState().analysisStatus).toBe('ready'));
  const property = useInspectionStore.getState().analysis!.properties[0];
  expect(property).toMatchObject({ label: '关注的孔径', nativeLabel: '原生圆柱直径', value: 12, unit: 'mm', anchor: [1, 2, 3] });
  expect(JSON.parse(fetch.mock.calls[1][1].body).metricIds).toEqual(['diameter']);
});

it('rejects the old LLM response after a newer selection, without issuing its measurement request', async () => {
  let finishOld!: (value: ReturnType<typeof proposal>) => void;
  vi.mocked(planSelectionMeasurements).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValueOnce(proposal('new-metric'));
  const fetch = vi.fn().mockResolvedValueOnce(json(raw('body-0/face-0'))).mockResolvedValueOnce(json(raw('body-0/face-1')))
    .mockResolvedValueOnce(json({ ...raw('body-0/face-1'), requestedMetricIds: ['new-metric'], properties: [{ id: 'new-metric', label: '新选择测量', value: 5, unit: 'mm' }] }));
  vi.stubGlobal('fetch', fetch);
  await useInspectionStore.getState().measure(['body-0/face-0']);
  await useInspectionStore.getState().measure(['body-0/face-1']);
  await vi.waitFor(() => expect(useInspectionStore.getState().analysisStatus).toBe('ready'));
  finishOld(proposal('old-metric'));
  await Promise.resolve();
  expect(useInspectionStore.getState().analysis?.properties[0].value).toBe(5);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('shows LLM failure as an analysis error while retaining the measured geometry', async () => {
  vi.mocked(planSelectionMeasurements).mockRejectedValue(new Error('LLM unavailable'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(raw('body-0/face-0'))));
  await useInspectionStore.getState().measure(['body-0/face-0']);
  await vi.waitFor(() => expect(useInspectionStore.getState().analysisStatus).toBe('error'));
  expect(useInspectionStore.getState().result?.selection).toEqual(['body-0/face-0']);
  expect(useInspectionStore.getState().analysis).toBeNull();
  expect(useInspectionStore.getState().error).toBe('');
});
