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

export function buildDeepSeekTools(_model: ModelDocument): DeepSeekTool[] {
  return ([
    {
      type: 'function', function: {
        name: 'withdraw_engineering_memory', description: '仅当用户本轮明确撤回某要求或要求忘记时使用。retract 保留历史但停止作为有效要求；forget 清除该来源及派生会话。不能自行删除不方便的约束；必须先维护有来源且无歧义的 revise/cancel/clarify 意图。id 来自当前记忆或历史搜索结果。',
        parameters: { type: 'object', properties: { sourceEventId: { type: 'string' }, id: { type: 'string' }, action: { type: 'string', enum: ['retract', 'forget'] } }, required: ['sourceEventId', 'id', 'action'], additionalProperties: false },
      },
    },
    {
      type: 'function', function: {
        name: 'read_engineering_source', description: '按当前上下文或历史搜索返回的 eventId 分页读取原始用户消息、先前方案或工具记录。摘要截断、指代不清或要核对细节时使用；不能把 assistant/intent 文本当作测量。',
        parameters: { type: 'object', properties: { eventId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['eventId'], additionalProperties: false },
      },
    },
    {
      type: 'function', function: {
        name: 'search_engineering_history', description: '按本轮任务查找较早的用户原话、先前方案和带来源的执行记录。近期对话或记忆不足以确定“上次/第二个方案/原先约束”时，先检索，不能猜测。可换同义关键词再次搜索。结果是历史来源，不是当前实测。',
        parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 2000 } }, required: ['query'], additionalProperties: false },
      },
    },
    {
      type: 'function', function: {
        name: 'update_task_intent',
        description: '工程操作前维护本轮的任务理解。根据当前用户原话、历史用户消息和已成功工具结果，说明本轮是新目标、继续、修订、取消或澄清。理解是 agent interpretation，不是用户已确认事实；不确定的指代或互斥要求必须列入 unresolved。需要承接历史时引用 recentDialogue 或 interpretedIntent 中的真实 eventId。重要长期要求另用 remember_engineering_intent 保存。',
        parameters: { type: 'object', properties: {
          sourceEventId: { type: 'string' }, goal: { type: 'string', maxLength: 1500 },
          relation: { type: 'string', enum: ['new', 'continue', 'revise', 'cancel', 'clarify'] },
          basedOnEventIds: { type: 'array', items: { type: 'string' }, maxItems: 12 },
          unresolved: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        }, required: ['sourceEventId', 'goal', 'relation', 'basedOnEventIds', 'unresolved'], additionalProperties: false },
      },
    },
    {
      type: 'function', function: {
        name: 'remember_engineering_intent',
        description: '保存用户明确声明的工程要求、决定、假设或展示偏好。content 必须逐字摘自 userSourceEventId 对应用户原话，不能写入自己生成的数字或用途推测。topic 用稳定的单一主题，如“接口孔径”或“密封用途”；同主题新旧值会保留冲突供用户选择。target 仅可为 project 或本轮选中原生对象 ID。不要把每句闲聊都保存。',
        parameters: { type: 'object', properties: {
          sourceEventId: { type: 'string', description: '本轮上下文提供的 userSourceEventId' },
          content: { type: 'string', maxLength: 2000, description: '用户原话中的连续片段，保留数值、单位和条件' },
          topic: { type: 'string', maxLength: 80 },
          kind: { type: 'string', enum: ['requirement', 'decision', 'assumption', 'preference'] },
          target: { type: 'string', description: 'project 或 currentSelection 中的 ID' },
          supersedesId: { type: 'string', description: '仅用户本轮明确修订某要求时，填当前记忆中被替换项的 id；保留原记录和修订来源。必须先 update_task_intent(relation=revise)。不确定是否替换时不要填写，先澄清。' },
        }, required: ['sourceEventId', 'content', 'topic', 'kind', 'target'], additionalProperties: false },
      },
    },
    {
      type: 'function', function: {
        name: 'query_usd_brep', description: '查询已安装 USD BRep 的真实 API 签名与文档。使用不熟悉的扫掠、曲面、抽壳、圆角、修复或导入导出前先查询；不要猜测函数签名。',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'Function name or group, e.g. pipe_sweep, create_skin, fillet, surfaces, usd' }, offset: { type: 'integer', minimum: 0 } }, required: ['query'], additionalProperties: false },
      },
    },
    {
      type: 'function', function: {
        name: 'configure_study', description: '一次性配置多个固定约束、合力载荷、分析实体与网格尺寸。支持极值面、box/sphere 空间区域、原生 cad-face 选择。零件之间无隐式粘接/接触。修改后需单独运行分析。',
        parameters: { type: 'object', properties: {
          study_json: { type: 'string', description: 'JSON object with optional supports:[{id,name,face,type:"fixed",enabled,region?}], loads:[{id,name,face,vector:[x,y,z],magnitude,enabled,region?}], bodyIds:["body-0"], meshSize:number. region={type:"box",min:[x,y,z],max:[x,y,z]} or {type:"sphere",center:[x,y,z],radius:number}. or {type:"cad-face",artifactId:"current artifact",faceIds:["body-0/face-0"],toleranceMm:0.075}. Native face IDs must belong to the current artifact. Coordinates mm. Use enabled:true.' },
        }, required: ['study_json'], additionalProperties: false },
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
        description: '修改固定约束面；约束为该面的 3 translational DOF fixed。',
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
          '运行一次真实 TetGen C3D4 / scikit-fem 线弹性静力校核。如果模型未变且结果有效，会复用现有结果；结果过期或不存在时重新求解。',
        parameters: {
          type: 'object',
          properties: {
            refinement: {
              type: 'boolean',
              description: 'If true, run two solves with decreasing requested mesh size and compare displacement; this is not proof of mesh independence.',
            },
          },
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
        name: 'run_usd_brep',
        description:
          '通用 CAD 建模入口：执行一段 NVIDIA USD BRep（NURBS B-Rep）Python 脚本。脚本必须 import usd_brep as u，并把 Brep、Brep 列表或 name->Brep 字典赋给 result（支持实体与片体）。单位 mm，Z 向上。默认更新当前工程；只有用户明确要求“新建工程”时才设置 new_project=true。',
        parameters: {
          type: 'object',
          properties: {
            options_json: { type: 'string', description: 'Optional JSON: parameters:{key:number|string|boolean}, tolerance_mm (absolute chord tolerance, default .05), angle_deg, relative_accuracy, heal.' },
            use_current: { type: 'boolean', description: 'Default true on an existing native model: import previous BReps as parts[name] before executing the script. Copy/reuse bodies according to the API ownership rules.' },
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
  ] as DeepSeekTool[]);
}

export function buildModelContext(
  model: ModelDocument,
  analysis: AnalysisResult | null,
  stale: boolean,
  validation: ValidationResult | null,
  geometry: { volumeCm3: number; massKg: number; bbox: number[]; triangles: number } | null,
): Record<string, unknown> {
  const material = getMaterial(model.materialId);
  const script = model.externalScript ?? '';
  return {
    cadKernel: {
      name: 'NVIDIA USD BRep 1.0.0',
      api: 'import usd_brep as u; assign a Brep to result',
      units: 'mm',
      upAxis: 'Z',
    },
    project: {
      code: model.code,
      name: model.name,
      revision: model.revision,
      template: model.template ?? 'bracket',
      units: model.units,
      discipline: model.meta.discipline,
      designIntent: model.meta.designIntent,
    },
    currentModel: {
      hasGeometry: Boolean(model.externalStlBase64),
      script: script || null,
      native: model.cad ? { artifactId: model.cad.artifactId, kernelVersion: model.cad.kernelVersion, parameters: model.cad.parameters, settings: model.cad.settings, bodies: model.cad.bodies.map((body) => ({ id: body.id, name: body.name, kind: body.kind, bbox: body.bbox_mm, faceCount: body.faces.length, edgeCount: body.edges.length })), selectedBodyIds: model.studyBodyIds } : null,
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
      region: support.region ?? null,
      type: support.type,
      enabled: support.enabled,
    })),
    loads: model.loads.map((load) => ({
      name: load.name,
      face: load.face,
      region: load.region ?? null,
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
      'run_usd_brep', 'query_usd_brep', 'configure_study',
    ],
  };
}
