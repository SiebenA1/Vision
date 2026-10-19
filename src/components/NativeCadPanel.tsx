import { useState } from 'react';
import { useAppStore } from '../state/store';
import { getMaterial } from '../core/materials';
import { executeNvidiaBrep, importNativeCad, cadArtifactFromResult, cadArtifactUrl, queryCadApi } from '../services/engineeringBackend';
import type { CadApiEntry, CadExecutionResult } from '../services/engineeringBackend';

export function NativeCadPanel() {
  const model = useAppStore((state) => state.model);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<CadApiEntry[]>([]);
  const [apiError, setApiError] = useState('');
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [script, setScript] = useState(model.externalScript ?? '');
  const [parameters, setParameters] = useState(model.cad?.parameters ?? {});
  const [tolerance, setTolerance] = useState(model.cad?.settings.tolerance_mm ?? 0.05);
  const [heal, setHeal] = useState(false);
  const cad = model.cad;
  const commit = (result: CadExecutionResult, source: typeof model, sourceArtifact?: string, sourceScript = '') => {
    const state = useAppStore.getState();
    if (state.model !== source) throw new Error('构建期间工程已变更，本次结果未写入');
    state.adoptExternalModel({ name: source.name, code: source.code, script: sourceScript,
      stlBase64: result.stlBase64, metrics: result.metrics, materialId: source.materialId,
      cad: cadArtifactFromResult(result, sourceArtifact) });
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await work(); }
    catch (error) { useAppStore.getState().addToast({ title: '建模未完成', detail: String(error), tone: 'error' }); }
    finally { setBusy(false); }
  };
  return <div className="native-cad-panel">
    <label className="button native-import">导入 USD / 工程包
      <input type="file" accept=".usd,.usda,.usdc,.zip" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        void run(async () => {
          if (file.size > 32 * 1024 * 1024) throw new Error('文件不能超过 32 MB');
          const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
          commit(await importNativeCad(data, file.name.endsWith('.zip') ? 'zip' : 'usd', getMaterial(model.materialId).rho), model);
        });
      }} />
    </label>
    {cad && <>
      <p>{cad.bodies.length} 个体 · USD BRep {cad.kernelVersion}</p>
      <div className="native-exports"><a className="button" href={cadArtifactUrl(cad.artifactId, 'model.usda')} download>导出 USD</a><a className="button" href={cadArtifactUrl(cad.artifactId, 'archive.zip')} download>保存工程包</a></div>
      <details><summary>实体与拓扑</summary>
        {cad.bodies.map((body) => <details key={body.id}><summary>{body.name} · {body.kind === 'solid' ? '实体' : '曲面体'}</summary>
          <p>{body.faces.length} 个面 · {body.edges.length} 条边</p>
          <p>{body.bbox_mm.size.map((v) => v.toFixed(2)).join(' × ')} mm</p>
          <p>{body.kind === 'solid' ? '可选入实体静力分析' : '仅建模与显示；暂不支持壳单元分析'}</p>
          <details><summary>查看面与边编号</summary><ul>{body.faces.map((face) => <li key={face.id}>{face.id} · {face.area_mm2.toFixed(2)} mm²</li>)}{body.edges.map((edge) => <li key={edge.id}>{edge.id} · {edge.length_mm.toFixed(2)} mm</li>)}</ul></details>
        </details>)}
      </details>
    </>}
    <details><summary>参数与建模脚本</summary>
      {Object.entries(parameters).map(([key, value]) => <label key={key}>{key}
        <input className="input" type={typeof value === 'number' ? 'number' : 'text'} value={String(value)} onChange={(event) => setParameters({ ...parameters, [key]: typeof value === 'number' ? Number(event.target.value) : typeof value === 'boolean' ? event.target.value === 'true' : event.target.value })} />
      </label>)}
      <label>曲面离散精度（mm）<input className="input" type="number" min={0.00001} max={10} step={0.01} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label>
      <label><input type="checkbox" checked={heal} onChange={(event) => setHeal(event.target.checked)} />构建后运行几何修复</label>
      <label>Python 脚本<textarea className="input cad-script" rows={12} value={script} onChange={(event) => setScript(event.target.value)} spellCheck={false} /></label>
      <p>脚本可返回命名实体字典。参数通过 parameters 读取；已导入的源几何通过 parts 访问。</p>
      <button className="button" type="button" disabled={busy || (!script.trim() && !cad)} onClick={() => void run(async () => {
        const sourceArtifact = cad?.sourceArtifact ?? (!script.trim() ? cad?.artifactId : undefined);
        const result = await executeNvidiaBrep(script, getMaterial(model.materialId).rho, undefined, { parameters, tolerance_mm: tolerance, heal }, sourceArtifact);
        commit(result, model, sourceArtifact, script);
      })}>{busy ? '正在构建…' : '应用并重建'}</button>
    </details>
    <details><summary>查询内核接口</summary><form onSubmit={(event) => {
      event.preventDefault(); setApiError('');
      void queryCadApi(query).then((api) => { setEntries(api.entries); setNextOffset(api.nextOffset ?? null); if (!api.entries.length) setApiError('未找到匹配接口'); }).catch((error) => setApiError(String(error)));
    }}><label>函数或分类<input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如 shell_brep、surfaces" /></label><button className="button" type="submit">查询</button></form>
      {nextOffset !== null && <button className="button" type="button" onClick={() => void queryCadApi(query, nextOffset).then((api) => { setEntries([...entries, ...api.entries]); setNextOffset(api.nextOffset ?? null); }).catch((error) => setApiError(String(error)))}>更多接口</button>}
      {apiError && <p role="alert">{apiError}</p>}
      {entries.map((entry) => <details key={entry.symbol}><summary>{entry.symbol}</summary><pre>{entry.documentation}</pre></details>)}
    </details>
  </div>;
}
