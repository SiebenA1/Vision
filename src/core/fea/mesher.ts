import type { FaceId, GeometryData, QualityReport } from '../types';

export interface VoxelMesh {
  nodes: Float64Array;
  elements: Int32Array;
  nodeCount: number;
  elementCount: number;
  dofs: number;
  cellSize: number;
  grid: [number, number, number];
  activeNodeRatio: number;
  volumeMm3: number;
  quality: QualityReport;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  originalNodeCount: number;
}

interface TriangleSoup {
  a: Float64Array;
  index: Uint32Array;
}

interface ColumnBins {
  bins: number[][];
  nx: number;
  ny: number;
  binSize: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function buildTriangleBins(geometry: GeometryData, cellSize: number): ColumnBins {
  const { positions, indices, bbox } = geometry;
  const spanX = bbox.max[0] - bbox.min[0];
  const spanY = bbox.max[1] - bbox.min[1];
  const binSize = Math.max(cellSize * 1.8, Math.max(spanX, spanY) / 160);
  const nx = Math.max(1, Math.ceil(spanX / binSize) + 1);
  const ny = Math.max(1, Math.ceil(spanY / binSize) + 1);
  const bins: number[][] = Array.from({ length: nx * ny }, () => []);
  const triCount = indices.length / 3;
  for (let t = 0; t < triCount; t += 1) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const bx = positions[ib];
    const by = positions[ib + 1];
    const cx = positions[ic];
    const cy = positions[ic + 1];
    const minX = Math.min(ax, bx, cx);
    const maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy);
    const maxY = Math.max(ay, by, cy);
    const ix0 = Math.max(0, Math.min(nx - 1, Math.floor((minX - bbox.min[0]) / binSize)));
    const ix1 = Math.max(0, Math.min(nx - 1, Math.floor((maxX - bbox.min[0]) / binSize)));
    const iy0 = Math.max(0, Math.min(ny - 1, Math.floor((minY - bbox.min[1]) / binSize)));
    const iy1 = Math.max(0, Math.min(ny - 1, Math.floor((maxY - bbox.min[1]) / binSize)));
    for (let iy = iy0; iy <= iy1; iy += 1) {
      for (let ix = ix0; ix <= ix1; ix += 1) {
        bins[iy * nx + ix].push(t);
      }
    }
  }
  return {
    bins,
    nx,
    ny,
    binSize,
    minX: bbox.min[0],
    minY: bbox.min[1],
    maxX: bbox.max[0],
    maxY: bbox.max[1],
  };
}

function crossingZ(
  positions: Float32Array,
  indices: Uint32Array,
  t: number,
  px: number,
  py: number,
): number | null {
  const ia = indices[t * 3] * 3;
  const ib = indices[t * 3 + 1] * 3;
  const ic = indices[t * 3 + 2] * 3;
  const ax = positions[ia];
  const ay = positions[ia + 1];
  const az = positions[ia + 2];
  const bx = positions[ib];
  const by = positions[ib + 1];
  const bz = positions[ib + 2];
  const cx = positions[ic];
  const cy = positions[ic + 1];
  const cz = positions[ic + 2];
  const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(denom) < 1e-12) return null;
  const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denom;
  const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denom;
  const l3 = 1 - l1 - l2;
  const eps = -1e-7;
  if (l1 < eps || l2 < eps || l3 < eps) return null;
  return l1 * az + l2 * bz + l3 * cz;
}

/**
 * Conservative structured voxel mesh.
 *
 * A grid node is inside when a +Z ray from the node has odd parity against the
 * watertight triangle soup. An element is retained only when all eight corners
 * are inside. This guarantees a conforming, non-degenerate Hex8 mesh with a
 * conservative (under-cut) boundary. Detached island elements are removed. The
 * policy is explicit in the report and drives the geometric-discretisation
 * warning; h-refinement is the prescribed remedy.
 */
