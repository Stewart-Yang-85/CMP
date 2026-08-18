-- Control Policy legacy JSON — inventory & optional migration (Phase 29 T209)
-- Old keys (root): cutoffPolicyId, throttlingPolicyId, cutoffThresholdMb
-- Target shape: clarifications/control-policy-module.md (T205)
--
-- BEFORE RUNNING UPDATES:
--   1) pg_dump / snapshot backup
--   2) Run §1 SELECTs on staging; review counts
--   3) Prefer a transaction: BEGIN; ... COMMIT; or ROLLBACK;
--
-- Default for cutoffThresholdMb -> cutoff.timeWindow is MONTHLY (see runbook-phase29-control-policy-legacy.md).

-- =============================================================================
-- §1 INVENTORY (read-only)
-- =============================================================================

-- control_policy_modules
SELECT
  control_policy_id,
  status,
  control_policy
FROM public.control_policy_modules
WHERE
  control_policy ? 'cutoffPolicyId'
  OR control_policy ? 'throttlingPolicyId'
  OR control_policy ? 'cutoffThresholdMb';

-- packages (embedded snapshot)
SELECT
  package_id,
  status,
  control_policy
FROM public.packages
WHERE
  control_policy ? 'cutoffPolicyId'
  OR control_policy ? 'throttlingPolicyId'
  OR control_policy ? 'cutoffThresholdMb';

-- price_plans: meta.controlPolicy inside payg_rates jsonb
SELECT
  price_plan_id,
  version,
  status,
  payg_rates -> 'meta' -> 'controlPolicy' AS control_policy_meta
FROM public.price_plans
WHERE
  (payg_rates #> '{meta,controlPolicy}') IS NOT NULL
  AND (
    (payg_rates #> '{meta,controlPolicy}') ? 'cutoffPolicyId'
    OR (payg_rates #> '{meta,controlPolicy}') ? 'throttlingPolicyId'
    OR (payg_rates #> '{meta,controlPolicy}') ? 'cutoffThresholdMb'
  );

-- =============================================================================
-- §2 OPTIONAL MIGRATION — control_policy_modules.control_policy
-- Uncomment and run after inventory review. Idempotent-ish: safe to re-run if
-- legacy keys already removed.
-- =============================================================================

/*
BEGIN;

UPDATE public.control_policy_modules AS c
SET
  control_policy = (
    (
      c.control_policy - 'cutoffPolicyId' - 'throttlingPolicyId'
    ) || CASE
      WHEN c.control_policy ? 'cutoffThresholdMb'
        AND NOT (c.control_policy ? 'cutoff')
      THEN jsonb_build_object(
        'cutoff',
        jsonb_build_object(
          'timeWindow',
          'MONTHLY',
          'thresholdMb',
          (c.control_policy ->> 'cutoffThresholdMb')::integer,
          'action',
          'DEACTIVATED'
        )
      )
      ELSE '{}'::jsonb
    END
  ) - 'cutoffThresholdMb'
WHERE
  c.control_policy ? 'cutoffPolicyId'
  OR c.control_policy ? 'throttlingPolicyId'
  OR c.control_policy ? 'cutoffThresholdMb';

COMMIT;
*/

-- =============================================================================
-- §3 OPTIONAL MIGRATION — packages.control_policy
-- Same logic as §2; uncomment BEGIN/COMMIT block and UPDATE when ready.
-- =============================================================================

/*
BEGIN;

UPDATE public.packages AS p
SET
  control_policy = (
    (
      p.control_policy - 'cutoffPolicyId' - 'throttlingPolicyId'
    ) || CASE
      WHEN p.control_policy ? 'cutoffThresholdMb'
        AND NOT (p.control_policy ? 'cutoff')
      THEN jsonb_build_object(
        'cutoff',
        jsonb_build_object(
          'timeWindow',
          'MONTHLY',
          'thresholdMb',
          (p.control_policy ->> 'cutoffThresholdMb')::integer,
          'action',
          'DEACTIVATED'
        )
      )
      ELSE '{}'::jsonb
    END
  ) - 'cutoffThresholdMb'
WHERE
  p.control_policy ? 'cutoffPolicyId'
  OR p.control_policy ? 'throttlingPolicyId'
  OR p.control_policy ? 'cutoffThresholdMb';

COMMIT;
*/

-- =============================================================================
-- §4 OPTIONAL — price_plans.payg_rates.meta.controlPolicy
-- Nested updates are error-prone; prefer re-saving DRAFT price plans via API
-- when possible. Example pattern (single row / tested on staging only):
-- =============================================================================

/*
-- Manual per-row fix recommended. If you must patch in SQL, build new meta object
-- in a CTE and jsonb_set payg_rates once validated.
*/
