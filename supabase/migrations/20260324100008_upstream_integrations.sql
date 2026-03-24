-- Gap supplement T162: upstream_integrations table for managing supplier upstream configs.

CREATE TABLE IF NOT EXISTS upstream_integrations (
  integration_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id    uuid NOT NULL REFERENCES suppliers(supplier_id),
  name           text NOT NULL,
  type           text NOT NULL DEFAULT 'API',  -- API, SFTP, WEBHOOK
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'ACTIVE',
  created_at     timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at     timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_upstream_integrations_supplier
  ON upstream_integrations(supplier_id);

-- RLS
ALTER TABLE IF EXISTS upstream_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS upstream_integrations_no_anon ON upstream_integrations;
CREATE POLICY upstream_integrations_no_anon ON upstream_integrations
  FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS upstream_integrations_authenticated ON upstream_integrations;
CREATE POLICY upstream_integrations_authenticated ON upstream_integrations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
