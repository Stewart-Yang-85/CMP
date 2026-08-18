-- Package module tables: FK enterprise_id / reseller_id → tenants(tenant_id) (FR-061 / spec).
-- Replaces references to customers(id) and resellers(id).

BEGIN;

-- ---------------------------------------------------------------------------
-- commercial_terms_modules
-- ---------------------------------------------------------------------------
ALTER TABLE public.commercial_terms_modules
  DROP CONSTRAINT IF EXISTS commercial_terms_modules_enterprise_id_fkey,
  DROP CONSTRAINT IF EXISTS commercial_terms_modules_reseller_id_fkey;

UPDATE public.commercial_terms_modules m
SET enterprise_id = c.tenant_id
FROM public.customers c
WHERE m.enterprise_id IS NOT NULL
  AND m.enterprise_id = c.id;

UPDATE public.commercial_terms_modules m
SET reseller_id = r.tenant_id
FROM public.resellers r
WHERE m.reseller_id IS NOT NULL
  AND m.reseller_id = r.id;

UPDATE public.commercial_terms_modules
SET enterprise_id = NULL
WHERE enterprise_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = commercial_terms_modules.enterprise_id
      AND t.tenant_type = 'ENTERPRISE'
  );

UPDATE public.commercial_terms_modules
SET reseller_id = NULL
WHERE reseller_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = commercial_terms_modules.reseller_id
      AND t.tenant_type = 'RESELLER'
  );

ALTER TABLE public.commercial_terms_modules
  ADD CONSTRAINT commercial_terms_modules_enterprise_id_fkey
    FOREIGN KEY (enterprise_id) REFERENCES public.tenants (tenant_id) ON DELETE SET NULL,
  ADD CONSTRAINT commercial_terms_modules_reseller_id_fkey
    FOREIGN KEY (reseller_id) REFERENCES public.tenants (tenant_id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- control_policy_modules
-- ---------------------------------------------------------------------------
ALTER TABLE public.control_policy_modules
  DROP CONSTRAINT IF EXISTS control_policy_modules_enterprise_id_fkey,
  DROP CONSTRAINT IF EXISTS control_policy_modules_reseller_id_fkey;

UPDATE public.control_policy_modules m
SET enterprise_id = c.tenant_id
FROM public.customers c
WHERE m.enterprise_id IS NOT NULL
  AND m.enterprise_id = c.id;

UPDATE public.control_policy_modules m
SET reseller_id = r.tenant_id
FROM public.resellers r
WHERE m.reseller_id IS NOT NULL
  AND m.reseller_id = r.id;

UPDATE public.control_policy_modules
SET enterprise_id = NULL
WHERE enterprise_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = control_policy_modules.enterprise_id
      AND t.tenant_type = 'ENTERPRISE'
  );

UPDATE public.control_policy_modules
SET reseller_id = NULL
WHERE reseller_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = control_policy_modules.reseller_id
      AND t.tenant_type = 'RESELLER'
  );

ALTER TABLE public.control_policy_modules
  ADD CONSTRAINT control_policy_modules_enterprise_id_fkey
    FOREIGN KEY (enterprise_id) REFERENCES public.tenants (tenant_id) ON DELETE SET NULL,
  ADD CONSTRAINT control_policy_modules_reseller_id_fkey
    FOREIGN KEY (reseller_id) REFERENCES public.tenants (tenant_id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- carrier_service_modules
-- ---------------------------------------------------------------------------
ALTER TABLE public.carrier_service_modules
  DROP CONSTRAINT IF EXISTS carrier_service_modules_enterprise_id_fkey,
  DROP CONSTRAINT IF EXISTS carrier_service_modules_reseller_id_fkey;

UPDATE public.carrier_service_modules m
SET enterprise_id = c.tenant_id
FROM public.customers c
WHERE m.enterprise_id IS NOT NULL
  AND m.enterprise_id = c.id;

UPDATE public.carrier_service_modules m
SET reseller_id = r.tenant_id
FROM public.resellers r
WHERE m.reseller_id IS NOT NULL
  AND m.reseller_id = r.id;

UPDATE public.carrier_service_modules
SET enterprise_id = NULL
WHERE enterprise_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = carrier_service_modules.enterprise_id
      AND t.tenant_type = 'ENTERPRISE'
  );

UPDATE public.carrier_service_modules
SET reseller_id = NULL
WHERE reseller_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = carrier_service_modules.reseller_id
      AND t.tenant_type = 'RESELLER'
  );

ALTER TABLE public.carrier_service_modules
  ADD CONSTRAINT carrier_service_modules_enterprise_id_fkey
    FOREIGN KEY (enterprise_id) REFERENCES public.tenants (tenant_id) ON DELETE SET NULL,
  ADD CONSTRAINT carrier_service_modules_reseller_id_fkey
    FOREIGN KEY (reseller_id) REFERENCES public.tenants (tenant_id) ON DELETE SET NULL;

COMMIT;
