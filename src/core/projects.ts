import type { ModelDocument, ProjectRecord } from './types';
import { BRACKET_MODEL, cloneModel } from './presets';
import { createBrakePedalModel, createWindBladeModel } from './templates';

const STORAGE_KEY = 'vision.project.library.v1';
const ACTIVE_KEY = 'vision.project.active.v1';

function isoNow(): string {
  return new Date().toISOString();
}

function cloneRecord(record: ProjectRecord): ProjectRecord {
  return {
    ...record,
    model: cloneModel(record.model),
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

function heavyProject(): ProjectRecord {
  const model = cloneModel(BRACKET_MODEL);
  model.id = 'mdl_brk_042_l';
  model.code = 'BRK-042-L';
  model.name = '重载悬挂支架';
  model.revision = 'R02';
  model.subtitle = 'Heavy-duty cantilever variant';
  model.materialId = 'AL7075-T6';
  model.meta.designIntent = '在 1,200 N 端载下保持安全系数 ≥ 2.0，优先保证螺栓连接与根部强度。';
  const set = (key: string, value: number) => {
    const variable = model.variables.find((item) => item.key === key);
    if (variable) variable.value = value;
  };
  set('armThickness', 16);
  set('wallThickness', 12);
  set('armWidth', 54);
  if (model.loads[0]) {
    model.loads[0].magnitude = 1200;
    model.loads[0].description = '重载工况 · 1,200 N 端部竖向载荷';
  }
  return {
    id: 'prj_brk_042_l',
    model,
    createdAt: '2026-10-12T09:20:00.000Z',
    updatedAt: '2026-10-18T05:00:00.000Z',
  };
}

function lightweightProject(): ProjectRecord {
  const model = cloneModel(BRACKET_MODEL);
  model.id = 'mdl_brk_042_s';
  model.code = 'BRK-042-S';
  model.name = '轻量化支架';
  model.revision = 'R03';
  model.subtitle = 'Mass-minimized cantilever variant';
  model.meta.designIntent = '以 SF ≥ 2.0、δmax ≤ 2.0 mm 为约束，探索悬臂厚度与减重孔的质量收益。';
  const set = (key: string, value: number) => {
    const variable = model.variables.find((item) => item.key === key);
    if (variable) variable.value = value;
  };
  set('armThickness', 9);
  set('lighteningHoleDia', 24);
  return {
    id: 'prj_brk_042_s',
    model,
    createdAt: '2026-10-15T11:40:00.000Z',
    updatedAt: '2026-10-18T05:10:00.000Z',
  };
}

function brakePedalProject(): ProjectRecord {
  return {
    id: 'prj_pedal_01',
    model: createBrakePedalModel('PEDAL-01', '刹车踏板支架'),
    createdAt: '2026-10-16T08:30:00.000Z',
    updatedAt: '2026-10-18T05:20:00.000Z',
  };
}

function windBladeProject(): ProjectRecord {
  return {
    id: 'prj_wind_blade_01',
    model: createWindBladeModel('WT-01', '风电叶片'),
    createdAt: '2026-10-17T06:10:00.000Z',
    updatedAt: '2026-10-18T05:30:00.000Z',
  };
}

export function seedProjects(): ProjectRecord[] {
  return [
    {
      id: 'prj_brk_042',
      model: cloneModel(BRACKET_MODEL),
      createdAt: '2026-10-10T08:00:00.000Z',
      updatedAt: isoNow(),
    },
    heavyProject(),
    lightweightProject(),
    brakePedalProject(),
    windBladeProject(),
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
    if (!projects.some((project) => project.model.code === 'PEDAL-01')) {
      projects.push(brakePedalProject());
    }
    if (!projects.some((project) => project.model.code === 'WT-01')) {
      projects.push(windBladeProject());
    }
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
    // Local persistence is best-effort.
  }
}

export function nextProjectCode(projects: ProjectRecord[], prefix = 'BRK'): string {
  let index = 43;
  const used = new Set(projects.map((project) => project.model.code));
  while (used.has(`${prefix}-${String(index).padStart(3, '0')}`)) index += 1;
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

export function makeProjectRecord(model: ModelDocument): ProjectRecord {
  const now = isoNow();
  return {
    id: `prj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    model: cloneModel(model),
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
