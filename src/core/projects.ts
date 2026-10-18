import type { ModelDocument, ProjectRecord } from './types';

const STORAGE_KEY = 'vision.project.library.v2';
const ACTIVE_KEY = 'vision.project.active.v2';

function isoNow(): string {
  return new Date().toISOString();
}

function cloneRecord(record: ProjectRecord): ProjectRecord {
  return {
    ...record,
    model: structuredClone(record.model),
  };
}

export function isModelDocument(value: unknown): value is ModelDocument {
  if (!value || typeof value !== 'object') return false;
  const model = value as Partial<ModelDocument>;
  return (
    model.schema === 'vision.model/1' &&
    typeof model.id === 'string' &&
    typeof model.code === 'string' &&
    typeof model.name === 'string' &&
    Array.isArray(model.variables) &&
    Array.isArray(model.features) &&
    Array.isArray(model.supports) &&
    Array.isArray(model.loads) &&
    Boolean(model.mesh) &&
    Boolean(model.meta)
  );
}

export function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ProjectRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    isModelDocument(record.model)
  );
}

/**
 * A blank project is the only built-in project. Geometry must come from the
 * generic build123d/OCCT backend; there are no model presets.
 */
export function createBlankProjectModel(code = 'CAD-000', name = '空白工程'): ModelDocument {
  const now = isoNow();
  return {
    schema: 'vision.model/1',
    id: `mdl_${Date.now().toString(36)}`,
    code,
    name,
    subtitle: 'Blank build123d / OCCT workspace',
    revision: 'R01',
    template: 'empty',
    units: 'mm-N-MPa',
    materialId: 'AL6061-T6',
    variables: [],
    features: [],
    supports: [
      {
        id: 'sup_blank',
        name: '未定义约束',
        face: 'x-min',
        type: 'fixed',
        enabled: true,
      },
    ],
    loads: [
      {
        id: 'load_blank',
        name: '未定义载荷',
        face: 'x-max',
        vector: [0, 0, -1],
        magnitude: 1000,
        enabled: true,
        description: '空白工程占位载荷；分析前必须按实际工况修改。',
      },
    ],
    mesh: {
      targetElements: 7000,
      cellSizeMm: 4,
      elementType: 'C3D4',
      tolerance: 1e-4,
      maxIterations: 2400,
      boundaryPolicy: 'conservative-voxel',
    },
    meta: {
      client: 'VISION Engineering',
      discipline: '结构 · 静力',
      created: now.slice(0, 10),
      analyst: 'ATLAS / 工程智能体',
      designIntent: '空白工程：通过 build123d/OCCT 脚本定义几何、载荷和约束。没有预置模型。',
    },
  };
}

export function seedProjects(): ProjectRecord[] {
  const model = createBlankProjectModel();
  return [
    {
      id: 'prj_blank',
      model,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    },
  ];
}

export interface ProjectLibraryState {
  projects: ProjectRecord[];
  activeProjectId: string;
}

export function loadProjectLibrary(): ProjectLibraryState {
  const fallback = seedProjects();
  if (typeof window === 'undefined') {
    return { projects: fallback, activeProjectId: fallback[0].id };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { projects: fallback, activeProjectId: fallback[0].id };
    const parsed = JSON.parse(raw) as unknown;
    const projects = Array.isArray(parsed) ? parsed.filter(isProjectRecord).map(cloneRecord) : [];
    if (projects.length === 0) return { projects: fallback, activeProjectId: fallback[0].id };
    const storedActive = localStorage.getItem(ACTIVE_KEY);
    const activeProjectId = projects.some((project) => project.id === storedActive)
      ? String(storedActive)
      : projects[0].id;
    return { projects, activeProjectId };
  } catch {
    return { projects: fallback, activeProjectId: fallback[0].id };
  }
}

export function persistProjectLibrary(projects: ProjectRecord[], activeProjectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
    localStorage.setItem(ACTIVE_KEY, activeProjectId);
  } catch {
    // Local persistence is best-effort; STL payloads can be large.
  }
}

export function nextProjectCode(projects: ProjectRecord[], prefix = 'CAD'): string {
  let index = 1;
  const used = new Set(projects.map((project) => project.model.code));
  while (used.has(`${prefix}-${String(index).padStart(3, '0')}`)) index += 1;
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

export function makeProjectRecord(model: ModelDocument): ProjectRecord {
  const now = isoNow();
  return {
    id: `prj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    model: structuredClone(model),
    createdAt: now,
    updatedAt: now,
  };
}

export function relativeProjectTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '—';
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} 分钟前`;
  if (diff < day) return `${Math.round(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.round(diff / day)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}
