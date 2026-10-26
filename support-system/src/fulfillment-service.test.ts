import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { buildTrackingDetails } from './admin-preview';
import {
  applyFulfillmentUpdate,
  extractFulfillmentTrackingNumbers,
  extractStoredFulfillmentTrackingNumbers,
  mergeFulfillments,
  validateFulfillments,
} from './fulfillment-service';

const T1 = '2026-10-20T12:00:00Z';
const T2 = '2026-10-20T12:00:01Z';
const T3 = '2026-10-20T12:00:02Z';
const fixture = { storeSubdomain: 'fixture-store', orderId: 'order-1', source: 'webhook' as const };
const parcel = (id: string, number: string, updated_at = T1) => ({ id, tracking_number: number, updated_at });

test('partial A update preserves B and absent fields without mutating either payload', () => {
  const existing = [{ ...parcel('A', 'OLD'), carrier: 'Carrier A', line_items: [{ id: 'item-1' }] }, parcel('B', 'B1')];
  const incoming = [parcel('A', 'NEW', T2)];
  const original = JSON.parse(JSON.stringify({ existing, incoming }));
  const result = mergeFulfillments(existing, incoming);
  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
  assert.deepEqual(result.fulfillments, [{ ...existing[0], tracking_number: 'NEW', updated_at: T2, tracking_number_history: ['OLD', 'NEW'] }, { ...existing[1], tracking_number_history: ['B1'] }]);
  assert.deepEqual(result.trackingNumbers, ['OLD', 'NEW', 'B1']);
  assert.deepEqual(result.changes, [{ fulfillmentId: 'A', kind: 'updated', beforeTrackingNumbers: ['OLD'], afterTrackingNumbers: ['NEW'], retainedTrackingNumbers: ['OLD', 'NEW'], addedTrackingNumbers: ['NEW'] }]);
  assert.deepEqual({ existing, incoming }, original);
});

test('full snapshots update A, append B, and repeated delivery never creates a second parcel', () => {
  const incoming = [parcel('A', 'A2', T2), parcel('B', 'B1')];
  const first = mergeFulfillments([parcel('A', 'A1')], incoming);
  assert.deepEqual([first.added, first.updated, first.unchanged, first.stale], [1, 1, 0, 0]);
  const repeated = mergeFulfillments(first.fulfillments, incoming);
  assert.deepEqual([repeated.added, repeated.updated, repeated.unchanged, repeated.stale], [0, 0, 2, 0]);
  assert.deepEqual(repeated.fulfillments, first.fulfillments);
});

test('tracking_items-only parcels preserve every item and its fields, with explicit replacement', () => {
  const items = [
    { tracking_number: 'ONE', tracking_url: 'https://carrier.invalid/one', carrier: 'First' },
    { tracking_number: 'TWO', tracking_url: 'https://carrier.invalid/two', carrier: 'Second', extra: { preserved: true } },
  ];
  const initial = mergeFulfillments([], [{ id: 'A', tracking_items: items, updated_at: T1 }]);
  assert.deepEqual(initial.trackingNumbers, ['ONE', 'TWO']);
  assert.deepEqual(initial.fulfillments[0].tracking_items, items);
  const partial = mergeFulfillments(initial.fulfillments, [{ id: 'A', updated_at: T2, carrier: 'Updated' }]);
  assert.deepEqual(partial.fulfillments[0].tracking_items, items);
  const replaced = mergeFulfillments(partial.fulfillments, [{ id: 'A', updated_at: T3, tracking_items: [items[1]] }]);
  assert.deepEqual(replaced.trackingNumbers, ['ONE', 'TWO']);
  assert.deepEqual(extractFulfillmentTrackingNumbers(replaced.fulfillments[0]), ['TWO']);
  assert.deepEqual(replaced.changes[0].beforeTrackingNumbers, ['ONE', 'TWO']);
  assert.deepEqual(replaced.changes[0].afterTrackingNumbers, ['TWO']);
  assert.deepEqual(extractFulfillmentTrackingNumbers({ tracking_number: 'LEGACY', tracking_items: [] }), []);
});

