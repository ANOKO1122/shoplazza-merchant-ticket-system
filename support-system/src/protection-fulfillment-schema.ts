export const PROTECTION_FULFILLMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS support_protection_fulfillment_control (
 id integer PRIMARY KEY CHECK(id=1), activated_at timestamptz
);
INSERT INTO support_protection_fulfillment_control(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS support_protection_fulfillment_store_activation (
 store_subdomain text PRIMARY KEY, activated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_protection_fulfillment_jobs (
 id bigserial PRIMARY KEY, protection_order_id bigint UNIQUE NOT NULL REFERENCES support_protection_orders(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','retry','done','blocked','skipped')),
 attempts integer NOT NULL DEFAULT 0, create_attempted boolean NOT NULL DEFAULT false,
 message text NOT NULL DEFAULT '', next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS protection_fulfillment_due ON support_protection_fulfillment_jobs(next_attempt_at) WHERE status IN('pending','retry');
`;
