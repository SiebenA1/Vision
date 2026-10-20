import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

await mkdir('screenshots', { recursive: true });
process.env.VISION_ENGINEERING_URL = 'http://127.0.0.1:8117';
const backend = spawn('.python313/python.exe', ['-u', 'server/engineering_server.py'], { env: { ...process.env, VISION_ENGINEERING_PORT: '8117' }, windowsHide: true });
let diagnostics = '', server, browser, page;
backend.stderr.on('data', chunk => { diagnostics += chunk; });
backend.stdout.on('data', chunk => { diagnostics += chunk; });
backend.on('error', error => { diagnostics += error.message; });
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const health = await (await fetch('http://127.0.0.1:8117/health')).json(); ready = health.ok; if (ready) break; diagnostics += JSON.stringify(health); } catch (e) { if (i === 59) diagnostics += String(e); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, diagnostics);
  const response = await fetch('http://127.0.0.1:8117/cad/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script: "result={'偏心孔零件':u.boolean_difference(u.create_box((-40,-20,-10),80,40,20),u.create_cylinder((-20,0,-11),6,22))}" }) });
  const cad = await response.json(); assert.equal(response.status, 200, JSON.stringify(cad));
  server = await createServer({ server: { host: '127.0.0.1', port: 4177, strictPort: true } }); await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4177');
  await page.getByRole('textbox', { name: '工程需求' }).waitFor();
  const adoptionSeq = await page.evaluate(async cad => {
    const { useAppStore } = await import('/src/state/store.ts');
    const { cadArtifactFromResult } = await import('/src/services/engineeringBackend.ts');
    useAppStore.getState().adoptExternalModel({ name: '物理属性验证', script: '', stlBase64: cad.stlBase64, metrics: cad.metrics, cad: cadArtifactFromResult(cad) });
    return useAppStore.getState().buildSeq;
  }, cad);
  await page.waitForFunction(async seq => { const state = (await import('/src/state/store.ts')).useAppStore.getState(); return state.buildSeq > seq && !state.building; }, adoptionSeq);
  // Restoring a persisted project must distinguish an outage from a lost artifact.
  const previewRoute = '**/api/engineering/cad/artifacts/*/preview.stl';
  let connected = false;
  await page.route(previewRoute, route => connected ? route.continue() : route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '计算后端不可用（测试断连）。' }) }));
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/state/store.ts');
    const model = { ...useAppStore.getState().model };
    delete model.externalStlBase64;
    useAppStore.setState({ model, geometry: null });
    await useAppStore.getState().rebuildGeometry();
  });
  await page.locator('.stage-error').getByText('计算后端不可用（测试断连）。', { exact: true }).waitFor();
  assert.equal(await page.getByText('原生制品不可用，请导入工程包或重新执行建模脚本。', { exact: true }).count(), 0);
  // Hold the outage through the application's delayed initialization rebuilds.
  await page.waitForTimeout(500);
  connected = true;
  await page.locator('.stage-error').getByRole('button', { name: '重新载入几何', exact: true }).click();
  await page.locator('.stage-error').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(async () => (await import('/src/state/store.ts')).useAppStore.getState().geometry.triangleCount), cad.metrics.triangles);
  await page.reload();
  await page.waitForFunction(async () => { const s = (await import('/src/state/store.ts')).useAppStore.getState(); return !!s.geometry && !s.geometryError; });
  const hud = page.getByRole('complementary', { name: '模型属性 HUD' });
  await hud.getByText('质量', { exact: true }).waitFor();
  await page.locator('.measurement-callout__card').getByText('包围尺寸 X', { exact: true }).waitFor();
  assert.equal(await hud.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('.measurement-callout__card').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  const layout = await page.evaluate(() => {
    const canvas = document.querySelector('.scene-viewport').getBoundingClientRect();
    const hud = document.querySelector('.measurement-hud').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.measurement-callout__card')].filter(el => getComputedStyle(el).visibility === 'visible').map(el => el.getBoundingClientRect());
    const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return { count: cards.length, inside: cards.every(r => r.left >= canvas.left && r.right <= canvas.right && r.top >= canvas.top && r.bottom <= canvas.bottom), overlapping: cards.some((r, i) => overlap(r, hud) || cards.slice(i + 1).some(other => overlap(r, other))) };
  });
  assert.ok(layout.count >= 3); assert.equal(layout.inside, true); assert.equal(layout.overlapping, false);
  await page.screenshot({ path: 'screenshots/measurement-hud.png' });
  const controls = page.getByRole('complementary', { name: '测量操作', exact: true });
  assert.equal(await controls.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await controls.getByText('更多', { exact: true }).click();
  const panel = page.getByRole('region', { name: '测量与物理属性' });
  await panel.getByText('质量中心 XYZ', { exact: true }).waitFor();
  // Body measurements must remain visible with smart mode enabled, even if
  // interpretation is unavailable. Never send this fixture to an external LLM.
  await page.route('**/api/deepseek/chat/completions', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'fixture: interpretation unavailable' } }) }));
  await controls.getByRole('button', { name: '体', exact: true }).click();
  await page.locator('.scene-canvas').first().click();
  await hud.getByText('实体体积', { exact: true }).waitFor();
  await hud.getByText('表面积', { exact: true }).waitFor();
  await hud.getByText('轴对齐包围尺寸 XYZ', { exact: true }).waitFor();
  assert.equal(await hud.getByRole('tab', { name: '所选体参数', exact: true }).getAttribute('aria-selected'), 'true');
  const bodyMeasurement = await page.evaluate(async () => {
    const state = (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState();
    return { smart: state.smart, selection: state.selection, properties: state.result.properties };
  });
  assert.equal(bodyMeasurement.smart, true);
  assert.deepEqual(bodyMeasurement.selection, [cad.bodies[0].id]);
  assert.ok(bodyMeasurement.properties.find(property => property.label === '质量').value > 0);
  await page.screenshot({ path: 'screenshots/measurement-body.png' });
  await controls.getByLabel('智能识别参数', { exact: true }).uncheck();
  await controls.getByRole('button', { name: '面', exact: true }).click();
  assert.equal(await panel.locator('option').filter({ hasText: 'face' }).count(), cad.bodies[0].faces.length);
  const canvas = page.locator('.scene-canvas').first();
  await canvas.click();
  await panel.getByText('所选面面积', { exact: true }).waitFor();
  let selected = await page.evaluate(async () => (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState().result.selection);
  assert.equal(selected.length, 1); assert.match(selected[0], /\/face-/);
    await hud.getByRole('tab', { name: '整体物性' }).click();
  await hud.getByText('质量', { exact: true }).waitFor();
  await page.locator('.measurement-callout__card').getByText('所选面面积', { exact: true }).waitFor();
  const labelBefore = await page.locator('.measurement-callout').first().getAttribute('style');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .6, box.y + box.height * .55, { steps: 8 }); await page.mouse.up();
  assert.deepEqual(await page.evaluate(async () => (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState().selection), selected);
  await page.waitForFunction(before => document.querySelector('.measurement-callout')?.getAttribute('style') !== before, labelBefore);
  await page.screenshot({ path: 'screenshots/measurement-face-labels.png' });
  await page.getByRole('complementary', { name: '工程面板' }).getByRole('button', { name: '模型', exact: true }).click();
  assert.deepEqual(await page.evaluate(async () => (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState().selection), selected);
  await page.getByRole('complementary', { name: '工程面板' }).getByRole('button', { name: '模型', exact: true }).click();
  await page.getByText('视图设置', { exact: true }).click();
  await page.getByLabel('显示几何参数标注', { exact: true }).uncheck();
  assert.equal(await page.locator('.measurement-callout').count(), 0);
  assert.ok(await hud.isVisible());
  await page.getByLabel('显示属性 HUD', { exact: true }).uncheck();
  assert.equal(await hud.count(), 0);
  assert.equal(await controls.count(), 1);
  await page.getByLabel('显示几何参数标注', { exact: true }).check();
  await page.getByLabel('显示属性 HUD', { exact: true }).check();
  await page.getByText('视图设置', { exact: true }).click();
  await panel.getByText('对象列表与筛选', { exact: true }).click();
  const objectList = panel.getByLabel('原生对象', { exact: false });
  await objectList.selectOption(cad.bodies[0].faces.slice(0, 2).map(face => face.id));
  await page.waitForFunction(async () => { const s = (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState(); return !s.busy && s.result?.selection.length === 2; });
  await controls.getByRole('button', { name: '边', exact: true }).click();
  await objectList.selectOption(cad.bodies[0].edges[0].id);
  await panel.getByText('所选边总长', { exact: true }).waitFor();
  await controls.getByRole('button', { name: '点', exact: true }).click();
  await objectList.selectOption(['body-0/vertex-0', 'body-0/vertex-1']);
  await panel.getByText('最短距离（至原生边界）', { exact: true }).waitFor();
  await controls.getByRole('button', { name: '整体', exact: true }).click();
  await panel.getByText('质量中心 XYZ', { exact: true }).waitFor();
  await panel.getByText('截面与局部质量', { exact: true }).click();
  await panel.getByRole('button', { name: '计算截面与保留区域' }).click();
  await panel.getByText('截面积', { exact: true }).waitFor();
  const properties = await page.evaluate(async () => (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState().result.properties);
  assert.ok(Math.abs(properties.find(p => p.label === '截面积').value - (80 * 40 - Math.PI * 36)) < .1);
  await panel.getByText('截面与局部质量', { exact: true }).click();
  await panel.getByText('对象列表与筛选', { exact: true }).click();
  await panel.evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: 'screenshots/measurement-panel.png' });
  await page.evaluate(async () => { const { useAppStore } = await import('/src/state/store.ts'); useAppStore.getState().setMaterial('STEEL-4340'); });
  await page.waitForFunction(async () => { const s = (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState(); return !s.busy && s.selection.length === 0 && s.result !== null; });
  await hud.getByText('ρ 7850 kg/m³ · 均匀材料', { exact: true }).waitFor();
  for (const width of [1440, 1024, 600]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  console.log('PASS saved project recovery; transparent HUD + native geometry labels follow orbit; independent display toggles; pick / multi-select / section / material invalidation; no page errors or horizontal overflow');
} catch (error) {
  console.error(diagnostics.slice(-3000));
  if (page) {
    await page.screenshot({ path: 'screenshots/measurement-failure.png' });
    console.error(await page.evaluate(async () => ({ text: document.body.innerText.slice(0, 5000), inspection: (await import('/src/state/inspectionStore.ts')).useInspectionStore.getState() })));
  }
  throw error;
}
finally { if (browser) await browser.close(); if (server) await server.close(); backend.kill(); }