test('tracking extraction uses the same canonical field priority as the displayed parcels', () => {
  assert.deepEqual(extractFulfillmentTrackingNumbers({ tracking_number: ' A ', tracking_no: 'A', tracking_numbers: ['B', '', null, 42] }), ['B', '42']);
  assert.deepEqual(extractFulfillmentTrackingNumbers({ tracking_number: 'OLD', tracking_items: [{ tracking_no: 'NEW' }, { tracking_numbers: ['NEW', 'SECOND'] }] }), ['NEW', 'SECOND']);
  assert.deepEqual(extractFulfillmentTrackingNumbers(null), []);
  for (const fulfillment of [
    { tracking_number: 'NEW', tracking_no: 'OLD' },
    { tracking_numbers: ['ARRAY', 'ARRAY'], tracking_number: 'OLD' },
    { trackingNumbers: ['ARRAY'], tracking_number: 'OLD' },
    { tracking_items: [{ tracking_number: 'NEW', tracking_no: 'OLD' }], tracking_number: 'OLDER' },
    { waybill_no: 'WAYBILL', logistics_no: 'OLD' },
  ]) {
    assert.deepEqual(extractFulfillmentTrackingNumbers(fulfillment), buildTrackingDetails({ raw_order_json: { fulfillments: [fulfillment] } }).tracking_numbers);
  }
});

test('a new tracking representation replaces current fields while retaining previously received numbers', () => {
  for (const previous of [
    { tracking_items: [{ tracking_number: 'OLD', tracking_url: 'https://carrier.invalid/old' }] },
    { tracking_numbers: ['OLD'] },
    { trackingNumbers: ['OLD'], tracking_no: 'OLDER' },
  ]) {
    const result = mergeFulfillments([{ id: 'A', updated_at: T1, carrier: 'Kept', ...previous }], [parcel('A', 'NEW', T2)]);
    const history = 'tracking_no' in previous ? ['OLD', 'OLDER', 'NEW'] : ['OLD', 'NEW'];
    assert.deepEqual(result.fulfillments, [{ ...parcel('A', 'NEW', T2), carrier: 'Kept', tracking_number_history: history }]);
    assert.deepEqual(result.trackingNumbers, history);
    assert.deepEqual(extractFulfillmentTrackingNumbers(result.fulfillments[0]), ['NEW']);
    assert.deepEqual(result.changes[0].beforeTrackingNumbers, ['OLD']);
    assert.deepEqual(result.changes[0].afterTrackingNumbers, ['NEW']);
  }
  const toItems = mergeFulfillments([parcel('A', 'OLD')], [{ id: 'A', updated_at: T2, tracking_items: [{ tracking_number: 'FIRST' }, { tracking_number: 'SECOND' }] }]);
  assert.equal(toItems.fulfillments[0].tracking_number, undefined);
  assert.deepEqual(toItems.trackingNumbers, ['OLD', 'FIRST', 'SECOND']);
  const cleared = mergeFulfillments(toItems.fulfillments, [{ id: 'A', updated_at: T3, tracking_number: null }]);
  assert.deepEqual(cleared.trackingNumbers, ['OLD', 'FIRST', 'SECOND']);
  assert.deepEqual(extractFulfillmentTrackingNumbers(cleared.fulfillments[0]), []);
  assert.equal(cleared.fulfillments[0].tracking_items, undefined);
});

test('an older format-changing message reports its proposed number without deleting current tracking items', () => {
  const existing = [{ id: 'A', updated_at: T2, tracking_items: [{ tracking_number: 'CURRENT' }] }];
  const result = mergeFulfillments(existing, [parcel('A', 'STALE', T1)]);
  assert.equal(result.stale, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.changes[0].kind, 'history_added');
  assert.deepEqual(result.fulfillments, [{ ...existing[0], tracking_number_history: ['CURRENT', 'STALE'] }]);
  assert.deepEqual(result.trackingNumbers, ['CURRENT', 'STALE']);
  assert.deepEqual(result.changes[0].afterTrackingNumbers, ['STALE']);
});

