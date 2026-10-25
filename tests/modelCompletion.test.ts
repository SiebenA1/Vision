import { describe, expect, it } from 'vitest';
import { modelCompletionLabel, modelCheckValue, type ModelCompletion } from '../src/features/workspace/viewHelpers';

const completed: ModelCompletion = { revision_id: 'current', artifact_id: 'artifact', status: 'checks_passed',
  outcome: 'verified', checks: [], notice: 'Registered criteria only.' };

describe('model completion evidence', () => {
  it('labels stale checks as historical after the project revision changes', () => {
    expect(modelCompletionLabel(completed, 'new')).toBe('历史模型检查 · 需重新核验');
    expect(modelCompletionLabel(completed, 'current')).toBe('已登记检查项通过');
  });
  it('distinguishes execution, missing geometry, failed builds and unresolved features', () => {
    expect(modelCompletionLabel({ ...completed, status: 'not_built', artifact_id: null }, 'current')).toBe('尚未构建模型');
    expect(modelCompletionLabel({ ...completed, status: 'unverified' }, 'current')).toContain('尚未登记检查项');
    expect(modelCompletionLabel({ ...completed, status: 'build_failed' }, 'current')).toBe('本次构建未完成');
    expect(modelCompletionLabel({ ...completed, status: 'needs_review' }, 'current')).toBe('部分特征待核验');
    expect(modelCompletionLabel({ ...completed, outcome: 'partial' }, 'current')).toBe('部分实现 · 已登记检查项通过');
  });
  it('shows physical units for measured values and acceptance bounds', () => {
    expect(modelCheckValue(34, 'bbox_z_mm')).toBe('34mm');
    expect(modelCheckValue(42, 'volume_mm3')).toBe('42mm³');
    expect(modelCheckValue(2, 'solid_count')).toBe('2个');
  });
});
