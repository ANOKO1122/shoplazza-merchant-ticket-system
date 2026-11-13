export interface MailboxAgent { id: number; name: string }
export interface MailboxAttachment { id: number; filename: string; mime_type: string | null; size_bytes: number; omitted_reason: string | null; available: boolean }
export interface MailboxMessage {
  id: number; direction: 'incoming' | 'outgoing'; sender_email: string; recipient_email: string;
  subject: string; body_text: string; sent_at: string; status: string; agent_name?: string | null;
  attachments: MailboxAttachment[];
}
export interface MailboxNote { id: number; body_text: string; agent_name: string; created_at: string }
export interface ClaimCandidate { id: number; public_no: string; order_number: string }
export interface NotificationCandidate { id: number; claim_id: number | null; protection_order_id: number;
  recipient_email: string; subject: string; claim_no: string | null; order_number: string | null }
export interface MailboxConversation {
  id: number; version: number; subject: string; customer_email: string; status: 'open' | 'resolved';
  unread_count: number; assignee_id: number | null; assignee_name: string | null;
  claim_id: number | null; claim_no: string | null; protection_order_id: number | null; protection_no: string | null;
  last_message_at: string; messages: MailboxMessage[]; notes: MailboxNote[];
  notification: { id: number; subject: string; body_text: string; sent_at: string; recipient_email: string } | null;
  candidate_notification: NotificationCandidate | null; candidates: ClaimCandidate[];
}
export type ConversationSummary = Pick<MailboxConversation, 'id' | 'subject' | 'customer_email' | 'status' | 'unread_count' | 'assignee_name' | 'claim_no' | 'last_message_at'>;

export class MailboxApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function mailboxApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/admin/mailbox${path}`, { credentials: 'same-origin', ...init });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new MailboxApiError(response.status, result.error || 'request_failed');
  return result as T;
}

export function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
