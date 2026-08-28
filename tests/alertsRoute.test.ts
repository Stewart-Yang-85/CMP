import { describe, expect, it, vi } from 'vitest'
import { registerAlertRoutes } from '../src/routes/alerts.ts'

const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const otherResellerId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'
const missingResellerId = 'cccccccc-1111-4111-8111-cccccccccccc'
const missingEnterpriseId = 'dddddddd-1111-4111-8111-dddddddddddd'
const otherEnterpriseId = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const alertId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

function createMockApp() {
  const routes = new Map<string, (req: any, res: any) => Promise<void>>()
  return {
    routes,
    get(path: string, handler: (req: any, res: any) => Promise<void>) {
      routes.set(`GET ${path}`, handler)
    },
    post(path: string, handler: (req: any, res: any) => Promise<void>) {
      routes.set(`POST ${path}`, handler)
    },
  }
}

function createMockRes() {
  const res: {
    body?: unknown
    statusCode?: number
    headers?: Record<string, string>
    send: (payload: unknown) => void
    code: (status: number) => typeof res
    header: (name: string, value: string) => typeof res
  } = {
    send(payload: unknown) {
      res.body = payload
    },
    code(status: number) {
      res.statusCode = status
      return res
    },
    header(name: string, value: string) {
      res.headers = { ...(res.headers ?? {}), [name]: value }
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
  alertQuery?: string
  alertQueries?: string[]
  updatePatch?: Record<string, unknown>
  inserts?: Array<{ table: string; row: Record<string, unknown> }>
  error?: string
  alertRow?: Record<string, unknown> | null
}) {
  const app = createMockApp()
  const supabase = {
    select: vi.fn(async (table: string, queryString: string) => {
      if (table === 'tenants' && queryString.includes('tenant_type=eq.ENTERPRISE')) {
        const id = parseEq(queryString, 'tenant_id')
        if (id === enterpriseId) return [{ tenant_id: enterpriseId, parent_id: resellerId, tenant_type: 'ENTERPRISE' }]
        return []
      }
      if (table === 'tenants' && queryString.includes('tenant_type=eq.RESELLER')) {
        const id = parseEq(queryString, 'tenant_id')
        if (id === resellerId) return [{ tenant_id: resellerId, tenant_type: 'RESELLER' }]
        if (id === otherResellerId) return [{ tenant_id: otherResellerId, tenant_type: 'RESELLER' }]
        return []
      }
      if (table === 'alerts') {
        if (queryString.includes(`alert_id=eq.${alertId}`)) {
          const defaultAlert = {
            alert_id: alertId,
            alert_type: 'POOL_USAGE_HIGH',
            severity: 'P2',
            status: 'OPEN',
            reseller_id: resellerId,
            customer_id: enterpriseId,
            sim_id: null,
            window_start: '2026-06-18T00:00:00.000Z',
            metadata: {},
          }
          const alertRow = captured.alertRow === undefined ? defaultAlert : captured.alertRow
          return alertRow ? [alertRow] : []
        }
        return []
      }
      return []
    }),
    selectWithCount: vi.fn(async (table: string, queryString: string) => {
      if (table === 'alerts') {
        captured.alertQuery = queryString
        captured.alertQueries = [...(captured.alertQueries ?? []), queryString]
      }
      return { data: [], total: 0 }
    }),
    update: vi.fn(async (_table: string, _queryString: string, patch: Record<string, unknown>) => {
      captured.updatePatch = patch
      return []
    }),
    insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
      captured.inserts = [...(captured.inserts ?? []), { table, row }]
      return []
    }),
  }
  registerAlertRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient: () => supabase,
      getTraceId: () => 'trace-1',
      sendError: (_res, status, code, message) => {
        captured.error = `${status}:${code}:${message}`
      },
      getRoleScope: (req) => req?.cmpAuth?.roleScope ?? null,
      getEnterpriseIdFromReq: (req) => req?.cmpAuth?.customerId ?? null,
      isValidUuid: (value) => /^[0-9a-f-]{36}$/i.test(String(value)),
    },
  })
  return app.routes
}

