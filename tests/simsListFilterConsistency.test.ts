import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../dist/app.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

const resellerA = '938ca03b-01c7-4f6a-bff6-9dbee00452a6'
const resellerB = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const enterpriseA = '2f130185-1bc9-4a33-8f1a-7f49312daa0c'
const supplierA = '9551a46c-5238-4323-b1e6-03d5c1d39b18'
const supplierB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const operatorRowA = '48135f8c-63ff-430c-8ed1-a0353edabb74'

type Row = Record<string, unknown>

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  })
}

function eqValue(raw: string | null) {
  if (!raw?.startsWith('eq.')) return null
  return decodeURIComponent(raw.slice(3))
}

function inValues(raw: string | null) {
  if (!raw?.startsWith('in.(') || !raw.endsWith(')')) return []
  const body = raw.slice(4, -1)
  if (!body) return []
  return body.split(',').map((item) => decodeURIComponent(item))
}

function installMock(data: {
  tenants: Row[]
  suppliers: Row[]
  resellerSuppliers: Row[]
  operators: Row[]
  sims?: Row[]
}) {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!raw.startsWith('https://example.supabase.co/')) return originalFetch(input as any, init)
    const url = new URL(raw)
    const method = String(init?.method || 'GET').toUpperCase()
    const table = url.pathname.startsWith('/rest/v1/') ? url.pathname.slice('/rest/v1/'.length) : ''
    if (method !== 'GET' || !table) return jsonResponse(200, [])

    if (table === 'tenants') {
      let rows = data.tenants.slice()
      const tenantType = eqValue(url.searchParams.get('tenant_type'))
      const tenantEq = eqValue(url.searchParams.get('tenant_id'))
      const parentId = eqValue(url.searchParams.get('parent_id'))
      const tenantIn = inValues(url.searchParams.get('tenant_id'))
      if (tenantType) rows = rows.filter((r) => String(r.tenant_type ?? '') === tenantType)
      if (tenantEq) rows = rows.filter((r) => String(r.tenant_id ?? '') === tenantEq)
      if (parentId) rows = rows.filter((r) => String(r.parent_id ?? '') === parentId)
      if (tenantIn.length) rows = rows.filter((r) => tenantIn.includes(String(r.tenant_id ?? '')))
      return jsonResponse(200, rows)
    }
    if (table === 'suppliers') {
      let rows = data.suppliers.slice()
      const idEq = eqValue(url.searchParams.get('supplier_id'))
      if (idEq) rows = rows.filter((r) => String(r.supplier_id ?? '') === idEq)
      return jsonResponse(200, rows)
    }
    if (table === 'reseller_suppliers') {
      let rows = data.resellerSuppliers.slice()
      const resellerEq = eqValue(url.searchParams.get('reseller_id'))
      const supplierEq = eqValue(url.searchParams.get('supplier_id'))
      const supplierIn = inValues(url.searchParams.get('supplier_id'))
      if (resellerEq) rows = rows.filter((r) => String(r.reseller_id) === resellerEq)
      if (supplierEq) rows = rows.filter((r) => String(r.supplier_id) === supplierEq)
      if (supplierIn.length) rows = rows.filter((r) => supplierIn.includes(String(r.supplier_id)))
      return jsonResponse(200, rows)
    }
    if (table === 'operators') {
      let rows = data.operators.slice()
      const supplierEq = eqValue(url.searchParams.get('supplier_id'))
      const operatorEq = eqValue(url.searchParams.get('operator_id'))
      const boEq = eqValue(url.searchParams.get('business_operator_id'))
      const operatorIn = inValues(url.searchParams.get('operator_id'))
      if (supplierEq) rows = rows.filter((r) => String(r.supplier_id) === supplierEq)
      if (operatorEq) rows = rows.filter((r) => String(r.operator_id) === operatorEq)
      if (boEq) rows = rows.filter((r) => String(r.business_operator_id) === boEq)
      if (operatorIn.length) rows = rows.filter((r) => operatorIn.includes(String(r.operator_id)))
      return jsonResponse(200, rows)
    }
    if (table === 'sims') {
      const select = url.searchParams.get('select') ?? ''
      if (select === 'reseller_id' || /^reseller_id(?:&|$)/.test(select)) {
        return jsonResponse(200, [{ reseller_id: null }])
      }
      return jsonResponse(200, data.sims ?? [], { 'content-range': '0-0/0' })
    }
    return jsonResponse(200, [])
  }
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = createApp()
  await app.ready()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr && 'port' in addr ? Number(addr.port) : 0
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await app.close()
  }
}

afterEach(() => {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
})

describe('GET /sims multi-ID filter consistency', () => {
  function setupEnv() {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  }

  const baseData = {
    tenants: [
      { tenant_id: resellerA, name: 'RA', tenant_type: 'RESELLER', parent_id: null },
      { tenant_id: resellerB, name: 'RB', tenant_type: 'RESELLER', parent_id: null },
      { tenant_id: enterpriseA, name: 'EA', tenant_type: 'ENTERPRISE', parent_id: resellerA },
    ],
    suppliers: [
      { supplier_id: supplierA, name: 'SA' },
      { supplier_id: supplierB, name: 'SB' },
    ],
    resellerSuppliers: [{ reseller_id: resellerA, supplier_id: supplierA }],
    operators: [{ operator_id: operatorRowA, business_operator_id: operatorRowA, supplier_id: supplierA }],
    sims: [],
  }

  it('returns 400 when resellerId and enterpriseId do not match', async () => {
    setupEnv()
    installMock(baseData)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(
        `${baseUrl}/v1/sims?enterpriseId=${encodeURIComponent(enterpriseA)}&resellerId=${encodeURIComponent(resellerB)}`,
        { headers: { 'x-api-key': 'test-admin-key' } }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('BAD_REQUEST')
      expect(String(body.message)).toMatch(/resellerId and enterpriseId do not match/i)
    })
  })

  it('returns 400 when supplierId is not bound to resellerId', async () => {
    setupEnv()
    installMock(baseData)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(
        `${baseUrl}/v1/sims?resellerId=${encodeURIComponent(resellerA)}&supplierId=${encodeURIComponent(supplierB)}`,
        { headers: { 'x-api-key': 'test-admin-key' } }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('BAD_REQUEST')
      expect(String(body.message)).toMatch(/supplierId is not bound to resellerId/i)
    })
  })

  it('returns 400 when supplierId and operatorId do not match', async () => {
    setupEnv()
    installMock(baseData)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(
        `${baseUrl}/v1/sims?supplierId=${encodeURIComponent(supplierB)}&operatorId=${encodeURIComponent(operatorRowA)}`,
        { headers: { 'x-api-key': 'test-admin-key' } }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('BAD_REQUEST')
      expect(String(body.message)).toMatch(/supplierId and operatorId do not match/i)
    })
  })

  it('accepts matching resellerId and enterpriseId', async () => {
    setupEnv()
    installMock(baseData)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(
        `${baseUrl}/v1/sims?enterpriseId=${encodeURIComponent(enterpriseA)}&resellerId=${encodeURIComponent(resellerA)}`,
        { headers: { 'x-api-key': 'test-admin-key' } }
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body.items)).toBe(true)
    })
  })
})
