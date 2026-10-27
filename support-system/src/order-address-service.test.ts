import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const BEFORE = { first_name: 'First', last_name: 'Last', address: 'Old street', address1: 'Unit 1', city: 'City',
  province: 'State', province_code: 'ST', country: 'Country', country_code: 'US', zip: '12345', phone: '1234567', email: 'unchanged@example.invalid' };
const AFTER = { ...BEFORE, address: 'New street' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function order(address = BEFORE, overrides: Record<string, unknown> = {}) {
  return { id: 'order-1', status: 'placed', fulfillment_status: 'waiting', updated_at: '2026-10-26T12:00:00Z',
    shipping_address: clone(address), fulfillments: [], line_items: [], ...overrides };
}
class ApiError extends Error {
  constructor(public code: string, public httpStatus = 0) { super('fixture provider failure'); }
}

function harness(options: {
  orders?: any[]; scopes?: string[]; putError?: Error; row?: Record<string, unknown>;
  enabled?: boolean; workerLock?: boolean; state?: any; failSnapshot?: boolean; missingSnapshot?: boolean; submitError?: any;
  beforeGet?: () => Promise<void>;
  stateAfterReadback?: any;
} = {}) {
  let row: any = {
    id: '9007199254740993', store_subdomain: 'fixture', order_id: 'order-1', source: 'admin', actor: 'agent-1',
    patch_json: { address: 'New street' }, expected_address_json: clone(BEFORE), status: 'pending', attempts: 0,
    write_started_at: null, before_address_json: null, desired_address_json: null, after_address_json: null,
    created_at: '2026-10-26T10:00:00Z', updated_at: '2026-10-26T10:00:00Z', ...clone(options.row || {}),
  };
  let state: any = clone(options.state || null);
  let snapshots = ['first@example.invalid', 'second@example.invalid'].map(email => ({
    customer_email: email, payment_status: 'paid', fulfillment_status: 'waiting',
    shipping_address_json: clone(BEFORE), raw_order_json: { shipping_address: clone(BEFORE), fulfillments: [{ id: 'keep-me' }],
      payment_line: { payment_name: 'keep-payment' }, customer: { email } },
  }));
  const originalSnapshots = clone(snapshots);
  const calls = { puts: [] as any[], gets: 0, scopes: 0, sql: [] as string[], logs: [] as any[], released: 0, submitted: [] as any[] };
  let backup: any;
  const sql = async (text: string, values: any[] = []): Promise<any> => {
    calls.sql.push(text);
    if (text === 'BEGIN') { backup = clone({ row, state, snapshots }); return { rows: [], rowCount: 0 }; }
    if (text === 'COMMIT') { backup = undefined; return { rows: [], rowCount: 0 }; }
    if (text === 'ROLLBACK') { ({ row, state, snapshots } = backup); backup = undefined; return { rows: [], rowCount: 0 }; }
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ acquired: options.workerLock !== false }] };
    if (text.includes('pg_advisory_unlock') || text.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (text.startsWith('SELECT subdomain')) return { rows: options.enabled === false ? [] : [{ subdomain: 'fixture', store_name: 'Fixture', access_token: 'fixture-only' }] };
    if (text.startsWith('SELECT support_submit_shipping_address_request')) {
      if (options.submitError) throw options.submitError;
      calls.submitted.push(values);
      return { rows: [{ id: row.id }] };
    }
    if (text.startsWith('SELECT * FROM support_shipping_address_requests')) return { rows: [clone(row)] };
    if (text.startsWith('SELECT id FROM support_order_snapshots')) return { rows: [{ id: 1 }, { id: 2 }] };
    if (text.startsWith('WITH candidate')) {
      if (!['pending', 'processing', 'uncertain'].includes(row.status)) return { rows: [], rowCount: 0 };
      row.status = 'processing'; row.attempts++;
      return { rows: [clone(row)], rowCount: 1 };
    }
    if (text.startsWith('SELECT id FROM support_shipping_address_requests')) {
      return { rows: row.status === 'processing' && row.attempts === values[1] ? [{ id: row.id }] : [] };
    }
    if (text.startsWith('SELECT provider_updated_at') || text.startsWith('SELECT revision')) return { rows: state ? [clone(state)] : [] };
    if (text.startsWith('INSERT INTO support_order_shipping_address_state')) {
      state = { address_json: JSON.parse(values[2]), provider_updated_at: values[3], revision: (state?.revision || 0) + 1 };
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('UPDATE support_order_snapshots')) {
      if (options.failSnapshot) throw new Error('fixture database failure with secret');
      if (options.missingSnapshot) return { rows: [], rowCount: 0 };
      assert.equal(calls.gets >= 2 || calls.puts.length === 0, true, 'snapshot writes require successful readback or no-op');
      for (const snapshot of snapshots) {
        snapshot.shipping_address_json = JSON.parse(values[2]);
        snapshot.raw_order_json.shipping_address = JSON.parse(values[2]);
      }
      return { rows: [], rowCount: snapshots.length };
    }
    if (text.startsWith('UPDATE support_shipping_address_requests')) {
      if (row.attempts !== values[1] || row.status !== 'processing') return { rows: [], rowCount: 0 };
      if (text.includes('before_address_json=$3')) {
        row.before_address_json = JSON.parse(values[2]); row.desired_address_json = JSON.parse(values[3]);
        row.write_started_at = values[4] ? '2026-10-26T12:00:00Z' : null;
        return { rows: [clone(row)], rowCount: 1 };
      }
      row.status = values[2]; row.error_code = values[3]; row.error_message = values[4];
      if (values[5]) row.after_address_json = JSON.parse(values[5]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  };
  const dependencies: Record<string, unknown> = {
    './pg': { query: sql, getClient: async () => ({ query: sql, release() { calls.released++; } }) },
    './store-service': { getStoreBySubdomain: async () => options.enabled === false ? null
      : { subdomain: 'fixture', store_name: 'Fixture', enabled: true, access_token: 'fixture-decrypted-token' } },
    './shoplazza-client': {
      ShoplazzaAddressApiError: ApiError,
      getOrderAddressAccessScopes: async (store: any) => {
        assert.equal(store.accessToken, 'fixture-decrypted-token');
        calls.scopes++; return options.scopes ?? ['write_order'];
      },
      getOrderForAddressUpdate: async () => {
        if (options.beforeGet) await options.beforeGet();
        const result = (options.orders || [order(), order(AFTER)])[calls.gets++];
        if (calls.gets === 2 && options.stateAfterReadback) state = clone(options.stateAfterReadback);
        if (result instanceof Error) throw result;
        if (!result) throw new Error('Unexpected extra provider GET');
        return clone(result);
      },
      putOrderShippingAddress: async (_store: any, id: string, address: any) => {
        assert.ok(row.write_started_at, 'write marker must be committed before provider PUT');
        assert.equal(id, row.order_id);
        assert.deepEqual(snapshots, originalSnapshots, 'do not update snapshots optimistically');
        calls.puts.push(clone(address));
        if (options.putError) throw options.putError;
      },
    },
    './shipping-address-guard': { lockOrderShippingAddress: async () => { await sql('SELECT pg_advisory_xact_lock'); } },
    './log-service': { logOperation: async (entry: any) => { calls.logs.push(entry); } },
  };
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/order-address-service.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, Date,
    require(name: string) { if (!(name in dependencies)) throw new Error(`Forbidden dependency: ${name}`); return dependencies[name]; },
  });
  const service = module.exports as typeof import('./order-address-service');
  return { service, calls, get row() { return row; }, get state() { return state; }, get snapshots() { return snapshots; }, originalSnapshots };
}

