/**
 * C3D8 / Hex8 isoparametric brick element.
 *
 * Node order (right-handed):
 *   0 (-1,-1,-1)  1 (+1,-1,-1)  2 (+1,+1,-1)  3 (-1,+1,-1)
 *   4 (-1,-1,+1)  5 (+1,-1,+1)  6 (+1,+1,+1)  7 (-1,+1,+1)
 */

export interface ElasticConstants {
  E: number;
  nu: number;
}

export interface StressTensor6 {
  xx: number;
  yy: number;
  zz: number;
  xy: number;
  yz: number;
  zx: number;
}

const GAUSS = 1 / Math.sqrt(3);
const GP: Array<[number, number, number]> = [
  [-GAUSS, -GAUSS, -GAUSS],
  [GAUSS, -GAUSS, -GAUSS],
  [GAUSS, GAUSS, -GAUSS],
  [-GAUSS, GAUSS, -GAUSS],
  [-GAUSS, -GAUSS, GAUSS],
  [GAUSS, -GAUSS, GAUSS],
  [GAUSS, GAUSS, GAUSS],
  [-GAUSS, GAUSS, GAUSS],
];

export const HEX_NATURAL_NODES: Array<[number, number, number]> = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

export function elasticityMatrix(E: number, nu: number): Float64Array {
  const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const mu = E / (2 * (1 + nu));
  const D = new Float64Array(36);
  const c = lambda + 2 * mu;
  D[0 * 6 + 0] = c;
  D[0 * 6 + 1] = lambda;
  D[0 * 6 + 2] = lambda;
  D[1 * 6 + 0] = lambda;
  D[1 * 6 + 1] = c;
  D[1 * 6 + 2] = lambda;
  D[2 * 6 + 0] = lambda;
  D[2 * 6 + 1] = lambda;
  D[2 * 6 + 2] = c;
  D[3 * 6 + 3] = mu;
  D[4 * 6 + 4] = mu;
  D[5 * 6 + 5] = mu;
  return D;
}

export function shapeDerivatives(xi: number, eta: number, zeta: number): Float64Array {
  const dN = new Float64Array(24);
  for (let i = 0; i < 8; i += 1) {
    const [sx, sy, sz] = HEX_NATURAL_NODES[i];
    dN[i * 3] = (sx * (1 + sy * eta) * (1 + sz * zeta)) / 8;
    dN[i * 3 + 1] = (sy * (1 + sx * xi) * (1 + sz * zeta)) / 8;
    dN[i * 3 + 2] = (sz * (1 + sx * xi) * (1 + sy * eta)) / 8;
  }
  return dN;
}

function invert3x3(m: Float64Array): { inv: Float64Array; det: number } | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-14) return null;
  const inv = new Float64Array(9);
  inv[0] = (e * i - f * h) / det;
  inv[1] = (c * h - b * i) / det;
  inv[2] = (b * f - c * e) / det;
  inv[3] = (f * g - d * i) / det;
  inv[4] = (a * i - c * g) / det;
  inv[5] = (c * d - a * f) / det;
  inv[6] = (d * h - e * g) / det;
  inv[7] = (b * g - a * h) / det;
  inv[8] = (a * e - b * d) / det;
  return { inv, det };
}

