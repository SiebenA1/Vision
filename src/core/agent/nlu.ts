import type { AgentAction, AgentPlan, DesignVariable, ModelDocument, Vec3 } from '../types';

interface VariableAlias {
  keys: string[];
  aliases: string[];
}

const VARIABLE_ALIASES: VariableAlias[] = [
  { keys: ['wallWidth'], aliases: ['背板宽度', '背板宽', '墙板宽度', 'wall width'] },
  { keys: ['wallHeight'], aliases: ['背板高度', '背板高', '立板高度', '墙板高度', '腹板高度', 'wall height'] },
  { keys: ['wallThickness'], aliases: ['背板厚度', '底板厚度', '安装板厚度', 'wall thickness'] },
  { keys: ['armLength'], aliases: ['悬臂长度', '臂长', '悬伸长度', 'arm length'] },
  { keys: ['armWidth'], aliases: ['悬臂宽度', '臂宽', 'arm width'] },
  { keys: ['armThickness'], aliases: ['悬臂厚度', '臂厚', '悬臂板厚', 'arm thickness'] },
  { keys: ['ribLength'], aliases: ['加强筋长度', '筋长', '肋长', 'gusset length'] },
  { keys: ['ribThickness'], aliases: ['加强筋厚度', '筋厚', '肋厚', 'gusset thickness'] },
  { keys: ['bossDiameter'], aliases: ['承力环直径', '凸台直径', 'boss diameter'] },
  { keys: ['bossHeight'], aliases: ['承力环高度', '凸台高度', 'boss height'] },
  { keys: ['mountHoleDia'], aliases: ['安装孔直径', '安装孔', '螺栓孔直径', 'mount hole'] },
  { keys: ['mountHoleInset'], aliases: ['安装孔边距', '孔边距'] },
  { keys: ['lighteningHoleDia'], aliases: ['减重孔直径', '减重孔', '轻量化孔', 'lightening'] },
  { keys: ['tipHoleDia'], aliases: ['端部销孔直径', '销孔直径', '销孔', 'pin hole'] },
];

const GENERIC_ALIASES: Array<{ key: string; alias: string }> = [
  { key: 'armLength', alias: '长度' },
  { key: 'armThickness', alias: '厚度' },
  { key: 'wallHeight', alias: '高度' },
  { key: 'wallWidth', alias: '宽度' },
];

function normalize(text: string): string {
  return text
    .replace(/[，。；！？、]/g, (char) => ({ '，': ',', '。': '.', '；': ';', '！': '!', '？': '?', '、': ',' }[char] ?? char))
    .replace(/：/g, ':')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .toLowerCase();
}

function asNumber(raw: string, unit: string | undefined): number {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return Number.NaN;
  if (unit === 'cm' || unit === '厘米') return value * 10;
  if (unit === 'm' || unit === '米') return value * 1000;
  return value;
}

function findValueAfter(text: string, alias: string): { value: number; unit: string } | null {
  const index = text.indexOf(alias);
  if (index < 0) return null;
  const tail = text.slice(index + alias.length, index + alias.length + 48);
  const match = tail.match(/(?:改成|改为|改到|调到|调整到|设为|设置为|设成|变成|到|为|至|=|:|to|at)?\s*(-?\d+(?:\.\d+)?)\s*(mm|毫米|cm|厘米)?/);
  if (!match) return null;
  const value = asNumber(match[1], match[2]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: match[2] ?? 'mm' };
}

function findVariable(text: string, model: ModelDocument): { variable: DesignVariable; value: number } | null {
  for (const group of VARIABLE_ALIASES) {
    for (const alias of group.aliases) {
      const hit = findValueAfter(text, alias);
      if (hit) {
        const variable = model.variables.find((item) => item.key === group.keys[0]);
        if (variable) return { variable, value: hit.value };
      }
    }
  }
  for (const generic of GENERIC_ALIASES) {
    const hit = findValueAfter(text, generic.alias);
    if (hit) {
      const variable = model.variables.find((item) => item.key === generic.key);
      if (variable) return { variable, value: hit.value };
    }
  }
  return null;
}

function findMaterial(text: string): string | null {
  if (/7075/.test(text)) return 'AL7075-T6';
  if (/6061|6061-t6|铝|alum/.test(text)) return 'AL6061-T6';
  if (/4340|钢|steel/.test(text)) return 'STEEL-4340';
  if (/tc4|ti-?6al-?4v|钛|titan/.test(text)) return 'TI64';
  if (/pa12|尼龙|nylon/.test(text)) return 'PA12-GF';
  return null;
}

