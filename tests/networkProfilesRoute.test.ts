import { describe, expect, it, vi } from 'vitest'
import { registerNetworkProfileRoutes } from '../src/routes/networkProfiles.ts'

const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const otherResellerId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const missingResellerId = 'cccccccc-1111-4111-8111-cccccccccccc'
const supplierId = '4699e98b-4b9c-4949-82fb-b1ecb7a089c1'
const otherSupplierId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const operatorId = '77f02d68-e832-4532-b064-33907f92b09a'
const otherOperatorId = '99999999-8888-4777-8666-555555555555'
const profileId = '11111111-2222-4333-8444-555555555555'

function createMockApp() {
  const routes = new Map<string, (req: any, res: any) => Promise<void>>()
  const register = (method: string, path: string, handler: (req: any, res: any) => Promise<void>) => {
    routes.set(`${method} ${path}`, handler)
  }
  return {
    routes,
    get(path: string, handler: (req: any, res: any) => Promise<void>) {
      register('GET', path, handler)
    },
    post(path: string, handler: (req: any, res: any) => Promise<void>) {
      register('POST', path, handler)
    },
    patch(path: string, handler: (req: any, res: any) => Promise<void>) {
      register('PATCH', path, handler)
    },
    put(path: string, handler: (req: any, res: any) => Promise<void>) {
      register('PUT', path, handler)
    },
  }
}

function createMockRes() {
  const res: {
    body?: unknown
    statusCode?: number
    send: (payload: unknown) => void
    code: (status: number) => typeof res
    header: () => typeof res
  } = {
    send(payload: unknown) {
      res.body = payload
    },
    code(status: number) {
      res.statusCode = status
      return res
    },
    header() {
      return res
    },
  }
  return res
}

