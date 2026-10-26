// Offline regression checks: render real page functions with fake DOM/API data.
// No server, database, browser session or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.resolve(__dirname, '../public');
const payload = '<img src=x onerror="globalThis.__xss=1">\'"<&';
const quoteUrl = "https://cdn.example.test/photo');globalThis.__xss=1;//.png";

function element(tag = 'div') {
  return {
    tagName: tag, innerHTML: '', textContent: '', style: {}, children: [], attributes: {}, value: '',
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelectorAll() { return []; },
    addEventListener() {}, remove() { this.removed = true; },
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function page(name, options = {}) {
  const nodes = new Map();
  const get = key => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); };
  const document = {
    body: element('body'),
    querySelector: get, querySelectorAll: () => [], getElementById: id => get('#' + id),
    createElement: element, addEventListener() {},
  };
  const context = vm.createContext({
    document, URL, URLSearchParams, FormData,
    location: { origin: 'https://support.example.test', search: options.search || '', pathname: '/ticket', replace() {} },
    fetch: options.fetch || (() => new Promise(() => {})),
    setTimeout() {}, setInterval() {}, clearInterval() {},
    adminEpoch: () => 0, adminFrame() {}, console, alert() {}, confirm: () => false,
    history: { replaceState() {} },
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(publicDir, 'safe-render.js'), 'utf8'), context);
  const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) vm.runInContext(match[1], context, { filename: name });
  }
  return { context, nodes, get, document, html };
}

function decode(value) {
  return value.replace(/&(?:amp|lt|gt|quot|#39|#x[\da-f]+|#\d+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
    if (named[entity]) return named[entity];
    return String.fromCodePoint(entity.slice(2, -1).toLowerCase().startsWith('x')
      ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10));
  });
}

