import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { get, type IncomingHttpHeaders } from 'node:http';
import { isProtectionHost, isProtectionPublicPath, protectionHostBoundary, protectionPageHeaders } from './protection-host';

test('customer host has an explicit page/asset/API allowlist', () => {
  assert.equal(isProtectionHost('us-seel.com'), true);
  assert.equal(isProtectionHost('us-seel.com:443'), true);
  assert.equal(isProtectionHost('us-seel.com.evil.invalid'), false);
  assert.equal(isProtectionHost('server.clientservice-center.com'), false);
  for (const path of ['/', '/protection', '/email-preferences', '/assets/customer-protection.js', '/assets/customer-protection.css', '/api/protection/order', '/api/protection/claims/CL-123/messages']) {
    assert.equal(isProtectionPublicPath(path), true, path);
  }
  for (const path of ['/thinkpro-admin', '/api/admin/me', '/api/support/tickets', '/uploads/a.png', '/login', '/admin.html', '/assets/admin.js', '/api/protection/../admin/me', '/api/protection/%2e%2e/admin/me', '//api/protection/order', '/email-preferences/admin', '/email-preferences/', '/email-preferences.html']) {
    assert.equal(isProtectionPublicPath(path), false, path);
  }
});

test('customer pages allow their own camera and keep microphone and unrelated routes blocked', async () => {
  const app = express();
  app.use(protectionHostBoundary);
  app.get('/protection', protectionPageHeaders, (_req, res) => res.send('Customer page'));
  app.get('/api/admin/me', (_req, res) => res.send('Staff only'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const customerRequest = (path: string) => new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
      get(`${base}${path}`, { headers: { Host: 'us-seel.com' } }, response => {
        response.resume();
        response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers }));
      }).once('error', reject);
    });
    const page = await customerRequest('/protection');
    assert.equal(page.status, 200);
    assert.equal(page.headers['permissions-policy'], 'geolocation=(self), camera=(self), microphone=()');
    assert.match(String(page.headers['content-security-policy'] || ''), /media-src 'self' blob:/);
    assert.equal((await customerRequest('/api/admin/me')).status, 404);
    const preview = await fetch(`${base}/protection`);
    assert.equal(preview.headers.get('permissions-policy'), 'geolocation=(self), camera=(self), microphone=()');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
