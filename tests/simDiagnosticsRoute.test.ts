import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerSimDiagnosticsRoutes } from '../src/routes/simDiagnostics.ts'

vi.mock('../src/services/upstreamIntegration.js', () => ({
  loadUpstreamIntegrationRuntime: vi.fn(),
}))

import { loadUpstreamIntegrationRuntime } from '../src/services/upstreamIntegration.js'

const iccid = '893107032536638540'

function createMockApp() {
  const routes = new Map<string, (req: any, res: any) => Promise<void>>()
  const register = (method: string, path: string, args: any[]) => {
    routes.set(`${method} ${path}`, args[args.length - 1])
  }
  return {
    routes,
    get(path: string, ...args: any[]) {
      register('GET', path, args)
    },
    post(path: string, ...args: any[]) {
      register('POST', path, args)
    },
  }
}

function createReply() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    code(status: number) {
      this.statusCode = status
      return this
    },
    status(status: number) {
      this.statusCode = status
      return this
    },
    header(name: string, value: string) {
      this.headers[name] = value
      return this
    },
    send(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

describe('GET /v1/sims/:iccid/visited-network-records pagination', () => {
  beforeEach(() => {
    vi.mocked(loadUpstreamIntegrationRuntime).mockReset()
    vi.mocked(loadUpstreamIntegrationRuntime).mockResolvedValue({
      integrationId: 'integration-1',
      supplierId: 'supplier-1',
      operatorId: 'operator-1',
      adapterType: 'wxzhonggeng',
      apiEndpoint: 'https://upstream.example.com',
      apiKey: 'key',
      apiSecret: 'secret',
      username: null,
      password: null,
      webhookKey: null,
      authType: 'api_key',
      tokenUrl: null,
      enabled: true,
      config: {},
    })
  })

  it('defaults to pageSize 20 and caps requested pageSize to 20', async () => {
    const captured: { usageQuery?: string } = {}
    const supabase = {
      async select(table: string, queryString: string) {
        if (table === 'sims' && queryString.includes('select=reseller_id')) return [{ reseller_id: null }]
        if (table === 'sims') {
          return [{
            sim_id: 'sim-1',
            iccid,
            enterprise_id: 'enterprise-1',
            supplier_id: 'supplier-1',
            operator_id: 'operator-1',
          }]
        }
        if (table === 'events') return []
        return []
      },
      async selectWithCount(table: string, queryString: string) {
        if (table === 'usage_daily_summary') {
          captured.usageQuery = queryString
          return { data: [], total: 0 }
        }
        return { data: [], total: 0 }
      },
      async insert() {
        return []
      },
      async update() {
        return []
      },
    }
    const app = createMockApp()
    registerSimDiagnosticsRoutes({
      app: app as any,
      prefix: '/v1',
      deps: {
        createSupabaseRestClient: () => supabase as any,
        getTraceId: () => 'trace-1',
        sendError: (reply: any, status: number, code: string, message: string) => {
          reply.code(status).send({ code, message })
        },
        getRoleScope: (req: any) => req.cmpAuth?.roleScope ?? null,
        getEnterpriseIdFromReq: (req: any) => req.cmpAuth?.customerId ?? null,
        getDepartmentIdFromReq: (req: any) => req.cmpAuth?.departmentId ?? null,
        normalizeIccid: (value: unknown) => String(value ?? '').trim(),
        isValidIccid: (value: unknown) => /^[0-9]{18,20}$/.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/sims/:iccid/visited-network-records')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        params: { iccid },
        query: {
          from: '2026-06-01T00:00:00.000Z',
          to: '2026-06-30T23:59:59.999Z',
          page: '2',
          pageSize: '100',
        },
      },
      reply,
    )

    expect(captured.usageQuery).toContain('limit=20')
    expect(captured.usageQuery).toContain('offset=20')
    expect(reply.body).toMatchObject({ items: [], total: 0, page: 2, pageSize: 20 })
  })
})

describe('GET /v1/sims/:iccid/visited-network local assembly', () => {
  it('does not require upstream integration configuration', async () => {
    vi.mocked(loadUpstreamIntegrationRuntime).mockReset()
    vi.mocked(loadUpstreamIntegrationRuntime).mockResolvedValue(null)
    const supabase = {
      async select(table: string, queryString: string) {
        if (table === 'sims' && queryString.includes('select=reseller_id')) return [{ reseller_id: null }]
        if (table === 'sims') {
          return [{
            sim_id: 'sim-1',
            iccid,
            enterprise_id: 'enterprise-1',
            supplier_id: 'supplier-1',
            operator_id: 'operator-1',
          }]
        }
        if (table === 'usage_daily_summary') {
          return [{
            iccid,
            visited_mccmnc: '204-008',
            created_at: '2026-06-17T08:00:00.000Z',
            usage_day: '2026-06-17',
          }]
        }
        if (table === 'events') return []
        if (table === 'public_infos') return [{ country: 'Netherlands', name: 'KPN B.V.' }]
        return []
      },
      async selectWithCount() {
        return { data: [], total: 0 }
      },
      async insert() {
        return []
      },
      async update() {
        return []
      },
    }
    const app = createMockApp()
    registerSimDiagnosticsRoutes({
      app: app as any,
      prefix: '/v1',
      deps: {
        createSupabaseRestClient: () => supabase as any,
        getTraceId: () => 'trace-1',
        sendError: (reply: any, status: number, code: string, message: string) => {
          reply.code(status).send({ code, message })
        },
        getRoleScope: (req: any) => req.cmpAuth?.roleScope ?? null,
        getEnterpriseIdFromReq: (req: any) => req.cmpAuth?.customerId ?? null,
        getDepartmentIdFromReq: (req: any) => req.cmpAuth?.departmentId ?? null,
        normalizeIccid: (value: unknown) => String(value ?? '').trim(),
        isValidIccid: (value: unknown) => /^[0-9]{18,20}$/.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/sims/:iccid/visited-network')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        params: { iccid },
        query: {},
      },
      reply,
    )

    expect(vi.mocked(loadUpstreamIntegrationRuntime)).not.toHaveBeenCalled()
    expect(reply.statusCode).toBe(200)
    expect(reply.body).toMatchObject({
      iccid,
      lastActivityTime: '2026-06-17T08:00:00.000Z',
      visitedMccMnc: '204-008',
      country: 'Netherlands',
      visitedOperator: 'KPN B.V.',
    })
  })
})
