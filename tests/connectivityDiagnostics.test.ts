import { describe, expect, it } from 'vitest'
import {
  getConnectivityStatus,
  getLocation,
  getLocationHistory,
  requestResetConnection,
  visitedMccMncFromUpdateLocationPayload,
} from '../src/services/connectivity.ts'

function createConnectivitySupabase(seed: {
  sims?: Record<string, unknown>[]
  usage?: Record<string, unknown>[]
  events?: Record<string, unknown>[]
  jobs?: Record<string, unknown>[]
  stateHistory?: Record<string, unknown>[]
  publicInfos?: Record<string, unknown>[]
}) {
  return {
    async select(table: string, queryString: string) {
      if (table === 'sims') {
        const m = queryString.match(/iccid=eq\.([^&]+)/)
        const iccid = m ? decodeURIComponent(m[1]) : null
        const row = (seed.sims ?? []).find((s) => String(s.iccid) === iccid)
        return row ? [row] : []
      }
      if (table === 'usage_daily_summary') {
        const m = queryString.match(/iccid=eq\.([^&]+)/)
        const iccid = m ? decodeURIComponent(m[1]) : null
        const rows = (seed.usage ?? []).filter((u) => String(u.iccid) === iccid)
        if (queryString.includes('order=usage_day.desc')) {
          return [...rows].sort((a, b) => String(b.usage_day).localeCompare(String(a.usage_day)))
        }
        return rows
      }
      if (table === 'events') {
        const m = queryString.match(/payload->>iccid=eq\.([^&]+)/)
        const iccid = m ? decodeURIComponent(m[1]) : null
        let rows = (seed.events ?? []).filter((e) => {
          const payload = e.payload as Record<string, unknown> | undefined
          return payload && String(payload.iccid) === iccid
        })
        if (queryString.includes('order=occurred_at.desc')) {
          rows = [...rows].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
        }
        const limitMatch = queryString.match(/limit=(\d+)/)
        const limit = limitMatch ? Number(limitMatch[1]) : rows.length
        return rows.slice(0, limit)
      }
      if (table === 'sim_state_history') {
        const m = queryString.match(/sim_id=eq\.([^&]+)/)
        const simId = m ? decodeURIComponent(m[1]) : null
        const rows = (seed.stateHistory ?? []).filter((h) => String(h.sim_id) === simId)
        if (queryString.includes('order=start_time.desc')) {
          return [...rows].sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)))
        }
        return rows
      }
      if (table === 'public_infos') {
        const mccMatch = queryString.match(/mcc=eq\.([^&]+)/)
        const mncMatch = queryString.match(/mnc=eq\.([^&]+)/)
        const mcc = mccMatch ? decodeURIComponent(mccMatch[1]) : null
        const mnc = mncMatch ? decodeURIComponent(mncMatch[1]) : null
        return (seed.publicInfos ?? []).filter((info) =>
          String(info.mcc) === mcc && String(info.mnc) === mnc
        )
      }
      if (table === 'jobs') return seed.jobs ?? []
      return []
    },
    async selectWithCount(table: string, queryString: string) {
      if (table === 'usage_daily_summary') {
        const m = queryString.match(/iccid=eq\.([^&]+)/)
        const iccid = m ? decodeURIComponent(m[1]) : null
        const rows = (seed.usage ?? []).filter((u) => String(u.iccid) === iccid)
        const sorted = [...rows].sort((a, b) => String(b.usage_day).localeCompare(String(a.usage_day)))
        const limitMatch = queryString.match(/limit=(\d+)/)
        const limit = limitMatch ? Number(limitMatch[1]) : sorted.length
        return { data: sorted.slice(0, limit), total: sorted.length }
      }
      const data = await this.select(table, queryString)
      return { data, total: Array.isArray(data) ? data.length : 0 }
    },
    async insert(table: string, rows: unknown) {
      if (table === 'jobs') {
        const list = Array.isArray(rows) ? rows : [rows]
        const inserted = list.map((r, i) => ({
          ...(r as Record<string, unknown>),
          job_id: `job-${i + 1}`,
        }))
        seed.jobs = [...(seed.jobs ?? []), ...inserted]
        return inserted
      }
      return rows
    },
    async update() {
      return []
    },
  }
}

