import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  FileJson,
  FilePlus,
  FolderKanban,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useAppStore } from '../state/store';
import { getMaterial } from '../core/materials';
import { relativeProjectTime } from '../core/projects';
import { resetDeepSeekConversation } from '../services/deepseekAgent';
import type { ModelDocument } from '../core/types';

interface ProjectCenterModalProps {
  onClose: () => void;
}

function projectTitle(model: ModelDocument): string {
  return `${model.code} · ${model.name}`;
}

export function ProjectCenterModal({ onClose }: ProjectCenterModalProps) {
  const projects = useAppStore((state) => state.projects);
  const activeProjectId = useAppStore((state) => state.activeProjectId);
  const activeModel = useAppStore((state) => state.model);
  const switchProject = useAppStore((state) => state.switchProject);
  const createProject = useAppStore((state) => state.createProject);
  const createBlankProject = useAppStore((state) => state.createBlankProject);
  const duplicateProject = useAppStore((state) => state.duplicateProject);
  const deleteProject = useAppStore((state) => state.deleteProject);
  const renameProject = useAppStore((state) => state.renameProject);
  const importProject = useAppStore((state) => state.importProject);
  const addToast = useAppStore((state) => state.addToast);
  const [selectedId, setSelectedId] = useState(activeProjectId);
  const [nameDraft, setNameDraft] = useState('');
  const [codeDraft, setCodeDraft] = useState('');
  const [newName, setNewName] = useState('未命名支架');
  const [newCode, setNewCode] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = projects.find((project) => project.id === selectedId) ?? projects[0];

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    if (!projects.some((project) => project.id === selectedId)) {
      setSelectedId(projects[0]?.id ?? '');
    }
  }, [projects, selectedId]);

  useEffect(() => {
    if (selected) {
      setNameDraft(selected.model.name);
      setCodeDraft(selected.model.code);
    }
  }, [selected?.id, selected?.model.name, selected?.model.code]);

  const openProject = (id: string) => {
    useAppStore.getState().syncProject();
    switchProject(id);
    resetDeepSeekConversation();
    onClose();
  };

  const handleCreate = () => {
    if (createProject(newName, newCode)) {
      resetDeepSeekConversation();
      onClose();
    }
  };

  const handleCreateBlank = () => {
    if (createBlankProject(newName, newCode)) {
      resetDeepSeekConversation();
      onClose();
    }
  };

  const handleDuplicate = (id: string) => {
    duplicateProject(id);
    resetDeepSeekConversation();
    onClose();
  };

  const handleDelete = (id: string) => {
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    if (!window.confirm(`删除项目 ${project.model.code} · ${project.model.name}？此操作不可撤销。`)) return;
    deleteProject(id);
    resetDeepSeekConversation();
    if (id === activeProjectId) onClose();
  };

  const handleRename = () => {
    if (!selected) return;
    renameProject(selected.id, nameDraft, codeDraft);
    addToast({ title: '项目信息已更新', detail: `${codeDraft.toUpperCase()} · ${nameDraft}`, tone: 'success' });
  };

  const handleExport = () => {
    if (!selected) return;
    void import('../core/report/report').then(({ downloadText }) => {
      downloadText(
        `VISION_${selected.model.code}_${selected.model.revision}.json`,
        JSON.stringify(selected.model, null, 2),
        'application/json;charset=utf-8',
      );
    });
  };

  const handleImport = async (file: File) => {
    setImportError(null);
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as ModelDocument;
      const ok = importProject(parsed);
      if (!ok) {
        setImportError('文件不是有效的 VISION model/1 文档。');
        return;
      }
      resetDeepSeekConversation();
      onClose();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="project-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-center-title">
        <header className="project-modal__head">
          <div className="project-modal__title">
            <span className="project-modal__mark"><FolderKanban size={18} /></span>
            <div>
              <span className="eyebrow">PROJECT LIBRARY / LOCAL WORKSPACE</span>
              <h2 id="project-center-title">工程中心</h2>
            </div>
          </div>
          <div className="project-modal__head-right">
            <span className="chip">{projects.length} PROJECTS</span>
            <button type="button" className="icon-button" onClick={onClose} aria-label="关闭工程中心">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="project-modal__body">
          <section className="project-list-pane">
            <div className="project-pane-head">
              <span className="eyebrow">RECENT PROJECTS</span>
              <span className="project-pane-hint">自动保存到本机</span>
            </div>
            <div className="project-list">
              {projects.map((project) => {
                const isActive = project.id === activeProjectId;
                const isSelected = project.id === selected?.id;
                const material = getMaterial(project.model.materialId);
                return (
                  <button
                    key={project.id}
                    type="button"
                    className={`project-card ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => setSelectedId(project.id)}
                    onDoubleClick={() => openProject(project.id)}
                  >
                    <div className="project-card__top">
                      <span className="project-card__code">{project.model.code}</span>
                      {isActive ? (
                        <span className="chip chip--good chip--tiny"><Check size={9} /> ACTIVE</span>
                      ) : (
                        <span className="project-card__revision">{project.model.revision}</span>
                      )}
                    </div>
                    <b className="project-card__name">{project.model.name}</b>
                    <div className="project-card__meta">
                      <span>{material.shortName}</span>
                      <span>
                        {project.model.template === 'empty'
                          ? '空白'
                          : `${project.model.variables[0]?.value ?? '—'} mm`}
                      </span>
                      <span>{project.model.loads[0]?.magnitude ?? 0} N</span>
                    </div>
                    <div className="project-card__foot">
                      <span><Clock3 size={10} /> {relativeProjectTime(project.updatedAt)}</span>
                      <ChevronRight size={12} />
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="project-import-row">
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="visually-hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleImport(file);
                  event.target.value = '';
                }}
              />
              <button type="button" className="button" onClick={() => fileRef.current?.click()}>
                <Upload size={14} /> 导入 JSON
              </button>
              <button type="button" className="button" onClick={() => openProject(activeProjectId)}>
                <ArrowUpRight size={14} /> 返回当前项目
              </button>
            </div>
            {importError && <div className="project-import-error">{importError}</div>}
          </section>

          <section className="project-detail-pane">
            {selected ? (
              <>
                <div className="project-detail-head">
                  <div>
                    <span className="eyebrow">PROJECT DETAIL</span>
                    <h3>{projectTitle(selected.model)}</h3>
                    <div className="project-detail-tags">
                      <span>{selected.model.revision}</span>
                      <span>{selected.model.meta.discipline}</span>
                      <span>schema {selected.model.schema.split('/')[1]}</span>
                    </div>
                  </div>
                  <span className={`project-detail-status ${selected.id === activeProjectId ? 'is-active' : ''}`}>
                    {selected.id === activeProjectId ? 'OPEN' : 'CLOSED'}
                  </span>
                </div>

                <div className="project-intent">
                  <span className="eyebrow">DESIGN INTENT</span>
                  <p>{selected.model.meta.designIntent}</p>
                  <div>
                    <span>{selected.model.meta.client}</span>
                    <span>{selected.model.meta.analyst}</span>
                  </div>
                </div>

                <div className="project-meta-grid">
                  <div><span>材料</span><b>{getMaterial(selected.model.materialId).shortName}</b></div>
                  <div><span>端载</span><b>{selected.model.loads[0]?.magnitude ?? 0} N</b></div>
                  <div><span>约束</span><b>{selected.model.supports[0]?.face ?? '—'}</b></div>
                  <div><span>网格</span><b>h {selected.model.mesh.cellSizeMm ?? '—'} mm</b></div>
                  <div><span>变量</span><b>{selected.model.variables.length}</b></div>
                  <div><span>更新</span><b>{relativeProjectTime(selected.updatedAt)}</b></div>
                </div>

                <div className="project-rename">
                  <span className="eyebrow">PROJECT INFO</span>
                  <label>
                    <span>名称</span>
                    <input className="input" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} />
                  </label>
                  <label>
                    <span>编号</span>
                    <input className="input" value={codeDraft} onChange={(event) => setCodeDraft(event.target.value)} />
                  </label>
                  <button type="button" className="button" onClick={handleRename}>
                    <Save size={13} /> 保存项目信息
                  </button>
                </div>

                <div className="project-actions">
                  <button type="button" className="button button--primary" onClick={() => openProject(selected.id)}>
                    <Boxes size={14} /> {selected.id === activeProjectId ? '返回当前项目' : '打开该项目'}
                  </button>
                  <button type="button" className="button" onClick={() => handleDuplicate(selected.id)}>
                    <Copy size={14} /> 另存副本
                  </button>
                  <button type="button" className="button" onClick={handleExport}>
                    <Download size={14} /> 导出 JSON
                  </button>
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => handleDelete(selected.id)}
                    disabled={projects.length <= 1}
                  >
                    <Trash2 size={14} /> 删除
                  </button>
                </div>
              </>
            ) : null}

            <div className="project-create">
              <div className="project-create__head">
                <Plus size={15} />
                <div>
                  <span className="eyebrow">NEW PROJECT</span>
                  <b>派生当前项目，或创建空白工程</b>
                </div>
              </div>
              <p>
                派生项目会复制当前特征、材料与边界条件；空白工程不含几何，打开后可在模型面板选择基础板 / 基础块 / 圆柱体。
              </p>
              <div className="project-create__form">
                <input className="input" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="项目名称" />
                <input className="input" value={newCode} onChange={(event) => setNewCode(event.target.value)} placeholder="编号（可空）" />
                <button type="button" className="button button--primary" onClick={handleCreate} disabled={!newName.trim()}>
                  <Plus size={14} /> 派生
                </button>
                <button type="button" className="button" onClick={handleCreateBlank} disabled={!newName.trim()}>
                  <FilePlus size={14} /> 空白工程
                </button>
              </div>
            </div>
          </section>
        </div>

        <footer className="project-modal__footer">
          <span><FileJson size={12} /> 本地项目库 · 自动保存 · schema model/1</span>
          <span className="project-modal__footer-right">双击项目可直接打开</span>
        </footer>
      </div>
    </div>
  );
}
