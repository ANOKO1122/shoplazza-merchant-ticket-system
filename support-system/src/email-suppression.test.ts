import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const plain = (value: any) => JSON.parse(JSON.stringify(value));
function load<T>(filename: string, dependencies: Record<string, unknown>): T {
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

function harness(options: { type?: string; status?: string; suppressed?: boolean; suppressDuringPreparation?: boolean; lookupFails?: boolean } = {}) {
  let suppressed = options.suppressed ?? true;
  const job: any = { id: 1, email_job_no: 'OFFLINE', event_key: 'offline-key', store_subdomain: 'offline', order_id: 'ORDER',
    customer_email: 'fixture@example.invalid', email_type: options.type || 'paid_support_invite', status: options.status || 'pending',
    subject_snapshot: 'Fixture', body_snapshot: '<p>Fixture body</p>', ordered_at: '2020-01-01T00:00:00Z', token_id: 1 };
  const calls = { sent: 0, suppressionReads: 0, tokens: 0, sentEvents: 0, snapshots: 0, logs: [] as any[] };
  const pg = { query: async (text: string, values: any[] = []): Promise<any> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('SELECT reason FROM support_order_notification_suppressions')) {
      calls.suppressionReads++;
      assert.deepEqual(plain(values), [job.store_subdomain, job.order_id]);
      if (options.lookupFails) throw new Error('suppression storage unavailable');
      return { rows: suppressed ? [{ reason: 'fulfillment_recovery' }] : [], rowCount: suppressed ? 1 : 0 };
    }
    if (sql.startsWith('SELECT auto_send_enabled')) return { rows: [{ auto_send_enabled: true }], rowCount: 1 };
    if (sql.startsWith('SELECT id FROM support_email_jobs')) return { rows: job.status === 'pending' ? [{ id: 1 }] : [], rowCount: job.status === 'pending' ? 1 : 0 };
    if (sql.startsWith('SELECT * FROM support_email_jobs WHERE id')) return { rows: [{ ...job }], rowCount: 1 };
    if (sql.startsWith('SELECT status FROM support_email_jobs')) return { rows: [{ status: job.status }], rowCount: 1 };
    if (sql.startsWith('SELECT count(*)::int AS cnt')) return { rows: [{ cnt: job.status === 'pending' ? 1 : 0 }], rowCount: 1 };
    if (sql.startsWith('SELECT customer_name,')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('UPDATE support_email_jobs SET status')) {
      const status = /SET status = '([^']+)'/.exec(sql)![1];
      if (status === 'sending' && job.status !== 'pending') return { rows: [], rowCount: 0 };
      if (status === 'skipped') {
        assert.match(sql, /status = 'sending'/);
        job.last_error = values[1];
      }
      job.status = status;
      return { rows: [{ ...job }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE support_email_jobs SET token_id')) {
      if (options.suppressDuringPreparation) suppressed = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO support_email_events')) { calls.sentEvents++; return { rows: [], rowCount: 1 }; }
    if (sql.startsWith('INSERT INTO support_order_snapshots')) { calls.snapshots++; return { rows: [{ is_new: false }], rowCount: 1 }; }
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  } };
  const subject = load<typeof import('./email-service')>('email-service.ts', {
    crypto, './pg': pg, './config': { loadConfig: () => ({}), buildStoreDomain: () => 'offline.invalid' },
    './mailer': { sendSupportEmail: async () => { calls.sent++; return { messageId: 'OFFLINE-SMTP-MOCK' }; } },
    './token': { createBootstrapToken: () => { calls.tokens++; throw new Error('Unexpected token creation'); },
      createTicketAccessToken: () => { calls.tokens++; throw new Error('Unexpected token creation'); } },
    './log-service': { logOperation: async (entry: any) => { calls.logs.push(entry); } },
  });
  return { subject, job, calls, pg };
}

