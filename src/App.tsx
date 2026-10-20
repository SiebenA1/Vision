import { Suspense, lazy, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { TopBar } from './components/TopBar';
import { LlmSettingsModal } from './components/LlmSettingsModal';
import { ProjectCenterModal } from './components/ProjectCenterModal';
import { ToolRail } from './components/ToolRail';
import { ModelPanel } from './components/ModelPanel';
import { ViewportStage } from './components/ViewportStage';
import { CopilotPanel } from './components/CopilotPanel';
import { useAppStore } from './state/store';
import { useLlmStore } from './state/llmStore';
import { getCurrentAnalysis, runStudy } from './services/simulation';
import { sendAgentPrompt } from './services/agent';
import { resetDeepSeekConversation } from './services/deepseekAgent';
import { fmt } from './lib/format';
import { exportBinaryStl } from './core/cad/stl';

const AnalysisWorkspace = lazy(() => import('./features/analysis/AnalysisWorkspace'));

function WorkspaceSkeleton() {
  return (
    <div className="workspace-overlay workspace-skeleton">
      <div className="workspace-skeleton__bar" />
      <div className="workspace-skeleton__body">
        <div className="workspace-skeleton__side" />
        <div className="workspace-skeleton__stage">
          <div className="skeleton-orbit" />
          <span>LOADING COMPONENT · ON-DEMAND CHUNK</span>
        </div>
        <div className="workspace-skeleton__side" />
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span className="toast__icon">
            {toast.tone === 'success' ? (
              <CheckCircle2 size={16} />
            ) : toast.tone === 'warning' || toast.tone === 'error' ? (
              <AlertTriangle size={16} />
            ) : (
              <Info size={16} />
            )}
          </span>
          <div className="toast__body">
            <b>{toast.title}</b>
            {toast.detail && <span>{toast.detail}</span>}
          </div>
          <button type="button" className="toast__close" onClick={() => dismiss(toast.id)} aria-label="关闭通知">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const model = useAppStore((state) => state.model);
  const activeWorkspace = useAppStore((state) => state.activeWorkspace);
  const leftCollapsed = useAppStore((state) => state.leftCollapsed);
  const addToast = useAppStore((state) => state.addToast);
  const settingsOpen = useLlmStore((state) => state.settingsOpen);
  const closeLlmSettings = useLlmStore((state) => state.closeSettings);
  const [projectCenterOpen, setProjectCenterOpen] = useState(false);
  const geometrySignature = model.cad?.nativeSha256 ?? model.externalStlBase64 ?? '';
  const modelSignature = JSON.stringify(model);

  useEffect(() => {
    void useAppStore.getState().rebuildGeometry();
    void useLlmStore.getState().refreshGateway();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void useAppStore.getState().rebuildGeometry();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [geometrySignature]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      useAppStore.getState().syncProject();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [modelSignature]);

  useEffect(() => {
    const persist = () => useAppStore.getState().syncProject();
    const failed = () => useAppStore.getState().addToast({ title: '工程保存失败', detail: '本地存储空间不足。请导出工程数据后清理空间。', tone: 'error' });
    window.addEventListener('beforeunload', persist);
    window.addEventListener('vision:persistence-error', failed);
    return () => { window.removeEventListener('beforeunload', persist); window.removeEventListener('vision:persistence-error', failed); };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !editing) {
        event.preventDefault();
        if (event.shiftKey) useAppStore.getState().redo();
        else useAppStore.getState().undo();
      }
      if (event.key === '[' && !editing) {
        event.preventDefault();
        useAppStore.getState().toggleLeft();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const openAnalysis = () => {
    const state = useAppStore.getState();
    if (!state.geometry && (state.model.template ?? 'bracket') === 'empty') {
      addToast({
        title: '空白工程：先添加基础体',
        detail: '请先通过 ATLAS 生成 USD BRep 几何。',
        tone: 'neutral',
      });
      if (state.leftCollapsed) state.toggleLeft();
      return;
    }
    useAppStore.getState().openWorkspace('analysis');
    if (state.analysis) {
      useAppStore.getState().setViewMode('result');
    }
  };

  const runFromStage = () => {
    if (!useAppStore.getState().geometry) {
      addToast({
        title: '尚无几何',
        detail: '先通过 ATLAS 生成 NVIDIA USD BRep 几何。',
        tone: 'neutral',
      });
      if (useAppStore.getState().leftCollapsed) useAppStore.getState().toggleLeft();
      return;
    }
    void runStudy({ focusResult: true, silentToast: false });
  };

  const refine = () => {
    void runStudy({ refinement: true, focusResult: false, silentToast: false });
  };

  const exportModel = async () => {
    const state = useAppStore.getState();
    if (!state.geometry) {
      addToast({ title: '无几何可导出', detail: '请等待参数化重建完成。', tone: 'warning' });
      return;
    }
    const { downloadBinary } = await import('./core/report/report');
    const buffer = await exportBinaryStl(state.geometry);
    downloadBinary(`VISION_${state.model.code}_${state.geometry.watermark}.stl`, buffer, 'model/stl');
    addToast({ title: 'STL 已导出', detail: `${state.geometry.triangleCount.toLocaleString('en-US')} triangles · watertight`, tone: 'success' });
  };

  const exportReport = async () => {
    let result = getCurrentAnalysis();
    if (!result) {
      result = await runStudy({ focusResult: false, silentToast: true });
    }
    if (!result) {
      addToast({ title: '无法生成报告', detail: '需要有效的求解结果。', tone: 'error' });
      return;
    }
    const { exportReportFile } = await import('./core/report/report');
    const state = useAppStore.getState();
    exportReportFile(state.model, result, state.validation);
    addToast({
      title: '工程报告已生成',
      detail: `${state.model.code} · SF ${fmt(result.safetyFactor, 2)} · ${result.mesh.elements.toLocaleString('en-US')} EL`,
      tone: 'success',
    });
  };

  const reset = () => {
    if (!window.confirm('重置当前工程为空白工程？当前未导出的编辑和结果将丢失。')) return;
    useAppStore.getState().resetProject();
    resetDeepSeekConversation();
    window.setTimeout(() => {
      void useAppStore.getState().rebuildGeometry();
    }, 50);
  };

  return (
    <div className="app-shell">
      <TopBar
        onRunAnalysis={() => {
          if (!useAppStore.getState().geometry) {
            addToast({
              title: '空白工程：先添加基础体',
              detail: '请先通过 ATLAS 生成 USD BRep 几何，再运行静力校核。',
              tone: 'neutral',
            });
            if (useAppStore.getState().leftCollapsed) useAppStore.getState().toggleLeft();
            return;
          }
          useAppStore.getState().openWorkspace('analysis');
          void runStudy({ openWorkspace: true, focusResult: true, silentToast: false });
        }}
        onOpenAnalysis={openAnalysis}
        onExportModel={() => void exportModel()}
        onExportReport={() => void exportReport()}
        onReset={reset}
        onOpenLlmSettings={() => useLlmStore.getState().openSettings()}
        onOpenProjects={() => {
          useAppStore.getState().syncProject();
          setProjectCenterOpen(true);
        }}
      />
      <div className="app-body">
        <ToolRail />
        {!leftCollapsed && <ModelPanel />}
        <ViewportStage onRun={runFromStage} />
        <CopilotPanel onSend={(prompt) => void sendAgentPrompt(prompt)} />
      </div>
      <Toasts />

      {activeWorkspace === 'analysis' && (
        <Suspense fallback={<WorkspaceSkeleton />}>
          <AnalysisWorkspace
            onClose={() => useAppStore.getState().openWorkspace(null)}
            onRun={() => void runStudy({ focusResult: false, silentToast: false })}
            onRefine={refine}
            onExport={() => void exportReport()}
          />
        </Suspense>
      )}

      {settingsOpen && <LlmSettingsModal onClose={closeLlmSettings} />}
      {projectCenterOpen && <ProjectCenterModal onClose={() => setProjectCenterOpen(false)} />}
    </div>
  );
}
