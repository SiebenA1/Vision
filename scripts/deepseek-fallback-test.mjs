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
await page.addInitScript(() => {
  sessionStorage.setItem('vision.deepseek.key.session', 'sk-invalid-test-key');
});
await page.goto('http://127.0.0.1:4173', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
await page.locator('#copilot-input').fill('你好');
await page.locator('#copilot-input').press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('DeepSeek 调用失败'), null, { timeout: 30000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'screenshots/11-deepseek-fallback.png' });
const body = await page.locator('body').innerText();
fs.writeFileSync('screenshots/fallback-errors.txt', errors.join('\n'), 'utf8');
console.log('fallback shown:', body.includes('已回退到本地确定性规划器'));
console.log('errors:', errors.join('\n') || 'none');
console.log(body.slice(-1400));
await browser.close();
