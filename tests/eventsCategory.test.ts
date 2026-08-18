import { describe, expect, it, vi } from 'vitest'
import {
  buildEventTypeCatalogMap,
  listAllEventTypes,
  normalizeEventCategoryId,
  buildEventTypeFilterClause,
  listEventCategoryCatalog,
  resolveEventTypeFilter,
} from '../src/utils/eventTypeCatalog.ts'
import { registerEventRoutes } from '../src/routes/events.ts'

function createMockApp() {
  const routes = new Map<string, (req: any, res: any) => Promise<void>>()
  return {
    routes,
    get(path: string, handler: (req: any, res: any) => Promise<void>) {
      routes.set(path, handler)
    },
  }
}

function createMockRes() {
  const res: {
    body?: unknown
    headers: Record<string, string>
    header: (name: string, value: string) => typeof res
    send: (payload: unknown) => void
  } = {
    headers: {},
    header(name: string, value: string) {
      res.headers[name.toLowerCase()] = value
      return res
    },
    send(payload: unknown) {
      res.body = payload
    },
  }
  return res
}

function registerPlatformEventsRoute(
  captured: { query?: string; error?: string },
  options: { simRows?: Record<string, unknown>[]; tenantRows?: Record<string, unknown>[] } = {},
) {
  const app = createMockApp()
  registerEventRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient: () => ({
        select: vi.fn(async (table: string, queryString: string) => {
          if (table === 'sims') return options.simRows ?? []
          if (table === 'tenants') {
            const tenantId = queryString.match(/tenant_id=eq\.([^&]+)/)?.[1]
            const tenantType = queryString.match(/tenant_type=eq\.([^&]+)/)?.[1]
            return (options.tenantRows ?? []).filter((row) => {
              if (tenantId && String(row.tenant_id) !== decodeURIComponent(tenantId)) return false
              if (tenantType && String(row.tenant_type) !== decodeURIComponent(tenantType)) return false
              return true
            })
          }
          return []
        }),
        selectWithCount: vi.fn(async (_table: string, queryString: string) => {
          captured.query = queryString
          return { data: [], total: 0 }
        }),
      }),
      getTraceId: () => 'trace-1',
      sendError: (_res, status, code, message) => {
        captured.error = `${status}:${code}:${message}`
      },
      getRoleScope: (req) => req?.cmpAuth?.roleScope ?? 'platform',
      getEnterpriseIdFromReq: (req) => req?.cmpAuth?.customerId ?? null,
      resolveEnterpriseForReseller: async () => null,
      isValidUuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    },
  })
  return app.routes
}

describe('eventTypeCatalog', () => {
  it('lists all known event types for OpenAPI enum sync', () => {
    expect(listAllEventTypes()).toHaveLength(24)
    expect(buildEventTypeCatalogMap().webhook).toContain('SIM_STATUS_CHANGED')
  })

  it('accepts deprecated upstream alias as inbound', () => {
    expect(normalizeEventCategoryId('upstream')).toBe('inbound')
    const result = resolveEventTypeFilter({
      eventCategory: 'upstream',
      eventType: 'INBOUND_SIM_STATUS_CHANGED',
    })
    expect(result).toEqual({ ok: true, filter: 'event_type=eq.INBOUND_SIM_STATUS_CHANGED' })
  })

  it('lists five categories with known webhook types', () => {
    const catalog = listEventCategoryCatalog()
    expect(catalog).toHaveLength(5)
    const webhook = catalog.find((c) => c.id === 'webhook')
    expect(webhook?.eventTypes).toContain('SIM_STATUS_CHANGED')
    expect(webhook?.eventTypes).toContain('JOB_FINISHED')
  })

  it('builds in-clause for multi-type category filters', () => {
    expect(buildEventTypeFilterClause(['SIM_STATUS_CHANGED', 'JOB_FINISHED'])).toBe(
      'event_type=in.(SIM_STATUS_CHANGED,JOB_FINISHED)',
    )
  })

  it('rejects eventType outside eventCategory', () => {
    const result = resolveEventTypeFilter({
      eventCategory: 'webhook',
      eventType: 'BILL_VOIDED',
    })
    expect(result).toEqual({
      ok: false,
      message: 'eventType BILL_VOIDED is not in eventCategory webhook.',
    })
  })

  it('accepts matching eventCategory and eventType', () => {
    const result = resolveEventTypeFilter({
      eventCategory: 'billing',
      eventType: 'bill_voided',
    })
    expect(result).toEqual({ ok: true, filter: 'event_type=eq.BILL_VOIDED' })
  })
})

