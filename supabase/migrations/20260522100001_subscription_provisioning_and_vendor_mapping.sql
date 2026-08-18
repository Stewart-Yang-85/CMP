-- Phase 36 (T290): subscription PROVISIONING state + vendor_product_mappings UNIQUE(package_id)

ALTER TYPE public.subscription_state ADD VALUE IF NOT EXISTS 'PROVISIONING';

-- Drop composite unique (package_id, supplier_id); enforce one mapping per package.
ALTER TABLE public.vendor_product_mappings
  DROP CONSTRAINT IF EXISTS vendor_product_mappings_package_version_id_supplier_id_key;

ALTER TABLE public.vendor_product_mappings
  DROP CONSTRAINT IF EXISTS vendor_product_mappings_package_id_supplier_id_key;

-- Keep at most one row per package_id when deduplicating legacy duplicates.
DELETE FROM public.vendor_product_mappings v
WHERE v.mapping_id NOT IN (
  SELECT DISTINCT ON (package_id) mapping_id
  FROM public.vendor_product_mappings
  ORDER BY package_id, created_at DESC NULLS LAST, mapping_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_product_mappings_package_id_unique
  ON public.vendor_product_mappings (package_id);
