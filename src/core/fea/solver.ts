import type {
  AnalysisResult,
  EquilibriumCheck,
  FaceId,
  Load,
  MeshStats,
  NodalField,
  SolverStats,
  Support,
  ValidationResult,
  Vec3,
} from '../types';
import type { MaterialSpec } from '../materials';
import { hex8Stiffness, stressAtCenter, vonMises } from './hex8';
import { nodesOnFace, type VoxelMesh } from './mesher';

export interface SolverConfig {
  material: MaterialSpec;
  supports: Support[];
  loads: Load[];
  tolerance: number;
  maxIterations: number;
  /** Load introduction band as a multiple of cell size. Default 2.2. */
  loadBandFactor?: number;
  onProgress?: (iteration: number, residual: number) => void;
}

interface CoreSolution {
  u: Float64Array;
  mesh: VoxelMesh;
  iterations: number;
  residual: number;
  relativeResidual: number;
  converged: boolean;
  solveMs: number;
  fixed: Uint8Array;
  loadNodes: number[];
  supportNodes: number[];
  appliedForce: Vec3;
  reactionForce: Vec3;
  equilibrium: EquilibriumCheck;
  strainEnergy: number;
  field: NodalField;
  maxVonMises: number;
  maxStressLocation: Vec3;
  maxDisplacement: number;
  maxDisplacementLocation: Vec3;
  safetyFactor: number;
}

function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function norm(a: Float64Array): number {
  return Math.sqrt(dot(a, a));
}

function findFaceNodes(mesh: VoxelMesh, face: FaceId, minCount = 2, preferredTolerance = 0): number[] {
  let tolerance = Math.max(mesh.cellSize * 0.7, preferredTolerance);
  let nodes = nodesOnFace(mesh, face, tolerance);
  while (nodes.length < minCount && tolerance < mesh.cellSize * 8) {
    tolerance += mesh.cellSize * 0.5;
    nodes = nodesOnFace(mesh, face, tolerance);
  }
  return nodes;
}

