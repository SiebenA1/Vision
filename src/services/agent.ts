import type { AgentAction, ChatMessage, ChatPlanStep, FaceId } from '../core/types';
import { parseEngineeringPrompt } from '../core/agent/nlu';
import { getMaterial } from '../core/materials';
import { useAppStore } from '../state/store';
import { runStudy, wait } from './simulation';
import { fmt, vectorLabel } from '../lib/format';

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

function riskNarrative(): string {
  const state = useAppStore.getState();
  const result = state.analysis;
  const geometry = state.geometry;
  if (!result || !geometry) return '尚未获得可用的求解结果。';
  const [x, y, z] = result.maxVonMisesLocation;
  const model = state.model;
  const wallThickness = model.variables.find((variable) => variable.key === 'wallThickness')?.value ?? 10;
  const armLength = model.variables.find((variable) => variable.key === 'armLength')?.value ?? 130;
  let region = '悬臂中段 / 截面过渡区';
  if (x <= wallThickness * 2.6) region = '背板与悬臂根部过渡区';
  else if (x >= armLength * 0.8) region = '端部承力环与销孔边缘';
  else if (Math.abs(y) > 12) region = '加强筋与悬臂腹板连接区';
  const material = getMaterial(model.materialId);
  const margin = ((material.yieldStrength - result.maxVonMises) / material.yieldStrength) * 100;
  const sfPass = result.safetyFactor >= 2.0;
  const drivers: string[] = [];
  if (result.maxDisplacement > 1.2) drivers.push('弯曲刚度');
  if (Math.abs(y) > 10) drivers.push('孔边/筋板的局部应力集中');
  if (result.safetyFactor < 1.8) drivers.push('根部弯曲正应力');
  if (drivers.length === 0) drivers.push('根部弯曲正应力与孔边应力梯度的耦合');
  return [
    `热点位于 **${region}**，坐标 (${fmt(x, 1)}, ${fmt(y, 1)}, ${fmt(z, 1)}) mm。`,
    `峰值 von Mises **${fmt(result.maxVonMises, 1)} MPa**，对应安全系数 **${fmt(result.safetyFactor, 2)}**；距屈服点仍有 ${fmt(margin, 1)}% 的材料裕度。`,
    `当前控制因素：${drivers.join('、')}。${sfPass ? '结构满足 SF ≥ 2.00 的目标，但仍应检查疲劳、屈曲与连接件。' : '结构未满足 SF ≥ 2.00 的目标，建议优先增加根部截面或优化载荷路径。'}`,
    result.warnings.length ? `自动检查提示：${result.warnings[0]}` : '自动检查未发现平衡或收敛异常。',
  ].join('\n\n');
}

function actionResultSummary(action: AgentAction): string {
  const state = useAppStore.getState();
  const result = state.analysis;
  const metrics = state.geometryMetrics;
  if (action.tool === 'run_analysis' && result) {
    return `**校核结果**\n最大应力 **${fmt(result.maxVonMises, 1)} MPa**，最大位移 **${fmt(
      result.maxDisplacement,
      3,
    )} mm**，安全系数 **${fmt(result.safetyFactor, 2)}**，质量 **${fmt(result.massKg, 3)} kg**。求解 ${result.solver.iterations} 次 PCG，相对残差 ${result.solver.relativeResidual.toExponential(2)}。`;
  }
  if (action.tool === 'set_variable') {
    return `已更新 **${action.args.label}** 至 **${action.args.value} ${action.args.unit ?? 'mm'}**，几何已重建${
      metrics ? `（${fmt(metrics.volumeCm3, 1)} cm³ · ${fmt(metrics.massKg, 3)} kg）` : ''
    }。旧结果已标记为待刷新。`;
  }
  if (action.tool === 'set_material') {
    const material = getMaterial(String(action.args.materialId));
    return `材料已切换为 **${material.name}**（E ${fmt(material.E / 1000, 1)} GPa，σy ${material.yieldStrength} MPa）。质量与旧结果的有效性已重新标记。`;
  }
  if (action.tool === 'set_load') {
    return `端部载荷更新为 **${action.args.magnitude} N**，方向 ${vectorLabel(
      String(action.args.direction)
        .split(',')
        .map(Number) as [number, number, number],
    )}，加载面 ${action.args.face}。`;
  }
  if (action.tool === 'set_support') {
    return `约束切换到 **${action.args.name}**（${action.args.face}，6 DOF fixed）。`;
  }
  return '';
}

