import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseRoamingProfileRatesCsv, serializeRoamingProfileRatesCsv } from '../src/services/simImportCsv.ts'
import { createRoamingProfile, deprecateRoamingProfile, exportRoamingProfileRatesCsv } from '../src/services/networkProfile.ts'

describe('parseRoamingProfileRatesCsv', () => {
  it('parses required columns and optional country/network', () => {
    const csv = [
      'mcc,mnc,country,network,ratePerMb',
      '520,*,Thailand,"AIS & True Move",0.001',
      '460,00,China,China Mobile,0.0038',
      '',
    ].join('\n')
    const result = parseRoamingProfileRatesCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rowCount).toBe(2)
    expect(result.entries[0]).toMatchObject({
      mcc: '520',
      mnc: '*',
      country: 'Thailand',
      network: 'AIS & True Move',
      ratePerMb: 0.001,
    })
    expect(result.entries[1].network).toBe('China Mobile')
  })

  it('rejects missing ratePerMb column', () => {
    const csv = ['mcc,mnc,country', '520,*,Thailand', ''].join('\n')
    const result = parseRoamingProfileRatesCsv(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('ratePerMb')
  })

  it('rejects empty mcc with row number', () => {
    const csv = ['mcc,mnc,ratePerMb', ',*,0.001', ''].join('\n')
    const result = parseRoamingProfileRatesCsv(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('CSV row 2')
    expect(result.message).toContain('mcc')
  })

  it('accepts snake_case rate_per_mb header', () => {
    const csv = ['mcc,mnc,rate_per_mb', '520,*,0.002', ''].join('\n')
    const result = parseRoamingProfileRatesCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries[0].ratePerMb).toBe(0.002)
  })

  it('round-trips via serializeRoamingProfileRatesCsv', () => {
    const csv = [
      'mcc,mnc,country,network,ratePerMb',
      '310,*,United States,,0.0014',
      '520,*,Thailand,"AIS & True",0.001',
      '',
    ].join('\n')
    const parsed = parseRoamingProfileRatesCsv(csv)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const out = serializeRoamingProfileRatesCsv(parsed.entries)
    const again = parseRoamingProfileRatesCsv(out)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.entries).toEqual(parsed.entries)
  })
})

describe('createRoamingProfile with CSV-shaped mccmncList', () => {
  it('persists country and network from parsed CSV entries', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const supabase = {
      tables: {} as Record<string, unknown[]>,
      async select(table: string) {
        if (table === 'operators') {
          return [{ operator_id: operatorRowId, supplier_id: supplierId, business_operator_id: randomUUID() }]
        }
        return []
      },
      async insert(table: string, row: unknown) {
        if (!supabase.tables[table]) supabase.tables[table] = []
        const r = row as Record<string, unknown>
        const stored = { ...r, roaming_profile_id: randomUUID(), created_at: '2026-05-23T00:00:00Z' }
        supabase.tables[table].push(stored)
        return [stored]
      },
    }
    const parsed = parseRoamingProfileRatesCsv(
      ['mcc,mnc,country,network,ratePerMb', '520,*,Thailand,,0.001', ''].join('\n')
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const result = await createRoamingProfile({
      supabase: supabase as any,
      payload: {
        name: 'CSV roaming',
        supplierId,
        operatorId: operatorRowId,
        mccmncList: parsed.entries,
      },
    })
    expect(result.ok).toBe(true)
    const row = (supabase.tables.roaming_profiles ?? [])[0] as any
    expect(row.mccmnc_list[0]).toMatchObject({
      mcc: '520',
      mnc: '*',
      country: 'Thailand',
      network: '',
      ratePerMb: 0.001,
    })
  })
})

describe('exportRoamingProfileRatesCsv', () => {
  it('exports mccmnc_list as import-compatible CSV', async () => {
    const roamingProfileId = randomUUID()
    const supabase = {
      async select(table: string, qs: string) {
        if (table !== 'roaming_profiles') return []
        if (qs.includes(encodeURIComponent(roamingProfileId))) {
          return [
            {
              roaming_profile_id: roamingProfileId,
              mccmnc_list: [{ mcc: '520', mnc: '*', country: 'Thailand', ratePerMb: 0.001 }],
            },
          ]
        }
        return []
      },
    }
    const result = await exportRoamingProfileRatesCsv({ supabase: supabase as any, roamingProfileId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = parseRoamingProfileRatesCsv(result.value.csv)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.entries[0]).toMatchObject({ mcc: '520', mnc: '*', country: 'Thailand', ratePerMb: 0.001 })
  })

  it('deprecateRoamingProfile persists deprecated_at', async () => {
    const roamingProfileId = randomUUID()
    const row = {
      roaming_profile_id: roamingProfileId,
      status: 'PUBLISHED',
      published_at: '2026-01-01T00:00:00Z',
      effective_from: '2026-02-01T00:00:00Z',
      mccmnc_list: [{ mcc: '520', mnc: '*', ratePerMb: 0.001 }],
      supplier_id: randomUUID(),
      operator_id: randomUUID(),
    }
    const supabase = {
      tables: { roaming_profiles: [row], audit_logs: [] as unknown[] },
      async select(table: string, qs: string) {
        if (table === 'roaming_profiles' && qs.includes(encodeURIComponent(roamingProfileId))) return [row]
        if (table === 'carrier_service_modules') return []
        if (table === 'packages') return []
        return []
      },
      async update(table: string, qs: string, patch: Record<string, unknown>) {
        if (table === 'roaming_profiles') Object.assign(row, patch)
        return null
      },
      async insert(table: string, payload: unknown) {
        if (table === 'audit_logs') supabase.tables.audit_logs.push(payload)
        return null
      },
    }
    const result = await deprecateRoamingProfile({
      supabase: supabase as any,
      roamingProfileId,
      audit: { actorUserId: null, actorRole: 'platform_admin' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as any).profileId).toBeUndefined()
    expect((row as any).deprecated_at).toBeTruthy()
    expect((row as any).status).toBe('DEPRECATED')
  })
})
