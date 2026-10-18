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
  onOpenOptimize: () => void;
  onExportModel: () => void;
  onExportReport: () => void;
  onReset: () => void;
  onOpenLlmSettings: () => void;
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
        <small>ENGINEERING INTELLIGENCE</small>
      </div>
    </div>
  );
}

export function TopBar({
  onRunAnalysis,
  onOpenAnalysis,
  onOpenOptimize,
  onExportModel,
  onExportReport,
  onReset,
  onOpenLlmSettings,
}: TopBarProps) {
  const model = useAppStore((state) => state.model);
  const history = useAppStore((state) => state.history);
  const future = useAppStore((state) => state.future);
  const analysisStatus = useAppStore((state) => state.analysisStatus);
  const resultStale = useAppStore((state) => state.resultStale);
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
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <Wordmark />
        <div className="topbar__divider" />
        <div className="project-crumb">
          <span className="eyebrow">PROJECT</span>
          <button type="button" className="project-crumb__title">
            {model.code} <span>·</span> {model.name}
            <ChevronDown size={13} />
          </button>
        </div>
      </div>

      <nav className="topbar__nav" aria-label="工作区">
        <button type="button" className="nav-tab is-active">
          模型与验证
        </button>
        <button type="button" className="nav-tab" onClick={onOpenAnalysis}>
          分析工作台
          {resultStale && <span className="nav-tab__flag">STALE</span>}
        </button>
        <button type="button" className="nav-tab" onClick={onOpenOptimize}>
          生成式优化
        </button>
      </nav>

      <div className="topbar__actions">
        <div className={`engine-status ${busy ? 'engine-status--busy' : ''}`}>
          <span className="engine-status__dot" />
          <span>{busy ? 'SOLVER ACTIVE' : 'LOCAL ENGINE'}</span>
        </div>
        <div className="history-controls">
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
        </div>
        <button type="button" className="button button--primary topbar__run" onClick={onRunAnalysis}>
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
              <button type="button" onClick={() => { setMenuOpen(false); onOpenAnalysis(); }}>
                <Play size={14} /> 打开分析工作台
              </button>
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
                <RotateCcw size={14} /> 重置示例项目
              </button>
            </div>
          )}
        </div>
        <button type="button" className="avatar" title="Jarvi · 设计负责人">
          JV
        </button>
      </div>
    </header>
  );
}
