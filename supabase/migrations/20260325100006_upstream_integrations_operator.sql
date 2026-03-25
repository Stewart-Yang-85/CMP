-- Add operator_id, api_endpoint, and enabled columns to upstream_integrations.
-- Also add unique constraint on (supplier_id, operator_id).

ALTER TABLE upstream_integrations
  ADD COLUMN IF NOT EXISTS operator_id uuid REFERENCES business_operators(operator_id),
  ADD COLUMN IF NOT EXISTS api_endpoint text,
  ADD COLUMN IF NOT EXISTS enabled boolean DEFAULT true;

-- Add unique constraint (idempotent)
DO $$ BEGIN
  ALTER TABLE upstream_integrations ADD CONSTRAINT uq_upstream_supplier_operator UNIQUE(supplier_id, operator_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
