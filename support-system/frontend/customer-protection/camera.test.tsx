import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CameraStreamGuard, damageEvidenceProblem } from './camera';
import { CameraEvidence, CameraException } from './CameraEvidence';
import { CameraPermissions } from './CameraPermissions';
import { Uploads } from './Uploads';
import type { CustomerEvidence } from '../../src/protection-customer-types';

function stream() { let stopped = 0; return { media: { getTracks: () => [{ stop() { stopped++; } }] } as unknown as MediaStream, count: () => stopped }; }
test('a camera permission resolving after leaving the step cannot keep the device active', async () => {
  const guard = new CameraStreamGuard();
  const camera = stream(); let resolve!: (value: MediaStream) => void;
  const opening = guard.open(() => new Promise<MediaStream>(done => { resolve = done; }));
  guard.stop(); resolve(camera.media);
  assert.equal(await opening, null);
  assert.equal(camera.count(), 1);
});
test('retaking, closing, or hiding a camera stops its previous tracks', async () => {
  const guard = new CameraStreamGuard(); const first = stream(); const second = stream();
  assert.equal(await guard.open(async () => first.media), first.media);
  assert.equal(await guard.open(async () => second.media), second.media);
  assert.equal(first.count(), 1);
  guard.stop(); guard.stop();
  assert.equal(second.count(), 1);
});
test('damage evidence needs the damaged item and cannot use ordinary uploads even with an exception', () => {
  const evidence = { id: 'photo', kind: 'image', original_name: 'photo.jpg', size_bytes: 100, url: '/api/protection/evidence/photo', source: 'camera', capture: { category: 'damaged_item', requested_at: '2026-11-03T12:00:00Z', received_at: '2026-11-03T12:01:00Z' } } as CustomerEvidence;
  assert.equal(damageEvidenceProblem([evidence], null), null);
  assert.ok(damageEvidenceProblem([], null));
  assert.ok(damageEvidenceProblem([{ ...evidence, capture: { ...evidence.capture!, category: 'shipping_label' } }], null));
  assert.equal(damageEvidenceProblem([], 'My camera is broken and cannot focus.'), null);
  assert.ok(damageEvidenceProblem([], 'broken'));
  assert.ok(damageEvidenceProblem([{ ...evidence, source: 'upload', capture: undefined }], 'My camera is broken and cannot focus.'));
});
test('camera evidence requests the phone camera while other issue types retain ordinary attachments', () => {
  const props = { limits: { max_files: 6, max_file_bytes: 25 * 1024 * 1024, max_total_bytes: 100 * 1024 * 1024 }, onChange: () => {}, onBlocked: () => {}, preserve: { current: false } };
  const camera = renderToStaticMarkup(<CameraEvidence {...props} active requireDamaged />);
  assert.match(camera, /type="file"[^>]*accept="image\/\*"[^>]*capture="environment"[^>]*hidden=""/);
  assert.ok(camera.includes('Open camera for damaged item'));
  assert.ok(camera.includes('Outer packaging') && camera.includes('Shipping label'));
  assert.ok(camera.includes('cp-capture-rail'));
  assert.ok(camera.includes('Photo guidelines'));
  assert.ok(camera.includes('/assets/protection-photo-guidelines.png'));
  assert.ok(camera.includes('Camera permission help'));
  assert.ok(renderToStaticMarkup(<Uploads {...props} />).includes('type="file"'));
});
test('camera permission help includes supplied iOS and Android guides', () => {
  const html = renderToStaticMarkup(<CameraPermissions />);
  assert.ok(html.includes('/assets/protection-camera-ios.png'));
  assert.ok(html.includes('/assets/protection-camera-android.png'));
  assert.ok(html.includes('Enlarge image'));
});
test('the camera exception field keeps its accessible name after a reason has been entered', () => {
  for (const value of ['', 'My camera lens is broken and cannot take pictures.']) {
    const html = renderToStaticMarkup(<CameraException value={value} onChange={() => {}} />);
    const label = html.match(/<span id="([^"]+)">Why you cannot use a camera<\/span>/);
    assert.ok(label, 'the visible label has its own text-only target');
    assert.ok(html.includes(`aria-labelledby="${label[1]}"`), 'the control references only the label, not the entered reason');
    assert.ok(html.includes(value));
  }
});
