import { describe, expect, it } from 'vitest';
import { BRACKET_MODEL } from '../src/core/presets';
import { buildGeometry } from '../src/core/geometry/kernel';
import { voxelMesh } from '../src/core/fea/mesher';
import { solveVoxelMesh, toAnalysisResult, validateCantilever } from '../src/core/fea/solver';
import { getMaterial } from '../src/core/materials';
import { parseEngineeringPrompt } from '../src/core/agent/nlu';
import { buildDeepSeekTools, directionVector } from '../src/core/llm/tools';
import { isModelDocument, nextProjectCode, seedProjects } from '../src/core/projects';
import { createBlankModel, createStarterModel, createBrakePedalModel } from '../src/core/templates';

describe('parametric geometry kernel', () => {
  it('builds a watertight bracket with positive volume', async () => {
    const { geometry } = await buildGeometry(BRACKET_MODEL);
    expect(geometry.volumeMm3).toBeGreaterThan(100_000);
    expect(geometry.triangleCount).toBeGreaterThan(500);
    expect(geometry.bbox.max[0]).toBeCloseTo(BRACKET_MODEL.variables.find((v) => v.key === 'armLength')!.value, 0);
    expect(geometry.watermark).toMatch(/^[0-9A-F]{8}$/);
    console.info(
      `geometry: ${(geometry.volumeMm3 / 1000).toFixed(1)} cm³, ${geometry.triangleCount} tri, ${geometry.buildMs.toFixed(0)} ms`,
    );
  }, 60_000);

  it('changes volume when a parameter changes', async () => {
    const model = structuredClone(BRACKET_MODEL);
    const arm = model.variables.find((v) => v.key === 'armThickness')!;
    arm.value += 4;
    const { geometry } = await buildGeometry(model);
    const original = await buildGeometry(BRACKET_MODEL);
    expect(geometry.volumeMm3).toBeGreaterThan(original.geometry.volumeMm3);
  }, 60_000);
});

describe('C3D8 linear static solver', () => {
  it('matches the analytic cantilever benchmark', () => {
    const validation = validateCantilever();
    console.info(
      `validation: analytic=${validation.reference.toFixed(5)} mm, computed=${validation.computed.toFixed(5)} mm, error=${validation.errorPercent.toFixed(2)}%, ${validation.solveMs.toFixed(0)} ms`,
    );
    expect(Number.isFinite(validation.computed)).toBe(true);
    expect(validation.errorPercent).toBeLessThan(validation.tolerancePercent);
  }, 120_000);

  it('solves the bracket and satisfies global equilibrium', async () => {
    const { geometry } = await buildGeometry(BRACKET_MODEL);
    const started = performance.now();
    const mesh = voxelMesh(geometry, 7000, 3);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < mesh.nodeCount; i += 1) {
      minX = Math.min(minX, mesh.nodes[i * 3]);
      maxX = Math.max(maxX, mesh.nodes[i * 3]);
    }
    console.info(`mesh: h=${mesh.cellSize.toFixed(3)}, grid=${mesh.grid.join('x')}, elems=${mesh.elementCount}, nodes=${mesh.nodeCount}, x=[${minX},${maxX}], cad=[${geometry.bbox.min[0]},${geometry.bbox.max[0]}], voxelVolRatio=${(mesh.volumeMm3 / geometry.volumeMm3).toFixed(3)}`);
    const solution = solveVoxelMesh(mesh, {
      material: getMaterial('AL6061-T6'),
      supports: BRACKET_MODEL.supports,
      loads: BRACKET_MODEL.loads,
      tolerance: 1e-4,
      maxIterations: 2600,
    });
    const result = toAnalysisResult(solution, {
      material: getMaterial('AL6061-T6'),
      supports: BRACKET_MODEL.supports,
      loads: BRACKET_MODEL.loads,
      tolerance: 1e-4,
      maxIterations: 2600,
    }, {
      modelRevision: BRACKET_MODEL.revision,
      modelHash: geometry.watermark,
      studyName: 'test',
      cadVolumeMm3: geometry.volumeMm3,
      meshMs: 0,
    });
    console.info(
      `solve: ${mesh.elementCount} el, ${mesh.dofs} dof, ${solution.iterations} it, ${solution.solveMs.toFixed(0)} ms, ` +
        `σmax=${result.maxVonMises.toFixed(1)} MPa, δmax=${result.maxDisplacement.toFixed(3)} mm, SF=${result.safetyFactor.toFixed(2)}, ` +
        `iters=${result.solver.iterations}, relres=${result.solver.relativeResidual.toExponential(2)}, equilibrium=${result.equilibrium.relativeError.toExponential(2)}, total=${(performance.now() - started).toFixed(0)} ms`,
    );
    console.info('applied', result.equilibrium.applied, 'reaction', result.equilibrium.reaction, 'residual', result.equilibrium.residual);
    expect(result.solver.converged).toBe(true);
    expect(result.equilibrium.relativeError).toBeLessThan(1e-4);
    expect(result.maxVonMises).toBeGreaterThan(0);
  }, 120_000);
});

