import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

const resellerId = '84380d9b-b197-447e-ad58-b3c87ddb1b77'
const supplierId = '61ea0260-7146-428c-9838-3628ee73c300'
const operatorId = 'd1a5af0d-2188-4574-9d51-5602883990e7'
const supplierOperatorLinkId = '0525828f-89bf-41e6-9bd9-5374e75352f1'
const enterpriseId = '8f49253c-fce4-44de-9a2a-e62550b856a2'

type Row = Record<string, any>

type DataSet = {
  sims: Row[]
  operators: Row[]
  businessOperators: Row[]
  resellerSuppliers: Row[]
  tenants: Row[]
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(headers ?? {}),
    },
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

function applySimsFilters(rows: Row[], params: URLSearchParams) {
  let current = rows.slice()
  const enterpriseEq = eqValue(params.get('enterprise_id'))
  const supplierEq = eqValue(params.get('supplier_id'))
  const operatorEq = eqValue(params.get('operator_id'))
  if (enterpriseEq) current = current.filter((r) => String(r.enterprise_id ?? '') === enterpriseEq)
  if (supplierEq) current = current.filter((r) => String(r.supplier_id ?? '') === supplierEq)
  if (operatorEq) current = current.filter((r) => String(r.operator_id ?? '') === operatorEq)

  const orRaw = params.get('or')
  if (orRaw?.startsWith('(') && orRaw.endsWith(')')) {
    const text = orRaw.slice(1, -1)
    const enterpriseInMatch = text.match(/enterprise_id(?:=|\.)in\.\(([^)]*)\)/)
    const supplierInMatch = text.match(/supplier_id(?:=|\.)in\.\(([^)]*)\)/)
    const operatorEqMatch = text.match(/(?:^|,)operator_id\.eq\.([^,\)]+)(?:,|\)|$)/)
    const enterpriseIds = enterpriseInMatch ? enterpriseInMatch[1].split(',').filter(Boolean).map(decodeURIComponent) : []
    const supplierIds = supplierInMatch ? supplierInMatch[1].split(',').filter(Boolean).map(decodeURIComponent) : []
    const orOperatorId = operatorEqMatch?.[1] ? decodeURIComponent(operatorEqMatch[1]) : null
    current = current.filter((row) => {
      const hitEnterprise = enterpriseIds.length ? enterpriseIds.includes(String(row.enterprise_id ?? '')) : false
      const hitSupplier = supplierIds.length ? supplierIds.includes(String(row.supplier_id ?? '')) : false
      const hitOperator = orOperatorId ? String(row.operator_id ?? '') === orOperatorId : false
      return hitEnterprise || hitSupplier || hitOperator
    })
  }

  return current
}

