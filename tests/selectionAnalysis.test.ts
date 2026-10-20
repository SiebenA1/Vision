import { expect, it } from 'vitest';
import { parseSelectionAnalysis, SELECTION_ANALYSIS_PROMPT } from '../src/services/selectionAnalysis';
import type { CadInspection } from '../src/services/engineeringBackend';

const input: CadInspection = { artifactId: 'a'.repeat(64), selection: ['body-0/face-0'], catalog: [], properties: [], notes: [], visual: { lines: [], points: [] }, relativeAccuracy: .0001, source: 'native',
  selectionContext: { selected: [{ id: 'body-0/face-0', kind: 'face' }], related: [{ id: 'body-0/edge-0' }], selectedTotal: 1, relatedTotal: 1, truncated: false, recognitionMethod: 'native' },
  availableMetrics: [{ id: 'body-0/face-0:diameter', label: '圆柱面直径', unit: 'mm', method: 'native' }] };
const plan = () => ({ feature: { name: '内凹圆柱面', confidence: 'geometry_evidence', explanation: '圆边和内向径向法线支持此判断，无法确认用途。', evidenceIds: ['body-0/face-0'] },
  parameters: [{ metricId: 'body-0/face-0:diameter', label: '孔壁直径', reason: '用于评估配合尺寸', value: 99999, unit: 'm', anchor: [999, 999, 999] }],
  considerations: [{ name: '配合公差', reason: '用途可能涉及配合', requiredData: '需要配合零件及公差等级', status: 'needs_context' }] });

it('accepts grounded planning but discards every LLM-supplied value, unit and coordinate', () => {
  const parsed = parseSelectionAnalysis(JSON.stringify(plan()), input);
  expect(parsed.parameters).toEqual([{ metricId: 'body-0/face-0:diameter', label: '孔壁直径', reason: '用于评估配合尺寸' }]);
  expect(parsed.considerations[0].status).toBe('needs_context');
  expect(SELECTION_ANALYSIS_PROMPT).toContain('不自动等于盲孔深度');
});

it('rejects non-existent measurements, foreign objects and duplicate requests', () => {
  const unknown = plan(); unknown.parameters[0].metricId = 'execute_python';
  expect(() => parseSelectionAnalysis(JSON.stringify(unknown), input)).toThrow('不可用');
  const foreign = plan(); foreign.feature.evidenceIds = ['body-99/face-0'];
  expect(() => parseSelectionAnalysis(JSON.stringify(foreign), input)).toThrow('上下文之外');
  const duplicate = plan(); duplicate.parameters.push(duplicate.parameters[0]);
  expect(() => parseSelectionAnalysis(JSON.stringify(duplicate), input)).toThrow('重复');
});

it('allows an uncertain result with explicit missing evidence and no fabricated measurement', () => {
  const value = plan(); value.parameters = []; value.feature.confidence = 'uncertain';
  expect(parseSelectionAnalysis('```json\n' + JSON.stringify(value) + '\n```', input).parameters).toEqual([]);
  value.considerations = [];
  expect(() => parseSelectionAnalysis(JSON.stringify(value), input)).toThrow('未给出');
});
