import { describe, expect, it } from 'vitest'
import { listSubscriptionsSearch } from '../src/services/subscription.ts'

describe('listSubscriptionsSearch departmentId validation', () => {
  const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'
  const departmentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

  function createSupabaseStub(tenantsRows: Array<Record<string, unknown>>) {
    return {
      select: async (table: string) => {
        if (table === 'tenants') return tenantsRows
        return []
      },
      selectWithCount: async () => ({ data: [], total: 0 }),
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
    }
  }

  it('returns not found when departmentId does not exist', async () => {
    const result = await listSubscriptionsSearch({
      supabase: createSupabaseStub([]),
      enterpriseId,
      departmentId,
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
      expect(result.message).toBe('departmentId Not found.')
    }
  })

  it('returns out-of-scope when department belongs to another enterprise', async () => {
    const result = await listSubscriptionsSearch({
      supabase: createSupabaseStub([
        {
          tenant_id: departmentId,
          tenant_type: 'DEPARTMENT',
          parent_id: '99999999-9999-9999-9999-999999999999',
        },
      ]),
      enterpriseId,
      departmentId,
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.message).toBe('departmentId is out of enterprise scope.')
    }
  })
})

describe('listSubscriptionsSearch supplier/operator validation', () => {
  const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'
  const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
  const supplierId = '11111111-1111-1111-1111-111111111111'
  const operatorId = '22222222-2222-2222-2222-222222222222'

  function createScopeStub({
    suppliers = [],
    operators = [],
    sims = [],
  }: {
    suppliers?: Array<Record<string, unknown>>
    operators?: Array<Record<string, unknown>>
    sims?: Array<Record<string, unknown>>
  }) {
    return {
      select: async (table: string, query: string) => {
        if (table === 'suppliers') return suppliers
        if (table === 'operators') return operators
        if (table === 'sims') return sims
        if (table === 'subscriptions') return []
        if (table === 'packages') return []
        return []
      },
      selectWithCount: async () => ({ data: [], total: 0 }),
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
    }
  }

  it('returns not found when supplierId does not exist', async () => {
    const result = await listSubscriptionsSearch({
      supabase: createScopeStub({ suppliers: [] }),
      enterpriseId,
      supplierId,
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
      expect(result.message).toBe('supplierId Not found.')
    }
  })

  it('returns out-of-scope when supplierId is not associated with enterprise/reseller scope', async () => {
    const result = await listSubscriptionsSearch({
      supabase: createScopeStub({
        suppliers: [{ supplier_id: supplierId }],
        sims: [],
      }),
      enterpriseId,
      resellerId,
      supplierId,
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.message).toBe('supplierId is out of enterprise/reseller scope.')
    }
  })

  it('returns not found when operatorId does not exist', async () => {
    const result = await listSubscriptionsSearch({
      supabase: createScopeStub({
        operators: [],
      }),
      enterpriseId,
      operatorId,
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
      expect(result.message).toBe('operatorId Not found.')
    }
  })

  it('returns out-of-scope when operatorId is not associated with enterprise/reseller scope', async () => {
    const result = await listSubscriptionsSearch({
      supabase: createScopeStub({
        operators: [{ operator_id: operatorId, business_operator_id: operatorId }],
        sims: [],
      }),
      enterpriseId,
      resellerId,
      operatorId,
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.message).toBe('operatorId is out of enterprise/reseller scope.')
    }
  })
})