function forceFromText(text: string): { magnitude: number; face: ModelDocument['loads'][number]['face']; vector: Vec3 } | null {
  if (!/(加载|载荷|负载|受力|压力|force|load|压)/.test(text)) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(kn|n|千牛|牛)(?![a-z])/);
  if (!match) return null;
  let magnitude = Number.parseFloat(match[1]);
  if (/kn|千牛/.test(match[2])) magnitude *= 1000;
  let vector: Vec3 = [0, 0, -1];
  if (/向上|朝上|竖直向上|向上|up/.test(text)) vector = [0, 0, 1];
  else if (/向右|朝右|\+x|right/.test(text)) vector = [1, 0, 0];
  else if (/向左|朝左|-x|left/.test(text)) vector = [-1, 0, 0];
  else if (/向前|朝前|\+y|forward/.test(text)) vector = [0, 1, 0];
  else if (/向后|朝后|-y|backward/.test(text)) vector = [0, -1, 0];
  let face: ModelDocument['loads'][number]['face'] = 'x-max';
  if (/顶部|上表面|top/.test(text)) face = 'z-max';
  else if (/底部|下表面|bottom/.test(text)) face = 'z-min';
  else if (/背面|根部|root/.test(text)) face = 'x-min';
  return { magnitude, face, vector };
}

function supportFromText(text: string): { face: ModelDocument['supports'][number]['face']; name: string } | null {
  if (!/(固定|约束|夹紧|夹持|fixed|clamp|support)/.test(text)) return null;
  if (/底面|底部|z-min|bottom/.test(text)) return { face: 'z-min', name: '底面固定' };
  if (/顶面|顶部|z-max|top/.test(text)) return { face: 'z-max', name: '顶面固定' };
  if (/背面|左侧|左端|x-min|back|left/.test(text)) return { face: 'x-min', name: '背板固定面' };
  if (/右侧|右端|x-max|right/.test(text)) return { face: 'x-max', name: '右端固定' };
  if (/前侧|前侧|y-min/.test(text)) return { face: 'y-min', name: '前侧固定' };
  if (/后侧|y-max/.test(text)) return { face: 'y-max', name: '后侧固定' };
  return null;
}

function findTargetSafety(text: string): number | null {
  const patterns = [
    /(?:安全系数|safety factor|sf)\s*(?:≥|>=|>|不低于|至少|不小于|达到|至)?\s*(\d+(?:\.\d+)?)/i,
    /(?:≥|>=|不低于|至少|不小于)\s*(\d+(?:\.\d+)?)\s*(?:的安全系数|安全系数|sf)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number.parseFloat(match[1]);
      if (value > 0 && value < 10) return value;
    }
  }
  return null;
}

function findDisplacementLimit(text: string): number | null {
  const match = text.match(/位移[^\d]{0,10}(?:≤|<=|不超过|小于|低于|limit)?\s*(\d+(?:\.\d+)?)\s*(mm|毫米)?/);
  if (match) return asNumber(match[1], match[2]);
  return null;
}

function actionLabel(action: AgentAction): string {
  switch (action.tool) {
    case 'set_variable':
      return `更新 ${action.args.label}`;
    case 'set_material':
      return `切换材料 ${action.args.name}`;
    case 'set_load':
      return `设定载荷 ${action.args.magnitude} N`;
    case 'set_support':
      return `约束 ${action.args.name}`;
    case 'run_analysis':
      return '运行线性静力校核';
    case 'optimize':
      return '执行 FE-in-the-loop 优化';
    case 'explain_risk':
      return '解析危险截面与失效裕度';
    case 'export_report':
      return '生成工程校核报告';
    case 'generate_preset':
      return '生成刹车踏板支架 CSG 模型';
    case 'add_solid_feature':
      return '添加 CSG 实体特征';
    default:
      return '等待更多信息';
  }
}

function brakePedalPlan(): AgentPlan {
  return {
    intent: 'modeling',
    summary:
      '将生成一个由 16 个 CSG 特征组成的刹车踏板支架：安装背板、双侧叉板、加强筋、枢轴座、踏板臂与安装/减重孔，然后重建 watertight 几何。',
    actions: [
      {
        tool: 'generate_preset',
        args: { preset: 'brake-pedal' },
        label: '生成刹车踏板支架 CSG 模型',
      },
    ],
    confidence: 0.97,
  };
}

