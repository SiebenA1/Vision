import { chromium } from 'playwright-core';
import fs from 'node:fs';

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
await page.route('**/api/deepseek/models', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }) });
});

const script = `import usd_brep as u
result = u.create_box((-50, -10, -5), 100, 20, 10)
`;
let turn = 0;
await page.route('**/api/deepseek/chat/completions', async (route) => {
  turn += 1;
  if (turn === 1) {
    const chunks = [
      { id: 'm1', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '生成悬臂梁 B-Rep，再用 Gmsh/SfePy 求解。' }, finish_reason: null }] },
      { id: 'm1', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_cad', type: 'function', function: { name: 'run_usd_brep', arguments: JSON.stringify({ script, name: '悬臂梁验证', code: 'CAD-8001', density_kg_m3: 7850, materialId: 'STEEL-4340' }) } }] }, finish_reason: null }] },
      { id: 'm1', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 600, completion_tokens: 100, total_tokens: 700 } },
    ];
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n' });
    return;
  }
  const chunks = [
    { id: 'm2', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'B-Rep 已生成，可以运行 Gmsh + SfePy 校核。' }, finish_reason: null }] },
    { id: 'm2', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 800, completion_tokens: 30, total_tokens: 830 } },
  ];
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n' });
});

await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.getByTitle('DeepSeek 设置').click();
await page.locator('.settings-key input').fill('sk-mock-deepseek-key');
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForFunction(() => document.body.innerText.includes('连接成功'), null, { timeout: 10000 });
await page.getByRole('button', { name: '保存并启用' }).click();
await page.waitForTimeout(700);
await page.locator('#copilot-input').fill('建模 100×20×10 mm 悬臂梁，并校核。');
await page.locator('#copilot-input').press('Enter');
await page.waitForFunction(
  () => document.body.innerText.includes('已更新当前工程') || document.body.innerText.includes('NVIDIA USD BRep'),
  null,
  { timeout: 60000 },
);
await page.waitForTimeout(4000);
const preRun = await page.locator('body').innerText();
const autoRan = preRun.includes('求解中') || preRun.includes('校核完成');
await page.getByRole('button', { name: /运行基线校核/ }).first().click();
await page.waitForFunction(
  () => document.body.innerText.includes('校核完成') || document.body.innerText.includes('求解失败'),
  null,
  { timeout: 240000 },
);
await page.waitForTimeout(1200);
const body = await page.locator('body').innerText();
const hasSfePy = body.includes('SfePy');
const hasResult = body.includes('校核完成') && body.includes('MPa');
await page.getByRole('button', { name: /分析工作台/ }).first().click();
await page.waitForFunction(() => document.body.innerText.includes('解析解'), null, { timeout: 180000 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'screenshots/26-sfepy-validation.png' });
const validationText = await page.locator('body').innerText();
const hasValidation = validationText.includes('解析解') && validationText.includes('误差');
fs.writeFileSync('screenshots/sfepy-errors.txt', errors.join('\n'), 'utf8');
console.log({ hasSfePy, hasResult, hasValidation, autoRan });
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