function tags(html) {
  return [...html.matchAll(/<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map(match => {
    const attrs = {};
    for (const a of match[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4]);
    }
    return { tag: match[1].toLowerCase(), attrs };
  });
}

function assertSafe(html) {
  assert.ok(!/<(?:script|svg|object|embed|iframe)\b/i.test(html), 'business data created active markup');
  for (const { attrs } of tags(html)) {
    for (const [name, value] of Object.entries(attrs)) {
      if (/^on/i.test(name)) {
        assert.ok(!/__xss|globalThis/.test(value), 'business data entered an event handler');
        new vm.Script('(function(event){' + value + '})');
      }
      if (name === 'src' || name === 'href') {
        assert.ok(!/^(?:javascript|data|vbscript):/i.test(value) || value === 'javascript:void(0)', 'unsafe URL scheme');
      }
    }
  }
}

function maliciousData() {
  const order = Object.fromEntries(['customer_name', 'store_name', 'order_number', 'order_currency', 'order_amount', 'payment_method', 'card_last4', 'tracking_no'].map(key => [key, payload]));
  order.store_subdomain = 'store.example.test';
  order.items = [{ title: payload, quantity: payload, image: quoteUrl }];
  order.tracking_numbers = ['HISTORY123', 'FIRST123', payload, 'SECOND123'];
  order.shipments = [
    { id: payload, tracking_numbers: ['HISTORY123', 'FIRST123', payload, 'FIRST123'], current_tracking_numbers: ['FIRST123', payload], tracking_company: payload, updated_at: '2026-10-21T12:00:00Z' },
    { id: 'package-b', tracking_numbers: ['SECOND123'], current_tracking_numbers: ['SECOND123'], tracking_company: 'Carrier B', updated_at: '2026-10-22T12:00:00Z' },
  ];
  const ticket = { ...order, public_ticket_no: payload, order_id: payload, customer_email: payload, issue_type: payload, status: 'open' };
  const messages = [{ id: 7, sender_type: 'customer', content: payload + '\nsecond line', attachments: [quoteUrl, 'javascript:globalThis.__xss=1', 'data:image/svg+xml,<svg onload="globalThis.__xss=1">'] }];
  return { ticket, order, messages, remainingMessages: 5 };
}

function assertPackages(html, currentLabel = 'Current') {
  assertSafe(html);
  const packages = tags(html).filter(t => t.attrs.class === 'shipment-block');
  assert.equal(packages.length, 2, 'both packages must render separately');
  assert.equal(packages[0].attrs['data-shipment-id'], payload);
  assert.equal(packages[1].attrs['data-shipment-id'], 'package-b');
  assert.ok(html.includes('FIRST123'));
  assert.ok(html.includes('SECOND123'));
  assert.equal((html.match(/>FIRST123<span/g) || []).length, 1, 'duplicate current numbers in one package should render once');
  assert.equal((html.match(/>HISTORY123<\/div>/g) || []).length, 1, 'retained number remains visible without being labeled current');
  assert.equal(tags(html).filter(t => t.attrs.class === 'shipment-current').length, 3);
  assert.ok(html.includes('>' + currentLabel + '</span>'));
}

async function main() {
  // Parse every inline script, including pages reached through soft navigation.
  for (const name of fs.readdirSync(publicDir).filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1], { filename: name });
    if (html.includes('/admin-shell.js')) assert.ok(html.includes('/safe-render.js'), name + ' must load shared rendering rules');
  }

  const admin = page('admin.html');
  const safe = admin.context.SupportSafe;
  for (const value of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'blob:https://support.example.test/id', 'httpsx://example.test', '\\evil.test/image', '/\nevil', 'https://user:pass@example.test/a']) {
    assert.equal(safe.url(value), '', value);
  }
  assert.equal(safe.url('/uploads/a.png'), 'https://support.example.test/uploads/a.png');
  assert.equal(safe.url('//cdn.example.test/a.png'), 'https://cdn.example.test/a.png');
  assert.equal(safe.url('https://cdn.example.test/a.png?x=1&y=2'), 'https://cdn.example.test/a.png?x=1&y=2');
  const data = maliciousData();
  admin.context.renderTable([data.ticket], 1);
  admin.context.renderDetail(data);
  assertSafe(admin.get('#ticketTbody').innerHTML);
  assertPackages(admin.get('#detailPanel').innerHTML, '当前');
  assert.ok(admin.get('#detailPanel').innerHTML.includes(safe.escape(payload) + '\nsecond line'));
  const row = tags(admin.get('#ticketTbody').innerHTML).find(t => t.tag === 'tr');
  let selected;
  admin.context.selectTicket = (_element, ticketNo) => { selected = ticketNo; };
  vm.runInContext('(function(){' + row.attrs.onclick + '})', admin.context).call({ getAttribute: name => row.attrs[name] });
  assert.equal(selected, payload, 'selection passes the original ticket number as data');

  const attachment = tags(safe.images(data.messages[0].attachments)).find(t => t.tag === 'img');
  assert.ok(attachment);
  assert.equal(tags(safe.images(data.messages[0].attachments)).filter(t => t.tag === 'img').length, 1);
  vm.runInContext('(function(){' + attachment.attrs.onclick + '})', admin.context).call({ getAttribute: name => attachment.attrs[name] });
  assert.equal(admin.document.body.children.at(-1).children[0].src, safe.url(quoteUrl));
  assert.equal(admin.context.__xss, undefined, 'apostrophe in attachment URL must never become executable code');
  const count = admin.document.body.children.length;
  safe.showImage('javascript:globalThis.__xss=1');
  assert.equal(admin.document.body.children.length, count);

  const customer = page('ticket.html');
  customer.context.renderNewTicket(data.order);
  assertPackages(customer.get('#app').innerHTML);
  assert.ok(customer.get('#app').innerHTML.includes(safe.escape(payload)));
  customer.context.renderTicketDetail(data);
  assertPackages(customer.get('#app').innerHTML);
  const refreshedShipments = element();
  customer.document.querySelectorAll = selector => selector === '.shipment-list' ? [refreshedShipments] : [];
  customer.context.fetch = async () => ({ json: async () => ({ ok: true, ...data }) });
  await customer.context.refreshMessages();
  assertSafe(customer.get('.timeline').innerHTML);
  assert.ok(customer.get('.timeline').innerHTML.includes(safe.escape(payload)));
  assertPackages(refreshedShipments.innerHTML);
  assert.ok(customer.html.includes("headers: { 'Authorization': 'Bearer ' + token }"));
  assert.ok(customer.html.includes("headers: { 'Authorization': 'Bearer ' + accessToken }"));

  const preview = page('admin-ticket-preview.html');
  preview.context.renderNewTicket(data.order);
  assertPackages(preview.get('#app').innerHTML);
  preview.context.renderTicketDetail(data);
  assertPackages(preview.get('#app').innerHTML);
  assertSafe(preview.context.renderAttachments(data.messages[0].attachments));
  assert.ok(safe.shipments({ tracking_no: 'LEGACY123' }).includes('LEGACY123'));
  assert.ok(safe.shipments({ tracking_numbers: ['ONE123', 'TWO123'], tracking_no: 'STALE123' }).includes('TWO123'));
  assert.ok(!safe.shipments({ tracking_numbers: [], tracking_no: 'STALE123' }).includes('STALE123'));
  assert.ok(!safe.shipments({ shipments: [{ id: 'a', tracking_numbers: ['CURRENT123'] }], tracking_no: 'OLD123' }).includes('OLD123'));
  const retainedOnly = safe.shipments({ shipments: [{ id: 'a', tracking_numbers: ['HISTORY123'], current_tracking_numbers: [] }] });
  assert.ok(retainedOnly.includes('HISTORY123'));
  assert.ok(!retainedOnly.includes('shipment-current'));
  assert.ok(!safe.shipments({ shipments: [{ id: 'a', tracking_numbers: ['LEGACY123'] }] }).includes('shipment-current'));
  assertSafe(safe.shipments({ shipments: [{ id: payload, tracking_company: payload, tracking_numbers: [payload] }] }));
  assertSafe(safe.shipments({ shipments: [{ id: 'a', tracking_numbers: [payload], current_tracking_numbers: [payload] }] }, { currentLabel: payload }));

  const logs = page('admin-logs.html');
  const detail = { text: "');globalThis.__xss=1;//", steps: [{ step: payload, detail: payload, status: 'failed' }] };
  const log = { id: 1, detail_json: detail, action: payload, source: payload, store_subdomain: payload, store_name: payload, target_id: payload, category: payload, actor: payload, target: payload, summary: payload, failed_at_step: payload };
  logs.context.renderSyncLogs([log], 1);
  assertSafe(logs.get('#logTbody').innerHTML);
  logs.context.renderOperationLogs([log], 1);
  assertSafe(logs.get('#logTbody').innerHTML);
  const logLink = tags(logs.get('#logTbody').innerHTML).find(t => t.attrs['data-detail']);
  let shown;
  logs.context.showLogBubble = (_element, json, failed) => { shown = { json, failed }; };
  vm.runInContext('(function(event){' + logLink.attrs.onclick + '})', logs.context).call({ getAttribute: name => logLink.attrs[name] }, { stopPropagation() {} });
  assert.equal(shown.json, JSON.stringify(detail));
  assert.equal(shown.failed, payload);
  assert.equal(logs.context.__xss, undefined);

  const shipmentLog = {
    id: 10, action: 'fulfillment_update', source: 'webhook', status: 'success', store_name: payload, target_id: 'ORDER123',
    items_new: 1, items_updated: 2, items_skipped: 2,
    detail_json: {
      topic: 'fulfillments/update', trackingNumbers: ['OLD123', 'NEW123', 'OLDER123', 'SECOND123'], trackingCount: 4, fulfillmentCount: 2, stale: 1, unchanged: 1,
      changes: [
        { fulfillmentId: payload, kind: 'added', beforeTrackingNumbers: [], afterTrackingNumbers: ['SECOND123'], retainedTrackingNumbers: ['SECOND123'], addedTrackingNumbers: ['SECOND123'] },
        { fulfillmentId: 'a', kind: 'updated', beforeTrackingNumbers: ['OLD123', payload], afterTrackingNumbers: ['NEW123'], retainedTrackingNumbers: ['OLD123', payload, 'NEW123'], addedTrackingNumbers: ['NEW123', payload] },
        { fulfillmentId: 'a', kind: 'history_added', beforeTrackingNumbers: ['NEW123'], afterTrackingNumbers: ['OLDER123'], retainedTrackingNumbers: ['OLD123', 'NEW123', 'OLDER123'], addedTrackingNumbers: ['OLDER123'] },
        { fulfillmentId: 'a', kind: 'stale', beforeTrackingNumbers: ['NEW123'], afterTrackingNumbers: ['OLD123'], retainedTrackingNumbers: ['OLD123', 'NEW123', 'OLDER123'], addedTrackingNumbers: [] },
        { fulfillmentId: 'b', kind: 'unchanged', beforeTrackingNumbers: ['SECOND123'], afterTrackingNumbers: ['SECOND123'], retainedTrackingNumbers: ['SECOND123'], addedTrackingNumbers: [] },
      ],
    },
  };
  logs.context.renderSyncLogs([shipmentLog], 1);
  assertSafe(logs.get('#logTbody').innerHTML);
  for (const text of ['新增包裹 1', '更新 2', '补充号码 1', '过期未改当前 1', '重复/无变化跳过 1', '物流明细']) assert.ok(logs.get('#logTbody').innerHTML.includes(text), text);
  const shippingDetail = logs.context.fulfillmentDetailHtml(shipmentLog);
  assertSafe(shippingDetail);
  const visibleShippingDetail = shippingDetail.split('<details')[0];
  for (const text of ['新增包裹', '更新当前号，旧号保留', '补充累计号码，当前号未覆盖', '过期事件，当前号未覆盖', '重复或无变化，已跳过', 'OLD123', 'NEW123', 'SECOND123', 'OLDER123', '累计运单：', '<th>累计号码</th>', '<th>本次新增号码</th>', '晚到消息可补充号码', 'OLD123<br>NEW123<br>OLDER123']) assert.ok(visibleShippingDetail.includes(text), text);
  assert.ok(visibleShippingDetail.includes(safe.escape(payload)), 'retained and added tracking values are escaped');
  logs.context.openFulfillmentDetail(10);
  assertSafe(logs.document.body.children.at(-1).innerHTML);
  assert.ok(logs.document.body.children.at(-1).innerHTML.includes('Webhook'));

  const legacyShipmentLog = { id: 11, action: 'fulfillment_update', source: 'webhook', detail_json: { topic: 'orders/partially_fulfilled', tracking: 'OLD-FIRST,OLD-SECOND', trackingCount: 2 } };
  assert.match(logs.context.syncActCN(legacyShipmentLog.action, legacyShipmentLog), /部分发货/);
  assert.match(logs.context.syncLogSummary(legacyShipmentLog), /OLD-FIRST,OLD-SECOND/);
  assert.match(logs.context.fulfillmentDetailHtml(legacyShipmentLog), /旧日志未保存/);
  const legacyChangedLog = { action: 'fulfillment_update', detail_json: { changes: [{ fulfillmentId: 'a', kind: 'updated', beforeTrackingNumbers: ['OLD'], afterTrackingNumbers: ['NEW'] }], trackingNumbers: ['NEW'] } };
  const legacyChangedDetail = logs.context.fulfillmentDetailHtml(legacyChangedLog).split('<details')[0];
  assert.match(legacyChangedDetail, /更新单号（旧日志）/);
  assert.match(legacyChangedDetail, /未记录/);
  assert.doesNotMatch(legacyChangedDetail, /旧号保留|晚到消息可补充/);

  const reconcile = { id: 12, action: 'fulfillment_reconcile_summary', source: 'backfill', detail_json: {
    checked: 10, changed: 2, failed: 1, remainingDue: 8,
    items: [
      { orderNumber: 'ORDER-CHANGED', status: 'changed', added: 2, updated: 1, trackingNumbers: ['OLD123', 'NEW123', 'SECOND123'] },
      { orderId: 'fallback-order-id', status: 'unchanged', added: 0, updated: 0, trackingNumbers: ['KEPT123'] },
      { orderNumber: payload, status: 'failed', added: payload, updated: payload, trackingNumbers: [payload], error: payload },
      null,
    ],
  } };
  logs.context.renderSyncLogs([reconcile], 1);
  for (const text of ['物流兜底汇总', '兜底同步', '检查 10', '有变化 2', '失败 1']) assert.ok(logs.get('#logTbody').innerHTML.includes(text), text);
  const reconcileDetail = logs.context.fulfillmentDetailHtml(reconcile);
  assertSafe(reconcileDetail);
  const reconcileTable = reconcileDetail.split('<details')[0];
  for (const text of ['待检查订单：8', '<th>订单号</th>', '<th>新增包裹</th>', '<th>更新包裹</th>', '<th>累计运单</th>', '<th>错误</th>', 'ORDER-CHANGED', 'fallback-order-id', 'OLD123<br>NEW123<br>SECOND123', 'KEPT123', '<td>有变化</td><td>2</td><td>1</td>', '<td>无变化</td>', '<td>失败</td><td>0</td><td>0</td>']) assert.ok(reconcileTable.includes(text), text);
  assert.equal(reconcileTable.split(safe.escape(payload)).length - 1, 3, 'order number, tracking and error remain escaped in the visible table');
  logs.context.openFulfillmentDetail(12);
  assertSafe(logs.document.body.children.at(-1).innerHTML);
  assert.ok(logs.document.body.children.at(-1).innerHTML.includes(reconcileTable));
  assert.match(logs.context.fulfillmentDetailHtml({ ...reconcile, detail_json: { remainingDue: 0, items: [] } }), /待检查订单：0.*没有逐条订单/);
  assert.match(logs.context.fulfillmentDetailHtml({ ...reconcile, detail_json: {} }), /未保存逐条订单明细/);
  const filters = logs.context.buildSyncFilters();
  for (const action of ['order_unpaid', 'unpaid_summary', 'fulfillment_update', 'fulfillment_reconcile_summary']) assert.ok(filters.includes('data-value="' + action + '"'));

  // Existing unpaid rows still open their dedicated order detail, including legacy notes.
  const unpaid = { id: 13, action: 'unpaid_summary', items_total: 2, items_skipped: 1, detail_json: { orders: [{ orderNumber: payload, kind: 'updated' }] } };
  logs.context.renderSyncLogs([unpaid], 1);
  assert.ok(logs.get('#logTbody').innerHTML.includes('openUnpaidDetail(13)'));
  logs.context.openUnpaidDetail(13);
  assertSafe(logs.document.body.children.at(-1).innerHTML);
  assert.ok(logs.document.body.children.at(-1).innerHTML.includes(safe.escape(payload)));
  logs.context.showUnpaidModal(unpaid, [], true);
  assert.ok(logs.document.body.children.at(-1).innerHTML.includes('没有逐条留下'));

  const stores = page('admin-stores.html');
  const storeRow = stores.context.buildStoreRowHTML({ id: 1, subdomain: payload, store_name: payload, enabled: true });
  assertSafe(storeRow);
  const edit = tags(storeRow).find(t => t.attrs['data-store-name']);
  let editArgs;
  stores.context.showEditStoreModal = (...args) => { editArgs = args; };
  vm.runInContext('(function(){' + edit.attrs.onclick + '})', stores.context).call({ getAttribute: name => edit.attrs[name] });
  assert.deepEqual(editArgs, [1, payload, payload]);
  const editPage = page('admin-stores.html');
  editPage.context.showEditStoreModal(1, payload, payload);
  assertSafe(editPage.document.body.children.at(-1).innerHTML);
  const inputs = tags(editPage.document.body.children.at(-1).innerHTML).filter(t => t.tag === 'input');
  assert.equal(inputs.find(t => t.attrs.id === 'eName').attrs.value, payload);

  const settings = page('admin-settings.html');
  settings.context.settings = { public_base_url: payload };
  settings.context.me = { name: payload };
  settings.context.renderMain();
  assertSafe(settings.get('#mainArea').innerHTML);

  const emails = page('admin-emails.html');
  const job = { id: 1, email_job_no: payload, store_name: payload, customer_email: payload, order_number: payload, email_type: payload, job_source: payload, status: payload, last_error: payload, client_link_snapshot: payload, retry_count: 0 };
  emails.context.renderEmailJobs([job], 1);
  emails.context.renderEmailDetail(job, [], data.order);
  assertSafe(emails.get('#emailTbody').innerHTML);
  assertSafe(emails.get('#emailDetailPanel').innerHTML);

  const email = page('email-preview.html', {
    search: '?job_id=1',
    fetch: async url => ({ json: async () => url.endsWith('/me') ? { ok: true } : { ok: true, html: '<h1>Receipt</h1><script>parent.__xss=1</script>' } }),
  });
  await new Promise(setImmediate);
  const frame = email.get('#emailBody').children[0];
  assert.ok(frame, 'email preview should still render');
  assert.equal(frame.getAttribute('sandbox'), '', 'email preview must block scripts and same-origin access');
  assert.ok(frame.srcdoc.includes('<h1>Receipt</h1>'));
  assert.ok(fs.readFileSync(path.join(publicDir, 'email-templates.html'), 'utf8').includes('sandbox=""'));

  console.log('Frontend security regression checks passed (offline VM; no live requests).');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
