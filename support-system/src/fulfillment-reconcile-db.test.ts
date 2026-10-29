import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { Pool } from 'pg';

const testUrl = process.env.SUPPORT_LOGISTICS_TEST_DATABASE_URL;

test('logistics selection uses recent order dates, active tickets, per-store budgets and due times in PostgreSQL',
  { skip: !testUrl, timeout: 60_000 }, async t => {
    const url = new URL(testUrl!);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.match(url.pathname, /^\/support_[a-z0-9_]*_test$/i);
    assert.equal(url.search, '');
    const pool = new Pool({ connectionString: testUrl, max: 3 });
    const stores = ['store-a', 'store-b'].map(subdomain => ({ subdomain, store_name: subdomain, access_token: 'unused-fixture' }));
    const applied: Array<{ store: string; order: string }> = [];
    const load = (name: string): any => {
      const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, name), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      }).outputText;
      const module = { exports: {} };
      const dependencies: Record<string, unknown> = {
        './pg': { getClient: () => pool.connect() },
        './store-service': { getEnabledStores: async () => stores },
        './shoplazza-client': {
          listOrderFulfillments: async () => [],
          listOrderFulfillmentsBatch: async (_store: unknown, ids: string[]) => new Map(ids.map(id => [id, []])),
        },
        './fulfillment-service': { applyFulfillmentUpdate: async (params: any) => {
          applied.push({ store: params.storeSubdomain, order: params.orderId });
          return { matched: true, added: 0, updated: 0, unchanged: 0, stale: 0, trackingNumbers: [], changes: [] };
        } },
        './log-service': { logSync: async () => {} },
      };
      vm.runInNewContext(source, { module, exports: module.exports, Date, console,
        require(key: string) {
          if (key === './fulfillment-selection') return load('fulfillment-selection.ts');
          if (!(key in dependencies)) throw new Error(`Unapproved dependency: ${key}`);
          return dependencies[key];
        },
      });
      return module.exports;
    };
    const reset = async () => {
      await pool.query('TRUNCATE support_order_snapshots, support_tickets, support_fulfillment_sync_state');
      applied.length = 0;
    };
    const seed = async (id: string, days: number, store = 'store-a', payment = 'paid', duplicate = false) => {
      await pool.query(`INSERT INTO support_order_snapshots(store_subdomain,order_id,order_number,payment_status,paid_at,raw_order_json)
        VALUES($1,$2,$2,$3,now()-make_interval(days=>$4),
          jsonb_build_object('placed_at',now()-make_interval(days=>$4),'created_at',now()-make_interval(days=>$4)))`,
      [store, id, payment, days]);
      if (duplicate) await seed(id, days, store, payment);
    };
    const ticket = async (id: string, lastMessageDays: number, store = 'store-a') => {
      await pool.query(`INSERT INTO support_tickets(store_subdomain,order_id,created_at,updated_at,last_agent_message_at,last_customer_viewed_at)
        VALUES($1,$2,now()-interval '70 days',now()-make_interval(days=>$3),now()-make_interval(days=>$3),now())`, [store, id, lastMessageDays]);
    };
    const state = async (id: string, checkedHours: number, nextHours: number, error: string | null = null) => {
      await pool.query(`INSERT INTO support_fulfillment_sync_state(store_subdomain,order_id,last_attempt_at,last_checked_at,next_check_at,last_error)
        VALUES('store-a',$1,now()-make_interval(hours=>$2),now()-make_interval(hours=>$2),now()+make_interval(hours=>$3),$4)`,
      [id, checkedHours, nextHours, error]);
    };
    try {
      assert.equal(Number((await pool.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0].count), 0,
        'a fresh empty disposable database is required');
      await pool.query(`
        CREATE TABLE support_order_snapshots (
          id bigserial PRIMARY KEY, store_subdomain text, order_id text, order_number text,
          payment_status text, paid_at timestamptz, created_at timestamptz DEFAULT now(), raw_order_json jsonb);
        CREATE TABLE support_tickets (
          store_subdomain text, order_id text, created_at timestamptz, updated_at timestamptz,
          last_customer_message_at timestamptz, last_agent_message_at timestamptz,
          last_customer_viewed_at timestamptz, closed_at timestamptz);
        CREATE TABLE support_fulfillment_sync_state (
          store_subdomain text, order_id text, last_attempt_at timestamptz, last_checked_at timestamptz,
          next_check_at timestamptz, last_error text, PRIMARY KEY(store_subdomain,order_id));
      `);
      await t.test('recent active tickets include old orders while stale tickets and recent views do not', async () => {
        await reset();
        await seed('recent', 10, 'store-a', 'paid', true);
        await seed('old-newly-imported', 60);
        await seed('old-active', 60); await ticket('old-active', 5);
        await seed('old-stale', 60); await ticket('old-stale', 31);
        await seed('cross-store', 60); await ticket('cross-store', 1, 'store-b');
        await seed('partial', 5, 'store-a', 'partially_refunded');
        await seed('refunded', 5, 'store-a', 'refunded');
        await load('fulfillment-reconcile.ts').runFulfillmentReconciliation();
        assert.deepEqual(applied.map(x => x.order), ['old-active', 'partial', 'recent']);
        const intervals = (await pool.query(`SELECT order_id,extract(epoch FROM(next_check_at-last_checked_at))/3600 AS hours
          FROM support_fulfillment_sync_state ORDER BY order_id`)).rows;
        assert.deepEqual(intervals.map(x => [x.order_id, Math.round(Number(x.hours))]), [['old-active', 6], ['partial', 24], ['recent', 24]]);
      });
      await t.test('each store receives its own quota and duplicate snapshots consume one slot', async () => {
        await reset();
        for (const store of ['store-a', 'store-b']) {
          await seed('one', 1, store, 'paid', true); await seed('two', 2, store); await seed('three', 3, store);
        }
        const result = await load('fulfillment-reconcile.ts').runFulfillmentReconciliation({ limit: 2 });
        assert.equal(result.checked, 4);
        assert.deepEqual(Array.from(result.stores, (x: any) => x.checked), [2, 2]);
        assert.equal(result.remainingDue, 2);
        assert.equal(new Set(applied.map(x => `${x.store}/${x.order}`)).size, 4);
      });
      await t.test('reopening an old ticket renews priority even without a new message', async () => {
        await reset(); await seed('reopened', 90); await ticket('reopened', 45);
        // reopenTicket updates updated_at and clears closed_at without fabricating a message timestamp.
        await pool.query("UPDATE support_tickets SET updated_at=now(),closed_at=NULL WHERE order_id='reopened'");
        await load('fulfillment-reconcile.ts').runFulfillmentReconciliation();
        assert.deepEqual(applied.map(x => x.order), ['reopened']);
      });
      await t.test('newly active tickets accelerate successful checks but do not bypass failure backoff', async () => {
        await reset();
        for (const id of ['priority-due', 'priority-early', 'priority-failed', 'normal-early']) await seed(id, 10);
        for (const id of ['priority-due', 'priority-early', 'priority-failed']) await ticket(id, 1);
        await state('priority-due', 8, 16);
        await state('priority-early', 2, 22);
        await state('priority-failed', 8, 1, 'fixture failure');
        await state('normal-early', 8, 16);
        await load('fulfillment-reconcile.ts').runFulfillmentReconciliation();
        assert.deepEqual(applied.map(x => x.order), ['priority-due']);
      });
      await t.test('invalid upstream dates use valid fallback dates and unknown dates do not make old imports recent', async () => {
        await reset();
        await seed('fallback', 3);
        await pool.query(`UPDATE support_order_snapshots SET raw_order_json=jsonb_build_object('placed_at','invalid','created_at',now()-interval '3 days')`);
        await pool.query(`INSERT INTO support_order_snapshots(store_subdomain,order_id,order_number,payment_status,raw_order_json)
          VALUES('store-a','unknown','unknown','paid','{}')`);
        await load('fulfillment-reconcile.ts').runFulfillmentReconciliation();
        assert.deepEqual(applied.map(x => x.order), ['fallback']);
      });
      await t.test('manual explicit order checks remain possible outside the automated window', async () => {
        await reset(); await seed('old-manual', 100); await state('old-manual', 1, 23);
        await load('fulfillment-reconcile.ts').runFulfillmentReconciliation({ storeSubdomain: 'store-a', orderId: 'old-manual' });
        assert.deepEqual(applied.map(x => x.order), ['old-manual']);
      });
    } finally { await pool.end(); }
  });
