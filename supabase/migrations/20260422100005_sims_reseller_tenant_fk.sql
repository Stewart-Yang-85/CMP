-- Reseller pool / inventory SIMs: reseller_id → RESELLER tenants.tenant_id (matches API `resellerId`).
-- Enterprise M2M credentials remain on `customers` (api_key, api_secret_hash, webhook_url).

BEGIN;

ALTER TABLE public.sims
  ADD COLUMN IF NOT EXISTS reseller_id uuid;

UPDATE public.sims s
SET reseller_id = r.tenant_id
FROM public.resellers r
WHERE s.reseller_id IS NOT NULL
  AND s.reseller_id = r.id;

UPDATE public.sims s
SET reseller_id = t.parent_id
FROM public.tenants t
WHERE s.enterprise_id IS NOT NULL
  AND s.enterprise_id = t.tenant_id
  AND t.tenant_type = 'ENTERPRISE'
  AND s.reseller_id IS NULL;

ALTER TABLE public.sims
  DROP CONSTRAINT IF EXISTS sims_reseller_id_fkey;

UPDATE public.sims s
SET reseller_id = NULL
WHERE s.reseller_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = s.reseller_id AND t.tenant_type = 'RESELLER'
  );

ALTER TABLE public.sims
  ADD CONSTRAINT sims_reseller_id_fkey
    FOREIGN KEY (reseller_id) REFERENCES public.tenants (tenant_id);

CREATE INDEX IF NOT EXISTS idx_sims_reseller_id ON public.sims (reseller_id);

COMMIT;