test('queue submission uses the shared SQL contract and preserves bigint request IDs', async () => {
  const h = harness();
  const result = await h.service.submitShippingAddressRequest({ storeSubdomain: 'fixture', orderId: 'order-1',
    patch: { address: 'New street' }, expectedAddress: BEFORE, actor: 'agent-1', source: 'admin', idempotencyKey: 'request-1' });
  assert.equal(result.id, '9007199254740993');
  assert.equal(result.status, 'pending');
  assert.equal(h.calls.submitted[0][5], 'admin');
  assert.equal(h.calls.puts.length, 0);
  await assert.rejects(h.service.getShippingAddressRequest('9223372036854775808'), { code: 'invalid_request_id' });
});

test('forbidden email, unknown fields and malformed patches cannot reach the queue', async () => {
  for (const patch of [{ email: 'new@example.invalid' }, { address2: 'wrong field' }, { phone: 123 }, { address: 'bad\nline' }, {}]) {
    const h = harness();
    await assert.rejects(h.service.submitShippingAddressRequest({ storeSubdomain: 'fixture', orderId: 'order-1',
      patch, expectedAddress: BEFORE, actor: 'agent-1', source: 'admin', idempotencyKey: 'request-1' }), { code: 'invalid_patch' });
    assert.equal(h.calls.submitted.length, 0);
  }
});

test('active queue conflicts produce a safe HTTP 409 without leaking SQL errors', async () => {
  const h = harness({ submitError: { code: '55000', message: 'secret SQL fixture' } });
  await assert.rejects(h.service.submitShippingAddressRequest({ storeSubdomain: 'fixture', orderId: 'order-1',
    patch: { address: 'New street' }, expectedAddress: BEFORE, actor: 'agent-1', source: 'admin', idempotencyKey: 'request-1' }),
  (error: any) => error.statusCode === 409 && !error.message.includes('secret'));
});

