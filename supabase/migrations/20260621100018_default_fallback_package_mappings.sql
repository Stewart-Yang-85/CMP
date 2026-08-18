-- Phase 45 T371: Default Fallback Package mapping.
-- Maps reseller + supplier + operator to one ordinary published package used
-- when usage has no active subscription.

BEGIN;

CREATE TABLE IF NOT EXISTS public.default_fallback_package_mappings (
  mapping_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(supplier_id),
  operator_id uuid NOT NULL REFERENCES public.operators(operator_id),
  package_id uuid NOT NULL REFERENCES public.packages(package_id),
  status text NOT NULL DEFAULT 'ACTIVE',
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp,
  CONSTRAINT default_fallback_package_mappings_status_chk CHECK (status IN ('ACTIVE', 'INACTIVE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_fallback_package_mappings_active
  ON public.default_fallback_package_mappings (reseller_id, supplier_id, operator_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_default_fallback_package_mappings_package
  ON public.default_fallback_package_mappings (package_id);

CREATE INDEX IF NOT EXISTS idx_default_fallback_package_mappings_reseller_status
  ON public.default_fallback_package_mappings (reseller_id, status);

COMMENT ON TABLE public.default_fallback_package_mappings IS
  'Maps reseller + supplier + operator to the ordinary package used for no-active-subscription usage rating.';
COMMENT ON COLUMN public.default_fallback_package_mappings.package_id IS
  'Ordinary packages.package_id; not a special package type and not a subscription.';

ALTER TABLE public.default_fallback_package_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS default_fallback_package_mappings_no_anon_access
  ON public.default_fallback_package_mappings;
CREATE POLICY default_fallback_package_mappings_no_anon_access
  ON public.default_fallback_package_mappings
  FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS default_fallback_package_mappings_reseller_scope
  ON public.default_fallback_package_mappings;
CREATE POLICY default_fallback_package_mappings_reseller_scope
  ON public.default_fallback_package_mappings
  FOR ALL TO authenticated
  USING (is_tenant_accessible(reseller_id))
  WITH CHECK (is_tenant_accessible(reseller_id));

COMMIT;
