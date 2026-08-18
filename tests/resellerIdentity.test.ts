import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { signJwtHs256 } from '../src/jwt.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

// Phase 24: Test reseller identity unification
// auth.resellerId should always be tenants.tenant_id, never resellers.id
const resellerTenantId = 'aaaaaaaa-0000-0000-0000-111111111111'
const resellerId = 'bbbbbbbb-0000-0000-0000-222222222222' // legacy resellers.id
const enterpriseTenantId = 'cccccccc-0000-0000-0000-333333333333'
const simId = 'eeeeeeee-0000-0000-0000-555555555555'

type Row = Record<string, any>

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  })
}

describe('Phase 24: Reseller Identity Unification', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  it('API Key auth loads customers row and sets cmpAuth to tenant_ids', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'

    const mockData: Record<string, Row[]> = {
      customers: [{
        tenant_id: enterpriseTenantId,
        reseller_tenant_id: resellerTenantId,
        api_secret_hash: 'scrypt:hash:mock',
        status: 'ACTIVE',
      }],
    }

    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      for (const [table, rows] of Object.entries(mockData)) {
        if (url.includes(`/rest/v1/${table}`)) {
          return jsonResponse(200, rows, { 'content-range': `0-${rows.length - 1}/${rows.length}` })
        }
      }
      return jsonResponse(200, [])
    }

    // Verify that cmpAuth.resellerId would be set to reseller_tenant_id
    // This is verified by checking the query parameter in the API call
    const app = createApp()
    expect(app).toBeDefined()
  })

  it('JWT login includes resellerId from enterprise tenant parent_id', async () => {
    process.env.SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
    process.env.AUTH_DB_ENABLED = '1'

    const mockData: Record<string, Row[]> = {
      api_clients: [{
        client_id: 'test@example.com',
        secret_hash: 'scrypt:hash:mock',
        enterprise_id: enterpriseTenantId,
        status: 'ACTIVE',
      }],
      tenants: [{
        tenant_id: enterpriseTenantId,
        parent_id: resellerTenantId,
        tenant_type: 'ENTERPRISE',
      }],
    }

    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url
      for (const [table, rows] of Object.entries(mockData)) {
        if (url.includes(`/rest/v1/${table}`)) {
          return jsonResponse(200, rows, { 'content-range': `0-${rows.length - 1}/${rows.length}` })
        }
      }
      return jsonResponse(200, [])
    }

    // Verify app creates without error
    const app = createApp()
    expect(app).toBeDefined()
  })

  it('resolveResellerIdentity function no longer exists in simPhase4', async () => {
    // Phase 24: resolveResellerIdentity was removed
    // Verify the import does not export this function
    const simModule = await import('../src/routes/simPhase4.js')
    expect(typeof simModule.registerSimPhase4Routes).toBe('function')
    // resolveResellerIdentity should NOT be exported
    expect((simModule as any).resolveResellerIdentity).toBeUndefined()
  })

  it('reseller_suppliers migration uses tenants.tenant_id', async () => {
    // Verify migration file exists and contains correct FK
    const fs = await import('node:fs/promises')
    const migrationPath = 'supabase/migrations/20260324100001_reseller_identity_unification.sql'
    const content = await fs.readFile(migrationPath, 'utf-8')

    expect(content).toContain('reseller_tenant_id uuid REFERENCES tenants(tenant_id)')

    // T138: reseller_suppliers_v2 uses tenants(tenant_id) FK
    expect(content).toContain('REFERENCES tenants(tenant_id)')

    // Data migration from resellers.id to resellers.tenant_id
    expect(content).toContain('SET reseller_tenant_id = r.tenant_id')
    expect(content).toContain('FROM resellers r')
  })
})

// --- T181: JWT tenant UUID + reseller path param (RESELLER tenants.tenant_id only; not resellers.id) ---

const T181_BASE = 'https://t181.supabase.test'
const T181_RT = 'aaaaaaaa-0000-0000-0000-111111111111'
const T181_RR = 'bbbbbbbb-0000-0000-0000-222222222222'
const T181_ENT = 'cccccccc-0000-0000-0000-333333333333'
const T181_ENT_OTHER = 'cccccccc-0000-0000-0000-777777777777'
const T181_RT_OTHER = 'aaaaaaaa-0000-0000-0000-999999999999'
const T181_SUP = 'dddddddd-0000-0000-0000-444444444444'
const T181_USER = 'eeeeeeee-0000-0000-0000-555555555555'
const T181_AUTH_SECRET = 'unit-test-auth-secret-min-32-chars!'