export function parseEngineeringPrompt(prompt: string, model: ModelDocument): AgentPlan {
  const text = normalize(prompt);
  if (/(刹车|制动|brake).*(踏板|pedal)|(踏板|pedal).*(支架|bracket)|(刹车|制动).*(支架|bracket)/.test(text)) {
    return brakePedalPlan();
  }
  const actions: AgentAction[] = [];

  const materialId = findMaterial(text);
  if (materialId && /(换成|改用|材料|材质|使用|用|material|switch|change)/.test(text)) {
    const names: Record<string, string> = {
      'AL6061-T6': '铝合金 6061-T6',
      'AL7075-T6': '铝合金 7075-T6',
      'STEEL-4340': '合金钢 AISI 4340',
      TI64: '钛合金 Ti-6Al-4V',
      'PA12-GF': 'PA12-GF',
    };
    actions.push({
      tool: 'set_material',
      args: { materialId, name: names[materialId] ?? materialId },
      label: `切换材料 ${names[materialId] ?? materialId}`,
    });
  }

  const variableHit = findVariable(text, model);
  if (variableHit) {
    const variable = variableHit.variable;
    const clamped = Math.min(variable.max, Math.max(variable.min, variableHit.value));
    if (clamped !== variable.value) {
      actions.push({
        tool: 'set_variable',
        args: {
          key: variable.key,
          value: clamped,
          label: variable.label,
          unit: variable.unit,
        },
        label: `更新 ${variable.label} → ${clamped} ${variable.unit}`,
      });
    }
  }

  const load = forceFromText(text);
  if (load) {
    actions.push({
      tool: 'set_load',
      args: {
        magnitude: Math.round(load.magnitude * 10) / 10,
        face: load.face,
        direction: load.vector.join(','),
      },
      label: `设定载荷 ${Math.round(load.magnitude * 10) / 10} N`,
    });
  }

  const support = supportFromText(text);
  if (support) {
    actions.push({
      tool: 'set_support',
      args: { face: support.face, name: support.name },
      label: `约束 ${support.name}`,
    });
  }

  const targetSafety = findTargetSafety(text) ?? 2.0;
  const displacementLimit = findDisplacementLimit(text);
  const mentionsSafetyTarget = /(安全系数|safety factor|\bsf\b)/i.test(text);
  const wantsOptimize =
    /(优化|轻量化|减重|最轻|最小质量|optimi|mass|lightweight|pareto)/.test(text) ||
    (mentionsSafetyTarget && !/(校核|分析|验证|verify|check)/.test(text));
  if (wantsOptimize) {
    let variableKey = 'armThickness';
    if (/背板厚度|壁厚|wall thickness/.test(text)) variableKey = 'wallThickness';
    else if (/减重孔|轻量化孔|lightening/.test(text)) variableKey = 'lighteningHoleDia';
    else if (/加强筋|筋厚|gusset/.test(text)) variableKey = 'ribThickness';
    else if (/悬臂宽度|臂宽/.test(text)) variableKey = 'armWidth';
    const variable = model.variables.find((item) => item.key === variableKey);
    actions.push({
      tool: 'optimize',
      args: {
        variableKey,
        targetSafety,
        displacementLimit: displacementLimit ?? 2.0,
        label: variable?.label ?? variableKey,
      },
      label: `优化 ${variable?.label ?? variableKey} · SF ≥ ${targetSafety}`,
    });
  }

  const wantsExplain = /(哪里|最危险|危险|风险|解释|评估|复核|为什么|critical|risk|review|why|hotspot)/.test(text);
  if (wantsExplain) {
    actions.push({
      tool: 'explain_risk',
      args: {},
      label: '解析危险截面与失效裕度',
    });
  }

  const wantsReport = /(报告|report|导出|export|pdf|文档)/.test(text);
  if (wantsReport) {
    actions.push({
      tool: 'export_report',
      args: {},
      label: '生成工程校核报告',
    });
  }

  const wantsRun = /(校核|分析|仿真|求解|计算|计算一下|run|solve|check|verify|study)/.test(text) && !wantsOptimize;
  if (wantsRun) {
    actions.push({ tool: 'run_analysis', args: {}, label: '运行线性静力校核' });
  }

  if (actions.length === 0) {
    if (/(你能|可以做什么|帮助|help|capabilit|怎么用|what can)/.test(text)) {
      return {
        intent: 'help',
        summary: '我可以修改参数、切换材料、施加边界条件、运行 FEA、执行优化并生成可追溯的校核报告。',
        actions: [],
        confidence: 0.9,
      };
    }
    if (/(你好|hello|hi|嗨)/.test(text)) {
      return {
        intent: 'greeting',
        summary: '你好。当前模型 BRK-042 已载入。告诉我目标，我会把它翻译成可验证的几何与仿真操作。',
        actions: [],
        confidence: 0.8,
      };
    }
    return {
      intent: 'clarify',
      summary: '我还不能把这句话映射为受控的工程操作。可以给出尺寸、材料、载荷、约束或优化目标，例如“把悬臂厚度改为 16 mm 并校核”。',
      actions: [],
      confidence: 0.25,
    };
  }

  const summaryParts = actions.map(actionLabel);
  const intent = wantsOptimize
    ? 'optimization'
    : wantsExplain
      ? 'diagnosis'
      : actions.some((a) => a.tool === 'run_analysis')
        ? 'verification'
        : 'edit';

  return {
    intent,
    summary: summaryParts.join(' → '),
    actions,
    confidence: Math.min(0.98, 0.55 + actions.length * 0.12),
  };
}