describe('visitedMccMncFromUpdateLocationPayload', () => {
  it('parses WXZG UPDATE_LOCATION mcc and mncList', () => {
    const parsed = visitedMccMncFromUpdateLocationPayload({
      iccid: '893107032536638540',
      mcc: '460',
      mncList: '[01, 02]',
      eventTime: '2026-06-17T10:00:00.000Z',
    })
    expect(parsed.visitedMccMnc).toBe('460-001')
    expect(parsed.mcc).toBe('460')
    expect(parsed.mnc).toBe('001')
    expect(parsed.timestamp).toBe('2026-06-17T10:00:00.000Z')
  })
})

describe('getConnectivityStatus UPSTREAM_PARTIAL', () => {
  const iccid = '893107032536638540'

  it('merges queryCardStatus upstream fields with local usage fallback', async () => {
    const upstreamCalls: string[] = []
    const supabase = createConnectivitySupabase({
      sims: [
        {
          sim_id: 's1',
          iccid,
          status: 'ACTIVATED',
          apn: 'local.apn',
          operators: { business_operators: { mcc: '460', mnc: '001' } },
        },
      ],
      usage: [{ iccid, visited_mccmnc: '460-001', rat: 'LTE', apn: 'usage.apn', created_at: '2026-06-17T08:30:00.000Z', usage_day: '2026-06-16' }],
      stateHistory: [{ sim_id: 's1', start_time: '2026-06-15T00:00:00.000Z' }],
    })
    const upstreamClient = {
      getSimCardStatus: async (id: string) => {
        upstreamCalls.push(id)
        return {
          data: {
            status: 'ACTIVTY',
            ipAddress: '10.0.0.1',
            lastChangeStateTime: '2026-06-17T09:00:00.000Z',
          },
        }
      },
    }
    const result = await getConnectivityStatus({
      supabase,
      upstreamClient,
      connectivityMode: 'UPSTREAM_PARTIAL',
      iccid,
    })
    expect(upstreamCalls).toEqual([iccid])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.value)).toEqual([
      'simStatus',
      'simStatusChangedAt',
      'onlineStatus',
      'registrationStatus',
      'lastActivityTime',
      'visitedMccMnc',
      'ratType',
      'apn',
    ])
    expect(result.value.simStatus).toBe('ACTIVATED')
    expect(result.value.simStatusChangedAt).toBe('2026-06-15T00:00:00.000Z')
    expect(result.value.onlineStatus).toBe('ONLINE')
    expect(result.value.lastActivityTime).toBe('2026-06-17T08:30:00.000Z')
    expect(result.value.ratType).toBe('LTE')
    expect(result.value.visitedMccMnc).toBe('460-001')
    expect(result.value.apn).toBe('usage.apn')
  })

  it('does not call upstream when mode is LOCAL_ASSEMBLE', async () => {
    let called = false
    const supabase = createConnectivitySupabase({
      sims: [{ sim_id: 's1', iccid, status: 'ACTIVATED', operators: { business_operators: { mcc: '460', mnc: '001' } } }],
      usage: [{ iccid, visited_mccmnc: '460-001', created_at: '2026-06-17T08:00:00.000Z', usage_day: '2026-06-17' }],
    })
    const result = await getConnectivityStatus({
      supabase,
      upstreamClient: {
        getSimCardStatus: async () => {
          called = true
          return { data: { status: 'ACTIVTY' } }
        },
      },
      connectivityMode: 'LOCAL_ASSEMBLE',
      iccid,
    })
    expect(called).toBe(false)
    expect(result.ok).toBe(true)
  })

  it('does not infer registered roaming from stale local usage', async () => {
    const staleCreatedAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
    const supabase = createConnectivitySupabase({
      sims: [{ sim_id: 's1', iccid, status: 'ACTIVATED', operators: { business_operators: { mcc: '460', mnc: '001' } } }],
      usage: [{
        iccid,
        visited_mccmnc: '204-008',
        created_at: staleCreatedAt,
        usage_day: staleCreatedAt.slice(0, 10),
      }],
    })

    const result = await getConnectivityStatus({
      supabase,
      upstreamClient: null,
      connectivityMode: 'LOCAL_ASSEMBLE',
      iccid,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.onlineStatus).toBe('OFFLINE')
    expect(result.value.registrationStatus).toBe('NOT_REGISTERED')
    expect(result.value.visitedMccMnc).toBe('204-008')
  })
})

