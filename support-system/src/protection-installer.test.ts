import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProtectionManifest, redactInstallerOutput, parseInstallerResult } from './protection-installer';

test('installer rejects cross-store and path-injected configuration', () => {
  const manifest = { store: 'pilot.myshoplaza.com', shopId: '123', themeId: 'theme-a', themeFamily: 'hero', asset: 'protection.js', products: [{ id: 'p1', handle: 'protection-low' }], tiers: [{ productId: 'p1', variantId: 'v1', cents: 200 }], hostnames: ['pilot.myshoplaza.com'], enabled: true };
  assert.doesNotThrow(() => validateProtectionManifest(manifest, manifest.store));
  assert.throws(() => validateProtectionManifest(manifest, 'other.myshoplaza.com'));
  assert.throws(() => validateProtectionManifest({ ...manifest, asset: '../../secrets.js' }, manifest.store));
  assert.throws(() => validateProtectionManifest({ ...manifest, themeFamily: 'unknown' }, manifest.store));
});

test('installer log redaction removes credentials and bounds diagnostic size', () => {
  const result = redactInstallerOutput('error token-secret Authorization: Bearer token-secret ' + 'x'.repeat(5000), 'token-secret');
  assert.ok(!result.includes('token-secret'));
  assert.ok(result.length <= 2000);
  assert.equal(redactInstallerOutput('Authorization: Bearer unknown-token', ''), 'Authorization=[redacted]');
});

test('only explicit final worker results count as verified health', () => {
  assert.equal(parseInstallerResult('noise\n' + JSON.stringify({ protection_result: true, health: 'healthy', message: 'verified' })).health, 'healthy');
  assert.throws(() => parseInstallerResult('{"ok":true}'));
  assert.throws(() => parseInstallerResult('{"protection_result":true,"health":"made-up"}'));
});
