import type { AgentAction, ChatMessage, ChatPlanStep } from '../core/types';
import { parseEngineeringPrompt } from '../core/agent/nlu';
import { fmt } from '../lib/format';
import { isLlmConfigured, useLlmStore } from '../state/llmStore';
import { useAppStore } from '../state/store';
import { AgentAbortedError, runDeepSeekTurn } from './deepseekAgent';
import { executeTool, labelForAction, type LastResultRef } from './agentTools';
import { describeApiError } from '../core/llm/client';
import { wait } from './simulation';

let activeController: AbortController | null = null;

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function getAssistantMessage(id: string): ChatMessage | undefined {
  return useAppStore.getState().chat.find((message) => message.id === id);
}

function setStep(id: string, stepId: string, patch: Partial<ChatPlanStep>) {
  const message = getAssistantMessage(id);
  if (!message?.steps) return;
  useAppStore.getState().updateMessage(id, {
    steps: message.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
  });
}

async function runLocalTurn(prompt: string): Promise<void> {
  useAppStore.getState().setAgentSource('local');
  const state = useAppStore.getState();
  const plan = parseEngineeringPrompt(prompt, state.model);
  const messageId = uid('assistant');
  const steps: ChatPlanStep[] = plan.actions.map((action, index) => ({
    id: `step_${index}`,
    label: labelForAction(action),
    status: 'queued',
  }));
  useAppStore.getState().addMessage({
    id: messageId,
    role: 'assistant',
    content: plan.summary,
    createdAt: Date.now(),
    steps,
    streaming: true,
    meta: { kind: plan.actions.length ? 'action' : 'insight', source: 'local' },
  });
  await wait(220);

  if (plan.actions.length === 0) {
    useAppStore.getState().updateMessage(messageId, {
      content: plan.summary,
      streaming: false,
      meta: {
        kind: 'question',
        source: 'local',
        chips:
          plan.intent === 'help'
            ? ['运行基线校核', '哪里最危险？', '以质量最小为目标优化悬臂厚度']
            : ['把悬臂厚度改为 14 mm 并校核', '末端加载 1.2 kN 向下', '生成工程校核报告'],
      },
    });
    return;
  }

  const summaries: string[] = [];
  const lastResultRef: LastResultRef = { value: useAppStore.getState().analysis };
  let failed = false;
  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index];
    setStep(messageId, `step_${index}`, { status: 'running' });
    try {
      const result = await executeTool(action, lastResultRef);
      setStep(messageId, `step_${index}`, { status: 'done', detail: result.detail });
      if (result.summary) summaries.push(result.summary);
    } catch (error) {
      failed = true;
      setStep(messageId, `step_${index}`, {
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
      summaries.push(`**执行失败：** ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    await wait(120);
  }

  const stateNow = useAppStore.getState();
  const result = stateNow.analysis;
  const ending =
    !failed && result && plan.actions.some((action) => action.tool === 'run_analysis')
      ? `\n\n当前控制指标：**SF ${fmt(result.safetyFactor, 2)}** / **δmax ${fmt(
          result.maxDisplacement,
          3,
        )} mm**。${
          result.safetyFactor >= 2.0
            ? '满足 SF ≥ 2.00 的当前设计目标。'
            : '未满足 SF ≥ 2.00，建议调整几何或材料。'
        }`
      : '';
  const componentsAreCsg = stateNow.model.template === 'csg';
  const componentsAreBlade = stateNow.model.template === 'blade';
  const componentsAreWheel = componentsAreCsg && /轮辋|轮毂|rim/i.test(stateNow.model.name);
  const chips = result
    ? componentsAreWheel
      ? ['哪里最危险？', '生成工程校核报告', '切换为 7075-T6']
      : componentsAreCsg
        ? ['哪里最危险？', '生成工程校核报告', '切换为 7075-T6']
        : componentsAreBlade
          ? ['哪里最危险？', '生成工程校核报告', '把叶片长度改为 2200 mm']
          : ['哪里最危险？', '以 SF ≥ 2.5 优化悬臂厚度', '生成工程校核报告']
    : componentsAreWheel
      ? ['运行基线校核', '哪里最危险？', '切换为 7075-T6']
      : componentsAreCsg
        ? ['运行基线校核', '哪里最危险？', '切换为 7075-T6']
        : componentsAreBlade
          ? ['运行基线校核', '哪里最危险？', '把叶片长度改为 2200 mm']
          : ['运行基线校核', '把悬臂厚度改为 14 mm', '切换为 7075-T6'];
  useAppStore.getState().updateMessage(messageId, {
    content: summaries.filter(Boolean).join('\n\n') + ending,
    streaming: false,
    meta: {
      kind: failed ? 'question' : plan.actions.some((action) => action.tool === 'optimize') ? 'action' : 'insight',
      source: 'local',
      chips,
    },
  });
}

export async function sendAgentPrompt(prompt: string): Promise<void> {
  const value = prompt.trim();
  if (!value) return;
  if (useAppStore.getState().chatBusy) return;

  useAppStore.getState().setChatBusy(true);
  useAppStore.getState().addMessage({
    id: uid('user'),
    role: 'user',
    content: value,
    createdAt: Date.now(),
  });

  const llm = useLlmStore.getState();
  if (llm.settings.preferDeepSeek && !isLlmConfigured()) {
    await useLlmStore.getState().refreshGateway();
  }
  const useDeepSeek = useLlmStore.getState().settings.preferDeepSeek && isLlmConfigured();

  try {
    if (useDeepSeek) {
      activeController = new AbortController();
      try {
        await runDeepSeekTurn(value, activeController.signal);
        return;
      } catch (error) {
        if (error instanceof AgentAbortedError) {
          useAppStore.getState().addToast({
            title: '已停止生成',
            detail: 'DeepSeek 请求已取消，未执行后续工具。',
            tone: 'neutral',
          });
          return;
        }
        const described = describeApiError(error);
        useAppStore.getState().addToast({
          title: 'DeepSeek 调用失败',
          detail: `${described.message} · 已切换到本地规划器`,
          tone: 'warning',
        });
        useAppStore.getState().addMessage({
          id: uid('assistant'),
          role: 'assistant',
          content: `**DeepSeek 不可用**\n${described.message}\n\n已回退到本地确定性规划器；你可以在 ATLAS 头部打开 DeepSeek 设置。`,
          createdAt: Date.now(),
          meta: { kind: 'question', source: 'system' },
        });
      }
    } else if (llm.settings.preferDeepSeek) {
      useAppStore.getState().addToast({
        title: 'DeepSeek 尚未配置',
        detail: '正在使用本地确定性规划器。点击 ATLAS 的模型状态可配置 API Key。',
        tone: 'neutral',
      });
    }

    await runLocalTurn(value).catch((error: unknown) => {
      useAppStore.getState().addToast({
        title: '规划器执行失败',
        detail: error instanceof Error ? error.message : String(error),
        tone: 'error',
      });
    });
  } finally {
    activeController = null;
    useAppStore.getState().setAgentSource(null);
    useAppStore.getState().setChatBusy(false);
  }
}

export function stopAgent(): void {
  activeController?.abort();
}