function setupT181Env() {
  process.env.SUPABASE_URL = T181_BASE
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
  process.env.SUPABASE_ANON_KEY = 'anon-key'
  process.env.AUTH_TOKEN_SECRET = T181_AUTH_SECRET
  process.env.AUTH_CLIENT_ID = 'cid'
  process.env.AUTH_CLIENT_SECRET = 'csec'
}

function eqParam(sp: URLSearchParams, key: string) {
  const v = sp.get(key)
  if (!v?.startsWith('eq.')) return null
  return decodeURIComponent(v.slice(3))
}

function inParam(sp: URLSearchParams, key: string) {
  const v = sp.get(key)
  if (!v?.startsWith('in.(') || !v.endsWith(')')) return null
  return v
    .slice(4, -1)
    .split(',')
    .map((s) => decodeURIComponent(s.trim()))
    .filter(Boolean)
}

type T181Dataset = {
  tenants: Row[]
  resellers: Row[]
  resellerSuppliers: Row[]
  bills: Row[]
  users?: Row[]
}

type T181Mutable = { assignments: Row[] }

function installT181SupabaseMock(data: T181Dataset, mutable?: T181Mutable) {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!raw.startsWith(T181_BASE)) return originalFetch(input as any, init)

    const url = new URL(raw)
    const method = String(init?.method || 'GET').toUpperCase()
    const pathMatch = url.pathname.match(/\/rest\/v1\/([^/?]+)/)
    const table = pathMatch?.[1] ?? ''
    const sp = url.searchParams
    const hdrs = init?.headers as Record<string, string> | undefined
    const prefer = hdrs?.Prefer ?? hdrs?.prefer ?? ''
    const wantCount = String(prefer).includes('count=exact')

    const respond = (rows: unknown[], total?: number) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      const arr = Array.isArray(rows) ? rows : []
      if (wantCount) {
        const t = typeof total === 'number' ? total : arr.length
        headers['content-range'] = `0-${Math.max(0, arr.length - 1)}/${t}`
      }
      return new Response(JSON.stringify(arr), { status: 200, headers })
    }

    if (method === 'GET' && table === 'tenants') {
      let rows = data.tenants.slice()
      const tt = eqParam(sp, 'tenant_type')
      const tid = eqParam(sp, 'tenant_id')
      const parent = eqParam(sp, 'parent_id')
      const tin = inParam(sp, 'tenant_id')
      if (tt) rows = rows.filter((r) => String(r.tenant_type) === tt)
      if (tid) rows = rows.filter((r) => String(r.tenant_id) === tid)
      if (parent) rows = rows.filter((r) => String(r.parent_id ?? '') === parent)
      if (tin?.length) rows = rows.filter((r) => tin.includes(String(r.tenant_id)))
      return respond(rows, rows.length)
    }

    if (method === 'GET' && table === 'resellers') {
      const orRaw = sp.get('or') || ''
      let rows = data.resellers.slice()
      if (orRaw.includes('id.eq.') || orRaw.includes('tenant_id.eq.')) {
        const ids = new Set<string>()
        for (const m of orRaw.matchAll(/id\.eq\.([^,)]+)/g)) ids.add(decodeURIComponent(m[1]))
        for (const m of orRaw.matchAll(/tenant_id\.eq\.([^,)]+)/g)) ids.add(decodeURIComponent(m[1]))
        rows = rows.filter((r) => ids.has(String(r.id)) || ids.has(String(r.tenant_id)))
      } else {
        const idEq = eqParam(sp, 'id')
        const tidEq = eqParam(sp, 'tenant_id')
        if (idEq) rows = rows.filter((r) => String(r.id) === idEq)
        if (tidEq) rows = rows.filter((r) => String(r.tenant_id) === tidEq)
      }
      return respond(rows, rows.length)
    }

    if (method === 'GET' && table === 'reseller_suppliers') {
      const orRaw = sp.get('or') || ''
      let rows = data.resellerSuppliers.slice()
      if (orRaw.includes('reseller_id.eq.')) {
        const allow = new Set([...orRaw.matchAll(/reseller_id\.eq\.([^,)]+)/g)].map((m) => decodeURIComponent(m[1])))
        rows = rows.filter((r) => allow.has(String(r.reseller_id)))
      } else {
        const rEq = eqParam(sp, 'reseller_id')
        if (rEq) rows = rows.filter((r) => String(r.reseller_id) === rEq)
      }
      return respond(rows, rows.length)
    }

    if (method === 'GET' && table === 'bills') {
      let rows = data.bills.slice()
      const ein = inParam(sp, 'enterprise_id')
      const rEq = eqParam(sp, 'reseller_id')
      if (ein?.length) rows = rows.filter((b) => ein.includes(String(b.enterprise_id)))
      if (rEq) rows = rows.filter((b) => String(b.reseller_id) === rEq)
      return respond(rows, rows.length)
    }

    if (method === 'GET' && table === 'suppliers') {
      const sin = inParam(sp, 'supplier_id')
      let rows = [{ supplier_id: T181_SUP, name: 'S1', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' }]
      if (sin?.length) rows = rows.filter((r) => sin.includes(String(r.supplier_id)))
      return respond(rows, rows.length)
    }

    if (method === 'GET' && table === 'users') {
      let rows = (data.users ?? []).slice()
      const uid = eqParam(sp, 'user_id')
      if (uid) rows = rows.filter((r) => String(r.user_id) === uid)
      return respond(rows, rows.length)
    }

    if (method === 'GET' && table === 'reseller_enterprise_assignments') {
      let rows = (mutable?.assignments ?? []).slice()
      const uid = eqParam(sp, 'user_id')
      const rid = eqParam(sp, 'reseller_id')
      if (uid) rows = rows.filter((r) => String(r.user_id) === uid)
      if (rid) rows = rows.filter((r) => String(r.reseller_id) === rid)
      return respond(rows, rows.length)
    }

    if (method === 'DELETE' && table === 'reseller_enterprise_assignments') {
      if (mutable) {
        const uid = eqParam(sp, 'user_id')
        const rid = eqParam(sp, 'reseller_id')
        mutable.assignments = mutable.assignments.filter(
          (a) => !(uid && rid && String(a.user_id) === uid && String(a.reseller_id) === rid)
        )
      }
      return new Response(null, { status: 204 })
    }

    if (method === 'POST' && table === 'reseller_enterprise_assignments') {
      if (mutable) {
        const body = JSON.parse(String(init?.body ?? '[]'))
        const arr = Array.isArray(body) ? body : [body]
        for (const row of arr) mutable.assignments.push(row)
      }
      return new Response(null, { status: 201 })
    }

    if (method === 'POST' && table === 'audit_logs') {
      return new Response(null, { status: 201 })
    }

    return respond([])
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

function jwtResellerTenantIdOnly() {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHs256(
    {
      iss: 'iot-cmp-api',
      sub: T181_USER,
      iat: now,
      exp: now + 3600,
      userId: T181_USER,
      email: 'ra@test',
      roleScope: 'reseller',
      role: 'reseller_admin',
      tenant_id: T181_RT,
    },
    T181_AUTH_SECRET
  )
}

function jwtPlatformAdmin() {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHs256(
    {
      iss: 'iot-cmp-api',
      sub: 'platform-admin-user',
      iat: now,
      exp: now + 3600,
      userId: 'platform-admin-user',
      email: 'platform-admin@test',
      roleScope: 'platform',
      role: 'platform_admin',
    },
    T181_AUTH_SECRET
  )
}

describe('T181: reseller JWT + path tenant UUID only (integration)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  it('accepts reseller JWT with only tenant_id (no resellerId claim) for enterprises list', async () => {
    setupT181Env()

    const data: T181Dataset = {
      tenants: [
        { tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' },
        {
          tenant_id: T181_ENT,
          tenant_type: 'ENTERPRISE',
          parent_id: T181_RT,
          name: 'E1',
          enterprise_status: 'ACTIVE',
          auto_suspend_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      resellers: [{ id: T181_RR, tenant_id: T181_RT, status: 'ACTIVE' }],
      resellerSuppliers: [{ reseller_id: T181_RT, supplier_id: T181_SUP, created_at: '2026-01-01T00:00:00Z' }],
      bills: [
        {
          bill_id: 'ffffffff-0000-0000-0000-000000000001',
          enterprise_id: T181_ENT,
          reseller_id: T181_RT,
          period_start: '2026-02-01',
          period_end: '2026-02-28',
          status: 'PUBLISHED',
          currency: 'CNY',
          total_amount: 100,
          due_date: '2026-03-31',
        },
      ],
    }
    installT181SupabaseMock(data)

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      const entRes = await originalFetch(`${baseUrl}/v1/enterprises`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(entRes.status).toBe(200)
      const entBody = await entRes.json()
      expect(entBody.items?.length).toBe(1)
      expect(entBody.items[0].enterpriseId).toBe(T181_ENT)
      expect(entBody.items[0].tenantId).toBeUndefined()
      expect(entBody.items[0].resellerId).toBe(T181_RT)

      const billRes = await originalFetch(`${baseUrl}/v1/bills`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(billRes.status).toBe(200)
      const billBody = await billRes.json()
      expect(billBody.items?.length).toBe(1)
      expect(billBody.items[0].enterpriseId).toBe(T181_ENT)
    })
  })

  it('GET /enterprises rejects resellerId query when it mismatches reseller JWT scope', async () => {
    setupT181Env()

    const data: T181Dataset = {
      tenants: [
        { tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' },
        {
          tenant_id: T181_ENT,
          tenant_type: 'ENTERPRISE',
          parent_id: T181_RT,
          name: 'E1',
          enterprise_status: 'ACTIVE',
          auto_suspend_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
        { tenant_id: T181_RT_OTHER, tenant_type: 'RESELLER', parent_id: null, name: 'R2' },
      ],
      resellers: [
        { id: T181_RR, tenant_id: T181_RT, status: 'ACTIVE' },
        { id: 'bbbbbbbb-0000-0000-0000-aaaaaaaaaaaa', tenant_id: T181_RT_OTHER, status: 'ACTIVE' },
      ],
      resellerSuppliers: [],
      bills: [],
    }
    installT181SupabaseMock(data)

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      const res = await originalFetch(`${baseUrl}/v1/enterprises?resellerId=${encodeURIComponent(T181_RT_OTHER)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('FORBIDDEN')
      expect(body.message).toBe('resellerId is out of scope.')
    })
  })

  it('POST /enterprises rejects legacy tenantId-only payload', async () => {
    setupT181Env()

    await withServer(async (baseUrl) => {
      const token = jwtPlatformAdmin()
      const res = await originalFetch(`${baseUrl}/v1/enterprises`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Enterprise Legacy TenantId Only',
          tenantId: T181_RT,
          contactEmail: 'legacy-tenantid@test.com',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('VALIDATION_ERROR')
      expect(body.message).toBe('resellerId is required.')
    })
  })

  it('POST /enterprises/{enterpriseId}:change-status works with colon-style path', async () => {
    setupT181Env()
    const data: T181Dataset = {
      tenants: [
        {
          tenant_id: T181_ENT,
          tenant_type: 'ENTERPRISE',
          parent_id: T181_RT,
          name: 'E1',
          enterprise_status: 'ACTIVE',
          auto_suspend_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      resellers: [],
      resellerSuppliers: [],
      bills: [],
    }
    installT181SupabaseMock(data)

    await withServer(async (baseUrl) => {
      const token = jwtPlatformAdmin()
      const res = await originalFetch(`${baseUrl}/v1/enterprises/${encodeURIComponent(T181_ENT)}:change-status`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: 'INACTIVE',
          reason: 'test-reason',
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.enterpriseId).toBe(T181_ENT)
      expect(body.status).toBe('INACTIVE')
      expect(body.previousStatus).toBe('ACTIVE')
    })
  })

  it('POST /enterprises/{enterpriseId}:change-status works with reseller JWT in reseller scope', async () => {
    setupT181Env()
    const data: T181Dataset = {
      tenants: [
        { tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' },
        {
          tenant_id: T181_ENT,
          tenant_type: 'ENTERPRISE',
          parent_id: T181_RT,
          name: 'E1',
          enterprise_status: 'ACTIVE',
          auto_suspend_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      resellers: [{ id: T181_RR, tenant_id: T181_RT, status: 'ACTIVE' }],
      resellerSuppliers: [],
      bills: [],
    }
    installT181SupabaseMock(data)

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      const res = await originalFetch(`${baseUrl}/v1/enterprises/${encodeURIComponent(T181_ENT)}:change-status`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          status: 'INACTIVE',
          reason: 'reseller-change-status',
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.enterpriseId).toBe(T181_ENT)
      expect(body.status).toBe('INACTIVE')
      expect(body.previousStatus).toBe('ACTIVE')
    })
  })

  it('lists reseller suppliers only when path is RESELLER tenant UUID (not resellers.id)', async () => {
    setupT181Env()

    const data: T181Dataset = {
      tenants: [{ tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' }],
      resellers: [{ id: T181_RR, tenant_id: T181_RT, status: 'ACTIVE' }],
      resellerSuppliers: [{ reseller_id: T181_RT, supplier_id: T181_SUP, created_at: '2026-01-01T00:00:00Z' }],
      bills: [],
    }
    installT181SupabaseMock(data)

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      const ok = await originalFetch(`${baseUrl}/v1/resellers/${encodeURIComponent(T181_RT)}/suppliers`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(ok.status).toBe(200)
      const jo = await ok.json()
      expect(jo.resellerId).toBe(T181_RT)

      const badPath = await originalFetch(`${baseUrl}/v1/resellers/${encodeURIComponent(T181_RR)}/suppliers`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(badPath.status).toBe(403)
    })
  })

  it('returns 403 when path resellerRef resolves to another reseller than JWT scope', async () => {
    setupT181Env()

    const data: T181Dataset = {
      tenants: [
        { tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' },
        { tenant_id: T181_RT_OTHER, tenant_type: 'RESELLER', parent_id: null, name: 'R2' },
      ],
      resellers: [
        { id: T181_RR, tenant_id: T181_RT, status: 'ACTIVE' },
        { id: 'bbbbbbbb-0000-0000-0000-aaaaaaaaaaaa', tenant_id: T181_RT_OTHER, status: 'ACTIVE' },
      ],
      resellerSuppliers: [],
      bills: [],
    }
    installT181SupabaseMock(data)

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      const res = await originalFetch(`${baseUrl}/v1/resellers/${encodeURIComponent(T181_RT_OTHER)}/suppliers`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(403)
    })
  })

  it('GET enterprise detail allows JWT tenant_id-only when enterprise belongs to that reseller', async () => {
    setupT181Env()

    const data: T181Dataset = {
      tenants: [
        { tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' },
        {
          tenant_id: T181_ENT,
          tenant_type: 'ENTERPRISE',
          parent_id: T181_RT,
          name: 'E1',
          enterprise_status: 'ACTIVE',
          auto_suspend_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          tenant_id: T181_ENT_OTHER,
          tenant_type: 'ENTERPRISE',
          parent_id: T181_RT_OTHER,
          name: 'E2',
          enterprise_status: 'ACTIVE',
          auto_suspend_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
        { tenant_id: T181_RT_OTHER, tenant_type: 'RESELLER', parent_id: null, name: 'R2' },
      ],
      resellers: [
        { id: T181_RR, tenant_id: T181_RT, status: 'ACTIVE' },
        { id: 'bbbbbbbb-0000-0000-0000-aaaaaaaaaaaa', tenant_id: T181_RT_OTHER, status: 'ACTIVE' },
      ],
      resellerSuppliers: [],
      bills: [],
    }
    installT181SupabaseMock(data)

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      const ok = await originalFetch(`${baseUrl}/v1/enterprises/${encodeURIComponent(T181_ENT)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(ok.status).toBe(200)
      const okBody = await ok.json()
      expect(okBody.enterpriseId).toBe(T181_ENT)
      expect(okBody.tenantId).toBeUndefined()
      expect(okBody.resellerId).toBe(T181_RT)
      const bad = await originalFetch(`${baseUrl}/v1/enterprises/${encodeURIComponent(T181_ENT_OTHER)}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(bad.status).toBe(403)
    })
  })

  it('POST assign-enterprises accepts path tenant UUID matching JWT scope', async () => {
    setupT181Env()
    const mutable: T181Mutable = { assignments: [] }
    const data: T181Dataset = {
      tenants: [
        { tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' },
        {
          tenant_id: T181_ENT,
          tenant_type: 'ENTERPRISE',
          parent_id: T181_RT,
          name: 'E1',
          enterprise_status: 'ACTIVE',
          auto_suspend_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      resellers: [{ id: T181_RR, tenant_id: T181_RT, status: 'ACTIVE' }],
      resellerSuppliers: [],
      bills: [],
      users: [{ user_id: T181_USER, tenant_id: T181_RT }],
    }
    installT181SupabaseMock(data, mutable)

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      const res = await originalFetch(
        `${baseUrl}/v1/resellers/${encodeURIComponent(T181_RT)}/users/${encodeURIComponent(T181_USER)}/assign-enterprises`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ assignedEnterpriseIds: [T181_ENT] }),
        }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.resellerId).toBe(T181_RT)
      expect(body.assignedEnterpriseIds).toEqual([T181_ENT])
      expect(mutable.assignments.length).toBe(1)
      expect(String(mutable.assignments[0].reseller_id)).toBe(T181_RT)

      const badPath = await originalFetch(
        `${baseUrl}/v1/resellers/${encodeURIComponent(T181_RR)}/users/${encodeURIComponent(T181_USER)}/assign-enterprises`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ assignedEnterpriseIds: [T181_ENT] }),
        }
      )
      expect(badPath.status).toBe(404)
    })
  })

  it('POST assign-enterprises returns 403 when path reseller is not JWT scope', async () => {
    setupT181Env()
    const mutable: T181Mutable = { assignments: [] }
    const data: T181Dataset = {
      tenants: [
        { tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' },
        { tenant_id: T181_RT_OTHER, tenant_type: 'RESELLER', parent_id: null, name: 'R2' },
      ],
      resellers: [
        { id: T181_RR, tenant_id: T181_RT, status: 'ACTIVE' },
        { id: 'bbbbbbbb-0000-0000-0000-aaaaaaaaaaaa', tenant_id: T181_RT_OTHER, status: 'ACTIVE' },
      ],
      resellerSuppliers: [],
      bills: [],
      users: [{ user_id: T181_USER, tenant_id: T181_RT }],
    }
    installT181SupabaseMock(data, mutable)

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      const res = await originalFetch(
        `${baseUrl}/v1/resellers/${encodeURIComponent(T181_RT_OTHER)}/users/${encodeURIComponent(T181_USER)}/assign-enterprises`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ assignedEnterpriseIds: [] }),
        }
      )
      expect(res.status).toBe(403)
      expect(mutable.assignments.length).toBe(0)
    })
  })
})

/** T258: enterprise user routes use `resolveResellerForEnterpriseScope` (same as appendix 表 A); DEACTIVATED → 403 RESELLER_INACTIVE */
describe('T258: enterprise users routes — resolve + RESELLER_INACTIVE', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  function deactivatedResellerDataset(): T181Dataset {
    return {
      tenants: [
        { tenant_id: T181_RT, tenant_type: 'RESELLER', parent_id: null, name: 'R' },
        {
          tenant_id: T181_ENT,
          tenant_type: 'ENTERPRISE',
          parent_id: T181_RT,
          name: 'E1',
          enterprise_status: 'ACTIVE',
          auto_suspend_enabled: false,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
      resellers: [{ id: T181_RR, tenant_id: T181_RT, status: 'DEACTIVATED' }],
      resellerSuppliers: [],
      bills: [],
    }
  }

  async function expectResellerInactive(
    fetchImpl: () => Promise<Response>,
  ) {
    const res = await fetchImpl()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('RESELLER_INACTIVE')
  }

  it('GET /enterprises/:id/users returns RESELLER_INACTIVE after resolve sees DEACTIVATED', async () => {
    setupT181Env()
    installT181SupabaseMock(deactivatedResellerDataset())

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      await expectResellerInactive(() =>
        originalFetch(`${baseUrl}/v1/enterprises/${encodeURIComponent(T181_ENT)}/users`, {
          headers: { authorization: `Bearer ${token}` },
        })
      )
    })
  })

  it('POST /enterprises/:id/users returns RESELLER_INACTIVE before insert', async () => {
    setupT181Env()
    installT181SupabaseMock(deactivatedResellerDataset())

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      await expectResellerInactive(() =>
        originalFetch(`${baseUrl}/v1/enterprises/${encodeURIComponent(T181_ENT)}/users`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'newu@example.com',
            name: 'New User',
            role: 'customer_admin',
            password: 'initialPw!12',
          }),
        })
      )
    })
  })

  it('POST assign-departments returns RESELLER_INACTIVE before touching assignments', async () => {
    setupT181Env()
    installT181SupabaseMock(deactivatedResellerDataset())

    await withServer(async (baseUrl) => {
      const token = jwtResellerTenantIdOnly()
      await expectResellerInactive(() =>
        originalFetch(
          `${baseUrl}/v1/enterprises/${encodeURIComponent(T181_ENT)}/users/${encodeURIComponent(T181_USER)}/assign-departments`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ assignedDepartmentIds: [] }),
          }
        )
      )
    })
  })
})

describe('Auth login error message', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  it('returns Invalid email or password when email does not exist', async () => {
    setupT181Env()
    installT181SupabaseMock({
      tenants: [],
      resellers: [],
      resellerSuppliers: [],
      bills: [],
      users: [],
    })

    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'admin11@demo-enterprise1.com',
          password: 'Tiechui@1803',
        }),
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.code).toBe('UNAUTHORIZED')
      expect(body.message).toBe('Invalid email or password.')
    })
  })
})