export function buildBMatrix(
  xi: number,
  eta: number,
  zeta: number,
  nodeCoords: Float64Array,
): { B: Float64Array; detJ: number; dNdx: Float64Array } | null {
  const dN = shapeDerivatives(xi, eta, zeta);
  const J = new Float64Array(9);
  for (let i = 0; i < 8; i += 1) {
    const x = nodeCoords[i * 3];
    const y = nodeCoords[i * 3 + 1];
    const z = nodeCoords[i * 3 + 2];
    const dx = dN[i * 3];
    const dy = dN[i * 3 + 1];
    const dz = dN[i * 3 + 2];
    J[0] += dx * x;
    J[1] += dx * y;
    J[2] += dx * z;
    J[3] += dy * x;
    J[4] += dy * y;
    J[5] += dy * z;
    J[6] += dz * x;
    J[7] += dz * y;
    J[8] += dz * z;
  }
  const inverse = invert3x3(J);
  if (!inverse) return null;
  const inv = inverse.inv;
  const B = new Float64Array(6 * 24);
  const dNdx = new Float64Array(24);
  for (let i = 0; i < 8; i += 1) {
    const dxi = dN[i * 3];
    const deta = dN[i * 3 + 1];
    const dzeta = dN[i * 3 + 2];
    const dx = inv[0] * dxi + inv[1] * deta + inv[2] * dzeta;
    const dy = inv[3] * dxi + inv[4] * deta + inv[5] * dzeta;
    const dz = inv[6] * dxi + inv[7] * deta + inv[8] * dzeta;
    dNdx[i * 3] = dx;
    dNdx[i * 3 + 1] = dy;
    dNdx[i * 3 + 2] = dz;
    const col = i * 3;
    B[0 * 24 + col] = dx;
    B[1 * 24 + col + 1] = dy;
    B[2 * 24 + col + 2] = dz;
    B[3 * 24 + col] = dy;
    B[3 * 24 + col + 1] = dx;
    B[4 * 24 + col + 1] = dz;
    B[4 * 24 + col + 2] = dy;
    B[5 * 24 + col] = dz;
    B[5 * 24 + col + 2] = dx;
  }
  return { B, detJ: inverse.det, dNdx };
}

/**
 * Inverts a 3x3 represented in column-major order (used by Manifold).
 */
export function hex8Stiffness(h: number, constants: ElasticConstants): Float64Array {
  const D = elasticityMatrix(constants.E, constants.nu);
  const K = new Float64Array(24 * 24);
  const nodeCoords = new Float64Array([
    0, 0, 0,
    h, 0, 0,
    h, h, 0,
    0, h, 0,
    0, 0, h,
    h, 0, h,
    h, h, h,
    0, h, h,
  ]);
  for (const [xi, eta, zeta] of GP) {
    const result = buildBMatrix(xi, eta, zeta, nodeCoords);
    if (!result) throw new Error('退化单元：雅可比行列式为零');
    const { B, detJ } = result;
    const DB = new Float64Array(6 * 24);
    for (let r = 0; r < 6; r += 1) {
      for (let c = 0; c < 24; c += 1) {
        let sum = 0;
        for (let k = 0; k < 6; k += 1) sum += D[r * 6 + k] * B[k * 24 + c];
        DB[r * 24 + c] = sum;
      }
    }
    for (let i = 0; i < 24; i += 1) {
      for (let j = 0; j < 24; j += 1) {
        let sum = 0;
        for (let k = 0; k < 6; k += 1) sum += B[k * 24 + i] * DB[k * 24 + j];
        K[i * 24 + j] += sum * detJ;
      }
    }
  }
  return K;
}

export function stressAtCenter(
  h: number,
  constants: ElasticConstants,
  elementDisplacement: Float64Array,
): StressTensor6 {
  const D = elasticityMatrix(constants.E, constants.nu);
  const nodeCoords = new Float64Array([
    0, 0, 0,
    h, 0, 0,
    h, h, 0,
    0, h, 0,
    0, 0, h,
    h, 0, h,
    h, h, h,
    0, h, h,
  ]);
  const result = buildBMatrix(0, 0, 0, nodeCoords);
  if (!result) return { xx: 0, yy: 0, zz: 0, xy: 0, yz: 0, zx: 0 };
  const strain = new Float64Array(6);
  for (let r = 0; r < 6; r += 1) {
    let sum = 0;
    for (let c = 0; c < 24; c += 1) sum += result.B[r * 24 + c] * elementDisplacement[c];
    strain[r] = sum;
  }
  const stress = new Float64Array(6);
  for (let r = 0; r < 6; r += 1) {
    let sum = 0;
    for (let c = 0; c < 6; c += 1) sum += D[r * 6 + c] * strain[c];
    stress[r] = sum;
  }
  return {
    xx: stress[0],
    yy: stress[1],
    zz: stress[2],
    xy: stress[3],
    yz: stress[4],
    zx: stress[5],
  };
}

export function vonMises(stress: StressTensor6): number {
  const { xx, yy, zz, xy, yz, zx } = stress;
  return Math.sqrt(
    Math.max(
      0,
      0.5 * ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) +
        3 * (xy ** 2 + yz ** 2 + zx ** 2),
    ),
  );
}

export function scaledJacobianAtCenter(h: number): number {
  // A regular, right-handed brick has unit scaled Jacobian by construction.
  return h > 0 ? 1 : 0;
}
