import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function editor() {
  const nodes = new Map<string, any>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', srcdoc: '', style: {}, classList: { toggle() {} } });
    return nodes.get(id);
  };
  const pending: Array<{ url: string; options: any; resolve: (value: any) => void }> = [];
  const timers = new Map<number, () => unknown>();
  let timerId = 0;
  const context = vm.createContext({
    document: { getElementById: get, querySelectorAll: () => [], addEventListener() {} },
    adminEpoch: () => 1,
    location: { replace() {} },
    fetch: (url: string, options: any) => new Promise(resolve => { pending.push({ url, options, resolve }); }),
    setTimeout: (callback: () => unknown) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    AbortController,
  });
  context.window = context;
  const html = fs.readFileSync(path.join(__dirname, '../public/email-templates.html'), 'utf8');
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (script[1].trim()) vm.runInContext(script[1], context);
  }
  return {
    context, get, pending,
    flush() { const callbacks = [...timers.values()]; timers.clear(); return Promise.all(callbacks.map(callback => callback())); },
    reply(request: typeof pending[number], subject: string, html: string) { request.resolve({ ok: true, json: async () => ({ ok: true, preview: { subject, html } }) }); },
  };
}

test('editor uses server preview without changing the draft and ignores out-of-order responses', async () => {
  const e = editor();
  e.get('subjectInput').value = 'Draft';
  e.get('bodyInput').value = '<p>Original {{customer_name}}</p>';
  e.context.livePreview();
  const first = e.flush();
  assert.equal(e.pending.filter(request => request.url.endsWith('/preview')).length, 1);
  const old = e.pending.at(-1)!;

  e.get('bodyInput').value = '<p>Latest {{customer_name}}</p>';
  e.context.livePreview();
  e.context.livePreview();
  const second = e.flush();
  const latest = e.pending.at(-1)!;
  assert.equal(e.pending.filter(request => request.url.endsWith('/preview')).length, 2, 'rapid edits are debounced');
  assert.equal(latest.url, '/api/admin/email-templates/paid_support_invite/preview');
  assert.equal(JSON.parse(latest.options.body).body_template, '<p>Latest {{customer_name}}</p>');
  e.reply(latest, 'Latest subject', '<p>Latest preview</p><a aria-disabled="true">Unsubscribe</a>');
  await second;
  assert.match(e.get('previewFrame').srcdoc, /Latest preview.*Unsubscribe/);
  assert.equal(e.get('previewSubject').textContent, 'Latest subject');
  assert.equal(e.get('bodyInput').value, '<p>Latest {{customer_name}}</p>');

  e.reply(old, 'Outdated subject', '<p>Outdated preview</p>');
  await first;
  assert.doesNotMatch(e.get('previewFrame').srcdoc, /Outdated/);
  assert.equal(e.get('previewSubject').textContent, 'Latest subject');
});

test('clearing or switching the draft prevents an old preview response from appearing', async () => {
  for (const action of ['clear', 'switch']) {
    const e = editor();
    e.get('subjectInput').value = 'Old draft';
    e.get('bodyInput').value = '<p>Old body</p>';
    e.context.livePreview();
    const sent = e.flush();
    const request = e.pending.at(-1)!;
    if (action === 'clear') {
      e.get('subjectInput').value = '';
      e.get('bodyInput').value = '';
      e.context.livePreview();
    } else {
      e.context.switchTemplate('protection_claim_update');
    }
    e.reply(request, 'Old subject', '<p>Old preview</p>');
    await sent;
    assert.doesNotMatch(e.get('previewFrame').srcdoc, /Old preview/);
    assert.notEqual(e.get('previewSubject').textContent, 'Old subject');
  }
});
