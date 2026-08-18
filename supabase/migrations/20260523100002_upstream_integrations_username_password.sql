-- Upstream integration username/password outbound auth (auth_type = username_password)
-- Renamed from 20260521100001_* to avoid version clash with platform_admin_sims_mark_test_ready.

ALTER TABLE upstream_integrations
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS password_encrypted bytea;

COMMENT ON COLUMN upstream_integrations.username IS 'Outbound login username when auth_type = username_password';
COMMENT ON COLUMN upstream_integrations.password_encrypted IS 'AES-256-GCM ciphertext for outbound password when auth_type = username_password';
