import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import express from 'express';
import ts from 'typescript';
import * as protectionEmailTemplate from './protection-email-template';
import * as emailPreferences from './email-preferences';
import { renderTemplateString } from './email-service';

const TICKET = {
  public_ticket_no: 'T-OFFLINE', store_subdomain: 'fixture-store', store_name: 'Fixture Store',
  order_id: 'fixture-order', order_number: '#1001', customer_email: 'buyer@example.invalid', status: 'waiting',
};
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'admin-routes.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function harness(options: { snapshotName?: string | null; ticketName?: string | null; missingSnapshot?: boolean; missingTicket?: boolean; closed?: boolean; unsubscribed?: boolean; skipAtSend?: boolean; previewJob?: Record<string, unknown> } = {}) {
  const calls = { tickets: [] as string[], snapshots: [] as any[], notices: [] as any[], messages: [] as any[], processed: [] as any[], rendered: [] as any[] };
  const forbid = () => { throw new Error('Offline route attempted a live database, API or mail dependency'); };
  const pass: express.RequestHandler = (_req, _res, next) => next();
  const dependencies: Record<string, unknown> = {
    './protection-email-template': protectionEmailTemplate,
    './email-preferences': emailPreferences,
    './protection-customer-auth': { protectionPublicBaseUrl: () => 'https://us-seel.com' },
    './email-preferences-admin-routes': { createEmailPreferencesAdminRouter: () => express.Router() },
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
      renderTemplateString,
      getEmailTemplate: forbid,
      extractStoreCustomDomain: () => '',
      ensureAgentReplyNoticeJob: async (params: unknown) => { calls.notices.push(params); return options.unsubscribed ? { job: null, created: false, suppressed: true } : { job: { id: 42 }, created: true }; },
      createCustomerComplaintInviteJob: async (params: unknown) => { calls.notices.push(params); return options.unsubscribed ? { job: null, suppressed: true } : { job: { id: 42 } }; },
      processDueEmailJobs: async (params: unknown) => { calls.processed.push(params); },
      getEmailJobDetail: async () => ({ job: options.previewJob || (options.skipAtSend ? { id: 42, status: 'skipped', last_error: 'email_unsubscribed:ticket' } : { id: 42 }) }),
      getEffectivePublicBaseUrl: async () => 'https://tickets.example.invalid',
      buildTemplateItems: async () => [], extractFirstProductImage: () => '', formatEasternTime: () => '',
      renderEmailFromTemplate: async (...params: unknown[]) => { calls.rendered.push(params); return { subject: 'Current template subject', html: '<p>Current template body</p>' }; },
    },
    './config': { buildStoreDomain: () => 'fixture-store.myshoplaza.com' },
    './storage-service': { uploadAttachments: pass, processAttachments: forbid },
    './pg': { query: forbid }, './store-service': {}, './backfill-jobs': {}, './log-service': {},
    './admin-preview': {}, './shoplazza-client': {}, './webhook-security': {}, './normalize-order': { mapPaymentMethodDisplay: () => '' }, './order-address-service': {}, './quick-reply-service': {},
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
  function preview() {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      let status = 200;
      const request = { method: 'GET', url: '/email-jobs/42/preview', headers: { cookie: 'fixture=yes' } };
      const response = { status(code: number) { status = code; return this; }, json(body: unknown) { resolve({ status, body }); return this; } };
      router(request as express.Request, response as express.Response, error => reject(error || new Error('Route did not respond')));
    });
  }
  function previewTemplate(type: string, authenticated = true, subject = 'Hello {{customer_name}}', html = '<html><body><p>Hi {{customer_name}}</p></body></html>') {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      let status = 200;
      const request = { method: 'POST', url: `/email-templates/${type}/preview`, headers: authenticated ? { cookie: 'fixture=yes' } : {}, body: { subject_template: subject, body_template: html, variables: { customer_name: 'Preview buyer' } } };
      const response = { status(code: number) { status = code; return this; }, json(body: unknown) { resolve({ status, body }); return this; } };
      router(request as express.Request, response as express.Response, error => reject(error || new Error('Route did not respond')));
    });
  }
  return { calls, post, preview, previewTemplate };
}

