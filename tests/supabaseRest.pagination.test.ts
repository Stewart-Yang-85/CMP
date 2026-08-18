import { describe, expect, it, vi, afterEach } from 'vitest'

describe('supabaseRest selectWithCount pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  it('returns empty data when PostgREST reports offset beyond row count (416 PGRST103)', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'test-anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 416,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          code: 'PGRST103',
          details: 'An offset of 40 was requested, but there are only 35 rows.',
          hint: null,
          message: 'Requested range not satisfiable',
        }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { createSupabaseRestClient } = await import('../src/supabaseRest.js')
    const client = createSupabaseRestClient({ useServiceRole: true })
    const { data, total } = await client.selectWithCount('sims', 'select=sim_id&limit=20&offset=40')

    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(0)
    expect(total).toBe(35)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
