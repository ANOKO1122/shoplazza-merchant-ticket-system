import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import express from 'express';
import ts from 'typescript';
import { Pool } from 'pg';
import { EMAIL_PREFERENCES_SCHEMA_SQL } from './email-preferences-schema';
import { createEmailPreferencesAdminRouter, listEmailPreferences, parseEmailPreferenceFilters } from './email-preferences-admin-routes';

const empty = { items: [], total: 0, page: 1, page_size: 25, summary: { email_count: 0, ticket_count: 0, protection_count: 0 } };

test('admin filters accept a partial address and bounded pagination, rejecting ambiguous or malformed inputs', () => {
  assert.deepEqual(parseEmailPreferenceFilters({}), { q: '', category: 'all', page: 1, page_size: 25 });
  assert.deepEqual(parseEmailPreferenceFilters({ q: ' Buyer+Tag@ ', category: 'protection', page: '2', page_size: '10' }), { q: 'Buyer+Tag@', category: 'protection', page: 2, page_size: 10 });
  for (const value of [{ category: 'unknown' }, { category: ['ticket', 'protection'] }, { q: ['a', 'b'] }, { q: 'x'.repeat(255) }, { q: 'a\nb' }, { page: '0' }, { page: '1e2' }, { page: '-2' }, { page_size: '101' }, { page_size: '0' }, { page: '999999999999999999' }]) {
    assert.throws(() => parseEmailPreferenceFilters(value));
  }
});

async function httpFixture(run: (base: string, calls: unknown[]) => Promise<void>, fail = false) {
  const calls: unknown[] = [];
  const app = express();
  // Load the actual parent router to verify that the new child cannot bypass its auth middleware.
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'admin-routes.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const pass: express.RequestHandler = (_req, _res, next) => next();
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name: string) {
      if (name === 'express') return express;
      if (name === 'crypto') return crypto;
      if (name === 'express-rate-limit') return () => pass;
      if (name === './auth') return { getRequestAgent: async (req: express.Request) => req.get('Cookie') === 'fixture=yes' ? { agentId: 7 } : null };
      if (name === './storage-service') return { uploadAttachments: pass };
      if (name === './email-preferences-admin-routes') return { createEmailPreferencesAdminRouter: () => createEmailPreferencesAdminRouter({ list: async filters => { calls.push(filters); if (fail) throw new Error('private SQL/connection detail'); return empty; } }) };
      if (name.startsWith('./')) return {};
      throw new Error(`Unexpected live dependency: ${name}`);
    },
  });
  app.use('/api/admin', (module.exports as typeof import('./admin-routes')).createAdminRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  try { await run(`http://127.0.0.1:${address.port}`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('preference listing uses staff authentication, validates filters and returns a non-cacheable read-only response', async () => {
  await httpFixture(async (base, calls) => {
    const anonymous = await fetch(base + '/api/admin/email-preferences');
    assert.equal(anonymous.status, 401); assert.equal(calls.length, 0);
    const headers = { Cookie: 'fixture=yes' };
    const listed = await fetch(base + '/api/admin/email-preferences?category=ticket&q=Buyer&page=2&page_size=10', { headers });
    assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await listed.json(), { ok: true, ...empty });
    assert.deepEqual(calls, [{ q: 'Buyer', category: 'ticket', page: 2, page_size: 10 }]);
    const invalid = await fetch(base + '/api/admin/email-preferences?category=ticket&category=protection', { headers });
    assert.equal(invalid.status, 400); assert.equal(calls.length, 1);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await fetch(base + '/api/admin/email-preferences', { method, headers })).status, 405);
    }
    assert.equal(calls.length, 1);
  });
});

test('database errors do not disclose connection or query details to the staff browser', async () => {
  await httpFixture(async base => {
    const response = await fetch(base + '/api/admin/email-preferences', { headers: { Cookie: 'fixture=yes' } });
    assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /private SQL|connection detail/);
  }, true);
});

const databaseUrl = process.env.SUPPORT_EMAIL_PREFERENCES_ADMIN_TEST_DATABASE_URL;
test('real preference listing groups both systems, preserves timestamps and paginates searched records without exposing capabilities', { skip: !databaseUrl }, async () => {
  assert.match(new URL(databaseUrl!).pathname, /_test$/);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(EMAIL_PREFERENCES_SCHEMA_SQL);
    await pool.query('TRUNCATE support_email_preferences, support_email_unsubscribe_tokens');
    await pool.query(`INSERT INTO support_email_preferences(category,email,unsubscribed_at) VALUES
      ('ticket','both@example.invalid','2026-11-01T01:00:00Z'),
      ('protection','both@example.invalid','2026-11-04T01:00:00Z'),
      ('ticket','ticket@example.invalid','2026-11-03T01:00:00Z'),
      ('protection','protection@example.invalid','2026-11-02T01:00:00Z'),
      ('ticket','percent%_tag@example.invalid','2026-11-01T02:00:00Z')`);
    await pool.query("INSERT INTO support_email_unsubscribe_tokens(token_hash,category,email) VALUES('PRIVATE_HASH','ticket','token-only@example.invalid')");
    const list = (filters: Record<string, unknown>) => listEmailPreferences(parseEmailPreferenceFilters(filters), pool);
    const all = await list({});
    assert.equal(all.total, 4); assert.equal(all.items.length, 4);
    assert.deepEqual(all.summary, { email_count: 4, ticket_count: 3, protection_count: 2 });
    assert.equal(all.items[0].email, 'both@example.invalid');
    assert.equal(Date.parse(all.items[0].ticket_unsubscribed_at!), Date.parse('2026-11-01T01:00:00Z'));
    assert.equal(Date.parse(all.items[0].protection_unsubscribed_at!), Date.parse('2026-11-04T01:00:00Z'));
    assert.equal(all.items[1].protection_unsubscribed_at, null);
    assert.doesNotMatch(JSON.stringify(all), /PRIVATE_HASH|token_hash|token-only/);
    const protection = await list({ category: 'protection' });
    assert.deepEqual(protection.items.map(item => item.email), ['both@example.invalid', 'protection@example.invalid']);
    assert.equal(protection.total, 2); assert.deepEqual(protection.summary, all.summary);
    assert.equal((await list({ q: 'BOTH@EXAMPLE' })).total, 1);
    assert.deepEqual((await list({ q: '%_' })).items.map(item => item.email), ['percent%_tag@example.invalid']);
    assert.equal((await list({ q: '\\' })).total, 0);
    assert.equal((await list({ q: "' OR 1=1 --" })).total, 0);
    assert.equal((await list({ q: 'both', category: 'ticket' })).items[0].protection_unsubscribed_at, all.items[0].protection_unsubscribed_at);
    const second = await list({ page: '2', page_size: '1' });
    assert.equal(second.items[0].email, 'ticket@example.invalid'); assert.equal(second.total, 4);
    assert.deepEqual((await list({ page: '8', page_size: '1' })).items, []);
    const missing = await list({ q: 'absent' }); assert.equal(missing.total, 0); assert.deepEqual(missing.items, []); assert.deepEqual(missing.summary, all.summary);
    assert.equal(Number((await pool.query('SELECT count(*) FROM support_email_preferences')).rows[0].count), 5, 'listing must not change preferences');
  } finally { await pool.end(); }
});
