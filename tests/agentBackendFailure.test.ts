import { afterEach, expect, it, vi } from 'vitest';
import { resetDeepSeekConversation } from '../src/services/deepseekAgent';
import { sendAgentPrompt } from '../src/services/agent';
import { createDeepSeekCompletion } from '../src/core/llm/client';
import { executeTool } from '../src/services/agentTools';
import { EngineeringBackendError } from '../src/services/engineeringBackend';
import { useAppStore } from '../src/state/store';
import { useLlmStore } from '../src/state/llmStore';

vi.mock('../src/core/llm/client', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/llm/client')>(), createDeepSeekCompletion: vi.fn(),
}));
vi.mock('../src/services/agentTools', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/agentTools')>(), executeTool: vi.fn(),
}));
const initialApp = useAppStore.getState();
const initialLlm = useLlmStore.getState();
afterEach(() => {
  useAppStore.setState(initialApp); useLlmStore.setState(initialLlm);
  resetDeepSeekConversation(); vi.unstubAllGlobals(); vi.clearAllMocks();
});
it('stops after unavailable backend instead of repeating tools or blaming the AI key', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  useAppStore.setState({chat:[],toasts:[],chatBusy:false});
  useLlmStore.setState({serverKey:true,settings:{...initialLlm.settings,preferDeepSeek:true}});
  vi.mocked(createDeepSeekCompletion).mockResolvedValue({
    content:'', reasoning:'', latencyMs:1, finishReason:'tool_calls', model:'test-model', usage:{promptTokens:1,completionTokens:1,totalTokens:2},
    toolCalls:[{id:'cad-query',type:'function',function:{name:'query_usd_brep',arguments:'{"query":"create_box"}'}}],
  });
  const failure = new EngineeringBackendError('计算后端不可用（http://127.0.0.1:8111）',503);
  vi.mocked(executeTool).mockRejectedValue(failure);
  await sendAgentPrompt('建一个盒子');
  expect(executeTool).toHaveBeenCalledTimes(1);
  expect(createDeepSeekCompletion).toHaveBeenCalledTimes(1);
  const message=useAppStore.getState().chat.at(-1)!;
  expect(message.content).toContain('工程后端调用失败');
  expect(message.content).not.toContain('API Key');
  expect(message.streaming).toBe(false);
  expect(useAppStore.getState().toasts.at(-1)?.title).toBe('工程后端调用失败');
  expect(useAppStore.getState().chatBusy).toBe(false);
  expect(useLlmStore.getState().connectionError).toBe(initialLlm.connectionError);
});

it('continues a large thinking/tool turn and refers to previously supplied API documentation', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  useAppStore.setState({ chat: [], toasts: [], chatBusy: false });
  useLlmStore.setState({ serverKey: true, settings: { ...initialLlm.settings, preferDeepSeek: true, thinking: true } });
  const reasoning = 'x'.repeat(200000);
  const completion = { content: '', reasoning, latencyMs: 1, finishReason: 'tool_calls', model: 'fixture', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    toolCalls: [{ id: 'api-1', type: 'function' as const, function: { name: 'query_usd_brep', arguments: '{"query":"create_box"}' } }] };
  vi.mocked(executeTool).mockImplementation(async () => ({ ok: true, summary: '', detail: 'API', state: { api: { version: 'fixture', entries: [{ symbol: 'usd_brep.create_box', documentation: 'native signature' }] } } }));
  vi.mocked(createDeepSeekCompletion).mockResolvedValueOnce(completion)
    .mockResolvedValueOnce({ ...completion, reasoning: '', toolCalls: [{ ...completion.toolCalls[0], id: 'api-2' }] })
    .mockImplementationOnce(async request => {
      expect(request.messages.find(message => message.role === 'assistant' && message.reasoning_content)?.reasoning_content).toBe(reasoning);
      const tools = request.messages.filter(message => message.role === 'tool');
      expect(JSON.parse(tools[0].content!).state.api.entries[0].documentation).toBe('native signature');
      expect(JSON.parse(tools[1].content!).state.apiReference.alreadyProvided).toBe(true);
      return { ...completion, content: '已核对接口，尚未执行建模。', reasoning: '', finishReason: 'stop', toolCalls: [] };
    });
  await sendAgentPrompt('核对盒子接口');
  expect(createDeepSeekCompletion).toHaveBeenCalledTimes(3);
  expect(useAppStore.getState().chat.at(-1)?.content).toContain('已核对接口');
  expect(useLlmStore.getState().connectionError).toBe(initialLlm.connectionError);
});

it('reports a local task error without marking the provider unavailable or running fallback', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  useAppStore.setState({ chat: [], toasts: [], chatBusy: false });
  useLlmStore.setState({ serverKey: true, settings: { ...initialLlm.settings, preferDeepSeek: true } });
  vi.mocked(createDeepSeekCompletion).mockRejectedValueOnce(new Error('本地上下文整理失败'));
  await sendAgentPrompt('建一个盒子');
  expect(executeTool).not.toHaveBeenCalled();
  expect(useAppStore.getState().chat.at(-1)?.content).toContain('工程任务未完成');
  expect(JSON.stringify(useAppStore.getState().chat)).not.toContain('DeepSeek 不可用');
  expect(useLlmStore.getState().connectionError).toBe(initialLlm.connectionError);
});
