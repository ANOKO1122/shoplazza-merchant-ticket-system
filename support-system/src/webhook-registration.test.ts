import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const STORE = { subdomain: 'fixture-store', storeName: 'Fixture', accessToken: 'fixture-access-token' };
const KEY = 'a1'.repeat(32);
const CALLBACK = `https://support.example.invalid/api/shoplazza/webhook/fixture-store?key=${KEY}`;

interface FetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

// Explicit dependency injection prevents this test from reaching a live API or database.
function clientWithFetch(fetch: (url: string, options: FetchOptions) => Promise<unknown>) {
  const output: unknown[][] = [];
  let clock = Date.parse('2026-10-23T09:00:00Z');
  class FixedDate extends Date {
    static now() { clock += 1000; return clock; }
  }
  const code = ts.transpileModule(
    fs.readFileSync(path.resolve(__dirname, '../src/shoplazza-client.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } },
  ).outputText;
  const dependencies: Record<string, unknown> = {
    'node-fetch': fetch,
    './config': { buildApiHost: () => 'api.example.invalid' },
  };
  const module = { exports: {} };
  const capture = (...args: unknown[]) => { output.push(args); };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    console: { log: capture, warn: capture, error: capture },
    Date: FixedDate, URLSearchParams, AbortController, setTimeout, clearTimeout,
  }, { filename: 'shoplazza-client.ts' });
  return { client: module.exports as typeof import('./shoplazza-client'), output };
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('updating a callback preserves its original topic and subscription id in the PUT request', async () => {
  const calls: Array<{ url: string; options: FetchOptions }> = [];
  const { client, output } = clientWithFetch(async (url, options) => {
    calls.push({ url, options });
    return response({ webhook: { address: CALLBACK } });
  });
  const topics = ['orders/paid', 'orders/fulfilled', 'orders/partially_fulfilled'];
  for (const topic of topics) {
    const id = `fixture/${topic}`;
    const result = await client.updateWebhookAddress(STORE, id, CALLBACK, topic);
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    const request = calls[calls.length - 1];
    assert.equal(request.url, `https://api.example.invalid/openapi/2025-06/webhooks/${encodeURIComponent(id)}`);
    assert.equal(request.options.method, 'PUT');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.equal(request.options.headers['Access-Token'], STORE.accessToken);
    assert.deepEqual(JSON.parse(request.options.body!), { id, webhook: { address: CALLBACK, topic } });
  }
  assert.equal(calls.length, topics.length);
  assert.ok(!JSON.stringify(output).includes(KEY), 'callback keys must not appear in console output');
});

test('upstream errors never echo callback credentials into the returned error or logs', async t => {
  for (const status of [400, 422, 500]) {
    await t.test(`HTTP ${status}`, async () => {
      const { client, output } = clientWithFetch(async () => response({
        error: `Topic is not allowed: ${CALLBACK}`,
        webhook: { address: CALLBACK },
      }, status));
      const result = await client.updateWebhookAddress(STORE, 'fixture-id', CALLBACK, 'orders/paid');
      assert.equal(result.ok, false);
      assert.match(result.error!, new RegExp(`HTTP ${status}`));
      assert.ok(!JSON.stringify({ result, output }).includes(KEY));
      assert.ok(!JSON.stringify({ result, output }).includes('Topic is not allowed'));
    });
  }
  const { client, output } = clientWithFetch(async () => { throw new Error(`network failure: ${CALLBACK}`); });
  const result = await client.updateWebhookAddress(STORE, 'fixture-id', CALLBACK, 'orders/paid');
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify({ result, output }).includes(KEY), 'network errors must also hide callback keys');
});
