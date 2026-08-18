-- Single-entity Package model (spec FR-016 / FR-060, data-model.md):
-- Morph `package_versions` + legacy `packages` (container) into one table `packages`
-- with PK `package_id` (former package_version_id). Subscriptions reference `package_id`.
--
-- Breaking: HTTP `packageId` denotes the sellable package row (no separate "line" id).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Container table -> packages_line; backfill enterprise + name onto versions
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.packages RENAME TO packages_line;

ALTER TABLE public.package_versions
  ADD COLUMN IF NOT EXISTS enterprise_id uuid REFERENCES public.tenants (tenant_id),
  ADD COLUMN IF NOT EXISTS name text;

UPDATE public.package_versions pv
SET
  enterprise_id = pl.enterprise_id,
  name = trim(both ' ' from coalesce(pl.name, '') || ' v' || pv.version::text)
FROM public.packages_line pl
WHERE pl.package_id = pv.package_id;

UPDATE public.package_versions
SET name = 'Package v' || coalesce(version::text, '1')
WHERE name IS NULL OR trim(name) = '';

ALTER TABLE public.package_versions ALTER COLUMN enterprise_id SET NOT NULL;
ALTER TABLE public.package_versions ALTER COLUMN name SET NOT NULL;

-- Drop FK package_versions -> packages_line
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
  SELECT c.conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.package_versions'::regclass
    AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) ILIKE '%packages_line%'
  LOOP
    EXECUTE format('ALTER TABLE public.package_versions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.package_versions DROP COLUMN IF EXISTS package_id;

DROP TABLE IF EXISTS public.packages_line CASCADE;

ALTER TABLE public.package_versions DROP CONSTRAINT IF EXISTS package_versions_package_id_version_key;

ALTER TABLE public.package_versions DROP COLUMN IF EXISTS version;

ALTER TABLE public.package_versions RENAME COLUMN package_version_id TO package_id;

ALTER TABLE public.package_versions ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE public.package_versions ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;
ALTER TABLE public.package_versions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT current_timestamp;

UPDATE public.package_versions
SET
  published_at = coalesce(published_at, effective_from, created_at)
WHERE upper(coalesce(status, '')) = 'PUBLISHED';

UPDATE public.package_versions
SET deprecated_at = coalesce(deprecated_at, created_at)
WHERE upper(coalesce(status, '')) = 'DEPRECATED';

ALTER TABLE public.package_versions RENAME TO packages;

CREATE INDEX IF NOT EXISTS idx_packages_enterprise_status ON public.packages (enterprise_id, status);
CREATE INDEX IF NOT EXISTS idx_packages_price_plan_id ON public.packages (price_plan_id);
CREATE INDEX IF NOT EXISTS idx_packages_carrier_service_id ON public.packages (carrier_service_id);
CREATE INDEX IF NOT EXISTS idx_packages_commercial_terms_id ON public.packages (commercial_terms_id);
CREATE INDEX IF NOT EXISTS idx_packages_control_policy_id ON public.packages (control_policy_id);

-- ---------------------------------------------------------------------------
-- 2) subscriptions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
  SELECT c.conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.subscriptions'::regclass
    AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) ILIKE '%package_versions%'
  LOOP
    EXECUTE format('ALTER TABLE public.subscriptions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.subscriptions RENAME COLUMN package_version_id TO package_id;

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_package_id_fkey;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_package_id_fkey
  FOREIGN KEY (package_id) REFERENCES public.packages (package_id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_subscriptions_package_id ON public.subscriptions (package_id);

-- ---------------------------------------------------------------------------
-- 3) vendor_product_mappings
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
  SELECT c.conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.vendor_product_mappings'::regclass
    AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) ILIKE '%package_versions%'
  LOOP
    EXECUTE format('ALTER TABLE public.vendor_product_mappings DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.vendor_product_mappings RENAME COLUMN package_version_id TO package_id;

ALTER TABLE public.vendor_product_mappings DROP CONSTRAINT IF EXISTS vendor_product_mappings_package_id_fkey;

ALTER TABLE public.vendor_product_mappings
  ADD CONSTRAINT vendor_product_mappings_package_id_fkey
  FOREIGN KEY (package_id) REFERENCES public.packages (package_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 4) bill_line_items
-- ---------------------------------------------------------------------------
ALTER TABLE public.bill_line_items RENAME COLUMN package_version_id TO package_id;

-- ---------------------------------------------------------------------------
-- 5) rating_results
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
  SELECT c.conname
  FROM pg_constraint c
  WHERE c.conrelid = 'public.rating_results'::regclass
    AND c.contype = 'f'
    AND pg_get_constraintdef(c.oid) ILIKE '%package_versions%'
  LOOP
    EXECUTE format('ALTER TABLE public.rating_results DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.rating_results RENAME COLUMN matched_package_version_id TO matched_package_id;

ALTER TABLE public.rating_results DROP CONSTRAINT IF EXISTS rating_results_matched_package_id_fkey;

ALTER TABLE public.rating_results
  ADD CONSTRAINT rating_results_matched_package_id_fkey
  FOREIGN KEY (matched_package_id) REFERENCES public.packages (package_id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 6) share_links
-- ---------------------------------------------------------------------------
UPDATE public.share_links SET kind = 'packages' WHERE kind = 'packageVersions';

ALTER TABLE public.share_links DROP CONSTRAINT IF EXISTS share_links_kind;

ALTER TABLE public.share_links
  ADD CONSTRAINT share_links_kind CHECK (kind IN ('packages', 'bills'));

-- ---------------------------------------------------------------------------
-- 7) RBAC
-- ---------------------------------------------------------------------------
DELETE FROM public.role_permissions
WHERE permission_id IN (
  SELECT id FROM public.permissions WHERE code = 'catalog.package_versions.list'
);

DELETE FROM public.permissions WHERE code = 'catalog.package_versions.list';

COMMIT;
