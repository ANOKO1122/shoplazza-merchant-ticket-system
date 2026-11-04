import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTION_COMPLETION_TEMPLATE, PROTECTION_EMAIL_PREVIEW_VARS } from './protection-email-template';
import { renderTemplateString } from './email-service';
import * as protectionTemplates from './protection-email-template';

test('protection template uses own secure portal without asserting carrier delivery', () => {
  const html = renderTemplateString(PROTECTION_COMPLETION_TEMPLATE.body, PROTECTION_EMAIL_PREVIEW_VARS);
  assert.match(html, /https:\/\/us-seel\.com\/protection/);
  assert.match(html, /View order &amp; request support/);
  assert.doesNotMatch(html, /Your order has been delivered|Powered by Seel|resolve\.seel\.com|\{\{/i);
  assert.doesNotMatch(html, /<script|tracking_pixel|Start a return/i);
});

test('template escapes customer text and hides absent shipment fields', () => {
  const html = renderTemplateString(PROTECTION_COMPLETION_TEMPLATE.body, {
    ...PROTECTION_EMAIL_PREVIEW_VARS, customer_name: '<img src=x onerror=alert(1)>', tracking_number: '', carrier: '',
  });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x|Tracking number:|Carrier:/);
});

test('claim update email links to the private request without exposing a decision or internal details', () => {
  const template = (protectionTemplates as any).PROTECTION_CLAIM_UPDATE_TEMPLATE;
  assert.ok(template, 'The claim update template must be registered');
  const html = renderTemplateString(template.body, { ...PROTECTION_EMAIL_PREVIEW_VARS, claim_no: 'CL-DEMO-1042' });
  assert.match(html, /Your request has been updated/);
  assert.match(html, /CL-DEMO-1042/);
  assert.match(html, /DEMO-1042/);
  assert.match(html, /View update/);
  assert.match(html, /https:\/\/us-seel\.com\/protection/);
  assert.doesNotMatch(html, /approved|rejected|bank|wire transfer|insurance|underwrit|\{\{/i);
});