test('confirmed update preserves email and updates only address for every email snapshot', async () => {
  const h = harness();
  const result = await h.service.processShippingAddressRequest(h.row.id);
  assert.equal(result?.status, 'succeeded');
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.puts[0].email, BEFORE.email);
  assert.equal(h.calls.puts[0].address, AFTER.address);
  assert.deepEqual(h.state.address_json, AFTER);
  for (let i = 0; i < h.snapshots.length; i++) {
    const expected = clone(h.originalSnapshots[i]);
    expected.shipping_address_json = clone(AFTER); expected.raw_order_json.shipping_address = clone(AFTER);
    assert.deepEqual(h.snapshots[i], expected);
  }
  assert.equal(h.calls.sql.some(sql => /support_email|support_tickets|logistics_json|payment_status\s*=/.test(sql)), false);
  assert.equal(h.calls.released, 1);
});

test('a stale expected address is a conflict and never writes remotely or locally', async () => {
  const h = harness({ orders: [order({ ...BEFORE, phone: 'changed elsewhere' })] });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'conflict');
  assert.equal(h.calls.puts.length, 0);
  assert.deepEqual(h.snapshots, h.originalSnapshots);
});

test('permission, fulfillment and special-address checks fail closed before PUT', async t => {
  const scenarios = [
    { name: 'missing write scope', scopes: ['read_order'], error: 'missing_write_scope' },
    { name: 'disabled store', enabled: false, error: 'store_disabled' },
    { name: 'partly shipped', orders: [order(BEFORE, { fulfillment_status: 'partially_shipped' })], error: 'order_fulfilled' },
    { name: 'unknown state', orders: [order(BEFORE, { fulfillment_status: '' })], error: 'order_fulfilled' },
    { name: 'cancelled', orders: [order(BEFORE, { status: 'cancelled' })], error: 'order_not_editable' },
    { name: 'fulfilled record contradicts waiting', orders: [order(BEFORE, { fulfillments: [{ id: 'f1', status: 'shipped' }] })], error: 'order_fulfilled' },
    { name: 'shipped item contradicts waiting', orders: [order(BEFORE, { line_items: [{ ship_quantity: 1 }] })], error: 'order_fulfilled' },
    { name: 'tax ID', orders: [order({ ...BEFORE, extra_info: { cpf: 'tax-id' } } as any)], error: 'unsupported_address_fields' },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const h = harness(scenario);
    const result = await h.service.processShippingAddressRequest();
    assert.equal(result?.status, 'failed'); assert.equal(result?.errorCode, scenario.error);
    assert.equal(h.calls.puts.length, 0); assert.deepEqual(h.snapshots, h.originalSnapshots);
  });
});

test('empty special fields do not prevent a normal address edit', async () => {
  const h = harness({ orders: [order({ ...BEFORE, extra_info: { cpf: '', addition: {} } } as any), order(AFTER)] });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'succeeded');
  assert.equal('extra_info' in h.calls.puts[0], false);
});

test('a timeout after PUT can still succeed only after GET confirms the desired address', async () => {
  const h = harness({ putError: new ApiError('request_failed') });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'succeeded');
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.gets, 2);
});

test('unconfirmed PUT stays uncertain; later recovery only reads, never repeats PUT', async () => {
  const h = harness({ putError: new ApiError('request_failed'), orders: [order(), order(), order(AFTER)] });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'uncertain');
  assert.deepEqual(h.snapshots, h.originalSnapshots);
  assert.equal((await h.service.processShippingAddressRequest(h.row.id))?.status, 'succeeded');
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.scopes, 1);
});

test('readback failure, unexpected email change, and failed local commit all remain uncertain', async t => {
  for (const scenario of [
    { name: 'readback unavailable', orders: [order(), new ApiError('request_failed')] },
    { name: 'email changed remotely', orders: [order(), order({ ...AFTER, email: 'changed@example.invalid' })] },
    { name: 'local rollback', failSnapshot: true },
    { name: 'local order removed', missingSnapshot: true },
  ]) await t.test(scenario.name, async () => {
    const h = harness(scenario);
    const result = await h.service.processShippingAddressRequest();
    assert.equal(result?.status, 'uncertain');
    assert.equal(h.calls.puts.length, 1);
    assert.deepEqual(h.snapshots, h.originalSnapshots);
    assert.equal(h.state, null);
    assert.equal(result?.errorMessage?.includes('secret'), false);
  });
});

test('old worker recovery after a persisted write marker only verifies the result', async () => {
  const h = harness({ row: { status: 'processing', write_started_at: '2026-10-26T10:01:00Z',
    before_address_json: BEFORE, desired_address_json: AFTER }, orders: [order(AFTER)] });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'succeeded');
  assert.equal(h.calls.puts.length, 0); assert.equal(h.calls.scopes, 0);
});

