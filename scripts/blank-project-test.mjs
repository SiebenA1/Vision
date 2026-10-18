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
await page.waitForTimeout(1500);
await page.waitForFunction(() => document.body.innerText.includes('校核完成'), null, { timeout: 90000 });

await page.getByTitle('打开工程中心').click();
await page.getByPlaceholder('项目名称').fill('空白验证工程');
await page.getByPlaceholder('编号（可空）').fill('BLK-001');
await page.getByRole('button', { name: '空白工程', exact: true }).click();
await page.waitForFunction(() => document.body.innerText.includes('空白验证工程'), null, { timeout: 20000 });
await page.waitForTimeout(700);
const blankVisible = (await page.locator('.blank-starter').count()) === 1 || (await page.locator('.stage-empty--blank').count()) === 1;
await page.screenshot({ path: 'screenshots/16-blank-project.png' });

await page.locator('.stage-empty__starters button').filter({ hasText: '基础板' }).click();
await page.waitForTimeout(2200);
const plateVariables = (await page.locator('body').innerText()).includes('板厚');
await page.screenshot({ path: 'screenshots/17-blank-plate.png' });

fs.writeFileSync('screenshots/blank-errors.txt', errors.join('\n'), 'utf8');
console.log({ blankVisible, plateVariables });
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
