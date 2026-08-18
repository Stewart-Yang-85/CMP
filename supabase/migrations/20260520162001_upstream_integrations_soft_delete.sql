-- Upstream integrations soft delete support:
-- - Keep historical rows with status=DEPRECATED
-- - Allow recreating ACTIVE/INACTIVE row for same (supplier_id, operator_id)

ALTER TABLE upstream_integrations
  ADD COLUMN IF NOT EXISTS deprecated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deprecated_by text,
  ADD COLUMN IF NOT EXISTS deprecation_reason text;

ALTER TABLE upstream_integrations
  DROP CONSTRAINT IF EXISTS uq_upstream_supplier_operator;

DROP INDEX IF EXISTS uq_upstream_supplier_operator;

CREATE UNIQUE INDEX IF NOT EXISTS uq_upstream_supplier_operator_active
  ON upstream_integrations(supplier_id, operator_id)
  WHERE status IN ('ACTIVE', 'INACTIVE');
