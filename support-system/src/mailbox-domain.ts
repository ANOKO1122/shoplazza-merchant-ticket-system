export function normalizeMailboxAddress(value: unknown): string | null {
  if (typeof value !== 'string' || /[\r\n<>]/.test(value)) return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function parseMailHeaders(value: string | undefined | null): string[] {
  if (!value) return [];
  return Array.from(value.matchAll(/<[^<>\s]{1,254}@[^<>\s]{1,254}>/g), match => match[0].toLowerCase()).slice(0, 50);
}

export function matchNotificationThread(input: {
  sender: string;
  references: string[];
  notification: { messageId: string; recipient: string; status: string };
}): 'verified' | 'candidate' | 'none' {
  const { sender, references, notification } = input;
  if (notification.status !== 'sent' || !references.some(reference => reference.toLowerCase() === notification.messageId.toLowerCase())) return 'none';
  return normalizeMailboxAddress(sender) === normalizeMailboxAddress(notification.recipient) ? 'verified' : 'candidate';
}

export type AttachmentPolicyResult = { accepted: true; mimeType: string } | { accepted: false; reason: string };

export function attachmentPolicy(input: {
  filename: string;
  contentType: string;
  bytes: Buffer;
  count: number;
  totalBytes: number;
}): AttachmentPolicyResult {
  if (input.count > 6) return { accepted: false, reason: 'too_many_files' };
  if (input.bytes.length > 10 * 1024 * 1024) return { accepted: false, reason: 'file_too_large' };
  if (input.totalBytes > 25 * 1024 * 1024) return { accepted: false, reason: 'message_too_large' };
  const ext = input.filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  const bytes = input.bytes;
  const signature = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
    : bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
    : bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-' ? 'application/pdf' : null;
  const extensions: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };
  if (!ext || !signature || extensions[ext] !== signature || input.contentType.toLowerCase() !== signature) return { accepted: false, reason: 'unsupported_type' };
  return { accepted: true, mimeType: signature };
}