describe('GET /v1/events eventCategory', () => {
  it('applies category in-filter when eventCategory is webhook', async () => {
    const captured: { query?: string } = {}
    const handler = registerPlatformEventsRoute(captured).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { eventCategory: 'webhook' },
      },
      res,
    )
    expect(captured.query).toContain('event_type=in.(SIM_STATUS_CHANGED,JOB_FINISHED')
    expect(captured.query).toContain('ENTERPRISE_STATUS_CHANGED')
  })

  it('keeps single eq filter when only eventType is provided', async () => {
    const captured: { query?: string } = {}
    const handler = registerPlatformEventsRoute(captured).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { eventType: 'TRAFFIC_ALERT' },
      },
      res,
    )
    expect(captured.query).toContain('event_type=eq.TRAFFIC_ALERT')
    expect(captured.query).not.toContain('event_type=in.')
  })

  it('filters by iccid payload field', async () => {
    const captured: { query?: string } = {}
    const handler = registerPlatformEventsRoute(captured, {
      simRows: [
        {
          iccid: '8986012345678901234',
          enterprise_id: 'enterprise-1',
          reseller_id: 'reseller-1',
        },
      ],
    }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { iccid: '8986012345678901234' },
      },
      res,
    )
    expect(captured.query).toContain('payload->>iccid=eq.8986012345678901234')
    expect(captured.query).not.toContain('payload->>simId')
  })

  it('returns 404 when iccid is not an existing SIM', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { simRows: [] }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { iccid: '8986012345678901234' },
      },
      res,
    )
    expect(captured.error).toBe('404:SIM_NOT_FOUND:sim 8986012345678901234 not found.')
    expect(captured.query).toBeUndefined()
  })

  it('returns 403 when reseller token queries an out-of-scope iccid', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, {
      simRows: [
        {
          iccid: '8986012345678901234',
          enterprise_id: 'enterprise-1',
          reseller_id: 'other-reseller',
        },
      ],
    }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId: 'reseller-1' },
        query: { iccid: '8986012345678901234' },
      },
      res,
    )
    expect(captured.error).toBe('403:FORBIDDEN:SIM does not belong to your reseller.')
    expect(captured.query).toBeUndefined()
  })

  it('returns 403 when customer token queries an out-of-scope iccid', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, {
      simRows: [
        {
          iccid: '8986012345678901234',
          enterprise_id: 'other-enterprise',
          reseller_id: 'reseller-1',
        },
      ],
    }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: 'enterprise-1' },
        query: { iccid: '8986012345678901234' },
      },
      res,
    )
    expect(captured.error).toBe('403:FORBIDDEN:SIM does not belong to your enterprise.')
    expect(captured.query).toBeUndefined()
  })

  it('returns 400 for unknown eventCategory', async () => {
    const captured: { error?: string } = {}
    const handler = registerPlatformEventsRoute(captured).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { eventCategory: 'unknown' },
      },
      res,
    )
    expect(captured.error).toMatch(/eventCategory must be one of/)
  })

  it('exports CSV with pageSize capped at 1000', async () => {
    const captured: { query?: string } = {}
    const handler = registerPlatformEventsRoute(captured).get('/v1/events::csv')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { pageSize: '5000' },
      },
      res,
    )
    expect(captured.query).toContain('limit=1000')
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="events.csv"')
    expect(String(res.body)).toContain('eventId,occurredAt,eventType')
    expect(String(res.body).charCodeAt(0)).toBe(0xfeff)
  })
})

