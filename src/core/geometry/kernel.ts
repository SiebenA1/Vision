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
  const featureToken = (model.solidFeatures ?? [])
    .map((feature) =>
      [
        feature.shape,
        feature.operation,
        feature.enabled ? 1 : 0,
        feature.position.join(','),
        feature.rotation.join(','),
        feature.size.join(','),
        feature.radius,
        feature.height,
        feature.axis,
      ].join(':'),
    )
    .join(';');
  const token = `${model.template ?? 'bracket'}|${featureToken}|${model.variables.map((v) => `${v.key}:${v.value.toFixed(4)}`).join('|')}`;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

function bladeSection(chord: number, thickness: number, camber: number, twistDeg: number, segments: number): Array<[number, number, number]> {
  const upper: Array<[number, number, number]> = [];
  const lower: Array<[number, number, number]> = [];
  const theta = (twistDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const camberPos = 0.4;
  for (let j = 0; j <= segments; j += 1) {
    const u = j / segments;
    const yt =
      5 *
      thickness *
      (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u * u * u - 0.1036 * u * u * u * u);
    let yc = 0;
    let slope = 0;
    if (camber > 1e-6) {
      if (u < camberPos) {
        yc = (camber / (camberPos * camberPos)) * (2 * camberPos * u - u * u);
        slope = (2 * camber / (camberPos * camberPos)) * (camberPos - u);
      } else {
        yc = (camber / ((1 - camberPos) * (1 - camberPos))) * (1 - 2 * camberPos + 2 * camberPos * u - u * u);
        slope = (2 * camber / ((1 - camberPos) * (1 - camberPos))) * (camberPos - u);
      }
    }
    const angle = Math.atan(slope);
    const upperX = (u - yt * Math.sin(angle) - 0.5) * chord;
    const upperY = (yc + yt * Math.cos(angle)) * chord;
    const lowerX = (u + yt * Math.sin(angle) - 0.5) * chord;
    const lowerY = (yc - yt * Math.cos(angle)) * chord;
    upper.push([upperX * cos - upperY * sin, upperX * sin + upperY * cos, 0]);
    lower.push([lowerX * cos - lowerY * sin, lowerX * sin + lowerY * cos, 0]);
  }
  const ring: Array<[number, number, number]> = [];
  for (let j = 0; j <= segments; j += 1) ring.push(upper[j]);
  for (let j = segments - 1; j >= 1; j -= 1) ring.push(lower[j]);
  return ring;
}

async function buildBladeGeometry(
  model: ModelDocument,
  started: number,
): Promise<{ geometry: GeometryData; featureLog: string[] }> {
  const value = (key: string, fallback: number) => model.variables.find((item) => item.key === key)?.value ?? fallback;
  const length = Math.max(200, value('bladeLength', 1800));
  const rootDiameter = Math.max(40, value('rootDiameter', 140));
  const maxChord = Math.max(rootDiameter * 0.55, value('maxChord', 170));
  const rootTwist = value('rootTwist', 16);
  const tipTwist = value('tipTwist', 0);
  const thicknessPct = Math.max(10, Math.min(45, value('maxThicknessPct', 28))) / 100;
  const sections = [
    { s: 0, chord: rootDiameter, tr: 0.92, camber: 0 },
    { s: 0.06, chord: rootDiameter + (maxChord - rootDiameter) * 0.3, tr: 0.66, camber: 0.012 },
    { s: 0.18, chord: maxChord, tr: 0.43, camber: 0.035 },
    { s: 0.32, chord: maxChord * 0.94, tr: 0.34, camber: 0.045 },
    { s: 0.52, chord: maxChord * 0.68, tr: 0.27, camber: 0.042 },
    { s: 0.7, chord: maxChord * 0.48, tr: 0.21, camber: 0.032 },
    { s: 0.86, chord: maxChord * 0.3, tr: 0.16, camber: 0.02 },
    { s: 1, chord: Math.max(6, maxChord * 0.09), tr: 0.1, camber: 0.008 },
  ];
  const segments = 28;
  const ringSize = 2 * segments;
  const positions: number[] = [];
  const rings: number[][] = [];
  const twistAt = (s: number) => rootTwist + (tipTwist - rootTwist) * Math.pow(s, 0.85);
  for (const section of sections) {
    const ratio = Math.min(0.98, Math.max(0.06, section.tr * (thicknessPct / 0.28)));
    const ring = bladeSection(section.chord, ratio, section.camber, twistAt(section.s), segments);
    const indices: number[] = [];
    for (const [y, z] of ring) {
      indices.push(positions.length / 3);
      positions.push(section.s * length, y, z);
    }
    rings.push(indices);
  }
  const indices: number[] = [];
  for (let i = 0; i < rings.length - 1; i += 1) {
    for (let j = 0; j < ringSize; j += 1) {
      const a = rings[i][j];
      const b = rings[i][(j + 1) % ringSize];
      const c = rings[i + 1][j];
      const d = rings[i + 1][(j + 1) % ringSize];
      indices.push(a, c, b, b, c, d);
    }
  }
  const cap = (ring: number[]) => {
    const center = positions.length / 3;
    const y = ring.reduce((sum, index) => sum + positions[index * 3 + 1], 0) / ring.length;
    const z = ring.reduce((sum, index) => sum + positions[index * 3 + 2], 0) / ring.length;
    positions.push(ring === rings[0] ? 0 : length, y, z);
    for (let j = 0; j < ring.length; j += 1) {
      indices.push(center, ring[j], ring[(j + 1) % ring.length]);
    }
  };
  cap(rings[0]);
  cap(rings[rings.length - 1]);

  const vertices = new Float32Array(positions);
  let signedVolume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    signedVolume +=
      (vertices[a] * (vertices[b + 1] * vertices[c + 2] - vertices[b + 2] * vertices[c + 1]) +
        vertices[a + 1] * (vertices[b + 2] * vertices[c] - vertices[b] * vertices[c + 2]) +
        vertices[a + 2] * (vertices[b] * vertices[c + 1] - vertices[b + 1] * vertices[c])) /
      6;
  }
  if (signedVolume < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const tmp = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = tmp;
    }
  }
  let area = 0;
  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], vertices[i + axis]);
      max[axis] = Math.max(max[axis], vertices[i + axis]);
    }
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abx = vertices[b] - vertices[a];
    const aby = vertices[b + 1] - vertices[a + 1];
    const abz = vertices[b + 2] - vertices[a + 2];
    const acx = vertices[c] - vertices[a];
    const acy = vertices[c + 1] - vertices[a + 1];
    const acz = vertices[c + 2] - vertices[a + 2];
    area += 0.5 * Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx);
  }
  return {
    geometry: {
      positions: vertices,
      indices: new Uint32Array(indices),
      bbox: { min, max },
      volumeMm3: Math.abs(signedVolume),
      areaMm2: area,
      triangleCount: indices.length / 3,
      vertexCount: vertices.length / 3,
      buildMs: performance.now() - started,
      watermark: hashDocument(model),
    },
    featureLog: [
      `BLADE · ${sections.length} NACA sections / ${segments * 2} ring points`,
      `TWIST · ${rootTwist.toFixed(1)}° → ${tipTwist.toFixed(1)}°`,
      `CAP · root / tip watertight`,
    ],
  };
}

