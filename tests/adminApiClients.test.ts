import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../dist/app.js'
import { signJwtHs256 } from '../src/jwt.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const base = 'https://admin-api-clients.supabase.test'

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  })
}

function eqParam(sp: URLSearchParams, key: string) {
  const v = sp.get(key)
  if (!v?.startsWith('eq.')) return null
  return decodeURIComponent(v.slice(3))
}

function installSupabaseMock(state: { apiClients: any[]; auditLogs: any[]; tenants?: any[] }) {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!raw.startsWith(base)) return originalFetch(input as any, init)
    const url = new URL(raw)
    const method = String(init?.method || 'GET').toUpperCase()
    const table = url.pathname.match(/\/rest\/v1\/([^/?]+)/)?.[1] ?? ''
    const sp = url.searchParams
    if (table === 'tenants' && method === 'GET') {
      const tenantId = eqParam(sp, 'tenant_id')
      const tenantType = eqParam(sp, 'tenant_type')
      let rows = Array.isArray(state.tenants) ? state.tenants.slice() : []
      if (tenantId) rows = rows.filter((r) => String(r.tenant_id) === tenantId)
      if (tenantType) rows = rows.filter((r) => String(r.tenant_type) === tenantType)
      return jsonResponse(200, rows, { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` })
    }
    if (table === 'api_clients' && method === 'GET') {
      const clientId = eqParam(sp, 'client_id')
      const enterpriseId = eqParam(sp, 'enterprise_id')
      let rows = state.apiClients.slice()
      if (clientId) rows = rows.filter((r) => String(r.client_id) === clientId)
      if (enterpriseId) rows = rows.filter((r) => String(r.enterprise_id) === enterpriseId)
      return jsonResponse(200, rows, { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` })
    }
    if (table === 'api_clients' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const row = Array.isArray(body) ? body[0] : body
      const created = { ...row, created_at: '2026-05-07T13:45:00.000Z' }
      state.apiClients.push(created)
      return jsonResponse(201, [created])
    }
    if (table === 'audit_logs' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const rows = Array.isArray(body) ? body : [body]
      state.auditLogs.push(...rows)
      return new Response(null, { status: 201 })
    }
    return jsonResponse(200, [])
  }
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = createApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await app.close()
  }
}

function platformAdminToken(secret: string) {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHs256(
    {
      iss: 'iot-cmp-api',
      sub: 'platform-admin-user',
      userId: 'platform-admin-user',
      role: 'platform_admin',
      roleScope: 'platform',
      iat: now,
      exp: now + 3600,
    },
    secret
  )
}

