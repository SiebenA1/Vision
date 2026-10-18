import type { DesignVariable, ModelDocument, Vec3 } from './types';

export const BRACKET_VARIABLES: DesignVariable[] = [
  {
    key: 'wallWidth',
    label: '背板宽度',
    labelEn: 'Wall width',
    value: 96,
    min: 64,
    max: 140,
    step: 1,
    unit: 'mm',
    group: '主控尺寸',
    role: 'secondary',
  },
  {
    key: 'wallHeight',
    label: '背板高度',
    labelEn: 'Wall height',
    value: 120,
    min: 80,
    max: 180,
    step: 1,
    unit: 'mm',
    group: '主控尺寸',
    role: 'primary',
  },
  {
    key: 'wallThickness',
    label: '背板厚度',
    labelEn: 'Wall thickness',
    value: 10,
    min: 6,
    max: 22,
    step: 0.5,
    unit: 'mm',
    group: '主控尺寸',
    role: 'primary',
  },
  {
    key: 'armLength',
    label: '悬臂长度',
    labelEn: 'Arm length',
    value: 130,
    min: 80,
    max: 220,
    step: 1,
    unit: 'mm',
    group: '主控尺寸',
    role: 'primary',
  },
  {
    key: 'armWidth',
    label: '悬臂宽度',
    labelEn: 'Arm width',
    value: 48,
    min: 30,
    max: 80,
    step: 1,
    unit: 'mm',
    group: '主控尺寸',
    role: 'secondary',
  },
  {
    key: 'armThickness',
    label: '悬臂厚度',
    labelEn: 'Arm thickness',
    value: 12,
    min: 6,
    max: 28,
    step: 0.5,
    unit: 'mm',
    group: '主控尺寸',
    role: 'primary',
    note: '主要弯曲刚度贡献项；推荐优化变量。',
  },
  {
    key: 'ribLength',
    label: '加强筋长度',
    labelEn: 'Gusset length',
    value: 64,
    min: 20,
    max: 120,
    step: 1,
    unit: 'mm',
    group: '连接结构',
    role: 'primary',
  },
  {
    key: 'ribThickness',
    label: '加强筋厚度',
    labelEn: 'Gusset thickness',
    value: 8,
    min: 4,
    max: 18,
    step: 0.5,
    unit: 'mm',
    group: '连接结构',
    role: 'secondary',
  },
  {
    key: 'bossDiameter',
    label: '端部承力环直径',
    labelEn: 'Boss diameter',
    value: 28,
    min: 16,
    max: 40,
    step: 1,
    unit: 'mm',
    group: '连接结构',
    role: 'secondary',
  },
  {
    key: 'bossHeight',
    label: '端部承力环高度',
    labelEn: 'Boss height',
    value: 8,
    min: 2,
    max: 18,
    step: 0.5,
    unit: 'mm',
    group: '连接结构',
    role: 'secondary',
  },
  {
    key: 'mountHoleDia',
    label: '安装孔直径',
    labelEn: 'Mount hole Ø',
    value: 9,
    min: 6,
    max: 14,
    step: 0.5,
    unit: 'mm',
    group: '连接结构',
    role: 'secondary',
  },
  {
    key: 'mountHoleInset',
    label: '安装孔边距',
    labelEn: 'Mount hole inset',
    value: 19,
    min: 12,
    max: 32,
    step: 1,
    unit: 'mm',
    group: '连接结构',
    role: 'secondary',
  },
  {
    key: 'lighteningHoleDia',
    label: '减重孔直径',
    labelEn: 'Lightening Ø',
    value: 22,
    min: 10,
    max: 26,
    step: 1,
    unit: 'mm',
    group: '轻量化',
    role: 'primary',
  },
  {
    key: 'tipHoleDia',
    label: '端部销孔直径',
    labelEn: 'Pin hole Ø',
    value: 12,
    min: 5,
    max: 20,
    step: 0.5,
    unit: 'mm',
    group: '连接结构',
    role: 'secondary',
  },
];

