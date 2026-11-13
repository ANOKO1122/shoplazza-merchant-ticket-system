import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { centsFromInput, money, query, safeUrl, latestInstallJob } from './api';
import { Field, ItemList, OrderContext } from './shared';
import { Claims } from './Claims';
import { OrderDetail } from './Orders';
import type { ProtectionOrder } from '../../src/protection-types';
test('a newer remote installation supersedes a completed local job', () => {
  const old = { id: '9', store_subdomain: 'fixture', action: 'check' as const, status: 'succeeded' as const, message: 'done', created_at: '2026-11-03T00:00:00Z', finished_at: '2026-11-03T00:00:01Z' };
  const next = { ...old, id: '10', status: 'running' as const, finished_at: null };
  assert.equal(latestInstallJob(old, next)?.id, '10');
  assert.equal(latestInstallJob(old, { ...old, status: 'running' })?.status, 'succeeded');
});

test('claim amounts use exact integer cents and reject ambiguous or unsafe amounts', () => {
  assert.equal(centsFromInput('10.29'), 1029);
  assert.equal(centsFromInput('0.01'), 1);
  assert.equal(centsFromInput(' 3.1 '), 310);
  for (const value of ['', '-1', '0', '0.00', '1.001', '1e3', '1,000', 'NaN', '9007199254740992']) assert.equal(centsFromInput(value), null, value);
  assert.equal(money(null, 'USD'), '待确认');
  assert.equal(money(0, 'USD'), 'USD 0.00');
  assert.equal(money(1029, 'USD'), 'USD 10.29');
});

test('filters are URL encoded and external content cannot introduce executable links', () => {
  assert.equal(new URLSearchParams(query({ q: 'a&store=other', store: '', page: 2 })).get('q'), 'a&store=other');
  for (const value of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', '//evil.test', '/relative', null, {}]) assert.equal(safeUrl(value), undefined);
  assert.equal(safeUrl('https://tracking.example.test/a?ref=123'), 'https://tracking.example.test/a?ref=123');
});

test('customer and item content is escaped; unknown monetary values remain unknown', () => {
  const html = renderToStaticMarkup(<ItemList currency="USD" items={[{ id: 'item', product_id: 'product', variant_id: 'variant', title: '<script>alert(1)</script>', image_url: 'javascript:alert(1)', quantity: 1, amount_cents: null, is_protection: false }]} />);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('待确认'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('javascript:'));
});

test('order context keeps separate packages and rejects unsafe tracking destinations', () => {
  const order: ProtectionOrder = { id: '1', public_no: 'SP-1', store_subdomain: 'test', store_name: '测试店', order_id: 'o1', order_number: '#1', customer_email: '<img src=x onerror=alert(1)>', customer_name: '测试客户', currency: 'USD', order_amount_cents: null, protection_fee_cents: 99, protected_value_cents: null, refund_amount_cents: 0, payment_status: 'paid', order_status: 'open', fulfillment_status: 'partial', refund_status: 'none', paid_at: null, synced_at: '2026-11-03T00:00:00Z', items: [], logistics: [{ tracking_company: 'Carrier A', tracking_number: 'A1', tracking_url: 'https://tracking.example.test/A1' }, { tracking_company: 'Carrier B', tracking_number: 'B2', tracking_url: 'javascript:alert(1)' }], shipping_address: { address1: '<b>Address</b>' }, claim_count: 0, service_fulfillment_status: 'pending_verification' };
  const html = renderToStaticMarkup(<OrderContext order={order} />);
  assert.ok(html.includes('Carrier A') && html.includes('Carrier B'));
  assert.ok(html.includes('A1') && html.includes('B2'));
  assert.ok(html.includes('https://tracking.example.test/A1'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;b&gt;Address&lt;/b&gt;'));
  assert.ok(!html.includes('<img'));
});


test('field labels explicitly reference only visible label text when textarea content changes', () => {
  const html = renderToStaticMarkup(<><Field label="处理备注"><textarea defaultValue="已输入的审核备注" /></Field><Field label="问题说明"><textarea defaultValue="独立内容" /></Field></>);
  const labels = [...html.matchAll(/<span id="([^"]+)">([^<]+)<\/span>/g)];
  assert.equal(labels.length, 2, 'each field needs a distinct visible label target');
  assert.notEqual(labels[0][1], labels[1][1], 'field label ids must be unique');
  for (const [, id, text] of labels) {
    assert.ok(html.includes(`aria-labelledby="${id}"`), `${text} must explicitly name its control`);
  }
  assert.ok(html.includes('已输入的审核备注'));
});

test('opening a claim keeps the list layout and exposes a named modal dialog', () => {
  const html = renderToStaticMarkup(<Claims stores={[]} agents={[]} selected="claim-1" onSelect={() => {}} />);
  assert.ok(html.includes('class="p-workspace"'), 'the list must keep its single-column layout');
  assert.ok(!html.includes('p-has-detail'), 'opening a detail must not shrink the list');
  assert.match(html, /<dialog[^>]+aria-modal="true"[^>]+aria-label="赔付申诉详情"/);
});

test('order detail uses the same named modal instead of occupying a list column', () => {
  const html = renderToStaticMarkup(<OrderDetail id="order-1" onClose={() => {}} onClaim={() => {}} onChanged={() => {}} />);
  assert.match(html, /<dialog[^>]+aria-modal="true"[^>]+aria-label="保障订单详情"/);
  assert.ok(!html.includes('p-has-detail'));
});