for (const [type, origin] of [['paid_support_invite', 'https://tickets.example.invalid'], ['agent_reply_notice', 'https://tickets.example.invalid'], ['protection_completion_notice', 'https://us-seel.com'], ['protection_claim_update', 'https://us-seel.com']]) {
  test(`${type} template preview includes an inert system footer on the correct host without creating tokens or sending`, async () => {
    const response = await harness().previewTemplate(type);
    assert.equal(response.status, 200);
    assert.equal(response.body.preview.subject, 'Hello Preview buyer');
    const html = response.body.preview.html;
    assert.match(html, /<p>Hi Preview buyer<\/p>/);
    assert.match(html, />Unsubscribe<\/a>/);
    assert.ok(html.includes(`href="${origin}/email-preferences?preview=1"`));
    assert.match(html, /aria-disabled="true"/);
    assert.equal(html.match(/email-unsubscribe:start/g)?.length, 1);
    assert.ok(html.indexOf('email-unsubscribe:end') < html.indexOf('</body>'));
    assert.doesNotMatch(html, /eu_[A-Za-z0-9_-]{43}/);
  });
}
test('template preview accepts in-progress empty subjects and replaces pasted live footer tokens', async () => {
  const html = `<p>Draft</p><!-- email-unsubscribe:start --><a href="https://tickets.example.invalid/email-preferences?token=eu_${'x'.repeat(43)}">Old link</a><!-- email-unsubscribe:end -->`;
  const response = await harness().previewTemplate('paid_support_invite', true, '', html);
  assert.equal(response.status, 200);
  assert.equal(response.body.preview.subject, '');
  assert.equal(response.body.preview.html.match(/email-unsubscribe:start/g)?.length, 1);
  assert.match(response.body.preview.html, />Unsubscribe<\/a>/);
  assert.doesNotMatch(response.body.preview.html, /eu_[A-Za-z0-9_-]{43}/);
});
test('template previews require the existing admin session', async () => {
  assert.equal((await harness().previewTemplate('paid_support_invite', false)).status, 401);
});

test('email preview keeps the persisted content and unsubscribe footer while redacting all capabilities without new tokens', async () => {
  const tokens = ['bt', 'ta', 'pa', 'eu'].map(prefix => `${prefix}_${'x'.repeat(43)}`);
  const html = `<p>Original sent content</p><a href="https://tickets.example.invalid/ticket?t=${tokens[0]}">Open</a><p>${tokens[1]}</p><a href="https://us-seel.com/#access=${tokens[2]}">Access</a><!-- email-unsubscribe:start --><a href="https://tickets.example.invalid/email-preferences?token=${tokens[3]}">Unsubscribe from ticket emails</a><!-- email-unsubscribe:end --><a href="/ticket?mode=help&amp;t=legacy.capability.value">Old link</a>`;
  const subject = harness({ previewJob: { id: 42, subject_snapshot: `Original subject ${tokens[1]}`, body_snapshot: html } });
  const response = await subject.preview();
  assert.equal(response.status, 200);
  assert.equal(response.body.subject, 'Original subject [redacted]');
  assert.match(response.body.html, /Original sent content/);
  assert.match(response.body.html, /email-unsubscribe:start/);
  assert.match(response.body.html, /Unsubscribe from ticket emails/);
  for (const token of [...tokens, 'legacy.capability.value']) assert.equal(JSON.stringify(response.body).includes(token), false);
  assert.equal(subject.calls.rendered.length, 0);
  assert.deepEqual(subject.calls.notices, []);
});
test('old email jobs without a snapshot retain read-only template preview', async () => {
  const subject = harness({ previewJob: { id: 42, email_type: 'paid_support_invite' } });
  const response = await subject.preview();
  assert.equal(response.status, 200);
  assert.equal(response.body.subject, 'Current template subject');
  assert.equal(response.body.html, '<p>Current template body</p>');
  assert.equal(subject.calls.rendered.length, 1);
  assert.deepEqual(subject.calls.notices, []);
});

for (const endpoint of ['notify-email', 'invite-new-ticket']) {
  for (const options of [{ unsubscribed: true }, { skipAtSend: true }]) {
    test(`${endpoint} reports recipient unsubscribe without claiming creation or delivery ${JSON.stringify(options)}`, async () => {
      const subject = harness(options);
      const response = await subject.post(endpoint);
      assert.equal(response.status, 409); assert.equal(response.body.ok, false); assert.equal(response.body.suppressed, true);
      assert.match(response.body.error, /退订/);
      assert.equal(subject.calls.processed.length, 'unsubscribed' in options ? 0 : 1);
    });
  }
}
test('saving an agent reply still succeeds when notification is suppressed', async () => {
  const subject = harness({ unsubscribed: true });
  assert.equal((await subject.post('messages')).status, 200);
  assert.equal(subject.calls.messages.length, 1); assert.equal(subject.calls.processed.length, 0);
});

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
