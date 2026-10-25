import { useEffect, useState } from 'react';
import { Calculator, CheckCircle2, Download, FlaskConical, Play, Square } from 'lucide-react';
import { coreCommand, coreRequest } from './api';

interface CheckCase {
  id: string; mesh_mm: number; elements: number; dofs: number; algorithm: string;
  reference_mm: number; computed_mm: number; max_displacement_mm: number; relative_error: number;
  relative_residual: number; equilibrium_error: number; tolerance: number; passed: boolean; acceptance_case: boolean;
  measurement: string; mass_kg: number; strain_energy_mj: number; reaction_n: number[];
}
interface CheckReport {
  passed: boolean; cases: CheckCase[]; scope: string; limitations: string[]; finished_at: string;
  profile: { files: Record<string, string>; packages: Record<string, string> };
  same_grid: { passed: boolean; mesh_sha256: string; relative_displacement_difference: number; relative_stress_difference: number; relative_energy_difference: number; cg_residual: number };
}
interface CheckRun { id: string; suite: string; state: string; current_runtime: boolean; created: number; error: string | null; phase: string | null; result?: CheckReport | null; passed?: boolean | null }
interface Reference { displacement_mm: number; stress_mpa: number; mass_kg: number; strain_energy_mj: number; formula: string; meaning: string; warnings: string[] }
const stateLabels: Record<string, string> = { queued: '排队中', running: '正在校核', cancelling: '正在停止', succeeded: '已完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断', timed_out: '执行超时' };
const active = (run: CheckRun) => ['queued', 'running', 'cancelling'].includes(run.state);
const caseName = (id: string) => id === 'axial-patch' ? '均匀应变补片' : id.startsWith('bending') ? '悬臂梁弯曲' : '轴向拉伸';
const format = (value: number) => Number.isFinite(value) ? value.toPrecision(5) : '—';
const inputFields = { length_mm: '梁长 L / mm', width_mm: '宽度 b / mm', height_mm: '高度 h / mm', elastic_modulus_mpa: '弹性模量 E / MPa', force_n: '端部合力 F / N', density_kg_m3: '密度 / kg/m³' };

