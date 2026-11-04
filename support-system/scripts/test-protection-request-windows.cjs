// Run with PLAYWRIGHT_MODULE and CHROMIUM_PATH when Chromium is installed outside this project.
// Builds the real customer portal and serves synthetic data. All mutations are rejected.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
let scenario = 'not_open', server, browser;
const mutations = [];
function item(id, status) {
  return { id, title: `Fixture ${id}`, image_url: null, quantity: 1, amount_cents: 1000, available_quantity: 1, available_amount_cents: 1000, has_active_claim: false,
    request_windows: ['damaged', 'lost', 'stolen', 'delayed'].map(reason => ({ reason, status,
      opens_at: status === 'unknown' ? null : status === 'not_open' ? '2026-12-01T18:00:00Z' : '2026-10-01T18:00:00Z',
      closes_at: status === 'unknown' ? null : status === 'expired' ? '2026-10-08T18:00:00Z' : '2026-12-20T18:00:00Z',
      basis: 'Based on the shipment information supplied by the store.', message: 'Fixture request window' })) };
}
function fixture() {
  const items = [item('coat', scenario === 'mixed' ? 'expired' : scenario), item('shirt', scenario === 'mixed' ? 'open' : scenario)];
  return { ok: true, order: { protection_no: 'SP-FIXTURE', order_number: 'TEST-WINDOWS', store_name: 'Fixture store', currency: 'USD', purchased_at: '2026-10-01T18:00:00Z', customer_name: 'Test Customer', protection_fee_cents: 100, remaining_amount_cents: 2000, shipping_address: { address1: 'Fixture address', address2: '', city: 'Fixture city', province: '', postal_code: '', country: 'United States' }, items, shipments: [] }, claims: [],
    coverage: { policy_version: '2026-11-03:shipment', evaluated_at: '2026-11-04T00:00:00Z', windows: items[0].request_windows, timestamps: {} },
    eligibility: { can_submit: scenario === 'mixed', reason_code: scenario === 'mixed' ? null : 'request_window', message: null },
    limits: { max_files: 6, max_file_bytes: 26214400, max_total_bytes: 104857600 } };
}
async function translateDialog(page) {
  // Browser translators replace React's text nodes with nested font elements.
  // Keep the wording so locators remain readable; the detached-node behavior is identical.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('dialog'), NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) if (walker.currentNode.textContent.trim() && !walker.currentNode.parentElement.closest('font, svg')) texts.push(walker.currentNode);
    for (const text of texts) {
      const outer = document.createElement('font'), inner = document.createElement('font');
      inner.textContent = text.textContent; outer.append(inner); text.replaceWith(outer);
    }
  });
}
(async () => {
  const bundle = await build({ absWorkingDir: root, entryPoints: ['frontend/customer-protection/main.tsx'], bundle: true, minify: true, target: 'es2020', format: 'iife', write: false, outfile: 'customer-protection.js', define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'none' });
  server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { mutations.push(`${req.method} ${req.url}`); res.statusCode = 405; return res.end(); }
    if (req.url === '/api/protection/order') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(fixture())); }
    const asset = bundle.outputFiles.find(file => '/assets/' + path.basename(file.path) === req.url);
    if (asset) { res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(asset.contents); }
    if (req.url !== '/protection') { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(root, 'public/customer-protection.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/protection`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function open(mode, received, issue, preselect = false) {
      scenario = mode; await page.goto(url);
      await page.getByRole('heading', { name: 'Your protected order', exact: true }).waitFor();
      await (preselect ? page.locator('.cp-order-items > li').first().getByRole('button', { name: 'Request a refund', exact: true }) : page.getByRole('button', { name: 'New request', exact: true })).click();
      await page.getByRole('radio', { name: received ? 'Yes, I received my package.' : 'No, I have not received it.', exact: true }).check();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await translateDialog(page);
      await page.getByRole('radio', { name: issue, exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.cp-window-notice') || !document.querySelector('#customer-protection-root').childElementCount);
      assert.deepEqual(errors, [], 'Translated reason selection must not unmount the portal');
    }
    async function notice(title) {
      const dialog = page.getByRole('dialog', { name: 'Request window', exact: true });
      await dialog.getByRole('heading', { name: title, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), title, 'The explanation receives focus');
      assert.equal(await dialog.getByRole('radio').count(), 0, 'Hidden wizard controls are excluded from accessibility navigation');
      assert.equal(await dialog.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
      assert.equal(await dialog.getByRole('button', { name: 'Submit request', exact: true }).count(), 0);
      assert.equal(await dialog.getByRole('button', { name: 'About Shipping Protection', exact: true }).count(), 0);
      assert.doesNotMatch(await dialog.innerText(), /contact (?:support|the store)|request support/i);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      return dialog;
    }
    const cases = [
      ['not_open', false, 'My shipment is significantly delayed', 'Requests are not open yet'],
      ['not_open', false, 'My package has not arrived', 'Requests are not open yet'],
      ['not_open', false, 'My order is marked complete, but I have not received my package', 'Requests are not open yet'],
      ['not_open', true, 'My item arrived damaged', 'Requests are not open yet'],
      ['expired', true, 'Items are missing from my package', 'This request window has closed'],
      ['unknown', false, 'My package has not arrived', 'Request dates are not available'],
    ];
    for (const [mode, received, issue, title] of cases) {
      await open(mode, received, issue);
      const dialog = await notice(title);
      if (mode === 'unknown') { assert.match(await dialog.innerText(), /Not yet available/); assert.doesNotMatch(await dialog.innerText(), /Dec 20/); }
      if (mode === 'not_open') assert.match(await dialog.innerText(), /Dec 1, 2026, 6:00 PM UTC/);
      if (process.env.SCREENSHOT_DIR && issue === 'My shipment is significantly delayed') {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `request-window-${viewport.width}.png`) });
      }
      await translateDialog(page);
      await dialog.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('heading', { name: 'What went wrong?', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'What went wrong?');
      assert.equal(await page.getByRole('radio', { name: issue, exact: true }).isChecked(), true);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await notice(title);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.getByRole('heading', { name: 'Your protected order', exact: true }).isVisible(), true);
    }
    await open('mixed', false, 'My package has not arrived', true);
    const mixed = await notice('This request window has closed');
    assert.match(await mixed.innerText(), /Fixture coat/); assert.doesNotMatch(await mixed.innerText(), /Fixture shirt/);
    await translateDialog(page); await mixed.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('heading', { name: 'Which items are affected?', exact: true }).waitFor();
    await page.getByRole('checkbox', { name: 'Include Fixture coat', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Include Fixture shirt', exact: true }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Tell us what happened', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'Back and Escape after translation must leave the portal usable');
    await page.close();
  }
  assert.deepEqual(mutations, [], 'Blocked-window navigation must not perform mutations');
  console.log('Request-window browser regression passed: translated reasons, Back, hidden controls, mixed parcels and Escape on desktop/mobile; no mutations.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
