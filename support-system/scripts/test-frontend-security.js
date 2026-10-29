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
    tagName: tag, innerHTML: '', textContent: '', style: {}, children: [], attributes: {}, value: '', isConnected: true,
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    focus() {}, showModal() { this.open = true; }, close() { this.open = false; },
    addEventListener() {}, remove() { this.removed = true; this.isConnected = false; },
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
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, crypto: require('node:crypto').webcrypto,
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
  const order = Object.fromEntries(['customer_name', 'store_name', 'order_number', 'order_currency', 'order_amount', 'payment_method', 'card_last4', 'tracking_no', 'order_status', 'payment_status', 'fulfillment_status', 'refund_status', 'refund_amount'].map(key => [key, payload]));
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
  // Persistent webhook controls must serialize each store through the final status read.
  function webhookFixture() {
    const view = page('admin-stores.html');
    const requests = [];
    const notices = [];
    const buttons = new Map();
    for (const id of [1, 2]) {
      buttons.set(id, Array.from({ length: 3 }, () => ({ disabled: false })));
      view.get('#wh_actions_' + id).querySelectorAll = () => buttons.get(id);
    }
    view.context.confirm = () => true;
    view.context.showToast = (message, type) => notices.push({ message, type });
    view.context.fetch = (url, options = {}) => new Promise((resolve, reject) => {
      requests.push({ url, options, succeed: data => resolve({ json: async () => data }), reject });
    });
    return { ...view, requests, notices, buttons };
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));
  for (const operation of ['checkSingleWebhook', 'registerWebhook', 'unregisterWebhook']) {
    for (const fails of [false, true]) {
      const view = webhookFixture();
      const running = view.context[operation](1);
      const duplicate = view.context.checkSingleWebhook(1);
      const register = view.context.registerWebhook(1);
      const unregister = view.context.unregisterWebhook(1);
      assert.equal(view.requests.length, 1, operation + ' must block overlapping refresh and mutations');
      assert.ok(view.buttons.get(1).every(button => button.disabled), operation + ' disables all row actions');
      assert.ok(view.buttons.get(2).every(button => !button.disabled), 'other stores remain usable');
      if (fails) view.requests[0].reject(new Error('offline failure'));
      else {
        view.requests[0].succeed({ ok: true, registered: true });
        await flush();
        if (operation !== 'checkSingleWebhook') {
          assert.equal(view.requests.length, 2, 'mutation fetches its final status');
          assert.ok(view.buttons.get(1).every(button => button.disabled), 'guard covers final status fetch');
          view.requests[1].succeed({ ok: true, topics: [{ topic: 'orders/paid', registered: true }] });
        }
      }
      await Promise.all([running, duplicate, register, unregister]);
      assert.ok(view.buttons.get(1).every(button => !button.disabled), operation + ' reenables after success or failure');
      assert.ok(!view.get('#wh_status_1').innerHTML.includes('中...'), 'failed operations must not leave loading status');
      const retry = view.context.checkSingleWebhook(1);
      view.requests.at(-1).succeed({ ok: true, registered: false });
      await retry;
      assert.ok(view.buttons.get(1).every(button => !button.disabled), 'released guard allows retry');
    }
  }
  const bulk = webhookFixture();
  bulk.document.querySelectorAll = () => [{ id: 'storeRow_1' }, { id: 'storeRow_2' }];
  const busyRefresh = bulk.context.checkSingleWebhook(1);
  const bulkCheck = bulk.context.checkAllWebhooks();
  assert.equal(bulk.requests.length, 2, 'bulk skips the busy row and checks the available row');
  assert.ok(bulk.requests[1].url.includes('/stores/2/'), 'bulk must not duplicate the busy request');
  assert.ok(bulk.buttons.get(2).every(button => button.disabled), 'bulk disables the current row');
  const overlappingBulkRow = bulk.context.registerWebhook(2);
  assert.equal(bulk.requests.length, 2, 'bulk row cannot mutate while checking');
  bulk.requests[1].succeed({ ok: true, registered: false });
  await Promise.all([bulkCheck, overlappingBulkRow]);
  assert.ok(bulk.notices.some(notice => /跳过.*1/.test(notice.message) && notice.type === 'warning'), 'bulk reports the skipped busy row');
  assert.ok(bulk.buttons.get(1).every(button => button.disabled), 'bulk cannot release another operation guard');
  assert.ok(bulk.buttons.get(2).every(button => !button.disabled));
  assert.equal(bulk.get('#mainArea .btn-outline').disabled, false);
  bulk.requests[0].succeed({ ok: true, registered: true });
  await busyRefresh;

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
  assertSafe(admin.context.renderOrderStatusFields(data.order));
  assert.equal(admin.context.renderOrderStatusFields({}).split('未提供').length - 1, 5, 'missing states and refund amount remain unknown');
  for (const value of [undefined, null, '', '  ']) {
    assert.equal(admin.context.orderRefundAmount({ order_currency: 'USD', refund_amount: value }), '未提供');
  }
  for (const value of [0, '0', '0.00']) {
    assert.equal(admin.context.orderRefundAmount({ order_currency: 'EUR', refund_amount: value }), 'EUR ' + value);
  }
  assert.equal(admin.context.orderRefundAmount({ refund_amount: '12.50' }), '12.50', 'unknown currency must not default to USD');
  const statusView = page('admin.html');
  statusView.context.renderDetail({ ticket: { ...data.ticket, status: 'open' }, messages: [], order: {
    order_status: 'cancelled', payment_status: 'partially_refunded', fulfillment_status: 'partially_shipped',
    refund_status: 'finished', refund_amount: '12.50', order_currency: 'EUR',
  } });
  const statusHtml = statusView.get('#detailPanel').innerHTML;
  assertSafe(statusHtml);
  for (const text of ['工单：待处理', '订单状态', '已取消 (cancelled)', '付款状态', '已部分退款 (partially_refunded)',
    '发货状态', '部分发货 (partially_shipped)', '退款状态', '退款完成 (finished)', '已退款金额', 'EUR 12.50']) {
    assert.ok(statusHtml.includes(text), text);
  }
  assert.ok(!statusHtml.includes('可退金额'));
  assert.equal(statusView.context.orderStateLabel('order_status', 'future_state'), 'future_state');
  assert.equal(statusView.context.orderStateLabel('order_status', 'constructor'), 'constructor');
  assert.equal(statusView.context.orderStateLabel('refund_status', 'partially_refunded'), '已部分退款 (partially_refunded)');
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

  const addressPage = page('admin.html');
  const fixtureAddress = { first_name: 'Fixture', last_name: 'Buyer', address: '12 Example Road', address1: 'Unit 2', city: 'Old City', country_code: 'US', email: 'fixture@example.invalid' };
  assertSafe(addressPage.context.renderShippingAddressCard({ first_name: payload, address: payload, address1: payload, phone: payload }));
  addressPage.context.currentTicket = { public_ticket_no: 'T-OFFLINE', order_number: 'ORDER-OFFLINE', customer_email: 'fixture@example.invalid' };
  addressPage.get('#replyBox').value = 'unsent reply must survive address updates';
  const addressCalls = [];
  let firstSubmission = true;
  addressPage.context.fetch = async (url, options = {}) => {
    addressCalls.push({ url, options });
    if (options.method === 'PATCH') {
      if (firstSubmission) { firstSubmission = false; throw new Error('offline timeout after possible receipt'); }
      return { ok: true, status: 202, json: async () => ({ ok: true, request: { id: '42', status: 'pending' } }) };
    }
    if (url.endsWith('/requests/42')) return { ok: true, status: 200, json: async () => ({ ok: true, request: { id: '42', status: 'succeeded', afterAddress: { ...fixtureAddress, city: 'New City' } } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, address: fixtureAddress, editable: true, hasWriteScope: true }) };
  };
  await addressPage.context.openShippingAddressEditor();
  let addressEditor = addressPage.context.shippingAddressEditor;
  assertSafe(addressEditor.dialog.innerHTML);
  assert.ok(addressEditor.dialog.innerHTML.includes('address_address1'));
  assert.ok(!addressEditor.dialog.innerHTML.includes('address_address2'));
  assert.ok(!/name="email"/.test(addressEditor.dialog.innerHTML));
  addressPage.context.shippingAddressFields.forEach(field => { addressPage.get('#address_' + field[0]).value = String(fixtureAddress[field[0]] || ''); });
  addressPage.get('#address_city').value = 'New City';
  await addressPage.context.saveShippingAddress({ preventDefault() {} });
  assert.ok(addressEditor.dialog.innerHTML.includes('重试同一请求'));
  const firstBody = JSON.parse(addressCalls.find(call => call.options.method === 'PATCH').options.body);
  assert.deepEqual(firstBody.patch, { city: 'New City' });
  assert.deepEqual(firstBody.expectedAddress, fixtureAddress);
  assert.ok(firstBody.idempotencyKey);
  addressPage.context.closeShippingAddressEditor();
  await addressPage.context.openShippingAddressEditor();
  addressEditor = addressPage.context.shippingAddressEditor;
  await addressPage.context.retryShippingAddressSubmission();
  await new Promise(resolve => setImmediate(resolve));
  const submittedBodies = addressCalls.filter(call => call.options.method === 'PATCH').map(call => JSON.parse(call.options.body));
  assert.equal(submittedBodies.length, 2);
  assert.deepEqual(submittedBodies[1], submittedBodies[0], 'network retry and reopen retain the exact request key/body');
  assert.equal(addressPage.get('#replyBox').value, 'unsent reply must survive address updates');
  assert.ok(addressPage.get('#shippingAddressSummary').innerHTML.includes('New City'));
  assert.equal(addressPage.context.shippingAddressSubmissions['T-OFFLINE'], undefined);
  assert.ok(addressCalls.every(call => call.url.includes('/shipping-address')), 'address changes must not call ticket messages or email APIs');
  addressEditor.submission = null;
  addressEditor.view = { address: fixtureAddress, editable: false, hasWriteScope: false, disabledReason: '缺少订单写权限 ' + payload };
  addressPage.context.renderShippingAddressEditor(addressEditor);
  assertSafe(addressEditor.dialog.innerHTML);
  assert.ok(addressEditor.dialog.innerHTML.includes('<fieldset class="address-fields" disabled>'));
  assert.ok(!addressEditor.dialog.innerHTML.includes('保存并同步到店匠'));
  addressEditor.submission = { body: firstBody, requestId: '43', request: { id: '43', status: 'uncertain', errorMessage: payload } };
  addressPage.context.renderShippingAddressEditor(addressEditor);
  assertSafe(addressEditor.dialog.innerHTML);
  assert.ok(addressEditor.dialog.innerHTML.includes('刷新结果'));
  assert.ok(!addressEditor.dialog.innerHTML.includes('重新读取并编辑'));
  addressEditor.submission.request.status = 'conflict';
  addressPage.context.renderShippingAddressEditor(addressEditor);
  assert.ok(addressEditor.dialog.innerHTML.includes('重新读取并编辑'));

  const restoredPage = page('admin.html');
  restoredPage.context.currentTicket = { public_ticket_no: 'T-RESTORED', order_number: 'ORDER-RESTORED' };
  const activeRequest = { id: '55', status: 'uncertain', expectedAddress: fixtureAddress, patch: { city: 'Pending City' }, errorMessage: '正在核对上次修改结果' };
  restoredPage.context.fetch = async url => ({ ok: true, status: 200, json: async () => url.includes('/requests/')
    ? { ok: true, request: activeRequest }
    : { ok: true, address: fixtureAddress, editable: false, hasWriteScope: true, activeRequest } });
  await restoredPage.context.openShippingAddressEditor();
  await new Promise(resolve => setImmediate(resolve));
  const restoredEditor = restoredPage.context.shippingAddressEditor;
  assert.equal(restoredEditor.submission.requestId, '55', 'fresh page recovers the active request from the server');
  assert.ok(restoredEditor.dialog.innerHTML.includes('店匠处理结果待确认'));
  assert.ok(!restoredEditor.dialog.innerHTML.includes('保存并同步到店匠'));
  assert.equal(restoredPage.context.shippingAddressSubmissions['T-RESTORED'].requestId, '55');
  assert.ok(restoredPage.html.includes('editor.pollCount < 60'));
  assert.ok(restoredPage.html.includes('}, 3000)'));

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
  for (const text of ['新增包裹 1', '更新 2', '仅补历史的包裹 1', '过期未改当前 1', '重复/无变化跳过 1', '物流明细']) assert.ok(logs.get('#logTbody').innerHTML.includes(text), text);
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

  const reconcile = { id: 12, action: 'fulfillment_reconcile_summary', source: 'backfill', duration_ms: 1250, detail_json: {
    checked: 10, changed: 2, failed: 1, remainingDue: 8, batchDurationMs: 61200,
    items: [
      { orderNumber: 'ORDER-CHANGED', status: 'changed', added: 2, updated: 1, trackingNumbers: ['OLD123', 'NEW123', 'SECOND123'] },
      { orderId: 'fallback-order-id', status: 'unchanged', added: 0, updated: 0, trackingNumbers: ['KEPT123'] },
      { orderNumber: payload, status: 'failed', added: payload, updated: payload, trackingNumbers: [payload], error: payload },
      null,
    ],
  } };
  logs.context.renderSyncLogs([reconcile], 1);
  for (const text of ['物流兜底汇总', '兜底同步', '检查 10', '有变化 2', '失败 1']) assert.ok(logs.get('#logTbody').innerHTML.includes(text), text);
  assert.ok(logs.get('#logTbody').innerHTML.includes('1250ms'), 'table duration keeps its existing format');
  const reconcileDetail = logs.context.fulfillmentDetailHtml(reconcile);
  assertSafe(reconcileDetail);
  const reconcileTable = reconcileDetail.split('<details')[0];
  for (const text of ['新增/更新按订单计数；更新也包括同号信息变化，具体号码见逐单明细', '本店耗时：1.3 秒', '整批耗时：61.2 秒']) assert.ok(reconcileTable.includes(text), text);
  assert.ok(!reconcileTable.includes('旧版耗时为整批'));
  for (const text of ['待检查订单：8', '<th>订单号</th>', '<th>新增包裹</th>', '<th>更新包裹</th>', '<th>累计运单</th>', '<th>错误</th>', 'ORDER-CHANGED', 'fallback-order-id', 'OLD123<br>NEW123<br>SECOND123', 'KEPT123', '<td>有变化</td><td>2</td><td>1</td>', '<td>无变化</td>', '<td>失败</td><td>0</td><td>0</td>']) assert.ok(reconcileTable.includes(text), text);
  assert.equal(reconcileTable.split(safe.escape(payload)).length - 1, 3, 'order number, tracking and error remain escaped in the visible table');
  logs.context.openFulfillmentDetail(12);
  assertSafe(logs.document.body.children.at(-1).innerHTML);
  assert.ok(logs.document.body.children.at(-1).innerHTML.includes(reconcileTable));
  assert.match(logs.context.fulfillmentDetailHtml({ ...reconcile, detail_json: { remainingDue: 0, items: [] } }), /待检查订单：0.*没有逐条订单/);
  assert.match(logs.context.fulfillmentDetailHtml({ ...reconcile, detail_json: {} }), /未保存逐条订单明细/);
  const oldDurationDetail = logs.context.fulfillmentDetailHtml({ ...reconcile, duration_ms: 61200, detail_json: {} }).split('<details')[0];
  assert.ok(oldDurationDetail.includes('旧版耗时为整批：61.2 秒'));
  assert.ok(!oldDurationDetail.includes('本店耗时'));
  const invalidDurationDetail = logs.context.fulfillmentDetailHtml({ ...reconcile, duration_ms: payload, detail_json: { batchDurationMs: payload } });
  assertSafe(invalidDurationDetail);
  assert.ok(invalidDurationDetail.includes('本店耗时：未记录 · 整批耗时：未记录'));
  assert.equal(logs.context.fulfillmentDuration(0), '0 毫秒');
  assert.equal(logs.context.fulfillmentDuration(null), '未记录');
  const filters = logs.context.buildSyncFilters();
  for (const action of ['order_unpaid', 'unpaid_summary', 'fulfillment_update', 'fulfillment_reconcile_summary', 'order_status_update']) assert.ok(filters.includes('data-value="' + action + '"'));

  const orderStatusLog = { id: 14, action: 'order_status_update', source: 'webhook', status: 'success', detail_json: {
    topic: 'orders/partially_refunded', reason: 'applied', matchedRows: 2, changedRows: 2,
    before: { orderStatus: 'placed', paymentStatus: 'paid', fulfillmentStatus: 'waiting', refundStatus: null, refundAmount: null },
    after: { orderStatus: 'cancelled', paymentStatus: 'partially_refunded', fulfillmentStatus: 'partially_shipped', refundStatus: 'finished', refundAmount: '12.50' },
  } };
  logs.context.renderSyncLogs([orderStatusLog], 1);
  const statusLogHtml = logs.get('#logTbody').innerHTML;
  assertSafe(statusLogHtml);
  for (const text of ['订单状态更新', '进行中 (placed) → 已取消 (cancelled)', '已付款 (paid) → 已部分退款 (partially_refunded)',
    '待发货 (waiting) → 部分发货 (partially_shipped)', '未提供 → 退款完成 (finished)', '退款金额：未提供 → 12.50', '匹配快照 2', '更新快照 2']) {
    assert.ok(statusLogHtml.includes(text), text);
  }
  const zeroRefundLog = { ...orderStatusLog, detail_json: { before: { refundAmount: null }, after: { refundAmount: 0 }, matchedRows: 1, changedRows: 1 } };
  assert.ok(logs.context.syncLogSummary(zeroRefundLog).includes('退款金额：未提供 → 0'));
  assert.ok(logs.context.syncLogSummary({ ...zeroRefundLog, detail_json: { before: { refundAmount: '0' }, after: { refundAmount: 0 } } }).includes('状态无变化'));
  assert.ok(logs.context.syncLogSummary({ ...orderStatusLog, detail_json: {} }).includes('未记录状态明细'));
  assert.equal(logs.context.orderStatusLogValue('refundStatus', 'refunded'), '已全额退款 (refunded)');
  for (const [reason, label] of [['updated', '已更新'], ['unchanged', '无变化'], ['not_found', '库内无此订单已跳过'],
    ['stale', '忽略旧版本'], ['missing_updated_at', '缺更新时间'], ['retry', '处理失败已排队重试']]) {
    assert.ok(logs.context.syncLogSummary({ ...orderStatusLog, detail_json: { reason } }).includes('原因：' + label));
  }
  assert.ok(logs.context.syncLogSummary({ ...orderStatusLog, detail_json: { reason: 'future_reason' } }).includes('原因：future_reason'));
  const failedStatusLog = { ...orderStatusLog, status: 'failed', error_message: 'Shoplazza order lookup HTTP 403; queued for retry', detail_json: { reason: 'retry' } };
  assert.ok(logs.context.syncLogSummary(failedStatusLog).includes('错误：Shoplazza order lookup HTTP 403; queued for retry'));
  logs.context.renderSyncLogs([{ ...failedStatusLog, error_message: payload }], 1);
  assertSafe(logs.get('#logTbody').innerHTML);
  assert.ok(logs.get('#logTbody').innerHTML.includes('错误：' + safe.escape(payload)));
  const hostileStatus = { ...orderStatusLog, detail_json: { topic: payload, reason: payload, before: {},
    after: { orderStatus: payload, paymentStatus: payload, fulfillmentStatus: payload, refundStatus: payload, refundAmount: payload },
    matchedRows: payload, changedRows: payload } };
  logs.context.renderSyncLogs([hostileStatus], 1);
  assertSafe(logs.get('#logTbody').innerHTML);
  assert.ok(logs.get('#logTbody').innerHTML.includes(safe.escape(payload)));

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
