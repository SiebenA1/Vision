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

await page.getByTitle('打开工程中心').click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'screenshots/12-project-center.png' });

const heavyCard = page.locator('.project-card').filter({ hasText: '重载悬挂支架' }).first();
await heavyCard.click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: '打开该项目' }).click();
await page.waitForFunction(() => document.body.innerText.includes('BRK-042-L'), null, { timeout: 20000 });
await page.waitForTimeout(1800);
await page.screenshot({ path: 'screenshots/13-project-heavy.png' });

await page.getByTitle('收起模型面板').click();
await page.waitForTimeout(400);
const collapsed = (await page.locator('.model-panel').count()) === 0 && (await page.locator('.left-expand').count()) === 1;
await page.screenshot({ path: 'screenshots/15-panel-collapsed.png' });
await page.locator('.left-expand').click();
await page.waitForTimeout(400);
const reopened = (await page.locator('.model-panel').count()) === 1;
await page.screenshot({ path: 'screenshots/14-panel-reopened.png' });

await page.getByTitle('打开工程中心').click();
await page.waitForTimeout(300);
await page.getByPlaceholder('项目名称').fill('测试派生项目');
await page.getByPlaceholder('编号（可空）').fill('BRK-099');
await page.getByRole('button', { name: '派生', exact: true }).click();
await page.waitForFunction(() => document.body.innerText.includes('BRK-099'), null, { timeout: 20000 });
await page.waitForTimeout(1200);
const activeBeforeReload = (await page.locator('body').innerText()).includes('测试派生项目');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const activeAfterReload = (await page.locator('body').innerText()).includes('BRK-099');

fs.writeFileSync('screenshots/project-errors.txt', errors.join('\n'), 'utf8');
console.log({ collapsed, reopened, activeBeforeReload, activeAfterReload });
console.log('errors:', errors.join('\n') || 'none');
await browser.close();
