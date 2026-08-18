import { describe, expect, it } from 'vitest'
import { registerReportRoutes } from '../src/routes/reports.ts'

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
  }
}

function createReply() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    code(status: number) {
      this.statusCode = status
      return this
    },
    status(status: number) {
      this.statusCode = status
      return this
    },
    send(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

describe('Reports routes', () => {
  it('registers and serves anomaly SIMs report', async () => {
    const supabase = {
      async select(table: string) {
        if (table === 'alerts') {
          return [{
            alert_id: 'alert-1',
            alert_type: 'UNEXPECTED_ROAMING',
            severity: 'P2',
            status: 'OPEN',
            sim_id: 'sim-1',
            window_start: '2026-06-10T00:00:00.000Z',
            last_seen_at: '2026-06-11T00:00:00.000Z',
            created_at: '2026-06-10T00:00:00.000Z',
            sims: { iccid: '893107032536638540' },
          }]
        }
        if (table === 'tenants') return []
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/anomaly-sims')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { startDate: '2026-06-01', endDate: '2026-06-30' },
      },
      reply,
    )

    expect(reply.statusCode).toBe(200)
    expect(reply.body).toMatchObject({
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      total: 1,
      page: 1,
      pageSize: 20,
      items: [{
        iccid: '893107032536638540',
        alertCount: 1,
        latestAlertType: 'UNEXPECTED_ROAMING',
      }],
    })
    expect((reply.body as any).items[0]).not.toHaveProperty('simId')
  })

  it('rejects unknown enterpriseId for platform reports', async () => {
    const supabase = {
      async select(table: string) {
        if (table === 'tenants') return []
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/anomaly-sims')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: {
          enterpriseId: '11111111-1111-4111-8111-111111111111',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
      },
      reply,
    )

    expect(reply.statusCode).toBe(404)
    expect(reply.body).toMatchObject({ code: 'NOT_FOUND', message: 'Enterprise not found.' })
  })

  it('paginates anomaly SIMs and omits simId from response items', async () => {
    const supabase = {
      async select(table: string) {
        if (table === 'alerts') {
          return [
            {
              alert_id: 'alert-1',
              alert_type: 'SILENT_SIM',
              severity: 'P3',
              status: 'OPEN',
              sim_id: 'sim-1',
              window_start: '2026-06-10T00:00:00.000Z',
              last_seen_at: '2026-06-10T00:00:00.000Z',
              sims: { iccid: 'iccid-1' },
            },
            {
              alert_id: 'alert-2',
              alert_type: 'UNEXPECTED_ROAMING',
              severity: 'P1',
              status: 'OPEN',
              sim_id: 'sim-2',
              window_start: '2026-06-11T00:00:00.000Z',
              last_seen_at: '2026-06-11T00:00:00.000Z',
              sims: { iccid: 'iccid-2' },
            },
            {
              alert_id: 'alert-3',
              alert_type: 'OUT_OF_PROFILE_SURGE',
              severity: 'P2',
              status: 'ACKED',
              sim_id: 'sim-3',
              window_start: '2026-06-12T00:00:00.000Z',
              last_seen_at: '2026-06-12T00:00:00.000Z',
              sims: { iccid: 'iccid-3' },
            },
          ]
        }
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/anomaly-sims')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { startDate: '2026-06-01', endDate: '2026-06-30', page: '2', pageSize: '2' },
      },
      reply,
    )

    expect(reply.statusCode).toBe(200)
    expect(reply.body).toMatchObject({
      total: 3,
      page: 2,
      pageSize: 2,
      items: [{ iccid: 'iccid-3', alertCount: 1 }],
    })
    expect((reply.body as any).items[0]).not.toHaveProperty('simId')
  })

  it('rejects customer token enterpriseId outside its scope', async () => {
    const tokenEnterpriseId = '22222222-2222-4222-8222-222222222222'
    const requestedEnterpriseId = '33333333-3333-4333-8333-333333333333'
    const supabase = {
      async select(table: string) {
        if (table === 'tenants') {
          return [{ tenant_id: requestedEnterpriseId, parent_id: 'reseller-1', tenant_type: 'ENTERPRISE' }]
        }
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/usage-trend')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', customerId: tokenEnterpriseId },
        query: {
          enterpriseId: requestedEnterpriseId,
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
      },
      reply,
    )

    expect(reply.statusCode).toBe(403)
    expect(reply.body).toMatchObject({ code: 'FORBIDDEN', message: 'Enterprise is not in customer scope.' })
  })

  it('rejects usage trend day granularity ranges over 90 days', async () => {
    const supabase = {
      async select() {
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/usage-trend')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { startDate: '2026-01-01', endDate: '2026-04-01', granularity: 'day' },
      },
      reply,
    )

    expect(reply.statusCode).toBe(400)
    expect(reply.body).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'granularity=day supports a maximum date range of 90 days.',
    })
  })

  it('rejects sim-summary visited-MCC windows over 36 months', async () => {
    const app = createMockApp()
    registerReportRoutes({
      app: app as any,
      prefix: '/v1',
      deps: {
        createSupabaseRestClient: () => ({ select: async () => [] }) as any,
        getTraceId: () => 'trace-1',
        sendError: (reply: any, status: number, code: string, message: string) => {
          reply.code(status).send({ code, message })
        },
        getRoleScope: (req: any) => req.cmpAuth?.roleScope ?? null,
        getEnterpriseIdFromReq: (req: any) => req.cmpAuth?.customerId ?? null,
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/sim-summary')!
    const reply = createReply()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { startDate: '2020-01-01', endDate: '2023-02-01' },
      },
      reply,
    )
    expect(reply.statusCode).toBe(400)
    expect(reply.body).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'startDate/endDate span must be at most 36 calendar months.',
    })
  })

  it('rejects top-sims date ranges over 36 months', async () => {
    const app = createMockApp()
    registerReportRoutes({
      app: app as any,
      prefix: '/v1',
      deps: {
        createSupabaseRestClient: () => ({ select: async () => [] }) as any,
        getTraceId: () => 'trace-1',
        sendError: (reply: any, status: number, code: string, message: string) => {
          reply.code(status).send({ code, message })
        },
        getRoleScope: (req: any) => req.cmpAuth?.roleScope ?? null,
        getEnterpriseIdFromReq: (req: any) => req.cmpAuth?.customerId ?? null,
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/top-sims')!
    const reply = createReply()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { startDate: '2020-01-01', endDate: '2023-02-01' },
      },
      reply,
    )
    expect(reply.statusCode).toBe(400)
    expect(reply.body).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'startDate/endDate span must be at most 36 calendar months.',
    })
  })

  it('filters platform reports by resellerId when provided', async () => {
    const resellerId = '44444444-4444-4444-8444-444444444444'
    const enterpriseId = '55555555-5555-4555-8555-555555555555'
    let usageQuery = ''
    const supabase = {
      async select(table: string, query: string) {
        if (table === 'tenants' && query.includes('tenant_type=eq.RESELLER')) {
          return [{ tenant_id: resellerId, tenant_type: 'RESELLER' }]
        }
        if (table === 'tenants' && query.includes('parent_id=eq.')) {
          return [{ tenant_id: enterpriseId }]
        }
        if (table === 'usage_daily_summary') {
          usageQuery = query
          return [{ usage_day: '2026-06-01', iccid: '893107032536638540', total_mb: 25 }]
        }
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/top-sims')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId, startDate: '2026-06-01', endDate: '2026-06-30' },
      },
      reply,
    )

    expect(reply.statusCode).toBe(200)
    expect(usageQuery).toContain(`enterprise_id=in.(${enterpriseId})`)
    expect(reply.body).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      items: [{ iccid: '893107032536638540', totalMb: 25 }],
    })
  })

  it('paginates top SIMs with page, pageSize, and total', async () => {
    const supabase = {
      async select(table: string) {
        if (table === 'usage_daily_summary') {
          return [
            { usage_day: '2026-06-01', iccid: 'iccid-1', total_mb: 50 },
            { usage_day: '2026-06-01', iccid: 'iccid-2', total_mb: 40 },
            { usage_day: '2026-06-01', iccid: 'iccid-3', total_mb: 30 },
            { usage_day: '2026-06-02', iccid: 'iccid-3', total_mb: 5 },
          ]
        }
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/top-sims')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { startDate: '2026-06-01', endDate: '2026-06-30', page: '2', pageSize: '2' },
      },
      reply,
    )

    expect(reply.statusCode).toBe(200)
    expect(reply.body).toMatchObject({
      total: 3,
      page: 2,
      pageSize: 2,
      items: [{ iccid: 'iccid-3', totalMb: 35 }],
    })
  })

  it('rejects unknown resellerId for platform reports', async () => {
    const supabase = {
      async select() {
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/anomaly-sims')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: {
          resellerId: '66666666-6666-4666-8666-666666666666',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
      },
      reply,
    )

    expect(reply.statusCode).toBe(404)
    expect(reply.body).toMatchObject({ code: 'NOT_FOUND', message: 'Reseller not found.' })
  })

  it('rejects resellerId that does not match reseller token', async () => {
    const tokenResellerId = '77777777-7777-4777-8777-777777777777'
    const requestedResellerId = '88888888-8888-4888-8888-888888888888'
    const supabase = {
      async select(table: string) {
        if (table === 'tenants') return [{ tenant_id: requestedResellerId, tenant_type: 'RESELLER' }]
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/anomaly-sims')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', resellerId: tokenResellerId },
        query: {
          resellerId: requestedResellerId,
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        },
      },
      reply,
    )

    expect(reply.statusCode).toBe(403)
    expect(reply.body).toMatchObject({ code: 'FORBIDDEN', message: 'resellerId does not match reseller token.' })
  })

  it('ignores resellerId for customer token reports', async () => {
    const customerId = '99999999-9999-4999-8999-999999999999'
    let usageQuery = ''
    const supabase = {
      async select(table: string, query: string) {
        if (table === 'usage_daily_summary') {
          usageQuery = query
          return [{ usage_day: '2026-06-01', total_mb: 12 }]
        }
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/usage-trend')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', customerId },
        query: { resellerId: 'not-a-uuid', startDate: '2026-06-01', endDate: '2026-06-30' },
      },
      reply,
    )

    expect(reply.statusCode).toBe(200)
    expect(usageQuery).toContain(`enterprise_id=eq.${customerId}`)
    expect(reply.body).toMatchObject({ items: [{ period: '2026-06-01', totalMb: 12 }] })
  })

  it('serves sim-summary totals by status for reseller scope', async () => {
    const resellerId = '44444444-4444-4444-8444-444444444444'
    const enterpriseId = '55555555-5555-4555-8555-555555555555'
    const supabase = {
      async select(table: string, query: string) {
        if (table === 'tenants' && query.includes('parent_id=eq.')) {
          return [{ tenant_id: enterpriseId }]
        }
        if (table === 'sims') {
          if (query.includes('status=eq.ACTIVATED')) {
            return [{ status: 'ACTIVATED' }, { status: 'ACTIVATED' }]
          }
          if (query.includes('status=eq.')) return []
          return [
            { status: 'ACTIVATED' },
            { status: 'ACTIVATED' },
            { status: 'INVENTORY' },
          ]
        }
        return []
      },
      async selectWithCount(_table: string, query: string) {
        if (query.includes('status=eq.ACTIVATED')) return { data: [], total: 2 }
        if (query.includes('status=eq.INVENTORY')) return { data: [], total: 1 }
        if (query.includes('status=eq.')) return { data: [], total: 0 }
        return { data: [], total: 3 }
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/sim-summary')!
    const reply = createReply()
    await handler({ cmpAuth: { roleScope: 'reseller', resellerId } }, reply)
    expect(reply.statusCode).toBe(200)
    expect(reply.body).toMatchObject({
      total: 3,
      byStatus: expect.arrayContaining([
        { status: 'ACTIVATED', count: 2 },
        { status: 'INVENTORY', count: 1 },
        { status: 'DEACTIVATED', count: 0 },
      ]),
      byEnterprise: expect.any(Array),
      byVisitedMcc: expect.any(Array),
      visitedMccWindow: expect.objectContaining({
        startDate: expect.any(String),
        endDate: expect.any(String),
      }),
    })
  })

  it('sim-summary byEnterprise and byVisitedMcc (visited network MCC)', async () => {
    const resellerId = '44444444-4444-4444-8444-444444444444'
    const enterpriseA = '55555555-5555-4555-8555-555555555555'
    const enterpriseB = '66666666-6666-4666-8666-666666666666'
    const supabase = {
      async select(table: string, query: string) {
        if (table === 'tenants' && query.includes('parent_id=eq.')) {
          return [{ tenant_id: enterpriseA }, { tenant_id: enterpriseB }]
        }
        if (table === 'tenants' && query.includes('tenant_id=in.')) {
          return [
            { tenant_id: enterpriseA, name: 'Ent A' },
            { tenant_id: enterpriseB, name: 'Ent B' },
          ]
        }
        if (table === 'sims' && query.includes('select=enterprise_id')) {
          return [
            { enterprise_id: enterpriseA },
            { enterprise_id: enterpriseA },
            { enterprise_id: enterpriseB },
            { enterprise_id: null },
          ]
        }
        if (table === 'sims') return []
        if (table === 'usage_monthly_summary' || table === 'usage_daily_summary') {
          return [
            { sim_id: 's1', iccid: '1', visited_mccmnc: '46001' },
            { sim_id: 's1', iccid: '1', visited_mccmnc: '46001' },
            { sim_id: 's2', iccid: '2', visited_mccmnc: '46011' },
            { sim_id: 's3', iccid: '3', visited_mccmnc: '310260' },
          ]
        }
        return []
      },
      async selectWithCount() {
        return { data: [], total: 4 }
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/sim-summary')!
    const reply = createReply()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', resellerId },
        query: { startDate: '2026-01-01', endDate: '2026-06-30' },
      },
      reply,
    )
    expect(reply.statusCode).toBe(200)
    expect(reply.body).toMatchObject({
      total: 4,
      visitedMccWindow: { startDate: '2026-01-01', endDate: '2026-06-30' },
      byEnterprise: expect.arrayContaining([
        { enterpriseId: enterpriseA, enterpriseName: 'Ent A', count: 2 },
        { enterpriseId: enterpriseB, enterpriseName: 'Ent B', count: 1 },
        { enterpriseId: null, enterpriseName: null, count: 1 },
      ]),
      byVisitedMcc: [
        { mcc: '460', count: 2 },
        { mcc: '310', count: 1 },
      ],
    })
  })

  it('groups usage-trend by mcc from visited_mccmnc', async () => {
    const supabase = {
      async select(table: string) {
        if (table === 'usage_monthly_summary') {
          return [
            { usage_month: '2026-01-01', total_mb: 15, visited_mccmnc: '46001' },
            { usage_month: '2026-02-01', total_mb: 8, visited_mccmnc: '310260' },
          ]
        }
        if (table === 'usage_daily_summary') {
          return [
            { usage_day: '2026-01-01', total_mb: 10, visited_mccmnc: '46001' },
            { usage_day: '2026-01-15', total_mb: 5, visited_mccmnc: '46001' },
            { usage_day: '2026-02-01', total_mb: 8, visited_mccmnc: '310260' },
          ]
        }
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/usage-trend')!
    const reply = createReply()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: {
          startDate: '2026-01-01',
          endDate: '2026-06-30',
          granularity: 'month',
          groupBy: 'mcc',
        },
      },
      reply,
    )
    expect(reply.statusCode).toBe(200)
    expect(reply.body).toMatchObject({
      groupBy: 'mcc',
      items: [
        { period: '2026-01', groupKey: '460', groupLabel: '460', totalMb: 15 },
        { period: '2026-02', groupKey: '310', groupLabel: '310', totalMb: 8 },
      ],
    })
  })

  it('groups usage-trend by enterprise for reseller scope', async () => {
    const resellerId = '44444444-4444-4444-8444-444444444444'
    const enterpriseA = '55555555-5555-4555-8555-555555555555'
    const enterpriseB = '66666666-6666-4666-8666-666666666666'
    const supabase = {
      async select(table: string, query: string) {
        if (table === 'tenants' && query.includes('parent_id=eq.')) {
          return [{ tenant_id: enterpriseA }, { tenant_id: enterpriseB }]
        }
        if (table === 'tenants' && query.includes('tenant_id=in.')) {
          return [
            { tenant_id: enterpriseA, name: 'Ent A' },
            { tenant_id: enterpriseB, name: 'Ent B' },
          ]
        }
        if (table === 'usage_monthly_summary') {
          return [
            { usage_month: '2026-01-01', total_mb: 20, enterprise_id: enterpriseA },
            { usage_month: '2026-01-01', total_mb: 5, enterprise_id: enterpriseB },
          ]
        }
        if (table === 'usage_daily_summary') {
          return [
            { usage_day: '2026-01-10', total_mb: 20, enterprise_id: enterpriseA },
            { usage_day: '2026-01-20', total_mb: 5, enterprise_id: enterpriseB },
          ]
        }
        return []
      },
    }
    const app = createMockApp()
    registerReportRoutes({
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
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/usage-trend')!
    const reply = createReply()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', resellerId },
        query: {
          startDate: '2026-01-01',
          endDate: '2026-06-30',
          granularity: 'month',
          groupBy: 'enterprise',
        },
      },
      reply,
    )
    expect(reply.statusCode).toBe(200)
    expect(reply.body).toMatchObject({
      groupBy: 'enterprise',
      items: [
        { period: '2026-01', groupKey: enterpriseA, groupLabel: 'Ent A', totalMb: 20 },
        { period: '2026-01', groupKey: enterpriseB, groupLabel: 'Ent B', totalMb: 5 },
      ],
    })
  })

  it('forbids groupBy=enterprise for customer tokens', async () => {
    const customerId = '77777777-7777-4777-8777-777777777777'
    const app = createMockApp()
    registerReportRoutes({
      app: app as any,
      prefix: '/v1',
      deps: {
        createSupabaseRestClient: () => ({ select: async () => [] }) as any,
        getTraceId: () => 'trace-1',
        sendError: (reply: any, status: number, code: string, message: string) => {
          reply.code(status).send({ code, message })
        },
        getRoleScope: (req: any) => req.cmpAuth?.roleScope ?? null,
        getEnterpriseIdFromReq: (req: any) => req.cmpAuth?.customerId ?? null,
        isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      },
    })
    const handler = app.routes.get('GET /v1/reports/usage-trend')!
    const reply = createReply()
    await handler(
      {
        cmpAuth: { roleScope: 'customer', customerId },
        query: {
          startDate: '2026-01-01',
          endDate: '2026-06-30',
          granularity: 'month',
          groupBy: 'enterprise',
        },
      },
      reply,
    )
    expect(reply.statusCode).toBe(403)
    expect(reply.body).toMatchObject({ code: 'FORBIDDEN' })
  })
})