export function voxelMesh(geometry: GeometryData, targetElements: number, fixedCellSize?: number): VoxelMesh {
  const { bbox, volumeMm3 } = geometry;
  const spanX = Math.max(1e-6, bbox.max[0] - bbox.min[0]);
  const spanY = Math.max(1e-6, bbox.max[1] - bbox.min[1]);
  const spanZ = Math.max(1e-6, bbox.max[2] - bbox.min[2]);
  const bboxVolume = spanX * spanY * spanZ;
  let h = fixedCellSize && fixedCellSize > 0
    ? fixedCellSize
    : Math.cbrt(volumeMm3 / Math.max(500, targetElements));
  const maxCells = 180_000;
  const minH = Math.cbrt(bboxVolume / maxCells);
  h = Math.max(h, minH);
  h = Math.max(h, Math.max(spanX, spanY, spanZ) / 150);
  const nx = Math.max(3, Math.ceil(spanX / h));
  const ny = Math.max(3, Math.ceil(spanY / h));
  const nz = Math.max(3, Math.ceil(spanZ / h));
  const nodeNx = nx + 1;
  const nodeNy = ny + 1;
  const nodeNz = nz + 1;
  const totalNodes = nodeNx * nodeNy * nodeNz;
  const inside = new Uint8Array(totalNodes);
  const bins = buildTriangleBins(geometry, h);
  const jitter = Math.max(spanX, spanY, spanZ) * 1e-7;
  let insideCount = 0;

  for (let iy = 0; iy < nodeNy; iy += 1) {
    for (let ix = 0; ix < nodeNx; ix += 1) {
      const px = bbox.min[0] + ix * h + jitter * (1 + ix * 0.37);
      const py = bbox.min[1] + iy * h + jitter * (1 + iy * 0.29);
      const bx = Math.max(0, Math.min(bins.nx - 1, Math.floor((px - bins.minX) / bins.binSize)));
      const by = Math.max(0, Math.min(bins.ny - 1, Math.floor((py - bins.minY) / bins.binSize)));
      const candidates = bins.bins[by * bins.nx + bx];
      const crossings: number[] = [];
      for (const t of candidates) {
        const z = crossingZ(geometry.positions, geometry.indices, t, px, py);
        if (z !== null) crossings.push(z);
      }
      crossings.sort((a, b) => a - b);
      const unique: number[] = [];
      for (const z of crossings) {
        if (unique.length === 0 || Math.abs(z - unique[unique.length - 1]) > h * 1e-5) {
          unique.push(z);
        }
      }
      let cursor = 0;
      for (let iz = 0; iz < nodeNz; iz += 1) {
        const pz = bbox.min[2] + iz * h + h * 1e-7;
        while (cursor < unique.length && unique[cursor] < pz) cursor += 1;
        if (cursor % 2 === 1) {
          inside[iz * nodeNx * nodeNy + iy * nodeNx + ix] = 1;
          insideCount += 1;
        }
      }
    }
  }

  const elementCountEstimate = Math.max(0, (nx * ny * nz) / 4);
  const activeElements: number[] = [];
  const activeMark = new Uint8Array(totalNodes);
  const nodeId = (ix: number, iy: number, iz: number) =>
    ix + iy * nodeNx + iz * nodeNx * nodeNy;

  for (let iz = 0; iz < nz; iz += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const n0 = nodeId(ix, iy, iz);
        const n1 = nodeId(ix + 1, iy, iz);
        const n2 = nodeId(ix + 1, iy + 1, iz);
        const n3 = nodeId(ix, iy + 1, iz);
        const n4 = nodeId(ix, iy, iz + 1);
        const n5 = nodeId(ix + 1, iy, iz + 1);
        const n6 = nodeId(ix + 1, iy + 1, iz + 1);
        const n7 = nodeId(ix, iy + 1, iz + 1);
        if (
          inside[n0] && inside[n1] && inside[n2] && inside[n3] &&
          inside[n4] && inside[n5] && inside[n6] && inside[n7]
        ) {
          activeElements.push(n0, n1, n2, n3, n4, n5, n6, n7);
          activeMark[n0] = 1;
          activeMark[n1] = 1;
          activeMark[n2] = 1;
          activeMark[n3] = 1;
          activeMark[n4] = 1;
          activeMark[n5] = 1;
          activeMark[n6] = 1;
          activeMark[n7] = 1;
        }
      }
    }
  }

  if (activeElements.length === 0) {
    throw new Error(
      `网格化失败：在 ${h.toFixed(2)} mm 单元尺寸下没有完整内部单元。请增大网格目标或检查几何封闭性。`,
    );
  }

  // Remove detached voxel islands caused by conservative boundary cutting.
  // The main structural body is the largest nodal-connectivity component.
  const rawElementCount = activeElements.length / 8;
  const parent = new Int32Array(rawElementCount);
  for (let i = 0; i < rawElementCount; i += 1) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== x) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const nodeOwner = new Int32Array(totalNodes).fill(-1);
  for (let e = 0; e < rawElementCount; e += 1) {
    for (let i = 0; i < 8; i += 1) {
      const node = activeElements[e * 8 + i];
      if (nodeOwner[node] === -1) nodeOwner[node] = e;
      else union(e, nodeOwner[node]);
    }
  }
  const componentSize = new Map<number, number>();
  for (let e = 0; e < rawElementCount; e += 1) {
    const root = find(e);
    componentSize.set(root, (componentSize.get(root) ?? 0) + 1);
  }
  let largestRoot = 0;
  let largestSize = -1;
  for (const [root, size] of componentSize) {
    if (size > largestSize) {
      largestSize = size;
      largestRoot = root;
    }
  }
  const keep = new Int32Array(largestSize);
  let kept = 0;
  for (let e = 0; e < rawElementCount; e += 1) {
    if (find(e) === largestRoot) keep[kept++] = e;
  }
  const filteredElements = new Int32Array(largestSize * 8);
  for (let i = 0; i < largestSize; i += 1) {
    const source = keep[i] * 8;
    for (let j = 0; j < 8; j += 1) filteredElements[i * 8 + j] = activeElements[source + j];
  }
  activeMark.fill(0);
  for (let i = 0; i < filteredElements.length; i += 1) activeMark[filteredElements[i]] = 1;
  const activeElementsFinal = filteredElements;

  let activeNodes = 0;
  for (let i = 0; i < totalNodes; i += 1) activeNodes += activeMark[i];
  const localMap = new Int32Array(totalNodes).fill(-1);
  const nodes = new Float64Array(activeNodes * 3);
  let cursor = 0;
  for (let iz = 0; iz < nodeNz; iz += 1) {
    for (let iy = 0; iy < nodeNy; iy += 1) {
      for (let ix = 0; ix < nodeNx; ix += 1) {
        const id = nodeId(ix, iy, iz);
        if (!activeMark[id]) continue;
        localMap[id] = cursor;
        nodes[cursor * 3] = bbox.min[0] + ix * h;
        nodes[cursor * 3 + 1] = bbox.min[1] + iy * h;
        nodes[cursor * 3 + 2] = bbox.min[2] + iz * h;
        cursor += 1;
      }
    }
  }

  const elements = new Int32Array(activeElementsFinal.length);
  for (let i = 0; i < activeElementsFinal.length; i += 1) {
    elements[i] = localMap[activeElementsFinal[i]];
  }

  const elementCount = elements.length / 8;
  const activeNodeRatio = activeNodes / Math.max(1, totalNodes);
  const quality: QualityReport = {
    minScaledJacobian: 1,
    maxAspectRatio: 1,
    meanAspectRatio: 1,
    negativeElements: 0,
    activeNodeRatio,
  };

  return {
    nodes,
    elements,
    nodeCount: activeNodes,
    elementCount,
    dofs: activeNodes * 3,
    cellSize: h,
    grid: [nx, ny, nz],
    activeNodeRatio,
    volumeMm3: elementCount * h * h * h,
    quality,
    bbox: { min: [...bbox.min], max: [...bbox.max] },
    originalNodeCount: insideCount,
  };
}

