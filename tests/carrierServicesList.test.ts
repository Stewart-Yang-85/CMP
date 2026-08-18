import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { signJwtHs256 } from '../src/jwt.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

const SUPABASE_URL = 'https://carrier-list.supabase.test'
const AUTH_SECRET = 'carrier-service-list-test-secret-32chars'
const RESELLER_ID = 'aaaaaaaa-0000-0000-0000-111111111111'
const OTHER_RESELLER_ID = 'bbbbbbbb-0000-0000-0000-222222222222'
/** `carrier_service_modules.reseller_id` FK → RESELLER `tenants.tenant_id` (same as JWT `tenant_id`). */
const RESELLER_ROW_PK = 'f0e0e0e0-0000-4000-8000-000000000001'
const OTHER_RESELLER_ROW_PK = 'f0e0e0e0-0000-4000-8000-000000000002'

type Row = Record<string, any>

function parseQuery(queryString: string) {
  const parts = String(queryString || '').split('&').filter(Boolean)
  const filters: Array<{ field: string; op: string; value: string | string[] }> = []
  let order: string | null = null
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx)
    const value = part.slice(idx + 1)
    if (key === 'select' || key === 'limit' || key === 'offset') continue
    if (key === 'order') {
      order = decodeURIComponent(value)
      continue
    }
    const opIdx = value.indexOf('.')
    if (opIdx < 0) continue
    const op = value.slice(0, opIdx)
    const raw = value.slice(opIdx + 1)
    if (op === 'in') {
      const inner = raw.startsWith('(') && raw.endsWith(')') ? raw.slice(1, -1) : raw
      const values = inner.length ? inner.split(',').map((v) => decodeURIComponent(v)) : []
      filters.push({ field: key, op, value: values })
      continue
    }
    filters.push({ field: key, op, value: decodeURIComponent(raw) })
  }
  return { filters, order }
}

function applyFilters(rows: Row[], filters: Array<{ field: string; op: string; value: string | string[] }>) {
  if (!filters.length) return rows
  return rows.filter((row) => {
    for (const f of filters) {
      const actual = row?.[f.field]
      if (f.op === 'eq' && String(actual ?? '') !== String(f.value ?? '')) return false
      if (f.op === 'in') {
        const values = Array.isArray(f.value) ? f.value : []
        if (!values.includes(String(actual ?? ''))) return false
      }
    }
    return true
  })
}

function sortRows(rows: Row[], order: string | null) {
  if (!order) return rows
  const [field, dirRaw] = order.split('.')
  const dir = dirRaw?.toLowerCase() === 'desc' ? -1 : 1
  return rows.slice().sort((a, b) => {
    const av = a?.[field]
    const bv = b?.[field]
    if (av === bv) return 0
    if (av === undefined || av === null) return 1
    if (bv === undefined || bv === null) return -1
    return av < bv ? -1 * dir : 1 * dir
  })
}

function installSupabaseMock(data: {
  carrierServices: Row[]
  packageVersions: Row[]
  tenants?: Row[]
  resellers?: Row[]
  operators?: Row[]
}) {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!raw.startsWith(SUPABASE_URL)) return originalFetch(input as any, init)
    const url = new URL(raw)
    const method = String(init?.method || 'GET').toUpperCase()
    const table = url.pathname.replace('/rest/v1/', '')
    if (method !== 'GET') return new Response(JSON.stringify([]), { status: 200 })
    const source =
      table === 'carrier_service_modules'
        ? data.carrierServices
        : table === 'package_versions'
          ? data.packageVersions
          : table === 'tenants'
            ? (data.tenants ?? [])
            : table === 'resellers'
              ? (data.resellers ?? [])
              : table === 'operators'
                ? (data.operators ?? [])
                : []
    const { filters, order } = parseQuery(url.search.slice(1))
    const rows = sortRows(applyFilters(source, filters), order)
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = createApp()
  const appAny = app as any
  const server = await new Promise<any>((resolve, reject) => {
    const s = appAny.listen(0, () => resolve(s))
    s.on('error', reject)
  })
  const port = server.address().port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err: any) => (err ? reject(err) : resolve())))
  }
}

function resellerToken() {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHs256(
    {
      iss: 'iot-cmp-api',
      sub: 'user-1',
      iat: now,
      exp: now + 3600,
      userId: 'user-1',
      roleScope: 'reseller',
      role: 'reseller_admin',
      tenant_id: RESELLER_ID,
    },
    AUTH_SECRET
  )
}

function platformToken() {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHs256(
    {
      iss: 'iot-cmp-api',
      sub: 'admin-1',
      iat: now,
      exp: now + 3600,
      userId: 'admin-1',
      roleScope: 'platform',
      role: 'platform_admin',
    },
    AUTH_SECRET
  )
}

