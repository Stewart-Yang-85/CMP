-- events: replace ambiguous tenant_id with enterprise_id + reseller_id (FR-058 scope columns).
-- Backfill from legacy tenant_id + tenants hierarchy; then drop tenant_id.
-- Application must be deployed with matching emitEvent / insert paths before relying on new columns in prod.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Add scope columns (nullable; platform / orphan rows may leave both null)
-- ---------------------------------------------------------------------------
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS enterprise_id uuid,
  ADD COLUMN IF NOT EXISTS reseller_id uuid;

-- ---------------------------------------------------------------------------
-- 2) Backfill: tenant_id was ENTERPRISE → enterprise_id + parent reseller
-- ---------------------------------------------------------------------------
UPDATE public.events e
SET
  enterprise_id = e.tenant_id,
  reseller_id = t.parent_id
FROM public.tenants t
WHERE e.tenant_id IS NOT NULL
  AND e.tenant_id = t.tenant_id
  AND t.tenant_type = 'ENTERPRISE'
  AND e.enterprise_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3) Backfill: tenant_id was RESELLER (e.g. ALERT_TRIGGERED) → reseller only
-- ---------------------------------------------------------------------------
UPDATE public.events e
SET
  enterprise_id = NULL,
  reseller_id = e.tenant_id
FROM public.tenants t
WHERE e.tenant_id IS NOT NULL
  AND e.tenant_id = t.tenant_id
  AND t.tenant_type = 'RESELLER'
  AND e.reseller_id IS NULL;

-- ---------------------------------------------------------------------------
-- 4) Backfill: tenant_id was DEPARTMENT → owning enterprise + reseller
-- ---------------------------------------------------------------------------
UPDATE public.events e
SET
  enterprise_id = ent.tenant_id,
  reseller_id = ent.parent_id
FROM public.tenants dept
JOIN public.tenants ent
  ON ent.tenant_id = dept.parent_id
 AND ent.tenant_type = 'ENTERPRISE'
WHERE e.tenant_id IS NOT NULL
  AND e.tenant_id = dept.tenant_id
  AND dept.tenant_type = 'DEPARTMENT'
  AND e.enterprise_id IS NULL;

-- ---------------------------------------------------------------------------
-- 5) Sanity: reseller_id must reference RESELLER tenants when set
-- ---------------------------------------------------------------------------
UPDATE public.events e
SET reseller_id = NULL
WHERE e.reseller_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = e.reseller_id AND t.tenant_type = 'RESELLER'
  );

UPDATE public.events e
SET enterprise_id = NULL
WHERE e.enterprise_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.tenant_id = e.enterprise_id AND t.tenant_type = 'ENTERPRISE'
  );

-- ---------------------------------------------------------------------------
-- 6) Foreign keys + indexes (match sims / bills / jobs pattern)
-- ---------------------------------------------------------------------------
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_enterprise_id_fkey;

ALTER TABLE public.events
  ADD CONSTRAINT events_enterprise_id_fkey
    FOREIGN KEY (enterprise_id) REFERENCES public.tenants (tenant_id);

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_reseller_id_fkey;

ALTER TABLE public.events
  ADD CONSTRAINT events_reseller_id_fkey
    FOREIGN KEY (reseller_id) REFERENCES public.tenants (tenant_id);

CREATE INDEX IF NOT EXISTS idx_events_enterprise_time
  ON public.events (enterprise_id, occurred_at DESC)
  WHERE enterprise_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_reseller_time
  ON public.events (reseller_id, occurred_at DESC)
  WHERE reseller_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_type_enterprise_time
  ON public.events (event_type, enterprise_id, occurred_at DESC)
  WHERE enterprise_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_type_reseller_time
  ON public.events (event_type, reseller_id, occurred_at DESC)
  WHERE reseller_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7) RLS: accessible via enterprise OR reseller (same spirit as jobs)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS events_tenant_isolation ON public.events;

CREATE POLICY events_scope_isolation ON public.events
  FOR ALL TO authenticated
  USING (
    is_tenant_accessible(enterprise_id)
    OR is_tenant_accessible(reseller_id)
    OR (enterprise_id IS NULL AND reseller_id IS NULL)
  )
  WITH CHECK (
    is_tenant_accessible(enterprise_id)
    OR is_tenant_accessible(reseller_id)
    OR (enterprise_id IS NULL AND reseller_id IS NULL)
  );

-- ---------------------------------------------------------------------------
-- 8) Drop legacy column
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_events_tenant_time;

ALTER TABLE public.events
  DROP COLUMN IF EXISTS tenant_id;

COMMIT;