for (const entry of ['automatic', 'send-all', 'retry'] as const) {
  test(`${entry} cannot send a suppressed paid invitation, including a previously skipped task`, async () => {
    const h = harness({ status: entry === 'retry' ? 'skipped' : 'pending' });
    if (entry === 'automatic') {
      assert.deepEqual(plain(await h.subject.processDueEmailJobs()), { picked: 1, sent: 0, failed: 0 });
    } else if (entry === 'send-all') {
      assert.deepEqual(plain(await h.subject.sendPendingEmailJobs()), { picked: 1, sent: 0, failed: 0, remaining: 0 });
    } else {
      assert.equal((await h.subject.resendEmailJob(1))?.status, 'skipped');
    }
    assert.equal(h.job.status, 'skipped');
    assert.equal(h.job.last_error, 'paid_invite_suppressed: fulfillment_recovery');
    assert.equal(h.calls.sent, 0); assert.equal(h.calls.sentEvents, 0);
    assert.equal(h.calls.logs[0].action, 'job_skipped');
  });
}

test('the final send guard observes a suppression marker committed after the job was claimed', async () => {
  const h = harness({ suppressed: false, suppressDuringPreparation: true });
  await h.subject.processDueEmailJobs({ onlyJobId: 1 });
  assert.equal(h.job.status, 'skipped'); assert.equal(h.calls.sent, 0);
});

test('suppression lookup failure fails closed instead of reaching SMTP', async () => {
  const h = harness({ lookupFails: true });
  const result = await h.subject.processDueEmailJobs({ onlyJobId: 1 });
  assert.equal(h.job.status, 'failed'); assert.equal(result.failed, 1); assert.equal(h.calls.sent, 0);
});

test('unmarked paid invitation keeps the normal automatic send path without a global order-age cutoff', async () => {
  const h = harness({ suppressed: false });
  assert.deepEqual(plain(await h.subject.processDueEmailJobs()), { picked: 1, sent: 1, failed: 0 });
  assert.equal(h.job.status, 'sent'); assert.equal(h.calls.sent, 1); assert.equal(h.calls.sentEvents, 1);
});

for (const type of ['agent_reply_notice', 'customer_complaint_invite', 'ticket_closed_notice']) {
  test(`${type} still sends when the same order has paid-invite suppression`, async () => {
    const h = harness({ type });
    await h.subject.processDueEmailJobs({ onlyJobId: 1 });
    assert.equal(h.job.status, 'sent'); assert.equal(h.calls.sent, 1); assert.equal(h.calls.suppressionReads, 0);
  });
}

test('late paid webhook completes its snapshot update when invitation creation returns job=null', async () => {
  const h = harness();
  const forbidden = () => { throw new Error('Unexpected external API call'); };
  const paid = load<typeof import('./paid-webhook')>('paid-webhook.ts', {
    crypto, './pg': h.pg, './config': { buildStoreDomain: () => 'offline.invalid' },
    './normalize-order': load('normalize-order.ts', {}),
    './shipping-address-guard': { withSnapshotShippingAddressGuard: async (normalized: any, _fetch: unknown, write: any) => write(h.pg, normalized) },
    './shoplazza-client': { getOrderDetail: forbidden, getOrderByNumber: forbidden, getOrderTransactions: forbidden, getOrderForAddressUpdate: forbidden },
    './email-service': h.subject, './log-service': { logSync: async () => undefined },
  });
  const result = await paid.processOrderWebhook({
    store: { subdomain: 'offline', storeName: 'Offline', accessToken: 'fake-only' }, topic: 'orders/paid',
    payload: { order: { id: 'ORDER', number: 'OFFLINE-1', financial_status: 'paid', created_at: '2020-01-01T00:00:00Z',
      customer: { email: 'fixture@example.invalid' }, payment_line: { payment_channel: 'paypal' }, line_items: [{ title: 'Fixture', quantity: 1 }] } },
  });
  assert.equal(result.orderNumber, 'OFFLINE-1'); assert.equal(h.calls.snapshots, 1);
  assert.equal(h.calls.tokens, 0); assert.equal(h.calls.sent, 0);
});
