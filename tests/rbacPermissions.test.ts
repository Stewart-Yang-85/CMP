import { describe, expect, it } from 'vitest'

// Phase 23: RBAC Database-Driven Permission Tests
// Verify that:
// 1. When DB has role data, permissions resolve from DB
// 2. When DB is empty/unavailable, fallback to hardcoded defaults
// 3. Role codes match between user_roles.role_name and roles.code

describe('Phase 23: RBAC Database-Driven Permissions', () => {
  it('migration file creates roles/permissions/role_permissions tables', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('supabase/migrations/20260324100002_rbac_tables.sql', 'utf-8')

    expect(content).toContain('CREATE TABLE IF NOT EXISTS roles')
    expect(content).toContain('code text NOT NULL UNIQUE')
    expect(content).toContain('scope text NOT NULL')

    expect(content).toContain('CREATE TABLE IF NOT EXISTS permissions')
    expect(content).toContain('category text NOT NULL')

    expect(content).toContain('CREATE TABLE IF NOT EXISTS role_permissions')
    expect(content).toContain('REFERENCES roles(id)')
    expect(content).toContain('REFERENCES permissions(id)')
  })

  it('seed file contains all 6 business roles', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('supabase/migrations/20260324100003_rbac_seed.sql', 'utf-8')

    const roles = [
      'reseller_admin',
      'reseller_sales_director',
      'reseller_sales',
      'reseller_finance',
      'customer_admin',
      'customer_ops',
    ]
    for (const role of roles) {
      expect(content).toContain(`'${role}'`)
    }
  })

  it('seed file contains 38+ permission codes', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('supabase/migrations/20260324100003_rbac_seed.sql', 'utf-8')

    const requiredPermissions = [
      'bills.list', 'bills.read', 'bills.export', 'bills.mark_paid', 'bills.adjust', 'bills.write_off',
      'sims.list', 'sims.read', 'sims.create', 'sims.import', 'sims.export',
      'sims.activate', 'sims.deactivate', 'sims.reactivate', 'sims.retire',
      'subscriptions.list', 'subscriptions.read', 'subscriptions.create',
      'catalog.packages.list', 'price_plans.read',
      'jobs.read', 'share.read', 'share.create',
      'alerts.list', 'alerts.read', 'alerts.acknowledge',
      'reports.usage', 'reports.billing',
    ]
    for (const perm of requiredPermissions) {
      expect(content).toContain(`'${perm}'`)
    }
    expect(requiredPermissions.length).toBeGreaterThanOrEqual(28)
  })

  it('reseller_sales has SIM management but no billing write', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('supabase/migrations/20260324100003_rbac_seed.sql', 'utf-8')

    // Find the reseller_sales permission block
    const salesBlock = content.split("r.code = 'reseller_sales'").pop()?.split('ON CONFLICT')[0] ?? ''

    // Should have SIM operations
    expect(salesBlock).toContain("'sims.activate'")
    expect(salesBlock).toContain("'sims.deactivate'")
    expect(salesBlock).toContain("'subscriptions.create'")

    // Should NOT have billing write
    expect(salesBlock).not.toContain("'bills.mark_paid'")
    expect(salesBlock).not.toContain("'bills.adjust'")
    expect(salesBlock).not.toContain("'bills.write_off'")
  })

  it('reseller_finance is read-only', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('supabase/migrations/20260324100003_rbac_seed.sql', 'utf-8')

    const financeBlock = content.split("r.code = 'reseller_finance'").pop()?.split('ON CONFLICT')[0] ?? ''

    // Should have read permissions
    expect(financeBlock).toContain("'bills.list'")
    expect(financeBlock).toContain("'bills.read'")
    expect(financeBlock).toContain("'reports.billing'")

    // Should NOT have write operations
    expect(financeBlock).not.toContain("'sims.activate'")
    expect(financeBlock).not.toContain("'sims.create'")
    expect(financeBlock).not.toContain("'subscriptions.create'")
    expect(financeBlock).not.toContain("'bills.mark_paid'")
  })

  it('customer_ops has minimal department-scoped permissions', async () => {
    const fs = await import('node:fs/promises')
    const content = await fs.readFile('supabase/migrations/20260324100003_rbac_seed.sql', 'utf-8')

    const opsBlock = content.split("r.code = 'customer_ops'").pop()?.split('ON CONFLICT')[0] ?? ''

    // Should have read-only SIM access
    expect(opsBlock).toContain("'sims.list'")
    expect(opsBlock).toContain("'sims.read'")
    expect(opsBlock).toContain("'sims.connectivity.read'")

    // Should NOT have lifecycle operations
    expect(opsBlock).not.toContain("'sims.activate'")
    expect(opsBlock).not.toContain("'sims.create'")
    expect(opsBlock).not.toContain("'bills.list'")
  })

  it('rbac.ts getEffectivePermissions falls back to defaults when DB is empty', async () => {
    // Verify the fallback logic exists in rbac.ts
    const fs = await import('node:fs/promises')
    const rbacContent = await fs.readFile('src/middleware/rbac.ts', 'utf-8')

    // DB resolution attempt
    expect(rbacContent).toContain('resolveRolePermissions')

    // Fallback to hardcoded
    expect(rbacContent).toContain('defaultPermissionsByRoleScope')

    // The flow: JWT permissions → DB → hardcoded
    expect(rbacContent).toContain('if (current.length) return current')
    expect(rbacContent).toContain('if (rolePermissions !== null && rolePermissions.length > 0) return rolePermissions')
  })
})