export function VerificationPanel() {
  const [runs, setRuns] = useState<CheckRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState('');
  const [run, setRun] = useState<CheckRun | null>(null);
  const [suite, setSuite] = useState('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inputs, setInputs] = useState({ kind: 'cantilever', length_mm: 100, width_mm: 20, height_mm: 10, elastic_modulus_mpa: 210000, force_n: 100, density_kg_m3: 7850 });
  const [reference, setReference] = useState<Reference | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [calcError, setCalcError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const refresh = async () => {
      try {
        const list = await coreRequest<CheckRun[]>('/solver-checks', undefined, abort.signal);
        const id = selected || list[0]?.id;
        const detail = id ? await coreRequest<CheckRun>(`/solver-checks/${id}`, undefined, abort.signal) : null;
        if (!stopped) { setRuns(list); setRun(detail); setError(''); }
      } catch (failure) { if (!stopped) setError(String(failure)); }
      if (!stopped) setLoaded(true);
      if (!stopped) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [selected]);
  const action = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); }
  };
  const report = run?.result;
  return <div className="verification-page">
    <header className="analysis-heading"><Calculator size={21} /><div><h1>解析与数值校核</h1><p>独立理论参考 · 当前求解器基准 · 可追溯的验证记录</p></div></header>
    <section className="analysis-card">
      <div className="analysis-card-title"><Calculator size={16} /><h2>矩形梁理论参考</h2><span>mm · N · MPa · kg</span></div>
      <p>示例参数独立于当前工程。X 为梁轴、Y 为宽、Z 为高；悬臂梁沿 Z 加载，全固定于 X 最小端。</p>
      <form onSubmit={event => { event.preventDefault(); setCalculating(true); setCalcError(''); setReference(null); void coreRequest<Reference>('/calculations/beam', inputs).then(setReference).catch(failure => setCalcError(String(failure))).finally(() => setCalculating(false)); }}>
        <div className="analysis-inputs"><label>计算类型<select disabled={calculating} value={inputs.kind} onChange={event => { setInputs({ ...inputs, kind: event.target.value }); setReference(null); }}><option value="cantilever">悬臂梁端部弯曲</option><option value="axial">直杆轴向拉伸</option></select></label>
          {Object.entries(inputFields).map(([key, label]) => <label key={key}>{label}<input disabled={calculating} type="number" required min="0.001" step="any" value={inputs[key as keyof typeof inputFields]} onChange={event => { setInputs({ ...inputs, [key]: Number(event.target.value) }); setReference(null); }} /></label>)}
        </div><button className="core-primary" disabled={calculating} type="submit"><Calculator size={14} />{calculating ? '计算中' : '计算理论参考'}</button>
      </form>
      {calcError && <p className="core-error" role="alert">{calcError}</p>}
      {reference && <div className="reference-result" aria-label="理论计算结果"><code>{reference.formula}</code><dl><div><dt>参考位移 / mm</dt><dd>{format(reference.displacement_mm)}</dd></div><div><dt>名义正应力 / MPa</dt><dd>{format(reference.stress_mpa)}</dd></div><div><dt>质量 / kg</dt><dd>{format(reference.mass_kg)}</dd></div><div><dt>应变能 / mJ</dt><dd>{format(reference.strain_energy_mj)}</dd></div></dl>{reference.warnings.map(warning => <p className="study-warning" key={warning}>{warning}</p>)}<small>{reference.meaning}</small></div>}
    </section>
    <section className="analysis-card">
      <div className="analysis-card-title"><FlaskConical size={16} /><h2>求解器验证</h2><span>本机持久记录</span></div>
      <p>调用实际生产求解器，验证轴向解析解、仿射位移补片、弯曲网格细化，以及同一网格的 Direct / CG 一致性。校核串行执行，不更改工程模型或工况。</p>
      <div className="analysis-actions"><label>验证范围<select value={suite} onChange={event => setSuite(event.target.value)}><option value="standard">标准 · 解析 / 补片 / 弯曲细化 / 同网格</option><option value="extended">扩展 · 增加自动 CG 与更细弯曲网格</option></select></label>
        <button className="core-primary" disabled={!loaded || busy || runs.some(active)} onClick={() => void action(async () => { const next = await coreRequest<{ run_id: string }>('/solver-checks', { ...coreCommand(), suite }); setRuns(previous => [{ id: next.run_id, suite, state: 'queued', current_runtime: true, created: Date.now() / 1000, error: null, phase: null }, ...previous]); setSelected(next.run_id); })}><Play size={14} />运行校核</button>
        {run && active(run) && <button disabled={busy || run.state === 'cancelling'} onClick={() => void action(async () => { await coreRequest(`/solver-checks/${run.id}/cancel`, {}); })}><Square size={13} />停止校核</button>}
      </div>
      {error && <p className="core-error" role="alert">{error}</p>}
      {runs.length > 0 && <label>验证记录<select aria-label="验证记录" value={selected || runs[0]?.id || ''} onChange={event => setSelected(event.target.value)}>{runs.map(item => <option key={item.id} value={item.id}>{new Date(item.created * 1000).toLocaleString()} · {item.suite === 'extended' ? '扩展' : '标准'} · {stateLabels[item.state]}{!item.current_runtime ? ' · 旧实现' : ''}</option>)}</select></label>}
      {run ? <div className="check-run" aria-live="polite"><div className="check-status"><CheckCircle2 size={16} /><strong>{stateLabels[run.state]}{report ? report.passed ? ' · 基准检查通过' : ' · 基准检查未通过' : ''}</strong><small>{run.current_runtime ? '对应当前实现' : '实现已变化，请重新校核'}</small></div>{active(run) && <p>{run.phase || '等待本机计算队列。关闭页面后校核仍会继续。'}</p>}{run.error && <p className="core-error">{run.error}</p>}</div> : <p className="analysis-empty">{loaded ? '尚无验证记录。运行一次校核以确认当前安装环境与求解实现。' : '正在读取验证记录…'}</p>}
      {report && <>
        <p>{report.scope}</p>
        <div className="check-table-wrap"><table className="check-table"><thead><tr><th>算例 / 网格</th><th>单元 / 方法</th><th>参考 / 计算 mm</th><th>位移误差</th><th>残差 / 平衡误差</th><th>判定</th></tr></thead><tbody>{report.cases.map(item => <tr key={item.id}><td>{caseName(item.id)}<small>h = {item.mesh_mm} mm</small></td><td>{item.elements.toLocaleString()}<small>{item.algorithm} · {item.dofs.toLocaleString()} DOF</small></td><td>{format(item.reference_mm)}<small>{format(item.computed_mm)}</small></td><td>{(item.relative_error * 100).toFixed(3)}%<small>阈值 {(item.tolerance * 100).toPrecision(2)}%</small></td><td>{item.relative_residual.toExponential(2)}<small>{item.equilibrium_error.toExponential(2)}</small></td><td className={item.passed ? '' : 'study-warning'}>{item.passed ? '通过' : item.acceptance_case ? '未通过' : '粗网格偏差'}<small>{item.acceptance_case ? '验收项' : '诊断项'}</small></td></tr>)}</tbody></table></div>
        <p className="study-warning">表中比较自由端面按面积加权的平均位移分量，不等同于模型最大位移。粗网格诊断项保留真实偏差，不计入合格项；基准通过不能证明当前零件满足设计要求。</p>
        <details><summary>同网格对照与复现信息</summary><p>Direct / CG 位移相对差：{report.same_grid.relative_displacement_difference.toExponential(3)}；应力：{report.same_grid.relative_stress_difference.toExponential(3)}；应变能：{report.same_grid.relative_energy_difference.toExponential(3)}。</p><p>归档网格 SHA256：<code>{report.same_grid.mesh_sha256}</code></p><p>{Object.entries(report.profile.packages).map(([name, version]) => `${name} ${version}`).join(' · ')}</p><p>完成于 {new Date(report.finished_at).toLocaleString()}</p><pre>{JSON.stringify(report.profile.files, null, 2)}</pre></details>
        <ul className="check-limitations">{report.limitations.map(item => <li key={item}>{item}</li>)}</ul>
        <button onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `solver-check-${run!.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={14} />下载校核记录</button>
      </>}
    </section>
  </div>;
}
