import { describe, expect, it } from 'vitest'
import { findIccidsOutOfLifecycleScope } from '../src/services/batchLifecycleScope.js'

const normalizeIccid = (v: unknown) => String(v ?? '').trim()

describe('findIccidsOutOfLifecycleScope', () => {
  const supabase = { select: async () => [] }

  it('returns empty for platform scope', async () => {
    const out = await findIccidsOutOfLifecycleScope(
      supabase,
      ['8986012345678901234'],
      [{ iccid: '8986012345678901234', enterprise_id: 'other' }],
      {
        roleScope: 'platform',
        role: 'platform_admin',
        authResellerId: null,
        userEnterpriseId: null,
        userDepartmentId: null,
        enterpriseIdFilter: null,
        hasSimResellerColumn: true,
      },
      normalizeIccid,
      async () => false,
    )
    expect(out).toEqual([])
  })

  it('flags ICCID on another enterprise for customer token', async () => {
    const enterpriseA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const enterpriseB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const out = await findIccidsOutOfLifecycleScope(
      supabase,
      ['8986012345678901234', '8986012345678901235'],
      [
        { iccid: '8986012345678901234', enterprise_id: enterpriseA },
        { iccid: '8986012345678901235', enterprise_id: enterpriseB },
      ],
      {
        roleScope: 'customer',
        role: 'customer_admin',
        authResellerId: null,
        userEnterpriseId: enterpriseA,
        userDepartmentId: null,
        enterpriseIdFilter: enterpriseA,
        hasSimResellerColumn: true,
      },
      normalizeIccid,
      async () => true,
    )
    expect(out).toEqual(['8986012345678901235'])
  })

  it('flags ICCID when reseller cannot read sim', async () => {
    const out = await findIccidsOutOfLifecycleScope(
      supabase,
      ['8986012345678901234'],
      [{ iccid: '8986012345678901234', enterprise_id: null, reseller_id: 'foreign' }],
      {
        roleScope: 'reseller',
        role: 'reseller_admin',
        authResellerId: 'reseller-tenant-1',
        userEnterpriseId: null,
        userDepartmentId: null,
        enterpriseIdFilter: null,
        hasSimResellerColumn: true,
      },
      normalizeIccid,
      async () => false,
    )
    expect(out).toEqual(['8986012345678901234'])
  })

  it('ignores ICCIDs not present in simRows (handled later as not found)', async () => {
    const out = await findIccidsOutOfLifecycleScope(
      supabase,
      ['8986012345678901234'],
      [],
      {
        roleScope: 'customer',
        role: 'customer_admin',
        authResellerId: null,
        userEnterpriseId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        userDepartmentId: null,
        enterpriseIdFilter: null,
        hasSimResellerColumn: false,
      },
      normalizeIccid,
      async () => true,
    )
    expect(out).toEqual([])
  })
})
