import { describe, expect, it } from 'vitest'
import { resolveEventScopeColumns, sanitizeEventPayload } from '../src/services/eventEmitter.ts'

describe('event scope columns', () => {
  it('sanitizeEventPayload removes resellerId', () => {
    expect(sanitizeEventPayload({ billId: 'b1', resellerId: 'r1' })).toEqual({ billId: 'b1' })
  })

  it('resolveEventScopeColumns derives reseller from enterprise', async () => {
    const enterpriseId = 'cccccccc-0000-0000-0000-333333333333'
    const resellerId = 'aaaaaaaa-0000-0000-0000-111111111111'
    const supabase = {
      async select(table: string, queryString: string) {
        if (table === 'tenants' && queryString.includes(enterpriseId)) {
          return [{ tenant_id: enterpriseId, parent_id: resellerId, tenant_type: 'ENTERPRISE' }]
        }
        return []
      },
    }
    const scope = await resolveEventScopeColumns(supabase as any, { enterpriseId, resellerId: null })
    expect(scope).toEqual({ enterpriseId, resellerId })
  })

  it('resolveEventScopeColumns keeps reseller-only scope', async () => {
    const resellerId = 'aaaaaaaa-0000-0000-0000-111111111111'
    const supabase = { async select() { return [] } }
    const scope = await resolveEventScopeColumns(supabase as any, { enterpriseId: null, resellerId })
    expect(scope).toEqual({ enterpriseId: null, resellerId })
  })
})
