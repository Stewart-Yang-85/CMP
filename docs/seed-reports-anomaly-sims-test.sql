-- Seed SIM-level alert rows for Swagger UI testing of:
--   GET /v1/reports/anomaly-sims
--
-- This seed intentionally writes alerts.sim_id. The existing generic
-- alerts API seed uses sim_id = NULL and therefore does not appear in
-- the anomaly SIMs report.

BEGIN;

DELETE FROM public.alerts
WHERE metadata ->> 'seed' = 'reports-anomaly-sims-test-20260627';

WITH requested_iccids AS (
  SELECT *
  FROM (
    VALUES
      (1, '893107032536642107'),
      (2, '893107032536642111'),
      (3, '893107032536642110'),
      (4, '893107032536642109'),
      (5, '893107032536642108'),
      (6, '893107032536642334'),
      (7, '8965012309280009884'),
      (8, '8965012309280009520')
  ) AS v(ord, iccid)
),
selected_sims AS (
  SELECT
    r.ord,
    s.sim_id,
    s.iccid,
    s.enterprise_id,
    COALESCE(s.reseller_id, parent_tenant.parent_id) AS reseller_id
  FROM requested_iccids r
  JOIN public.sims s
    ON s.iccid = r.iccid
  LEFT JOIN public.tenants parent_tenant
    ON parent_tenant.tenant_id = s.enterprise_id
),
valid_sims AS (
  SELECT *
  FROM selected_sims
  WHERE sim_id IS NOT NULL
    AND reseller_id IS NOT NULL
),
alert_rows AS (
  SELECT
    gen_random_uuid() AS alert_id,
    CASE (ord - 1) % 4
      WHEN 0 THEN 'SILENT_SIM'
      WHEN 1 THEN 'UNEXPECTED_ROAMING'
      WHEN 2 THEN 'OUT_OF_PROFILE_SURGE'
      ELSE 'POOL_USAGE_HIGH'
    END AS alert_type,
    CASE (ord - 1) % 4
      WHEN 0 THEN 'P3'
      WHEN 1 THEN 'P1'
      ELSE 'P2'
    END AS severity,
    CASE (ord - 1) % 4
      WHEN 0 THEN 'OPEN'
      WHEN 1 THEN 'ACKED'
      WHEN 2 THEN 'OPEN'
      ELSE 'RESOLVED'
    END AS status,
    reseller_id,
    enterprise_id AS customer_id,
    sim_id,
    iccid,
    CASE (ord - 1) % 4
      WHEN 0 THEN 4320
      WHEN 1 THEN NULL
      WHEN 2 THEN 20
      ELSE 80
    END::numeric AS threshold,
    CASE (ord - 1) % 4
      WHEN 0 THEN 4380 + ord
      WHEN 1 THEN 15 + ord
      WHEN 2 THEN 35 + ord
      ELSE 88 + ord
    END::numeric AS current_value,
    ('2026-06-18 08:00:00+00'::timestamptz + (ord || ' hours')::interval) AS window_start,
    ('2026-06-18 09:00:00+00'::timestamptz + (ord || ' hours')::interval) AS window_end,
    ord
  FROM valid_sims
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
  delivery_channels,
  metadata,
  created_at,
  updated_at
)
SELECT
  alert_id,
  alert_type::alert_type,
  severity::alert_severity,
  status::alert_status,
  reseller_id,
  customer_id,
  sim_id,
  threshold,
  current_value,
  window_start,
  window_end,
  window_start,
  window_end,
  CASE WHEN status = 'ACKED' THEN window_end ELSE NULL END,
  ARRAY['PORTAL']::text[],
  jsonb_build_object(
    'seed', 'reports-anomaly-sims-test-20260627',
    'message', 'SIM-level anomaly report seed alert',
    'iccid', iccid,
    'alertType', alert_type,
    'swaggerTest', true
  ),
  window_start,
  now()
FROM alert_rows;

COMMIT;

SELECT
  a.alert_type AS "alertType",
  a.status,
  s.iccid,
  a.sim_id AS "simId",
  a.reseller_id AS "resellerId",
  a.customer_id AS "enterpriseId",
  a.window_start AS "windowStart",
  a.window_end AS "windowEnd"
FROM public.alerts a
JOIN public.sims s
  ON s.sim_id = a.sim_id
WHERE a.metadata ->> 'seed' = 'reports-anomaly-sims-test-20260627'
ORDER BY a.window_start, s.iccid;
