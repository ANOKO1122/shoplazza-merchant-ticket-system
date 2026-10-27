// Both customer-service applications enqueue the same operation. Only the worker
// may change an order snapshot after Shoplazza has confirmed the saved address.
export const ORDER_ADDRESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS public.support_order_shipping_address_state (
  store_subdomain TEXT NOT NULL,
  order_id TEXT NOT NULL,
  address_json JSONB NOT NULL,
  provider_updated_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_subdomain, order_id),
  CHECK (jsonb_typeof(address_json) = 'object')
);

CREATE TABLE IF NOT EXISTS public.support_shipping_address_requests (
  id BIGSERIAL PRIMARY KEY,
  store_subdomain TEXT NOT NULL,
  order_id TEXT NOT NULL,
  source TEXT NOT NULL,
  actor TEXT NOT NULL,
  submitted_by TEXT NOT NULL DEFAULT session_user,
  idempotency_key TEXT NOT NULL,
  patch_json JSONB NOT NULL,
  expected_address_json JSONB NOT NULL,
  before_address_json JSONB,
  desired_address_json JSONB,
  after_address_json JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'conflict', 'uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,
  write_started_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, idempotency_key),
  CHECK (jsonb_typeof(patch_json) = 'object'),
  CHECK (jsonb_typeof(expected_address_json) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_support_address_requests_pending
  ON public.support_shipping_address_requests (status, updated_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_address_requests_active_order
  ON public.support_shipping_address_requests (store_subdomain, order_id)
  WHERE status IN ('pending', 'processing', 'uncertain');

CREATE OR REPLACE FUNCTION public.support_submit_shipping_address_request(
  p_store TEXT, p_order TEXT, p_patch JSONB, p_expected JSONB,
  p_actor TEXT, p_source TEXT, p_key TEXT
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $address_submit$
DECLARE
  previous public.support_shipping_address_requests%ROWTYPE;
  request_id BIGINT;
  allowed_fields TEXT[] := ARRAY[
    'first_name','last_name','phone','country','country_code',
    'province','province_code','area','city','address','address1',
    'company','zip','phone_area_code'
  ];
BEGIN
  IF p_store IS NULL OR length(p_store) NOT BETWEEN 1 AND 255
     OR p_order IS NULL OR length(p_order) NOT BETWEEN 1 AND 255
     OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 300
     OR p_source IS NULL OR p_source NOT IN ('admin', 'maildesk')
     OR p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid_request_identity' USING ERRCODE = '22023';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb
     OR octet_length(p_patch::text) > 16384
     OR p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object'
     OR octet_length(p_expected::text) > 65536 THEN
    RAISE EXCEPTION 'invalid_address_payload' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(p_patch) AS entry
    WHERE NOT (entry.key = ANY(allowed_fields))
       OR jsonb_typeof(entry.value) <> 'string'
       OR length(entry.value #>> '{}') > 1000
  ) THEN
    RAISE EXCEPTION 'invalid_address_field' USING ERRCODE = '22023';
  END IF;

  -- Serialize identical retry keys before checking the existing request. The
  -- per-order unique index separately arbitrates different submissions.
  PERFORM pg_advisory_xact_lock(hashtext('support.address.submit:' || p_source), hashtext(p_key));
  SELECT * INTO previous FROM public.support_shipping_address_requests
    WHERE source = p_source AND idempotency_key = p_key;
  IF FOUND THEN
    IF previous.store_subdomain <> p_store OR previous.order_id <> p_order
       OR previous.patch_json <> p_patch OR previous.expected_address_json <> p_expected
       OR previous.actor <> p_actor THEN
      RAISE EXCEPTION 'idempotency_key_reused' USING ERRCODE = '22023';
    END IF;
    RETURN previous.id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.support_stores WHERE subdomain = p_store AND enabled = true) THEN
    RAISE EXCEPTION 'store_unavailable' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.support_order_snapshots WHERE store_subdomain = p_store AND order_id = p_order) THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = '22023';
  END IF;
  BEGIN
    INSERT INTO public.support_shipping_address_requests
      (store_subdomain, order_id, source, actor, submitted_by, idempotency_key, patch_json, expected_address_json)
    VALUES (p_store, p_order, p_source, p_actor, session_user, p_key, p_patch, p_expected)
    RETURNING id INTO request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'active_address_request_exists' USING ERRCODE = '55000';
  END;
  RETURN request_id;
END;
$address_submit$;
REVOKE ALL ON FUNCTION public.support_submit_shipping_address_request(TEXT,TEXT,JSONB,JSONB,TEXT,TEXT,TEXT) FROM PUBLIC;

-- The external DB login can submit a request, but cannot forge the source,
-- overwrite snapshots, change a result, or read any Shoplazza access token.
CREATE OR REPLACE FUNCTION public.support_submit_shipping_address_change(
  p_store TEXT, p_order TEXT, p_patch JSONB, p_expected JSONB, p_actor TEXT, p_key TEXT
) RETURNS BIGINT
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $external_address_submit$
  SELECT public.support_submit_shipping_address_request(
    p_store, p_order, p_patch, p_expected, p_actor, 'maildesk', p_key
  );
$external_address_submit$;
REVOKE ALL ON FUNCTION public.support_submit_shipping_address_change(TEXT,TEXT,JSONB,JSONB,TEXT,TEXT) FROM PUBLIC;
`;
