import { useState } from 'react';
import { coreCommand, coreRequest, importCoreBundle, type CoreRevision, type CoreStudy } from './api';
import { MATERIALS } from '../../core/materials';
import type { ModelDocument } from '../../core/types';

/** File operations belong to project management, independent of modeling tools. */
export function ProjectImport({ busy, workspaceEmpty, run, onImported }: { busy: boolean; workspaceEmpty: boolean; run: (action: () => Promise<void>) => Promise<void>; onImported: (revision: CoreRevision) => Promise<void> }) {
  const [legacy, setLegacy] = useState<{ model: ModelDocument; available: boolean; issue: string | null } | null>(null);
  const [activateStudy, setActivateStudy] = useState(false);
  return <details className="project-import"><summary>导入与备份恢复</summary>
    <p>完整 ZIP 备份恢复需要空工作区；旧版 JSON 可迁移为新工程，不执行其中的脚本。</p>
    <label>工程文件<input type="file" accept=".zip,.json" disabled={busy} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      void run(async () => {
        setLegacy(null); setActivateStudy(false);
        if (file.name.toLowerCase().endsWith('.zip')) {
          if (!workspaceEmpty) throw new Error('完整备份恢复需要空工作区，现有工程不会被覆盖。');
          await onImported(await importCoreBundle(file)); return;
        }
        if (file.size > 32 * 1024 * 1024) throw new Error('旧工程文件不能超过 32 MiB');
        const model = JSON.parse(await file.text()) as ModelDocument;
        const preview = await coreRequest<{ legacy_artifact_available: boolean; geometry_issue: string | null }>('/imports/preview', { legacy_model: model });
        setLegacy({ model, available: preview.legacy_artifact_available, issue: preview.geometry_issue });
      });
    }} /></label>
    {legacy && <div className="project-import-preview"><h3>{legacy.model.name}</h3><p>{legacy.available ? '原生几何完整性已核对' : legacy.issue}</p>
      <label><input type="checkbox" checked={activateStudy} disabled={busy} onChange={event => setActivateStudy(event.target.checked)} />启用已核对的旧工况</label>
      <button disabled={busy || !legacy.available} onClick={() => void run(async () => {
        let study: CoreStudy | undefined;
        if (activateStudy) {
          const material = MATERIALS.find(item => item.id === legacy.model.materialId);
          if (!material || !legacy.model.mesh.cellSizeMm) throw new Error('旧材料或网格参数不完整，请先迁移几何，再配置工况。');
          study = { material: { E: material.E, nu: material.nu, rho: material.rho, yieldStrength: material.yieldStrength },
            supports: legacy.model.supports.map(({ id, name, face, type, enabled, region }) => ({ id, name, face, type, enabled, region })),
            loads: legacy.model.loads.map(({ id, name, face, vector, magnitude, enabled, region }) => ({ id, name, face, vector, magnitude, enabled, region })),
            body_ids: legacy.model.studyBodyIds, mesh_size: legacy.model.mesh.cellSizeMm };
        }
        await onImported(await coreRequest<CoreRevision>('/imports/legacy', { ...coreCommand(), legacy_model: legacy.model, ...(study ? { study } : {}) }));
      })}>迁移为新工程</button>
    </div>}
  </details>;
}