function parseEq(queryString: string, field: string): string | null {
  const match = queryString.match(new RegExp(`(?:^|&)${field}=eq\\.([^&]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function registerRoutes(captured: {
  error?: string
  apnQuery?: string
  roamingQuery?: string
  coveredQuery?: string
  multipartFields?: Record<string, unknown>
  multipartFiles?: Record<string, { filename?: string; content: string }>
  inserts?: Array<{ table: string; row: Record<string, unknown> }>
  selectCalls?: Array<{ table: string; queryString: string }>
}) {
  const app = createMockApp()
  const supabase = {
    select: vi.fn(async (table: string, queryString: string) => {
      captured.selectCalls = [...(captured.selectCalls ?? []), { table, queryString }]
      if (table === 'suppliers') {
        if (queryString.includes(`supplier_id=eq.${encodeURIComponent(supplierId)}`)) return [{ supplier_id: supplierId }]
        if (queryString.includes(`supplier_id=eq.${encodeURIComponent(otherSupplierId)}`)) return [{ supplier_id: otherSupplierId }]
        return []
      }
      if (table === 'tenants') {
        const id = parseEq(queryString, 'tenant_id')
        if (id === resellerId) return [{ tenant_id: resellerId, tenant_type: 'RESELLER' }]
        if (id === otherResellerId) return [{ tenant_id: otherResellerId, tenant_type: 'RESELLER' }]
        return []
      }
      if (table === 'reseller_suppliers') {
        const rowResellerId = parseEq(queryString, 'reseller_id')
        const rowSupplierId = parseEq(queryString, 'supplier_id')
        if (rowResellerId === resellerId && !rowSupplierId) {
          return [{ reseller_id: resellerId, supplier_id: supplierId }]
        }
        if (rowResellerId === resellerId && rowSupplierId === supplierId) {
          return [{ reseller_id: resellerId, supplier_id: supplierId }]
        }
        return []
      }
      if (table === 'operators') {
        const rowOperatorId = parseEq(queryString, 'operator_id')
        const rowBusinessOperatorId = parseEq(queryString, 'business_operator_id')
        const rowSupplierId = parseEq(queryString, 'supplier_id')
        const matchesPrimary = rowOperatorId === operatorId || rowBusinessOperatorId === operatorId
        const matchesOther = rowOperatorId === otherOperatorId || rowBusinessOperatorId === otherOperatorId
        if (matchesPrimary && (!rowSupplierId || rowSupplierId === supplierId)) {
          return [{ operator_id: operatorId, business_operator_id: operatorId, supplier_id: supplierId }]
        }
        if (matchesOther && (!rowSupplierId || rowSupplierId === otherSupplierId)) {
          return [{ operator_id: otherOperatorId, business_operator_id: otherOperatorId, supplier_id: otherSupplierId }]
        }
        return []
      }
      if (table === 'sims') return []
      if (table === 'apn_profiles') {
        captured.apnQuery = queryString
        return [
          {
            apn_profile_id: '22222222-2222-4222-8222-222222222222',
            name: 'APN A',
            apn: 'iot',
            auth_type: 'NONE',
            supplier_id: supplierId,
            operator_id: operatorId,
            status: 'DRAFT',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ]
      }
      if (table === 'roaming_profiles') {
        captured.roamingQuery = queryString
        return [
          {
            roaming_profile_id: '33333333-3333-4333-8333-333333333333',
            name: 'Roaming A',
            mccmnc_list: [{ mcc: '460', mnc: '00', ratePerMb: 0.001 }],
            supplier_id: supplierId,
            operator_id: operatorId,
            status: 'DRAFT',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ]
      }
      if (table === 'covered_network_profiles') {
        captured.coveredQuery = queryString
        return [
          {
            covered_network_profile_id: profileId,
            name: 'Cov A',
            reseller_id: resellerId,
            supplier_id: supplierId,
            operator_id: operatorId,
            coverage_mode: 'NONE',
            status: 'DRAFT',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ]
      }
      if (table === 'covered_network_profile_entries') return []
      return []
    }),
    insert: vi.fn(async (table: string, rows: unknown) => {
      const payload = Array.isArray(rows) ? rows : [rows]
      captured.inserts = [
        ...(captured.inserts ?? []),
        ...payload.map((row) => ({ table, row: { ...(row as Record<string, unknown>) } })),
      ]
      if (table === 'roaming_profiles') {
        return payload.map((row) => ({
          ...(row as Record<string, unknown>),
          roaming_profile_id: '44444444-4444-4444-8444-444444444444',
          created_at: '2026-01-01T00:00:00.000Z',
        }))
      }
      return null
    }),
    update: vi.fn(),
  }

  registerNetworkProfileRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient: () => supabase,
      getTraceId: () => 'trace-test',
      sendError: (_res: any, status: number, code: string, message: string) => {
        captured.error = `${status}:${code}:${message}`
      },
      ensureResellerAdmin: (req: any) => ({ scope: req.cmpAuth?.roleScope, resellerId: req.cmpAuth?.resellerId }),
      ensureResellerSales: (req: any) => ({ scope: req.cmpAuth?.roleScope, resellerId: req.cmpAuth?.resellerId }),
      isValidUuid: (value: unknown) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '')),
      readRequestBody: async () => Buffer.from('multipart-body'),
      parseMultipartFormData: () => ({
        fields: captured.multipartFields ?? {},
        files: captured.multipartFiles ?? {},
      }),
    } as any,
  })
  return app.routes
}

describe('NetworkProfiles routes', () => {
  it('creates roaming profile under token reseller when reseller token omits resellerId', async () => {
    const captured: { error?: string; inserts?: Array<{ table: string; row: Record<string, unknown> }> } = {}
    const handler = registerRoutes(captured).get('POST /v1/roaming-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        body: {
          name: 'Roaming A',
          supplierId,
          operatorId,
          mccmncList: [{ mcc: '460', mnc: '00', ratePerMb: 0.001 }],
        },
      },
      res
    )

    expect(captured.error).toBeUndefined()
    const inserted = captured.inserts?.find((entry) => entry.table === 'roaming_profiles')
    expect(inserted?.row.reseller_id).toBeUndefined()
    const audit = captured.inserts?.find((entry) => entry.table === 'audit_logs')
    expect((audit?.row.after_data as { resellerId?: string } | undefined)?.resellerId).toBe(resellerId)
  })

  it('rejects platform roaming create when resellerId is omitted', async () => {
    const captured: { error?: string; inserts?: Array<{ table: string; row: Record<string, unknown> }> } = {}
    const handler = registerRoutes(captured).get('POST /v1/roaming-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        body: {
          name: 'Roaming A',
          supplierId,
          operatorId,
          mccmncList: [{ mcc: '460', mnc: '00', ratePerMb: 0.001 }],
        },
      },
      res
    )

    expect(captured.error).toBe('400:BAD_REQUEST:resellerId is required.')
    expect(captured.inserts ?? []).toHaveLength(0)
  })

  it('rejects platform roaming create when resellerId is not found', async () => {
    const captured: { error?: string; inserts?: Array<{ table: string; row: Record<string, unknown> }> } = {}
    const handler = registerRoutes(captured).get('POST /v1/roaming-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        body: {
          name: 'Roaming A',
          resellerId: missingResellerId,
          supplierId,
          operatorId,
          mccmncList: [{ mcc: '460', mnc: '00', ratePerMb: 0.001 }],
        },
      },
      res
    )

    expect(captured.error).toBe('404:RESOURCE_NOT_FOUND:resellerId is not found.')
    expect(captured.inserts ?? []).toHaveLength(0)
  })

  it('rejects reseller roaming create when resellerId does not match token', async () => {
    const captured: { error?: string; inserts?: Array<{ table: string; row: Record<string, unknown> }> } = {}
    const handler = registerRoutes(captured).get('POST /v1/roaming-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        body: {
          name: 'Roaming A',
          resellerId: otherResellerId,
          supplierId,
          operatorId,
          mccmncList: [{ mcc: '460', mnc: '00', ratePerMb: 0.001 }],
        },
      },
      res
    )

    expect(captured.error).toBe('403:FORBIDDEN:resellerId does not match authenticated reseller.')
    expect(captured.inserts ?? []).toHaveLength(0)
  })

  it('imports roaming CSV under token reseller when reseller token omits resellerId', async () => {
    const captured: {
      error?: string
      multipartFields?: Record<string, unknown>
      multipartFiles?: Record<string, { filename?: string; content: string }>
      inserts?: Array<{ table: string; row: Record<string, unknown> }>
    } = {
      multipartFields: { name: 'Roaming CSV', supplierId, operatorId },
      multipartFiles: { file: { filename: 'rates.csv', content: 'mcc,mnc,ratePerMb\n460,00,0.001\n' } },
    }
    const handler = registerRoutes(captured).get('POST /v1/roaming-profiles/import-csv')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        headers: { 'content-type': 'multipart/form-data; boundary=----test' },
      },
      res
    )

    expect(captured.error).toBeUndefined()
    const audit = captured.inserts?.find((entry) => entry.table === 'audit_logs')
    expect((audit?.row.after_data as { resellerId?: string } | undefined)?.resellerId).toBe(resellerId)
  })

  it('rejects platform roaming CSV import when resellerId is omitted', async () => {
    const captured: {
      error?: string
      multipartFields?: Record<string, unknown>
      multipartFiles?: Record<string, { filename?: string; content: string }>
      inserts?: Array<{ table: string; row: Record<string, unknown> }>
    } = {
      multipartFields: { name: 'Roaming CSV', supplierId, operatorId },
      multipartFiles: { file: { filename: 'rates.csv', content: 'mcc,mnc,ratePerMb\n460,00,0.001\n' } },
    }
    const handler = registerRoutes(captured).get('POST /v1/roaming-profiles/import-csv')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        headers: { 'content-type': 'multipart/form-data; boundary=----test' },
      },
      res
    )

    expect(captured.error).toBe('400:BAD_REQUEST:resellerId is required.')
    expect(captured.inserts ?? []).toHaveLength(0)
  })

  it('rejects reseller roaming CSV import when resellerId does not match token', async () => {
    const captured: {
      error?: string
      multipartFields?: Record<string, unknown>
      multipartFiles?: Record<string, { filename?: string; content: string }>
      inserts?: Array<{ table: string; row: Record<string, unknown> }>
    } = {
      multipartFields: { name: 'Roaming CSV', resellerId: otherResellerId, supplierId, operatorId },
      multipartFiles: { file: { filename: 'rates.csv', content: 'mcc,mnc,ratePerMb\n460,00,0.001\n' } },
    }
    const handler = registerRoutes(captured).get('POST /v1/roaming-profiles/import-csv')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        headers: { 'content-type': 'multipart/form-data; boundary=----test' },
      },
      res
    )

    expect(captured.error).toBe('403:FORBIDDEN:resellerId does not match authenticated reseller.')
    expect(captured.inserts ?? []).toHaveLength(0)
  })

  it('lists reseller APN profiles without supplier/operator by reseller supplier scope', async () => {
    const captured: { error?: string; apnQuery?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/apn-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: {},
      },
      res
    )

    expect(captured.error).toBeUndefined()
    expect(captured.apnQuery).toContain(`supplier_id=in.(${encodeURIComponent(supplierId)})`)
  })

  it('rejects APN supplierId that is not found', async () => {
    const captured: { error?: string; apnQuery?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/apn-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { supplierId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
      res
    )

    expect(captured.error).toBe('400:BAD_REQUEST:supplierId is not found.')
    expect(captured.apnQuery).toBeUndefined()
  })

  it('rejects reseller Roaming operatorId outside reseller supplier scope', async () => {
    const captured: { error?: string; roamingQuery?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/roaming-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { operatorId: otherOperatorId },
      },
      res
    )

    expect(captured.error).toBe('403:FORBIDDEN:operatorId is outside reseller scope.')
    expect(captured.roamingQuery).toBeUndefined()
  })

  it('rejects admin APN supplierId/operatorId mismatch', async () => {
    const captured: { error?: string; apnQuery?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/apn-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { supplierId, operatorId: otherOperatorId },
      },
      res
    )

    expect(captured.error).toBe('400:BAD_REQUEST:operatorId is not linked to supplierId.')
    expect(captured.apnQuery).toBeUndefined()
  })

  it('rejects missing resellerId query for reseller-scoped covered profile list', async () => {
    const captured: { error?: string; coveredQuery?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/covered-network-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { supplierId, resellerId: missingResellerId },
      },
      res
    )

    expect(captured.error).toBe('404:RESOURCE_NOT_FOUND:resellerId is not found.')
    expect(captured.coveredQuery).toBeUndefined()
  })

  it('defaults covered profile reseller filter to token resellerId for reseller scope', async () => {
    const captured: { error?: string; coveredQuery?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/covered-network-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { supplierId },
      },
      res
    )

    expect(captured.error).toBeUndefined()
    expect(captured.coveredQuery).toContain(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  })

  it('rejects existing resellerId outside reseller token scope', async () => {
    const captured: { error?: string; coveredQuery?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/covered-network-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { supplierId, resellerId: otherResellerId },
      },
      res
    )

    expect(captured.error).toBe('403:FORBIDDEN:resellerId does not match authenticated reseller.')
    expect(captured.coveredQuery).toBeUndefined()
  })

  it('rejects malformed coveredNetworkProfileId on patch before Supabase access', async () => {
    const captured: { error?: string; coveredQuery?: string; selectCalls?: Array<{ table: string; queryString: string }> } = {}
    const handler = registerRoutes(captured).get('PATCH /v1/covered-network-profiles/:coveredNetworkProfileId')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        params: { coveredNetworkProfileId: '6dfe9989-ded4-48ac-8cb7-e94388e90f7' },
        body: { name: 'string', coverageMode: 'LIST', coverage: [{ mcc: '460', mnc: '00' }] },
      },
      res
    )

    expect(captured.error).toBe('400:BAD_REQUEST:coveredNetworkProfileId must be a valid uuid.')
    expect(captured.selectCalls ?? []).toHaveLength(0)
  })

  it('rejects malformed coveredNetworkProfileId on publish before Supabase access', async () => {
    const captured: { error?: string; coveredQuery?: string; selectCalls?: Array<{ table: string; queryString: string }> } = {}
    const handler = registerRoutes(captured).get('POST /v1/covered-network-profiles/:coveredNetworkProfileId/publish')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        params: { coveredNetworkProfileId: 'f625d1f1-ea0f-431b-9d0d-11230be9c7f' },
      },
      res
    )

    expect(captured.error).toBe('400:BAD_REQUEST:coveredNetworkProfileId must be a valid uuid.')
    expect(captured.selectCalls ?? []).toHaveLength(0)
  })

  it('rejects malformed roamingProfileId on publish before Supabase access', async () => {
    const captured: { error?: string; selectCalls?: Array<{ table: string; queryString: string }> } = {}
    const handler = registerRoutes(captured).get('POST /v1/roaming-profiles/:roamingProfileId/publish')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        params: { roamingProfileId: '18392229-1930-4726-8b41-5ebf762c35fg' },
      },
      res
    )

    expect(captured.error).toBe('400:BAD_REQUEST:roamingProfileId must be a valid uuid.')
    expect(captured.selectCalls ?? []).toHaveLength(0)
  })
})
