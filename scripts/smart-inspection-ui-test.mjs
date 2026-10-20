import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

const live = process.env.VISION_TEST_LIVE_LLM === '1';
process.env.VISION_ENGINEERING_URL = 'http://127.0.0.1:8118';
await mkdir('server/.agent_memory', { recursive: true });
const memoryDirectory = await mkdtemp(path.resolve('server/.agent_memory/inspection-test-'));
const backend = spawn('.python313/python.exe', ['-u', 'server/engineering_server.py'], { env: { ...process.env, VISION_ENGINEERING_PORT: '8118', VISION_MEMORY_DB: path.join(memoryDirectory, 'memory.sqlite3') }, windowsHide: true });
let logs = '', server, browser, page;
backend.stderr.on('data', chunk => { logs += chunk; });
backend.on('error', error => { logs += error.message; });
const script = "result={'housing':u.boolean_difference(u.create_box((-40,-20,-10),80,40,20),u.create_cylinder((-20,0,-11),6,22))}";
const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:8118${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await r.json(); assert.equal(r.status, 200, JSON.stringify(value)); return value;
};
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await (await fetch('http://127.0.0.1:8118/health')).json()).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const cad = await post('/cad/execute', { script });
  const probe = await post('/cad/inspect', { artifactId: cad.artifactId, selection: cad.bodies[0].faces.map(f => f.id) });
  const cylinder = probe.selectionContext.selected.find(f => f.cylinderEvidence?.radialOrientation === 'inward');
  const plane = probe.selectionContext.selected.find(f => f.planar && f.boundaryLoops.length === 2 && f.outwardNormalAtInterior[2] > .9);
  assert.ok(cylinder); assert.ok(plane);
  server = await createServer({ server: { host: '127.0.0.1', port: 4178, strictPort: true } }); await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.setDefaultTimeout(15000);
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  const prompts = [], requested = [];
  page.on('request', r => { if (r.url().endsWith('/cad/inspect')) { const b = r.postDataJSON(); if (b?.metricIds) requested.push(b.metricIds); } });
  if (!live) {
    await page.route('**/api/llm/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ hasServerKey: true, provider: 'deepseek' }) }));
    await page.route('**/api/deepseek/chat/completions', route => {
      const request = route.request().postDataJSON();
      const context = JSON.parse(request.messages.at(-1).content); prompts.push(context);
      assert.ok(context.geometry.related.length); assert.ok(context.model.bodyNames.includes('housing'));
      assert.equal(context.model.sourceScript, undefined);
      const selected = context.geometry.selected[0];
      const parameters = selected.cylinderEvidence
        ? [{ metricId: `${selected.id}:diameter`, label: '孔壁直径', reason: '内凹圆柱面直径是配合界面的主要几何量' }, { metricId: `${selected.id}:axial_span`, label: '孔壁轴向范围', reason: '此值为所选壁面长度，不冒充盲孔深度' }]
        : [{ metricId: `${selected.id}:area`, label: '带孔面的有效面积', reason: '排除裁剪孔洞后的实际面面积' }, { metricId: context.availableMetrics.find(m => m.id.endsWith(':diameter') && m.targetId.includes('/edge-')).id, label: '孔口圆边直径', reason: '关注选中平面的开口边界尺寸' }];
      const value = { feature: { name: selected.cylinderEvidence ? '内凹圆柱孔壁' : '带孔平面接口', confidence: selected.cylinderEvidence ? 'geometry_evidence' : 'functional_inference', explanation: '结合原生边界、相邻拓扑与关注点识别，安装或配合用途仍是推测。', evidenceIds: [selected.id] },
        parameters: parameters.map(p => ({ ...p, value: 999999, unit: 'm', anchor: [999999, 999999, 999999] })),
        considerations: [{ name: '配合公差', reason: '几何本身未定义设计公差', requiredData: '需要配合零件尺寸及公差要求', status: 'needs_context' }] };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ model: 'inspection-test-fixture', choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) });
    });
  }
  await page.goto('http://127.0.0.1:4178');
  await page.getByRole('textbox', { name: '工程需求' }).waitFor();
  await page.evaluate(async ({ cad, script }) => {
    const { useAppStore } = await import('/src/state/store.ts');
    const { cadArtifactFromResult } = await import('/src/services/engineeringBackend.ts');
    const { useInspectionStore } = await import('/src/state/inspectionStore.ts');
    window.__inspectionTestStore = useInspectionStore;
    useAppStore.getState().adoptExternalModel({ name: '智能测量验证', script, stlBase64: cad.stlBase64, metrics: cad.metrics, cad: cadArtifactFromResult(cad) });
  }, { cad, script });
  await page.getByRole('button', { name: '测量', exact: true }).click();
  const panel = page.getByRole('region', { name: '测量与物理属性' });
  await page.waitForFunction(() => !!window.__inspectionTestStore.getState().summary);
  await panel.getByRole('button', { name: '面', exact: true }).click();
  await panel.getByText('对象列表与筛选', { exact: true }).click();
  const objects = panel.getByLabel('原生对象', { exact: false });
  async function selectAndAnalyze(id) {
    await objects.selectOption(id);
    await page.waitForFunction(selectedId => { const state = window.__inspectionTestStore.getState(); return state.result?.selection[0] === selectedId && ['ready', 'error'].includes(state.analysisStatus); }, id, { timeout: 65000 });
    const state = await page.evaluate(async () => { const s = (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState(); return { analysis: s.analysis, error: s.analysisError || s.error, status: s.analysisStatus, selection: s.selection, busy: s.busy }; });
    assert.equal(state.status, 'ready', state.error);
    assert.ok(state.analysis.properties.length || state.analysis.considerations.length);
    assert.ok(state.analysis.properties.every(p => p.value !== 999999 && p.unit !== 'm'));
    return state.analysis;
  }
  const holeAnalysis = await selectAndAnalyze(cylinder.id);
  assert.ok(holeAnalysis.properties.some(p => p.id === `${cylinder.id}:diameter` || p.id === `${cylinder.id}:radius`), JSON.stringify(holeAnalysis));
  for (const p of holeAnalysis.properties) {
    if (p.id === `${cylinder.id}:diameter`) assert.ok(Math.abs(p.value - 12) < 1e-6);
    if (p.id === `${cylinder.id}:axial_span`) assert.ok(Math.abs(p.value - 20) < 1e-6);
  }
  assert.ok(requested.length);
  const hud = page.getByRole('complementary', { name: '模型属性 HUD' });
  await hud.getByText('对象类型：面', { exact: false }).waitFor();
  assert.equal(await hud.getByRole('tab', { name: '所选几何' }).getAttribute('aria-selected'), 'true');
  await hud.getByRole('tab', { name: '整体物性' }).click();
  await hud.getByText('物性范围：整个模型', { exact: false }).waitFor();
  assert.ok(await hud.getByText('闭合实体', { exact: true }).count());
  await hud.getByRole('tab', { name: '所选几何' }).click();
  assert.ok(await page.locator('.measurement-callout').count() <= 3);
  await mkdir('screenshots', { recursive: true });
  await panel.getByRole('region', { name: '智能几何解读' }).evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `screenshots/smart-cylinder-${live ? 'live' : 'fixture'}.png` });
  const planeAnalysis = await selectAndAnalyze(plane.id);
  assert.notDeepEqual(planeAnalysis.parameters.map(p => p.metricId), holeAnalysis.parameters.map(p => p.metricId));
  await panel.getByRole('region', { name: '智能几何解读' }).evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `screenshots/smart-plane-${live ? 'live' : 'fixture'}.png` });
  if (!live) assert.equal(prompts.length, 2);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ mode: live ? 'LIVE DEEPSEEK + NATIVE KERNEL' : 'LLM FIXTURE + REAL NATIVE KERNEL', hole: { feature: holeAnalysis.feature.name, metrics: holeAnalysis.parameters.map(p => p.metricId) }, plane: { feature: planeAnalysis.feature.name, metrics: planeAnalysis.parameters.map(p => p.metricId) }, nativeQueries: requested.length }));
} catch (error) {
  console.error(logs.slice(-2200));
  if (page) { await mkdir('screenshots', { recursive: true }); await page.screenshot({ path: 'screenshots/smart-inspection-failure.png' }); }
  throw error;
} finally {
  if (browser) await browser.close(); if (server) await server.close();
  if (backend.exitCode === null) { const exited = new Promise(resolve => backend.once('exit', resolve)); backend.kill(); await exited; }
  await rm(memoryDirectory, { recursive: true, force: true });
}
