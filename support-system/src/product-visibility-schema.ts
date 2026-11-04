/** Retained schema from visibility branch 1c038cb; startup must not reset saved preview rules. */
export const VISIBILITY_SCHEMA = `CREATE TABLE IF NOT EXISTS support_product_visibility (
  store_subdomain TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  keyword TEXT NOT NULL DEFAULT 'women',
  device TEXT NOT NULL DEFAULT 'desktop' CHECK(device IN ('desktop','mobile','both')),
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE support_product_visibility ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
INSERT INTO support_product_visibility (store_subdomain) VALUES ('amao04.myshoplaza.com') ON CONFLICT DO NOTHING;`;
