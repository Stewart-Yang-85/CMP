-- V1.1 Phase 23: RBAC Database-Driven Permission Configuration
--
-- Purpose: Create roles, permissions, and role_permissions tables to replace
-- hardcoded defaultPermissionsByRoleScope. The application layer (rbac.ts)
-- already supports DB-first resolution with hardcoded fallback.
--
-- Deployment: Part of V1.1 single downtime release (after Phase 24)
-- Tasks: T122 (roles), T123 (permissions), T124 (role_permissions)

BEGIN;

-- ============================================================
-- T122: Create roles table
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  scope text NOT NULL CHECK (scope IN ('platform', 'reseller', 'customer')),
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  updated_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_roles_scope ON roles(scope);

-- ============================================================
-- T123: Create permissions table
-- ============================================================
CREATE TABLE IF NOT EXISTS permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  category text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_permissions_category ON permissions(category);

-- ============================================================
-- T124: Create role_permissions table (junction)
-- ============================================================
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_perm ON role_permissions(permission_id);

COMMIT;
