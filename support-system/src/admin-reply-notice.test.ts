import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import express from 'express';
import ts from 'typescript';

const TICKET = {
  public_ticket_no: 'T-OFFLINE', store_subdomain: 'fixture-store', store_name: 'Fixture Store',
  order_id: 'fixture-order', order_number: '#1001', customer_email: 'buyer@example.invalid', status: 'waiting',
};
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'admin-routes.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function harness(options: { snapshotName?: string | null; ticketName?: string | null; missingSnapshot?: boolean; missingTicket?: boolean; closed?: boolean } = {}) {
  const calls = { tickets: [] as string[], snapshots: [] as any[], notices: [] as any[], messages: [] as any[], processed: [] as any[] };
  const forbid = () => { throw new Error('Offline route attempted a live database, API or mail dependency'); };
  const pass: express.RequestHandler = (_req, _res, next) => next();
  const dependencies: Record<string, unknown> = {
    express, crypto, 'express-rate-limit': () => pass,
    './auth': {
      SESSION_COOKIE_NAME: 'fixture',
      getRequestAgent: async (req: any) => req.headers.cookie === 'fixture=yes' ? { agentId: 7, name: 'Offline Agent' } : null,
    },
    './ticket-service': {
      getTicketByPublicNo: async (id: string) => {
        calls.tickets.push(id);
        return options.missingTicket ? null : { ...TICKET, customer_name: options.ticketName, status: options.closed ? 'closed' : TICKET.status };
      },
      getOrderSnapshot: async (params: unknown) => {
        calls.snapshots.push(params);
        return options.missingSnapshot ? null : { customer_name: options.snapshotName, raw_order_json: {} };
      },
      addAgentMessage: async (params: unknown) => { calls.messages.push(params); },
    },
    './email-service': {
      extractStoreCustomDomain: () => '',
      ensureAgentReplyNoticeJob: async (params: unknown) => { calls.notices.push(params); return { job: { id: 42 }, created: true }; },
      processDueEmailJobs: async (params: unknown) => { calls.processed.push(params); },
      getEmailJobDetail: async () => ({ job: { id: 42 } }),
    },
    './config': { buildStoreDomain: () => 'fixture-store.myshoplaza.com' },
    './storage-service': { uploadAttachments: pass, processAttachments: forbid },
    './pg': { query: forbid }, './store-service': {}, './backfill-jobs': {}, './log-service': {},
    './admin-preview': {}, './shoplazza-client': {}, './webhook-security': {}, './normalize-order': {}, './order-address-service': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Forbidden dependency: ${name}`);
      return dependencies[name];
    },
  });
  const router = (module.exports as typeof import('./admin-routes')).createAdminRouter();
  function post(endpoint: string, authenticated = true) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      let status = 200;
      const request = {
        method: 'POST', url: `/tickets/${TICKET.public_ticket_no}/${endpoint}`,
        headers: authenticated ? { cookie: 'fixture=yes' } : {},
        body: { content: 'We have an update.', customerName: 'Untrusted request name' },
      };
      const response = {
        status(code: number) { status = code; return this; },
        json(body: unknown) { resolve({ status, body }); return this; },
      };
      router(request as express.Request, response as express.Response, error => reject(error || new Error('Route did not respond')));
    });
  }
  return { calls, post };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

for (const endpoint of ['messages', 'notify-email']) {
  for (const scenario of [
    { name: 'prefers the trimmed order snapshot name', options: { snapshotName: '  Snapshot Buyer  ', ticketName: 'Ticket Buyer' }, expected: 'Snapshot Buyer' },
    { name: 'falls back to the trimmed ticket name when the snapshot name is blank', options: { snapshotName: ' \t ', ticketName: '  Ticket Buyer  ' }, expected: 'Ticket Buyer' },
    { name: 'falls back to the ticket name when the snapshot is absent', options: { missingSnapshot: true, ticketName: 'Ticket Buyer' }, expected: 'Ticket Buyer' },
    { name: 'leaves an absent name for the email renderer fallback', options: { snapshotName: null, ticketName: null }, expected: undefined },
    { name: 'leaves blank names for the email renderer fallback', options: { snapshotName: '  ', ticketName: '\t ' }, expected: undefined },
  ]) {
    test(`${endpoint} reply notice ${scenario.name}`, { timeout: 5000 }, async () => {
      const subject = harness(scenario.options);
      const response = await subject.post(endpoint);
      assert.equal(response.status, 200);
      assert.equal(subject.calls.notices.length, 1);
      assert.equal(subject.calls.notices[0].customerName, scenario.expected);
      assert.deepEqual(plain(subject.calls.snapshots), [{
        storeSubdomain: 'fixture-store', orderId: 'fixture-order', customerEmail: 'buyer@example.invalid',
      }]);
      assert.equal(subject.calls.messages.length, endpoint === 'messages' ? 1 : 0);
      assert.deepEqual(plain(subject.calls.processed), endpoint === 'notify-email' ? [{ limit: 1, onlyJobId: 42 }] : []);
    });
  }

  test(`${endpoint} reply notice requires authentication before reading the ticket`, { timeout: 5000 }, async () => {
    const subject = harness({ snapshotName: 'Snapshot Buyer' });
    assert.equal((await subject.post(endpoint, false)).status, 401);
    assert.equal(subject.calls.tickets.length + subject.calls.snapshots.length + subject.calls.notices.length + subject.calls.messages.length, 0);
  });

  test(`${endpoint} reply notice preserves missing and closed ticket checks`, { timeout: 5000 }, async () => {
    for (const [options, expectedStatus] of [[{ missingTicket: true }, 404], [{ closed: true }, 400]] as const) {
      const subject = harness(options);
      assert.equal((await subject.post(endpoint)).status, expectedStatus);
      assert.equal(subject.calls.snapshots.length + subject.calls.notices.length + subject.calls.messages.length + subject.calls.processed.length, 0);
    }
  });
}