function installSupabaseMock(data: DataSet) {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!raw.startsWith('https://example.supabase.co/')) return originalFetch(input as any, init)
    const url = new URL(raw)
    const method = String(init?.method || 'GET').toUpperCase()
    const table = url.pathname.startsWith('/rest/v1/') ? url.pathname.slice('/rest/v1/'.length) : ''
    if (!table) return jsonResponse(404, { code: 'NOT_FOUND' })

    if (method === 'GET' && table === 'sims') {
      const select = url.searchParams.get('select') ?? ''
      if (select.includes('reseller_id') && select.trim() === 'reseller_id') {
        return jsonResponse(400, { message: 'column sims.reseller_id does not exist' })
      }
      let rows = applySimsFilters(data.sims, url.searchParams)
      rows = rows.sort((a, b) => String(a.iccid ?? '').localeCompare(String(b.iccid ?? '')))
      const limit = Number(url.searchParams.get('limit') ?? '0')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      const sliced = rows.slice(offset, limit > 0 ? offset + limit : undefined)
      return jsonResponse(200, sliced, { 'content-range': `${offset}-${Math.max(offset, offset + sliced.length - 1)}/${rows.length}` })
    }

    if (method === 'GET' && table === 'tenants') {
      const tenantType = eqValue(url.searchParams.get('tenant_type'))
      const parentId = eqValue(url.searchParams.get('parent_id'))
      const tenantIds = inValues(url.searchParams.get('tenant_id'))
      let rows = data.tenants.slice()
      if (tenantType) rows = rows.filter((r) => String(r.tenant_type ?? '') === tenantType)
      if (parentId) rows = rows.filter((r) => String(r.parent_id ?? '') === parentId)
      if (tenantIds.length) rows = rows.filter((r) => tenantIds.includes(String(r.tenant_id ?? '')))
      return jsonResponse(200, rows)
    }

    if (method === 'GET' && table === 'reseller_suppliers') {
      const resellerEq = eqValue(url.searchParams.get('reseller_id'))
      const supplierIds = inValues(url.searchParams.get('supplier_id'))
      let rows = data.resellerSuppliers.slice()
      if (resellerEq) rows = rows.filter((r) => String(r.reseller_id) === resellerEq)
      if (supplierIds.length) rows = rows.filter((r) => supplierIds.includes(String(r.supplier_id)))
      return jsonResponse(200, rows)
    }

    if (method === 'GET' && table === 'operators') {
      const supplierEq = eqValue(url.searchParams.get('supplier_id'))
      const operatorEq = eqValue(url.searchParams.get('operator_id'))
      const operatorIn = inValues(url.searchParams.get('operator_id'))
      let rows = data.operators.slice()
      if (supplierEq) rows = rows.filter((r) => String(r.supplier_id) === supplierEq)
      if (operatorEq) rows = rows.filter((r) => String(r.operator_id) === operatorEq || String(r.business_operator_id) === operatorEq)
      if (operatorIn.length) rows = rows.filter((r) => operatorIn.includes(String(r.operator_id)))
      return jsonResponse(200, rows)
    }

    if (method === 'GET' && table === 'business_operators') {
      const ids = inValues(url.searchParams.get('operator_id'))
      const idEq = eqValue(url.searchParams.get('operator_id'))
      let rows = data.businessOperators.slice()
      if (idEq) rows = rows.filter((r) => String(r.operator_id) === idEq)
      if (ids.length) rows = rows.filter((r) => ids.includes(String(r.operator_id)))
      return jsonResponse(200, rows)
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

describe('sims reseller fallback without sims.reseller_id column', () => {
  it('returns resellerId and supports resellerId filter for list and csv', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    const data: DataSet = {
      sims: [
        {
          sim_id: 'sim-1',
          iccid: '8986000000000000001',
          primary_imsi: 'imsi-1',
          msisdn: '10001',
          status: 'INVENTORY',
          apn: 'iot',
          supplier_id: supplierId,
          operator_id: supplierOperatorLinkId,
          enterprise_id: null,
          department_id: null,
          form_factor: null,
          upstream_status: null,
          upstream_status_updated_at: null,
          activation_date: null,
          bound_imei: null,
          activation_code: null,
          suppliers: { name: 'S1' },
          operators: { name: 'O1' },
        },
      ],
      operators: [{ operator_id: supplierOperatorLinkId, business_operator_id: operatorId, supplier_id: supplierId }],
      businessOperators: [{ operator_id: operatorId, name: 'Operator One', mcc: '460', mnc: '00' }],
      resellerSuppliers: [{ reseller_id: resellerId, supplier_id: supplierId }],
      tenants: [
        { tenant_id: resellerId, name: 'R1', tenant_type: 'RESELLER', parent_id: null },
        { tenant_id: enterpriseId, name: 'E1', tenant_type: 'ENTERPRISE', parent_id: resellerId },
      ],
    }
    installSupabaseMock(data)

    await withServer(async (baseUrl) => {
      const listBySupplier = await originalFetch(`${baseUrl}/v1/sims?supplierId=${encodeURIComponent(supplierId)}`, {
        headers: { 'x-api-key': 'test-admin-key' },
      })
      expect(listBySupplier.status).toBe(200)
      const supplierBody = await listBySupplier.json()
      expect(Array.isArray(supplierBody.items)).toBe(true)
      expect(supplierBody.items[0]?.resellerId).toBe(resellerId)
      expect(supplierBody.items[0]?.operatorId).toBe(operatorId)

      const listByReseller = await originalFetch(`${baseUrl}/v1/sims?resellerId=${encodeURIComponent(resellerId)}`, {
        headers: { 'x-api-key': 'test-admin-key' },
      })
      expect(listByReseller.status).toBe(200)
      const resellerBody = await listByReseller.json()
      expect(resellerBody.total).toBeGreaterThan(0)
      expect(resellerBody.items[0]?.resellerId).toBe(resellerId)

      const csvByReseller = await originalFetch(`${baseUrl}/v1/sims:csv?resellerId=${encodeURIComponent(resellerId)}`, {
        headers: { 'x-api-key': 'test-admin-key' },
      })
      expect(csvByReseller.status).toBe(200)
      const csvText = await csvByReseller.text()
      expect(csvText).toContain(resellerId)
      expect(csvText).toContain('8986000000000000001')
    })
  })
})
