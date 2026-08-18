-- price_plans: explicit reseller scope (tenants.tenant_id for RESELLER) for RLS, admin queries, and API alignment with spec.
-- Rollback:
--   DROP INDEX IF EXISTS idx_price_plans_reseller_enterprise;
--   ALTER TABLE public.price_plans DROP CONSTRAINT IF EXISTS price_plans_reseller_id_fkey;
--   ALTER TABLE public.price_plans DROP COLUMN IF EXISTS reseller_id;

ALTER TABLE public.price_plans
  ADD COLUMN IF NOT EXISTS reseller_id uuid;

ALTER TABLE public.price_plans
  DROP CONSTRAINT IF EXISTS price_plans_reseller_id_fkey;

ALTER TABLE public.price_plans
  ADD CONSTRAINT price_plans_reseller_id_fkey
  FOREIGN KEY (reseller_id) REFERENCES public.tenants (tenant_id);

COMMENT ON COLUMN public.price_plans.reseller_id IS
  'RESELLER tenant (tenants.tenant_id, tenant_type=RESELLER). Must match tenants.parent_id of enterprise_id.';

-- Backfill from enterprise tenant parent
UPDATE public.price_plans pp
SET reseller_id = t.parent_id
FROM public.tenants t
WHERE t.tenant_id = pp.enterprise_id
  AND t.tenant_type = 'ENTERPRISE'
  AND t.parent_id IS NOT NULL
  AND pp.reseller_id IS NULL;

-- Backfill from customers.reseller_tenant_id when parent_id was not set
UPDATE public.price_plans pp
SET reseller_id = c.reseller_tenant_id
FROM public.customers c
WHERE c.tenant_id = pp.enterprise_id
  AND c.reseller_tenant_id IS NOT NULL
  AND pp.reseller_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_price_plans_reseller_enterprise
  ON public.price_plans (reseller_id, enterprise_id);

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*)::int INTO n FROM public.price_plans WHERE reseller_id IS NULL;
  IF n > 0 THEN
    RAISE NOTICE 'price_plans: % rows still have NULL reseller_id; NOT NULL not applied. Fix data then re-run or migrate.', n;
  ELSE
    ALTER TABLE public.price_plans ALTER COLUMN reseller_id SET NOT NULL;
  END IF;
END $$;
