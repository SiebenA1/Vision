import { describe, expect, it } from 'vitest';
import { buildDeepSeekTools, buildModelContext, directionVector } from '../src/core/llm/tools';
import { parseEngineeringPrompt } from '../src/core/agent/nlu';
import { isModelDocument, nextProjectCode, seedProjects } from '../src/core/projects';
import { exportBinaryStl, parseBinaryStl } from '../src/core/cad/stl';
import type { GeometryData } from '../src/core/types';

describe('binary STL transport', () => {
  it('round-trips a closed tetrahedron through STL', async () => {
    const positions = new Float32Array([
      0, 0, 0,
      10, 0, 0,
      0, 10, 0,
      0, 0, 10,
    ]);
    const indices = new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      0, 3, 2,
      1, 2, 3,
    ]);
    const geometry: GeometryData = {
      positions,
      indices,
      bbox: { min: [0, 0, 0], max: [10, 10, 10] },
      volumeMm3: 1000 / 6,
      areaMm2: 0,
      triangleCount: 4,
      vertexCount: 4,
      buildMs: 0,
      watermark: 'TEST-0001',
    };
    const buffer = await exportBinaryStl(geometry);
    const parsed = parseBinaryStl(new Uint8Array(buffer), 'TEST-0001');
    expect(parsed.triangleCount).toBe(4);
    expect(parsed.bbox.max).toEqual([10, 10, 10]);
    expect(parsed.volumeMm3).toBeCloseTo(1000 / 6, 3);
    expect(parsed.watermark).toBe('TEST-0001');
  });
});

describe('blank project library', () => {
  it('starts from one generic blank workspace', () => {
    const projects = seedProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].model.code).toBe('CAD-000');
    expect(projects[0].model.template).toBe('empty');
    expect(projects[0].model.features).toHaveLength(0);
    expect(isModelDocument(projects[0].model)).toBe(true);
    expect(isModelDocument({ schema: 'wrong' })).toBe(false);
    expect(nextProjectCode(projects)).toBe('CAD-001');
  });
});

describe('generic modeling tool contract', () => {
  it('exposes USD BRep and no preset generator', () => {
    const tools = buildDeepSeekTools(seedProjects()[0].model);
    const names = tools.map((tool) => tool.function.name);
    expect(names).toContain('run_usd_brep');
    expect(names).not.toContain('generate_preset');
    expect(names).not.toContain('create_wheel_rim');
    expect(names).not.toContain('add_solid_feature');
    expect(directionVector('down')).toEqual([0, 0, -1]);
    expect(directionVector('right')).toEqual([1, 0, 0]);
  });

  it('does not route freeform modeling to a local preset', () => {
    const plan = parseEngineeringPrompt('帮我建模一个 18 英寸、9辐的汽车轮辋', seedProjects()[0].model);
    expect(plan.actions).toHaveLength(0);
    expect(plan.intent).toBe('clarify');
  });

  it('gives the agent the current USD BRep script for in-place edits', () => {
    const model = seedProjects()[0].model;
    model.template = 'external';
    model.externalScript = 'import usd_brep as u\nresult = u.create_box((0,0,0), 100, 20, 10)\n';
    const context = buildModelContext(model, null, false, null, null);
    expect((context.currentModel as { script: string | null }).script).toContain('create_box');
  });
});