export function solveVoxelMesh(mesh: VoxelMesh, config: SolverConfig): CoreSolution {
  const started = performance.now();
  const { material } = config;
  const Ke = hex8Stiffness(mesh.cellSize, { E: material.E, nu: material.nu });
  const dofs = mesh.dofs;
  const fixed = new Uint8Array(dofs);
  const force = new Float64Array(dofs);
  const elementDofs = new Int32Array(mesh.elementCount * 24);
  for (let e = 0; e < mesh.elementCount; e += 1) {
    for (let i = 0; i < 8; i += 1) {
      const node = mesh.elements[e * 8 + i];
      elementDofs[e * 24 + i * 3] = node * 3;
      elementDofs[e * 24 + i * 3 + 1] = node * 3 + 1;
      elementDofs[e * 24 + i * 3 + 2] = node * 3 + 2;
    }
  }

  // Dirichlet boundary conditions on selected geometric faces.
  const supportNodes: number[] = [];
  for (const support of config.supports.filter((item) => item.enabled)) {
    const nodes = findFaceNodes(mesh, support.face);
    for (const node of nodes) {
      supportNodes.push(node);
      fixed[node * 3] = 1;
      fixed[node * 3 + 1] = 1;
      fixed[node * 3 + 2] = 1;
    }
  }
  const uniqueSupportNodes = [...new Set(supportNodes)];

  // Nodal equipartition of the resultant force across the loaded face.
  const appliedForce: Vec3 = [0, 0, 0];
  const loadNodes: number[] = [];
  for (const load of config.loads.filter((item) => item.enabled)) {
    // Spread the resultant over an outer nodal band (≈2.2 cells). A single-node
    // thick surface slice is sensitive to voxel topology and produces spurious
    // stress concentrations at the load introduction.
    const nodes = findFaceNodes(mesh, load.face, 8, mesh.cellSize * (config.loadBandFactor ?? 2.2));
    if (nodes.length === 0) continue;
    const mag = Math.hypot(load.vector[0], load.vector[1], load.vector[2]) || 1;
    const unit: Vec3 = [load.vector[0] / mag, load.vector[1] / mag, load.vector[2] / mag];
    const perNode = load.magnitude / nodes.length;
    for (const node of nodes) {
      loadNodes.push(node);
      force[node * 3] += unit[0] * perNode;
      force[node * 3 + 1] += unit[1] * perNode;
      force[node * 3 + 2] += unit[2] * perNode;
      appliedForce[0] += unit[0] * perNode;
      appliedForce[1] += unit[1] * perNode;
      appliedForce[2] += unit[2] * perNode;
    }
  }
  const uniqueLoadNodes = [...new Set(loadNodes)];

  if (uniqueSupportNodes.length === 0) {
    throw new Error('约束面未捕获任何网格节点，无法组装边界条件。');
  }
  if (uniqueLoadNodes.length === 0) {
    throw new Error('加载面未捕获任何网格节点，无法施加荷载。');
  }

  // Make fixed DOFs homogeneous.
  let freeDofs = 0;
  for (let i = 0; i < dofs; i += 1) {
    if (fixed[i]) force[i] = 0;
    else freeDofs += 1;
  }
  if (freeDofs === 0) throw new Error('所有自由度均被约束。');

  const diag = new Float64Array(dofs);
  for (let e = 0; e < mesh.elementCount; e += 1) {
    for (let i = 0; i < 24; i += 1) {
      const dof = elementDofs[e * 24 + i];
      diag[dof] += Ke[i * 24 + i];
    }
  }
  for (let i = 0; i < dofs; i += 1) {
    if (fixed[i] || !Number.isFinite(diag[i]) || diag[i] <= 0) diag[i] = 1;
  }

  const u = new Float64Array(dofs);
  const r = new Float64Array(force);
  const z = new Float64Array(dofs);
  const p = new Float64Array(dofs);
  const Ap = new Float64Array(dofs);
  const ue = new Float64Array(24);
  const oe = new Float64Array(24);

  const matvec = (vector: Float64Array, out: Float64Array, zeroFixed: boolean) => {
    out.fill(0);
    for (let e = 0; e < mesh.elementCount; e += 1) {
      const base = e * 24;
      for (let i = 0; i < 24; i += 1) ue[i] = vector[elementDofs[base + i]];
      for (let i = 0; i < 24; i += 1) {
        const row = i * 24;
        let sum = 0;
        for (let j = 0; j < 24; j += 1) sum += Ke[row + j] * ue[j];
        oe[i] = sum;
      }
      for (let i = 0; i < 24; i += 1) out[elementDofs[base + i]] += oe[i];
    }
    if (zeroFixed) {
      for (let i = 0; i < dofs; i += 1) {
        if (fixed[i]) out[i] = 0;
      }
    }
  };

  // Jacobi-preconditioned conjugate gradient.
  const forceNorm = norm(force);
  if (forceNorm < 1e-12) throw new Error('荷载向量为零。');
  for (let i = 0; i < dofs; i += 1) z[i] = fixed[i] ? 0 : r[i] / diag[i];
  p.set(z);
  let rz = dot(r, z);
  let residual = norm(r);
  let relativeResidual = residual / forceNorm;
  let iterations = 0;
  const tolerance = Math.max(1e-12, config.tolerance);

  while (iterations < config.maxIterations && relativeResidual > tolerance) {
    matvec(p, Ap, true);
    const pAp = dot(p, Ap);
    if (!Number.isFinite(pAp) || pAp <= 0) break;
    const alpha = rz / pAp;
    for (let i = 0; i < dofs; i += 1) {
      if (fixed[i]) continue;
      u[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    iterations += 1;
    residual = norm(r);
    relativeResidual = residual / forceNorm;
    if (iterations % 20 === 0 || relativeResidual <= tolerance) {
      config.onProgress?.(iterations, relativeResidual);
    }
    for (let i = 0; i < dofs; i += 1) z[i] = fixed[i] ? 0 : r[i] / diag[i];
    const rzNext = dot(r, z);
    if (!Number.isFinite(rzNext) || Math.abs(rz) < 1e-30) break;
    const beta = rzNext / rz;
    rz = rzNext;
    for (let i = 0; i < dofs; i += 1) p[i] = z[i] + beta * p[i];
  }

  const converged = relativeResidual <= tolerance;
  const solveMs = performance.now() - started;

  // Nodal displacement + element-centroid von Mises recovery.
  const displacement = new Float32Array(dofs);
  const vonMisesNodal = new Float32Array(mesh.nodeCount);
  const stressCount = new Uint32Array(mesh.nodeCount);
  const elementField = new Float64Array(mesh.elementCount);
  let maxVonMises = 0;
  let maxStressLocation: Vec3 = [0, 0, 0];
  let maxDisplacement = 0;
  let maxDisplacementLocation: Vec3 = [0, 0, 0];

  for (let i = 0; i < dofs; i += 1) {
    displacement[i] = u[i];
    if (Math.abs(u[i]) > Math.abs(maxDisplacement)) {
      maxDisplacement = Math.abs(u[i]);
    }
  }

  for (let node = 0; node < mesh.nodeCount; node += 1) {
    const ux = u[node * 3];
    const uy = u[node * 3 + 1];
    const uz = u[node * 3 + 2];
    const mag = Math.hypot(ux, uy, uz);
    if (mag > maxDisplacement || maxDisplacement === 0) {
      maxDisplacement = mag;
      maxDisplacementLocation = [
        mesh.nodes[node * 3],
        mesh.nodes[node * 3 + 1],
        mesh.nodes[node * 3 + 2],
      ];
    }
  }

  for (let e = 0; e < mesh.elementCount; e += 1) {
    for (let i = 0; i < 24; i += 1) ue[i] = u[elementDofs[e * 24 + i]];
    const stress = stressAtCenter(mesh.cellSize, { E: material.E, nu: material.nu }, ue);
    const vm = vonMises(stress);
    elementField[e] = vm;
    if (vm > maxVonMises) {
      maxVonMises = vm;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let i = 0; i < 8; i += 1) {
        const node = mesh.elements[e * 8 + i];
        cx += mesh.nodes[node * 3] / 8;
        cy += mesh.nodes[node * 3 + 1] / 8;
        cz += mesh.nodes[node * 3 + 2] / 8;
      }
      maxStressLocation = [cx, cy, cz];
    }
    for (let i = 0; i < 8; i += 1) {
      const node = mesh.elements[e * 8 + i];
      vonMisesNodal[node] += vm;
      stressCount[node] += 1;
    }
  }

  for (let node = 0; node < mesh.nodeCount; node += 1) {
    if (stressCount[node] > 0) vonMisesNodal[node] /= stressCount[node];
  }

  // Reaction recovery from K·u at constrained DOFs.
  const internal = new Float64Array(dofs);
  matvec(u, internal, false);
  const reactionForce: Vec3 = [0, 0, 0];
  for (let i = 0; i < dofs; i += 1) {
    if (fixed[i]) reactionForce[i % 3] += internal[i];
  }
  const residualVector: Vec3 = [
    appliedForce[0] + reactionForce[0],
    appliedForce[1] + reactionForce[1],
    appliedForce[2] + reactionForce[2],
  ];
  const appliedNorm = Math.hypot(appliedForce[0], appliedForce[1], appliedForce[2]);
  const equilibrium: EquilibriumCheck = {
    applied: appliedForce,
    reaction: reactionForce,
    residual: residualVector,
    relativeError:
      Math.hypot(residualVector[0], residualVector[1], residualVector[2]) /
      Math.max(appliedNorm, 1e-9),
  };

  const strainEnergy = 0.5 * dot(u, force);
  const safety = maxVonMises > 1e-9 ? material.yieldStrength / maxVonMises : 99.9;

  return {
    u,
    mesh,
    iterations,
    residual,
    relativeResidual,
    converged,
    solveMs,
    fixed,
    loadNodes: uniqueLoadNodes,
    supportNodes: uniqueSupportNodes,
    appliedForce,
    reactionForce,
    equilibrium,
    strainEnergy,
    field: {
      positions: new Float32Array(mesh.nodes),
      displacement,
      vonMises: vonMisesNodal,
      nodeCount: mesh.nodeCount,
    },
    maxVonMises,
    maxStressLocation,
    maxDisplacement,
    maxDisplacementLocation,
    safetyFactor: safety,
  };
}

export interface AnalysisContext {
  modelRevision: string;
  modelHash: string;
  studyName: string;
  cadVolumeMm3: number;
  meshMs: number;
  warnings?: string[];
}

export function toAnalysisResult(
  solution: CoreSolution,
  config: SolverConfig,
  context: AnalysisContext,
): AnalysisResult {
  const { mesh } = solution;
  const meshStats: MeshStats = {
    nodes: mesh.nodeCount,
    elements: mesh.elementCount,
    dofs: mesh.dofs,
    cellSize: mesh.cellSize,
    grid: mesh.grid,
    activeNodeRatio: mesh.activeNodeRatio,
    volumeMm3: mesh.volumeMm3,
    quality: mesh.quality,
  };
  const solver: SolverStats = {
    method: 'PCG',
    preconditioner: 'Jacobi',
    iterations: solution.iterations,
    residual: solution.residual,
    relativeResidual: solution.relativeResidual,
    converged: solution.converged,
    solveMs: solution.solveMs,
    meshMs: context.meshMs,
    strainEnergyMj: solution.strainEnergy,
  };
  const warnings = [...(context.warnings ?? [])];
  if (!solution.converged) warnings.push('PCG 未在迭代上限内收敛；结果仅可用于趋势判断。');
  if (mesh.elementCount < 1200) warnings.push('网格较粗（<1,200 单元），峰值应力可能被低估。');
  if (solution.safetyFactor < 1) warnings.push('静强度不足：最大 von Mises 应力超过材料屈服强度。');
  else if (solution.safetyFactor < 1.5) warnings.push('安全系数低于 1.5，需复核许用值与失效模式。');
  if (solution.maxDisplacement > 2) warnings.push('最大位移超过 2 mm，刚度可能是控制工况。');
  if (mesh.volumeMm3 > 0) {
    const discrepancy = Math.abs(mesh.volumeMm3 - context.cadVolumeMm3) / context.cadVolumeMm3;
    if (discrepancy > 0.18) {
      warnings.push(
        `体素网格体积与 CAD 体积相差 ${(discrepancy * 100).toFixed(1)}%，边界离散可能影响局部应力。`,
      );
    }
  }
  if (solution.loadNodes.length < 2) warnings.push('加载节点过少，存在应力集中/圣维南效应。');
  if (solution.equilibrium.relativeError > 1e-4) warnings.push('反力平衡相对误差超过 1e-4，请检查约束。');

  return {
    id: `run_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    modelRevision: context.modelRevision,
    modelHash: context.modelHash,
    studyName: context.studyName,
    materialId: config.material.id,
    loadCase: 'LC-01 / 端部竖向工作载荷',
    status: warnings.length === 0 ? 'ok' : 'warning',
    maxVonMises: solution.maxVonMises,
    maxVonMisesLocation: solution.maxStressLocation,
    maxDisplacement: solution.maxDisplacement,
    maxDisplacementLocation: solution.maxDisplacementLocation,
    safetyFactor: solution.safetyFactor,
    massKg: (context.cadVolumeMm3 * 1e-9) * config.material.rho,
    mesh: meshStats,
    solver,
    equilibrium: solution.equilibrium,
    field: solution.field,
    warnings,
  };
}

export function buildBeamValidationMesh(
  length = 100,
  width = 20,
  height = 10,
  cell = 2.5,
): VoxelMesh {
  const nx = Math.round(length / cell);
  const ny = Math.round(width / cell);
  const nz = Math.round(height / cell);
  const hx = length / nx;
  const hy = width / ny;
  const hz = height / nz;
  if (Math.abs(hx - hy) > 1e-9 || Math.abs(hx - hz) > 1e-9) {
    throw new Error('验证梁要求立方体单元。');
  }
  const h = hx;
  const nodeNx = nx + 1;
  const nodeNy = ny + 1;
  const nodeNz = nz + 1;
  const totalNodes = nodeNx * nodeNy * nodeNz;
  const nodes = new Float64Array(totalNodes * 3);
  for (let iz = 0; iz < nodeNz; iz += 1) {
    for (let iy = 0; iy < nodeNy; iy += 1) {
      for (let ix = 0; ix < nodeNx; ix += 1) {
        const id = ix + iy * nodeNx + iz * nodeNx * nodeNy;
        nodes[id * 3] = ix * h;
        nodes[id * 3 + 1] = iy * h;
        nodes[id * 3 + 2] = iz * h;
      }
    }
  }
  const elements = new Int32Array(nx * ny * nz * 8);
  let cursor = 0;
  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const n0 = ix + iy * nodeNx + iz * nodeNx * nodeNy;
        const n1 = n0 + 1;
        const n3 = n0 + nodeNx;
        const n2 = n3 + 1;
        const n4 = n0 + nodeNx * nodeNy;
        const n5 = n4 + 1;
        const n7 = n4 + nodeNx;
        const n6 = n7 + 1;
        elements.set([n0, n1, n2, n3, n4, n5, n6, n7], cursor);
        cursor += 8;
      }
    }
  }
  return {
    nodes,
    elements,
    nodeCount: totalNodes,
    elementCount: elements.length / 8,
    dofs: totalNodes * 3,
    cellSize: h,
    grid: [nx, ny, nz],
    activeNodeRatio: 1,
    volumeMm3: length * width * height,
    quality: {
      minScaledJacobian: 1,
      maxAspectRatio: 1,
      meanAspectRatio: 1,
      negativeElements: 0,
      activeNodeRatio: 1,
    },
    bbox: { min: [0, 0, 0], max: [length, width, height] },
    originalNodeCount: totalNodes,
  };
}

export function validateCantilever(): ValidationResult {
  const L = 100;
  const b = 20;
  const h = 10;
  const P = 100;
  const E = 210_000;
  const mesh = buildBeamValidationMesh(L, b, h, 2.5);
  const steel = {
    id: 'VALIDATION-STEEL',
    name: 'Validation steel',
    shortName: 'STEEL',
    standard: 'analytic benchmark',
    family: 'steel' as const,
    E,
    nu: 0.3,
    rho: 7850,
    yieldStrength: 355,
    ultimateStrength: 470,
    thermalExpansion: 12e-6,
    color: '#888',
    finish: 'n/a',
    note: 'validation only',
    validated: true,
  };
  const started = performance.now();
  const solution = solveVoxelMesh(mesh, {
    material: steel,
    supports: [{ id: 'v', name: 'fixed', face: 'x-min', type: 'fixed', enabled: true }],
    loads: [
      {
        id: 'v',
        name: 'tip',
        face: 'x-max',
        vector: [0, 0, -1],
        magnitude: P,
        enabled: true,
      },
    ],
    tolerance: 1e-8,
    maxIterations: 1200,
    loadBandFactor: 0.7,
  });
  const inertia = (b * h ** 3) / 12;
  const analytic = (P * L ** 3) / (3 * E * inertia);
  const errorPercent = Math.abs(solution.maxDisplacement - analytic) / analytic * 100;
  return {
    caseId: 'VB-01',
    name: '悬臂梁端部挠度',
    reference: analytic,
    computed: solution.maxDisplacement,
    errorPercent,
    passed: errorPercent <= 8,
    tolerancePercent: 8,
    formula: 'δ = P·L³ / (3·E·I)，I = b·h³/12',
    meshElements: mesh.elementCount,
    solveMs: performance.now() - started,
  };
}
