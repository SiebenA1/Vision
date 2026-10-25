import { describe, expect, it } from 'vitest';
import { draftPrefix, parseDraft, readDrafts, type DraftRecord } from '../src/features/workspace/drafts';

const project = 'a'.repeat(32), other = 'b'.repeat(32);
const record = (writer: string, savedAt: number): DraftRecord => ({ schema: 'vision.editor-draft/1', project, writer, savedAt,
  content: { script: { base: 'c'.repeat(32), code: 'result = parameters', parameters: '{invalid JSON draft', tolerance: .05, angle: 10, mode: 'fresh', inspectOnly: false } } });

describe('local editor recovery boundaries', () => {
  it('preserves unfinished text, but rejects cross-project, future and malformed records', () => {
    const original = record('tab-a', 100);
    expect(parseDraft(JSON.stringify(original), project, 'tab-a')).toEqual(original);
    for (const invalid of [
      { ...original, project: other }, { ...original, schema: 'vision.editor-draft/99' },
      { ...original, content: { script: { ...original.content.script, base: '../foreign' } } },
      { ...original, content: { study: { base: 'c'.repeat(32), text: 123 } } },
    ]) expect(parseDraft(JSON.stringify(invalid), project, 'tab-a')).toBeNull();
    expect(parseDraft('not JSON', project, 'tab-a')).toBeNull();
  });

  it('keeps independent page copies and filters by project without deleting unreadable data', () => {
    const values = new Map([
      [draftPrefix(project) + 'tab-a', JSON.stringify(record('tab-a', 100))],
      [draftPrefix(project) + 'tab-b', JSON.stringify(record('tab-b', 200))],
      [draftPrefix(other) + 'tab-c', JSON.stringify({ ...record('tab-c', 300), project: other })],
      [draftPrefix(project) + 'corrupt', 'invalid'],
    ]);
    const storage: Storage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
      getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
      removeItem: key => { values.delete(key); }, clear: () => values.clear() };
    expect(readDrafts(storage, project).map(item => item.writer)).toEqual(['tab-b', 'tab-a']);
    expect(values.size).toBe(4);
    expect(storage.getItem(draftPrefix(project) + 'corrupt')).toBe('invalid');
  });
});
