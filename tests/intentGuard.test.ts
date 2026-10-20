import { afterEach, expect, it, vi } from 'vitest';
import { runDeepSeekTurn, resetDeepSeekConversation } from '../src/services/deepseekAgent';
import { createDeepSeekCompletion } from '../src/core/llm/client';
import { compileMemoryContext, memoryRequest } from '../src/services/agentMemory';
import { executeTool } from '../src/services/agentTools';
import { useAppStore } from '../src/state/store';
import { useLlmStore } from '../src/state/llmStore';

vi.mock('../src/core/llm/client', async original => ({ ...await original<typeof import('../src/core/llm/client')>(), createDeepSeekCompletion: vi.fn() }));
vi.mock('../src/services/agentTools', async original => ({ ...await original<typeof import('../src/services/agentTools')>(), executeTool: vi.fn() }));
vi.mock('../src/services/agentMemory', async original => ({ ...await original<typeof import('../src/services/agentMemory')>(), compileMemoryContext: vi.fn(), memoryRequest: vi.fn(), recordMemoryEvent: vi.fn().mockResolvedValue({}), checkpoint: vi.fn().mockResolvedValue({}) }));
const initial = useAppStore.getState();
const llmInitial = useLlmStore.getState();
afterEach(() => { resetDeepSeekConversation(); useAppStore.setState(initial); useLlmStore.setState(llmInitial); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('blocks a geometry action when this turn has unresolved user intent', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  useLlmStore.setState({ serverKey: true });
  const context = { schema: 'vision.context/1' as const, contextId: 'ctx', projectId: '', snapshotId: 'snapshot', revision: 0, epoch: 0, memories: [], excluded: [], resume: null, taskStatus: null, budgetChars: 10000, usedChars: 0, rules: '', executions: [], intent: null, dialogue: [], outcomes: [], retrievedHistory: [] };
  vi.mocked(compileMemoryContext).mockResolvedValue(context);
  vi.mocked(memoryRequest).mockResolvedValue({ intent: { unresolved: ['两个孔中要改哪一个？'], relation: 'revise' } });
  const completion = { content: '', reasoning: '', latencyMs: 1, model: 'fixture', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls', toolCalls: [] };
  vi.mocked(createDeepSeekCompletion).mockImplementationOnce(async request => {
    const data = JSON.parse(request.messages.find(message => message.content?.includes('engineering_context_data'))!.content!);
    return { ...completion, toolCalls: [
      { id: 'intent', type: 'function' as const, function: { name: 'update_task_intent', arguments: JSON.stringify({ sourceEventId: data.userSourceEventId, goal: '修改孔径', relation: 'revise', basedOnEventIds: [], unresolved: ['两个孔中要改哪一个？'] }) } },
      { id: 'cad', type: 'function' as const, function: { name: 'run_usd_brep', arguments: JSON.stringify({ script: 'result = u.create_box((0,0,0),10,10,10)' }) } },
    ] };
  }).mockResolvedValueOnce({ ...completion, content: '需要明确要修改哪一个孔。', finishReason: 'stop' });
  await runDeepSeekTurn('把那个孔改成12', new AbortController().signal);
  expect(executeTool).not.toHaveBeenCalled();
  expect(createDeepSeekCompletion).toHaveBeenCalledTimes(2);
  const second = vi.mocked(createDeepSeekCompletion).mock.calls[1][0];
  expect(second.messages.some(message => message.role === 'tool' && message.content?.includes('未确定的指代'))).toBe(true);
  expect(useAppStore.getState().chat.at(-1)?.content).toContain('明确');
});
