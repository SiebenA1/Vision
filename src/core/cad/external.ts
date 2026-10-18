import type { GeometryMetrics, ModelDocument } from '../types';
import { createBlankProjectModel } from '../projects';

export interface ExternalModelInput {
  name: string;
  code?: string;
  newProject?: boolean;
  script: string;
  stlBase64: string;
  metrics: {
    volume_mm3: number;
    area_mm2: number;
    mass_kg?: number;
    bbox_mm: {
      min: [number, number, number];
      max: [number, number, number];
      size: [number, number, number];
    };
  };
  materialId?: string;
}

/**
 * Wraps a generic build123d/OCCT result as a VISION model. No geometry preset
 * is involved: the script and the OCCT-generated STL are the model source.
 */
export function createExternalModel(input: ExternalModelInput): {
  model: ModelDocument;
  metrics: GeometryMetrics;
} {
  const model = createBlankProjectModel(input.code ?? `CAD-${String(Date.now()).slice(-4)}`, input.name || 'AI B-Rep 模型');
  model.id = `mdl_${Date.now().toString(36)}`;
  model.subtitle = 'NVIDIA USD BRep';
  model.template = 'external';
  model.materialId = input.materialId ?? 'AL6061-T6';
  model.variables = [];
  model.features = [
    {
      id: 'backend',
      index: '01',
      name: 'NVIDIA USD BRep',
      nameEn: 'B-REP',
      kind: 'solid',
      operation: 'add',
      description: 'NVIDIA NURBS B-Rep · 由 usd_brep 脚本实时生成',
      variableKeys: [],
      quality: 'primary',
    },
  ];
  delete model.solidFeatures;
  model.externalScript = input.script;
  model.externalStlBase64 = input.stlBase64;
  model.supports = [
    {
      id: 'sup_external',
      name: '外部模型约束',
      face: 'x-min',
      type: 'fixed',
      enabled: true,
    },
  ];
  model.loads = [
    {
      id: 'load_external',
      name: '外部模型载荷',
      face: 'x-max',
      vector: [0, 0, -1],
      magnitude: 1000,
      enabled: true,
      description: '通用占位载荷 · 需按实际工况修改',
    },
  ];
  model.mesh = { ...model.mesh, cellSizeMm: 1.5, elementType: 'C3D4' };
  model.meta.created = new Date().toISOString().slice(0, 10);
  model.meta.designIntent =
    '由 NVIDIA USD BRep（NURBS）生成的精确 B-Rep 几何。载荷与约束为通用占位，必须在分析前按工程工况确认。';
  const { min, max, size } = input.metrics.bbox_mm;
  const metrics: GeometryMetrics = {
    volumeCm3: input.metrics.volume_mm3 / 1000,
    massKg: input.metrics.mass_kg ?? 0,
    surfaceCm2: input.metrics.area_mm2 / 100,
    bbox: { min, max },
    triangleCount: 0,
    buildMs: 0,
    watermark: '',
  };
  model.externalMetrics = metrics;
  model.meta.designIntent += ` 包围盒 ${size.join(' × ')} mm。`;
  return { model, metrics };
}
