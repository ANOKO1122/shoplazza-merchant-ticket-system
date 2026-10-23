import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express, { RequestHandler } from 'express';
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import { createSupportRouter } from './support-routes';
import {
  LocalStorageProvider, processAttachments,
  uploadAttachments, uploadSingleAttachment, uploadTicketAttachments,
} from './storage-service';

const boundary = 'fixture-upload-boundary';
function multipart(fields: Record<string, string> = {}, files = 1): Buffer {
  const parts = Object.entries(fields).map(([key, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  for (let i = 0; i < files; i++) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\nfixture image bytes\r\n`);
  }
  return Buffer.from(parts.join('') + `--${boundary}--\r\n`);
}

async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!await condition()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for upload cleanup');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function trackTemporaryDirectories(t: TestContext) {
  const directories: string[] = [];
  const mkdtemp = fs.mkdtemp.bind(fs);
  t.mock.method(fs, 'mkdtemp', async (prefix: string) => {
    const directory = await mkdtemp(prefix);
    directories.push(directory);
    return directory;
  });
  t.after(async () => {
    for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directories,
    async assertClean() {
      await waitUntil(async () => (await Promise.all(directories.map(dir =>
        fs.access(dir).then(() => false, () => true)))).every(Boolean));
    },
  };
}

async function listen(t: TestContext, configure: (app: express.Express) => void): Promise<string> {
  const app = express();
  app.use(express.json());
  configure(app);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ ok: false });
  });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function mockTokens(t: TestContext, payload?: Record<string, unknown>) {
  t.mock.method(Pool.prototype, 'connect', () => { throw new Error('Real database access forbidden'); });
  t.mock.method(Pool.prototype, 'query', async (sql: string) => {
    if (sql.includes('SELECT purpose,')) return { rows: payload ? [payload] : [] };
    if (sql.includes('UPDATE support_access_tokens SET used_at')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected database query: ${sql}`);
  });
}

function post(url: string, body: Buffer, authorization?: string) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...(authorization ? { Authorization: authorization } : {}) },
    body,
  });
}

for (const [name, upload] of [
  ['admin reply', uploadAttachments],
  ['customer reply', uploadSingleAttachment],
  ['new ticket', uploadTicketAttachments],
] as const) {
  test(`${name} cleans temporary uploads when the handler rejects the request`, async t => {
    const tracked = trackTemporaryDirectories(t);
    const base = await listen(t, app => app.post('/upload', upload, (_req, res) => res.sendStatus(400)));
    assert.equal((await post(base + '/upload', multipart())).status, 400);
    assert.equal(tracked.directories.length, 1);
    await tracked.assertClean();
  });
}

test('legacy invalid body tokens leave no temporary files', async t => {
  mockTokens(t);
  const tracked = trackTemporaryDirectories(t);
  const base = await listen(t, app => app.use('/api/support', createSupportRouter()));
  const response = await post(base + '/api/support/tickets', multipart({ token: 'invalid', description: 'fixture' }));
  assert.equal(response.status, 401);
  assert.equal(tracked.directories.length, 1);
  await tracked.assertClean();
});

test('a valid bearer and form token allow a customer reply and keep its saved attachment reference', async t => {
  t.mock.method(Pool.prototype, 'connect', () => { throw new Error('Real database access forbidden'); });
  let messagesCreated = 0;
  t.mock.method(Pool.prototype, 'query', async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT purpose,')) return { rows: [{
      purpose: 'ticket_access', public_ticket_no: 'fixture-ticket', customer_email: 'fixture@example.invalid',
    }] };
    if (sql.includes('UPDATE support_access_tokens SET used_at')) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT * FROM support_tickets')) return { rows: [{ status: 'open' }] };
    if (sql.includes('SELECT sender_type')) return { rows: [] };
    if (sql.includes('INSERT INTO support_ticket_messages')) {
      messagesCreated += 1;
      assert.equal(values[0], 'fixture-ticket');
      assert.equal(values[1], 'fixture@example.invalid');
      assert.equal(values[3], 'fixture reply');
      assert.equal(values[4], JSON.stringify(['/uploads/fixture/saved.webp']));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE support_tickets')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected database query: ${sql}`);
  });
  t.mock.method(LocalStorageProvider.prototype, 'save', async (source: string) => {
    assert.equal(await fs.readFile(source, 'utf8'), 'fixture image bytes');
    return '/uploads/fixture/saved.webp';
  });
  const tracked = trackTemporaryDirectories(t);
  const base = await listen(t, app => app.use('/api/support', createSupportRouter()));
  const response = await post(base + '/api/support/tickets/fixture-ticket/messages',
    multipart({ token: 'fixture', content: 'fixture reply' }), 'Bearer fixture');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, remainingMessages: 5 });
  assert.equal(messagesCreated, 1);
  assert.equal(tracked.directories.length, 1);
  await tracked.assertClean();
});

for (const [name, payload] of [
  ['invalid token', undefined],
  ['wrong purpose', { purpose: 'support_bootstrap' }],
  ['another ticket', { purpose: 'ticket_access', public_ticket_no: 'other-ticket' }],
] as const) {
  test(`upload authorization rejects ${name} before creating temporary files`, async t => {
    mockTokens(t, payload);
    const tracked = trackTemporaryDirectories(t);
    const base = await listen(t, app => app.use('/api/support', createSupportRouter()));
    const response = await post(base + '/api/support/tickets/fixture-ticket/messages', multipart({ token: 'invalid', content: 'fixture' }), 'Bearer fixture');
    assert.equal(response.status, 401);
    assert.equal(tracked.directories.length, 0);
  });
}

test('file count errors remove partially received uploads', async t => {
  const tracked = trackTemporaryDirectories(t);
  const base = await listen(t, app => app.post('/upload', uploadSingleAttachment, (_req, res) => res.sendStatus(200)));
  assert.equal((await post(base + '/upload', multipart({}, 2))).status, 400);
  assert.equal(tracked.directories.length, 1);
  await tracked.assertClean();
});

test('successful uploads retain saved attachments while removing original temporary files', async t => {
  const savedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'support-upload-test-'));
  t.after(() => fs.rm(savedDirectory, { recursive: true, force: true }));
  const savedFile = path.join(savedDirectory, 'saved.webp');
  t.mock.method(LocalStorageProvider.prototype, 'save', async (source: string) => {
    await fs.copyFile(source, savedFile);
    return '/uploads/fixture/saved.webp';
  });
  const tracked = trackTemporaryDirectories(t);
  const handler: RequestHandler = async (req, res, next) => {
    try { res.json(await processAttachments(req.files as Express.Multer.File[])); }
    catch (error) { next(error); }
  };
  const base = await listen(t, app => app.post('/upload', uploadAttachments, handler));
  const response = await post(base + '/upload', multipart());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ['/uploads/fixture/saved.webp']);
  await tracked.assertClean();
  assert.equal(await fs.readFile(savedFile, 'utf8'), 'fixture image bytes');
});

test('disconnecting during multipart upload removes the partial request directory', async t => {
  const tracked = trackTemporaryDirectories(t);
  const base = await listen(t, app => app.post('/upload', uploadAttachments, (_req, res) => res.sendStatus(200)));
  const request = http.request(base + '/upload', {
    method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  request.on('error', () => {});
  t.after(() => request.destroy());
  request.write(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\npartial file`);
  await waitUntil(async () => tracked.directories.length === 1);
  request.destroy();
  await tracked.assertClean();
});
