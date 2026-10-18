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
await page.waitForTimeout(2000);
await page.waitForFunction(() => document.body.innerText.includes('校核完成'), null, { timeout: 90000 });

const composer = page.locator('.composer textarea, textarea').first();
await composer.fill('帮我建模一个刹车踏板支架，包含安装背板、双侧叉板、枢轴座和踏板臂。');
await composer.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('PEDAL-02'), null, { timeout: 30000 });
await page.waitForTimeout(2500);
const body = await page.locator('body').innerText();
const hasBuilder = (await page.locator('.csg-builder').count()) === 1;
const hasFeatures = body.includes('16 SOLIDS') || body.includes('CSG 特征模型');
const hasSummary = body.includes('已生成') && body.includes('刹车踏板支架');
await page.screenshot({ path: 'screenshots/18-brake-pedal.png' });
fs.writeFileSync('screenshots/csg-errors.txt', errors.join('\n'), 'utf8');
console.log({ hasBuilder, hasFeatures, hasSummary });
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
