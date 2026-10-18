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
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }),
  });
});

const script = `from build123d import *
R = 228.5
W = 203.0
with BuildPart() as wheel:
    Cylinder(R, W)
    Cylinder(R - 14, W + 20, mode=Mode.SUBTRACT)
    Cylinder(84, 100)
    Cylinder(36.3, 120, mode=Mode.SUBTRACT)
    with PolarLocations(145, 9):
        Box(30, 150, 26)
result = wheel.part
`;

let chatCount = 0;
await page.route('**/api/deepseek/chat/completions', async (route) => {
  chatCount += 1;
  if (chatCount === 1) {
    const chunks = [
      {
        id: 'mock-cad-1',
        object: 'chat.completion.chunk',
        model: 'deepseek-flash',
        choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '用户要求 9 辐轮辋，写 build123d 脚本并由 OCCT 执行。' }, finish_reason: null }],
      },
      {
        id: 'mock-cad-1',
        object: 'chat.completion.chunk',
        model: 'deepseek-flash',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_mock_cad_1',
              type: 'function',
              function: {
                name: 'run_build123d',
                arguments: JSON.stringify({
                  script,
                  name: '9辐汽车轮辋',
                  code: 'CAD-9001',
                  density_kg_m3: 2700,
                  materialId: 'AL6061-T6',
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: 'mock-cad-1',
        object: 'chat.completion.chunk',
        model: 'deepseek-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 700, completion_tokens: 120, total_tokens: 820 },
      },
    ];
    const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: text });
    return;
  }
  const chunks = [
    {
      id: 'mock-cad-2',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: '已由 build123d/OCCT 生成 9 辐轮辋，几何来自本次脚本，不是预设。' }, finish_reason: null }],
    },
    {
      id: 'mock-cad-2',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 },
    },
  ];
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: text });
});

await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.getByTitle('DeepSeek 设置').click();
await page.locator('.settings-key input').fill('sk-mock-deepseek-key');
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForFunction(() => document.body.innerText.includes('连接成功'), null, { timeout: 10000 });
await page.getByRole('button', { name: '保存并启用' }).click();
await page.waitForTimeout(700);

await page.locator('#copilot-input').fill('帮我用 build123d 建模一个 9 辐汽车轮辋');
await page.locator('#copilot-input').press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('CAD-9001'), null, { timeout: 60000 });
await page.waitForTimeout(1800);
const body = await page.locator('body').innerText();
const hasExternal = body.includes('B-Rep 模型') || body.includes('build123d');
const hasGeometry = (await page.locator('.stage-canvas canvas').count()) === 1;
await page.screenshot({ path: 'screenshots/24-build123d-external.png' });
fs.writeFileSync('screenshots/build123d-errors.txt', errors.join('\n'), 'utf8');
console.log({ hasExternal, hasGeometry, chatCount });
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