test('older or unversioned conflicting messages cannot overwrite a versioned parcel', () => {
  const existing = [parcel('A', 'NEW', T2)];
  for (const incoming of [parcel('A', 'OLD', T1), { id: 'A', tracking_number: 'NO-TIME' }]) {
    const result = mergeFulfillments(existing, [incoming]);
    assert.equal(result.stale, 0);
    assert.equal(result.updated, 1);
    assert.equal(result.changes[0].kind, 'history_added');
    assert.deepEqual(extractFulfillmentTrackingNumbers(result.fulfillments[0]), ['NEW']);
    assert.equal(result.fulfillments[0].updated_at, T2);
    assert.deepEqual(result.changes[0].afterTrackingNumbers, [incoming.tracking_number]);
    assert.equal(mergeFulfillments(result.fulfillments, [incoming]).stale, 1);
  }
  const versioned = mergeFulfillments([{ id: 'A', tracking_number: 'UNVERSIONED' }], existing);
  assert.equal(versioned.updated, 1);
});

test('same-second conflict is skipped for webhook and corrected by authoritative backfill', () => {
  const existing = [parcel('A', 'OLD')];
  const incoming = [parcel('A', 'CORRECTED')];
  const webhook = mergeFulfillments(existing, incoming, { source: 'webhook' });
  assert.equal(webhook.changes[0].kind, 'history_added');
  assert.deepEqual(webhook.trackingNumbers, ['OLD', 'CORRECTED']);
  assert.deepEqual(extractFulfillmentTrackingNumbers(webhook.fulfillments[0]), ['OLD']);
  const backfill = mergeFulfillments(existing, incoming, { source: 'backfill' });
  assert.equal(backfill.updated, 1);
  assert.deepEqual(backfill.trackingNumbers, ['OLD', 'CORRECTED']);
  assert.deepEqual(extractFulfillmentTrackingNumbers(backfill.fulfillments[0]), ['CORRECTED']);
  assert.equal(mergeFulfillments(backfill.fulfillments, incoming, { source: 'backfill' }).unchanged, 1);
  assert.equal(mergeFulfillments([parcel('A', 'NEWEST', T2)], incoming, { source: 'backfill' }).changes[0].kind, 'history_added');
});

test('repeated ids normalize and count once while retaining the newest complete data', () => {
  const result = mergeFulfillments([], [
    { id: 123, tracking_number: 'OLD', carrier: 'Kept', updated_at: T1 },
    { id: '123', tracking_number: 'NEW', updated_at: T2 },
    { id: '123', tracking_number: 'OLD', updated_at: T1 },
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.fulfillments, [{ id: '123', tracking_number: 'NEW', carrier: 'Kept', updated_at: T2, tracking_number_history: ['OLD', 'NEW'] }]);
});

test('local history is accumulated from received numbers and cannot be injected or cleared by incoming history', () => {
  const existing = [{ ...parcel('A', 'CURRENT'), tracking_number_history: ['OLDER', 'CURRENT'] }];
  const incoming = [{ ...parcel('A', 'NEW', T2), tracking_number_history: ['FORGED'] }];
  assert.equal(validateFulfillments(incoming)[0].tracking_number_history, undefined);
  const result = mergeFulfillments(existing, incoming);
  assert.deepEqual(result.fulfillments[0].tracking_number_history, ['OLDER', 'CURRENT', 'NEW']);
  assert.deepEqual(result.changes[0].addedTrackingNumbers, ['NEW']);
  assert.deepEqual(extractStoredFulfillmentTrackingNumbers(result.fulfillments[0]), ['OLDER', 'CURRENT', 'NEW']);
  const repeat = mergeFulfillments(result.fulfillments, [{ ...parcel('A', 'NEW', T2), tracking_number_history: [] }]);
  assert.equal(repeat.unchanged, 1);
  assert.deepEqual(repeat.changes[0].addedTrackingNumbers, []);
  assert.deepEqual(repeat.trackingNumbers, result.trackingNumbers);
  const added = mergeFulfillments([], incoming);
  assert.deepEqual(added.trackingNumbers, ['NEW']);
});

test('existing email rows union trusted histories even at identical timestamps', () => {
  const existing = [
    { ...parcel('A', 'CURRENT'), tracking_number_history: ['DOMESTIC', 'CURRENT'] },
    { ...parcel('A', 'CURRENT'), tracking_number_history: ['EXPORT', 'CURRENT'] },
    { ...parcel('B', 'B1'), tracking_number_history: ['B0', 'B1'] },
  ];
  const result = mergeFulfillments(existing, [parcel('A', 'CURRENT')]);
  assert.equal(result.fulfillments.length, 2);
  assert.deepEqual(result.fulfillments[0].tracking_number_history, ['DOMESTIC', 'CURRENT', 'EXPORT']);
  assert.deepEqual(result.fulfillments[1].tracking_number_history, ['B0', 'B1']);
  assert.deepEqual(result.changes[0].addedTrackingNumbers, []);
});

test('initializing local history for an already saved current number does not count it as a newly received number', () => {
  const result = mergeFulfillments([parcel('A', 'EXISTING')], [parcel('A', 'EXISTING')]);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.changes[0].addedTrackingNumbers, []);
  assert.deepEqual(result.fulfillments[0].tracking_number_history, ['EXISTING']);
  assert.equal(mergeFulfillments(result.fulfillments, [parcel('A', 'EXISTING')]).unchanged, 1);
});