test('a newer confirmed state cannot be overwritten by an older readback', async () => {
  const state = { address_json: { ...BEFORE, address: 'Newest' }, provider_updated_at: '2026-10-26T13:00:00Z', revision: 3 };
  const h = harness({ state });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'uncertain');
  assert.deepEqual(h.state, state); assert.deepEqual(h.snapshots, h.originalSnapshots);
});

test('a same-timestamp revision change during readback cannot overwrite the newer saved address', async () => {
  const state = { address_json: BEFORE, provider_updated_at: '2026-10-26T12:00:00Z', revision: 1 };
  const changed = { address_json: { ...BEFORE, address: 'Concurrent edit' }, provider_updated_at: state.provider_updated_at, revision: 2 };
  const h = harness({ state, stateAfterReadback: changed });
  const result = await h.service.processShippingAddressRequest();
  assert.equal(result?.status, 'uncertain'); assert.equal(result?.errorCode, 'address_revision_changed');
  assert.deepEqual(h.state, changed); assert.deepEqual(h.snapshots, h.originalSnapshots);
});

test('authoritative readback without updated_at confirms the address and retains the known provider time', async () => {
  const state = { address_json: BEFORE, provider_updated_at: '2026-10-26T12:00:00Z', revision: 2 };
  const h = harness({ state, orders: [order(), order(AFTER, { updated_at: undefined })] });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'succeeded');
  assert.deepEqual(h.state.address_json, AFTER);
  assert.equal(h.state.provider_updated_at, state.provider_updated_at);
  assert.equal(h.state.revision, 3);
});

test('uncertain recovery without updated_at can finish through GET alone', async () => {
  const state = { address_json: BEFORE, provider_updated_at: '2026-10-26T12:00:00Z', revision: 2 };
  const h = harness({ state, row: { status: 'uncertain', write_started_at: '2026-10-26T10:01:00Z',
    before_address_json: BEFORE, desired_address_json: AFTER }, orders: [order(AFTER, { updated_at: '' })] });
  assert.equal((await h.service.processShippingAddressRequest(h.row.id))?.status, 'succeeded');
  assert.equal(h.calls.puts.length, 0);
  assert.equal(h.state.provider_updated_at, state.provider_updated_at);
});

test('definite provider rejection plus unchanged readback produces failed, without local mutation', async () => {
  const h = harness({ putError: new ApiError('http_error', 403), orders: [order(), order()] });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'failed');
  assert.deepEqual(h.snapshots, h.originalSnapshots);
});

test('an unchanged patch succeeds without PUT and refreshes the confirmed snapshot', async () => {
  const h = harness({ row: { patch_json: { address: BEFORE.address } }, orders: [order()] });
  assert.equal((await h.service.processShippingAddressRequest())?.status, 'succeeded');
  assert.equal(h.calls.puts.length, 0); assert.equal(h.row.write_started_at, null);
});

test('busy worker lock and same-process overlap cannot send another PUT', async () => {
  const locked = harness({ workerLock: false });
  assert.equal(await locked.service.processShippingAddressRequest(), null);
  assert.equal(locked.calls.gets, 0); assert.equal(locked.calls.released, 1);
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ beforeGet: () => wait });
  const first = h.service.processShippingAddressRequest();
  assert.equal(await h.service.processShippingAddressRequest(), null);
  release();
  assert.equal((await first)?.status, 'succeeded'); assert.equal(h.calls.puts.length, 1);
});

test('live address view reports permission and fulfillment restrictions without writing', async () => {
  const h = harness({ scopes: ['read_order'], orders: [order()] });
  const result = await h.service.getOrderShippingAddress({ storeSubdomain: 'fixture', orderId: 'order-1' });
  assert.equal(result.editable, false); assert.equal(result.hasWriteScope, false);
  assert.deepEqual(result.address, BEFORE); assert.equal(h.calls.puts.length, 0);
});

test('live view retains the active request when remote reads fail', async () => {
  const h = harness({ row: { status: 'uncertain', write_started_at: '2026-10-26T10:01:00Z' }, orders: [new ApiError('request_failed')] });
  const result = await h.service.getOrderShippingAddress({ storeSubdomain: 'fixture', orderId: 'order-1' });
  assert.equal(result.editable, false); assert.equal(result.activeRequest?.status, 'uncertain');
  assert.equal(result.activeRequest?.id, h.row.id); assert.deepEqual(result.address, BEFORE);
});

test('invalid country code fails validation without provider PUT', async () => {
  const h = harness({ row: { patch_json: { country_code: 'USA' } } });
  const result = await h.service.processShippingAddressRequest();
  assert.equal(result?.errorCode, 'invalid_country_code'); assert.equal(h.calls.puts.length, 0);
});