describe('carrier services list route', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  it('lists reseller-scoped carrier services without query filters', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const inScopeId = '11111111-1111-1111-1111-111111111111'
    const outScopeId = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: inScopeId,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: '33333333-3333-3333-3333-333333333333',
          operator_id: '44444444-4444-4444-4444-444444444444',
          apn_profile_id: '55555555-5555-5555-5555-555555555555',
          roaming_profile_id: '66666666-6666-6666-6666-666666666666',
          rat: '4G',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: outScopeId,
          reseller_id: OTHER_RESELLER_ID,
          enterprise_id: null,
          supplier_id: '77777777-7777-7777-7777-777777777777',
          operator_id: '88888888-8888-8888-8888-888888888888',
          apn_profile_id: '99999999-9999-9999-9999-999999999999',
          roaming_profile_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          rat: '4G',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      const res = await originalFetch(`${baseUrl}/v1/carrier-services`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(Array.isArray(body.items)).toBe(true)
      expect(body.items[0]?.carrierServiceId).toBe(inScopeId)
      expect(body.items[0]?.resellerId).toBe(RESELLER_ID)
      expect(body.items.find((x: any) => x?.carrierServiceId === outScopeId)).toBeUndefined()
    })
  })

  it('list and GET carrier-service expose apn_profile_id / roaming_profile_id / rat from columns', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const svcId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const colApn = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01'
    const roamId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const supId = '33333333-3333-3333-3333-333333333333'
    const opId = '44444444-4444-4444-4444-444444444444'

    installSupabaseMock({
      resellers: [{ id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' }],
      operators: [{ operator_id: opId, supplier_id: supId, business_operator_id: null }],
      carrierServices: [
        {
          carrier_service_id: svcId,
          reseller_id: RESELLER_ID,
          supplier_id: supId,
          operator_id: opId,
          status: 'PUBLISHED',
          name: 'Column wins HTTP',
          apn_profile_id: colApn,
          roaming_profile_id: roamId,
          rat: '5G',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      const listCol = await originalFetch(
        `${baseUrl}/v1/carrier-services?apnProfileId=${encodeURIComponent(colApn)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(listCol.status).toBe(200)
      const bodyCol = await listCol.json()
      expect(bodyCol.total).toBe(1)
      expect(bodyCol.items[0]?.carrierServiceConfig?.apnProfileId).toBe(colApn)
      expect(bodyCol.items[0]?.carrierServiceConfig?.rat).toBe('5G')

      const listStale = await originalFetch(
        `${baseUrl}/v1/carrier-services?apnProfileId=${encodeURIComponent('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2')}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(listStale.status).toBe(200)
      const bodyStale = await listStale.json()
      expect(bodyStale.items.some((x: any) => x?.carrierServiceId === svcId)).toBe(false)

      const detail = await originalFetch(`${baseUrl}/v1/carrier-services/${encodeURIComponent(svcId)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(detail.status).toBe(200)
      const detailBody = await detail.json()
      expect(detailBody?.carrierServiceConfig?.apnProfileId).toBe(colApn)
      expect(detailBody?.carrierServiceConfig?.rat).toBe('5G')
    })
  })

  it('GET carrier-services/:id rejects other reseller with 403', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const inScopeId = '11111111-1111-1111-1111-111111111111'
    const outScopeId = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: inScopeId,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: '33333333-3333-3333-3333-333333333333',
          operator_id: '44444444-4444-4444-4444-444444444444',
          status: 'PUBLISHED',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: outScopeId,
          reseller_id: OTHER_RESELLER_ID,
          enterprise_id: null,
          supplier_id: '77777777-7777-7777-7777-777777777777',
          operator_id: '88888888-8888-8888-8888-888888888888',
          status: 'PUBLISHED',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      const okRes = await originalFetch(`${baseUrl}/v1/carrier-services/${encodeURIComponent(inScopeId)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(okRes.status).toBe(200)

      const forbidden = await originalFetch(`${baseUrl}/v1/carrier-services/${encodeURIComponent(outScopeId)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(forbidden.status).toBe(403)
      const body = await forbidden.json()
      expect(body.code).toBe('FORBIDDEN')
    })
  })

  it('PUT carrier-services/:id rejects other reseller with 403', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const inScopeId = '11111111-1111-1111-1111-111111111111'
    const outScopeId = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: inScopeId,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: '33333333-3333-3333-3333-333333333333',
          operator_id: '44444444-4444-4444-4444-444444444444',
          status: 'DRAFT',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: outScopeId,
          reseller_id: OTHER_RESELLER_ID,
          enterprise_id: null,
          supplier_id: '77777777-7777-7777-7777-777777777777',
          operator_id: '88888888-8888-8888-8888-888888888888',
          status: 'DRAFT',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      const forbidden = await originalFetch(`${baseUrl}/v1/carrier-services/${encodeURIComponent(outScopeId)}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ carrierServiceConfig: {} }),
      })
      expect(forbidden.status).toBe(403)
      const body = await forbidden.json()
      expect(body.code).toBe('FORBIDDEN')
    })
  })

  it('POST carrier-services/:id::publish rejects other reseller with 403', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const inScopeId = '11111111-1111-1111-1111-111111111111'
    const outScopeId = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: inScopeId,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: '33333333-3333-3333-3333-333333333333',
          operator_id: '44444444-4444-4444-4444-444444444444',
          status: 'DRAFT',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: outScopeId,
          reseller_id: OTHER_RESELLER_ID,
          enterprise_id: null,
          supplier_id: '77777777-7777-7777-7777-777777777777',
          operator_id: '88888888-8888-8888-8888-888888888888',
          status: 'DRAFT',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      const forbidden = await originalFetch(
        `${baseUrl}/v1/carrier-services/${encodeURIComponent(outScopeId)}:publish`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } }
      )
      expect(forbidden.status).toBe(403)
      const body = await forbidden.json()
      expect(body.code).toBe('FORBIDDEN')
    })
  })

  it('POST carrier-services/:id::deprecate rejects other reseller with 403', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const inScopeId = '11111111-1111-1111-1111-111111111111'
    const outScopeId = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: inScopeId,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: '33333333-3333-3333-3333-333333333333',
          operator_id: '44444444-4444-4444-4444-444444444444',
          status: 'PUBLISHED',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: outScopeId,
          reseller_id: OTHER_RESELLER_ID,
          enterprise_id: null,
          supplier_id: '77777777-7777-7777-7777-777777777777',
          operator_id: '88888888-8888-8888-8888-888888888888',
          status: 'PUBLISHED',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      const forbidden = await originalFetch(
        `${baseUrl}/v1/carrier-services/${encodeURIComponent(outScopeId)}:deprecate`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } }
      )
      expect(forbidden.status).toBe(403)
      const body = await forbidden.json()
      expect(body.code).toBe('FORBIDDEN')
    })
  })

  it('accepts matching resellerId query for reseller token', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const inScopeId = '11111111-1111-1111-1111-111111111111'
    const outScopeId = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: inScopeId,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: '33333333-3333-3333-3333-333333333333',
          operator_id: '44444444-4444-4444-4444-444444444444',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: outScopeId,
          reseller_id: OTHER_RESELLER_ID,
          enterprise_id: null,
          supplier_id: '77777777-7777-7777-7777-777777777777',
          operator_id: '88888888-8888-8888-8888-888888888888',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      const res = await originalFetch(
        `${baseUrl}/v1/carrier-services?resellerId=${encodeURIComponent(RESELLER_ID)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0]?.carrierServiceId).toBe(inScopeId)
    })
  })

  it('rejects mismatched resellerId query for reseller token', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      const res = await originalFetch(
        `${baseUrl}/v1/carrier-services?resellerId=${encodeURIComponent(OTHER_RESELLER_ID)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('FORBIDDEN')
    })
  })

  it('platform admin lists all carrier services without resellerId', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const idA = '11111111-1111-1111-1111-111111111111'
    const idB = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: idA,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: '33333333-3333-3333-3333-333333333333',
          operator_id: '44444444-4444-4444-4444-444444444444',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: idB,
          reseller_id: OTHER_RESELLER_ID,
          enterprise_id: null,
          supplier_id: '77777777-7777-7777-7777-777777777777',
          operator_id: '88888888-8888-8888-8888-888888888888',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = platformToken()
      const res = await originalFetch(`${baseUrl}/v1/carrier-services`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(2)
    })
  })

  it('platform admin filters by resellerId', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const idA = '11111111-1111-1111-1111-111111111111'
    const idB = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
        { id: OTHER_RESELLER_ROW_PK, tenant_id: OTHER_RESELLER_ID, name: 'Mock reseller B', status: 'ACTIVE' },
      ],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: idA,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: '33333333-3333-3333-3333-333333333333',
          operator_id: '44444444-4444-4444-4444-444444444444',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: idB,
          reseller_id: OTHER_RESELLER_ID,
          enterprise_id: null,
          supplier_id: '77777777-7777-7777-7777-777777777777',
          operator_id: '88888888-8888-8888-8888-888888888888',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = platformToken()
      const res = await originalFetch(
        `${baseUrl}/v1/carrier-services?resellerId=${encodeURIComponent(RESELLER_ID)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0]?.carrierServiceId).toBe(idA)
    })
  })

  it('rejects enterpriseId query (carrier modules have no enterprise row; see OpenAPI listCarrierServices)', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const enterpriseInScope = 'cccccccc-0000-0000-0000-333333333333'
    const enterpriseOutScope = 'dddddddd-0000-0000-0000-444444444444'
    installSupabaseMock({
      resellers: [{ id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' }],
      operators: [],
      carrierServices: [],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = resellerToken()
      for (const eid of [enterpriseInScope, enterpriseOutScope]) {
        const res = await originalFetch(`${baseUrl}/v1/carrier-services?enterpriseId=${encodeURIComponent(eid)}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.code).toBe('BAD_REQUEST')
      }
    })
  })

  const SUPPLIER_SA = '33333333-3333-3333-3333-333333333333'
  const SUPPLIER_SB = '99999999-9999-9999-9999-999999990001'
  const INTERNAL_OPERATOR_PK = '44444444-4444-4444-4444-444444444444'
  const BUSINESS_OPERATOR_PUBLIC = 'aaaaaaaa-1111-1111-1111-111111111111'

  it('filters by supplierId', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const idA = '11111111-1111-1111-1111-111111111111'
    const idB = '22222222-2222-2222-2222-222222222222'
    installSupabaseMock({
      resellers: [
        { id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' },
      ],
      operators: [
        {
          operator_id: INTERNAL_OPERATOR_PK,
          supplier_id: SUPPLIER_SA,
          business_operator_id: BUSINESS_OPERATOR_PUBLIC,
        },
      ],
      carrierServices: [
        {
          carrier_service_id: idA,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: SUPPLIER_SA,
          operator_id: INTERNAL_OPERATOR_PK,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          carrier_service_id: idB,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: SUPPLIER_SB,
          operator_id: INTERNAL_OPERATOR_PK,
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = platformToken()
      const res = await originalFetch(
        `${baseUrl}/v1/carrier-services?supplierId=${encodeURIComponent(SUPPLIER_SA)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0]?.carrierServiceId).toBe(idA)
    })
  })

  it('filters by operatorId resolved via business_operator_id', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const csId = '11111111-1111-1111-1111-111111111111'
    installSupabaseMock({
      resellers: [{ id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' }],
      operators: [
        {
          operator_id: INTERNAL_OPERATOR_PK,
          supplier_id: SUPPLIER_SA,
          business_operator_id: BUSINESS_OPERATOR_PUBLIC,
        },
      ],
      carrierServices: [
        {
          carrier_service_id: csId,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: SUPPLIER_SA,
          operator_id: INTERNAL_OPERATOR_PK,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = platformToken()
      const res = await originalFetch(
        `${baseUrl}/v1/carrier-services?operatorId=${encodeURIComponent(BUSINESS_OPERATOR_PUBLIC)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0]?.carrierServiceId).toBe(csId)
      expect(body.items[0]?.operatorId).toBe(BUSINESS_OPERATOR_PUBLIC)
    })
  })

  it('accepts carrierId as alias for operatorId', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    const csId = '11111111-1111-1111-1111-111111111111'
    installSupabaseMock({
      resellers: [{ id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' }],
      operators: [
        {
          operator_id: INTERNAL_OPERATOR_PK,
          supplier_id: SUPPLIER_SA,
          business_operator_id: BUSINESS_OPERATOR_PUBLIC,
        },
      ],
      carrierServices: [
        {
          carrier_service_id: csId,
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: SUPPLIER_SA,
          operator_id: INTERNAL_OPERATOR_PK,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = platformToken()
      const res = await originalFetch(
        `${baseUrl}/v1/carrier-services?carrierId=${encodeURIComponent(INTERNAL_OPERATOR_PK)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0]?.carrierServiceId).toBe(csId)
    })
  })

  it('returns empty when operatorId does not resolve', async () => {
    process.env.SUPABASE_URL = SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET
    process.env.AUTH_CLIENT_ID = 'cid'
    process.env.AUTH_CLIENT_SECRET = 'csec'

    installSupabaseMock({
      resellers: [{ id: RESELLER_ROW_PK, tenant_id: RESELLER_ID, name: 'Mock reseller A', status: 'ACTIVE' }],
      operators: [],
      carrierServices: [
        {
          carrier_service_id: '11111111-1111-1111-1111-111111111111',
          reseller_id: RESELLER_ID,
          enterprise_id: null,
          supplier_id: SUPPLIER_SA,
          operator_id: INTERNAL_OPERATOR_PK,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      packageVersions: [],
      tenants: [],
    })

    await withServer(async (baseUrl) => {
      const token = platformToken()
      const unknownOp = '00000000-0000-0000-0000-000000000099'
      const res = await originalFetch(
        `${baseUrl}/v1/carrier-services?operatorId=${encodeURIComponent(unknownOp)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(0)
      expect(body.items).toEqual([])
    })
  })
})
