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
await page.waitForTimeout(1000);
await page.waitForFunction(() => document.body.innerText.includes('校核完成'), null, { timeout: 120000 });

const input = page.locator('#copilot-input');
await input.fill('把悬臂厚度改成 14 mm');
await input.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('已更新'), null, { timeout: 30000 });
await page.waitForTimeout(800);
await page.screenshot({ path: 'screenshots/07-agent-edit.png' });

await input.fill('哪里最危险？');
await input.press('Enter');
await page.waitForFunction(() => document.body.innerText.includes('热点位于'), null, { timeout: 120000 });
await page.waitForTimeout(800);
await page.screenshot({ path: 'screenshots/08-agent-risk.png' });

const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
await page.getByTitle('项目操作').click();
await page.getByRole('button', { name: '导出校核报告' }).click();
const download = await downloadPromise;
await download.saveAs('screenshots/exported-report.md');

fs.writeFileSync('screenshots/agent-body.txt', await page.locator('body').innerText(), 'utf8');
fs.writeFileSync('screenshots/agent-errors.txt', errors.join('\n'), 'utf8');
console.log(errors.join('\n') || 'no console/page errors');
console.log('download:', download.suggestedFilename());
await browser.close();
