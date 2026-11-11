const randomReference = (prefix: 'SP' | 'CL') =>
  `('${prefix}-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 12) || left(replace(gen_random_uuid()::text, '-', ''), 8)))`;

/** Preserve existing generated values while assigning opaque references to future rows. */
export const PROTECTION_PUBLIC_NO_MIGRATION_SQL = `
DO $protection_public_no$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='support_protection_orders'::regclass AND attname='public_no' AND attgenerated='s') THEN
    ALTER TABLE support_protection_orders ALTER COLUMN public_no DROP EXPRESSION;
  END IF;
  ALTER TABLE support_protection_orders ALTER COLUMN public_no SET DEFAULT ${randomReference('SP')};
  ALTER TABLE support_protection_orders ALTER COLUMN public_no SET NOT NULL;

  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='support_protection_claims'::regclass AND attname='public_no' AND attgenerated='s') THEN
    ALTER TABLE support_protection_claims ALTER COLUMN public_no DROP EXPRESSION;
  END IF;
  ALTER TABLE support_protection_claims ALTER COLUMN public_no SET DEFAULT ${randomReference('CL')};
  ALTER TABLE support_protection_claims ALTER COLUMN public_no SET NOT NULL;
END;
$protection_public_no$;
`;

/** Protection schema and idempotent reference migration. Claim events outlive transient system logs. */
export const PROTECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS support_protection_orders (
  id BIGSERIAL PRIMARY KEY,
  public_no TEXT NOT NULL DEFAULT ${randomReference('SP')} UNIQUE,
  store_subdomain TEXT NOT NULL,
  store_name TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  currency TEXT NOT NULL,
  order_amount_cents BIGINT CHECK (order_amount_cents >= 0),
  protection_fee_cents BIGINT CHECK (protection_fee_cents >= 0),
  protected_value_cents BIGINT CHECK (protected_value_cents >= 0),
  refund_amount_cents BIGINT CHECK (refund_amount_cents >= 0),
  payment_status TEXT NOT NULL,
  order_status TEXT NOT NULL,
  fulfillment_status TEXT NOT NULL,
  refund_status TEXT NOT NULL,
  paid_at TIMESTAMPTZ,
  items_json JSONB NOT NULL DEFAULT '[]',
  logistics_json JSONB NOT NULL DEFAULT '[]',
  shipping_address_json JSONB NOT NULL DEFAULT '{}',
  service_fulfillment_status TEXT NOT NULL DEFAULT 'pending',
  source_snapshot_id BIGINT,
  source_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_subdomain, order_id)
);
CREATE INDEX IF NOT EXISTS idx_protection_orders_paid ON support_protection_orders(paid_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_protection_orders_store ON support_protection_orders(store_subdomain,paid_at DESC,id DESC);
DO $protection_timeline$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='support_protection_orders' AND column_name='timeline_json') THEN
    ALTER TABLE support_protection_orders ADD COLUMN timeline_json JSONB NOT NULL DEFAULT '{}';
    IF to_regclass('public.support_protection_sync_state') IS NOT NULL THEN
      UPDATE support_protection_sync_state SET cursor_updated_at='1970-01-01',cursor_id=0 WHERE id=1;
    END IF;
  END IF;
END;
$protection_timeline$;

CREATE TABLE IF NOT EXISTS support_protection_claims (
  id BIGSERIAL PRIMARY KEY,
  public_no TEXT NOT NULL DEFAULT ${randomReference('CL')} UNIQUE,
  protection_order_id BIGINT NOT NULL REFERENCES support_protection_orders(id),
  reason TEXT NOT NULL CHECK (reason IN ('lost','damaged','stolen','delayed','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','reviewing','needs_info','approved','rejected','closed')),
  requested_amount_cents BIGINT NOT NULL CHECK (requested_amount_cents > 0),
  approved_amount_cents BIGINT CHECK (approved_amount_cents > 0 AND approved_amount_cents <= requested_amount_cents),
  currency TEXT NOT NULL,
  item_ids JSONB NOT NULL CHECK (jsonb_typeof(item_ids) = 'array'),
  allocation_json JSONB NOT NULL DEFAULT '{}',
  assignee_id BIGINT REFERENCES support_agents(id),
  revision INTEGER NOT NULL DEFAULT 1,
  resolution_note TEXT,
  external_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (approved_amount_cents IS NULL OR status IN ('approved','closed'))
);
CREATE INDEX IF NOT EXISTS idx_protection_claims_order ON support_protection_claims(protection_order_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_protection_claims_status ON support_protection_claims(status,created_at DESC,id DESC);
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS selections_json JSONB;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS customer_message TEXT;
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE support_protection_claims ADD COLUMN IF NOT EXISTS policy_snapshot_json JSONB;

CREATE TABLE IF NOT EXISTS support_protection_claim_events (
  id BIGSERIAL PRIMARY KEY,
  claim_id BIGINT NOT NULL REFERENCES support_protection_claims(id),
  actor_id BIGINT NOT NULL REFERENCES support_agents(id),
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  detail_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_protection_claim_events_claim ON support_protection_claim_events(claim_id,id);

CREATE TABLE IF NOT EXISTS support_protection_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_updated_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  cursor_id BIGINT NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ
);
INSERT INTO support_protection_sync_state(id) VALUES (1) ON CONFLICT DO NOTHING;

-- A timestamp cursor alone cannot see transactions that commit out of order.
-- This durable notification shares the source write's transaction and therefore
-- becomes visible exactly when the snapshot does.
CREATE TABLE IF NOT EXISTS support_protection_sync_dirty (
  store_subdomain TEXT NOT NULL,
  order_id TEXT NOT NULL,
  touched_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(store_subdomain,order_id)
);
CREATE INDEX IF NOT EXISTS idx_protection_sync_dirty_touched ON support_protection_sync_dirty(touched_at);
CREATE OR REPLACE FUNCTION public.support_mark_protection_snapshot_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $protection_dirty$
BEGIN
  IF EXISTS(SELECT 1 FROM public.support_protection_stores WHERE store_subdomain=NEW.store_subdomain) THEN
    INSERT INTO public.support_protection_sync_dirty(store_subdomain,order_id,touched_at)
      VALUES(NEW.store_subdomain,NEW.order_id,clock_timestamp())
      ON CONFLICT(store_subdomain,order_id) DO UPDATE SET touched_at=EXCLUDED.touched_at;
  END IF;
  RETURN NEW;
END;
$protection_dirty$;
DO $protection_trigger$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='support_protection_snapshot_dirty' AND tgrelid='public.support_order_snapshots'::regclass) THEN
    CREATE TRIGGER support_protection_snapshot_dirty AFTER INSERT OR UPDATE ON public.support_order_snapshots
      FOR EACH ROW EXECUTE FUNCTION public.support_mark_protection_snapshot_dirty();
  END IF;
END;
$protection_trigger$;
${PROTECTION_PUBLIC_NO_MIGRATION_SQL}
`;
