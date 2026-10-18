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
await composer.fill('帮我建模一个风电的扇叶。');
await composer.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('WT-02'), null, { timeout: 30000 });
await page.waitForTimeout(1800);
const body = await page.locator('body').innerText();
const hasBlade = body.includes('风电叶片') && body.includes('叶片放样');
const hasStale = body.includes('BRK-042 已载入');
await page.screenshot({ path: 'screenshots/21-wind-blade.png' });

await page.getByRole('button', { name: /运行基线校核/ }).first().click();
await page.waitForFunction(() => document.body.innerText.includes('校核完成'), null, { timeout: 180000 });
await page.waitForTimeout(900);
await page.screenshot({ path: 'screenshots/22-wind-blade-result.png' });
const resultBody = await page.locator('body').innerText();
const hasResult = resultBody.includes('MPa') && resultBody.includes('SF');
fs.writeFileSync('screenshots/wind-errors.txt', errors.join('\n'), 'utf8');
console.log({ hasBlade, hasStale, hasResult });
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
