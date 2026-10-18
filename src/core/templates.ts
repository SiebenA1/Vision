import type {
  DesignVariable,
  FeatureDescriptor,
  GeometryTemplate,
  ModelDocument,
  SolidFeature,
} from './types';
import { BRACKET_MODEL, cloneModel } from './presets';

type StarterTemplate = Exclude<GeometryTemplate, 'bracket' | 'empty'>;

function variable(
  key: string,
  label: string,
  labelEn: string,
  value: number,
  min: number,
  max: number,
  step = 1,
): DesignVariable {
  return {
    key,
    label,
    labelEn,
    value,
    min,
    max,
    step,
    unit: 'mm',
    group: '主控尺寸',
    role: 'primary',
  };
}

function starterDefinition(template: StarterTemplate): {
  variables: DesignVariable[];
  feature: FeatureDescriptor;
  designIntent: string;
  load: number;
} {
  if (template === 'plate') {
    return {
      variables: [
        variable('length', '板长', 'Length', 120, 20, 500),
        variable('width', '板宽', 'Width', 80, 20, 300),
        variable('thickness', '板厚', 'Thickness', 10, 2, 80, 0.5),
      ],
      feature: {
        id: 'base',
        index: '01',
        name: '基础板',
        nameEn: 'BASE PLATE',
        kind: 'solid',
        operation: 'add',
        description: '矩形基础板 · 沿 Z 拉伸',
        variableKeys: ['length', 'width', 'thickness'],
        quality: 'primary',
      },
      designIntent: '空白工程起点：参数化基础板。先定义边界条件和载荷，再开始校核或优化。',
      load: 1000,
    };
  }
  if (template === 'block') {
    return {
      variables: [
        variable('length', '块长', 'Length', 100, 20, 400),
        variable('width', '块宽', 'Width', 80, 20, 300),
        variable('height', '块高', 'Height', 60, 10, 300),
      ],
      feature: {
        id: 'base',
        index: '01',
        name: '基础块',
        nameEn: 'BASE BLOCK',
        kind: 'solid',
        operation: 'add',
        description: '矩形实体块 · C3D8 体素基础体',
        variableKeys: ['length', 'width', 'height'],
        quality: 'primary',
      },
      designIntent: '空白工程起点：参数化实体块。适合先做承压、压缩或局部挖孔研究。',
      load: 5000,
    };
  }
  return {
    variables: [
      variable('diameter', '圆柱直径', 'Diameter', 60, 10, 300),
      variable('height', '圆柱高度', 'Height', 100, 10, 400),
    ],
    feature: {
      id: 'base',
      index: '01',
      name: '圆柱体',
      nameEn: 'CYLINDER',
      kind: 'solid',
      operation: 'add',
      description: '圆柱实体 · 64 边近似',
      variableKeys: ['diameter', 'height'],
      quality: 'primary',
    },
    designIntent: '空白工程起点：参数化圆柱体。适合先做轴向承压或柱状支架研究。',
    load: 2000,
  };
}

export function createBlankModel(name: string, code: string): ModelDocument {
  const model = cloneModel(BRACKET_MODEL);
  const cleanCode = code.trim().toUpperCase() || 'BRK-043';
  const cleanName = name.trim() || '空白工程';
  model.id = `mdl_${Date.now().toString(36)}`;
  model.code = cleanCode;
  model.name = cleanName;
  model.subtitle = 'Blank engineering project';
  model.revision = 'R01';
  model.template = 'empty';
  model.variables = [];
  model.features = [];
  model.supports = [
    {
      id: 'sup_bottom',
      name: '底面固定',
      face: 'z-min',
      type: 'fixed',
      enabled: true,
    },
  ];
  model.loads = [
    {
      id: 'load_top',
      name: '顶面工作载荷',
      face: 'z-max',
      vector: [0, 0, -1],
      magnitude: 1000,
      enabled: true,
      description: '空白工程默认载荷 · 1000 N',
    },
  ];
  model.mesh = {
    ...model.mesh,
    cellSizeMm: 3,
  };
  model.meta.created = new Date().toISOString().slice(0, 10);
  model.meta.designIntent = '空白工程：从基础体开始，定义材料、边界条件与载荷，再运行可验证的静力校核。';
  return model;
}

export function createStarterModel(template: StarterTemplate, base: ModelDocument): ModelDocument {
  const model = cloneModel(base);
  const definition = starterDefinition(template);
  model.template = template;
  model.id = base.id || `mdl_${Date.now().toString(36)}`;
  model.revision = base.revision || 'R01';
  model.variables = definition.variables;
  model.features = [definition.feature];
  model.supports = [
    {
      id: 'sup_bottom',
      name: '底面固定',
      face: 'z-min',
      type: 'fixed',
      enabled: true,
    },
  ];
  model.loads = [
    {
      id: 'load_top',
      name: '顶面工作载荷',
      face: 'z-max',
      vector: [0, 0, -1],
      magnitude: definition.load,
      enabled: true,
      description: `基础体默认载荷 · ${definition.load} N`,
    },
  ];
  model.meta.designIntent = definition.designIntent;
  model.subtitle = `Blank starter / ${template}`;
  return model;
}

export function isStarterTemplate(value: string): value is StarterTemplate {
  return value === 'plate' || value === 'block' || value === 'cylinder';
}

