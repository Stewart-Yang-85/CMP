import { describe, expect, it } from 'vitest'
import { ensureSimDiagnosticsAccess } from '../src/services/simDiagnosticsScope.js'

function createFakeSupabase(seed: {
  sims?: Record<string, unknown>[]
  tenants?: Record<string, unknown>[]
  resellerSuppliers?: Record<string, unknown>[]
  resellers?: Record<string, unknown>[]
}) {
  return {
    async select(table: string, queryString: string) {
      if (table === 'sims' && queryString.includes('select=reseller_id')) {
        return [{ reseller_id: null }]
      }
      if (table === 'sims') {
        const m = queryString.match(/iccid=eq\.([^&]+)/)
        const iccid = m ? decodeURIComponent(m[1]) : null
        const row = (seed.sims ?? []).find((s) => String(s.iccid) === iccid)
        return row ? [row] : []
      }
      if (table === 'tenants') {
        const m = queryString.match(/tenant_id=eq\.([^&]+)/)
        const tenantId = m ? decodeURIComponent(m[1]) : null
        const row = (seed.tenants ?? []).find((t) => String(t.tenant_id) === tenantId)
        return row ? [row] : []
      }
      if (table === 'reseller_suppliers') {
        return seed.resellerSuppliers ?? []
      }
      if (table === 'resellers') {
        return seed.resellers ?? []
      }
      return []
    },
  }
}

describe('ensureSimDiagnosticsAccess', () => {
  const iccid = '893107032536638540'
  const enterpriseId = 'cccccccc-0000-0000-0000-333333333333'
  const resellerId = 'aaaaaaaa-0000-0000-0000-111111111111'

  it('platform admin only requires sim in inventory', async () => {
    const supabase = createFakeSupabase({
      sims: [{ sim_id: 's1', iccid, enterprise_id: enterpriseId }],
    })
    const result = await ensureSimDiagnosticsAccess({
      supabase,
      iccid,
      roleScope: 'platform',
      role: 'platform_admin',
      authResellerId: null,
      userEnterpriseId: null,
      userDepartmentId: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.enterpriseIdForQuery).toBeNull()
  })

  it('returns 404 when sim is missing', async () => {
    const supabase = createFakeSupabase({ sims: [] })
    const result = await ensureSimDiagnosticsAccess({
      supabase,
      iccid,
      roleScope: 'customer',
      role: 'customer_admin',
      authResellerId: null,
      userEnterpriseId: enterpriseId,
      userDepartmentId: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
  })

  it('customer token rejects sim outside enterprise', async () => {
    const supabase = createFakeSupabase({
      sims: [{ sim_id: 's1', iccid, enterprise_id: 'dddddddd-0000-0000-0000-444444444444' }],
    })
    const result = await ensureSimDiagnosticsAccess({
      supabase,
      iccid,
      roleScope: 'customer',
      role: 'customer_admin',
      authResellerId: null,
      userEnterpriseId: enterpriseId,
      userDepartmentId: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(403)
  })

  it('reseller token accepts child enterprise sim', async () => {
    const supabase = createFakeSupabase({
      sims: [{ sim_id: 's1', iccid, enterprise_id: enterpriseId, supplier_id: 'sup-1' }],
      tenants: [{ tenant_id: enterpriseId, parent_id: resellerId }],
    })
    const result = await ensureSimDiagnosticsAccess({
      supabase,
      iccid,
      roleScope: 'reseller',
      role: 'reseller_admin',
      authResellerId: resellerId,
      userEnterpriseId: null,
      userDepartmentId: null,
    })
    expect(result.ok).toBe(true)
  })
})