export function nodesOnFace(mesh: VoxelMesh, face: FaceId, tolerance: number): number[] {
  const axis = face[0] as 'x' | 'y' | 'z';
  const side = face.endsWith('min') ? 'min' : 'max';
  const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  let activeMin = Number.POSITIVE_INFINITY;
  let activeMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < mesh.nodeCount; i += 1) {
    const value = mesh.nodes[i * 3 + axisIndex];
    if (value < activeMin) activeMin = value;
    if (value > activeMax) activeMax = value;
  }
  // Use the extent of the retained (connected) discrete domain rather than the
  // CAD bounding box. Coarse voxelisation may stop short of a tangent surface;
  // the load/support must still be applied to the outermost mesh nodes.
  const target = side === 'min' ? activeMin : activeMax;
  const result: number[] = [];
  for (let i = 0; i < mesh.nodeCount; i += 1) {
    const value = mesh.nodes[i * 3 + axisIndex];
    if (side === 'min' ? value <= target + tolerance : value >= target - tolerance) {
      result.push(i);
    }
  }
  return result;
}

export function meshSamplePoints(mesh: VoxelMesh, maxPoints = 6): Float64Array {
  const stride = Math.max(1, Math.floor(mesh.nodeCount / maxPoints));
  const points = new Float64Array(Math.min(maxPoints, mesh.nodeCount) * 3);
  for (let i = 0; i < points.length / 3; i += 1) {
    const node = Math.min(mesh.nodeCount - 1, i * stride);
    points[i * 3] = mesh.nodes[node * 3];
    points[i * 3 + 1] = mesh.nodes[node * 3 + 1];
    points[i * 3 + 2] = mesh.nodes[node * 3 + 2];
  }
  return points;
}
