export const PROTECTION_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS support_protection_stores (
 store_subdomain text PRIMARY KEY,
 enabled boolean NOT NULL DEFAULT false,
 product_ids jsonb NOT NULL DEFAULT '[]',
 config_json jsonb,
 health text NOT NULL DEFAULT 'unknown',
 health_message text NOT NULL DEFAULT '尚未检测',
 active_theme_id text,
 checked_at timestamptz,
 fulfillment_enabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_protection_install_jobs (
 id bigserial PRIMARY KEY,
 store_subdomain text NOT NULL,
 action text NOT NULL CHECK (action IN ('check','install','disable')),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
 actor_id bigint NOT NULL,
 actor_name text NOT NULL,
 message text NOT NULL DEFAULT '等待执行',
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS protection_install_active_store
 ON support_protection_install_jobs(store_subdomain) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS protection_install_store_history ON support_protection_install_jobs(store_subdomain,id DESC);
`;
