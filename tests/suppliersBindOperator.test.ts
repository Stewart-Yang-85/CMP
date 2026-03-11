import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

const supplierId = '11111111-1111-1111-1111-111111111111'
const businessOperatorId = '22222222-2222-2222-2222-222222222222'

type DataSet = {
  suppliers: Array<Record<string, any>>
  businessOperators: Array<Record<string, any>>
  operators: Array<Record<string, any>>
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function eqValue(raw: string | null) {
  if (!raw) return null
  if (!raw.startsWith('eq.')) return null
  return decodeURIComponent(raw.slice(3))
}

function inValues(raw: string | null) {
  if (!raw) return []
  if (!raw.startsWith('in.(') || !raw.endsWith(')')) return []
  const content = raw.slice(4, -1)
  if (!content) return []
  return content.split(',').map((item) => decodeURIComponent(item))
}

function orOperatorValue(raw: string | null) {
  if (!raw) return null
  const match = raw.match(/(?:^|,)business_operator_id\.eq\.([^,\)]+)(?:,|\)|$)/)
  if (match?.[1]) return decodeURIComponent(match[1])
  const match2 = raw.match(/(?:^|,)operator_id\.eq\.([^,\)]+)(?:,|\)|$)/)
  if (match2?.[1]) return decodeURIComponent(match2[1])
  return null
}

function installSupabaseMock(data: DataSet) {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!raw.startsWith('https://example.supabase.co/')) {
      return originalFetch(input as any, init)
    }
    const url = new URL(raw)
    const method = String(init?.method || 'GET').toUpperCase()
    const isRest = url.pathname.startsWith('/rest/v1/')
    if (!isRest) return jsonResponse(404, { code: 'NOT_FOUND' })
    const table = url.pathname.slice('/rest/v1/'.length)

    if (method === 'GET' && table === 'suppliers') {
      const id = eqValue(url.searchParams.get('supplier_id'))
      const rows = id ? data.suppliers.filter((row) => String(row.supplier_id) === id) : data.suppliers
      return jsonResponse(200, rows)
    }

    if (method === 'GET' && table === 'business_operators') {
      const id = eqValue(url.searchParams.get('operator_id'))
      const ids = inValues(url.searchParams.get('operator_id'))
      const rows = id
        ? data.businessOperators.filter((row) => String(row.operator_id) === id)
        : ids.length
          ? data.businessOperators.filter((row) => ids.includes(String(row.operator_id)))
          : data.businessOperators
      return jsonResponse(200, rows)
    }

    if (method === 'GET' && table === 'operators') {
      const supplier = eqValue(url.searchParams.get('supplier_id'))
      const operator = eqValue(url.searchParams.get('operator_id'))
      const businessOperator = eqValue(url.searchParams.get('business_operator_id'))
      const operatorOr = orOperatorValue(url.searchParams.get('or'))
      const suppliers = inValues(url.searchParams.get('supplier_id'))
      let rows = data.operators
      if (supplier) rows = rows.filter((row) => String(row.supplier_id) === supplier)
      else if (suppliers.length) rows = rows.filter((row) => suppliers.includes(String(row.supplier_id)))
      if (operator) rows = rows.filter((row) => String(row.operator_id) === operator)
      if (businessOperator) rows = rows.filter((row) => String(row.business_operator_id) === businessOperator)
      if (operatorOr) rows = rows.filter((row) => String(row.business_operator_id) === operatorOr || String(row.operator_id) === operatorOr)
      return jsonResponse(200, rows)
    }

    if (method === 'POST' && table === 'operators') {
      const payload = JSON.parse(String(init?.body || '[]'))
      const first = Array.isArray(payload) ? payload[0] : payload
      const row = {
        operator_id: '44444444-4444-4444-4444-444444444444',
        business_operator_id: first.business_operator_id,
        supplier_id: first.supplier_id,
        name: first.name ?? null,
      }
      data.operators.push(row)
      return jsonResponse(201, [row])
    }

    return jsonResponse(200, [])
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

afterEach(() => {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
})