export function describeSolidFeature(feature: SolidFeature, index: number): FeatureDescriptor {
  const dimensions =
    feature.shape === 'box'
      ? `${feature.size[0]} × ${feature.size[1]} × ${feature.size[2]}`
      : feature.shape === 'cylinder'
        ? `Ø${feature.radius * 2} × ${feature.height}${feature.axis.toUpperCase()}`
        : `Ø${feature.radius * 2}`;
  return {
    id: feature.id,
    index: String(index + 1).padStart(2, '0'),
    name: feature.name,
    nameEn: feature.shape.toUpperCase(),
    kind: feature.operation === 'subtract' ? 'cut' : 'solid',
    operation: feature.operation === 'subtract' ? 'subtract' : 'add',
    description: `${feature.shape.toUpperCase()} · ${dimensions}`,
    variableKeys: [],
    quality: 'primary',
  };
}

export function csgFeatures(features: SolidFeature[]): FeatureDescriptor[] {
  return features.map(describeSolidFeature);
}

function solid(
  id: string,
  name: string,
  shape: SolidFeature['shape'],
  operation: SolidFeature['operation'],
  position: SolidFeature['position'],
  options: Partial<SolidFeature> = {},
): SolidFeature {
  return {
    id,
    name,
    shape,
    operation,
    enabled: true,
    position,
    rotation: [0, 0, 0],
    size: [30, 30, 30],
    radius: 15,
    height: 30,
    axis: 'z',
    ...options,
  };
}

/**
 * A brake-pedal bracket assembled from a CSG feature graph:
 * wall plate → side cheeks → gussets → pivot boss → pedal lever → subtractive holes.
 */
export function createBrakePedalModel(code = 'PEDAL-01', name = '刹车踏板支架'): ModelDocument {
  const features: SolidFeature[] = [
    solid('pedal_wall', '安装背板', 'box', 'add', [6, 0, 45], { size: [12, 130, 90] }),
    solid('pedal_hole_1', '安装孔 01', 'cylinder', 'subtract', [6, -48, 18], {
      radius: 5.5,
      height: 22,
      axis: 'x',
    }),
    solid('pedal_hole_2', '安装孔 02', 'cylinder', 'subtract', [6, 48, 18], {
      radius: 5.5,
      height: 22,
      axis: 'x',
    }),
    solid('pedal_hole_3', '安装孔 03', 'cylinder', 'subtract', [6, -48, 72], {
      radius: 5.5,
      height: 22,
      axis: 'x',
    }),
    solid('pedal_hole_4', '安装孔 04', 'cylinder', 'subtract', [6, 48, 72], {
      radius: 5.5,
      height: 22,
      axis: 'x',
    }),
    solid('pedal_cheek_l', '左侧叉板', 'box', 'add', [62, -38, 55], { size: [112, 9, 58] }),
    solid('pedal_cheek_r', '右侧叉板', 'box', 'add', [62, 38, 55], { size: [112, 9, 58] }),
    solid('pedal_brace', '下横梁', 'box', 'add', [54, 0, 36], { size: [14, 68, 10] }),
    solid('pedal_gusset_l', '左加强筋', 'box', 'add', [32, -38, 28], {
      size: [54, 8, 10],
      rotation: [0, -42, 0],
    }),
    solid('pedal_gusset_r', '右加强筋', 'box', 'add', [32, 38, 28], {
      size: [54, 8, 10],
      rotation: [0, -42, 0],
    }),
    solid('pedal_boss', '枢轴座', 'cylinder', 'add', [106, 0, 72], { radius: 24, height: 92, axis: 'y' }),
    solid('pedal_bore', '枢轴孔', 'cylinder', 'subtract', [106, 0, 72], {
      radius: 13,
      height: 104,
      axis: 'y',
    }),
    solid('pedal_light_l', '左侧减重孔', 'cylinder', 'subtract', [58, -38, 55], {
      radius: 14,
      height: 24,
      axis: 'y',
    }),
    solid('pedal_light_r', '右侧减重孔', 'cylinder', 'subtract', [58, 38, 55], {
      radius: 14,
      height: 24,
      axis: 'y',
    }),
    solid('pedal_lever', '踏板臂', 'box', 'add', [162, 0, 52], {
      size: [118, 20, 16],
      rotation: [0, 22, 0],
    }),
    solid('pedal_pad', '踏板垫', 'box', 'add', [216, 0, 29], {
      size: [28, 48, 10],
      rotation: [0, 22, 0],
    }),
  ];
  const model = cloneModel(BRACKET_MODEL);
  model.id = `mdl_${Date.now().toString(36)}`;
  model.code = code;
  model.name = name;
  model.subtitle = 'Brake pedal bracket / CSG feature graph';
  model.revision = 'R01';
  model.template = 'csg';
  model.variables = [];
  model.features = csgFeatures(features);
  model.solidFeatures = features;
  model.supports = [
    {
      id: 'sup_wall',
      name: '安装面固定',
      face: 'x-min',
      type: 'fixed',
      enabled: true,
    },
  ];
  model.loads = [
    {
      id: 'load_pedal',
      name: '踏板端部载荷',
      face: 'x-max',
      vector: [0, 0, -1],
      magnitude: 500,
      enabled: true,
      description: '刹车踏板端部 · 500 N 下压',
    },
  ];
  model.mesh = { ...model.mesh, cellSizeMm: 4 };
  model.meta.created = new Date().toISOString().slice(0, 10);
  model.meta.client = 'VISION Brake Systems';
  model.meta.designIntent =
    '刹车踏板支架：后安装板固定，双侧叉板承载枢轴，踏板臂将 500 N 脚部载荷传至枢轴座。重点校核安装孔、叉板焊缝区与枢轴座。';
  return model;
}
