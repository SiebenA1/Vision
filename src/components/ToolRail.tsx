import {
  Activity,
  Boxes,
  Clock3,
  Cuboid,
  Layers3,
  Library,
  SlidersHorizontal,
  TerminalSquare,
} from 'lucide-react';
import type { WorkspaceId } from '../core/types';
import { useAppStore } from '../state/store';

interface ToolRailProps {
  onOpenAnalysis: () => void;
}

const items: Array<{
  id: WorkspaceId;
  label: string;
  icon: typeof Cuboid;
  action: 'rail' | 'analysis';
}> = [
  { id: 'model', label: '模型 / Model', icon: Cuboid, action: 'rail' },
  { id: 'history', label: '特征历史 / History', icon: Clock3, action: 'rail' },
  { id: 'analysis', label: '分析 / Analysis', icon: Activity, action: 'analysis' },
  { id: 'materials', label: '材料 / Materials', icon: Layers3, action: 'rail' },
];

export function ToolRail({ onOpenAnalysis }: ToolRailProps) {
  const rail = useAppStore((state) => state.rail);
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);
  const leftCollapsed = useAppStore((state) => state.leftCollapsed);
  const setRail = useAppStore((state) => state.setRail);
  const openWorkspace = useAppStore((state) => state.openWorkspace);
  const toggleLeft = useAppStore((state) => state.toggleLeft);
  const addToast = useAppStore((state) => state.addToast);

  return (
    <aside className="tool-rail" aria-label="工具">
      <div className="tool-rail__brand">
        <Boxes size={19} />
      </div>
      <div className="tool-rail__items">
        {items.map((item) => {
          const Icon = item.icon;
          const active =
            item.action === 'rail'
              ? rail === item.id && !activeWorkspace
              : activeWorkspace === 'analysis';
          return (
            <button
              key={item.id}
              type="button"
              className={`rail-button ${active ? 'is-active' : ''}`}
              title={item.label}
              aria-label={item.label}
              onClick={() => {
                if (item.action === 'analysis') {
                  onOpenAnalysis();
                  return;
                }
                openWorkspace(null);
                setRail(item.id);
                if (leftCollapsed) toggleLeft();
              }}
            >
              <Icon size={19} strokeWidth={1.7} />
              <span className="rail-button__tip">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="tool-rail__bottom">
        <button
          type="button"
          className="rail-button"
          title="命令面板 / Command"
          aria-label="命令面板"
          onClick={() =>
            addToast({
              title: '命令面板',
              detail: '⌘K / Ctrl+K 聚焦工程智能体；所有操作均通过受控工具执行。',
              tone: 'neutral',
            })
          }
        >
          <TerminalSquare size={19} strokeWidth={1.7} />
          <span className="rail-button__tip">命令面板</span>
        </button>
        <button
          type="button"
          className="rail-button"
          title="材料库"
          aria-label="材料库"
          onClick={() => {
            openWorkspace(null);
            setRail('materials');
          }}
        >
          <Library size={19} strokeWidth={1.7} />
          <span className="rail-button__tip">材料库</span>
        </button>
        <button
          type="button"
          className="rail-button rail-button--muted"
          title="参数化内核状态"
          aria-label="参数化内核状态"
          onClick={() =>
            addToast({
              title: 'Manifold kernel · online',
              detail: 'watertight mesh booleans · 本地 WASM 运行 · 无几何数据外传。',
              tone: 'success',
            })
          }
        >
          <SlidersHorizontal size={18} strokeWidth={1.7} />
        </button>
        <div className="tool-rail__version">v0.1</div>
      </div>
    </aside>
  );
}
