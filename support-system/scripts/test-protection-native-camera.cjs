// Isolated mobile Chrome camera flow. API routes are mocked; no customer order is changed.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const captureId = '10c83620-b938-4c13-a5d4-93c6737a1877';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', 'base64');
let server, browser;
(async () => {
  const bundle = await build({ absWorkingDir: root, stdin: { contents: `
    import { createRoot } from 'react-dom/client';
    import { CameraEvidence } from './frontend/customer-protection/CameraEvidence';
    import './frontend/customer-protection/styles.css';
    createRoot(document.getElementById('root')).render(<dialog className="cp-dialog" open><div className="cp-dialog-content"><CameraEvidence active requireDamaged limits={{max_files:6,max_file_bytes:26214400,max_total_bytes:104857600}} onChange={files=>{window.attachedFiles=files}} onBlocked={()=>{}} preserve={{current:true}} /></div></dialog>);
  `, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, outfile: 'camera.js', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  server = http.createServer((req, res) => {
    if (['protection-photo-guidelines.png', 'protection-camera-ios.png', 'protection-camera-android.png'].some(name => req.url === `/assets/${name}`)) {
      res.setHeader('Content-Type', 'image/png');
      return res.end(fs.readFileSync(path.join(root, 'public', req.url)));
    }
    const asset = bundle.outputFiles.find(file => path.basename(file.path) === req.url?.slice(1));
    res.setHeader('Content-Type', asset ? req.url.endsWith('.css') ? 'text/css' : 'text/javascript' : 'text/html');
    res.end(asset ? asset.contents : '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/camera.css"><div id="root"></div><script src="/camera.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' });
  const errors = []; let uploaded = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/protection/capture-sessions', route => route.fulfill({ status: 201, json: { ok: true, capture: { id: captureId, category: 'damaged_item', expires_at: '2099-01-01T00:00:00Z' } } }));
  await page.route('**/api/protection/evidence', route => {
    const body = route.request().postDataBuffer().toString();
    assert.match(body, /capture_id/); assert.match(body, new RegExp(captureId)); uploaded = true;
    return route.fulfill({ json: { ok: true, evidence: { id: 'photo-1', kind: 'image', original_name: 'damage.png', size_bytes: png.length, url: '/api/protection/evidence/photo-1', source: 'camera', capture: { category: 'damaged_item', requested_at: '2026-11-09T00:00:00Z', received_at: '2026-11-09T00:01:00Z' } } } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.locator('.cp-capture-rail').evaluate(element => element.scrollWidth > element.clientWidth), true, 'Photo types scroll horizontally on a phone');
  const guidelines = page.getByRole('button', { name: 'Photo guidelines' });
  await guidelines.hover();
  assert.equal(await page.locator('.cp-photo-guide-panel').isVisible(), true, 'Mouse hover shows the photo guide');
  await page.locator('.cp-photo-guide-image img').evaluate(async image => { await image.decode(); });
  await page.mouse.move(0, 0);
  await guidelines.click();
  assert.equal(await page.locator('.cp-photo-guide-panel').isVisible(), true, 'Click keeps the guide open for touch and keyboard users');
  await page.getByRole('button', { name: 'Close guide' }).click();
  await page.getByText('Camera permission help').click();
  assert.equal(await page.getByRole('tab', { name: 'Android' }).getAttribute('aria-selected'), 'true');
  await page.locator('.cp-camera-guide-image img:not([hidden])').evaluate(async image => { await image.decode(); });
  await page.getByRole('tab', { name: 'iOS' }).click();
  await page.locator('.cp-camera-guide-image img:not([hidden])').evaluate(async image => { await image.decode(); });
  await page.getByRole('button', { name: 'Enlarge image' }).click();
  assert.equal(await page.locator('.cp-camera-guide-image').evaluate(element => element.scrollWidth > element.clientWidth), true);
  await page.getByRole('button', { name: 'Fit image' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Guide and photo rail do not overflow the page');
  await page.screenshot({ path: '/tmp/protection-camera-guidance-mobile.png' });
  assert.equal(await page.locator('input[capture="environment"]').getAttribute('accept'), 'image/*');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open camera for damaged item' }).click();
  const chooser = await chooserPromise;
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await chooser.setFiles({ name: 'damage.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Use photo' }).waitFor();
  await page.getByRole('button', { name: 'Use photo' }).click();
  await page.waitForFunction(() => window.attachedFiles?.length === 1);
  const cancelledChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open camera for outer packaging' }).click();
  await cancelledChooser;
  await page.locator('input[capture="environment"]').dispatchEvent('cancel');
  assert.equal(await page.getByRole('button', { name: 'Open camera for damaged item' }).isEnabled(), true);
  assert.equal(uploaded, true); assert.deepEqual(errors, []);
  const desktop = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await desktop.goto(`http://127.0.0.1:${server.address().port}`);
  await desktop.screenshot({ path: '/tmp/protection-camera-guidance-desktop.png' });
  assert.equal(await desktop.locator('.cp-capture-rail').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Desktop keeps all photo types on one row');
  await desktop.close();
  console.log('Native camera handoff, background return, preview, capture upload and cancellation passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve) || resolve()); });
