#!/usr/bin/env node
'use strict';

// Run only against a new, empty local PostgreSQL database. Never load .env.
// FULFILLMENT_TEST_DATABASE_URL=postgresql://.../support_fulfillment_test node scripts/test-fulfillment-integration.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');

const dsn = process.env.FULFILLMENT_TEST_DATABASE_URL;
if (!dsn) throw new Error('An explicit FULFILLMENT_TEST_DATABASE_URL is required');
const target = new URL(dsn);
const database = decodeURIComponent(target.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || !/^support_[a-z0-9_]*test[a-z0-9_]*$/i.test(database)
    || target.search) {
  throw new Error('Integration tests require a local support_*test* database without URL options');
}
process.env.SUPPORT_DATABASE_URL = dsn;
process.env.SUPPORT_PG_POOL_MAX = '10';
require('tsx/cjs');
const pg = require('../src/pg.ts');
const service = require('../src/fulfillment-service.ts');
const logService = require('../src/log-service.ts');
const pool = pg.getPool();
const store = { id: 1, subdomain: 'integration-fixture', store_name: 'Integration Fixture', access_token: 'unused-fixture', enabled: true };
const base = { storeSubdomain: store.subdomain, source: 'webhook' };
const times = ['2026-10-20T10:00:00Z', '2026-10-20T10:00:01Z', '2026-10-20T10:00:02Z'];
const parcel = (id, tracking_number, updated_at = times[0]) => ({ id, tracking_number, updated_at });
const plain = value => JSON.parse(JSON.stringify(value));

function loadModule(filename, dependencies) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, require(name) {
    if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unapproved test dependency: ${name}`);
    return dependencies[name];
  } }, { filename });
  return module.exports;
}

function worker() {
  return loadModule('fulfillment-webhook.ts', {
    crypto, './pg': pg, './fulfillment-service': service,
    './store-service': { getStoreBySubdomain: async () => store },
  });
}

async function addOrder(id, fulfillments, email = 'one@example.invalid', status = 'waiting') {
  await pool.query(`INSERT INTO support_order_snapshots
    (store_subdomain, order_id, order_number, customer_email, payment_status, fulfillment_status, raw_order_json)
    VALUES ($1,$2,$3,$4,'paid',$5,$6::jsonb)`,
  [store.subdomain, id, `#${id}`, email, status, JSON.stringify({ id, preserved: 'original', fulfillments })]);
}

async function snapshots(id) {
  return (await pool.query(`SELECT raw_order_json, fulfillment_status, updated_at::text, xmin::text
    FROM support_order_snapshots WHERE store_subdomain=$1 AND order_id=$2 ORDER BY id`, [store.subdomain, id])).rows;
}

async function realConcurrency() {
  const original = [{ id: 'A', updated_at: times[0], tracking_items: [{ tracking_number: 'OLD', carrier: 'Original' }] }];
  await addOrder('CONCURRENT', original);
  await addOrder('CONCURRENT', original, 'two@example.invalid');
  const blocker = await pool.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM support_order_snapshots WHERE order_id=$1 FOR UPDATE', ['CONCURRENT']);
    pending = Promise.all([
      service.applyFulfillmentUpdate({ ...base, orderId: 'CONCURRENT', fulfillments: [parcel('A', 'NEW', times[1])] }),
      service.applyFulfillmentUpdate({ ...base, orderId: 'CONCURRENT', fulfillments: [parcel('B', 'SECOND')] }),
    ]);
    pending.catch(() => {});
    let waiting = 0;
    for (let attempt = 0; attempt < 50 && waiting < 2; attempt++) {
      waiting = Number((await pool.query(`SELECT count(*) FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%ORDER BY id FOR UPDATE%'`)).rows[0].count);
      if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, 2, 'both real transactions must block while acquiring the order read lock');
    await blocker.query('COMMIT');
    await pending;
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    if (pending) await pending;
  }
  let rows = await snapshots('CONCURRENT');
  assert.deepEqual(rows[0].raw_order_json, rows[1].raw_order_json);
  assert.deepEqual(rows[0].raw_order_json.fulfillments, [
    { ...parcel('A', 'NEW', times[1]), tracking_number_history: ['OLD', 'NEW'] },
    { ...parcel('B', 'SECOND'), tracking_number_history: ['SECOND'] },
  ]);
  await service.applyFulfillmentUpdate({ ...base, orderId: 'CONCURRENT', fulfillments: [parcel('A', 'NEWER', times[2])] });
  rows = await snapshots('CONCURRENT');
  assert.equal(rows[0].raw_order_json.fulfillments.length, 2);
  assert.equal(rows[0].raw_order_json.fulfillments[0].tracking_number, 'NEWER');
  assert.deepEqual(rows[0].raw_order_json.fulfillments[0].tracking_number_history, ['OLD', 'NEW', 'NEWER']);
  const late = await Promise.all([
    service.applyFulfillmentUpdate({ ...base, orderId: 'CONCURRENT', fulfillments: [parcel('A', 'DOMESTIC-LATE', times[0])] }),
    service.applyFulfillmentUpdate({ ...base, orderId: 'CONCURRENT', fulfillments: [parcel('A', 'EXPORT-LATE', times[1])] }),
  ]);
  assert.ok(late.every(result => result.updated === 1 && result.stale === 0 && result.changes[0].kind === 'history_added'));
  rows = await snapshots('CONCURRENT');
  const saved = rows[0].raw_order_json.fulfillments[0];
  assert.equal(saved.tracking_number, 'NEWER');
  assert.equal(saved.updated_at, times[2]);
  assert.deepEqual(new Set(saved.tracking_number_history), new Set(['OLD', 'NEW', 'NEWER', 'DOMESTIC-LATE', 'EXPORT-LATE']));
  assert.deepEqual(rows[0].raw_order_json, rows[1].raw_order_json);
  const repeat = await service.applyFulfillmentUpdate({ ...base, orderId: 'CONCURRENT', fulfillments: [parcel('A', 'DOMESTIC-LATE', times[0])] });
  assert.equal(repeat.stale, 1);
  assert.equal(repeat.updated, 0);
  assert.deepEqual(repeat.changes[0].addedTrackingNumbers, []);
  const historyLogs = (await pool.query("SELECT items_updated, items_skipped, detail_json FROM support_sync_logs WHERE detail_json->'changes'->0->>'kind'='history_added'")).rows;
  assert.equal(historyLogs.length, 2);
  assert.ok(historyLogs.every(log => log.items_updated === 1 && log.items_skipped === 0 && log.detail_json.changes[0].addedTrackingNumbers.length === 1));
  rows = await snapshots('CONCURRENT');
  const before = plain(rows);
  await service.applyFulfillmentUpdate({ ...base, source: 'backfill', orderId: 'CONCURRENT', fulfillments: rows[0].raw_order_json.fulfillments });
  assert.deepEqual(await snapshots('CONCURRENT'), before, 'no-op backfill must preserve xmin, updated_at, and raw JSON');
  console.log('PASS real concurrent updates/history accumulation, late-event logs, format changes, same-id replacement, and no-op preservation');
}

