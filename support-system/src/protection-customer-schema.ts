import { query } from './pg';
export const PROTECTION_CUSTOMER_SCHEMA_SQL = `
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS selections_json JSONB;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS received_package BOOLEAN;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS issue_code TEXT;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS location_json JSONB;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS customer_message TEXT;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS submission_id UUID;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS submission_hash TEXT;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS camera_exception_reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_protection_customer_submission ON support_protection_claims(protection_order_id,submission_id) WHERE submission_id IS NOT NULL;
ALTER TABLE support_protection_claim_events ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE support_protection_claim_events ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'admin';
CREATE TABLE IF NOT EXISTS support_protection_access_tokens (
  token_hash TEXT PRIMARY KEY,protection_order_id BIGINT NOT NULL REFERENCES support_protection_orders(id),
  customer_email TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS support_protection_customer_sessions (
  session_hash TEXT PRIMARY KEY,token_hash TEXT NOT NULL REFERENCES support_protection_access_tokens(token_hash),
  expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protection_customer_session_expiry ON support_protection_customer_sessions(expires_at);
CREATE TABLE IF NOT EXISTS support_protection_customer_messages (
  id BIGSERIAL PRIMARY KEY,claim_id BIGINT NOT NULL REFERENCES support_protection_claims(id),
  submission_id UUID NOT NULL,submission_hash TEXT NOT NULL,description TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(claim_id,submission_id)
);
CREATE TABLE IF NOT EXISTS support_protection_evidence (
  id UUID PRIMARY KEY,protection_order_id BIGINT NOT NULL REFERENCES support_protection_orders(id),
  session_hash TEXT NOT NULL,claim_id BIGINT REFERENCES support_protection_claims(id),
  message_id BIGINT REFERENCES support_protection_customer_messages(id),
  storage_name TEXT NOT NULL UNIQUE,mime_type TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('image','video')),
  original_name TEXT NOT NULL,size_bytes BIGINT NOT NULL CHECK(size_bytes>0),created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protection_evidence_order ON support_protection_evidence(protection_order_id,created_at);
CREATE INDEX IF NOT EXISTS idx_protection_evidence_claim ON support_protection_evidence(claim_id,message_id);
ALTER TABLE support_protection_evidence ADD COLUMN IF NOT EXISTS upload_id UUID;
ALTER TABLE support_protection_evidence ADD COLUMN IF NOT EXISTS upload_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_protection_evidence_upload ON support_protection_evidence(protection_order_id,session_hash,upload_id) WHERE upload_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS support_protection_capture_sessions (
  id UUID PRIMARY KEY,protection_order_id BIGINT NOT NULL REFERENCES support_protection_orders(id),session_hash TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('damaged_item','outer_packaging','shipping_label','additional')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),expires_at TIMESTAMPTZ NOT NULL,
  upload_id UUID,upload_hash TEXT,received_at TIMESTAMPTZ,
  CHECK ((upload_id IS NULL AND upload_hash IS NULL AND received_at IS NULL) OR (upload_id IS NOT NULL AND upload_hash IS NOT NULL AND received_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_protection_capture_sessions_order ON support_protection_capture_sessions(protection_order_id,session_hash,requested_at);
ALTER TABLE support_protection_evidence ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE support_protection_evidence ADD COLUMN IF NOT EXISTS capture_id UUID REFERENCES support_protection_capture_sessions(id);
ALTER TABLE support_protection_evidence ADD COLUMN IF NOT EXISTS capture_category TEXT;
ALTER TABLE support_protection_evidence ADD COLUMN IF NOT EXISTS capture_requested_at TIMESTAMPTZ;
ALTER TABLE support_protection_evidence ADD COLUMN IF NOT EXISTS capture_received_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_protection_evidence_capture ON support_protection_evidence(capture_id) WHERE capture_id IS NOT NULL;
`;
export async function initProtectionCustomerSchema():Promise<void>{await query(PROTECTION_CUSTOMER_SCHEMA_SQL);}
