import { useInspectionStore, inspectionContext } from '../state/inspectionStore';
import { useLlmStore } from '../state/llmStore';
import { measurementValue } from '../core/cad/measurementLabels';

const confidenceNames = { geometry_evidence: '几何证据', functional_inference: '用途推测', uncertain: '尚不确定' };
export function SelectionInsight({ compact = false }: { compact?: boolean }) {
  const { context, selection, smart, section, analysis, analysisStatus, analysisError, focus, setFocus, analyze, busy } = useInspectionStore();
  if (!smart || !selection.length || section || context !== inspectionContext()) return null;
  const working = analysisStatus === 'planning' || analysisStatus === 'measuring';
  return <section className={`selection-insight ${compact ? 'selection-insight--compact' : ''}`} aria-label={compact ? '视口智能识别' : '智能几何解读'}>
    <div className="selection-insight__head"><b>{analysis?.feature.name ?? '智能几何解读'}</b>
      {analysis && <span className="selection-insight__certainty">{confidenceNames[analysis.feature.confidence]}</span>}
    </div>
    {!compact && <label>当前关注点（可选）<input className="input" maxLength={1000} value={focus} placeholder="例如：用于轴承配合，关注孔的配合尺寸" onChange={event => setFocus(event.target.value)} /></label>}
    {working && <p role="status">{analysisStatus === 'planning' ? '正在结合相邻拓扑与设计上下文识别关注参数…' : '正在由几何内核计算所需参数…'}</p>}
    {analysisError && <p role="alert" className="selection-insight__error">{analysisError}</p>}
    {!working && <div className="selection-insight__actions">
      <button type="button" disabled={busy} onClick={() => void analyze()}>{analysis ? '重新分析' : '分析所选几何'}</button>
      {analysisError && <button type="button" onClick={() => useLlmStore.getState().openSettings()}>模型设置</button>}
    </div>}
    {analysis && <>
      {compact ? <>
        <dl>{analysis.properties.filter(property => property.annotation !== 'detail').map((property, i) => <div key={property.id ?? i}><dt>{property.label}</dt><dd>{measurementValue(property, true)}</dd></div>)}</dl>
        <details><summary>全部参数与识别依据</summary><p>{analysis.feature.explanation}</p>
        {analysis.properties.map((property, i) => <p key={property.id ?? i}><b>{property.label}：{measurementValue(property)}</b><br />{property.reason}<br />原生量：{property.nativeLabel}</p>)}
        {analysis.considerations.map((item, i) => <p key={i}>{item.name} · {item.status === 'needs_context' ? '待补充依据' : '暂不支持测量'}：{item.requiredData}</p>)}
      </details></> : <>
        <p>{analysis.feature.explanation}</p>
        <div className="selection-insight__parameters">{analysis.properties.map((property, i) => <article key={property.id ?? i}>
          <div><b>{property.label}</b><strong>{measurementValue(property)}</strong></div>
          <p>{property.reason}</p><small>原生量：{property.nativeLabel} · {property.method ?? '原生 B-Rep 查询'}</small>
        </article>)}</div>
        {analysis.considerations.length > 0 && <div className="selection-insight__pending"><b>还需要考虑</b>
          {analysis.considerations.map((item, i) => <article key={i}><b>{item.name} <span>{item.status === 'needs_context' ? '待补充依据' : '暂不支持测量'}</span></b><p>{item.reason}</p><p>{item.requiredData}</p></article>)}
        </div>}
        <details><summary>识别来源</summary><p>{analysis.model} · {analysis.feature.evidenceIds.join('、') || '依据当前模型上下文'}</p><p>参数由 LLM 选择；数值由原生几何内核查询。用途推测不代表设计要求已确认。</p></details>
      </>}
    </>}
  </section>;
}
