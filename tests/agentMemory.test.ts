import { expect, it } from 'vitest';
import { boundedHistory, memoryData, memoryScope } from '../src/services/agentMemory';
import { createBlankProjectModel } from '../src/core/projects';
import type { DeepSeekMessage } from '../src/core/llm/types';

it('keeps tool calls/results together and never restores an incomplete tool group', () => {
  const group: DeepSeekMessage[] = [
    { role: 'user', content: '改孔径' },
    { role: 'assistant', content: null, reasoning_content: 'protocol field', tool_calls: [{ id: 'call', type: 'function', function: { name: 'run_usd_brep', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call', content: '{"ok":true}' },
    { role: 'assistant', content: '已修改' },
  ];
  expect(boundedHistory(group)).toEqual(group);
  expect(boundedHistory(group.slice(0, 3))).toEqual([]);
  const newest: DeepSeekMessage[] = [{ role: 'user', content: '新任务' }, { role: 'assistant', content: '新回答' }];
  expect(boundedHistory([...group, ...newest], JSON.stringify(newest).length)).toEqual(newest);
  expect(boundedHistory([{ role: 'tool', content: 'dangling', tool_call_id: 'old' }, ...newest])).toEqual(newest);
});

it('snapshots omit script and mesh blobs but bind material and geometry', () => {
  const model = createBlankProjectModel();
  model.externalScript = 'private-script'; model.externalStlBase64 = 'private-mesh';
  const scope = memoryScope(model);
  const serialized = JSON.stringify(scope);
  expect(serialized).not.toContain('private-script');
  expect(serialized).not.toContain('private-mesh');
  expect(scope.snapshot.material.rho).toBeGreaterThan(0);
  expect(scope.snapshot.geometryKey).toBeTruthy();
  expect(scope.projectId).toContain(model.id);
});

it('does not present a failed recall as restored knowledge', () => {
  expect(memoryData(null)).toMatchObject({ status: 'unavailable' });
});
