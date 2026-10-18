/**
 * Client for the local open-source engineering backend.
 *
 * The backend executes a caller-supplied build123d/OCCT script. It is a generic
 * B-Rep CAD service; this client deliberately contains no model presets.
 */

export interface EngineeringBackendHealth {
  ok: boolean;
  build123d: string | null;
  ocp: string | null;
  gmsh: string | null;
  python: string;
}

export interface CadExecutionMetrics {
  volume_mm3: number;
  area_mm2: number;
  mass_kg?: number;
  density_kg_m3?: number;
  bbox_mm: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  center_mm: [number, number, number];
}

export interface CadExecutionResult {
  schema: 'vision.cad/1';
  metrics: CadExecutionMetrics;
  stlBase64: string;
  stlBytes: number;
}

export interface FeaSolveResult {
  schema: 'vision.fea/1';
  nodes: number;
  elements: number;
  dofs: number;
  h: number;
  volume_mm3: number;
  mass_kg: number;
  maxVonMises: number;
  maxVonMisesLocation: [number, number, number];
  maxDisplacement: number;
  maxDisplacementLocation: [number, number, number];
  safetyFactor: number;
  positions: number[];
  displacement: number[];
  vonMises: number[];
  loadArea: number;
}

export interface FeaValidation {
  caseId: string;
  name: string;
  reference: number;
  computed: number;
  errorPercent: number;
  passed: boolean;
  tolerancePercent: number;
  formula: string;
  meshElements: number;
  solveMs: number;
}

export class EngineeringBackendError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status = 0, detail?: string) {
    super(message);
    this.name = 'EngineeringBackendError';
    this.status = status;
    this.detail = detail;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text for the error below.
  }
  if (!response.ok) {
    const body = payload as { error?: string; trace?: string } | null;
    throw new EngineeringBackendError(
      body?.error || `Engineering backend returned HTTP ${response.status}`,
      response.status,
      body?.trace,
    );
  }
  return payload as T;
}

export async function engineeringBackendHealth(): Promise<EngineeringBackendHealth> {
  const response = await fetch('/api/engineering/health', { cache: 'no-store' });
  return parseResponse<EngineeringBackendHealth>(response);
}

export async function executeBuild123d(
  script: string,
  densityKgM3 = 2700,
  signal?: AbortSignal,
): Promise<CadExecutionResult> {
  const response = await fetch('/api/engineering/cad/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, density_kg_m3: densityKgM3 }),
    signal,
  });
  return parseResponse<CadExecutionResult>(response);
}

export interface FeaSolveInput {
  script: string;
  material: {
    E: number;
    nu: number;
    rho: number;
    yieldStrength: number;
  };
  supports: Array<{ face: string; enabled?: boolean }>;
  loads: Array<{
    face: string;
    vector: [number, number, number];
    magnitude: number;
    enabled?: boolean;
  }>;
  meshSize: number;
}

export async function solveFea(input: FeaSolveInput, signal?: AbortSignal): Promise<FeaSolveResult> {
  const response = await fetch('/api/engineering/fea/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      script: input.script,
      material: input.material,
      supports: input.supports,
      loads: input.loads,
      mesh_size: input.meshSize,
    }),
    signal,
  });
  return parseResponse<FeaSolveResult>(response);
}

export async function validateFea(signal?: AbortSignal): Promise<FeaValidation> {
  const response = await fetch('/api/engineering/fea/validate', { method: 'POST', signal });
  return parseResponse<FeaValidation>(response);
}

export function stlBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
