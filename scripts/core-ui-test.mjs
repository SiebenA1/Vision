// Current desktop workbench against real CAD/FEA in a disposable workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const workspace = await mkdtemp(resolve('tests/tmp-ui-'));
const backend = spawn('.python313/python.exe', ['-m', 'backend.vision', '--port', '8116', '--workspace', workspace],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VISION_MEMORY_SEMANTIC: '0' } });
let logs = '', server, browser;
backend.stdout.on('data', chunk => { logs += chunk; });
backend.stderr.on('data', chunk => { logs += chunk; });
process.env.VISION_CORE_URL = 'http://127.0.0.1:8116';
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = (await (await fetch(`${process.env.VISION_CORE_URL}/api/v2/health`)).json()).controller; } catch {}
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready, logs);
  server = await createServer({ server: { host: '127.0.0.1', port: 4177, strictPort: true } });
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('**/api/v2/health', async route => {
    const response = await route.fetch();
    const value = await response.json();
    await route.fulfill({ response, json: { ...value, model: { ...value.model, configured: true } } });
  });
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(90_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  console.log('UI: opening workspace');
  await page.goto('http://127.0.0.1:4177/?workspace=v2', { waitUntil: 'domcontentloaded' });
  console.log('UI: creating disposable project');
  await page.getByRole('button', { name: '新建或打开工程', exact: true }).click();
  await page.getByLabel('新工程名称', { exact: true }).fill('Cleanup regression beam');
  await page.getByRole('dialog', { name: '工程管理', exact: true }).getByRole('button', { name: '新建工程', exact: true }).click();
  const openScript = async () => {
    await page.getByLabel('高级操作', { exact: true }).click();
    await page.getByRole('button', { name: '脚本编辑', exact: true }).click();
  };
  await openScript();
  const script = 'result=u.create_box((0,0,0),100,20,10)';
  await page.getByLabel('建模脚本', { exact: true }).fill(script);
  await page.getByText('编辑副本已保存到本机；尚未提交的内容不会自动执行。', { exact: true }).waitFor();
  await page.reload();
  await openScript();
  await page.getByText(/^本机草稿（/).click();
  await page.getByRole('button', { name: '恢复草稿副本', exact: true }).first().click();
  assert.equal(await page.getByLabel('建模脚本', { exact: true }).inputValue(), script);
  const jobResponse = () => page.waitForResponse(r => /\/(build|solve)$/.test(r.url()) && r.status() === 202);
  const finish = async response => {
    const { job_id } = await response.json();
    for (let attempt = 0; attempt < 180; attempt++) {
      const job = await (await fetch(`${process.env.VISION_CORE_URL}/api/v2/jobs/${job_id}`)).json();
      if (['failed', 'cancelled', 'timed_out'].includes(job.state)) assert.fail(JSON.stringify(job));
      if (job.state === 'succeeded') return job;
      await delay(500);
    }
    assert.fail(`job ${job_id} timed out`);
  };
  console.log('UI: building native geometry');
  const [built] = await Promise.all([jobResponse(), page.getByRole('button', { name: '构建几何', exact: true }).click()]);
  const cadJob = await finish(built);
  await page.getByRole('dialog', { name: '脚本编辑', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: 'CAE 仿真', exact: true }).click();
  assert.equal(await page.getByLabel('静力分析目的', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '让 AI 配置并分析', exact: true }).count(), 0);
  // Analysis scope must be selectable before any supports/loads are saved.
  await page.getByLabel('视口操作', { exact: true }).selectOption('body');
  await page.locator('.core-viewport canvas').click();
  await page.getByRole('button', { name: '仅分析所选实体', exact: true }).click();
  const scopedDraft = JSON.parse(await page.getByLabel('工况 JSON', { exact: true }).inputValue());
  assert.deepEqual(scopedDraft.body_ids, ['body-0']);
  assert.equal(scopedDraft.body_artifact_id, cadJob.result.artifact_id);
  assert.deepEqual(scopedDraft.supports, []);
  assert.deepEqual(scopedDraft.loads, []);
  await page.getByRole('heading', { name: '候选参数 · 未保存', exact: true }).waitFor();
  await page.getByText('手动调整（高级）', { exact: true }).click();
  await page.getByLabel('分析范围', { exact: true }).getByText(/草稿分析范围/).waitFor();
  await page.getByRole('button', { name: '使用全部闭合实体', exact: true }).click();
  assert.equal(JSON.parse(await page.getByLabel('工况 JSON', { exact: true }).inputValue()).body_ids, null);
  await page.getByRole('button', { name: '将所选实体用于分析', exact: true }).click();
  // Verify AI handoff without calling an external model or changing saved inputs.
  let aiRequest;
  const interceptAI = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    aiRequest = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ task_id: 'offline-ui-handoff' }) });
  };
  await page.route('**/api/v2/projects/*/conversation', interceptAI);
  await page.getByLabel('对话消息', { exact: true }).fill('按明确的钢材示例，检查100N横向力下的变形。');
  await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/conversation') && response.status() === 202),
    page.getByRole('button', { name: '发送消息', exact: true }).click()]);
  assert.deepEqual(aiRequest.selection, ['body-0']);
  assert.equal(aiRequest.artifact_id, cadJob.result.artifact_id);
  assert.deepEqual(aiRequest.analysis_draft.body_ids, ['body-0']);
  assert.deepEqual(aiRequest.analysis_draft.supports, []);
  assert.deepEqual(aiRequest.analysis_draft.loads, []);
  assert.equal(aiRequest.text, '按明确的钢材示例，检查100N横向力下的变形。');
  assert.ok(aiRequest.text.includes('100N横向力'));
  await page.unroute('**/api/v2/projects/*/conversation', interceptAI);
  // The offline handoff deliberately has no AI revision; restore scope for the independent native solve.
  await page.getByRole('button', { name: '将所选实体用于分析', exact: true }).click();
  await page.getByLabel('视口操作', { exact: true }).selectOption('face');
  await page.locator('.core-viewport canvas').click();
  await page.getByRole('button', { name: '固定所选面', exact: true }).waitFor();
  const cad = await (await fetch(`${process.env.VISION_CORE_URL}/api/v2/artifacts/${cadJob.result.artifact_id}/manifest`)).json();
  const faces = cad.bodies[0].faces;
  const endFaces = faces.filter(face => face.bbox_mm.max[0] - face.bbox_mm.min[0] < .1).sort((a, b) => a.bbox_mm.min[0] - b.bbox_mm.min[0]);
  assert.equal(endFaces.length, 2, JSON.stringify(faces));
  const left = endFaces[0].id, right = endFaces[1].id;
  const selectBoundary = async (action, face) => {
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.getByRole('button', { name: '对象列表与多选', exact: true }).click();
    await page.getByLabel('原生对象', { exact: true }).selectOption(face);
    await page.getByRole('button', { name: '使用所选面', exact: true }).click();
  };
  await selectBoundary('＋ 在模型上添加固定位置', left);
  await page.getByRole('status').filter({ hasText: '草稿 · 固定位置' }).waitFor();
  await selectBoundary('＋ 在模型上添加施力', right);
  await page.getByLabel('载荷 1施力方向', { exact: true }).selectOption('+0');
  await page.getByLabel('载荷 1施力方向', { exact: true }).selectOption('custom');
  assert.deepEqual(JSON.parse(await page.getByLabel('工况 JSON', { exact: true }).inputValue()).loads[0].vector, [1, 0, 0]);
  await page.getByLabel('载荷 1施力方向', { exact: true }).selectOption('+0');
  // Arrow follows draft direction changes before saving, without changing server inputs.
  await page.getByRole('status').filter({ hasText: '合力 [100, 0, 0]' }).waitFor();
  await page.getByRole('button', { name: '反向', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '合力 [-100, 0, 0]' }).waitFor();
  await page.getByRole('button', { name: '反向', exact: true }).click();
  // The saved study is verified from the actual project list; selections only changed the draft.
  const currentProjects = await (await fetch(`${process.env.VISION_CORE_URL}/api/v2/projects`)).json();
  assert.equal(currentProjects[0].document.study, null);
  await mkdir('screenshots', { recursive: true });
  await page.getByRole('button', { name: '适应模型', exact: true }).click();
  await page.screenshot({ path: 'screenshots/simulation-graphical-draft.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'screenshots/simulation-graphical-draft-dark.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: '保存工况', exact: true }).click();
  await page.getByRole('heading', { name: '当前分析参数', exact: true }).waitFor();
  // Both saved boundary glyphs must appear automatically, before any preview button is clicked.
  await page.waitForFunction(() => document.querySelector('.simulation-viewport-note')?.getAttribute('data-marker-count') === '2');
  await page.screenshot({ path: 'screenshots/simulation-auto-markers.png', fullPage: true });
  await page.getByRole('button', { name: '查看载荷 1', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '求解前区域示意' }).waitFor();
  // Selecting a body must not leave an old load glyph attached to another object.
  await page.getByRole('button', { name: '对象列表与多选', exact: true }).click();
  await page.getByLabel('原生对象', { exact: true }).selectOption(cad.bodies[0].id);
  await page.getByText('当前选中的是实体或边，不是受力面。选择对象不会更改原来的约束或载荷。', { exact: true }).waitFor();
  assert.equal(await page.locator('.simulation-viewport-note').count(), 0);
  await page.getByRole('button', { name: '关闭对象列表', exact: true }).click();
  // A coordinate selector envelope cannot establish a physical arrow attachment.
  const selectorDraft = JSON.parse(await page.getByLabel('工况 JSON', { exact: true }).inputValue());
  delete selectorDraft.loads[0].region;
  selectorDraft.loads[0].face = 'z-max';
  await page.getByText('高级工况 JSON', { exact: true }).click();
  await page.getByLabel('工况 JSON', { exact: true }).fill(JSON.stringify(selectorDraft));
  await page.getByRole('button', { name: '显示力箭头 1', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '仅选区范围示意，实际作用位置尚未确认' }).waitFor();
  await page.getByRole('button', { name: '载入已保存工况', exact: true }).click();
  console.log('UI: solving static study');
  const [solved] = await Promise.all([jobResponse(), page.getByRole('button', { name: '运行静力分析', exact: true }).click()]);
  const job = await finish(solved);
  const reference = 100 * 100 / (210000 * 200);
  assert.ok(Math.abs(job.result.summary.maxDisplacement / reference - 1) < .02);
  await page.getByRole('button', { name: '查看数值证据', exact: true }).click();
  await page.getByRole('heading', { name: '当前版本数值证据', exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await page.getByLabel('工况 JSON', { exact: true }).inputValue()).body_ids, ['body-0']);
  assert.ok(job.result.summary.boundaries[0].id);
  assert.ok(job.result.summary.boundaries.every(item => item.nodes > 0));
  assert.ok(job.result.summary.boundaries[1].areaMm2 > 0);
  await page.getByLabel('分析可信度状态').getByText('方程求解：数值核验通过', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看载荷 1', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '实际命中节点抽样标记' }).waitFor();
  console.log('UI: locating extremes and checking field legend');
  await page.getByRole('button', { name: '定位最大位移', exact: true }).click();
  await page.getByLabel('结果场图例').getByText(/非全模型极值/).waitFor();
  await page.getByRole('status').filter({ hasText: '全模型最大位移 · 原始坐标' }).waitFor();
  await page.getByLabel('变形倍率', { exact: true }).fill('100');
  await page.getByRole('button', { name: '定位应力极值', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '全模型节点平均应力极值 · 原始坐标' }).waitFor();
  await mkdir('screenshots', { recursive: true });
  await page.screenshot({ path: 'screenshots/simulation-batch1.png', fullPage: true });
  // Editing the study invalidates current overlays and numerical status.
  await page.getByText(/^材料参数 · E/).click();
  await page.getByLabel('弹性模量 / MPa', { exact: true }).fill('200000');
  await page.getByRole('button', { name: '保存工况', exact: true }).click();
  await page.getByRole('heading', { name: '历史版本数值证据', exact: true }).waitFor();
  assert.equal(await page.getByLabel('结果场图例').count(), 0);
  assert.equal(await page.getByRole('button', { name: '定位最大位移', exact: true }).isEnabled(), false);
  await page.reload();
  await page.locator('.core-viewport canvas').waitFor();
  for (const width of [1440, 1024, 600]) {
    await page.setViewportSize({ width, height: 1000 });
    await delay(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS current workspace: create, draft recovery, native CAD/FEA, evidence, reload and responsive layout');
} catch (error) {
  console.error(logs.slice(-6000));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  if (backend.exitCode === null) { const exited = new Promise(done => backend.once('exit', done)); backend.kill(); await exited; }
  assert.ok(resolve(workspace).startsWith(resolve('tests') + sep));
  await rm(workspace, { recursive: true, force: true });
}
