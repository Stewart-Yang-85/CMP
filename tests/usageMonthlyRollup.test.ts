import { describe, expect, it } from 'vitest'
import {
  pastMonthsTouchedByUsageDays,
  previousUtcYearMonth,
  resolveUsageMonthlyRollupScope,
  runUsageMonthlyRollup,
  splitReportWindowForUsageSources,
} from '../src/services/usageMonthlyRollup.ts'

describe('usageMonthlyRollup helpers', () => {
  it('lists only past months touched by usage days', () => {
    const now = new Date('2026-08-11T12:00:00.000Z')
    expect(pastMonthsTouchedByUsageDays(['2026-07-15', '2026-08-01', '2026-06-01'], now)).toEqual([
      '2026-06',
      '2026-07',
    ])
  })

  it('previousUtcYearMonth rolls across year boundary', () => {
    expect(previousUtcYearMonth(new Date('2026-01-05T00:00:00.000Z'))).toBe('2025-12')
    expect(previousUtcYearMonth(new Date('2026-08-11T00:00:00.000Z'))).toBe('2026-07')
  })

  it('splits report window into complete past months vs daily fragments', () => {
    const now = new Date('2026-08-11T12:00:00.000Z')
    const start = new Date('2026-01-15T00:00:00.000Z')
    const end = new Date('2026-08-10T00:00:00.000Z')
    const split = splitReportWindowForUsageSources(start, end, now)
    expect(split.monthlyPeriods).toEqual(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'])
    expect(split.dailyRanges.map((r) => ({
      start: r.startDay.toISOString().slice(0, 10),
      end: r.endDay.toISOString().slice(0, 10),
    }))).toEqual([
      { start: '2026-01-15', end: '2026-01-31' },
      { start: '2026-08-01', end: '2026-08-10' },
    ])
  })
})

describe('resolveUsageMonthlyRollupScope', () => {
  const resellerId = '938ca03b-01c7-4f6a-bff6-9dbee00452a6'
  const otherReseller = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const enterpriseId = '2f130185-1bc9-4a33-8f1a-7f49312daa0c'
  const foreignEnterprise = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function mockSupabase() {
    return {
      async select(_table: string, qs: string) {
        if (qs.includes(`tenant_id=eq.${resellerId}`) && qs.includes('RESELLER')) {
          return [{ tenant_id: resellerId, tenant_type: 'RESELLER' }]
        }
        if (qs.includes(`tenant_id=eq.${otherReseller}`) && qs.includes('RESELLER')) {
          return [{ tenant_id: otherReseller, tenant_type: 'RESELLER' }]
        }
        if (qs.includes(`tenant_id=eq.${enterpriseId}`) && qs.includes('ENTERPRISE')) {
          return [{ tenant_id: enterpriseId, parent_id: resellerId, tenant_type: 'ENTERPRISE' }]
        }
        if (qs.includes(`tenant_id=eq.${foreignEnterprise}`) && qs.includes('ENTERPRISE')) {
          return [{ tenant_id: foreignEnterprise, parent_id: otherReseller, tenant_type: 'ENTERPRISE' }]
        }
        if (qs.includes(`parent_id=eq.${resellerId}`) && qs.includes('ENTERPRISE')) {
          return [{ tenant_id: enterpriseId }]
        }
        return []
      },
    } as any
  }

  it('reseller: empty resellerId uses token; enterprise under reseller ok', async () => {
    const result = await resolveUsageMonthlyRollupScope(mockSupabase(), {
      roleScope: 'reseller',
      tokenResellerId: resellerId,
      resellerId: null,
      enterpriseId,
    })
    expect(result).toMatchObject({ ok: true, resellerId, enterpriseId })
  })

  it('reseller: mismatched resellerId forbidden', async () => {
    const result = await resolveUsageMonthlyRollupScope(mockSupabase(), {
      roleScope: 'reseller',
      tokenResellerId: resellerId,
      resellerId: otherReseller,
      enterpriseId: null,
    })
    expect(result).toMatchObject({ ok: false, status: 403, code: 'FORBIDDEN' })
  })

  it('reseller: unknown enterprise not found', async () => {
    const result = await resolveUsageMonthlyRollupScope(mockSupabase(), {
      roleScope: 'reseller',
      tokenResellerId: resellerId,
      resellerId: null,
      enterpriseId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })
    expect(result).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND', message: 'Enterprise not found.' })
  })

  it('reseller: enterprise outside reseller forbidden', async () => {
    const result = await resolveUsageMonthlyRollupScope(mockSupabase(), {
      roleScope: 'reseller',
      tokenResellerId: resellerId,
      resellerId: null,
      enterpriseId: foreignEnterprise,
    })
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Enterprise is not in reseller scope.',
    })
  })

  it('platform: reseller + child enterprise ok', async () => {
    const result = await resolveUsageMonthlyRollupScope(mockSupabase(), {
      roleScope: 'platform',
      resellerId,
      enterpriseId,
    })
    expect(result).toMatchObject({ ok: true, resellerId, enterpriseId })
  })

  it('platform: unknown reseller not found', async () => {
    const result = await resolveUsageMonthlyRollupScope(mockSupabase(), {
      roleScope: 'platform',
      resellerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      enterpriseId: null,
    })
    expect(result).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND', message: 'Reseller not found.' })
  })
})