async function atomicLogRollback() {
  await addOrder('ROLLBACK', [{ ...parcel('A', 'OLD'), tracking_number_history: ['OLDER', 'OLD'] }]);
  const before = await snapshots('ROLLBACK');
  await pool.query("ALTER TABLE support_sync_logs ADD CONSTRAINT integration_reject_log CHECK (target_id <> '#ROLLBACK')");
  try {
    await assert.rejects(service.applyFulfillmentUpdate({ ...base, orderId: 'ROLLBACK', fulfillments: [parcel('A', 'NEW', times[1])] }), error => error.code === '23514');
    assert.deepEqual(await snapshots('ROLLBACK'), before);
    assert.equal(Number((await pool.query("SELECT count(*) FROM support_sync_logs WHERE target_id='#ROLLBACK'")).rows[0].count), 0);
  } finally {
    await pool.query('ALTER TABLE support_sync_logs DROP CONSTRAINT integration_reject_log');
  }
  console.log('PASS database log failure rolls back the snapshot transaction');
}

async function durableQueueRetry() {
  const event = { storeSubdomain: store.subdomain, topic: 'fulfillments/update', headers: { 'x-shoplazza-deduplication-id': 'integration-delivery' },
    payload: { fulfillment: { ...parcel('Q', 'QUEUED'), order_id: 'QUEUED' } } };
  await worker().enqueueFulfillmentWebhook(event);
  await worker().enqueueFulfillmentWebhook(event);
  assert.equal(Number((await pool.query('SELECT count(*) FROM shoplazza_webhook_events')).rows[0].count), 1);
  assert.deepEqual(plain(await worker().processPendingFulfillmentWebhooks({ limit: 1 })), { processed: 0, failed: 1 });
  let saved = (await pool.query('SELECT status, attempts, next_attempt_at > now() AS deferred FROM shoplazza_webhook_events')).rows[0];
  assert.deepEqual(saved, { status: 'failed', attempts: 1, deferred: true });
  await addOrder('QUEUED', []);
  await pool.query('UPDATE shoplazza_webhook_events SET next_attempt_at=now()');
  assert.deepEqual(plain(await worker().processPendingFulfillmentWebhooks({ limit: 1 })), { processed: 1, failed: 0 });
  saved = (await pool.query('SELECT status, attempts, next_attempt_at FROM shoplazza_webhook_events')).rows[0];
  assert.deepEqual(saved, { status: 'processed', attempts: 2, next_attempt_at: null });
  assert.equal((await snapshots('QUEUED'))[0].raw_order_json.fulfillments[0].tracking_number, 'QUEUED');
  console.log('PASS persistent queue deduplication and retry after worker reload');
}