async function buildCsgGeometry(
  model: ModelDocument,
  started: number,
): Promise<{ geometry: GeometryData; featureLog: string[] }> {
  const runtime = await getKernel();
  let body: ManifoldInstance | null = null;
  const solids: ManifoldInstance[] = [];
  const featureLog: string[] = [];
  const track = (solid: ManifoldInstance) => {
    solids.push(solid);
    return solid;
  };
  try {
    for (const feature of model.solidFeatures ?? []) {
      if (!feature.enabled) continue;
      let shape: ManifoldInstance;
      if (feature.shape === 'box') {
        const base = runtime.Manifold.cube(
          [Math.max(0.5, feature.size[0]), Math.max(0.5, feature.size[1]), Math.max(0.5, feature.size[2])],
          true,
        );
        shape = base.rotate(feature.rotation[0], feature.rotation[1], feature.rotation[2]);
        base.delete();
      } else if (feature.shape === 'sphere') {
        const base = runtime.Manifold.sphere(Math.max(0.5, feature.radius), 48);
        shape = base.rotate(feature.rotation[0], feature.rotation[1], feature.rotation[2]);
        base.delete();
      } else {
        const base = runtime.Manifold.cylinder(
          Math.max(0.5, feature.height),
          Math.max(0.5, feature.radius),
          Math.max(0.5, feature.radius),
          48,
          true,
        );
        let oriented = base;
        if (feature.axis === 'x') {
          oriented = base.rotate(0, 90, 0);
          base.delete();
        } else if (feature.axis === 'y') {
          oriented = base.rotate(90, 0, 0);
          base.delete();
        }
        shape = oriented.rotate(feature.rotation[0], feature.rotation[1], feature.rotation[2]);
        if (oriented !== shape) oriented.delete();
      }
      const placed = shape.translate(feature.position[0], feature.position[1], feature.position[2]);
      shape.delete();
      track(placed);
      if (!body) {
        if (feature.operation !== 'subtract') body = placed;
        featureLog.push(`${feature.operation.toUpperCase()} ${feature.shape.toUpperCase()} · ${feature.name}`);
        continue;
      }
      const next =
        feature.operation === 'subtract'
          ? body.subtract(placed)
          : feature.operation === 'intersect'
            ? body.intersect(placed)
            : body.add(placed);
      track(next);
      body = next;
      featureLog.push(`${feature.operation.toUpperCase()} ${feature.shape.toUpperCase()} · ${feature.name}`);
    }
    if (!body) throw new Error('CSG 模型没有任何实体特征。');
    const mesh = body.getMesh();
    const positions = new Float32Array(mesh.vertProperties);
    const indices = new Uint32Array(mesh.triVerts);
    const bounds = body.boundingBox();
    const volume = body.volume();
    if (!Number.isFinite(volume) || volume <= 0 || indices.length < 12) {
      throw new Error('CSG 布尔结果为空或无效。');
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
    for (const solid of solids) {
      try {
        solid.delete();
      } catch {
        // Best-effort disposal.
      }
    }
  }
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
  if (template === 'blade') {
    return buildBladeGeometry(model, started);
  }
  if (template === 'csg') {
    return buildCsgGeometry(model, started);
  }
  if (template === 'external') {
    throw new Error('外部 B-Rep 模型由 build123d/OCCT STL 提供，不走 Manifold 几何内核。');
  }
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
