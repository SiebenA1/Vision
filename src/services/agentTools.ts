import type { AgentAction, FaceId, SolidShape, Vec3 } from '../core/types';
import { MATERIALS, getMaterial } from '../core/materials';
import { useAppStore } from '../state/store';
import { runStudy, wait } from './simulation';
import { fmt, vectorLabel } from '../lib/format';
import { directionVector } from '../core/llm/tools';
import { executeBuild123d } from './engineeringBackend';

const FACES: FaceId[] = ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'];

function assertFace(value: unknown): FaceId {
  const face = String(value);
  if (!FACES.includes(face as FaceId)) throw new Error(`无效的 face：${face}`);
  return face as FaceId;
}

export type LastResultRef = { value: ReturnType<typeof useAppStore.getState>['analysis'] };

export interface ToolExecution {
  ok: boolean;
  summary: string;
  detail: string;
  state: Record<string, unknown>;
}

export function labelForAction(action: AgentAction): string {
  const label = action.args.label;
  switch (action.tool) {
    case 'set_variable':
      return `更新 ${label ?? action.args.key} → ${action.args.value} ${action.args.unit ?? 'mm'}`;
    case 'set_material':
      return `切换材料 ${action.args.name ?? action.args.materialId}`;
    case 'set_load':
      return `设定载荷 ${action.args.magnitude} N`;
    case 'set_support':
      return `约束 ${action.args.name ?? action.args.face}`;
    case 'run_analysis':
      return action.args.refinement ? '运行 h 收敛校核' : '运行线性静力校核';
    case 'explain_risk':
      return '解析危险截面与失效裕度';
    case 'export_report':
      return '生成工程校核报告';
    case 'run_build123d':
      return '执行 build123d / OCCT 建模脚本';
    default:
      return '执行工程工具';
  }
}

export function compactState(): Record<string, unknown> {
  const state = useAppStore.getState();
  const result = state.analysis;
  return {
    model: {
      code: state.model.code,
      revision: state.model.revision,
      template: state.model.template ?? 'bracket',
      materialId: state.model.materialId,
      variables: Object.fromEntries(state.model.variables.map((variable) => [variable.key, variable.value])),
      solidFeatures: (state.model.solidFeatures ?? []).map((feature) => ({
        id: feature.id,
        name: feature.name,
        shape: feature.shape,
        operation: feature.operation,
      })),
      load: state.model.loads[0]
        ? {
            magnitude: state.model.loads[0].magnitude,
            face: state.model.loads[0].face,
            vector: state.model.loads[0].vector,
          }
        : null,
      support: state.model.supports[0]?.face ?? null,
    },
    geometry: state.geometry
      ? {
          watermark: state.geometry.watermark,
          massKg: Number((state.geometryMetrics?.massKg ?? 0).toFixed(5)),
          volumeCm3: Number((state.geometryMetrics?.volumeCm3 ?? 0).toFixed(3)),
          triangles: state.geometry.triangleCount,
        }
      : null,
    result: result
      ? {
          modelHash: result.modelHash,
          stale: state.resultStale,
          SF: Number(result.safetyFactor.toFixed(3)),
          maxStressMPa: Number(result.maxVonMises.toFixed(2)),
          maxDisplacementMm: Number(result.maxDisplacement.toFixed(4)),
          massKg: Number(result.massKg.toFixed(5)),
          elements: result.mesh.elements,
          iterations: result.solver.iterations,
          relativeResidual: result.solver.relativeResidual,
          equilibriumError: result.equilibrium.relativeError,
          warnings: result.warnings,
        }
      : null,
    analysisStatus: state.analysisStatus,
    validation: state.validation
      ? {
          passed: state.validation.passed,
          errorPercent: Number(state.validation.errorPercent.toFixed(2)),
          computedMm: Number(state.validation.computed.toFixed(5)),
        }
      : null,
  };
}

