import type { DeepSeekTool } from './types';
import type { AnalysisResult, ModelDocument, ValidationResult } from '../types';
import { MATERIALS, getMaterial } from '../materials';

export const LOAD_FACES = ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'] as const;
export const LOAD_DIRECTIONS = ['down', 'up', 'left', 'right', 'forward', 'backward'] as const;

export function directionVector(direction: string): [number, number, number] {
  switch (direction) {
    case 'down':
      return [0, 0, -1];
    case 'up':
      return [0, 0, 1];
    case 'left':
      return [-1, 0, 0];
    case 'right':
      return [1, 0, 0];
    case 'forward':
      return [0, 1, 0];
    case 'backward':
      return [0, -1, 0];
    default:
      return [0, 0, -1];
  }
}

export function buildDeepSeekTools(model: ModelDocument): DeepSeekTool[] {
  const variableKeys = model.variables.map((variable) => variable.key);
  const variableList = model.variables
    .map((variable) => `${variable.key} (${variable.label}, ${variable.min}-${variable.max} ${variable.unit})`)
    .join('; ');

  return ([
    {
      type: 'function',
      function: {
        name: 'set_variable',
        description: `修改一个参数化设计变量并重建 watertight 几何。可选变量：${variableList}。修改后 FE 结果会过期。`,
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              enum: variableKeys,
              description: 'Design variable key.',
            },
            value: {
              type: 'number',
              description: 'New value in mm. The app clamps to the variable bounds.',
            },
            reason: {
              type: 'string',
              description: 'One short engineering reason for the change.',
            },
          },
          required: ['key', 'value'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_material',
        description: '切换各向同性线弹性材料。会更新质量和结果有效性。',
        parameters: {
          type: 'object',
          properties: {
            materialId: {
              type: 'string',
              enum: MATERIALS.map((material) => material.id),
              description: 'Material database id.',
            },
            reason: {
              type: 'string',
              description: 'Short engineering reason.',
            },
          },
          required: ['materialId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_load',
        description: '修改单个荷载工况的合力大小、加载面和方向。单位 N。',
        parameters: {
          type: 'object',
          properties: {
            magnitude: {
              type: 'number',
              minimum: 0,
              maximum: 1000000,
              description: 'Resultant force in N.',
            },
            face: {
              type: 'string',
              enum: [...LOAD_FACES],
              description: 'Face id used by the solver.',
            },
            direction: {
              type: 'string',
              enum: [...LOAD_DIRECTIONS],
              description: 'Global load direction: down=-Z, up=+Z, left=-X, right=+X, forward=+Y, backward=-Y.',
            },
          },
          required: ['magnitude', 'face', 'direction'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_support',
        description: '修改固定约束面；约束为该面的 6-DOF fixed。',
        parameters: {
          type: 'object',
          properties: {
            face: {
              type: 'string',
              enum: [...LOAD_FACES],
              description: 'Face id.',
            },
          },
          required: ['face'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_analysis',
        description:
          '运行一次真实 C3D8 线弹性静力校核。如果模型未变且结果有效，会复用现有结果；结果过期或不存在时重新求解。',
        parameters: {
          type: 'object',
          properties: {
            refinement: {
              type: 'boolean',
              description: 'If true, also run an h-refinement convergence check (slower).',
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'optimize',
        description:
          '打开生成式优化工作台并启动单变量 FE-in-the-loop 搜索。该操作异步运行，不要在结果完成前声称已得到优化解。',
        parameters: {
          type: 'object',
          properties: {
            variableKey: {
              type: 'string',
              enum: variableKeys,
              description: 'Design variable to optimize.',
            },
            targetSafety: {
              type: 'number',
              minimum: 0.5,
              maximum: 5,
              description: 'Minimum safety factor.',
            },
            displacementLimit: {
              type: 'number',
              minimum: 0.05,
              maximum: 20,
              description: 'Maximum displacement in mm.',
            },
          },
          required: ['variableKey', 'targetSafety', 'displacementLimit'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'explain_risk',
        description:
          '基于真实求解结果解释危险截面、材料裕度、控制因素和自动检查警告。没有有效结果时会先运行求解。',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'export_report',
        description:
          '生成并下载当前模型的 Markdown 工程校核报告。只有在用户明确要求报告时调用；没有有效结果时会先求解。',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_preset',
        description:
          '生成一个完整的工程预设模型并作为新项目打开。brake-pedal 生成刹车踏板支架；wind-blade 生成 NACA 截面放样风电叶片。轮辋必须使用 create_wheel_rim 按用户参数实时生成，不要用固定预设。',
        parameters: {
          type: 'object',
          properties: {
            preset: {
              type: 'string',
              enum: ['brake-pedal', 'wind-blade'],
              description: 'Engineering preset id.',
            },
            reason: {
              type: 'string',
              description: 'Short engineering reason.',
            },
          },
          required: ['preset'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_wheel_rim',
        description:
          '按用户明确参数实时生成汽车轮辋，不得用固定 5 辐预设代替。辐条数量、外径、宽度、PCD、中心孔、螺栓孔数量都进入参数化 CSG 生成器；生成后重建 watertight 几何。',
        parameters: {
          type: 'object',
          properties: {
            spokeCount: {
              type: 'integer',
              minimum: 3,
              maximum: 20,
              description: 'Number of equally spaced spokes requested by the user.',
            },
            outerDiameterMm: {
              type: 'number',
              minimum: 300,
              maximum: 700,
              description: 'Bead-seat outer diameter in mm. 18 inch = 457.2 mm.',
            },
            widthMm: {
              type: 'number',
              minimum: 100,
              maximum: 350,
              description: 'Rim width in mm.',
            },
            pcdMm: {
              type: 'number',
              minimum: 80,
              maximum: 220,
              description: 'Bolt circle diameter in mm.',
            },
            centerBoreMm: {
              type: 'number',
              minimum: 35,
              maximum: 130,
              description: 'Center bore diameter in mm.',
            },
            lugCount: {
              type: 'integer',
              minimum: 3,
              maximum: 8,
              description: 'Number of lug holes.',
            },
            materialId: {
              type: 'string',
              enum: MATERIALS.map((material) => material.id),
              description: 'Material database id.',
            },
          },
          required: ['spokeCount', 'outerDiameterMm', 'widthMm', 'pcdMm', 'centerBoreMm', 'lugCount'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_usd_brep',
        description:
          '通用 CAD 建模入口：执行一段 NVIDIA USD BRep（NURBS B-Rep）Python 脚本。脚本必须 import usd_brep as u，并把一个 usd_brep.Brep 赋给名为 result 的顶层变量。单位 mm，Z 向上。默认更新当前工程；只有用户明确要求“新建工程”时才设置 new_project=true。',
        parameters: {
          type: 'object',
          properties: {
            script: {
              type: 'string',
              description:
                'Complete Python script using usd_brep. Example: "import usd_brep as u\\nresult = u.create_box((0,0,0), 100, 20, 10)". Must assign `result` (a Brep) at top level.',
            },
            name: { type: 'string', description: 'Short model name. For an update this is ignored unless creating a new project.' },
            code: { type: 'string', description: 'Optional project code. Only used when new_project=true.' },
            new_project: {
              type: 'boolean',
              description: 'Create a new project. Default false updates the active project in place.',
            },
            density_kg_m3: {
              type: 'number',
              description: 'Uniform density used only for mass reporting.',
            },
            materialId: {
              type: 'string',
              enum: MATERIALS.map((material) => material.id),
              description: 'VISION material id for downstream mass/FEA metadata.',
            },
          },
          required: ['script'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'add_solid_feature',
        description:
          '向当前 CSG 特征图追加一个实体或切除特征，并重建 watertight 几何。只能用于 CSG 模型；若不是 CSG 模型，先调用 generate_preset。坐标系为 mm，Z 向上。',
        parameters: {
          type: 'object',
          properties: {
            shape: {
              type: 'string',
              enum: ['box', 'cylinder', 'sphere'],
              description: 'Primitive type.',
            },
            operation: {
              type: 'string',
              enum: ['add', 'subtract'],
              description: 'Boolean union or difference.',
            },
            x: { type: 'number', description: 'Center X in mm.' },
            y: { type: 'number', description: 'Center Y in mm.' },
            z: { type: 'number', description: 'Center Z in mm.' },
            sx: { type: 'number', description: 'Box size X in mm.' },
            sy: { type: 'number', description: 'Box size Y in mm.' },
            sz: { type: 'number', description: 'Box size Z in mm.' },
            radius: { type: 'number', description: 'Cylinder/sphere radius in mm.' },
            height: { type: 'number', description: 'Cylinder height in mm.' },
            axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'Cylinder axis.' },
            rx: { type: 'number', description: 'Rotation about X in degrees.' },
            ry: { type: 'number', description: 'Rotation about Y in degrees.' },
            rz: { type: 'number', description: 'Rotation about Z in degrees.' },
            reason: { type: 'string', description: 'Short engineering reason.' },
          },
          required: ['shape', 'operation'],
          additionalProperties: false,
        },
      },
    },
  ] as DeepSeekTool[]).filter(
    (tool) =>
      !['generate_preset', 'create_wheel_rim', 'add_solid_feature', 'set_variable', 'optimize'].includes(
        tool.function.name,
      ),
  );
}

export function buildModelContext(
  model: ModelDocument,
  analysis: AnalysisResult | null,
  stale: boolean,
  validation: ValidationResult | null,
  geometry: { volumeCm3: number; massKg: number; bbox: number[]; triangles: number } | null,
): Record<string, unknown> {
  const material = getMaterial(model.materialId);
  return {
    project: {
      code: model.code,
      name: model.name,
      revision: model.revision,
      template: model.template ?? 'bracket',
      units: model.units,
      discipline: model.meta.discipline,
      designIntent: model.meta.designIntent,
    },
    material: {
      id: material.id,
      name: material.name,
      E_MPa: material.E,
      nu: material.nu,
      rho_kg_m3: material.rho,
      yield_MPa: material.yieldStrength,
      standardized: material.standard,
    },
    variables: model.variables.map((variable) => ({
      key: variable.key,
      label: variable.label,
      value: variable.value,
      min: variable.min,
      max: variable.max,
      step: variable.step,
      unit: variable.unit,
      group: variable.group,
    })),
    solidFeatures: (model.solidFeatures ?? []).map((feature) => ({
      id: feature.id,
      name: feature.name,
      shape: feature.shape,
      operation: feature.operation,
      position: feature.position,
      rotation: feature.rotation,
      size: feature.size,
      radius: feature.radius,
      height: feature.height,
      axis: feature.axis,
    })),
    supports: model.supports.map((support) => ({
      name: support.name,
      face: support.face,
      type: support.type,
      enabled: support.enabled,
    })),
    loads: model.loads.map((load) => ({
      name: load.name,
      face: load.face,
      vector: load.vector,
      magnitude_N: load.magnitude,
      enabled: load.enabled,
    })),
    mesh: {
      elementType: model.mesh.elementType,
      cellSizeMm: model.mesh.cellSizeMm,
      targetElements: model.mesh.targetElements,
      boundaryPolicy: model.mesh.boundaryPolicy,
      tolerance: model.mesh.tolerance,
    },
    geometry: geometry
      ? {
          volume_cm3: Number(geometry.volumeCm3.toFixed(3)),
          mass_kg: Number(geometry.massKg.toFixed(5)),
          bbox_mm: geometry.bbox,
          triangles: geometry.triangles,
        }
      : null,
    lastResult: analysis
      ? {
          stale,
          modelHash: analysis.modelHash,
          status: analysis.status,
          maxVonMises_MPa: Number(analysis.maxVonMises.toFixed(3)),
          maxDisplacement_mm: Number(analysis.maxDisplacement.toFixed(5)),
          safetyFactor: Number(analysis.safetyFactor.toFixed(4)),
          mass_kg: Number(analysis.massKg.toFixed(5)),
          hotspot_mm: analysis.maxVonMisesLocation.map((value) => Number(value.toFixed(2))),
          elements: analysis.mesh.elements,
          nodes: analysis.mesh.nodes,
          dofs: analysis.mesh.dofs,
          iterations: analysis.solver.iterations,
          relativeResidual: analysis.solver.relativeResidual,
          equilibriumError: analysis.equilibrium.relativeError,
          warnings: analysis.warnings,
          convergence: analysis.convergence ?? null,
        }
      : null,
    validation: validation
      ? {
          case: validation.caseId,
          name: validation.name,
          referenceMm: Number(validation.reference.toFixed(6)),
          computedMm: Number(validation.computed.toFixed(6)),
          errorPercent: Number(validation.errorPercent.toFixed(3)),
          passed: validation.passed,
          tolerancePercent: validation.tolerancePercent,
        }
      : null,
    capabilities: [
      'set_material',
      'set_load',
      'set_support',
      'run_analysis',
      'explain_risk',
      'export_report',
      'run_usd_brep',
    ],
  };
}
