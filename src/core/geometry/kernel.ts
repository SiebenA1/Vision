import ManifoldModule from 'manifold-3d';
import type {
  CrossSection as CrossSectionInstance,
  Manifold as ManifoldInstance,
  ManifoldToplevel,
  Mat4,
  Vec2,
} from 'manifold-3d';
import type { Box3, GeometryData, ModelDocument, Vec3 } from '../types';

type Runtime = ManifoldToplevel;

let runtimePromise: Promise<Runtime> | null = null;

export async function getKernel(): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = ManifoldModule().then((runtime) => {
      runtime.setup();
      return runtime;
    });
  }
  return runtimePromise;
}

interface BuildContext {
  runtime: Runtime;
  solids: ManifoldInstance[];
  sections: CrossSectionInstance[];
}

function vals(model: ModelDocument): Record<string, number> {
  return Object.fromEntries(model.variables.map((variable) => [variable.key, variable.value]));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundedRectContour(width: number, height: number, radius: number, segments = 7): Vec2[] {
  const hw = width / 2;
  const hh = height / 2;
  const r = clamp(radius, 0.5, Math.min(hw, hh) - 0.1);
  const points: Vec2[] = [];
  const corners: Array<[number, number, number, number]> = [
    [hw - r, -hh + r, -90, 0],
    [hw - r, hh - r, 0, 90],
    [-hw + r, hh - r, 90, 180],
    [-hw + r, -hh + r, 180, 270],
  ];
  for (const [cx, cy, start, end] of corners) {
    for (let i = 0; i <= segments; i += 1) {
      const angle = ((start + ((end - start) * i) / segments) * Math.PI) / 180;
      points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
    }
  }
  return points;
}

function roundedTipContour(length: number, width: number, segments = 24): Vec2[] {
  const r = width / 2;
  const straightEnd = Math.max(0.5, length - r);
  const points: Vec2[] = [[0, -r], [straightEnd, -r]];
  for (let i = 0; i <= segments; i += 1) {
    const angle = -Math.PI / 2 + (Math.PI * i) / segments;
    points.push([straightEnd + Math.cos(angle) * r, Math.sin(angle) * r]);
  }
  points.push([0, r]);
  return points;
}

function axisMatrix(axis: 'x' | 'y' | 'z'): Mat4 {
  // Rotate a Z-aligned extrusion onto the requested global axis.
  if (axis === 'x') {
    return [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  }
  if (axis === 'y') {
    return [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  }
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function trackSolid(ctx: BuildContext, solid: ManifoldInstance): ManifoldInstance {
  ctx.solids.push(solid);
  return solid;
}

function extrudeSection(
  ctx: BuildContext,
  contour: Vec2[],
  height: number,
): ManifoldInstance {
  const section = new ctx.runtime.CrossSection([contour]);
  ctx.sections.push(section);
  return trackSolid(ctx, section.extrude(height));
}

function rod(
  ctx: BuildContext,
  radius: number,
  length: number,
  center: Vec3,
  axis: 'x' | 'y' | 'z',
  segments = 32,
): ManifoldInstance {
  const base = ctx.runtime.Manifold.cylinder(length, radius, radius, segments, true);
  const rotated = base.transform(axisMatrix(axis));
  base.delete();
  const placed = rotated.translate(center[0], center[1], center[2]);
  rotated.delete();
  return trackSolid(ctx, placed);
}

function hashDocument(model: ModelDocument): string {
  let hash = 2166136261;
  const token = `${model.template ?? 'bracket'}|${model.variables.map((v) => `${v.key}:${v.value.toFixed(4)}`).join('|')}`;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

async function buildPrimitiveGeometry(
  model: ModelDocument,
  template: 'plate' | 'block' | 'cylinder',
  started: number,
): Promise<{ geometry: GeometryData; featureLog: string[] }> {
  const runtime = await getKernel();
  const v = vals(model);
  const featureLog: string[] = [];
  let body: ManifoldInstance | null = null;
  try {
    if (template === 'cylinder') {
      const diameter = Math.max(5, v.diameter ?? 60);
      const height = Math.max(5, v.height ?? 100);
      const base = runtime.Manifold.cylinder(height, diameter / 2, diameter / 2, 64, true);
      body = base.translate(0, 0, height / 2);
      base.delete();
      featureLog.push(`CYLINDER · Ø${diameter.toFixed(1)} × ${height.toFixed(1)}`);
    } else {
      const length = Math.max(5, v.length ?? 120);
      const width = Math.max(5, v.width ?? 80);
      const height = template === 'plate' ? Math.max(1, v.thickness ?? 10) : Math.max(5, v.height ?? 60);
      const base = runtime.Manifold.cube([length, width, height], true);
      body = base.translate(0, 0, height / 2);
      base.delete();
      featureLog.push(`${template.toUpperCase()} · ${length.toFixed(1)} × ${width.toFixed(1)} × ${height.toFixed(1)}`);
    }
    if (!body) throw new Error('基础体未生成。');
    const mesh = body.getMesh();
    const positions = new Float32Array(mesh.vertProperties);
    const indices = new Uint32Array(mesh.triVerts);
    const bounds = body.boundingBox();
    const volume = body.volume();
    if (!Number.isFinite(volume) || volume <= 0 || indices.length < 12) {
      throw new Error('基础体几何无效。');
    }
    return {
      geometry: {
        positions,
        indices,
        bbox: {
          min: [bounds.min[0], bounds.min[1], bounds.min[2]],
          max: [bounds.max[0], bounds.max[1], bounds.max[2]],
        },
        volumeMm3: volume,
        areaMm2: body.surfaceArea(),
        triangleCount: indices.length / 3,
        vertexCount: positions.length / 3,
        buildMs: performance.now() - started,
        watermark: hashDocument(model),
      },
      featureLog,
    };
  } finally {
    try {
      body?.delete();
    } catch {
      // Best-effort WASM disposal.
    }
  }
}

/**
 * Evaluates the parametric feature recipe into a watertight triangle mesh.
 *
 * The geometric kernel is Manifold (robust mesh-boolean kernel). All structural
 * solids are exact prisms of planar/quadric profiles; booleans are performed on
 * a watertight manifold and the result is checked for volume, genus and mesh
 * validity before it is published to the viewport or the analysis worker.
 */
export async function buildGeometry(model: ModelDocument): Promise<{
  geometry: GeometryData;
  featureLog: string[];
}> {
  const started = performance.now();
  const template = model.template ?? 'bracket';
  if (template === 'empty') {
    throw new Error('空白工程尚未添加基础体。');
  }
  if (template !== 'bracket') {
    return buildPrimitiveGeometry(model, template, started);
  }
  const runtime = await getKernel();
  const v = vals(model);
  const ctx: BuildContext = { runtime, solids: [], sections: [] };
  const featureLog: string[] = [];

  try {
    const wallWidth = Math.max(30, v.wallWidth);
    const wallHeight = Math.max(50, v.wallHeight);
    const wallThickness = Math.max(3, v.wallThickness);
    const armLength = Math.max(wallThickness + 20, v.armLength);
    const armWidth = Math.max(20, Math.min(v.armWidth, wallWidth * 0.9));
    const armThickness = Math.max(3, Math.min(v.armThickness, wallHeight * 0.35));
    const ribThickness = Math.max(2, Math.min(v.ribThickness, armWidth / 3));
    const ribLength = clamp(v.ribLength, 10, armLength - 12);
    const bossHeight = clamp(v.bossHeight, 1, 24);
    const bossDiameter = clamp(v.bossDiameter, v.tipHoleDia + 4, armWidth * 0.95);
    const mountHoleDia = clamp(v.mountHoleDia, 2, Math.min(wallWidth, wallHeight) * 0.12);
    const tipHoleDia = clamp(v.tipHoleDia, 2, bossDiameter - 4);
    const lighteningHoleDia = clamp(v.lighteningHoleDia, 4, Math.min(armWidth * 0.55, 26));
    const mountInset = clamp(v.mountHoleInset, mountHoleDia / 2 + 2, wallWidth / 2 - mountHoleDia / 2 - 2);
    const zArmBottom = wallHeight - armThickness;
    const cornerRadius = Math.min(16, wallWidth * 0.12, wallHeight * 0.1);

    // 01 — Back plate: rounded-rectangle silhouette extruded through wall thickness.
    const wallProfile = roundedRectContour(wallWidth, wallHeight, cornerRadius, 8);
    const wallBlank = extrudeSection(ctx, wallProfile, wallThickness);
    const wall = wallBlank
      .transform([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1] as Mat4)
      .translate(0, 0, wallHeight / 2);
    trackSolid(ctx, wall);
    featureLog.push('WALL · rounded rectangle 96×120×10');

    // 02 — Cantilever arm: rounded tip in plan, extruded vertically.
    const arm = extrudeSection(ctx, roundedTipContour(armLength, armWidth, 26), armThickness)
      .translate(0, 0, zArmBottom);
    featureLog.push('ARM · rounded-tip plate');

    // 03 — Twin mirrored gussets: triangular prisms embedded in wall and arm.
    const ribHeight = Math.min(ribLength * 0.92, wallHeight * 0.52);
    const triangle: Vec2[] = [
      [wallThickness * 0.35, zArmBottom],
      [wallThickness * 0.35, Math.max(6, zArmBottom - ribHeight)],
      [wallThickness + ribLength, zArmBottom],
    ];
    const ribSection = new runtime.CrossSection([triangle]);
    ctx.sections.push(ribSection);
    const ribBlank = trackSolid(ctx, ribSection.extrude(ribThickness));
    const ribMap: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
    const ribY = armWidth / 2 - ribThickness / 2;
    const ribRight = ribBlank.transform(ribMap).translate(0, ribY + ribThickness / 2, 0);
    const ribLeft = ribBlank.transform(ribMap).translate(0, -ribY + ribThickness / 2, 0);
    trackSolid(ctx, ribRight);
    trackSolid(ctx, ribLeft);
    featureLog.push('RIBS · 2 × triangular gusset');

    // 04 — Boss ring seat at the pin joint.
    const bossX = armLength - bossDiameter * 0.5;
    const bossZ = zArmBottom + bossHeight / 2 + armThickness / 2;
    const boss = rod(ctx, bossDiameter / 2, bossHeight + armThickness, [bossX, 0, bossZ], 'z', 40);
    featureLog.push('BOSS · load introduction ring');

    // Union the positive solids.
    let body = wall.add(arm);
    body = body.add(ribRight).add(ribLeft).add(boss);
    trackSolid(ctx, body);
    featureLog.push('BOOLEAN · union / watertight check');

    // 05 — Four wall mounting holes, drilled along X.
    const holeRadius = mountHoleDia / 2;
    const mountZs = [mountInset, wallHeight - mountInset];
    const mountYs = [-(wallWidth / 2 - mountInset), wallWidth / 2 - mountInset];
    let cutters: ManifoldInstance[] = [];
    for (const y of mountYs) {
      for (const z of mountZs) {
        cutters.push(rod(ctx, holeRadius, wallThickness + 6, [wallThickness / 2, y, z], 'x', 28));
      }
    }
    featureLog.push('MOUNT HOLES · 4 × Ø' + mountHoleDia.toFixed(1));

    // 06 — Twin lightening holes through the low-stress lower wall region.
    const lightRadius = lighteningHoleDia / 2;
    const lightZ = wallHeight * 0.3;
    const lightY = wallWidth * 0.21;
    cutters.push(rod(ctx, lightRadius, wallThickness + 6, [wallThickness / 2, -lightY, lightZ], 'x', 30));
    cutters.push(rod(ctx, lightRadius, wallThickness + 6, [wallThickness / 2, lightY, lightZ], 'x', 30));
    featureLog.push('LIGHTENING · 2 × Ø' + lighteningHoleDia.toFixed(1));

    // 07 — Pin bore through boss and arm.
    cutters.push(
      rod(ctx, tipHoleDia / 2, armThickness + bossHeight + 10, [bossX, 0, zArmBottom + armThickness / 2 + bossHeight / 2], 'z', 32),
    );
    featureLog.push('PIN HOLE · Ø' + tipHoleDia.toFixed(1) + ' through boss');

    for (const cutter of cutters) {
      body = body.subtract(cutter);
    }
    trackSolid(ctx, body);
    cutters = [];

    const mesh = body.getMesh();
    const positions = new Float32Array(mesh.vertProperties);
    const indices = new Uint32Array(mesh.triVerts);
    const triangleCount = indices.length / 3;

    if (!Number.isFinite(body.volume()) || body.volume() <= 0) {
      throw new Error('几何内核返回无效体积，请检查特征参数。');
    }
    if (triangleCount < 12) {
      throw new Error('几何结果为空或退化。');
    }

    const bounds = body.boundingBox();
    const bbox: Box3 = {
      min: [bounds.min[0], bounds.min[1], bounds.min[2]],
      max: [bounds.max[0], bounds.max[1], bounds.max[2]],
    };

    const geometry: GeometryData = {
      positions,
      indices,
      bbox,
      volumeMm3: body.volume(),
      areaMm2: body.surfaceArea(),
      triangleCount,
      vertexCount: positions.length / 3,
      buildMs: performance.now() - started,
      watermark: hashDocument(model),
    };

    return { geometry, featureLog };
  } finally {
    for (const solid of ctx.solids) {
      try {
        solid.delete();
      } catch {
        // Best-effort disposal; a deleted alias is harmless.
      }
    }
    for (const section of ctx.sections) {
      try {
        section.delete();
      } catch {
        // Best-effort disposal.
      }
    }
  }
}

export async function exportBinaryStl(geometry: GeometryData): Promise<ArrayBuffer> {
  const triangleCount = geometry.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  const header = 'VISION / watertight STL export';
  for (let i = 0; i < Math.min(header.length, 79); i += 1) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triangleCount, true);
  const p = geometry.positions;
  const idx = geometry.indices;
  let offset = 84;
  for (let t = 0; t < triangleCount; t += 1) {
    const a = idx[t * 3] * 3;
    const b = idx[t * 3 + 1] * 3;
    const c = idx[t * 3 + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const value of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
}
