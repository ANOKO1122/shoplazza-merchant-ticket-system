import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { PassThrough } from 'node:stream';
import { Response, RequestInit } from 'node-fetch';
import ts from 'typescript';

type Client = typeof import('./shoplazza-client');
const STORE = { subdomain: 'fixture', storeName: 'Fixture', accessToken: 'fixture-only' };

function isolatedClient(fetch: (url: string, init?: RequestInit) => Promise<Response>): Client {
  let clock = Date.parse('2026-10-26T12:00:00Z');
  class AdvancingDate extends Date {
    static now() { clock += 1000; return clock; }
  }
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/shoplazza-client.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name: string) {
      if (name === 'node-fetch') return fetch;
      if (name === './config') return { buildApiHost: () => 'fixture.invalid' };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    Date: AdvancingDate, URLSearchParams, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
  }, { filename: 'shoplazza-client.ts' });
  return module.exports as Client;
}

async function withinDeadline<T>(request: Promise<T>): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Response body did not time out')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

const cases: Array<{
  name: string;
  call: (client: Client) => Promise<unknown>;
  fallback: unknown;
  successBody: unknown;
  successResult: unknown;
}> = [
  {
    name: 'getOrderDetail', call: client => client.getOrderDetail(STORE, 'order-1'), fallback: null,
    successBody: { order: { id: 'order-1', order_number: 'ORDER-1' } },
    successResult: { id: 'order-1', order_number: 'ORDER-1' },
  },
  {
    name: 'getOrderByNumber', call: client => client.getOrderByNumber(STORE, 'ORDER-1'), fallback: null,
    successBody: { data: { order: { id: 'order-1', order_number: 'ORDER-1' } } },
    successResult: { id: 'order-1', order_number: 'ORDER-1' },
  },
  {
    name: 'getOrderTransactions', call: client => client.getOrderTransactions(STORE, 'order-1'), fallback: [],
    successBody: { transactions: [{ id: 'transaction-1', order_id: 'order-1' }] },
    successResult: [{ id: 'transaction-1', order_id: 'order-1' }],
  },
];

for (const scenario of cases) {
  test(`${scenario.name} bounds a hanging response body and permits the next request`, async () => {
    const hangingBody = new PassThrough();
    const requests: RequestInit[] = [];
    const client = isolatedClient(async (url, init) => {
      requests.push(init || {});
      if (requests.length === 1) {
        // Run node-fetch 2's real body reader without network. Shorten only the test clock;
        // omitting the production timeout leaves this stream hanging and fails the deadline.
        return new Response(hangingBody, { status: 200, url, timeout: init?.timeout ? 5 : 0 });
      }
      return new Response(JSON.stringify(scenario.successBody), { status: 200, url });
    });
    try {
      const fallback = await withinDeadline(scenario.call(client));
      assert.deepEqual(JSON.parse(JSON.stringify(fallback)), scenario.fallback);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].timeout, 18000);

      const result = await withinDeadline(scenario.call(client));
      assert.deepEqual(JSON.parse(JSON.stringify(result)), scenario.successResult);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].timeout, 18000);
      assert.ok(requests.every(request => request.method === 'GET'));
    } finally {
      hangingBody.destroy();
    }
  });
}
