// Run with PLAYWRIGHT_MODULE and CHROMIUM_PATH when Chromium is installed outside this project.
// Uses an isolated wizard and intercepted API; never submits a real customer claim.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const windows = ['stolen', 'lost', 'delayed', 'damaged'].map(reason => ({ reason, status: 'open', opens_at: '2026-01-01T00:00:00Z', closes_at: '2027-01-01T00:00:00Z', basis: 'Fixture', message: 'Open' }));
const fixture = {
  ok: true,
  order: { protection_no: 'SP-FIXTURE', order_number: 'TEST-LOCATION', currency: 'USD', remaining_amount_cents: 1000,
    items: [{ id: 'fixture-item', title: 'Test item', image_url: null, quantity: 1, amount_cents: 1000, available_quantity: 1, available_amount_cents: 1000, has_active_claim: false, request_windows: windows }] },
  limits: { max_files: 6, max_file_bytes: 26214400, max_total_bytes: 104857600 },
};
let server, browser;
(async () => {
  const bundle = await build({ absWorkingDir: root, stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {Wizard} from './frontend/customer-protection/Wizard';
    import './frontend/customer-protection/styles.css';
    createRoot(document.getElementById('root')).render(<Wizard data={${JSON.stringify(fixture)}} initialItem="fixture-item" onClose={()=>{}} onSubmitted={()=>{window.submitted=true}} />);
  `, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outfile: 'wizard.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  server = http.createServer((req, res) => {
    const asset = bundle.outputFiles.find(file => path.basename(file.path) === req.url?.slice(1));
    res.setHeader('Content-Type', asset ? req.url.endsWith('.css') ? 'text/css' : 'text/javascript' : 'text/html');
    res.end(asset ? asset.contents : '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/wizard.css"><div id="root"></div><script src="/wizard.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [], submissions = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/protection/claims', async route => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, claim: { public_no: 'CL-FIXTURE' } } });
  });
  await page.addInitScript(() => {
    window.locationMode = 'denied'; window.locationCalls = 0;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success, failure, options) {
        window.locationCalls++; window.locationOptions = options;
        window.locationCallback = success;
        if (window.locationMode === 'throw') throw new DOMException('Fixture geolocation security restriction', 'SecurityError');
        if (window.locationMode === 'pending') return;
        if (window.locationMode !== 'success') return failure({ code: window.locationMode === 'timeout' ? 3 : 1 });
        success({ coords: { latitude: 40.7, longitude: -74, accuracy: 25 }, timestamp: Date.now() });
      },
    } });
  });
  async function details(issue, received = false) {
    await page.goto(url);
    await page.getByRole('radio', { name: received ? 'Yes, I received my package.' : 'No, I have not received it.', exact: true }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('radio', { name: issue, exact: true }).check();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Issue details').fill('The package could not be found.');
    assert.equal(await page.evaluate(() => window.locationCalls), 0, 'Location requires an explicit customer action');
  }
  async function staysOnDetails() {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'Tell us what happened', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Submit request', exact: true }).count(), 0);
  }
  for (const issue of ['My order is marked complete, but I have not received my package', 'My package has not arrived', 'My shipment is significantly delayed']) {
    await details(issue);
    assert.match(await page.locator('.cp-location').innerText(), /Required/);
    await staysOnDetails();
    await page.getByRole('button', { name: 'Share current location', exact: true }).click();
    assert.match(await page.locator('.cp-location-status').innerText(), /allow location|location permission/i);
    assert.doesNotMatch(await page.locator('.cp-location').innerText(), /continue without|Skip location/);
    await staysOnDetails();
    assert.equal(submissions.length, 0);
  }
  await details('My order is marked complete, but I have not received my package');
  await page.evaluate(() => Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined }));
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  assert.match(await page.locator('.cp-location-status').innerText(), /not available.*browser/i);
  await staysOnDetails();
  await details('My order is marked complete, but I have not received my package');
  await page.evaluate(() => { window.locationMode = 'throw'; });
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  assert.match(await page.locator('.cp-location-status').innerText(), /browser.*location|location.*browser/i);
  assert.equal(await page.getByRole('button', { name: 'Share current location', exact: true }).isEnabled(), true);
  await staysOnDetails();
  await page.evaluate(() => { window.locationMode = 'pending'; });
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel location request', exact: true }).click();
  await page.evaluate(() => window.locationCallback({ coords: { latitude: 40.7, longitude: -74, accuracy: 25 }, timestamp: Date.now() }));
  assert.equal(await page.getByRole('button', { name: 'Remove location', exact: true }).count(), 0, 'A cancelled request must ignore its late location result');
  await staysOnDetails();
  assert.equal(submissions.length, 0);
  await page.evaluate(() => { window.locationMode = 'timeout'; });
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  assert.match(await page.locator('.cp-location-status').innerText(), /timed out/i);
  await staysOnDetails();
  await page.evaluate(() => { window.locationMode = 'success'; });
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  assert.equal(await page.evaluate(() => window.locationOptions.enableHighAccuracy), true);
  await page.getByRole('button', { name: 'Remove location', exact: true }).click();
  await staysOnDetails();
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Review your request', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await page.waitForFunction(() => window.submitted);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].received_package, false);
  assert.equal(submissions[0].location.latitude, 40.7);
  assert.equal(submissions[0].location.accuracy_meters, 25);
  await details('Items are missing from my package', true);
  assert.match(await page.locator('.cp-location').innerText(), /Optional/);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Review your request', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await page.waitForFunction(() => window.submitted);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].location, null);
  assert.equal(submissions[1].received_package, true);
  assert.deepEqual(errors, []);
  console.log('PASS: all nonreceived reasons require location; denied/timeout/unsupported/synchronous failure/removal block review; cancelled late callbacks are ignored; explicit consent and successful coordinates submit; received-package location remains optional. Isolated fixture only.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
