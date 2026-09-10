// UI smoke test + screenshots (needs a running server with mocks; see tests/e2e.mjs for the API flow).
// Usage: BASE=http://localhost:8090 EMAIL=admin@neopolis.test PASSWORD=password123 node scripts/screenshots.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8090';
const EMAIL = process.env.EMAIL || 'admin@neopolis.test';
const PASSWORD = process.env.PASSWORD || 'password123';
const OUT = process.env.OUT || 'tests/screenshots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE + '/#/dashboard');
await page.waitForSelector('#authform', { timeout: 10000 });
await page.screenshot({ path: `${OUT}/00-login.png` });
const nameField = await page.$('input[name=name]');
if (nameField) await nameField.fill('Hemant');
await page.fill('input[name=email]', EMAIL);
await page.fill('input[name=password]', PASSWORD);
await page.click('#authform button[type=submit]');
await page.waitForSelector('.shell', { timeout: 10000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/01-dashboard.png`, fullPage: true });

await page.goto(BASE + '/#/inbox');
await page.waitForSelector('.conv', { timeout: 10000 });
await page.click('.conv');
await page.waitForSelector('.msg', { timeout: 10000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-inbox.png` });

await page.goto(BASE + '/#/leads');
await page.waitForSelector('table.tbl tbody tr', { timeout: 10000 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/03-leads.png` });

await page.goto(BASE + '/#/review/all');
await page.waitForSelector('.rv-card, .empty', { timeout: 10000 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/04-review.png`, fullPage: true });

for (const tab of ['ai', 'outreach', 'whatsapp', 'sheet', 'team']) {
  await page.goto(BASE + '/#/settings/' + tab);
  await page.waitForSelector('#panel .card', { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/05-settings-${tab}.png`, fullPage: true });
}
await browser.close();
if (errors.length) { console.log('BROWSER ERRORS:\n' + errors.join('\n')); process.exitCode = 1; } else console.log('UI OK — screenshots in', OUT);
