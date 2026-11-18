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
ALTER TABLE support_protection_stores ADD COLUMN IF NOT EXISTS first_install_day date;
-- Verified historical cart rollouts, before the install worker recorded jobs.
UPDATE support_protection_stores s SET first_install_day=v.day::date
FROM (VALUES
 ('amao04.myshoplaza.com','2026-11-03'), ('hipkastl.myshoplaza.com','2026-11-03'),
 ('sheraer.myshoplaza.com','2026-11-13'), ('drakvex.myshoplaza.com','2026-11-13'),
 ('shutiaoes.myshoplaza.com','2026-11-16'), ('newgg.myshoplaza.com','2026-11-16'),
 ('natie1.myshoplaza.com','2026-11-16')
) AS v(store_subdomain,day)
WHERE s.store_subdomain=v.store_subdomain AND s.first_install_day IS NULL;
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
