-- Phase 37 T297: upstream_integrations V1.1 columns + operators FK correction

ALTER TABLE upstream_integrations
  ADD COLUMN IF NOT EXISTS adapter_type text,
  ADD COLUMN IF NOT EXISTS auth_type text DEFAULT 'api_key',
  ADD COLUMN IF NOT EXISTS token_url text,
  ADD COLUMN IF NOT EXISTS api_key text,
  ADD COLUMN IF NOT EXISTS api_secret_encrypted bytea,
  ADD COLUMN IF NOT EXISTS webhook_key_encrypted bytea;

-- Correct operator_id FK: must reference operators(operator_id), not business_operators
ALTER TABLE upstream_integrations DROP CONSTRAINT IF EXISTS upstream_integrations_operator_id_fkey;

DO $$ BEGIN
  ALTER TABLE upstream_integrations
    ADD CONSTRAINT upstream_integrations_operator_id_fkey
    FOREIGN KEY (operator_id) REFERENCES operators(operator_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_upstream_integrations_supplier_operator
  ON upstream_integrations(supplier_id, operator_id);

COMMENT ON COLUMN upstream_integrations.adapter_type IS 'Vendor adapter key e.g. wxzhonggeng';
COMMENT ON COLUMN upstream_integrations.api_secret_encrypted IS 'AES-256-GCM ciphertext (iv||ct||tag)';
COMMENT ON COLUMN upstream_integrations.webhook_key_encrypted IS 'AES-256-GCM ciphertext for inbound webhook verification';
