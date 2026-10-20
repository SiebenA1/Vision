import type { InspectionKind } from '../services/engineeringBackend';
import { useInspectionStore } from '../state/inspectionStore';
import { MeasurementPanel } from './MeasurementPanel';

const modes: Array<[InspectionKind, string]> = [['body', '体'], ['face', '面'], ['edge', '边'], ['vertex', '点']];

export function MeasurementControls() {
  const state = useInspectionStore();
  return <aside className="measurement-hud measurement-controls" aria-label="测量操作">
    <div className="measurement-controls__head">
      <span className="measurement-hud__light" /><span>测量</span>
      <label title="开启后点击模型选择几何；拖动仍可旋转视图">
        <input type="checkbox" checked={state.enabled} onChange={event => state.setEnabled(event.target.checked)} />视口拾取
      </label>
    </div>
    <div className="measurement-controls__modes" role="group" aria-label="测量选择类型">
      {modes.map(([mode, label]) => <button type="button" key={mode} aria-pressed={state.enabled && state.mode === mode}
        title={`拾取${label === '点' ? '顶点' : label}`} onClick={() => { state.setMode(mode); state.setEnabled(true); }}>{label}</button>)}
      <button type="button" onClick={() => { state.setMode('body'); void state.measure([]); }}>整体</button>
    </div>
    <div className="measurement-controls__options">
      <label><input type="checkbox" checked={state.smart} onChange={event => state.setSmart(event.target.checked)} />智能识别参数</label>
      <details className="measurement-controls__advanced"><summary>更多</summary><MeasurementPanel /></details>
    </div>
    <p className="measurement-controls__hint" role="status">{state.busy ? '正在测量…' : state.enabled
      ? `${state.selection.length ? `已选 ${state.selection.length} 项 · ` : ''}Ctrl / ⌘ 多选 · 拖动旋转` : '点击体 / 面 / 边 / 点，开始拾取'}</p>
  </aside>;
}
