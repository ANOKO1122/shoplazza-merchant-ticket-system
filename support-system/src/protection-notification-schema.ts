/** No historical backfill: only the transactional claim status hook inserts work. */
export const PROTECTION_NOTIFICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS support_protection_notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  claim_id BIGINT NOT NULL REFERENCES support_protection_claims(id),
  protection_order_id BIGINT NOT NULL REFERENCES support_protection_orders(id),
  revision INTEGER NOT NULL,
  target_status TEXT NOT NULL CHECK(target_status IN ('needs_info','approved','rejected','closed')),
  recipient_email TEXT NOT NULL,
  context_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  subject_snapshot TEXT,
  body_snapshot TEXT,
  access_token_hash TEXT,
  token_expires_at TIMESTAMPTZ,
  message_id TEXT NOT NULL,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE(claim_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_protection_notification_due ON support_protection_notification_outbox(next_attempt_at,id) WHERE status IN ('pending','sending');
`;
