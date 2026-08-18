-- Password reset tokens for POST /auth/forgot-password + /auth/reset-password.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(user_id),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_ip text,
  CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id
  ON password_reset_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at
  ON password_reset_tokens (expires_at);

COMMENT ON TABLE password_reset_tokens IS
  'One-time tokens for self-service password reset (email link flow). Store only token_hash, never raw token.';