async function executeAction(
  action: AgentAction,
  messageId: string,
  stepId: string,
  lastResultRef: { value: ReturnType<typeof useAppStore.getState>['analysis'] },
): Promise<string> {
  const store = useAppStore.getState();
  setStep(messageId, stepId, { status: 'running' });
  let detail = '';
  let summary = '';
  if (action.tool === 'set_variable') {
    store.setVariable(String(action.args.key), Number(action.args.value), String(action.args.label));
    await wait(40);
    await useAppStore.getState().rebuildGeometry();
    detail = 'geometry rebuilt · watertight';
    summary = actionResultSummary(action);
    lastResultRef.value = null;
  } else if (action.tool === 'set_material') {
    store.setMaterial(String(action.args.materialId));
    detail = String(action.args.name);
    summary = actionResultSummary(action);
    lastResultRef.value = null;
  } else if (action.tool === 'set_load') {
    const vector = String(action.args.direction)
      .split(',')
      .map(Number) as [number, number, number];
    store.setLoadMagnitude(Number(action.args.magnitude));
    store.setLoadFace(action.args.face as FaceId);
    store.setLoadDirection(vector);
    detail = `${action.args.magnitude} N · ${action.args.face}`;
    summary = actionResultSummary(action);
    lastResultRef.value = null;
  } else if (action.tool === 'set_support') {
    store.setSupportFace(action.args.face as FaceId);
    detail = String(action.args.face);
    summary = actionResultSummary(action);
    lastResultRef.value = null;
  } else if (action.tool === 'run_analysis') {
    const existing = useAppStore.getState().analysis;
    const stale = useAppStore.getState().resultStale;
    let result = existing && !stale ? existing : null;
    if (!result) {
      result = await runStudy({ focusResult: false, silentToast: true });
    } else {
      await wait(180);
    }
    if (result) {
      lastResultRef.value = result;
      detail = `${result.mesh.elements.toLocaleString('en-US')} EL · ${result.solver.iterations} iter`;
      summary = actionResultSummary(action);
      useAppStore.getState().setViewMode('result');
    } else {
      throw new Error(useAppStore.getState().analysisError ?? '求解未返回结果');
    }
  } else if (action.tool === 'optimize') {
    const seed = {
      variableKey: String(action.args.variableKey ?? 'armThickness'),
      targetSafety: Number(action.args.targetSafety ?? 2.0),
      displacementLimit: Number(action.args.displacementLimit ?? 2.0),
      autoRun: true,
    };
    useAppStore.getState().setOptimizationSeed(seed);
    useAppStore.getState().openWorkspace('optimize');
    detail = `SF ≥ ${seed.targetSafety} · δ ≤ ${seed.displacementLimit} mm`;
    summary = `已打开生成式优化工作台，并在浏览器 Worker 中启动 **${seed.variableKey}** 的 FE-in-the-loop 搜索。目标：质量最小，SF ≥ ${seed.targetSafety}，位移 ≤ ${seed.displacementLimit} mm。你可以实时查看候选点与细网格复核结果。`;
  } else if (action.tool === 'explain_risk') {
    let result = useAppStore.getState().analysis;
    if (!result || useAppStore.getState().resultStale) {
      result = await runStudy({ focusResult: false, silentToast: true });
    }
    if (!result) throw new Error('尚无结果可供诊断');
    lastResultRef.value = result;
    detail = `hotspot @ ${result.maxVonMisesLocation.map((value) => fmt(value, 0)).join(', ')}`;
    summary = riskNarrative();
  } else if (action.tool === 'export_report') {
    let result = useAppStore.getState().analysis;
    if (!result || useAppStore.getState().resultStale) {
      result = await runStudy({ focusResult: false, silentToast: true });
    }
    if (!result) throw new Error('生成报告需要有效的求解结果');
    const { exportReportFile } = await import('../core/report/report');
    const state = useAppStore.getState();
    exportReportFile(state.model, result, state.validation);
    detail = `VISION_${state.model.code}_${result.id}.md`;
    summary = `工程校核报告已生成并下载：**VISION_${state.model.code}_${result.id}.md**。报告包含材料与参数表、C3D8 网格、平衡校核、求解器验证、限制与可追溯指纹。`;
  } else {
    throw new Error('未识别的工具');
  }
  setStep(messageId, stepId, { status: 'done', detail });
  await wait(180);
  return summary;
}