describe('Fastify Alerts routes', () => {
  it('defaults reseller list scope from reseller token and caps pageSize at 20', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { pageSize: '5000', acknowledged: 'false' },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.alertQuery).toContain(`reseller_id=eq.${resellerId}`)
    expect(captured.alertQuery).toContain('status=neq.ACKED')
    expect(captured.alertQuery).toContain('limit=20')
  })

  it('rejects missing resellerId before token mismatch checks', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { resellerId: missingResellerId },
      },
      res,
    )

    expect(captured.error).toBe(`404:RESOURCE_NOT_FOUND:reseller ${missingResellerId} not found.`)
    expect(captured.alertQuery).toBeUndefined()
  })

  it('rejects existing resellerId outside reseller token scope', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { resellerId: otherResellerId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:resellerId does not match token scope.')
    expect(captured.alertQuery).toBeUndefined()
  })

  it('rejects missing enterpriseId for reseller token', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { enterpriseId: missingEnterpriseId },
      },
      res,
    )

    expect(captured.error).toBe(`404:RESOURCE_NOT_FOUND:enterprise ${missingEnterpriseId} not found.`)
    expect(captured.alertQuery).toBeUndefined()
  })

  it('ignores resellerId for customer token but validates enterpriseId match', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        query: { resellerId: otherResellerId, enterpriseId },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.alertQuery).toContain(`customer_id=eq.${enterpriseId}`)
    expect(captured.alertQuery).not.toContain('reseller_id=eq.')
  })

  it('rejects existing enterpriseId outside customer token scope', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: missingEnterpriseId },
        query: { enterpriseId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId does not match token scope.')
    expect(captured.alertQuery).toBeUndefined()
  })

  it('rejects platform admin reseller and enterprise mismatch', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId: otherResellerId, enterpriseId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of reseller scope.')
    expect(captured.alertQuery).toBeUndefined()
  })

  it('exports alerts csv with export page size cap', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts:csv')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { pageSize: '5000' },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.alertQuery).toContain('limit=1000')
    expect(res.headers?.['Content-Type']).toBe('text/csv; charset=utf-8')
    expect(String(res.body)).toContain('alertId,resellerId,enterpriseId,alertType')
  })

  it('filters alert list by overlapping alert window', async () => {
    const captured: { alertQuery?: string; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts')!
    const res = createMockRes()
    const from = '2026-06-18T00:00:00.000Z'
    const to = '2026-06-19T00:00:00.000Z'

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { from, to },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.alertQuery).toContain(`window_start=lte.${encodeURIComponent(to)}`)
    expect(captured.alertQuery).toContain(
      `or=(window_end.gte.${encodeURIComponent(from)},and(window_end.is.null,window_start.gte.${encodeURIComponent(from)}))`,
    )
    expect(captured.alertQuery).not.toContain('window_start=gte.')
  })

  it('gets alert detail when alert belongs to reseller scope', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts/:alertId')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        params: { alertId },
        query: {},
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(res.body).toMatchObject({
      alertId,
      resellerId,
      enterpriseId,
      alertType: 'POOL_USAGE_HIGH',
    })
  })

  it('returns not found when getting a missing alert detail', async () => {
    const captured: { alertRow?: Record<string, unknown> | null; error?: string } = { alertRow: null }
    const handler = registerRoutes(captured).get('GET /v1/alerts/:alertId')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        params: { alertId },
        query: {},
      },
      res,
    )

    expect(captured.error).toBe('404:RESOURCE_NOT_FOUND:alert not found.')
  })

  it('rejects alert detail outside customer enterprise scope', async () => {
    const captured: { alertRow?: Record<string, unknown> | null; error?: string } = {
      alertRow: {
        alert_id: alertId,
        alert_type: 'POOL_USAGE_HIGH',
        severity: 'P2',
        status: 'OPEN',
        reseller_id: resellerId,
        customer_id: otherEnterpriseId,
      },
    }
    const handler = registerRoutes(captured).get('GET /v1/alerts/:alertId')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        params: { alertId },
        query: {},
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:alert does not belong to enterprise scope.')
  })

  it('acknowledges customer-scoped alert only after enterprise ownership check', async () => {
    const captured: { updatePatch?: Record<string, unknown>; inserts?: Array<{ table: string; row: Record<string, unknown> }>; error?: string } = {}
    const handler = registerRoutes(captured).get('POST /v1/alerts/:alertId/acknowledge')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId, userId: alertId },
        params: { alertId },
        query: {},
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.updatePatch?.status).toBe('ACKED')
    expect(captured.updatePatch?.acknowledged_by).toBe(alertId)
    expect(captured.inserts?.map((entry) => entry.table)).toEqual(['events', 'audit_logs'])
    expect(captured.inserts?.[0].row.event_type).toBe('ALERT_ACKNOWLEDGED')
    expect(captured.inserts?.[1].row.action).toBe('ALERT_ACKNOWLEDGE')
  })

  it('returns not found when acknowledging a missing alertId', async () => {
    const captured: {
      alertRow?: Record<string, unknown> | null
      updatePatch?: Record<string, unknown>
      error?: string
    } = { alertRow: null }
    const handler = registerRoutes(captured).get('POST /v1/alerts/:alertId/acknowledge')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        params: { alertId },
        query: {},
      },
      res,
    )

    expect(captured.error).toBe('404:RESOURCE_NOT_FOUND:alert not found.')
    expect(captured.updatePatch).toBeUndefined()
  })

  it('rejects acknowledging an alert outside reseller scope', async () => {
    const captured: {
      alertRow?: Record<string, unknown> | null
      updatePatch?: Record<string, unknown>
      error?: string
    } = {
      alertRow: {
        alert_id: alertId,
        alert_type: 'POOL_USAGE_HIGH',
        severity: 'P2',
        status: 'OPEN',
        reseller_id: otherResellerId,
        customer_id: enterpriseId,
      },
    }
    const handler = registerRoutes(captured).get('POST /v1/alerts/:alertId/acknowledge')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        params: { alertId },
        query: {},
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:alert does not belong to reseller scope.')
    expect(captured.updatePatch).toBeUndefined()
  })

  it('rejects acknowledging an alert outside customer enterprise scope', async () => {
    const captured: {
      alertRow?: Record<string, unknown> | null
      updatePatch?: Record<string, unknown>
      error?: string
    } = {
      alertRow: {
        alert_id: alertId,
        alert_type: 'POOL_USAGE_HIGH',
        severity: 'P2',
        status: 'OPEN',
        reseller_id: resellerId,
        customer_id: otherEnterpriseId,
      },
    }
    const handler = registerRoutes(captured).get('POST /v1/alerts/:alertId/acknowledge')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId, userId: alertId },
        params: { alertId },
        query: {},
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:alert does not belong to enterprise scope.')
    expect(captured.updatePatch).toBeUndefined()
  })

  it('rejects acknowledging non-open alerts', async () => {
    const captured: {
      alertRow?: Record<string, unknown> | null
      updatePatch?: Record<string, unknown>
      error?: string
    } = {
      alertRow: {
        alert_id: alertId,
        alert_type: 'POOL_USAGE_HIGH',
        severity: 'P2',
        status: 'ACKED',
        reseller_id: resellerId,
        customer_id: enterpriseId,
      },
    }
    const handler = registerRoutes(captured).get('POST /v1/alerts/:alertId/acknowledge')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        params: { alertId },
        query: {},
      },
      res,
    )

    expect(captured.error).toBe('409:CONFLICT:Only OPEN alerts can be acknowledged.')
    expect(captured.updatePatch).toBeUndefined()
  })

  it('builds summary counts with reseller scope and severity filter', async () => {
    const captured: { alertQueries?: string[]; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts/summary')!
    const res = createMockRes()
    const from = '2026-06-18T00:00:00.000Z'
    const to = '2026-06-19T00:00:00.000Z'

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { severity: 'P1', alertType: 'CDR_DELAY', from, to },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.alertQueries?.length).toBe(8)
    expect(captured.alertQueries?.[0]).toContain(`reseller_id=eq.${resellerId}`)
    expect(captured.alertQueries?.[0]).toContain('severity=eq.P1')
    expect(captured.alertQueries?.[0]).toContain('alert_type=eq.CDR_DELAY')
    expect(captured.alertQueries?.[0]).toContain(`window_start=lte.${encodeURIComponent(to)}`)
    expect(captured.alertQueries?.[0]).toContain(
      `or=(window_end.gte.${encodeURIComponent(from)},and(window_end.is.null,window_start.gte.${encodeURIComponent(from)}))`,
    )
    expect(captured.alertQueries?.[0]).not.toContain('created_at=')
    expect(res.body).toMatchObject({ totalOpen: 0 })
  })

  it('builds summary with platform resellerId and enterpriseId query filters', async () => {
    const captured: { alertQueries?: string[]; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts/summary')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId, enterpriseId },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.alertQueries?.[0]).toContain(`reseller_id=eq.${resellerId}`)
    expect(captured.alertQueries?.[0]).toContain(`customer_id=eq.${enterpriseId}`)
  })

  it('builds trend buckets with customer enterprise scope', async () => {
    const captured: { alertQueries?: string[]; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts/trends')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        query: { days: '3', alertType: 'SILENT_SIM' },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.alertQueries?.length).toBe(3)
    expect(captured.alertQueries?.[0]).toContain(`customer_id=eq.${enterpriseId}`)
    expect(captured.alertQueries?.[0]).toContain('alert_type=eq.SILENT_SIM')
    expect(captured.alertQueries?.[0]).toMatch(/window_start=lte\./)
    expect(captured.alertQueries?.[0]).toMatch(/or=\(window_end\.gte\./)
    expect(res.body).toMatchObject({ days: 3 })
  })

  it('builds trends with platform resellerId and enterpriseId query filters', async () => {
    const captured: { alertQueries?: string[]; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alerts/trends')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId, enterpriseId, days: '2' },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.alertQueries?.[0]).toContain(`reseller_id=eq.${resellerId}`)
    expect(captured.alertQueries?.[0]).toContain(`customer_id=eq.${enterpriseId}`)
    expect(res.body).toMatchObject({ days: 2 })
  })
})
