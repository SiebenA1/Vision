import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.addInitScript(() => localStorage.clear());
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
await page.route('**/api/deepseek/models', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }) });
});

let turn = 0;
await page.route('**/api/deepseek/chat/completions', async (route) => {
  turn += 1;
  if (turn === 1 || turn === 3) {
    const length = turn === 1 ? 100 : 120;
    const chunks = [
      { id: `m${turn}`, object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '更新当前工程几何。' }, finish_reason: null }] },
      { id: `m${turn}`, object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: 'run_build123d', arguments: JSON.stringify({ script: `from build123d import *\nresult = Box(${length}, 20, 10)\n`, name: `模型 ${length}`, code: turn === 1 ? 'CAD-9999' : 'CAD-8888', density_kg_m3: 7850, materialId: 'STEEL-4340' }) } }] }, finish_reason: null }] },
      { id: `m${turn}`, object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    ];
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n' });
    return;
  }
  const chunks = [
    { id: `m${turn}`, object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: '已更新当前工程。' }, finish_reason: null }] },
    { id: `m${turn}`, object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 } },
  ];
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n' });
});

await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
await page.getByTitle('DeepSeek 设置').click();
await page.locator('.settings-key input').fill('sk-mock-deepseek-key');
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForFunction(() => document.body.innerText.includes('连接成功'), null, { timeout: 10000 });
await page.getByRole('button', { name: '保存并启用' }).click();
await page.waitForTimeout(500);

await page.locator('#copilot-input').fill('用 build123d 建一个 100x20x10 的块。');
await page.locator('#copilot-input').press('Enter');
await page.waitForFunction(() => (document.body.innerText.match(/已更新当前工程/g) ?? []).length >= 1, null, { timeout: 60000 });
await page.waitForTimeout(800);

await page.locator('#copilot-input').fill('把长度改成 120。');
await page.locator('#copilot-input').press('Enter');
await page.waitForFunction(() => (document.body.innerText.match(/已更新当前工程/g) ?? []).length >= 2, null, { timeout: 60000 });
await page.waitForTimeout(1000);

const state = await page.evaluate(() => {
  const projects = JSON.parse(localStorage.getItem('vision.project.library.v2') ?? '[]');
  const active = localStorage.getItem('vision.project.active.v2');
  return {
    count: projects.length,
    codes: projects.map((project) => project.model.code),
    active,
    activeCode: projects.find((project) => project.id === active)?.model.code,
    activeScript: projects.find((project) => project.id === active)?.model.externalScript,
  };
});
await page.screenshot({ path: 'screenshots/27-same-project-update.png' });
console.log({ ...state, activeScript: state.activeScript?.includes('Box(120') ? '120' : 'other', errors });
await browser.close();
