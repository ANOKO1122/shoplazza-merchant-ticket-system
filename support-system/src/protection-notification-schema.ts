/** Claim transitions and new order milestones share one durable delivery outbox. */
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

ALTER TABLE support_protection_notification_outbox ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'claim_update';
ALTER TABLE support_protection_notification_outbox ADD COLUMN IF NOT EXISTS manual_requested_at TIMESTAMPTZ;
UPDATE support_protection_notification_outbox SET status='cancelled',last_error='manual_delivery_enabled',lease_token=NULL,lease_until=NULL,updated_at=now()
  WHERE event_type='claim_update' AND manual_requested_at IS NULL AND status IN ('pending','sending');
ALTER TABLE support_protection_notification_outbox ALTER COLUMN claim_id DROP NOT NULL;
ALTER TABLE support_protection_notification_outbox ALTER COLUMN revision DROP NOT NULL;
ALTER TABLE support_protection_notification_outbox ALTER COLUMN target_status DROP NOT NULL;
DO $notification_event_shape$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='protection_notification_event_shape' AND conrelid='support_protection_notification_outbox'::regclass) THEN
    ALTER TABLE support_protection_notification_outbox ADD CONSTRAINT protection_notification_event_shape CHECK (
      (event_type='claim_update' AND claim_id IS NOT NULL AND revision IS NOT NULL AND target_status IS NOT NULL)
      OR (event_type IN ('shipment','completion') AND claim_id IS NULL AND revision IS NULL AND target_status IS NULL)
    );
  END IF;
END;
$notification_event_shape$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_protection_notification_order_stage
  ON support_protection_notification_outbox(protection_order_id,event_type) WHERE event_type IN ('shipment','completion');

-- Retained across restarts/reindexing: enabling mail never sweeps old milestones.
CREATE TABLE IF NOT EXISTS support_protection_notification_activation (
  id INTEGER PRIMARY KEY CHECK(id=1),
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO support_protection_notification_activation(id) VALUES(1) ON CONFLICT DO NOTHING;
`;