describe('natural language intent parsing', () => {
  it('parses a Chinese parameter update', () => {
    const plan = parseEngineeringPrompt('把悬臂厚度改成 16 mm，然后重新校核', BRACKET_MODEL);
    expect(plan.actions[0].tool).toBe('set_variable');
    expect(plan.actions[0].args.key).toBe('armThickness');
    expect(plan.actions[0].args.value).toBe(16);
    expect(plan.actions.some((action) => action.tool === 'run_analysis')).toBe(true);
  });

  it('parses material, load and safety target', () => {
    const plan = parseEngineeringPrompt('材料换成 7075，末端加载 1.2 kN 向下，安全系数至少 2.5', BRACKET_MODEL);
    expect(plan.actions.some((action) => action.tool === 'set_material')).toBe(true);
    const load = plan.actions.find((action) => action.tool === 'set_load');
    expect(load?.args.magnitude).toBe(1200);
    expect(plan.actions.some((action) => action.tool === 'optimize')).toBe(true);
  });

  it('maps a brake-pedal prompt to a CSG modeling preset', () => {
    const plan = parseEngineeringPrompt('帮我建模一个刹车踏板支架', BRACKET_MODEL);
    expect(plan.intent).toBe('modeling');
    expect(plan.actions[0].tool).toBe('generate_preset');
    expect(plan.actions[0].args.preset).toBe('brake-pedal');
  });
});

describe('DeepSeek tool contract', () => {
  it('exposes the engineering tools with model-bound enums', () => {
    const tools = buildDeepSeekTools(BRACKET_MODEL);
    const names = tools.map((tool) => tool.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'set_variable',
        'set_material',
        'set_load',
        'set_support',
        'run_analysis',
        'optimize',
        'explain_risk',
        'export_report',
        'generate_preset',
        'add_solid_feature',
      ]),
    );
    const variableTool = tools.find((tool) => tool.function.name === 'set_variable')!;
    const params = variableTool.function.parameters as {
      properties: { key: { enum: string[] } };
    };
    expect(params.properties.key.enum).toContain('armThickness');
    expect(directionVector('down')).toEqual([0, 0, -1]);
    expect(directionVector('right')).toEqual([1, 0, 0]);
  });
});

describe('project library', () => {
  it('seeds four distinct engineering projects', () => {
    const projects = seedProjects();
    expect(projects).toHaveLength(4);
    expect(new Set(projects.map((project) => project.model.code)).size).toBe(4);
    expect(projects.some((project) => project.model.code === 'BRK-042-L')).toBe(true);
    expect(projects.some((project) => project.model.code === 'PEDAL-01')).toBe(true);
    expect(isModelDocument(projects[0].model)).toBe(true);
    expect(isModelDocument({ schema: 'wrong' })).toBe(false);
    expect(nextProjectCode(projects).startsWith('BRK-')).toBe(true);
  });

  it('creates blank projects and all three starter primitives', async () => {
    const blank = createBlankModel('空白支架', 'TST-001');
    expect(blank.template).toBe('empty');
    expect(blank.variables).toHaveLength(0);
    expect(blank.features).toHaveLength(0);
    for (const template of ['plate', 'block', 'cylinder'] as const) {
      const model = createStarterModel(template, blank);
      expect(model.template).toBe(template);
      expect(model.variables.length).toBeGreaterThan(0);
      const { geometry } = await buildGeometry(model);
      expect(geometry.volumeMm3).toBeGreaterThan(0);
      expect(geometry.triangleCount).toBeGreaterThan(0);
    }
  }, 60_000);

  it('solves a blank-project plate starter', async () => {
    const blank = createBlankModel('空白板校核', 'TST-002');
    const model = createStarterModel('plate', blank);
    const { geometry } = await buildGeometry(model);
    const mesh = voxelMesh(geometry, 3500, 3);
    const solution = solveVoxelMesh(mesh, {
      material: getMaterial(model.materialId),
      supports: model.supports,
      loads: model.loads,
      tolerance: 1e-4,
      maxIterations: 1200,
    });
    expect(solution.converged).toBe(true);
    expect(solution.maxVonMises).toBeGreaterThan(0);
    expect(solution.equilibrium.relativeError).toBeLessThan(1e-4);
  }, 60_000);

  it('builds the brake-pedal CSG topology', async () => {
    const model = createBrakePedalModel();
    expect(model.template).toBe('csg');
    expect(model.solidFeatures?.length).toBe(16);
    expect(model.features.length).toBe(16);
    const { geometry, featureLog } = await buildGeometry(model);
    expect(geometry.volumeMm3).toBeGreaterThan(0);
    expect(geometry.triangleCount).toBeGreaterThan(100);
    expect(geometry.bbox.max[0]).toBeGreaterThan(200);
    expect(featureLog.length).toBe(16);
  }, 60_000);
});
