import { query } from './pg';

const MAILBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS support_mailbox_sync_state (
  mailbox TEXT PRIMARY KEY,
  uid_validity TEXT,
  last_uid BIGINT NOT NULL DEFAULT 0,
  initial_since TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE support_mailbox_sync_state ADD COLUMN IF NOT EXISTS initial_since TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS support_mailbox_conversations (
  id BIGSERIAL PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  unread_count INTEGER NOT NULL DEFAULT 0,
  assignee_id BIGINT REFERENCES support_agents(id),
  claim_id BIGINT REFERENCES support_protection_claims(id),
  protection_order_id BIGINT REFERENCES support_protection_orders(id),
  notification_id BIGINT REFERENCES support_protection_notification_outbox(id),
  link_candidate_notification_id BIGINT REFERENCES support_protection_notification_outbox(id),
  auto_link_attempted BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_mailbox_conversations_latest ON support_mailbox_conversations(last_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_support_mailbox_conversations_owner ON support_mailbox_conversations(assignee_id,status,last_message_at DESC);
ALTER TABLE support_mailbox_conversations ADD COLUMN IF NOT EXISTS auto_link_attempted BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS support_mailbox_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES support_mailbox_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  mailbox TEXT NOT NULL,
  uid_validity TEXT,
  imap_uid BIGINT,
  message_id TEXT,
  in_reply_to TEXT,
  references_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  sender_email TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','queued','sending','sent','failed','unknown')),
  error_code TEXT,
  agent_id BIGINT REFERENCES support_agents(id),
  idempotency_key TEXT,
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_mailbox_message_imap ON support_mailbox_messages(mailbox,uid_validity,imap_uid) WHERE direction='incoming';
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_mailbox_message_external_id ON support_mailbox_messages(mailbox,message_id) WHERE direction='incoming' AND message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_mailbox_message_idempotency ON support_mailbox_messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_mailbox_message_thread ON support_mailbox_messages(message_id,conversation_id);
CREATE INDEX IF NOT EXISTS idx_support_mailbox_message_outbox ON support_mailbox_messages(status,created_at) WHERE direction='outgoing';

CREATE TABLE IF NOT EXISTS support_mailbox_attachments (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES support_mailbox_messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  storage_key TEXT,
  omitted_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_mailbox_notes (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES support_mailbox_conversations(id) ON DELETE CASCADE,
  agent_id BIGINT NOT NULL REFERENCES support_agents(id),
  body_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_mailbox_link_events (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES support_mailbox_conversations(id) ON DELETE CASCADE,
  agent_id BIGINT NOT NULL REFERENCES support_agents(id),
  previous_claim_id BIGINT,
  new_claim_id BIGINT,
  previous_protection_order_id BIGINT,
  new_protection_order_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE support_mailbox_link_events ADD COLUMN IF NOT EXISTS previous_protection_order_id BIGINT;
ALTER TABLE support_mailbox_link_events ADD COLUMN IF NOT EXISTS new_protection_order_id BIGINT;
`;

export async function initMailboxSchema(): Promise<void> {
  await query(MAILBOX_SCHEMA_SQL);
}