test('history retains all supported representations in one payload while current numbers keep their precedence', () => {
  const result = mergeFulfillments([{ ...parcel('A', 'EXISTING'), tracking_no: 'EXISTING-ALIAS' }], [{
    id: 'A', updated_at: T2, tracking_number: 'DOMESTIC', tracking_numbers: ['ARRAY'],
    tracking_items: [{ tracking_number: 'INTERNATIONAL', tracking_no: 'ITEM-ALIAS' }],
    tracking_number_history: ['FORGED'],
  }]);
  assert.deepEqual(extractFulfillmentTrackingNumbers(result.fulfillments[0]), ['INTERNATIONAL']);
  assert.deepEqual(result.trackingNumbers, ['EXISTING', 'EXISTING-ALIAS', 'INTERNATIONAL', 'ARRAY', 'DOMESTIC', 'ITEM-ALIAS']);
  assert.deepEqual(result.changes[0].addedTrackingNumbers, ['INTERNATIONAL', 'ARRAY', 'DOMESTIC', 'ITEM-ALIAS']);
});

test('history-only changes are persisted and logged as updated without advancing overall shipping status', async t => {
  const db = fakeDatabase(t, [row(1, [{ ...parcel('A', 'INTERNATIONAL', T2), tracking_number_history: ['INTERNATIONAL'] }])]);
  const result = await applyFulfillmentUpdate({ ...fixture, source: 'backfill', fulfillmentStatus: 'shipped', fulfillments: [parcel('A', 'DOMESTIC', T1)] });
  assert.deepEqual([result.added, result.updated, result.stale, result.unchanged], [0, 1, 0, 0]);
  assert.deepEqual(result.changes[0], {
    fulfillmentId: 'A', kind: 'history_added', beforeTrackingNumbers: ['INTERNATIONAL'], afterTrackingNumbers: ['DOMESTIC'],
    retainedTrackingNumbers: ['INTERNATIONAL', 'DOMESTIC'], addedTrackingNumbers: ['DOMESTIC'],
  });
  assert.equal(db.rows[0].fulfillment_status, 'waiting');
  assert.equal(db.rows[0].raw_order_json.fulfillments[0].tracking_number, 'INTERNATIONAL');
  assert.ok(db.calls.some(call => call.sql.startsWith('UPDATE')));
  assert.deepEqual(db.committedLogs[0].slice(4, 9), [1, 0, 1, 0, 'success']);
  assert.equal(JSON.parse(db.committedLogs[0][11]).historyAdded, 1);
});

test('invalid fulfillment objects, ids, versions, and tracking item arrays fail closed', () => {
  for (const value of [null, [], 'parcel', {}, { id: '' }, { id: '   ' }, { id: false }, { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: {} },
    { id: 'A', updated_at: 'not-a-date' }, { id: 'A', updated_at: 42 }, { id: 'A', tracking_items: {} }, { id: 'A', tracking_items: [null] }]) {
    assert.throws(() => mergeFulfillments([], [value]), /Invalid fulfillment/);
  }
  assert.throws(() => mergeFulfillments([], null as any), /must be an array/);
});