export function riskNarrative(): string {
  const state = useAppStore.getState();
  const result = state.analysis;
  const geometry = state.geometry;
  if (!result || !geometry) return '尚未获得可用的求解结果。';
  const [x, y, z] = result.maxVonMisesLocation;
  const model = state.model;
  const wallThickness = model.variables.find((variable) => variable.key === 'wallThickness')?.value ?? 10;
  const armLength = model.variables.find((variable) => variable.key === 'armLength')?.value ?? 130;
  const material = getMaterial(model.materialId);
  const margin = ((material.yieldStrength - result.maxVonMises) / material.yieldStrength) * 100;
  const sfPass = result.safetyFactor >= 2.0;
  const drivers: string[] = [];
  if (model.template === 'csg' && /轮辋|轮毂|rim/i.test(model.name)) {
    const radius = Math.hypot(y, z);
    const outerRadius = Math.max(
      Math.abs(geometry.bbox.min[1]),
      Math.abs(geometry.bbox.max[1]),
      Math.abs(geometry.bbox.min[2]),
      Math.abs(geometry.bbox.max[2]),
    );
    let region = '辐条中段 / 轮毂连接区';
    if (radius < 95) region = '轮毂法兰 / 中心孔与螺栓孔区';
    else if (radius > outerRadius - 35) region = '轮唇 / 胎圈座过渡区';
    else if (radius < 125) region = '辐条根部与轮毂过渡区';
    if (result.maxDisplacement > 2) drivers.push('辐条弯曲刚度');
    if (radius < 125) drivers.push('辐条根部弯曲/剪切');
    if (radius > outerRadius - 35) drivers.push('轮唇局部弯曲');
    if (result.safetyFactor < 1.8) drivers.push('轮毂法兰与螺栓孔承压');
    if (drivers.length === 0) drivers.push('辐条根部与轮唇的应力梯度');
    return [
      `热点位于 **${region}**，坐标 (${fmt(x, 1)}, ${fmt(y, 1)}, ${fmt(z, 1)}) mm。`,
      `峰值 von Mises **${fmt(result.maxVonMises, 1)} MPa**，对应安全系数 **${fmt(result.safetyFactor, 2)}**；距屈服点仍有 ${fmt(margin, 1)}% 的材料裕度。`,
      `当前控制因素：${drivers.join('、')}。轮辋承受的是旋转弯曲/径向载荷，当前 x-min 固定与 z-min 载荷只是通用占位工况；真实分析需定义轮毂螺栓预紧、胎圈接触和旋转载荷谱。`,
      result.warnings.length ? `自动检查提示：${result.warnings[0]}` : '自动检查未发现平衡或收敛异常。',
    ].join('\n\n');
  }
  if (model.template === 'csg') {
    let region = '叉板 / 加强筋传力路径';
    if (x <= 18) region = '安装背板与螺栓孔区';
    else if (x >= 185) region = '踏板垫与踏板臂端部';
    else if (Math.hypot(x - 106, z - 72) <= 38) region = '枢轴座与叉板连接区';
    else if (Math.abs(y) >= 30) region = '侧向叉板与横梁连接区';
    if (result.maxDisplacement > 1.5) drivers.push('踏板臂弯曲刚度');
    if (Math.abs(y) > 25) drivers.push('叉板面外弯曲与孔边应力集中');
    if (result.safetyFactor < 1.8) drivers.push('枢轴座附近的弯曲/剪切耦合');
    if (drivers.length === 0) drivers.push('安装孔边与叉板根部的应力梯度');
    return [
      `热点位于 **${region}**，坐标 (${fmt(x, 1)}, ${fmt(y, 1)}, ${fmt(z, 1)}) mm。`,
      `峰值 von Mises **${fmt(result.maxVonMises, 1)} MPa**，对应安全系数 **${fmt(result.safetyFactor, 2)}**；距屈服点仍有 ${fmt(margin, 1)}% 的材料裕度。`,
      `当前控制因素：${drivers.join('、')}。${sfPass ? '结构满足当前 SF ≥ 2.00 的设计目标；仍需校核安装螺栓预紧、焊缝与疲劳。' : '结构未满足 SF ≥ 2.00，建议优先加厚叉板/枢轴座或增加根部加强筋。'}`,
      result.warnings.length ? `自动检查提示：${result.warnings[0]}` : '自动检查未发现平衡或收敛异常。',
    ].join('\n\n');
  }
  if (model.template === 'blade') {
    const bladeLength = model.variables.find((variable) => variable.key === 'bladeLength')?.value ?? 1800;
    let region = '叶片中段主梁 / 蒙皮过渡区';
    if (x <= bladeLength * 0.12) region = '叶根圆角与连接区';
    else if (x >= bladeLength * 0.8) region = '叶尖薄壁区';
    else if (Math.abs(y) > 25) region = '前缘/后缘与主梁帽交界';
    if (result.maxDisplacement > bladeLength * 0.006) drivers.push('展向弯曲刚度');
    if (result.safetyFactor < 1.8) drivers.push('叶根弯曲与扭转耦合');
    if (Math.abs(y) > 25) drivers.push('薄壁蒙皮局部屈曲/剪切');
    if (drivers.length === 0) drivers.push('叶根连接与主梁帽应力集中');
    return [
      `热点位于 **${region}**，坐标 (${fmt(x, 1)}, ${fmt(y, 1)}, ${fmt(z, 1)}) mm。`,
      `峰值 von Mises **${fmt(result.maxVonMises, 1)} MPa**，对应安全系数 **${fmt(result.safetyFactor, 2)}**；距等效屈服点仍有 ${fmt(margin, 1)}% 的裕度。`,
      `当前控制因素：${drivers.join('、')}。该模型是各向同性等效实体，未模拟 CFRP 铺层、纤维方向、蒙皮-主梁胶接和疲劳；结果只能用于初步传力路径判断。`,
      result.warnings.length ? `自动检查提示：${result.warnings[0]}` : '自动检查未发现平衡或收敛异常。',
    ].join('\n\n');
  }
  let region = '悬臂中段 / 截面过渡区';
  if (x <= wallThickness * 2.6) region = '背板与悬臂根部过渡区';
  else if (x >= armLength * 0.8) region = '端部承力环与销孔边缘';
  else if (Math.abs(y) > 12) region = '加强筋与悬臂腹板连接区';
  return [
    `热点位于 **${region}**，坐标 (${fmt(x, 1)}, ${fmt(y, 1)}, ${fmt(z, 1)}) mm。`,
    `峰值 von Mises **${fmt(result.maxVonMises, 1)} MPa**，对应安全系数 **${fmt(result.safetyFactor, 2)}**；距屈服点仍有 ${fmt(margin, 1)}% 的材料裕度。`,
    `当前控制因素：${drivers.join('、')}。${sfPass ? '结构满足当前 SF ≥ 2.00 的设计目标，但仍应检查疲劳、屈曲与连接件。' : '结构未满足 SF ≥ 2.00 的设计目标，建议优先增加根部截面或优化载荷路径。'}`,
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
    )} mm**，安全系数 **${fmt(result.safetyFactor, 2)}**，质量 **${fmt(result.massKg, 3)} kg**。求解器：${result.solver.method === 'SfePy' ? 'Gmsh + SfePy' : 'C3D8 / PCG'}。`;
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
    const raw = String(action.args.direction);
    const vector = raw.includes(',')
      ? (raw.split(',').map(Number) as Vec3)
      : directionVector(raw);
    return `端部载荷更新为 **${action.args.magnitude} N**，方向 ${vectorLabel(vector)}，加载面 ${action.args.face}。`;
  }
  if (action.tool === 'set_support') {
    return `约束切换到 **${action.args.name ?? action.args.face}**（${action.args.face}，6 DOF fixed）。`;
  }
  if (action.tool === 'explain_risk') {
    return riskNarrative();
  }
  return '';
}

export async function executeTool(action: AgentAction, lastResultRef: LastResultRef): Promise<ToolExecution> {
  const store = useAppStore.getState();
  let detail = '';
  let summary = '';
  if (action.tool === 'run_build123d') {
    const script = String(action.args.script ?? '');
    if (!script.trim()) throw new Error('build123d 脚本为空。');
    const density = Number(action.args.density_kg_m3 ?? 2700);
    const result = await executeBuild123d(script, density);
    store.adoptExternalModel({
      name: String(action.args.name ?? 'AI B-Rep 模型'),
      code: String(action.args.code ?? `CAD-${String(Date.now()).slice(-4)}`),
      newProject: action.args.new_project === true,
      script,
      stlBase64: result.stlBase64,
      metrics: result.metrics,
      materialId: String(action.args.materialId ?? 'AL6061-T6'),
    });
    await wait(40);
    detail = `${result.metrics.volume_mm3.toFixed(0)} mm³ · ${result.stlBytes} STL bytes`;
    summary = actionResultSummary(action);
    lastResultRef.value = null;
  } else if (action.tool === 'set_variable') {
    const variable = useAppStore
      .getState()
      .model.variables.find((item) => item.key === action.args.key);
    if (!variable) throw new Error(`未知设计变量：${action.args.key}`);
    store.setVariable(
      String(action.args.key),
      Number(action.args.value),
      String(action.args.label ?? variable.label),
    );
    await wait(40);
    const geometry = await useAppStore.getState().rebuildGeometry();
    if (!geometry) throw new Error(useAppStore.getState().geometryError ?? '几何重建失败');
    detail = 'geometry rebuilt · watertight';
    summary = actionResultSummary({
      ...action,
      args: { ...action.args, label: variable.label, unit: variable.unit },
    });
    lastResultRef.value = null;
  } else if (action.tool === 'set_material') {
    const material = MATERIALS.find((item) => item.id === action.args.materialId);
    if (!material) throw new Error(`未知材料：${action.args.materialId}`);
    store.setMaterial(material.id);
    detail = material.shortName;
    summary = actionResultSummary({ ...action, args: { ...action.args, name: material.name } });
    lastResultRef.value = null;
  } else if (action.tool === 'set_load') {
    const raw = String(action.args.direction);
    const vector = raw.includes(',')
      ? (raw.split(',').map(Number) as Vec3)
      : directionVector(raw);
    const face = assertFace(action.args.face);
    store.setLoadMagnitude(Number(action.args.magnitude));
    store.setLoadFace(face);
    store.setLoadDirection(vector);    detail = `${action.args.magnitude} N · ${face}`;
    summary = actionResultSummary(action);
    lastResultRef.value = null;
  } else if (action.tool === 'set_support') {
    const face = assertFace(action.args.face);
    store.setSupportFace(face);
    detail = face;
    summary = actionResultSummary({ ...action, args: { ...action.args, name: face === 'x-min' ? '背板固定面' : `${face} 固定` } });
    lastResultRef.value = null;
  } else if (action.tool === 'run_analysis') {
    const existing = useAppStore.getState().analysis;
    const stale = useAppStore.getState().resultStale;
    let result = existing && !stale ? existing : null;
    if (!result) {
      result = await runStudy({
        focusResult: false,
        silentToast: true,
        refinement: Boolean(action.args.refinement),
      });
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
    summary = `工程校核报告已生成并下载：**VISION_${state.model.code}_${result.id}.md**。报告包含材料与参数表、Gmsh/SfePy 结果、限制与可追溯指纹。`;
  } else {
    throw new Error(`未识别的工具：${action.tool}`);
  }

  return { ok: true, summary, detail, state: compactState() };
}
