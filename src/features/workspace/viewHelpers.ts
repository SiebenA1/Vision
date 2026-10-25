/** Horizontal ruler at the orbit target's depth, in model millimetres. */
export function viewRuler(distance: number, fovDegrees: number, heightPx: number) {
  if (![distance, fovDegrees, heightPx].every(Number.isFinite) || !(distance > 0 && heightPx > 0 && fovDegrees > 0 && fovDegrees < 180)) return null;
  const mmPerPixel = 2 * distance * Math.tan(fovDegrees * Math.PI / 360) / heightPx;
  const target = mmPerPixel * 110;
  const power = 10 ** Math.floor(Math.log10(target));
  const fraction = target / power;
  const length = (fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1) * power;
  return { length, pixels: length / mmPerPixel };
}

export function objectLabel(id: string) {
  const part = /^body-(\d+)(?:\/(face|edge)-(\d+))?$/.exec(id);
  if (!part) return id;
  return `实体 ${Number(part[1]) + 1}${part[2] ? ` · ${part[2] === 'face' ? '面' : '边'} ${Number(part[3]) + 1}` : ''}`;
}

export interface ModelCompletion {
  revision_id: string;
  artifact_id: string | null;
  status: 'not_built' | 'unverified' | 'failed' | 'needs_review' | 'checks_passed' | 'build_failed';
  outcome: 'answer' | 'built' | 'partial' | 'verified';
  notice: string;
  checks: Array<{ requirement: { name: string; metric: string; minimum: number | null; maximum: number | null }; status: 'pass' | 'fail' | 'unknown'; actual: number | null; reason: string }>;
}

export function modelCheckValue(value: number, metric: string) {
  const unit = metric === 'volume_mm3' ? 'mm³' : metric.startsWith('bbox_') ? 'mm' : metric.endsWith('_count') ? '个' : '';
  return `${value}${unit}`;
}

export function modelCompletionLabel(completion: ModelCompletion, revision: string) {
  if (completion.revision_id !== revision) return '历史模型检查 · 需重新核验';
  const label = { not_built: '尚未构建模型', unverified: '已构建 · 尚未登记检查项', failed: '建模检查未通过',
    needs_review: '部分特征待核验', checks_passed: '已登记检查项通过', build_failed: '本次构建未完成' }[completion.status];
  return completion.outcome === 'partial' ? `部分实现 · ${label}` : label;
}