describe('POST /v1/admin/api-clients', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  it('creates an api client with admin key', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.ADMIN_API_KEY = 'admin-key'
    const state = {
      apiClients: [],
      auditLogs: [] as any[],
      tenants: [
        {
          tenant_id: 'cccccccc-0000-0000-0000-333333333333',
          tenant_type: 'ENTERPRISE',
          name: 'Demo Enterprise',
        },
      ],
    }
    installSupabaseMock(state)
    const enterpriseId = 'cccccccc-0000-0000-0000-333333333333'

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/api-clients`, {
        method: 'POST',
        headers: {
          'x-api-key': 'admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          clientId: 'downstream-client-1',
          enterpriseId,
          clientSecret: 'downstream-secret-123',
        }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.clientId).toBe('downstream-client-1')
      expect(body.enterpriseId).toBe(enterpriseId)
      expect(body.name).toBe('Demo Enterprise')
      expect(body.status).toBe('ACTIVE')
      expect(body.clientSecret).toBe('downstream-secret-123')
    })
  })

  it('creates an api client with platform_admin bearer token', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.AUTH_TOKEN_SECRET = 'test-secret-for-admin-bearer'
    process.env.ADMIN_API_KEY = ''
    installSupabaseMock({
      apiClients: [],
      auditLogs: [],
      tenants: [
        {
          tenant_id: 'cccccccc-0000-0000-0000-333333333333',
          tenant_type: 'ENTERPRISE',
          name: 'Demo Enterprise',
        },
      ],
    })
    const token = platformAdminToken(process.env.AUTH_TOKEN_SECRET)

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/api-clients`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          clientId: 'downstream-client-bearer-1',
          enterpriseId: 'cccccccc-0000-0000-0000-333333333333',
          clientSecret: 'downstream-secret-123',
        }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.clientId).toBe('downstream-client-bearer-1')
      expect(body.name).toBe('Demo Enterprise')
    })
  })

  it('rejects non-platform bearer token for admin endpoint', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.AUTH_TOKEN_SECRET = 'test-secret-for-admin-bearer'
    process.env.ADMIN_API_KEY = ''
    installSupabaseMock({
      apiClients: [],
      auditLogs: [],
      tenants: [
        {
          tenant_id: 'cccccccc-0000-0000-0000-333333333333',
          tenant_type: 'ENTERPRISE',
          name: 'Demo Enterprise',
        },
      ],
    })
    const now = Math.floor(Date.now() / 1000)
    const token = signJwtHs256(
      {
        iss: 'iot-cmp-api',
        sub: 'customer-admin-user',
        userId: 'customer-admin-user',
        role: 'customer_admin',
        roleScope: 'customer',
        customerId: 'cccccccc-0000-0000-0000-333333333333',
        iat: now,
        exp: now + 3600,
      },
      process.env.AUTH_TOKEN_SECRET
    )

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/api-clients`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          clientId: 'downstream-client-forbidden-1',
          enterpriseId: 'cccccccc-0000-0000-0000-333333333333',
          clientSecret: 'downstream-secret-123',
        }),
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('FORBIDDEN')
    })
  })

  it('validates enterpriseId format', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.ADMIN_API_KEY = 'admin-key'
    installSupabaseMock({ apiClients: [], auditLogs: [] })

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/api-clients`, {
        method: 'POST',
        headers: {
          'x-api-key': 'admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          clientId: 'downstream-client-1',
          enterpriseId: 'not-a-uuid',
          clientSecret: 'downstream-secret-123',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('VALIDATION_ERROR')
    })
  })

  it('rejects duplicate clientId', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.ADMIN_API_KEY = 'admin-key'
    installSupabaseMock({
      apiClients: [{ client_id: 'downstream-client-1', enterprise_id: 'cccccccc-0000-0000-0000-333333333333', status: 'ACTIVE' }],
      auditLogs: [],
      tenants: [
        {
          tenant_id: 'cccccccc-0000-0000-0000-333333333333',
          tenant_type: 'ENTERPRISE',
          name: 'Demo Enterprise',
        },
      ],
    })

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/api-clients`, {
        method: 'POST',
        headers: {
          'x-api-key': 'admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          clientId: 'downstream-client-1',
          enterpriseId: 'cccccccc-0000-0000-0000-333333333333',
          clientSecret: 'downstream-secret-123',
        }),
      })
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('DUPLICATE_CLIENT_ID')
    })
  })
})

describe('GET /v1/admin/api-clients', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  it('rejects invalid enterpriseId format', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.ADMIN_API_KEY = 'admin-key'
    installSupabaseMock({ apiClients: [], auditLogs: [] })

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/api-clients?enterpriseId=not-a-uuid`, {
        headers: { 'x-api-key': 'admin-key' },
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('VALIDATION_ERROR')
    })
  })

  it('rejects unknown enterpriseId with 404 instead of empty list', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.ADMIN_API_KEY = 'admin-key'
    installSupabaseMock({
      apiClients: [],
      auditLogs: [],
      tenants: [
        {
          tenant_id: 'cccccccc-0000-0000-0000-333333333333',
          tenant_type: 'ENTERPRISE',
          name: 'Demo Enterprise',
        },
      ],
    })
    const missingId = 'cccccccc-0000-0000-0000-999999999999'

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/api-clients?enterpriseId=${missingId}`, {
        headers: { 'x-api-key': 'admin-key' },
      })
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.code).toBe('RESOURCE_NOT_FOUND')
      expect(body.message).toContain(missingId)
    })
  })

  it('lists clients when enterpriseId exists', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.ADMIN_API_KEY = 'admin-key'
    const enterpriseId = 'cccccccc-0000-0000-0000-333333333333'
    installSupabaseMock({
      apiClients: [
        {
          client_id: 'downstream-client-1',
          enterprise_id: enterpriseId,
          status: 'ACTIVE',
          created_at: '2026-05-07T13:45:00.000Z',
          rotated_at: null,
        },
      ],
      auditLogs: [],
      tenants: [
        {
          tenant_id: enterpriseId,
          tenant_type: 'ENTERPRISE',
          name: 'Demo Enterprise',
        },
      ],
    })

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/api-clients?enterpriseId=${enterpriseId}`, {
        headers: { 'x-api-key': 'admin-key' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.items[0].clientId).toBe('downstream-client-1')
    })
  })
})
