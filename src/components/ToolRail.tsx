import { Clock3, Cuboid, Layers3 } from 'lucide-react';
import { useAppStore } from '../state/store';

const items = [
  { id: 'model', label: '模型', icon: Cuboid },
  { id: 'materials', label: '材料', icon: Layers3 },
  { id: 'history', label: '历史', icon: Clock3 },
] as const;

export function ToolRail() {
  const rail = useAppStore((state) => state.rail);
  const collapsed = useAppStore((state) => state.leftCollapsed);
  return (
    <aside className="tool-rail" aria-label="工程面板">
      <div className="tool-rail__items">
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={`rail-button ${!collapsed && rail === id ? 'is-active' : ''}`}
            aria-label={label} aria-pressed={!collapsed && rail === id}
            onClick={() => {
              const state = useAppStore.getState();
              if (state.rail === id && !state.leftCollapsed) state.toggleLeft();
              else { state.setRail(id); if (state.leftCollapsed) state.toggleLeft(); }
            }}>
            <Icon size={20} /><span>{label}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
