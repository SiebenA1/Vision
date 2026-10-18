import { chromium } from 'playwright-core';
import fs from 'node:fs';

const outDir = 'screenshots';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.waitForFunction(() => document.body.innerText.includes('校核完成'), null, { timeout: 60000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${outDir}/01-home.png` });

const resultButton = page.getByRole('button', { name: '结果场' });
if (await resultButton.count()) {
  await resultButton.first().click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${outDir}/02-result.png` });
}

await page.getByRole('button', { name: /分析工作台/ }).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/03-analysis.png` });

const bodyText = await page.locator('body').innerText();
fs.writeFileSync(`${outDir}/body.txt`, bodyText, 'utf8');
fs.writeFileSync(`${outDir}/errors.txt`, errors.join('\n'), 'utf8');
console.log('screenshots written');
console.log(errors.join('\n') || 'no console/page errors');
await browser.close();
