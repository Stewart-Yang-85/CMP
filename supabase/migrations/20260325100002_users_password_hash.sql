-- V1.1 Phase 24: Add password_hash column to users table
--
-- Purpose: Enable user-password login flow (Mode B) alongside existing M2M auth.
-- Users (reseller_admin, customer_admin, etc.) can now authenticate via email+password.
--
-- The password_hash column stores scrypt-hashed passwords in the format:
--   scrypt$N$r$p$salt$derivedKey
--
-- Rollback:
--   ALTER TABLE users DROP COLUMN IF EXISTS password_hash;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash text;

-- Index for email lookups during login (email is already part of unique(tenant_id, email))
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
