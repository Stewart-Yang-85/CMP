-- Phase 45 refinement: Default Fallback Package mapping is enterprise-scoped.
-- Roaming tariffs and fallback packages are enterprise-specific, so the active
-- mapping key is enterprise + reseller + supplier + operator.

BEGIN;

ALTER TABLE public.default_fallback_package_mappings
  ADD COLUMN IF NOT EXISTS enterprise_id uuid REFERENCES public.tenants(tenant_id);

UPDATE public.default_fallback_package_mappings dfpm
SET enterprise_id = p.enterprise_id
FROM public.packages p
WHERE dfpm.package_id = p.package_id
  AND dfpm.enterprise_id IS NULL;

ALTER TABLE public.default_fallback_package_mappings
  ALTER COLUMN enterprise_id SET NOT NULL;

DROP INDEX IF EXISTS public.uq_default_fallback_package_mappings_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_fallback_package_mappings_active
  ON public.default_fallback_package_mappings (enterprise_id, reseller_id, supplier_id, operator_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_default_fallback_package_mappings_enterprise_status
  ON public.default_fallback_package_mappings (enterprise_id, status);

COMMENT ON TABLE public.default_fallback_package_mappings IS
  'Maps enterprise + reseller + supplier + operator to the ordinary package used for no-active-subscription usage rating.';

COMMENT ON COLUMN public.default_fallback_package_mappings.enterprise_id IS
  'ENTERPRISE tenants.tenant_id that owns the fallback package and scoped roaming tariff.';

COMMIT;
