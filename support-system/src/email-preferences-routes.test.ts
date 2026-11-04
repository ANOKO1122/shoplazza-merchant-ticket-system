import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createEmailPreferencesRouter, type EmailPreferenceService, type EmailPreferenceView } from './email-preferences-routes';
import { protectionHostBoundary } from './protection-host';
const ticketToken = `eu_${'a'.repeat(43)}`, protectionToken = `eu_${'b'.repeat(43)}`, forgedToken = `eu_${'c'.repeat(43)}`;
type Response = { status: number; body: string; headers: IncomingHttpHeaders };
async function fixture(run: (f: { send: (method: string, host: string, path: string, body?: string, headers?: Record<string, string>) => Promise<Response>; lookups: string[]; mutations: string[]; globalErrors: unknown[]; values: Map<string, EmailPreferenceView>; setTicketBase: (value: string) => void; fail: () => void }) => Promise<void>) {
  const values = new Map<string, EmailPreferenceView>([[ticketToken, { category: 'ticket', email_masked: 'm•••@e•••.com', unsubscribed: false }], [protectionToken, { category: 'protection', email_masked: 'm•••@e•••.com', unsubscribed: false }]]);
  const lookups: string[] = [], mutations: string[] = [];
  const globalErrors: unknown[] = [];
  let ticketBase = 'https://tickets.example.test', failed = false;
  const service: EmailPreferenceService = {
    async get(raw) { if (failed) throw new Error(`private diagnostic ${ticketToken}`); lookups.push(String(raw)); return values.get(String(raw)) || null; },
    async unsubscribe(raw) { mutations.push(String(raw)); const current = values.get(String(raw)); if (!current) return null; const next = { ...current, unsubscribed: true }; values.set(String(raw), next); return next; },
  };
  const app = express(); app.use(protectionHostBoundary);
  app.use('/email-preferences', createEmailPreferencesRouter({ getTicketPublicBaseUrl: async () => ticketBase, service }));
  app.use(express.json({ limit: '512kb' }));
  app.get('/api/admin/me', (_req, res) => res.send('Staff route'));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { globalErrors.push(error); res.sendStatus(500); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const send = (method: string, host: string, path: string, body?: string, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: host, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body)), Origin: `http://${host}` } : {}), ...headers } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body: text, headers: response.headers }));
    }); req.on('error', reject); if (body) req.write(body); req.end();
  });
  try { await run({ send, lookups, mutations, globalErrors, values, setTicketBase: value => { ticketBase = value; }, fail: () => { failed = true; } }); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const form = (token: string) => new URLSearchParams({ token, confirm: 'unsubscribe' }).toString();
test('production preference router rejects bodies before the global JSON parser can log capabilities', () => {
  const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
  const preferences = source.indexOf("app.use('/email-preferences'");
  const parser = source.indexOf('app.use(express.json(');
  assert.ok(preferences >= 0 && parser >= 0 && preferences < parser);
});
test('malformed JSON carrying a token never reaches global error logging or preference services', async () => fixture(async ({ send, lookups, mutations, globalErrors }) => {
  const response = await send('POST', 'tickets.example.test', '/email-preferences', `{"token":"${ticketToken}",`, { 'Content-Type': 'application/json' });
  assert.equal(response.status, 415);
  assert.doesNotMatch(response.body, /eu_[A-Za-z0-9_-]{43}/);
  assert.deepEqual(globalErrors, []); assert.deepEqual(lookups, []); assert.deepEqual(mutations, []);
}));
test('email-scanner GET and HEAD only show scoped confirmation with private page headers', async () => fixture(async ({ send, mutations }) => {
  for (const [host, token, category, other] of [['tickets.example.test', ticketToken, 'all ticket-related emails', 'Shipping protection emails'], ['us-seel.com', protectionToken, 'all shipping protection emails', 'Ticket-related emails']]) {
    const response = await send('GET', host, `/email-preferences?token=${token}`);
    assert.equal(response.status, 200); assert.match(response.body, new RegExp(category)); assert.match(response.body, new RegExp(`${other} are unaffected`));
    assert.match(response.body, /m•••@e•••\.com/); assert.match(response.body, /method="post" action="\/email-preferences"/);
    assert.match(response.body, /Website access, tickets, and shipping protection requests are unchanged/);
    assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['referrer-policy'], 'no-referrer'); assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(String(response.headers['content-security-policy']), /default-src 'none'/); assert.doesNotMatch(response.body, /<script|contact support|mailto:|https?:\/\//i);
    assert.equal((await send('HEAD', host, `/email-preferences?token=${token}`)).status, 200);
  }
  assert.deepEqual(mutations, []);
}));
test('confirmation changes only the token category and repeating it is idempotent', async () => fixture(async ({ send, mutations, values }) => {
  for (let n = 0; n < 2; n++) {
    const response = await send('POST', 'tickets.example.test', '/email-preferences', form(ticketToken));
    assert.equal(response.status, 200); assert.match(response.body, /You’re unsubscribed/); assert.match(response.body, /Shipping protection emails are unaffected/); assert.doesNotMatch(response.body, /<form|eu_[A-Za-z0-9_-]{43}/);
  }
  assert.deepEqual(mutations, [ticketToken]); assert.equal(values.get(ticketToken)?.unsubscribed, true); assert.equal(values.get(protectionToken)?.unsubscribed, false);
  const revisit = await send('GET', 'tickets.example.test', `/email-preferences?token=${ticketToken}`); assert.match(revisit.body, /You’re unsubscribed/); assert.doesNotMatch(revisit.body, /<form/);
}));
test('hosts resolve only their own category while the customer host still blocks staff routes', async () => fixture(async ({ send, mutations }) => {
  for (const [host, token] of [['us-seel.com', ticketToken], ['tickets.example.test', protectionToken], ['us-seel.com.evil.invalid', protectionToken], ['unrelated.example.test', ticketToken]]) {
    const response = await send('GET', host, `/email-preferences?token=${token}`); assert.equal(response.status, 404); assert.doesNotMatch(response.body, /m•••|eu_[A-Za-z0-9_-]{43}/);
    assert.equal((await send('POST', host, '/email-preferences', form(token))).status, 404);
  }
  assert.equal((await send('GET', 'us-seel.com', '/api/admin/me')).status, 404); assert.equal((await send('GET', 'us-seel.com', '/email-preferences/admin')).status, 404); assert.deepEqual(mutations, []);
}));
test('host validation follows the effective ticket base including an administrator override', async () => fixture(async ({ send, setTicketBase }) => {
  setTicketBase('https://custom.example.test'); assert.equal((await send('GET', 'tickets.example.test', `/email-preferences?token=${ticketToken}`)).status, 404); assert.equal((await send('GET', 'custom.example.test', `/email-preferences?token=${ticketToken}`)).status, 200);
}));
test('missing, forged, duplicate and extra fields cannot choose a recipient or category', async () => fixture(async ({ send, lookups, mutations }) => {
  for (const query of ['', '?token=bad', `?token=${ticketToken}&token=${protectionToken}`, `?token=${ticketToken}&email=another%40example.test`, `?token=${ticketToken}&category=protection`]) assert.equal((await send('GET', 'tickets.example.test', '/email-preferences' + query)).status, 400);
  assert.equal(lookups.length, 0); assert.equal((await send('GET', 'tickets.example.test', `/email-preferences?token=${forgedToken}`)).status, 404);
  for (const body of [`token=${ticketToken}`, form(ticketToken) + '&category=protection', form(ticketToken) + '&email=another%40example.test', form(ticketToken) + `&token=${protectionToken}`]) assert.equal((await send('POST', 'tickets.example.test', '/email-preferences', body)).status, 400);
  assert.deepEqual(mutations, []);
}));
test('cross-site, non-form, oversized and unsupported requests cannot unsubscribe', async () => fixture(async ({ send, mutations }) => {
  assert.equal((await send('POST', 'tickets.example.test', '/email-preferences', form(ticketToken), { Origin: 'https://outside.example.test' })).status, 403);
  assert.equal((await send('POST', 'tickets.example.test', '/email-preferences', form(ticketToken), { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send('POST', 'tickets.example.test', '/email-preferences', form(ticketToken), { Origin: 'null' })).status, 403);
  assert.equal((await send('POST', 'tickets.example.test', '/email-preferences', JSON.stringify({ token: ticketToken, confirm: 'unsubscribe' }), { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await send('POST', 'tickets.example.test', '/email-preferences', `token=${'x'.repeat(3000)}&confirm=unsubscribe`)).status, 413);
  assert.equal((await send('PUT', 'tickets.example.test', '/email-preferences', form(ticketToken))).status, 405); assert.deepEqual(mutations, []);
}));
test('no-referrer native forms may use an opaque Origin only with same-origin browser metadata', async () => fixture(async ({ send, mutations }) => {
  const response = await send('POST', 'tickets.example.test', '/email-preferences', form(ticketToken), { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(response.status, 200);
  assert.match(response.body, /You’re unsubscribed/);
  assert.deepEqual(mutations, [ticketToken]);
}));
test('masked text is escaped and failures do not reveal token diagnostics', async () => fixture(async ({ send, values, fail }) => {
  values.set(ticketToken, { category: 'ticket', email_masked: '<svg/onload=alert(1)>', unsubscribed: false });
  const response = await send('GET', 'tickets.example.test', `/email-preferences?token=${ticketToken}`); assert.match(response.body, /&lt;svg\/onload=alert\(1\)&gt;/); assert.doesNotMatch(response.body, /<svg\/onload/);
  fail(); const failed = await send('GET', 'tickets.example.test', `/email-preferences?token=${ticketToken}`); assert.equal(failed.status, 503); assert.doesNotMatch(failed.body, /private diagnostic|eu_[A-Za-z0-9_-]{43}/);
}));
