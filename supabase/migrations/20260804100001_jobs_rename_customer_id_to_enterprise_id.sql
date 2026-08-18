-- Rename jobs.customer_id → enterprise_id (semantic: ENTERPRISE tenants.tenant_id).
ALTER TABLE jobs RENAME COLUMN customer_id TO enterprise_id;

DROP POLICY IF EXISTS jobs_tenant_isolation ON jobs;
CREATE POLICY jobs_tenant_isolation ON jobs FOR ALL TO authenticated
  USING (
    is_tenant_accessible(enterprise_id)
    OR is_tenant_accessible(reseller_id)
    OR (enterprise_id IS NULL AND reseller_id IS NULL)
  );
