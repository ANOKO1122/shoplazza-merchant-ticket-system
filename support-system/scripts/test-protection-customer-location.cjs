// Run with PLAYWRIGHT_MODULE and CHROMIUM_PATH when Chromium is installed outside this project.
// Uses an isolated wizard and intercepted API; never submits a real customer claim.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
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
    if (['/assets/protection-location-ios.png', '/assets/protection-location-android.png'].includes(req.url)) { res.setHeader('Content-Type', 'image/png'); return res.end(fs.readFileSync(path.join(root, 'public', req.url))); }
    const asset = bundle.outputFiles.find(file => path.basename(file.path) === req.url?.slice(1));
    res.setHeader('Content-Type', asset ? req.url.endsWith('.css') ? 'text/css' : 'text/javascript' : 'text/html');
    res.end(asset ? asset.contents : '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/wizard.css"><div id="root"></div><script src="/wizard.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [], submissions = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/protection/claims', async route => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, claim: { public_no: 'CL-FIXTURE' } } });
  });
  async function mockLocation(target) { await target.addInitScript(() => {
    window.locationMode = 'denied'; window.locationCalls = 0;
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      watchPosition(success, failure, options) {
        window.locationCalls++; window.locationOptions = options;
        window.locationCallback = success;
        if (window.locationMode === 'throw') throw new DOMException('Fixture geolocation security restriction', 'SecurityError');
        if (window.locationMode === 'pending') return 17;
        if (window.locationMode !== 'success') { failure({ code: window.locationMode === 'timeout' ? 3 : 1 }); return 17; }
        success({ coords: { latitude: 40.7, longitude: -74, accuracy: 25 }, timestamp: Date.now() }); return 17;
      },
      clearWatch(id) { window.clearedWatch = id; },
    } });
  }); }
  await mockLocation(page);
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
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  await page.evaluate(() => {
    window.clearedWatch = null;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.evaluate(() => window.clearedWatch), 17, 'Leaving the page stops location capture');
  assert.match(await page.locator('.cp-location-status').innerText(), /stopped when you left/);
  await page.evaluate(() => {
    window.locationCallback({ coords: { latitude: 1, longitude: 2, accuracy: 5 }, timestamp: Date.now() });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('.cp-location-result').count(), 0, 'Hidden-page callbacks cannot record a location');
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  await page.evaluate(() => { window.clearedWatch = null; });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  assert.equal(await page.evaluate(() => window.clearedWatch), 17, 'Leaving the details step stops location capture');
  await page.evaluate(() => window.locationCallback({ coords: { latitude: 1, longitude: 2, accuracy: 5 }, timestamp: Date.now() }));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  assert.equal(await page.locator('.cp-location-result').count(), 0, 'An inactive-step callback cannot record a location');
  assert.equal(submissions.length, 0);
  await page.evaluate(() => { window.locationMode = 'timeout'; });
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  assert.match(await page.locator('.cp-location-status').innerText(), /timed out/i);
  await staysOnDetails();
  await page.evaluate(() => { window.locationMode = 'success'; });
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  assert.equal(await page.evaluate(() => window.locationOptions.enableHighAccuracy), true);
  assert.match(await page.locator('.cp-location-result').first().innerText(), /40\.700000/);
  assert.match(await page.locator('.cp-location-result').first().innerText(), /Device-reported accuracy/);
  await page.getByRole('button', { name: 'Use this location', exact: true }).click();
  assert.equal(await page.evaluate(() => window.clearedWatch), 17);
  await page.getByRole('button', { name: 'Remove location', exact: true }).click();
  await staysOnDetails();
  await page.getByRole('button', { name: 'Share current location', exact: true }).click();
  await page.evaluate(() => window.locationCallback({ coords: { latitude: 40.71, longitude: -74.01, accuracy: 10 }, timestamp: Date.now() }));
  assert.match(await page.locator('.cp-location-result').first().innerText(), /40\.710000/);
  await page.getByRole('button', { name: 'Use this location', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Review your request', exact: true }).waitFor();
  if (submissions.length === 0) assert.match(await page.locator('.cp-step:not([hidden]) .cp-location-result').innerText(), /40\.710000/);
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await page.waitForFunction(() => window.submitted);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].received_package, false);
  assert.equal(submissions[0].location.latitude, 40.71);
  assert.equal(submissions[0].location.accuracy_meters, 10);
  await details('Items are missing from my package', true);
  assert.match(await page.locator('.cp-location').innerText(), /Optional/);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { name: 'Review your request', exact: true }).waitFor();
  if (submissions.length === 0) assert.match(await page.locator('.cp-step:not([hidden]) .cp-location-result').innerText(), /40\.710000/);
  await page.getByRole('button', { name: 'Submit request', exact: true }).click();
  await page.waitForFunction(() => window.submitted);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[1].location, null);
  assert.equal(submissions[1].received_package, true);
  assert.deepEqual(errors, []);
  await page.close();
  for (const device of [
    { name: 'desktop', viewport: { width: 1280, height: 1000 }, userAgent: 'Mozilla/5.0 desktop', defaultTab: 'iOS' },
    { name: 'android', viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36', defaultTab: 'Android' },
  ]) {
    page = await browser.newPage({ viewport: device.viewport, userAgent: device.userAgent });
    page.on('pageerror', error => errors.push(error.message));
    await mockLocation(page);
    await details('My order is marked complete, but I have not received my package');
    await page.getByRole('button', { name: 'Share current location', exact: true }).click();
    assert.equal(await page.locator('.cp-location-help').evaluate(element => element.open), true, 'Denied access expands the English permission guide');
    assert.equal(await page.getByRole('tab', { selected: true }).innerText(), device.defaultTab);
    for (const tab of ['iOS', 'Android']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const guide = page.locator('.cp-location-guide-image img');
      await guide.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => { const image = document.querySelector('.cp-location-guide-image img'); return image.complete && image.naturalWidth > 0; });
      assert.match(await guide.getAttribute('src'), tab === 'iOS' ? /-ios\.png$/ : /-android\.png$/);
      await page.getByRole('button', { name: 'Enlarge image', exact: true }).click();
      assert.equal(await page.locator('.cp-location-guide-image').evaluate(element => element.scrollWidth > element.clientWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Image enlargement must not widen the page');
      await page.getByRole('button', { name: 'Fit image', exact: true }).click();
    }
    // Translators detach React text nodes. Exercise both tab branches after this mutation.
    for (const tab of ['iOS', 'Android']) {
      await page.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector('.cp-location-help'), NodeFilter.SHOW_TEXT);
        const texts = [];
        while (walker.nextNode()) if (walker.currentNode.textContent.trim() && !walker.currentNode.parentElement.closest('font, svg')) texts.push(walker.currentNode);
        for (const text of texts) {
          const outer = document.createElement('font'), inner = document.createElement('font');
          inner.textContent = text.textContent; outer.append(inner); text.replaceWith(outer);
        }
      });
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.waitForTimeout(50);
      assert.deepEqual(errors, [], 'Translated location-guide tabs must not crash React');
      assert.equal(await page.locator('.cp-location-help-steps li').count(), 3);
    }
    await page.getByRole('tab', { name: 'Android', exact: true }).press('ArrowLeft');
    assert.equal(await page.getByRole('tab', { selected: true }).innerText(), 'iOS');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'iOS');
    if (process.env.LOCATION_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.LOCATION_SCREENSHOT_DIR, { recursive: true });
      await page.locator('.cp-location-help').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.LOCATION_SCREENSHOT_DIR, `${device.name}-guide.png`) });
    }
    await page.evaluate(() => { window.locationMode = 'success'; });
    await page.getByRole('button', { name: 'Try location again', exact: true }).click();
    assert.match(await page.locator('.cp-location-result').first().innerText(), /Latitude\s+40\.700000[\s\S]*Longitude\s+-74\.000000[\s\S]*Device-reported accuracy\s+About 25 m/);
    assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true, 'A provisional reading cannot be submitted');
    await page.getByRole('button', { name: 'Use this location', exact: true }).click();
    if (process.env.LOCATION_SCREENSHOT_DIR) {
      await page.locator('.cp-location-result').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.LOCATION_SCREENSHOT_DIR, `${device.name}-coordinates.png`) });
    }
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Review your request', exact: true }).waitFor();
    assert.match(await page.locator('.cp-step:not([hidden]) .cp-location-result').innerText(), /40\.700000[\s\S]*-74\.000000[\s\S]*About 25 m/);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: required/optional location, explicit consent, permission failures, fresh coordinates, candidate confirmation, hidden-page and inactive-step cleanup, translated permission tabs, both tutorial images, zoom, keyboard navigation and review on desktop/mobile. Isolated fixture only.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server?.close(); });