function snapshotUpserts(filename) {
  const source = ts.createSourceFile(filename, fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), ts.ScriptTarget.Latest, true);
  const statements = [];
  function visit(node) {
    if (ts.isNoSubstitutionTemplateLiteral(node) && /^INSERT INTO support_order_snapshots\s/.test(node.text.trim())) statements.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return statements;
}

async function normalSnapshotProtection() {
  const kept = [{ ...parcel('PROTECTED', 'CURRENT', times[2]), tracking_number_history: ['DOMESTIC', 'CURRENT'] }];
  await addOrder('PROTECTED', kept, 'one@example.invalid', 'shipped');
  const statements = [...snapshotUpserts('shoplazza-webhook-routes.ts'), ...snapshotUpserts('backfill-jobs.ts')];
  assert.equal(statements.length, 3, 'exercise every current ordinary snapshot upsert');
  for (const sql of statements) {
    const columns = sql.match(/INSERT INTO support_order_snapshots\s*\(([^)]+)\)/)[1].split(',').map(value => value.trim());
    const values = columns.map(column => {
      const known = { store_subdomain: store.subdomain, store_name: store.store_name, order_id: 'PROTECTED', order_number: '#PROTECTED',
        customer_email: 'one@example.invalid', payment_status: 'paid', fulfillment_status: 'waiting',
        raw_order_json: JSON.stringify({ id: 'PROTECTED', fresh_order_field: true, fulfillments: [parcel('PROTECTED', 'STALE')] }),
        items_json: '[]', last_webhook_topic: 'orders/paid' };
      if (column in known) return known[column];
      if (column.endsWith('_json')) return '{}';
      if (column.endsWith('_at')) return new Date().toISOString();
      return '';
    });
    await pool.query(sql, values);
    const saved = (await snapshots('PROTECTED'))[0];
    assert.deepEqual(saved.raw_order_json.fulfillments, kept);
    assert.equal(saved.fulfillment_status, 'shipped');
  }
  console.log('PASS paid webhook and both ordinary backfill SQL paths preserve merged logistics');
}

async function reconcileStateAndCandidates() {
  await addOrder('RETRY', []);
  let fail = true;
  let candidate;
  const dependencies = {
    './pg': { getClient: async () => {
      const client = await pool.connect();
      return { release: error => client.release(error), query: (sql, values) => {
        if (sql.includes('WITH paid_orders AS')) candidate = { sql, values };
        return client.query(sql, values);
      } };
    } },
    './store-service': { getEnabledStores: async () => [store] },
    './shoplazza-client': { listOrderFulfillments: async (_store, orderId) => {
      if (orderId === 'RETRY' && fail) throw new Error('fixture API failure');
      return (await snapshots(orderId))[0].raw_order_json.fulfillments;
    } },
    './fulfillment-service': service, './log-service': logService,
  };
  const run = () => loadModule('fulfillment-reconcile.ts', dependencies).runFulfillmentReconciliation({ limit: 200 });
  const first = await run();
  const uniqueOrders = Number((await pool.query('SELECT count(DISTINCT order_id) FROM support_order_snapshots')).rows[0].count);
  assert.equal(first.checked, uniqueOrders, 'multiple customer emails count as one candidate');
  assert.equal(first.failed, 1);
  let state = (await pool.query("SELECT last_checked_at, last_error, next_check_at > now() AS deferred FROM support_fulfillment_sync_state WHERE order_id='RETRY'")).rows[0];
  assert.deepEqual(state, { last_checked_at: null, last_error: 'fixture API failure', deferred: true });
  const plan = await pool.query(`EXPLAIN (FORMAT JSON) ${candidate.sql}`, candidate.values);
  assert.ok(plan.rows[0]['QUERY PLAN'][0].Plan);
  assert.equal((await run()).checked, 0, 'the next process respects persisted success and retry deadlines');
  await pool.query("UPDATE support_fulfillment_sync_state SET next_check_at=now()-interval '1 second' WHERE order_id='RETRY'");
  fail = false;
  const retried = await run();
  assert.equal(retried.checked, 1);
  assert.equal(retried.failed, 0);
  state = (await pool.query("SELECT last_checked_at IS NOT NULL AS checked, last_error FROM support_fulfillment_sync_state WHERE order_id='RETRY'")).rows[0];
  assert.deepEqual(state, { checked: true, last_error: null });
  console.log('PASS real candidate SQL/EXPLAIN, unique-order selection, durable check deadlines and retry recovery');
}

async function main() {
  const identity = await pool.query('SELECT current_database() AS name');
  assert.equal(identity.rows[0].name, database);
  const tables = await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'");
  assert.equal(Number(tables.rows[0].count), 0, 'integration database must be empty; no existing tables may be touched');
  await pg.ensureTables();
  await realConcurrency();
  await atomicLogRollback();
  await durableQueueRetry();
  await normalSnapshotProtection();
  await reconcileStateAndCandidates();
  console.log('PASS all fulfillment PostgreSQL integration scenarios (no external API or email calls)');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
