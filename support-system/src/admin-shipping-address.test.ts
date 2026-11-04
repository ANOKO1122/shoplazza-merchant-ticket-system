import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import ts from 'typescript';
import * as protectionEmailTemplate from './protection-email-template';

const TICKET = { public_ticket_no: 'T-OFFLINE', store_subdomain: 'real-store', order_id: 'real-order', customer_email: 'fixture@example.invalid' };
const AGENT = { agentId: 7, name: 'Offline Agent', role: 'agent' };
const ADDRESS = { first_name: 'Fixture', last_name: 'Buyer', address: '12 Example Road', address1: 'Unit 2', city: 'Example City', country_code: 'US', email: 'fixture@example.invalid' };
class FixtureAddressError extends Error {
  constructor(public code: string, message: string, public statusCode: number) { super(message); }
}
function loadRouter(dependencies: Record<string, unknown>) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'admin-routes.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console: { log() {}, error() {}, warn() {} },
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Forbidden dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports as typeof import('./admin-routes');
}
async function harness(t: TestContext, options: { readError?: Error; submitError?: Error; request?: any; missingTicket?: boolean; workerGate?: Promise<unknown> } = {}) {
  const calls = { tickets: [] as string[], reads: [] as any[], submissions: [] as any[], lookups: [] as string[], wakes: [] as string[] };
  const forbid = () => { throw new Error('Unmocked business/API/mail dependency'); };
  const request = options.request || { id: '42', status: 'pending', storeSubdomain: TICKET.store_subdomain, orderId: TICKET.order_id,
    patch: { city: 'New City' }, expectedAddress: ADDRESS, desiredAddress: { ...ADDRESS, city: 'New City' } };
  const dependencies: Record<string, unknown> = {
    './protection-email-template': protectionEmailTemplate,
    './email-preferences': {}, './protection-customer-auth': {},
    './email-preferences-admin-routes': { createEmailPreferencesAdminRouter: () => express.Router() },
    express, crypto, 'express-rate-limit': () => (_req: unknown, _res: unknown, next: () => void) => next(),
    './auth': { SESSION_COOKIE_NAME: 'fixture', getRequestAgent: async (req: any) => req.headers.cookie === 'fixture=yes' ? AGENT : null },
    './ticket-service': { getTicketByPublicNo: async (id: string) => { calls.tickets.push(id); return options.missingTicket ? null : TICKET; },
      getOrderSnapshot: async () => ({ shipping_address_json: ADDRESS, items_json: [] }), getTicketMessages: async () => [] },
    './order-address-service': {
      ShippingAddressError: FixtureAddressError,
      getOrderShippingAddress: async (params: unknown) => { calls.reads.push(params); if (options.readError) throw options.readError;
        return { address: ADDRESS, editable: true, hasWriteScope: true, fulfillmentStatus: 'waiting', updatedAt: '2026-10-27T00:00:00Z' }; },
      submitShippingAddressRequest: async (params: unknown) => { calls.submissions.push(params); if (options.submitError) throw options.submitError; return request; },
      getShippingAddressRequest: async (id: string) => { calls.lookups.push(id); return request; },
      processShippingAddressRequest: async (id: string) => { calls.wakes.push(id); await options.workerGate; return request; },
    },
    './admin-preview': { buildTrackingDetails: () => ({ tracking_numbers: [], shipments: [] }) },
    './normalize-order': { mapPaymentMethodDisplay: () => '' },
    './quick-reply-service': {},
    './storage-service': { uploadAttachments: forbid },
    './pg': { query: forbid }, './store-service': {}, './email-service': {}, './backfill-jobs': {},
    './log-service': {}, './config': {}, './shoplazza-client': {}, './webhook-security': {},
  };
  const app = express(); app.use(express.json());
  app.use('/api/admin', loadRouter(dependencies).createAdminRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const port = (server.address() as { port: number }).port;
  async function send(method: string, suffix = '/shipping-address', body?: unknown, authenticated = true) {
    return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method, path: '/api/admin/tickets/' + TICKET.public_ticket_no + suffix,
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: 'fixture=yes' } : {}) } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }));
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { calls, send };
}
const plain = (value: any) => JSON.parse(JSON.stringify(value));