describe('getLocation LOCAL_ASSEMBLE', () => {
  const iccid = '893107032536638540'

  it('prefers UPDATE_LOCATION event over usage_daily_summary', async () => {
    const supabase = createConnectivitySupabase({
      sims: [{ sim_id: 's1', iccid }],
      events: [
        {
          occurred_at: '2026-06-17T11:00:00.000Z',
          payload: { iccid, mcc: '310', mncList: '[260]', eventTime: '2026-06-17T11:00:00.000Z' },
        },
      ],
      usage: [{ iccid, visited_mccmnc: '460-001', usage_day: '2026-06-16' }],
      publicInfos: [{ mcc: '310', mnc: '260', country: 'US', name: 'T-Mobile US' }],
    })
    const result = await getLocation({ supabase, iccid })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.value)).toEqual([
      'iccid',
      'lastActivityTime',
      'visitedMccMnc',
      'country',
      'visitedOperator',
    ])
    expect(result.value.visitedMccMnc).toBe('310-260')
    expect(result.value.lastActivityTime).toBe('2026-06-16T00:00:00.000Z')
    expect(result.value.country).toBe('US')
    expect(result.value.visitedOperator).toBe('T-Mobile US')
  })
})

describe('getLocationHistory LOCAL_ASSEMBLE', () => {
  const iccid = '893107032536638540'

  it('returns simplified visited-network record fields with public operator info', async () => {
    const supabase = createConnectivitySupabase({
      sims: [{ sim_id: 's1', iccid }],
      usage: [{
        iccid,
        visited_mccmnc: '204-08',
        created_at: '2026-06-17T08:00:00.000Z',
        usage_day: '2026-06-17',
      }],
      publicInfos: [{ mcc: '204', mnc: '008', country: 'NL', name: 'Vodafone NL' }],
    })

    const result = await getLocationHistory({
      supabase,
      iccid,
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
      limit: 20,
      offset: 0,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items).toHaveLength(1)
    expect(Object.keys(result.value.items[0])).toEqual([
      'iccid',
      'lastActivityTime',
      'visitedMccMnc',
      'country',
      'visitedOperator',
    ])
    expect(result.value.items[0]).toMatchObject({
      iccid,
      lastActivityTime: '2026-06-17T08:00:00.000Z',
      visitedMccMnc: '204-08',
      country: 'NL',
      visitedOperator: 'Vodafone NL',
    })
  })
})

describe('requestResetConnection cancel-location', () => {
  const iccid = '893107032536638540'

  it('creates SIM_RESET_CONNECTION job without upstream call when NOT_SUPPORTED', async () => {
    let upstreamCalled = false
    const seed: { sims: Record<string, unknown>[]; jobs: Record<string, unknown>[] } = {
      sims: [{ sim_id: 's1', iccid }],
      jobs: [],
    }
    const supabase = createConnectivitySupabase(seed)
    const result = await requestResetConnection({
      supabase,
      iccid,
      upstreamClient: {
        cancelLocation: async () => {
          upstreamCalled = true
        },
      },
      cancelLocationMode: 'NOT_SUPPORTED',
      integrationId: 'int-1',
      reason: 'test',
    })
    expect(upstreamCalled).toBe(false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.jobId).toBe('job-1')
    const inserted = seed.jobs[0] as Record<string, unknown>
    const payload = inserted.payload as Record<string, unknown>
    expect(payload.upstreamCancelSupported).toBe(false)
    expect(payload.upstreamCancelMode).toBe('NOT_SUPPORTED')
    expect(payload.integrationId).toBe('int-1')
  })
})