export const BRACKET_FEATURES: ModelDocument['features'] = [
  {
    id: 'wall',
    index: '01',
    name: '背板',
    nameEn: 'WALL',
    kind: 'solid',
    operation: 'add',
    description: '圆角矩形轮廓 · 沿 X 拉伸',
    variableKeys: ['wallWidth', 'wallHeight', 'wallThickness'],
    quality: 'primary',
  },
  {
    id: 'arm',
    index: '02',
    name: '悬臂',
    nameEn: 'ARM',
    kind: 'solid',
    operation: 'add',
    description: '圆弧端轮廓 · 沿 Z 拉伸',
    variableKeys: ['armLength', 'armWidth', 'armThickness'],
    quality: 'primary',
  },
  {
    id: 'ribs',
    index: '03',
    name: '三角加强筋 ×2',
    nameEn: 'GUSSETS',
    kind: 'pattern',
    operation: 'add',
    description: '镜像三角肋 · 壁—臂载荷路径',
    variableKeys: ['ribLength', 'ribThickness', 'wallThickness'],
  },
  {
    id: 'boss',
    index: '04',
    name: '端部承力环',
    nameEn: 'BOSS',
    kind: 'boss',
    operation: 'add',
    description: '销孔局部补强 · 环形凸台',
    variableKeys: ['bossDiameter', 'bossHeight'],
  },
  {
    id: 'mountHoles',
    index: '05',
    name: '安装孔 ×4',
    nameEn: 'MOUNT HOLES',
    kind: 'cut',
    operation: 'subtract',
    description: 'Ø9 通孔 · 四角对称布置',
    variableKeys: ['mountHoleDia', 'mountHoleInset'],
  },
  {
    id: 'lighteningHoles',
    index: '06',
    name: '减重孔 ×2',
    nameEn: 'LIGHTENING',
    kind: 'pattern',
    operation: 'subtract',
    description: '背板下缘双孔 · 对称去除低应力材料',
    variableKeys: ['lighteningHoleDia', 'armWidth'],
  },
  {
    id: 'tipHole',
    index: '07',
    name: '端部销孔',
    nameEn: 'PIN HOLE',
    kind: 'cut',
    operation: 'subtract',
    description: '贯穿承力环 · Ø12',
    variableKeys: ['tipHoleDia', 'bossDiameter'],
  },
];

export const DEFAULT_VECTOR: Vec3 = [0, 0, -1];

export const BRACKET_MODEL: ModelDocument = {
  schema: 'vision.model/1',
  id: 'mdl_brk_042',
  code: 'BRK-042',
  name: '轻量悬挂支架',
  subtitle: 'Cantilever bracket / topology-aware study',
  revision: 'R04',
  template: 'bracket',
  units: 'mm-N-MPa',
  materialId: 'AL6061-T6',
  variables: BRACKET_VARIABLES,
  features: BRACKET_FEATURES,
  supports: [
    {
      id: 'sup_wall',
      name: '背板固定面',
      face: 'x-min',
      type: 'fixed',
      enabled: true,
    },
  ],
  loads: [
    {
      id: 'load_tip',
      name: '端部校核载荷',
      face: 'x-max',
      vector: DEFAULT_VECTOR,
      magnitude: 600,
      enabled: true,
      description: '悬臂端部竖向工作载荷 · 600 N (≈61 kgf)',
    },
  ],
  mesh: {
    targetElements: 7000,
    cellSizeMm: 3,
    elementType: 'C3D8',
    tolerance: 1e-4,
    maxIterations: 2400,
    boundaryPolicy: 'conservative-voxel',
  },
  meta: {
    client: 'VISION Advanced Systems',
    discipline: '结构 · 静力',
    created: '2026-10-18',
    analyst: 'ATLAS / 工程智能体',
    designIntent: '在 600 N 端载下保持安全系数 ≥ 2.0，并尽量降低质量。',
  },
};

export function cloneModel(model: ModelDocument): ModelDocument {
  return structuredClone(model);
}

export function variableMap(model: ModelDocument): Record<string, number> {
  return Object.fromEntries(model.variables.map((variable) => [variable.key, variable.value]));
}

export function getVariable(model: ModelDocument, key: string): DesignVariable | undefined {
  return model.variables.find((variable) => variable.key === key);
}

export function formatVariableValue(variable: DesignVariable): string {
  const digits = variable.precision ?? (variable.step < 1 ? 1 : 0);
  return variable.value.toFixed(digits);
}

export function loadVector(model: ModelDocument): Vec3 {
  const load = model.loads.find((item) => item.enabled);
  return load?.vector ?? [0, 0, -1];
}

export function primaryLoad(model: ModelDocument) {
  return model.loads.find((item) => item.enabled);
}

export function primarySupport(model: ModelDocument) {
  return model.supports.find((item) => item.enabled);
}