test('address endpoints require the existing agent session before reading tickets or calling services', { timeout: 5000 }, async t => {
  const subject = await harness(t);
  for (const [method, suffix] of [['GET', '/shipping-address'], ['PATCH', '/shipping-address'], ['GET', '/shipping-address/requests/42']]) {
    assert.equal((await subject.send(method, suffix, undefined, false)).status, 401);
  }
  assert.equal(subject.calls.tickets.length + subject.calls.reads.length + subject.calls.submissions.length + subject.calls.lookups.length, 0);
});

test('address read uses the persisted ticket identity and does not cache private address data', { timeout: 5000 }, async t => {
  const subject = await harness(t);
  const response = await subject.send('GET', '/shipping-address?store=attacker&order=attacker');
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.body.address, ADDRESS);
  assert.deepEqual(plain(subject.calls.reads), [{ storeSubdomain: 'real-store', orderId: 'real-order' }]);
});

test('ticket detail includes local shipping address without needing an upstream API request', { timeout: 5000 }, async t => {
  const subject = await harness(t);
  const response = await subject.send('GET', '');
  assert.equal(response.status, 200); assert.deepEqual(response.body.order.shipping_address, ADDRESS);
  assert.equal(subject.calls.reads.length, 0);
});

test('address save enqueues only allowed request inputs with server identity and responds before remote work', { timeout: 5000 }, async t => {
  let release!: () => void;
  const workerGate = new Promise(resolve => { release = () => resolve(null); });
  const subject = await harness(t, { workerGate });
  try {
    const response = await subject.send('PATCH', '/shipping-address', { expectedAddress: ADDRESS, patch: { city: 'New City' }, idempotencyKey: 'offline-key',
      storeSubdomain: 'attacker-store', orderId: 'attacker-order', source: 'maildesk', actor: 'attacker', customerEmail: 'attacker@example.invalid' });
    assert.equal(response.status, 202); assert.equal(response.body.request.id, '42');
    assert.deepEqual(plain(subject.calls.submissions), [{ storeSubdomain: 'real-store', orderId: 'real-order',
      expectedAddress: ADDRESS, patch: { city: 'New City' }, idempotencyKey: 'offline-key', source: 'admin',
      actor: JSON.stringify({ agentId: 7, name: 'Offline Agent', publicTicketNo: 'T-OFFLINE' }) }]);
    assert.deepEqual(subject.calls.wakes, ['42']);
  } finally { release(); }
});

test('address result lookup is bound to both store and order of the ticket', { timeout: 5000 }, async t => {
  for (const request of [{ id: '42', storeSubdomain: 'other-store', orderId: 'real-order' }, { id: '42', storeSubdomain: 'real-store', orderId: 'other-order' }]) {
    const subject = await harness(t, { request });
    const response = await subject.send('GET', '/shipping-address/requests/42');
    assert.equal(response.status, 404); assert.equal(response.body.request, undefined);
  }
  const subject = await harness(t);
  const response = await subject.send('GET', '/shipping-address/requests/42');
  assert.equal(response.status, 200); assert.equal(response.body.request.id, '42');
});

test('missing ticket does not call address services', { timeout: 5000 }, async t => {
  const subject = await harness(t, { missingTicket: true });
  assert.equal((await subject.send('PATCH', '/shipping-address', {})).status, 404);
  assert.equal(subject.calls.submissions.length + subject.calls.wakes.length, 0);
});

test('known permission failures are actionable; unexpected provider/SQL errors are not disclosed', { timeout: 5000 }, async t => {
  const known = await harness(t, { readError: new FixtureAddressError('missing_write_scope', '店铺缺少订单写权限。', 403) });
  const response = await known.send('GET');
  assert.equal(response.status, 403); assert.equal(response.body.code, 'missing_write_scope');
  assert.equal(response.body.error, '店铺缺少订单写权限。');
  const unknown = await harness(t, { submitError: new Error('SQL secret-token private address') });
  const failed = await unknown.send('PATCH', '/shipping-address', {});
  assert.equal(failed.status, 500); assert.doesNotMatch(JSON.stringify(failed.body), /secret-token|SQL|private address/);
  assert.equal(unknown.calls.wakes.length, 0);
});
