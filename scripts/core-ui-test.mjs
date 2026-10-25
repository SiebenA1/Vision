// Current desktop workbench against real CAD/FEA in a disposable workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
process.env.VISION_ENGINEERING_URL = 'http://127.0.0.1:8116';
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
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(90_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4177/?workspace=v2', { waitUntil: 'domcontentloaded' });
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
  const [built] = await Promise.all([jobResponse(), page.getByRole('button', { name: '构建几何', exact: true }).click()]);
  await finish(built);
  await page.getByRole('dialog', { name: '脚本编辑', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: 'CAE 仿真', exact: true }).click();
  await page.getByRole('button', { name: '创建示例草稿（请核对）', exact: true }).click();
  await page.getByRole('button', { name: '保存工况', exact: true }).click();
  const [solved] = await Promise.all([jobResponse(), page.getByRole('button', { name: '运行静力分析', exact: true }).click()]);
  const job = await finish(solved);
  const reference = 100 * 100 / (210000 * 200);
  assert.ok(Math.abs(job.result.summary.maxDisplacement / reference - 1) < .02);
  await page.getByRole('button', { name: '查看数值证据', exact: true }).click();
  await page.getByRole('heading', { name: '当前版本数值证据', exact: true }).waitFor();
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