describe('runUsageMonthlyRollup', () => {
  it('aggregates daily rows into monthly snapshot and replaces month', async () => {
    const deleted: string[] = []
    const inserted: any[] = []
    const supabase = {
      async select(table: string, qs: string) {
        if (table === 'usage_daily_summary') {
          return [
            {
              supplier_id: 'sup-1',
              enterprise_id: 'ent-1',
              sim_id: 'sim-1',
              iccid: '8999',
              usage_day: '2026-07-01',
              visited_mccmnc: '46001',
              uplink_mb: 1,
              downlink_mb: 2,
              total_mb: 3,
              in_profile_mb: 3,
              out_of_profile_mb: 0,
              unclassified_mb: 0,
              rated_at: '2026-07-02T00:00:00.000Z',
            },
            {
              supplier_id: 'sup-1',
              enterprise_id: 'ent-1',
              sim_id: 'sim-1',
              iccid: '8999',
              usage_day: '2026-07-15',
              visited_mccmnc: '46001',
              uplink_mb: 0,
              downlink_mb: 4,
              total_mb: 4,
              in_profile_mb: 1,
              out_of_profile_mb: 3,
              unclassified_mb: 0,
              rated_at: '2026-07-16T00:00:00.000Z',
            },
            {
              supplier_id: 'sup-1',
              enterprise_id: 'ent-1',
              sim_id: 'sim-1',
              iccid: '8999',
              usage_day: '2026-07-20',
              visited_mccmnc: '310260',
              uplink_mb: 0,
              downlink_mb: 5,
              total_mb: 5,
              in_profile_mb: 0,
              out_of_profile_mb: 5,
              unclassified_mb: 0,
              rated_at: null,
            },
          ]
        }
        return []
      },
      async insert(table: string, rows: unknown) {
        if (table === 'usage_monthly_summary') inserted.push(...(Array.isArray(rows) ? rows : [rows]))
        return rows
      },
      async update() {
        return []
      },
      async delete(table: string, match: string) {
        deleted.push(`${table}?${match}`)
      },
    }

    const result = await runUsageMonthlyRollup({
      supabase: supabase as any,
      period: '2026-07',
      now: new Date('2026-08-11T12:00:00.000Z'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.monthlyRows).toBe(2)
    expect(deleted.some((d) => d.includes('usage_month=eq.2026-07-01'))).toBe(true)
    const byVisited = new Map(inserted.map((r) => [r.visited_mccmnc, r]))
    expect(byVisited.get('46001').total_mb).toBe(7)
    expect(byVisited.get('46001').in_profile_mb).toBe(4)
    expect(byVisited.get('310260').total_mb).toBe(5)
  })

  it('rejects future calendar months', async () => {
    const result = await runUsageMonthlyRollup({
      supabase: { select: async () => [], insert: async () => [], update: async () => [] } as any,
      period: '2026-09',
      now: new Date('2026-08-11T12:00:00.000Z'),
    })
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      code: 'BAD_REQUEST',
      message: 'period cannot be a future calendar month.',
    })
  })

  it('rejects periods with no daily usage rows', async () => {
    const result = await runUsageMonthlyRollup({
      supabase: {
        select: async (table: string) => (table === 'usage_daily_summary' ? [] : []),
        insert: async () => [],
        update: async () => [],
        delete: async () => {},
      } as any,
      period: '2023-07',
      now: new Date('2026-08-11T12:00:00.000Z'),
    })
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: 'No usage_daily_summary rows found for period 2023-07.',
    })
  })
})
