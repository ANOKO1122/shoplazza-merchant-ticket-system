import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const BASE = 'https://support.example.invalid';
const TOPICS = ['orders/paid', 'orders/fulfilled', 'orders/partially_fulfilled', 'fulfillments/create',
  'fulfillments/update', 'orders/partially_refunded', 'orders/refunded', 'orders/cancelled', 'orders/finished'];
type Webhook = { id: string; address: string; topic: string };

async function runScript(mode: '--check' | '--apply', options: {
  ownedRetired?: boolean; deleteFails?: boolean; retainAfterDelete?: boolean;
} = {}) {
  // Load the real address comparison with fixture-only authentication and no environment files.
  const securityModule = { exports: {} };
  const securitySource = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'webhook-security.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(securitySource, {
    module: securityModule, exports: securityModule.exports, URL,
    process: { env: { SUPPORT_WEBHOOK_SECRET: 'offline-fixture-only' } },
    require(name: string) {
      if (name === 'crypto') return crypto;
      if (name === './config') return { buildStoreDomain: (subdomain: string) => `${subdomain}.myshoplaza.com` };
      throw new Error(`Unexpected security dependency: ${name}`);
    },
  });
  const security = securityModule.exports as typeof import('./webhook-security');
  const expected = security.buildWebhookCallbackUrl(BASE, 'fixture-store');
  let webhooks: Webhook[] = TOPICS.map((topic, index) => ({ id: `active-${index}`, address: expected, topic }));
  const external: Webhook[] = [
    { id: 'analytics-host', address: 'https://analytics.example.invalid/webhook', topic: 'orders/update' },
    { id: 'analytics-path', address: `${BASE}/api/analytics/webhook/fixture-store`, topic: 'orders/update' },
    { id: 'another-store', address: `${BASE}/api/shoplazza/webhook/other-store`, topic: 'orders/update' },
  ];
  webhooks.push(...external);
  if (options.ownedRetired) webhooks.push(
    { id: 'owned-update', address: `${BASE}/api/shoplazza/webhook/fixture-store?key=old-fixture-key`, topic: 'orders/update' },
    { id: 'owned-create', address: expected, topic: 'orders/create' },
  );
  const fakeProcess = { argv: ['node', 'secure-webhooks.js', mode], exitCode: 0 };
  const output: string[] = [];
  const mutations: string[] = [];
  let closed = false;
  const dependencies: Record<string, unknown> = {
    dotenv: { config: () => ({}) },
    '../dist/store-service': { getEnabledStores: async () => [{ subdomain: 'fixture-store', store_name: 'Fixture', access_token: 'offline-only' }] },
    '../dist/pg': { getPool: () => ({ end: async () => { closed = true; } }) },
    '../dist/email-service': { getEffectivePublicBaseUrl: async () => BASE },
    '../dist/webhook-security': security,
    '../dist/shoplazza-client': {
      STORE_WEBHOOK_TOPICS: TOPICS, RETIRED_WEBHOOK_TOPICS: ['orders/create', 'orders/update'],
      listWebhooks: async () => ({ ok: true, webhooks: webhooks.map(webhook => ({ ...webhook })) }),
      registerWebhook: async () => { mutations.push('register'); throw new Error('No registration should be needed'); },
      updateWebhookAddress: async () => { mutations.push('update'); throw new Error('No address update should be needed'); },
      deleteWebhook: async (_store: unknown, id: string) => {
        mutations.push(`delete:${id}`);
        if (options.deleteFails) return { ok: false, error: `private provider response: ${expected}` };
        if (!options.retainAfterDelete) webhooks = webhooks.filter(webhook => webhook.id !== id);
        return { ok: true };
      },
    },
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/secure-webhooks.js'), 'utf8'), {
    process: fakeProcess, console: { log: (message: string) => output.push(message), error: (message: string) => output.push(message) },
    require(name: string) {
      assert.ok(name in dependencies, `Live API, database, or environment dependency forbidden: ${name}`);
      return dependencies[name];
    },
  }, { filename: 'secure-webhooks.js' });
  assert.equal(closed, true, 'the script must close its database pool on success and failure');
  return { exitCode: fakeProcess.exitCode, webhooks, external, mutations, output: output.join('\n') };
}

test('apply removes only retired subscriptions owned by this support callback', async () => {
  const result = await runScript('--apply', { ownedRetired: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.webhooks.length, 12);
  assert.deepEqual(result.webhooks.filter(webhook => webhook.topic === 'orders/update'), result.external);
  assert.ok(!result.webhooks.some(webhook => webhook.id.startsWith('owned-')));
  assert.equal(result.webhooks.filter(webhook => webhook.id.startsWith('active-')).length, 9);
});

test('check rejects owned retired subscriptions without mutating any subscription', async () => {
  const result = await runScript('--check', { ownedRetired: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /retired.*orders\/update/i);
  assert.deepEqual(result.mutations, []);
  assert.ok(result.webhooks.some(webhook => webhook.id === 'owned-update'));
});

test('failed deletion exits unsuccessfully without exposing provider callback credentials', async () => {
  const result = await runScript('--apply', { ownedRetired: true, deleteFails: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /orders\/update/);
  assert.doesNotMatch(result.output, /private provider|[?&]key=/);
  assert.ok(result.webhooks.some(webhook => webhook.id === 'owned-update'));
});

test('apply verifies the retired subscription actually disappeared after successful deletion', async () => {
  const result = await runScript('--apply', { ownedRetired: true, retainAfterDelete: true });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /verification failed/i);
});

test('check allows analytics subscriptions for retired support topics', async () => {
  const result = await runScript('--check');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.mutations, []);
  assert.deepEqual(result.webhooks.filter(webhook => webhook.topic === 'orders/update'), result.external);
});
