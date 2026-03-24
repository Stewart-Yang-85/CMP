-- V1.1 Phase 24: Reseller Identity Unification — tenants.tenant_id
--
-- Purpose: Unify reseller identity from resellers.id to tenants.tenant_id across
-- the system. This migration adds reseller_tenant_id FK columns pointing to
-- tenants(tenant_id), migrates data, and deprecates legacy reseller_id columns.
--
-- Deployment: Part of V1.1 single downtime release window (Phase 24 → 23 → 19)
-- Pre-deploy: pg_dump full backup
-- Rollback: Restore pg_dump backup + revert JWT_SECRET + redeploy old code
--
-- Tasks: T137 (customers.reseller_tenant_id), T138 (reseller_suppliers FK update)

BEGIN;

-- ============================================================
-- T137: Add customers.reseller_tenant_id FK → tenants(tenant_id)
-- ============================================================

-- Step 1: Add new column (nullable initially for data migration)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS reseller_tenant_id uuid REFERENCES tenants(tenant_id);

-- Step 2: Migrate data — resolve resellers.id → resellers.tenant_id
UPDATE customers c
SET reseller_tenant_id = r.tenant_id
FROM resellers r
WHERE c.reseller_id = r.id
  AND c.reseller_tenant_id IS NULL;

-- Step 3: Make NOT NULL after data migration
ALTER TABLE customers
  ALTER COLUMN reseller_tenant_id SET NOT NULL;

-- Step 4: Add index for query performance
CREATE INDEX IF NOT EXISTS idx_customers_reseller_tenant_id
  ON customers(reseller_tenant_id);

-- Step 5: Add unique constraint (reseller_tenant_id, name) to mirror legacy constraint
-- Note: We keep both constraints during transition period
ALTER TABLE customers
  ADD CONSTRAINT uq_customers_reseller_tenant_name UNIQUE (reseller_tenant_id, name);

-- ============================================================
-- T138: Migrate reseller_suppliers.reseller_id FK → tenants(tenant_id)
-- ============================================================

-- Strategy: Create new table with correct FK, migrate data, swap tables.
-- This is cleaner than ALTER for composite PK changes.

-- Step 1: Create new table with reseller_id FK → tenants(tenant_id)
CREATE TABLE IF NOT EXISTS reseller_suppliers_v2 (
  reseller_id uuid NOT NULL REFERENCES tenants(tenant_id),
  supplier_id uuid NOT NULL REFERENCES suppliers(supplier_id),
  created_at timestamptz NOT NULL DEFAULT current_timestamp,
  PRIMARY KEY (reseller_id, supplier_id)
);

-- Step 2: Migrate data — resolve resellers.id → resellers.tenant_id
INSERT INTO reseller_suppliers_v2 (reseller_id, supplier_id, created_at)
SELECT r.tenant_id, rs.supplier_id, rs.created_at
FROM reseller_suppliers rs
JOIN resellers r ON rs.reseller_id = r.id
ON CONFLICT (reseller_id, supplier_id) DO NOTHING;

-- Step 3: Drop old table and rename new
DROP TABLE IF EXISTS reseller_suppliers CASCADE;

ALTER TABLE reseller_suppliers_v2 RENAME TO reseller_suppliers;

-- Step 4: Recreate index
CREATE INDEX IF NOT EXISTS idx_reseller_suppliers_supplier
  ON reseller_suppliers(supplier_id);

-- ============================================================
-- Deprecation notes (for future cleanup)
-- ============================================================
-- customers.reseller_id is now deprecated. Application code should use
-- customers.reseller_tenant_id exclusively. The old column is retained
-- for backward compatibility during the V1.1 rollout.
--
-- To fully remove in a future migration:
--   ALTER TABLE customers DROP CONSTRAINT customers_reseller_id_fkey;
--   ALTER TABLE customers DROP CONSTRAINT customers_reseller_id_name_key;
--   ALTER TABLE customers DROP COLUMN reseller_id;

COMMIT;
