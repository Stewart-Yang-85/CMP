-- US9 follow-up: UPSTREAM_DISCONNECT tracks reseller-scoped upstream API token probe health.

BEGIN;

ALTER TABLE public.upstream_integrations
  ADD COLUMN IF NOT EXISTS reseller_id uuid REFERENCES public.tenants(tenant_id);

DROP INDEX IF EXISTS public.uq_upstream_supplier_operator_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_upstream_reseller_supplier_operator_active
  ON public.upstream_integrations(reseller_id, supplier_id, operator_id)
  WHERE status IN ('ACTIVE', 'INACTIVE');

CREATE INDEX IF NOT EXISTS idx_upstream_integrations_reseller_status
  ON public.upstream_integrations(reseller_id, status)
  WHERE reseller_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.upstream_integration_health_checks (
  integration_id uuid PRIMARY KEY REFERENCES public.upstream_integrations(integration_id) ON DELETE CASCADE,
  reseller_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(supplier_id),
  operator_id uuid NOT NULL REFERENCES public.operators(operator_id),
  probe_type text NOT NULL DEFAULT 'TOKEN',
  status text NOT NULL DEFAULT 'UNKNOWN',
  consecutive_failure_count integer NOT NULL DEFAULT 0,
  last_probe_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text,
  last_error_message text,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT upstream_integration_health_probe_type_chk CHECK (probe_type IN ('TOKEN')),
  CONSTRAINT upstream_integration_health_status_chk CHECK (status IN ('UNKNOWN', 'CONNECTED', 'DISCONNECTED')),
  CONSTRAINT upstream_integration_health_failure_count_chk CHECK (consecutive_failure_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_upstream_integration_health_reseller_status
  ON public.upstream_integration_health_checks(reseller_id, status, consecutive_failure_count);

UPDATE public.alert_type_catalog
SET
  default_threshold_value = 3,
  default_threshold_unit = 'ATTEMPTS',
  description = 'Upstream supplier API token probe failed repeatedly for a reseller integration.',
  updated_at = current_timestamp
WHERE alert_type = 'UPSTREAM_DISCONNECT';

UPDATE public.alert_config_items item
SET
  threshold_value = 3,
  threshold_unit = 'ATTEMPTS',
  updated_at = current_timestamp,
  version = item.version + 1
FROM public.alert_config_profiles profile
WHERE profile.config_profile_id = item.config_profile_id
  AND profile.scope_type = 'PLATFORM'
  AND profile.status = 'ACTIVE'
  AND item.alert_type = 'UPSTREAM_DISCONNECT';

COMMIT;
