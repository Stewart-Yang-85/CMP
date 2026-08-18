import { describe, expect, it, vi } from 'vitest'
import { registerAuditLogRoutes } from '../src/app.ts'

const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const otherResellerId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'

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

function registerAuditRoute(captured: { query?: string; error?: string }) {
  const app = createMockApp()
  registerAuditLogRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient: () => ({
        select: vi.fn(async (table: string, queryString: string) => {
          if (table === 'tenants' && queryString.includes('tenant_type=eq.RESELLER')) {
            const tenantId = queryString.match(/tenant_id=eq\.([^&]+)/)?.[1]
            if (decodeURIComponent(tenantId ?? '') === resellerId) return [{ tenant_id: resellerId }]
            if (decodeURIComponent(tenantId ?? '') === otherResellerId) return [{ tenant_id: otherResellerId }]
            return []
          }
          if (table === 'tenants' && queryString.includes('tenant_type=eq.ENTERPRISE')) {
            return [{ tenant_id: enterpriseId }]
          }
          if (table === 'users') return []
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
    },
  })
  return app.routes
}

describe('GET /audit-logs reseller scope', () => {
  it('caps pageSize at 20 and defaults resellerId from reseller token', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerAuditRoute(captured).get('/v1/audit-logs')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { pageSize: '50' },
      },
      res,
    )
    expect(captured.query).toContain('limit=20')
    expect(captured.query).toContain(`tenant_id=in.(${resellerId},${enterpriseId})`)
    expect(captured.error).toBeUndefined()
  })

  it('rejects resellerId that does not match reseller token', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerAuditRoute(captured).get('/v1/audit-logs')!
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

  it('exports CSV with pageSize capped at 1000', async () => {
    const captured: { query?: string; error?: string } = {}
    const handler = registerAuditRoute(captured).get('/v1/audit-logs::csv')!
    const res = createMockRes()
    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { pageSize: '5000' },
      },
      res,
    )
    expect(captured.query).toContain('limit=1000')
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="audit-logs.csv"')
    expect(String(res.body)).toContain('auditId,createdAt,actorLabel')
    expect(String(res.body).charCodeAt(0)).toBe(0xfeff)
  })
})
