import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Cpu,
  Download,
  FileText,
  GitBranch,
  MoreHorizontal,
  Play,
  Redo2,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import { useAppStore } from '../state/store';

interface TopBarProps {
  onRunAnalysis: () => void;
  onOpenAnalysis: () => void;
  onExportModel: () => void;
  onExportReport: () => void;
  onReset: () => void;
  onOpenLlmSettings: () => void;
  onOpenProjects: () => void;
}

function Wordmark() {
  return (
    <div className="wordmark" aria-label="VISION">
      <svg className="wordmark__mark" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <path d="M4 5.5 15 26 26 5.5" stroke="currentColor" strokeWidth="2.2" />
        <path d="M9.6 5.5 15 16l5.4-10.5" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
        <circle cx="15" cy="26" r="2.2" fill="currentColor" />
      </svg>
      <div className="wordmark__type">
        <span>VISION</span>
      </div>
    </div>
  );
}

export function TopBar({
  onRunAnalysis,
  onOpenAnalysis,
  onExportModel,
  onExportReport,
  onReset,
  onOpenLlmSettings,
  onOpenProjects,
}: TopBarProps) {
  const model = useAppStore((state) => state.model);
  const history = useAppStore((state) => state.history);
  const future = useAppStore((state) => state.future);
  const analysisStatus = useAppStore((state) => state.analysisStatus);
  const geometry = useAppStore((state) => state.geometry);
  const undo = useAppStore((state) => state.undo);
  const redo = useAppStore((state) => state.redo);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = ['mesh', 'solve', 'refine', 'queued'].includes(analysisStatus);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <Wordmark />
        <div className="topbar__divider" />
        <div className="project-crumb">
          <button
            type="button"
            className="project-crumb__title"
            onClick={onOpenProjects}
            aria-haspopup="dialog"
            title="打开工程中心"
          >
            {model.code} <span>·</span> {model.name}
            <ChevronDown size={13} />
          </button>
        </div>
      </div>

      <div className="topbar__actions">
        {(history.length > 0 || future.length > 0) && <div className="history-controls">
          <button
            type="button"
            className="icon-button"
            onClick={undo}
            disabled={history.length === 0}
            title="撤销 (Ctrl+Z)"
          >
            <Undo2 size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={redo}
            disabled={future.length === 0}
            title="重做 (Ctrl+Shift+Z)"
          >
            <Redo2 size={16} />
          </button>
        </div>}
        <button type="button" className="button" onClick={onOpenAnalysis} disabled={!geometry}>分析详情</button>
        <button type="button" className="button button--primary topbar__run" onClick={onRunAnalysis} disabled={!geometry || busy} title={!geometry ? '先在 ATLAS 中描述零件，生成几何后即可分析' : '运行当前工况'}>
          <Play size={14} fill="currentColor" />
          {busy ? '求解中' : '运行分析'}
        </button>
        <div className="menu-anchor" ref={menuRef}>
          <button
            type="button"
            className="icon-button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            title="项目操作"
          >
            <MoreHorizontal size={18} />
          </button>
          {menuOpen && (
            <div className="dropdown-menu">
              <div className="dropdown-menu__label">PROJECT</div>
              <button type="button" onClick={() => { setMenuOpen(false); onOpenLlmSettings(); }}>
                <Cpu size={14} /> DeepSeek 设置
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); onExportModel(); }}>
                <Download size={14} /> 导出 STL
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); onExportReport(); }}>
                <FileText size={14} /> 导出校核报告
              </button>
              <div className="dropdown-menu__rule" />
              <div className="dropdown-menu__meta">
                <GitBranch size={12} /> {model.revision} · schema {model.schema.split('/')[1]}
              </div>
              <button type="button" onClick={() => { setMenuOpen(false); onReset(); }}>
                <RotateCcw size={14} /> 重置为空白工程
              </button>
            </div>
          )}
        </div>

      </div>
    </header>
  );
}
