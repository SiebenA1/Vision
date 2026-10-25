import { useEffect, useRef, useState } from 'react';
import type { CoreRequirement } from './api';

export interface EditorDraft {
  script?: { base: string; code: string; parameters: string; tolerance: number; angle: number; mode: string; inspectOnly: boolean; source?: string | null };
  study?: { base: string; text: string };
  requirement?: { base: string; statement: string; threshold: string; metric: CoreRequirement['metric'] };
}
export interface DraftRecord { schema: 'vision.editor-draft/1'; project: string; writer: string; savedAt: number; content: EditorDraft }
export const draftPrefix = (project: string) => `vision.core.draft/1/${project}/`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 200000): value is string => typeof value === 'string' && value.length <= limit;
const base = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

/** Bad or future local data is left untouched, never treated as engineering state. */
export function parseDraft(raw: string, project: string, writer: string): DraftRecord | null {
  try {
    if (raw.length > 512000) return null;
    const data: unknown = JSON.parse(raw);
    if (!object(data) || data.schema !== 'vision.editor-draft/1' || data.project !== project || data.writer !== writer ||
      typeof data.savedAt !== 'number' || !Number.isFinite(data.savedAt) || !object(data.content)) return null;
    const draft = data.content;
    if (Object.keys(draft).some(key => !['script', 'study', 'requirement'].includes(key))) return null;
    if (draft.script !== undefined) {
      const item = draft.script;
      if (!object(item) || !base(item.base) || !text(item.code) || !text(item.parameters) ||
        typeof item.tolerance !== 'number' || !Number.isFinite(item.tolerance) || typeof item.angle !== 'number' || !Number.isFinite(item.angle) ||
        !['current', 'fresh', 'replay', 'inspect'].includes(String(item.mode)) || typeof item.inspectOnly !== 'boolean' ||
        (item.source !== undefined && item.source !== null && (typeof item.source !== 'string' || !/^[a-f0-9]{64}$/.test(item.source)))) return null;
    }
    if (draft.study !== undefined && (!object(draft.study) || !base(draft.study.base) || !text(draft.study.text))) return null;
    if (draft.requirement !== undefined) {
      const item = draft.requirement;
      if (!object(item) || !base(item.base) || !text(item.statement, 16000) || !text(item.threshold, 100) ||
        !['maxDisplacement', 'maxVonMises', 'mass_kg', 'safetyFactor'].includes(String(item.metric))) return null;
    }
    return data as unknown as DraftRecord;
  } catch { return null; }
}

export function readDrafts(storage: Storage, project: string): DraftRecord[] {
  const prefix = draftPrefix(project), records: DraftRecord[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const record = parseDraft(storage.getItem(key) ?? '', project, key.slice(prefix.length));
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.savedAt - a.savedAt);
}

/** Per-page writers avoid cross-tab overwrite; restoration always forks a copy. */
export function useEditorDrafts(project: string | null, content: EditorDraft) {
  const writer = useRef(crypto.randomUUID());
  const active = useRef<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [records, setRecords] = useState<DraftRecord[]>([]);
  const [saved, setSaved] = useState(false);
  const [warning, setWarning] = useState('');
  const serialized = JSON.stringify(content);
  useEffect(() => { active.current = null; setSaved(false); setRecords([]); }, [project]);
  useEffect(() => {
    if (!project) return;
    const refresh = () => setRecords(readDrafts(localStorage, project).filter(item => item.writer !== writer.current));
    try {
      const key = draftPrefix(project) + writer.current;
      if (Object.keys(content).length) {
        const record: DraftRecord = { schema: 'vision.editor-draft/1', project, writer: writer.current, savedAt: Date.now(), content };
        const encoded = JSON.stringify(record);
        if (!parseDraft(encoded, project, writer.current)) throw new Error('草稿格式或大小超出本机恢复范围');
        localStorage.setItem(key, encoded); active.current = project; setSaved(true);
      } else if (active.current === project) {
        localStorage.removeItem(key); setSaved(false);
      }
      refresh(); setWarning('');
    } catch { setSaved(false); setWarning('本机草稿暂未保存，请保持页面打开并复制需要保留的内容。'); }
    const changed = (event: StorageEvent) => {
      if (event.key && !event.key.startsWith(draftPrefix(project))) return;
      try { refresh(); } catch { setWarning('本机草稿暂不可读取。'); }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [project, serialized, epoch]);
  return { records, saved, warning,
    fork: () => { writer.current = crypto.randomUUID(); active.current = null; setSaved(false); setEpoch(value => value + 1); },
    remove: (record: DraftRecord) => {
      if (record.project !== project) return;
      try { localStorage.removeItem(draftPrefix(record.project) + record.writer); setRecords(previous => previous.filter(item => item.writer !== record.writer)); }
      catch { setWarning('草稿副本未删除。'); }
    },
  };
}