describe('GET /v1/events scope filters', () => {
  const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
  const otherResellerId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'
  const otherEnterpriseId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  const tenantRows = [
    { tenant_id: resellerId, tenant_type: 'RESELLER', parent_id: null },
    { tenant_id: otherResellerId, tenant_type: 'RESELLER', parent_id: null },
    { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId },
    { tenant_id: otherEnterpriseId, tenant_type: 'ENTERPRISE', parent_id: otherResellerId },
  ]

  it('reseller token defaults to token reseller when resellerId is omitted', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: {},
      },
      res,
    )
    expect(captured.query).toContain(`reseller_id=eq.${resellerId}`)
  })

  it('reseller token accepts matching resellerId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { resellerId },
      },
      res,
    )
    expect(captured.query).toContain(`reseller_id=eq.${resellerId}`)
    expect(captured.error).toBeUndefined()
  })

  it('reseller token rejects invalid resellerId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { resellerId: 'not-a-uuid' },
      },
      res,
    )
    expect(captured.error).toBe('400:BAD_REQUEST:resellerId must be a valid uuid.')
    expect(captured.query).toBeUndefined()
  })

  it('reseller token rejects matching resellerId when database record is missing', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, {
      tenantRows: tenantRows.filter((row) => row.tenant_id !== resellerId),
    }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { resellerId },
      },
      res,
    )
    expect(captured.error).toBe(`404:RESOURCE_NOT_FOUND:reseller ${resellerId} not found.`)
    expect(captured.query).toBeUndefined()
  })

  it('reseller token rejects mismatched resellerId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { resellerId: otherResellerId },
      },
      res,
    )
    expect(captured.error).toBe('403:FORBIDDEN:resellerId is out of token scope.')
    expect(captured.query).toBeUndefined()
  })

  it('reseller token accepts in-scope enterpriseId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { enterpriseId },
      },
      res,
    )
    expect(captured.query).toContain(`enterprise_id=eq.${enterpriseId}`)
    expect(captured.error).toBeUndefined()
  })

  it('reseller token rejects enterpriseId outside reseller scope', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { enterpriseId: otherEnterpriseId },
      },
      res,
    )
    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of reseller scope.')
    expect(captured.query).toBeUndefined()
  })

  it('customer token ignores resellerId but rejects mismatched enterpriseId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        query: { resellerId: otherResellerId, enterpriseId: otherEnterpriseId },
      },
      res,
    )
    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of token scope.')
    expect(captured.query).toBeUndefined()
  })

  it('customer token rejects invalid enterpriseId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        query: { enterpriseId: 'not-a-uuid' },
      },
      res,
    )
    expect(captured.error).toBe('400:BAD_REQUEST:enterpriseId must be a valid uuid.')
    expect(captured.query).toBeUndefined()
  })

  it('customer token rejects nonexistent enterpriseId', async () => {
    const missingEnterpriseId = 'cccccccc-3333-4333-8333-cccccccccccc'
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        query: { enterpriseId: missingEnterpriseId },
      },
      res,
    )
    expect(captured.error).toBe(`404:RESOURCE_NOT_FOUND:enterprise ${missingEnterpriseId} not found.`)
    expect(captured.query).toBeUndefined()
  })

  it('customer token accepts matching enterpriseId and ignores resellerId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        query: { resellerId: otherResellerId, enterpriseId },
      },
      res,
    )
    expect(captured.query).toContain(`enterprise_id=eq.${enterpriseId}`)
    expect(captured.query).not.toContain('reseller_id=eq.')
  })

  it('platform token verifies enterpriseId and resellerId match when both are provided', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId, enterpriseId },
      },
      res,
    )
    expect(captured.query).toContain(`enterprise_id=eq.${enterpriseId}`)
    expect(captured.query).toContain(`reseller_id=eq.${resellerId}`)
    expect(captured.error).toBeUndefined()
  })

  it('platform token rejects mismatched enterpriseId and resellerId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId, enterpriseId: otherEnterpriseId },
      },
      res,
    )
    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of reseller scope.')
    expect(captured.query).toBeUndefined()
  })

  it('platform token returns 404 for nonexistent resellerId', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerPlatformEventsRoute(captured, { tenantRows }).get('/v1/events')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId: 'cccccccc-3333-4333-8333-cccccccccccc' },
      },
      res,
    )
    expect(captured.error).toBe('404:RESOURCE_NOT_FOUND:reseller cccccccc-3333-4333-8333-cccccccccccc not found.')
    expect(captured.query).toBeUndefined()
  })
})

describe('GET /v1/events/catalog', () => {
  it('returns grouped event types for authenticated callers', async () => {
    const app = createMockApp()
    registerEventRoutes({
      app,
      prefix: '/v1',
      deps: {
        createSupabaseRestClient: () => ({
          select: vi.fn(async () => []),
          selectWithCount: vi.fn(async () => ({ data: [], total: 0 })),
        }),
        getTraceId: () => 'trace-1',
        sendError: () => {},
        getRoleScope: () => 'platform',
        getEnterpriseIdFromReq: () => null,
        resolveEnterpriseForReseller: async () => null,
        isValidUuid: () => true,
      },
    })
    const handler = app.routes.get('/v1/events/catalog')
    expect(handler).toBeTruthy()
    const res = createMockRes()
    await handler!(
      { cmpAuth: { roleScope: 'platform', role: 'platform_admin' }, query: {} },
      res,
    )
    expect(res.body).toEqual({
      categories: expect.arrayContaining([
        expect.objectContaining({ id: 'webhook', eventTypes: expect.arrayContaining(['SIM_STATUS_CHANGED']) }),
      ]),
    })
  })
})


