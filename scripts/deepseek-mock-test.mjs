import { chromium } from 'playwright-core';
import fs from 'node:fs';

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
const requests = [];
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

let chatCount = 0;
await page.route('**/api/deepseek/chat/completions', async (route) => {
  const body = route.request().postDataJSON();
  requests.push(body);
  chatCount += 1;
  if (chatCount === 1) {
    const chunks = [
      {
        id: 'mock-1',
        object: 'chat.completion.chunk',
        model: 'deepseek-flash',
        choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '用户要求 14 mm，先调用参数工具。' }, finish_reason: null }],
      },
      {
        id: 'mock-1',
        object: 'chat.completion.chunk',
        model: 'deepseek-flash',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_mock_1',
              type: 'function',
              function: {
                name: 'set_variable',
                arguments: JSON.stringify({ key: 'armThickness', value: 14, reason: 'requested thickness' }),
              },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        id: 'mock-1',
        object: 'chat.completion.chunk',
        model: 'deepseek-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 640, completion_tokens: 90, total_tokens: 730 },
      },
    ];
    const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: text,
    });
    return;
  }
  const chunks = [
    {
      id: 'mock-2',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '工具返回了新的模型状态，可以总结。' }, finish_reason: null }],
    },
    {
      id: 'mock-2',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: { content: '已将 **悬臂厚度** 更新为 **14 mm**。几何已重建，旧结果已标记为待刷新。' }, finish_reason: null }],
    },
    {
      id: 'mock-2',
      object: 'chat.completion.chunk',
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 },
    },
  ];
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: text,
  });
});

await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

await page.getByTitle('DeepSeek 设置').click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'screenshots/09-settings.png' });
await page.locator('.settings-key input').fill('sk-mock-deepseek-key');
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForFunction(() => document.body.innerText.includes('连接成功'), null, { timeout: 10000 });
await page.screenshot({ path: 'screenshots/09b-settings-configured.png' });
await page.getByRole('button', { name: '保存并启用' }).click();
await page.waitForTimeout(800);

await page.locator('#copilot-input').fill('把悬臂厚度改成 14 mm');
await page.locator('#copilot-input').press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('旧结果已标记为待刷新'), null, { timeout: 30000 });
await page.waitForTimeout(1400);
await page.screenshot({ path: 'screenshots/10-deepseek-chat.png' });

fs.writeFileSync('screenshots/deepseek-requests.json', JSON.stringify(requests, null, 2), 'utf8');
fs.writeFileSync('screenshots/deepseek-errors.txt', errors.join('\n'), 'utf8');
console.log('chat requests:', requests.length);
console.log('errors:', errors.join('\n') || 'none');
console.log((await page.locator('body').innerText()).slice(-1800));
await browser.close();