type Row = { id: number; order_number: string; store_name: string; fulfillment_status: string; raw_order_json: Record<string, any> };
const row = (id: number, fulfillments: any[], status = 'waiting'): Row => ({
  id, order_number: '#1001', store_name: 'Fixture Store', fulfillment_status: status,
  raw_order_json: { id: 'order-1', customer: { preserved: true }, fulfillments },
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** All database access is intercepted; the fake stages writes and serializes SELECT FOR UPDATE. */
function fakeDatabase(t: TestContext, rows: Row[], failAt?: 'update' | 'log') {
  let state = clone(rows);
  let lockTail = Promise.resolve();
  let locksHeld = 0;
  let waitedForLock = 0;
  let releases = 0;
  let connections = 0;
  const calls: { sql: string; values: any[] }[] = [];
  const committedLogs: any[][] = [];
  const failure = new Error(`fixture ${failAt} failure`);
  t.mock.method(Pool.prototype, 'query', () => { throw new Error('Queries must use the locked transaction client'); });
  t.mock.method(Pool.prototype, 'connect', async () => {
    connections += 1;
    let staged: Row[] | undefined;
    let stagedLog: any[] | undefined;
    let unlock: (() => void) | undefined;
    let finished = false;
    const finish = () => {
      if (unlock) { locksHeld -= 1; unlock(); unlock = undefined; }
      finished = true;
    };
    return {
      async query(text: string, values: any[] = []) {
        const sql = text.replace(/\s+/g, ' ').trim();
        calls.push({ sql, values: clone(values) });
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.startsWith('SELECT')) {
          assert.match(sql, /WHERE store_subdomain = \$1 AND order_id = \$2 ORDER BY id FOR UPDATE$/);
          assert.deepEqual(values, [fixture.storeSubdomain, fixture.orderId]);
          if (locksHeld) waitedForLock += 1;
          const previous = lockTail;
          lockTail = new Promise<void>(resolve => { unlock = resolve; });
          locksHeld += 1;
          await previous;
          staged = clone(state);
          return { rows: clone(staged) };
        }
        if (sql.startsWith('UPDATE support_order_snapshots')) {
          assert.ok(staged, 'read and lock snapshots before writing');
          assert.match(sql, /raw_order_json = jsonb_set/);
          assert.match(sql, /WHERE id = ANY\(\$1::bigint\[\]\)/);
          assert.match(sql, /last_webhook_received_at = CASE WHEN \$3 = 'webhook' THEN now\(\) ELSE last_webhook_received_at END/);
          if (failAt === 'update') throw failure;
          for (const item of staged) {
            if (!values[0].includes(item.id)) continue;
            item.raw_order_json.fulfillments = JSON.parse(values[1]);
            if (values[4] !== null) item.fulfillment_status = values[4];
          }
          return { rows: [], rowCount: staged.length };
        }
        if (sql.startsWith('INSERT INTO support_sync_logs')) {
          assert.match(sql, /'fulfillment_update'/);
          if (failAt === 'log') throw failure;
          stagedLog = clone(values);
          return { rows: [] };
        }
        if (sql === 'COMMIT') {
          if (staged) state = clone(staged);
          if (stagedLog) committedLogs.push(stagedLog);
          finish();
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') { finish(); return { rows: [] }; }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() { assert.ok(finished, 'finish transaction before releasing'); releases += 1; },
    };
  });
  return { calls, committedLogs, failure, get rows() { return state; }, get releases() { return releases; },
    get connections() { return connections; }, get waitedForLock() { return waitedForLock; } };
}

test('transaction unifies all email snapshots and logs counts per parcel with before/after numbers', async t => {
  const db = fakeDatabase(t, [row(1, [parcel('A', 'A1')]), row(2, [parcel('A', 'A1'), parcel('B', 'B1')])]);
  const result = await applyFulfillmentUpdate({ ...fixture, fulfillments: [parcel('A', 'A2', T2), parcel('C', 'C1')], topic: 'orders/fulfillment_updated' });
  assert.equal(result.matched, true);
  assert.equal(result.orderNumber, '#1001');
  assert.deepEqual([result.added, result.updated, result.unchanged, result.stale], [1, 1, 0, 0]);
  assert.deepEqual(result.trackingNumbers, ['A1', 'A2', 'B1', 'C1']);
  assert.deepEqual(db.rows[0].raw_order_json, db.rows[1].raw_order_json);
  assert.deepEqual(db.rows[0].raw_order_json.customer, { preserved: true });
  const log = db.committedLogs[0];
  assert.deepEqual(log.slice(4, 9), [2, 1, 1, 0, 'success']);
  const detail = JSON.parse(log[11]);
  assert.deepEqual(detail.changes, result.changes);
  assert.deepEqual([detail.trackingCount, detail.fulfillmentCount, detail.skippedApi], [4, 3, true]);
  assert.deepEqual(db.calls.filter(call => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.sql)).map(call => call.sql), ['BEGIN', 'COMMIT']);
  assert.equal(db.releases, 1);
});

test('duplicate and stale messages are logged as skipped without losing current tracking', async t => {
  const db = fakeDatabase(t, [row(1, [{ ...parcel('A', 'CURRENT', T2), tracking_number_history: ['OLD', 'CURRENT'] }, { ...parcel('B', 'B1'), tracking_number_history: ['B1'] }])]);
  const result = await applyFulfillmentUpdate({ ...fixture, fulfillments: [parcel('A', 'OLD'), parcel('B', 'B1')] });
  assert.deepEqual([result.added, result.updated, result.unchanged, result.stale], [0, 0, 1, 1]);
  assert.deepEqual(db.committedLogs[0].slice(4, 9), [2, 0, 0, 2, 'success']);
  const detail = JSON.parse(db.committedLogs[0][11]);
  assert.deepEqual([detail.stale, detail.unchanged], [1, 1]);
  assert.deepEqual(result.trackingNumbers, ['OLD', 'CURRENT', 'B1']);
});

test('backfill corrects a same-second conflict and does not mark it as a webhook', async t => {
  const db = fakeDatabase(t, [row(1, [parcel('A', 'OLD')])]);
  const result = await applyFulfillmentUpdate({ ...fixture, source: 'backfill', fulfillments: [parcel('A', 'CORRECTED')] });
  assert.equal(result.updated, 1);
  const update = db.calls.find(call => call.sql.startsWith('UPDATE'))!;
  assert.deepEqual(update.values.slice(2), ['backfill', null, null]);
  assert.equal(JSON.parse(db.committedLogs[0][11]).skippedApi, false);
});

test('unchanged backfill logs the check without rewriting already consistent snapshots', async t => {
  const existing = [{ ...parcel('A', 'SAME'), tracking_number_history: ['SAME'] }];
  const db = fakeDatabase(t, [row(1, existing), row(2, existing)]);
  const result = await applyFulfillmentUpdate({ ...fixture, source: 'backfill', fulfillments: existing });
  assert.equal(result.unchanged, 1);
  assert.ok(!db.calls.some(call => call.sql.startsWith('UPDATE')));
  assert.equal(db.committedLogs.length, 1);
});

test('backfill still writes when email snapshots differ or an explicit overall status advances', async t => {
  await t.test('inconsistent snapshots', async st => {
    const db = fakeDatabase(st, [row(1, [parcel('A', 'SAME')]), row(2, [parcel('A', 'SAME'), parcel('B', 'SECOND')])]);
    await applyFulfillmentUpdate({ ...fixture, source: 'backfill', fulfillments: [parcel('A', 'SAME')] });
    assert.ok(db.calls.some(call => call.sql.startsWith('UPDATE')));
    assert.deepEqual(db.rows[0].raw_order_json, db.rows[1].raw_order_json);
  });
  await t.test('overall status advancement', async st => {
    const db = fakeDatabase(st, [row(1, [parcel('A', 'SAME')])]);
    await applyFulfillmentUpdate({ ...fixture, source: 'backfill', fulfillmentStatus: 'shipped', fulfillments: [parcel('A', 'SAME')] });
    assert.ok(db.calls.some(call => call.sql.startsWith('UPDATE')));
    assert.equal(db.rows[0].fulfillment_status, 'shipped');
  });
});

test('explicit supported overall status advances monotonically and stale data cannot advance it', async t => {
  const cases = [
    { previous: '', incoming: 'partially_shipped', expected: 'partially_shipped' },
    { previous: 'initialled', incoming: 'shipped', expected: 'shipped' },
    { previous: 'waiting', incoming: 'partially_shipped', expected: 'partially_shipped' },
    { previous: 'partially_shipped', incoming: 'shipped', expected: 'shipped' },
    { previous: 'shipped', incoming: 'partially_shipped', expected: 'shipped' },
    { previous: 'delivered', incoming: 'shipped', expected: 'delivered' },
    { previous: 'waiting', incoming: 'cancelled', expected: 'waiting' },
    { previous: 'waiting', incoming: undefined, expected: 'waiting' },
    { previous: 'waiting', incoming: 'shipped', expected: 'waiting', stale: true },
  ];
  for (const item of cases) {
    await t.test(`${item.previous || 'empty'} -> ${item.incoming || 'not supplied'}${item.stale ? ' (stale)' : ''}`, async st => {
      const db = fakeDatabase(st, [row(1, [parcel('A', 'CURRENT', T2)], item.previous)]);
      await applyFulfillmentUpdate({ ...fixture, fulfillmentStatus: item.incoming,
        fulfillments: [{ ...parcel('A', item.stale ? 'OLD' : 'NEW', item.stale ? T1 : T3), status: 'shipped' }] });
      assert.equal(db.rows[0].fulfillment_status, item.expected);
    });
  }
});

test('an unmatched order is logged without creating any snapshot or email', async t => {
  const db = fakeDatabase(t, []);
  const result = await applyFulfillmentUpdate({ ...fixture, orderNumber: '#UNMATCHED', fulfillments: [parcel('A', 'A1')] });
  assert.equal(result.matched, false);
  assert.equal(result.orderNumber, '#UNMATCHED');
  assert.deepEqual(result.trackingNumbers, []);
  assert.ok(!db.calls.some(call => call.sql.startsWith('UPDATE') || call.sql.includes('email')));
  assert.deepEqual(db.committedLogs[0].slice(4, 10), [1, 0, 0, 1, 'failed', 'Order snapshot not found']);
  assert.deepEqual(db.rows, []);
});

test('invalid inputs are rejected before obtaining a database connection', async t => {
  const db = fakeDatabase(t, []);
  await assert.rejects(applyFulfillmentUpdate({ ...fixture, fulfillments: [{ id: '' }] }), /Invalid fulfillment id/);
  await assert.rejects(applyFulfillmentUpdate({ ...fixture, storeSubdomain: '', fulfillments: [] }), /requires storeSubdomain/);
  await assert.rejects(applyFulfillmentUpdate({ ...fixture, source: 'invalid' as any, fulfillments: [] }), /Invalid fulfillment source/);
  assert.equal(db.connections, 0);
});

for (const failAt of ['update', 'log'] as const) {
  test(`${failAt} failure rolls back snapshot and log together, preserves original error, and releases client`, async t => {
    const initial = [row(1, [parcel('A', 'OLD')])];
    const db = fakeDatabase(t, initial, failAt);
    await assert.rejects(applyFulfillmentUpdate({ ...fixture, fulfillments: [parcel('A', 'NEW', T2)] }), error => error === db.failure);
    assert.deepEqual(db.rows, initial);
    assert.deepEqual(db.committedLogs, []);
    assert.equal(db.calls.at(-1)?.sql, 'ROLLBACK');
    assert.ok(!db.calls.some(call => call.sql === 'COMMIT'));
    assert.equal(db.releases, 1);
  });
}

test('concurrent writers acquire the order lock before reading and preserve both package changes', async t => {
  const db = fakeDatabase(t, [row(1, [parcel('A', 'OLD')]), row(2, [parcel('A', 'OLD')])]);
  const [updated, added] = await Promise.all([
    applyFulfillmentUpdate({ ...fixture, fulfillments: [parcel('A', 'NEW', T2)] }),
    applyFulfillmentUpdate({ ...fixture, fulfillments: [parcel('B', 'SECOND')] }),
  ]);
  assert.equal(updated.updated, 1);
  assert.equal(added.added, 1);
  assert.ok(db.waitedForLock > 0, 'the second transaction waits for the first commit');
  assert.deepEqual(db.rows[0].raw_order_json.fulfillments, [
    { ...parcel('A', 'NEW', T2), tracking_number_history: ['OLD', 'NEW'] },
    { ...parcel('B', 'SECOND'), tracking_number_history: ['SECOND'] },
  ]);
  assert.deepEqual(db.rows[0].raw_order_json, db.rows[1].raw_order_json);
  assert.equal(db.committedLogs.length, 2);
  assert.equal(db.releases, 2);
});
