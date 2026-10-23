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
        assert.ok(!value.includes('__xss'), 'business data entered an event handler');
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
  const ticket = { ...order, public_ticket_no: payload, order_id: payload, customer_email: payload, issue_type: payload, status: 'open' };
  const messages = [{ id: 7, sender_type: 'customer', content: payload + '\nsecond line', attachments: [quoteUrl, 'javascript:globalThis.__xss=1', 'data:image/svg+xml,<svg onload="globalThis.__xss=1">'] }];
  return { ticket, order, messages, remainingMessages: 5 };
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
  assertSafe(admin.get('#detailPanel').innerHTML);
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
  assertSafe(customer.get('#app').innerHTML);
  assert.ok(customer.get('#app').innerHTML.includes(safe.escape(payload)));
  customer.context.renderTicketDetail(data);
  assertSafe(customer.get('#app').innerHTML);
  customer.context.fetch = async () => ({ json: async () => ({ ok: true, ...data }) });
  await customer.context.refreshMessages();
  assertSafe(customer.get('.timeline').innerHTML);
  assert.ok(customer.get('.timeline').innerHTML.includes(safe.escape(payload)));
  assert.ok(customer.html.includes("headers: { 'Authorization': 'Bearer ' + token }"));
  assert.ok(customer.html.includes("headers: { 'Authorization': 'Bearer ' + accessToken }"));

  const preview = page('admin-ticket-preview.html');
  preview.context.renderNewTicket(data.order);
  assertSafe(preview.get('#app').innerHTML);
  preview.context.renderTicketDetail(data);
  assertSafe(preview.get('#app').innerHTML);
  assertSafe(preview.context.renderAttachments(data.messages[0].attachments));

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
