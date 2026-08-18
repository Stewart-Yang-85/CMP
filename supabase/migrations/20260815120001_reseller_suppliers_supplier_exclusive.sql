-- Enforce: each supplier binds to at most one reseller (reseller-scoped supplier instance).
-- Deduplicate any historical multi-binds by keeping the earliest created_at row per supplier_id.

WITH ranked AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY supplier_id
      ORDER BY created_at ASC NULLS LAST, reseller_id ASC
    ) AS rn
  FROM public.reseller_suppliers
)
DELETE FROM public.reseller_suppliers rs
USING ranked r
WHERE rs.ctid = r.ctid
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reseller_suppliers_supplier_id
  ON public.reseller_suppliers (supplier_id);

COMMENT ON INDEX public.uq_reseller_suppliers_supplier_id IS
  'FR-042a: each supplier_id is exclusively bound to one reseller_id';
