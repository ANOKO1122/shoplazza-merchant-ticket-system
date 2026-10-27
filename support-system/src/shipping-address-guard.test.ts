import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const STORE = { subdomain: 'offline', storeName: 'Offline', accessToken: 'fixture' };
const OLD = { first_name: 'Old', address1: 'Old fixture street' };
const CONFIRMED = { first_name: 'Current', address1: 'Confirmed fixture street' };
const EXTERNAL = { first_name: 'External', address1: 'New external fixture street' };
const EARLY = '2026-10-26T10:00:00Z';
const NOW = '2026-10-26T11:00:00Z';
const LATER = '2026-10-26T12:00:00Z';
const plain = (value: any) => JSON.parse(JSON.stringify(value));
function load<T = any>(filename: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date, Buffer,
    console: { log() {}, warn() {}, error() {} },
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Forbidden live dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename });
  return module.exports as T;
}
const normalizer = load<typeof import('./normalize-order')>('normalize-order.ts', {});
function order(shipping: any = OLD, updated: any = EARLY, payment = 'paid') {
  return { id: 'ORDER', number: 'ORDER-1', financial_status: payment, updated_at: updated,
    shipping_address: shipping, customer: { email: 'fixture@example.invalid' },
    payment_line: { payment_channel: 'paypal' }, line_items: [{ title: 'Fixture', quantity: 1 }],
    fulfillments: [{ id: 'PARCEL', tracking_number: 'KEEP' }] } as any;
}
function state(shipping = CONFIRMED, updated: string | null = NOW, revision = 1) {
  return { address_json: shipping, provider_updated_at: updated, revision };
}
/** Transaction-aware fixture: lock waits precede state visibility, writes stage until commit. */
function harness(initial: ReturnType<typeof state> | null = state()) {
  let savedState: any = initial && plain(initial);
  let tail = Promise.resolve();
  const calls = { active: 0, released: 0, sql: [] as string[], snapshots: [] as any[],
    failedWrite: false, rowCount: 1, api: 0, invites: 0, cursors: [] as string[],
    peers: [order(CONFIRMED, NOW), { ...order(CONFIRMED, NOW), customer: { email: 'other@example.invalid' } }] };
  async function getClient() {
    calls.active++;
    let unlock: (() => void) | undefined;
    let stagedState: any;
    let stagedSnapshots: any[] = [];
    let stagedPeerAddress: any;
    return {
      async query(sql: string, values: any[] = []) {
        calls.sql.push(sql);
        if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
        if (sql.includes('pg_advisory_xact_lock')) {
          assert.deepEqual(plain(values), ['support.shipping-address:offline', 'ORDER']);
          const before = tail;
          tail = new Promise<void>(done => { unlock = done; });
          await before;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT address_json')) {
          assert.ok(unlock, 'state is read only after the shared lock');
          return { rows: savedState ? [plain(savedState)] : [], rowCount: savedState ? 1 : 0 };
        }
        if (sql.includes('UPDATE support_order_shipping_address_state')) {
          stagedState = { ...savedState, address_json: JSON.parse(values[2]), provider_updated_at: values[3], revision: savedState.revision + 1 };
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT id FROM support_order_snapshots')) {
          assert.match(sql, /ORDER BY id FOR UPDATE/);
          return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
        }
        if (sql.includes('UPDATE support_order_snapshots SET shipping_address_json')) {
          assert.match(sql, /raw_order_json = jsonb_set\(COALESCE\(raw_order_json/);
          assert.doesNotMatch(sql, /fulfillments|payment_status\s*=|customer_email\s*=/);
          stagedPeerAddress = JSON.parse(values[2]);
          return { rows: [], rowCount: 2 };
        }
        if (sql === 'CONFIRM_FIXTURE') {
          stagedState = plain(values[0]);
          return { rows: [], rowCount: 1 };
        }
        if (sql === 'WRITE_FIXTURE' || sql.includes('INSERT INTO support_order_snapshots')) {
          if (calls.failedWrite) throw new Error('fixture snapshot failed');
          if (calls.rowCount) stagedSnapshots.push(sql === 'WRITE_FIXTURE'
            ? plain(values[0]) : { shippingAddressJson: JSON.parse(values[18]), rawOrderJson: JSON.parse(values[22]), paymentStatus: values[10] });
          return { rows: calls.rowCount ? [{ is_new: true, is_insert: true }] : [], rowCount: calls.rowCount };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (sql === 'COMMIT') {
            if (stagedState !== undefined) savedState = stagedState;
            if (stagedPeerAddress) for (const peer of calls.peers) peer.shipping_address = stagedPeerAddress;
            calls.snapshots.push(...stagedSnapshots);
          }
          stagedState = undefined; stagedSnapshots = []; stagedPeerAddress = undefined;
          unlock?.(); unlock = undefined;
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`Unexpected transaction SQL: ${sql}`);
      },
      release() { assert.equal(unlock, undefined, 'transaction must finish before release'); calls.active--; calls.released++; },
    };
  }
  const pg = { getClient, query: async (sql: string, values: any[] = []) => {
    if (sql.includes('SELECT card_last4')) return { rows: [], rowCount: 0 };
    if (sql.includes('SELECT store_subdomain')) return { rows: [{ store_subdomain: STORE.subdomain,
      last_synced_at: NOW, last_unpaid_synced_at: new Date(Date.now() - 1000).toISOString(), last_status: 'idle' }], rowCount: 1 };
    if (sql.includes('INSERT INTO support_backfill_state')) { calls.cursors.push(sql); return { rows: [], rowCount: 1 }; }
    throw new Error(`Unexpected outside transaction SQL: ${sql}`);
  } };
  const subject = load<typeof import('./shipping-address-guard')>('shipping-address-guard.ts', { './pg': pg });
  async function confirm(value: ReturnType<typeof state>) {
    const client = await getClient();
    await client.query('BEGIN');
    await subject.lockOrderShippingAddress(client as any, STORE.subdomain, 'ORDER');
    await client.query('CONFIRM_FIXTURE', [value]);
    await client.query('COMMIT'); client.release();
  }
  async function run(raw: any, latest: () => Promise<any> = async () => { throw new Error('Unexpected provider call'); }) {
    const normalized = normalizer.normalizeOrder(STORE.subdomain, STORE.storeName, raw, []);
    return subject.withSnapshotShippingAddressGuard(normalized, async () => {
      calls.api++; assert.equal(calls.active, 0, 'GET must not hold a pool connection'); return latest();
    }, (client, guarded) => client.query('WRITE_FIXTURE', [guarded]));
  }
  return { calls, subject, getClient, pg, run, confirm, state: () => savedState };
}

test('unprotected orders retain their address/raw data and do not fetch or create state', async () => {
  const h = harness(null);
  const incoming = order();
  await h.run(incoming);
  assert.deepEqual(h.calls.snapshots[0].rawOrderJson, incoming);
  assert.equal(h.state(), null); assert.equal(h.calls.api, 0); assert.equal(h.calls.active, 0);
});

test('old or incomplete snapshots preserve the confirmed address in normalized and raw JSON', async () => {
  for (const incoming of [order(), order(undefined, LATER), order({}, LATER), order(null, LATER),
    order({ email: 'fixture@example.invalid', first_name: 'Partial' }, LATER)]) {
    // Explicitly omit the field for the incomplete payload case.
    if (incoming.shipping_address === OLD && incoming.updated_at === LATER) delete incoming.shipping_address;
    const h = harness();
    await h.run(incoming);
    assert.deepEqual(h.calls.snapshots[0].shippingAddressJson, CONFIRMED);
    assert.deepEqual(h.calls.snapshots[0].rawOrderJson.shipping_address, CONFIRMED);
    assert.deepEqual(h.calls.snapshots[0].rawOrderJson.fulfillments, incoming.fulfillments);
    assert.equal(h.state().revision, 1); assert.equal(h.calls.api, 0);
  }
});

test('strictly newer valid address advances state, while its subsequent old event cannot roll it back', async () => {
  const h = harness();
  await h.run(order(EXTERNAL, LATER));
  await h.run(order(CONFIRMED, NOW));
  assert.deepEqual(h.calls.snapshots.map(item => item.shippingAddressJson), [EXTERNAL, EXTERNAL]);
  assert.deepEqual(h.state().address_json, EXTERNAL); assert.equal(h.state().revision, 2); assert.equal(h.calls.api, 0);
  assert.deepEqual(h.calls.peers.map(peer => peer.shipping_address), [EXTERNAL, EXTERNAL]);
  assert.deepEqual(h.calls.peers.map(peer => peer.customer.email), ['fixture@example.invalid', 'other@example.invalid']);
  assert.ok(h.calls.peers.every(peer => peer.fulfillments[0].tracking_number === 'KEEP'));
  assert.ok(h.calls.sql.findIndex(sql => sql.includes('ORDER BY id FOR UPDATE')) < h.calls.sql.indexOf('WRITE_FIXTURE'));
});

test('equal/missing timestamps require authoritative GET and accept confirmed external changes', async () => {
  for (const [savedTime, incomingTime, fetchedTime] of [[NOW, NOW, NOW], [NOW, null, null], [null, LATER, LATER]]) {
    const h = harness(state(CONFIRMED, savedTime));
    await h.run(order(OLD, incomingTime), async () => order(EXTERNAL, fetchedTime));
    assert.equal(h.calls.api, 1); assert.equal(h.calls.released, 2);
    assert.deepEqual(h.calls.snapshots[0].shippingAddressJson, EXTERNAL);
    assert.deepEqual(h.state().address_json, EXTERNAL); assert.equal(h.state().revision, 2);
  }
});

test('failed, incomplete, wrong-order or explicitly stale authoritative GET preserves confirmed address', async () => {
  for (const latest of [async () => null, async () => { throw new Error('fixture network failure'); },
    async () => order({}, NOW), async () => ({ ...order(EXTERNAL, NOW), id: 'OTHER' }), async () => order(EXTERNAL, EARLY)]) {
    const h = harness();
    await h.run(order(OLD, NOW), latest);
    assert.deepEqual(h.calls.snapshots[0].shippingAddressJson, CONFIRMED);
    assert.equal(h.state().revision, 1); assert.equal(h.calls.active, 0);
  }
});

test('a newer confirmed edit during an unlocked GET wins over that GET result', async () => {
  const h = harness();
  await h.run(order(OLD, NOW), async () => {
    await h.confirm(state(EXTERNAL, LATER, 2));
    return order(OLD, NOW);
  });
  assert.deepEqual(h.calls.snapshots[0].shippingAddressJson, EXTERNAL);
  assert.equal(h.state().revision, 2);
});

test('state inserted while a writer waits for the lock is visible before its first snapshot write', async () => {
  const h = harness(null);
  const core = await h.getClient();
  await core.query('BEGIN');
  await h.subject.lockOrderShippingAddress(core as any, STORE.subdomain, 'ORDER');
  const pending = h.subject.withSnapshotShippingAddressGuard(normalizer.normalizeOrder('offline', 'Offline', order(), []),
    async () => { throw new Error('No GET for old payload'); }, (client, guarded) => client.query('WRITE_FIXTURE', [guarded]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.snapshots.length, 0);
  await core.query('CONFIRM_FIXTURE', [state()]);
  await core.query('COMMIT'); core.release();
  await pending;
  assert.deepEqual(h.calls.snapshots[0].shippingAddressJson, CONFIRMED);
  assert.equal(h.calls.active, 0);
});

test('failed snapshot rolls back and releases; paid-row protection does not advance address state', async () => {
  const failed = harness(); failed.calls.failedWrite = true;
  await assert.rejects(failed.run(order(EXTERNAL, LATER)), /snapshot failed/);
  assert.equal(failed.calls.active, 0); assert.equal(failed.state().revision, 1);
  assert.ok(failed.calls.sql.includes('ROLLBACK'));
  const skipped = harness(); skipped.calls.rowCount = 0;
  await skipped.run(order(EXTERNAL, LATER, 'waiting'));
  assert.equal(skipped.state().revision, 1); assert.equal(skipped.calls.snapshots.length, 0);
});

for (const source of ['paid-webhook', 'paid-backfill', 'unpaid-backfill']) {
  test(`${source} uses the real guard without changing payment/mail/cursor behavior`, async () => {
    const h = harness();
    const incoming = order(OLD, EARLY, source === 'unpaid-backfill' ? 'waiting' : 'paid');
    const forbidden = () => { throw new Error('Unexpected live API or email transport'); };
    const dependencies = {
      crypto, './pg': h.pg, './shipping-address-guard': h.subject, './normalize-order': normalizer,
      './config': { buildStoreDomain: () => 'offline.invalid' },
      './store-service': { getEnabledStores: async () => [{ subdomain: STORE.subdomain, store_name: STORE.storeName, access_token: STORE.accessToken }] },
      './shoplazza-client': { getOrderDetail: forbidden, getOrderForAddressUpdate: forbidden, getOrderByNumber: forbidden, getOrderTransactions: forbidden,
        listPaidOrdersCreatedSince: async () => [incoming], listWaitingOrdersUpdatedSince: async () => [incoming] },
      './log-service': { logSync: async () => undefined, logOperation: async () => undefined },
      './email-service': { extractStoreCustomDomain: () => '', createPaidSupportInviteEmailJob: async () => {
        h.calls.invites++; return { inserted: true, job: { email_job_no: 'OFFLINE' } };
      } },
    };
    if (source === 'paid-webhook') {
      await load<typeof import('./paid-webhook')>('paid-webhook.ts', dependencies)
        .processOrderWebhook({ store: STORE, topic: 'orders/paid', payload: { order: incoming } });
    } else {
      const backfill = load<typeof import('./backfill-jobs')>('backfill-jobs.ts', dependencies);
      if (source === 'paid-backfill') await backfill.runBackfillForStore(STORE.subdomain);
      else await backfill.runUnpaidBackfillOnly(STORE.subdomain);
    }
    assert.ok(h.calls.snapshots.length > 0);
    for (const snapshot of h.calls.snapshots) {
      assert.deepEqual(snapshot.shippingAddressJson, CONFIRMED);
      assert.deepEqual(snapshot.rawOrderJson.shipping_address, CONFIRMED);
      assert.equal(snapshot.paymentStatus, incoming.financial_status);
    }
    assert.equal(h.calls.invites, source === 'unpaid-backfill' ? 0 : 1);
    if (source === 'unpaid-backfill') for (const sql of h.calls.cursors) assert.doesNotMatch(sql, /\blast_synced_at\b/);
    assert.equal(h.calls.active, 0);
  });
}