describe('supplier bind operator route', () => {
  it('binds an existing unbound operator to supplier', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const data: DataSet = {
      suppliers: [{ supplier_id: supplierId }],
      businessOperators: [{ operator_id: businessOperatorId, mcc: '460', mnc: '00', name: 'CMCC' }],
      operators: [],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/suppliers/${supplierId}/operators`, {
        method: 'POST',
        headers: {
          'x-api-key': 'test-admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operatorId: businessOperatorId }),
      })
      const body = await response.json()
      expect(response.status).toBe(201)
      expect(body).toMatchObject({
        supplierId,
        operatorId: businessOperatorId,
        supplierOperatorId: '44444444-4444-4444-4444-444444444444',
      })
      expect(data.operators.length).toBe(1)
    })
  })

  it('returns not found when supplier does not exist', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const data: DataSet = {
      suppliers: [],
      businessOperators: [{ operator_id: businessOperatorId, mcc: '460', mnc: '00', name: 'CMCC' }],
      operators: [],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/suppliers/${supplierId}/operators`, {
        method: 'POST',
        headers: {
          'x-api-key': 'test-admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operatorId: businessOperatorId }),
      })
      const body = await response.json()
      expect(response.status).toBe(404)
      expect(body.code).toBe('RESOURCE_NOT_FOUND')
    })
  })

  it('returns not found when operator does not exist', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const data: DataSet = {
      suppliers: [{ supplier_id: supplierId }],
      businessOperators: [],
      operators: [],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/suppliers/${supplierId}/operators`, {
        method: 'POST',
        headers: {
          'x-api-key': 'test-admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operatorId: businessOperatorId }),
      })
      const body = await response.json()
      expect(response.status).toBe(404)
      expect(body.code).toBe('RESOURCE_NOT_FOUND')
    })
  })

  it('returns conflict when operator is already bound', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const data: DataSet = {
      suppliers: [{ supplier_id: supplierId }],
      businessOperators: [{ operator_id: businessOperatorId, mcc: '460', mnc: '00', name: 'CMCC' }],
      operators: [{ operator_id: 'existing-link', business_operator_id: businessOperatorId, supplier_id: supplierId }],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/suppliers/${supplierId}/operators`, {
        method: 'POST',
        headers: {
          'x-api-key': 'test-admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operatorId: businessOperatorId }),
      })
      const body = await response.json()
      expect(response.status).toBe(409)
      expect(body.code).toBe('ALREADY_BOUND')
    })
  })

  it('returns conflict when legacy supplier operator id is already bound', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const data: DataSet = {
      suppliers: [{ supplier_id: supplierId }],
      businessOperators: [{ operator_id: businessOperatorId, mcc: '460', mnc: '00', name: 'CMCC' }],
      operators: [{ operator_id: businessOperatorId, business_operator_id: null, supplier_id: supplierId }],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/suppliers/${supplierId}/operators`, {
        method: 'POST',
        headers: {
          'x-api-key': 'test-admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operatorId: businessOperatorId }),
      })
      const body = await response.json()
      expect(response.status).toBe(409)
      expect(body.code).toBe('ALREADY_BOUND')
    })
  })

  it('returns supplier detail with bound operators', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const data: DataSet = {
      suppliers: [{ supplier_id: supplierId, name: 'Supplier A', status: 'ACTIVE', created_at: '2026-01-01T00:00:00.000Z' }],
      businessOperators: [{ operator_id: businessOperatorId, name: 'China Mobile', mcc: '460', mnc: '00' }],
      operators: [
        {
          operator_id: '44444444-4444-4444-4444-444444444444',
          business_operator_id: businessOperatorId,
          supplier_id: supplierId,
        },
      ],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/suppliers/${supplierId}`, {
        method: 'GET',
        headers: {
          'x-api-key': 'test-admin-key',
        },
      })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.operatorIds).toEqual([businessOperatorId])
      expect(body.operators).toEqual([
        {
          operatorId: businessOperatorId,
          name: 'China Mobile',
          mcc: '460',
          mnc: '00',
        },
      ])
    })
  })

  it('returns supplier list with operators and operatorIds', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const data: DataSet = {
      suppliers: [{ supplier_id: supplierId, name: 'Supplier A', status: 'ACTIVE', created_at: '2026-01-01T00:00:00.000Z' }],
      businessOperators: [{ operator_id: businessOperatorId, name: 'China Mobile', mcc: '460', mnc: '00' }],
      operators: [{ operator_id: '44444444-4444-4444-4444-444444444444', business_operator_id: businessOperatorId, supplier_id: supplierId }],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/suppliers?page=1&pageSize=20`, {
        method: 'GET',
        headers: {
          'x-api-key': 'test-admin-key',
        },
      })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(Array.isArray(body.items)).toBe(true)
      expect(body.items[0]).toMatchObject({
        supplierId,
        operatorIds: [businessOperatorId],
      })
      expect(body.items[0].operators).toEqual([
        {
          operatorId: businessOperatorId,
          name: 'China Mobile',
          mcc: '460',
          mnc: '00',
        },
      ])
    })
  })

  it('returns supplier detail operatorId even when business operator details missing', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    const data: DataSet = {
      suppliers: [{ supplier_id: supplierId, name: 'Supplier A', status: 'ACTIVE', created_at: '2026-01-01T00:00:00.000Z' }],
      businessOperators: [],
      operators: [{ operator_id: '44444444-4444-4444-4444-444444444444', business_operator_id: businessOperatorId, supplier_id: supplierId }],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/suppliers/${supplierId}`, {
        method: 'GET',
        headers: {
          'x-api-key': 'test-admin-key',
        },
      })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.operatorIds).toEqual([businessOperatorId])
      expect(body.operators).toEqual([
        {
          operatorId: businessOperatorId,
          name: null,
          mcc: null,
          mnc: null,
        },
      ])
    })
  })
})
