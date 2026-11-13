import crypto from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { attachmentPolicy } from './mailbox-domain';

function privateDir(): string {
  return process.env.SUPPORT_MAILBOX_PRIVATE_DIR || path.resolve(__dirname, '..', 'private', 'mailbox');
}

export async function saveMailboxAttachment(input: {
  filename: string;
  contentType: string;
  bytes: Buffer;
  count: number;
  totalBytes: number;
}): Promise<{ filename: string; mimeType: string; sizeBytes: number; storageKey: string | null; omittedReason: string | null }> {
  const filename = path.basename(input.filename).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255) || 'attachment';
  const policy = attachmentPolicy({ ...input, filename });
  if (!policy.accepted) return { filename, mimeType: input.contentType, sizeBytes: input.bytes.length, storageKey: null, omittedReason: policy.reason };
  const dir = privateDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const storageKey = `${crypto.randomUUID()}.bin`;
  await fs.writeFile(path.join(dir, storageKey), input.bytes, { flag: 'wx', mode: 0o600 });
  return { filename, mimeType: policy.mimeType, sizeBytes: input.bytes.length, storageKey, omittedReason: null };
}

export async function readMailboxAttachment(storageKey: string): Promise<Buffer> {
  if (!/^[a-f0-9-]{36}\.bin$/.test(storageKey)) throw new Error('invalid_storage_key');
  return fs.readFile(path.join(privateDir(), storageKey));
}

export async function deleteMailboxAttachment(storageKey: string): Promise<void> {
  if (!/^[a-f0-9-]{36}\.bin$/.test(storageKey)) throw new Error('invalid_storage_key');
  await fs.rm(path.join(privateDir(), storageKey), { force: true });
}
