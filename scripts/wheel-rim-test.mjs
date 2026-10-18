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
await page.waitForTimeout(1400);
await page.waitForFunction(() => document.body.innerText.includes('校核完成'), null, { timeout: 90000 });
const composer = page.locator('.composer textarea, textarea').first();
await composer.fill('帮我建模一个 18 英寸、9辐的汽车轮辋：外径 457 mm，宽度 203 mm，PCD 114.3 mm，中心孔 72.6 mm，5 个螺栓孔，材料铝合金 6061-T6。');
await composer.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('RIM-02'), null, { timeout: 30000 });
await page.waitForTimeout(1800);
const body = await page.locator('body').innerText();
const hasNine = body.includes('9 辐') && body.includes('9 根');
const hasNineFeatures = (await page.locator('.feature-row').count()) >= 20;
const summary = body.includes('已按参数生成') || body.includes('已生成');
await page.screenshot({ path: 'screenshots/23-wheel-rim-9.png' });
fs.writeFileSync('screenshots/wheel-errors.txt', errors.join('\n'), 'utf8');
console.log({ hasNine, hasNineFeatures, summary });
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
