export type Vec3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';
export type FaceId = 'x-min' | 'x-max' | 'y-min' | 'y-max' | 'z-min' | 'z-max';
export type UnitSystem = 'mm-N-MPa';
export type GeometryTemplate = 'bracket' | 'plate' | 'block' | 'cylinder' | 'empty';

export type VariableGroup = '主控尺寸' | '连接结构' | '轻量化';
export type VariableRole = 'primary' | 'secondary';

export interface DesignVariable {
  key: string;
  label: string;
  labelEn: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: 'mm' | 'deg' | 'mm²';
  group: VariableGroup;
  role: VariableRole;
  precision?: number;
  note?: string;
}

export interface FeatureDescriptor {
  id: string;
  index: string;
  name: string;
  nameEn: string;
  kind: 'solid' | 'cut' | 'pattern' | 'boss';
  operation: 'add' | 'subtract';
  description: string;
  variableKeys: string[];
  quality?: 'primary' | 'secondary';
}

export interface Support {
  id: string;
  name: string;
  face: FaceId;
  type: 'fixed';
  enabled: boolean;
}

export interface Load {
  id: string;
  name: string;
  face: FaceId;
  vector: Vec3;
  magnitude: number;
  enabled: boolean;
  description?: string;
}

export interface MeshSettings {
  targetElements: number;
  cellSizeMm?: number;
  elementType: 'C3D8';
  tolerance: number;
  maxIterations: number;
  boundaryPolicy: 'conservative-voxel';
}

export interface ModelDocument {
  schema: 'vision.model/1';
  id: string;
  code: string;
  name: string;
  subtitle: string;
  revision: string;
  template?: GeometryTemplate;
  units: UnitSystem;
  materialId: string;
  variables: DesignVariable[];
  features: FeatureDescriptor[];
  supports: Support[];
  loads: Load[];
  mesh: MeshSettings;
  meta: {
    client: string;
    discipline: string;
    created: string;
    analyst: string;
    designIntent: string;
  };
}

export interface ProjectRecord {
  id: string;
  model: ModelDocument;
  createdAt: string;
  updatedAt: string;
}

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export interface QualityReport {
  minScaledJacobian: number;
  maxAspectRatio: number;
  meanAspectRatio: number;
  negativeElements: number;
  activeNodeRatio: number;
}

export interface GeometryData {
  positions: Float32Array;
  indices: Uint32Array;
  bbox: Box3;
  volumeMm3: number;
  areaMm2: number;
  triangleCount: number;
  vertexCount: number;
  buildMs: number;
  watermark: string;
}

export interface GeometryMetrics {
  volumeCm3: number;
  massKg: number;
  surfaceCm2: number;
  bbox: Box3;
  triangleCount: number;
  buildMs: number;
  watermark: string;
}

export type FieldKind = 'vonMises' | 'displacement' | 'safety';

export interface NodalField {
  positions: Float32Array;
  displacement: Float32Array;
  vonMises: Float32Array;
  nodeCount: number;
}

export interface MeshStats {
  nodes: number;
  elements: number;
  dofs: number;
  cellSize: number;
  grid: [number, number, number];
  activeNodeRatio: number;
  volumeMm3: number;
  quality: QualityReport;
}

export interface SolverStats {
  method: 'PCG';
  preconditioner: 'Jacobi';
  iterations: number;
  residual: number;
  relativeResidual: number;
  converged: boolean;
  solveMs: number;
  meshMs: number;
  strainEnergyMj: number;
}

export interface EquilibriumCheck {
  applied: Vec3;
  reaction: Vec3;
  residual: Vec3;
  relativeError: number;
}

export interface AnalysisResult {
  id: string;
  createdAt: string;
  modelRevision: string;
  modelHash: string;
  studyName: string;
  materialId: string;
  loadCase: string;
  status: 'ok' | 'warning';
  maxVonMises: number;
  maxVonMisesLocation: Vec3;
  maxDisplacement: number;
  maxDisplacementLocation: Vec3;
  safetyFactor: number;
  massKg: number;
  mesh: MeshStats;
  solver: SolverStats;
  equilibrium: EquilibriumCheck;
  field: NodalField;
  warnings: string[];
  convergence?: {
    coarseMaxDisplacement: number;
    fineMaxDisplacement: number;
    deltaPercent: number;
  };
}

export interface ValidationResult {
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

export interface OptimizerCandidate {
  value: number;
  massKg: number;
  safetyFactor: number;
  maxDisplacement: number;
  feasible: boolean;
  status: 'screened' | 'verified';
}

export interface OptimizationResult {
  objective: 'min-mass';
  variableKey: string;
  variableLabel: string;
  targetSafety: number;
  displacementLimit: number;
  candidates: OptimizerCandidate[];
  recommended: OptimizerCandidate | null;
  baseline: OptimizerCandidate;
  massDeltaPercent: number | null;
  elapsedMs: number;
  note: string;
}

export interface ChatPlanStep {
  id: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'error';
  detail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  steps?: ChatPlanStep[];
  streaming?: boolean;
  reasoning?: string;
  latencyMs?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
  meta?: {
    kind?: 'insight' | 'action' | 'report' | 'question';
    chips?: string[];
    tool?: string;
    source?: 'deepseek' | 'local' | 'system';
    model?: string;
  };
}

export interface AgentAction {
  tool:
    | 'set_variable'
    | 'set_material'
    | 'set_load'
    | 'set_support'
    | 'run_analysis'
    | 'optimize'
    | 'explain_risk'
    | 'export_report'
    | 'unknown';
  args: Record<string, string | number | boolean>;
  label: string;
}

export interface AgentPlan {
  intent: string;
  summary: string;
  actions: AgentAction[];
  confidence: number;
}

export type WorkspaceId = 'model' | 'analysis' | 'optimize' | 'materials' | 'history';

export interface ToastMessage {
  id: string;
  title: string;
  detail?: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
}
