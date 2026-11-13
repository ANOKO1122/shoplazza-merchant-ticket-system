import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMailboxAttachment, saveMailboxAttachment } from './mailbox-attachments';

test('mail attachments use a private random path and reject invalid storage keys', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'support-mailbox-'));
  process.env.SUPPORT_MAILBOX_PRIVATE_DIR = dir;
  try {
    const bytes = Buffer.from('%PDF-1.7\nprivate');
    const saved = await saveMailboxAttachment({ filename: 'report.pdf', contentType: 'application/pdf', bytes, count: 1, totalBytes: bytes.length });
    assert.equal(saved.omittedReason, null);
    assert.equal(saved.storageKey?.includes('report'), false);
    assert.deepEqual(await readMailboxAttachment(saved.storageKey!), bytes);
    assert.deepEqual(await readFile(path.join(dir, saved.storageKey!)), bytes);
    await assert.rejects(() => readMailboxAttachment('../secret'), /invalid_storage_key/);
  } finally {
    delete process.env.SUPPORT_MAILBOX_PRIVATE_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
