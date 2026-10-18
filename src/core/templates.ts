import type {
  DesignVariable,
  FeatureDescriptor,
  GeometryTemplate,
  ModelDocument,
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
