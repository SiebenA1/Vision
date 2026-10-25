import type { RegionSelection } from '../../core/cad/types';

export interface CoreStudy {
  material: { E: number; nu: number; rho: number; yieldStrength: number };
  supports: Array<{ id: string; name?: string; face?: string; type?: 'fixed'; enabled?: boolean; region?: CoreRegion }>;
  loads: Array<{ id: string; name?: string; face?: string; vector: number[]; magnitude: number; enabled?: boolean; region?: CoreRegion }>;
  mesh_size: number;
  body_ids?: string[] | null;
  body_artifact_id?: string | null;
}
type CoreRegion = RegionSelection | { type: 'semantic-object'; object_id: string; toleranceMm: number };
export interface CoreObject {
  id: string; name: string; purpose: string; source_event: string;
  binding: { artifact_id: string; topology_ids: string[] };
}
export interface CoreInspection {
  is_pick: boolean;
  artifact_id: string; revision_id: string; selection: string[];
  candidates: Array<{ id: string; distance_mm: number; point: number[] }>;
  candidate_count: number;
  visual: { lines: number[][][]; truncated: boolean };
  metrics: Array<{ id: string; area_mm2?: number; length_mm?: number }>;
}
export interface CorePick { kind: 'body' | 'face' | 'edge'; point: number[]; tolerance_mm: number }
export interface CoreBuildImpact {
  digest: string; base_revision_id: string; source_artifact: string | null; notice: string;
  objects: Array<{ id: string; name: string; action: 'rebind' | 'already_stale' }>;
  study_regions: Array<{ id: string; name: string; region_type: string; action: 'rebind' | 'review_region' }>;
  selected_bodies_to_review: string[]; evidence_action: 'recompute' | 'no_current_analysis';
}
export interface CoreRevision {
  project_id: string;
  revision_id: string;
  head_revision_id: string;
  parent_revision_id: string | null;
  created_at: number;
  document: { schema_version: 'vision.project/2'; name: string; geometry: string | null; study: CoreStudy | null; legacy_source?: string | null; requirements?: CoreRequirement[]; objects?: CoreObject[] };
}
export interface CoreRequirement {
  id: string; source_event: string; name: string;
  metric: 'maxDisplacement' | 'maxVonMises' | 'mass_kg' | 'safetyFactor';
  comparison: 'le' | 'ge'; threshold: number; unit: string;
}
export interface CoreAssessment {
  revision_id: string; evidence_job_id: string | null; notice: string;
  findings: Array<{ requirement: CoreRequirement; status: 'pass' | 'fail' | 'unknown'; value: number | null; reason: string }>;
}
export interface CoreJob {
  id: string;
  revision: string;
  kind: 'cad' | 'fea';
  state: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  error: string | null;
  phase?: string | null;
  adopted_revision: string | null;
  result: { artifact_id: string; origin?: 'imported'; metrics?: Record<string, unknown>; summary?: Record<string, unknown> } | null;
}

export class CoreApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function coreRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v2${path}`, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      const id = body && typeof body === 'object' && 'command_id' in body ? String(body.command_id) : null;
      throw new CoreApiError(id ? `连接中断，操作 ${id} 的状态尚未确认。请先重新连接核对工程和作业，避免重复提交。` : '无法连接本地工程服务，请重试。', 0);
    });
  return coreResponse<T>(response);
}

async function coreResponse<T>(response: Response): Promise<T> {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new CoreApiError(`本地工程服务返回异常响应（HTTP ${response.status}）。操作状态尚未确认，请刷新工程列表核对；若持续出现，请重启本地工程服务。`, response.status);
  }
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data);
    throw new CoreApiError(response.status === 409 ? `工程已发生变化，请刷新后再操作。${detail}` : detail, response.status);
  }
  return data as T;
}

export async function importCoreBundle(file: File): Promise<CoreRevision> {
  if (file.size > 32 * 1024 * 1024) throw new Error('工程包不能超过 32 MiB');
  const command = coreCommand();
  const response = await fetch('/api/v2/imports/bundle', { method: 'POST', body: file,
    headers: { 'Content-Type': 'application/zip', 'X-Command-ID': command.command_id, 'Idempotency-Key': command.idempotency_key } });
  return coreResponse<CoreRevision>(response);
}

export function coreCommand(revision?: string) {
  const id = crypto.randomUUID();
  return { command_id: id, idempotency_key: id, ...(revision ? { expected_head: revision } : {}) };
}

export function coreArtifactUrl(id: string, filename: string) {
  return `/api/v2/artifacts/${encodeURIComponent(id)}/files/${encodeURIComponent(filename)}`;
}

export const activeJob = (job: CoreJob) => ['queued', 'running', 'cancelling'].includes(job.state);
