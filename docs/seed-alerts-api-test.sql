-- Seed data for Swagger UI testing of Alerts APIs.
-- Covers all 7 canonical alert types under 3 enterprise scopes.

BEGIN;

DO $$
DECLARE
  missing_count int;
BEGIN
  SELECT count(*)
  INTO missing_count
  FROM (
    VALUES
      ('938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid, 'RESELLER'),
      ('2f130185-1bc9-4a33-8f1a-7f49312daa0c'::uuid, 'ENTERPRISE'),
      ('89ec0276-7444-48bd-bb9d-1a14353b2f07'::uuid, 'ENTERPRISE'),
      ('0925eb82-53ef-4522-8d81-07ebaa17d819'::uuid, 'RESELLER'),
      ('43326e05-5704-4e0d-8175-547d6b555132'::uuid, 'ENTERPRISE')
  ) AS required_tenants(tenant_id, tenant_type)
  LEFT JOIN public.tenants t
    ON t.tenant_id = required_tenants.tenant_id
   AND t.tenant_type::text = required_tenants.tenant_type
  WHERE t.tenant_id IS NULL;

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Seed aborted: % required reseller/enterprise tenant rows are missing.', missing_count;
  END IF;
END $$;

DELETE FROM public.alerts
WHERE metadata ->> 'seed' = 'alerts-api-test-20260619';

WITH scopes AS (
  SELECT *
  FROM (
    VALUES
      (1, '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid, '2f130185-1bc9-4a33-8f1a-7f49312daa0c'::uuid, 'Reseller A / Enterprise 1'),
      (2, '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid, '89ec0276-7444-48bd-bb9d-1a14353b2f07'::uuid, 'Reseller A / Enterprise 2'),
      (3, '0925eb82-53ef-4522-8d81-07ebaa17d819'::uuid, '43326e05-5704-4e0d-8175-547d6b555132'::uuid, 'Reseller B / Enterprise 1')
  ) AS s(scope_ord, reseller_id, enterprise_id, scope_label)
),
alert_cases AS (
  SELECT *
  FROM (
    VALUES
      (1, 'POOL_USAGE_HIGH', 'P2', 'OPEN', 80, 91, ARRAY['PORTAL','WEBHOOK']::text[], 'Pool usage exceeded configured threshold'),
      (2, 'OUT_OF_PROFILE_SURGE', 'P2', 'OPEN', 500, 860, ARRAY['PORTAL']::text[], 'SIM usage surge detected outside normal profile'),
      (3, 'SILENT_SIM', 'P3', 'ACKED', 4320, 4380, ARRAY['PORTAL']::text[], 'SIM has remained DEACTIVATED beyond threshold'),
      (4, 'UNEXPECTED_ROAMING', 'P1', 'OPEN', 1, 3, ARRAY['PORTAL','EMAIL']::text[], 'Roaming traffic appeared outside covered profile'),
      (5, 'CDR_DELAY', 'P1', 'OPEN', 48, 72, ARRAY['PORTAL','WEBHOOK']::text[], 'CDR import is delayed beyond threshold'),
      (6, 'UPSTREAM_DISCONNECT', 'P1', 'RESOLVED', 1, 4, ARRAY['PORTAL']::text[], 'Upstream connectivity interruption detected'),
      (7, 'WEBHOOK_DELIVERY_FAILED', 'P2', 'SUPPRESSED', 3, 5, ARRAY['PORTAL','WEBHOOK']::text[], 'Outbound webhook delivery exhausted retry attempts')
  ) AS a(type_ord, alert_type, severity, status, threshold_value, current_value, delivery_channels, message)
),
seed_rows AS (
  SELECT
    gen_random_uuid() AS alert_id,
    a.alert_type::alert_type AS alert_type,
    a.severity::alert_severity AS severity,
    a.status::alert_status AS status,
    s.reseller_id,
    s.enterprise_id AS customer_id,
    a.threshold_value::numeric AS threshold,
    (a.current_value + (s.scope_ord - 1) * 2)::numeric AS current_value,
    date_trunc('hour', now()) - ((s.scope_ord * 10 + a.type_ord) || ' hours')::interval AS window_start,
    date_trunc('hour', now()) - ((s.scope_ord * 10 + a.type_ord - 1) || ' hours')::interval AS window_end,
    a.delivery_channels,
    jsonb_build_object(
      'seed', 'alerts-api-test-20260619',
      'scopeLabel', s.scope_label,
      'message', a.message,
      'alertType', a.alert_type,
      'thresholdUnit',
        CASE a.alert_type
          WHEN 'POOL_USAGE_HIGH' THEN 'PERCENT'
          WHEN 'OUT_OF_PROFILE_SURGE' THEN 'MB'
          WHEN 'SILENT_SIM' THEN 'HOURS'
          WHEN 'UNEXPECTED_ROAMING' THEN 'COUNT'
          WHEN 'CDR_DELAY' THEN 'HOURS'
          WHEN 'UPSTREAM_DISCONNECT' THEN 'HOURS'
          WHEN 'WEBHOOK_DELIVERY_FAILED' THEN 'ATTEMPTS'
          ELSE 'COUNT'
        END,
      'swaggerTest', true
    ) AS metadata
  FROM scopes s
  CROSS JOIN alert_cases a
)
INSERT INTO public.alerts (
  alert_id,
  alert_type,
  severity,
  status,
  reseller_id,
  customer_id,
  sim_id,
  threshold,
  current_value,
  window_start,
  window_end,
  first_seen_at,
  last_seen_at,
  acknowledged_at,
  suppressed_until,
  delivery_channels,
  metadata,
  created_at,
  updated_at
)
SELECT
  alert_id,
  alert_type,
  severity,
  status,
  reseller_id,
  customer_id,
  NULL,
  threshold,
  current_value,
  window_start,
  window_end,
  window_start,
  window_end,
  CASE WHEN status = 'ACKED' THEN window_end ELSE NULL END,
  CASE WHEN status = 'SUPPRESSED' THEN now() + interval '30 minutes' ELSE NULL END,
  delivery_channels,
  metadata,
  window_start,
  now()
FROM seed_rows;

COMMIT;

SELECT
  reseller_id AS "resellerId",
  customer_id AS "enterpriseId",
  alert_type AS "alertType",
  severity,
  status,
  threshold,
  current_value AS "currentValue",
  window_start AS "windowStart",
  metadata ->> 'message' AS message
FROM public.alerts
WHERE metadata ->> 'seed' = 'alerts-api-test-20260619'
ORDER BY reseller_id, customer_id, alert_type;