export async function sendAgentPrompt(prompt: string): Promise<void> {
  const value = prompt.trim();
  if (!value) return;
  const state = useAppStore.getState();
  if (state.chatBusy) return;
  useAppStore.getState().setChatBusy(true);
  useAppStore.getState().addMessage({
    id: uid('user'),
    role: 'user',
    content: value,
    createdAt: Date.now(),
  });

  const plan = parseEngineeringPrompt(value, state.model);
  const messageId = uid('assistant');
  const steps: ChatPlanStep[] = plan.actions.map((action, index) => ({
    id: `step_${index}`,
    label: action.label,
    status: 'queued',
  }));
  useAppStore.getState().addMessage({
    id: messageId,
    role: 'assistant',
    content: plan.actions.length ? plan.summary : plan.summary,
    createdAt: Date.now(),
    steps,
    streaming: true,
    meta: { kind: plan.actions.length ? 'action' : 'insight' },
  });
  await wait(260);

  if (plan.actions.length === 0) {
    useAppStore.getState().updateMessage(messageId, {
      content: plan.summary,
      streaming: false,
      meta: {
        kind: 'question',
        chips:
          plan.intent === 'help'
            ? ['运行基线校核', '哪里最危险？', '以质量最小为目标优化悬臂厚度']
            : ['把悬臂厚度改为 14 mm 并校核', '末端加载 1.2 kN 向下', '生成工程校核报告'],
      },
    });
    useAppStore.getState().setChatBusy(false);
    return;
  }

  const summaries: string[] = [];
  const lastResultRef: { value: ReturnType<typeof useAppStore.getState>['analysis'] } = {
    value: useAppStore.getState().analysis,
  };
  let failed = false;
  try {
    for (let index = 0; index < plan.actions.length; index += 1) {
      const action = plan.actions[index];
      try {
        const summary = await executeAction(action, messageId, `step_${index}`, lastResultRef);
        if (summary) summaries.push(summary);
      } catch (error) {
        failed = true;
        setStep(messageId, `step_${index}`, {
          status: 'error',
          detail: error instanceof Error ? error.message : String(error),
        });
        summaries.push(`**执行失败：** ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  } finally {
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
    const chips = result
      ? ['哪里最危险？', '以 SF ≥ 2.5 优化悬臂厚度', '生成工程校核报告']
      : ['运行基线校核', '把悬臂厚度改为 14 mm', '切换为 7075-T6'];
    useAppStore.getState().updateMessage(messageId, {
      content: summaries.filter(Boolean).join('\n\n') + ending,
      streaming: false,
      meta: {
        kind: failed ? 'question' : plan.actions.some((action) => action.tool === 'optimize') ? 'action' : 'insight',
        chips,
      },
    });
    useAppStore.getState().setChatBusy(false);
  }
}
