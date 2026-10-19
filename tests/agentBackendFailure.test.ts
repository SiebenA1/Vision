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
