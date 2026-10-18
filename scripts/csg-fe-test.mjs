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
await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.waitForFunction(() => document.body.innerText.includes('校核完成'), null, { timeout: 90000 });

const composer = page.locator('.composer textarea, textarea').first();
await composer.fill('帮我建模一个刹车踏板支架，包含安装背板、双侧叉板、枢轴座和踏板臂。');
await composer.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('PEDAL-02'), null, { timeout: 30000 });
await page.waitForTimeout(2200);
const chatText = await page.locator('.copilot').innerText();
const hasStaleSeed = chatText.includes('BRK-042 已载入');
const hasSummary = chatText.includes('已生成');
const hasInvalidChip = chatText.includes('悬臂厚度改为');
await page.screenshot({ path: 'screenshots/19-brake-pedal-framed.png' });

await page.getByRole('button', { name: /运行基线校核/ }).first().click();
await page.waitForFunction(() => document.body.innerText.includes('校核完成'), null, { timeout: 180000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: 'screenshots/20-brake-pedal-result.png' });
const body = await page.locator('body').innerText();
const hasResult = body.includes('SF') && body.includes('MPa');
fs.writeFileSync('screenshots/csg-fe-errors.txt', errors.join('\n'), 'utf8');
console.log({ hasStaleSeed, hasSummary, hasInvalidChip, hasResult });
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
