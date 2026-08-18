import { describe, expect, it, vi } from 'vitest'
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
  const res: { statusCode?: number; body?: unknown; send: (payload: unknown) => void } = {
    send(payload: unknown) {
      res.body = payload
    },
  }
  return res
}

describe('GET /events pagination', () => {
  it('applies page/pageSize defaults and returns pagination metadata', async () => {
    let capturedQuery = ''
    const app = createMockApp()
    registerEventRoutes({
      app,
      prefix: '/v1',
      deps: {
        createSupabaseRestClient: () => ({
          select: vi.fn(async () => []),
          selectWithCount: vi.fn(async (_table: string, queryString: string) => {
            capturedQuery = queryString
            return {
              data: [
                {
                  event_id: 'e1',
                  event_type: 'SIM_STATUS_CHANGED',
                  occurred_at: '2026-06-17T10:00:00.000Z',
                  tenant_id: null,
                  actor_user_id: null,
                  request_id: null,
                  job_id: null,
                  payload: {},
                },
              ],
              total: 42,
            }
          }),
        }),
        getTraceId: () => 'trace-1',
        sendError: (_res, status, code, message) => {
          throw new Error(`${status}:${code}:${message}`)
        },
        getRoleScope: () => 'platform',
        getEnterpriseIdFromReq: () => null,
        resolveEnterpriseForReseller: async () => null,
        isValidUuid: () => true,
      },
    })

    const handler = app.routes.get('/v1/events')
    expect(handler).toBeTruthy()
    const res = createMockRes()
    await handler!(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: {},
      },
      res,
    )

    expect(capturedQuery).toContain('limit=20')
    expect(capturedQuery).toContain('offset=0')
    expect(res.body).toEqual({
      items: [
        expect.objectContaining({ eventId: 'e1', eventType: 'SIM_STATUS_CHANGED' }),
      ],
      total: 42,
      page: 1,
      pageSize: 20,
    })
  })

  it('caps pageSize at 20 and uses offset for page 2', async () => {
    let capturedQuery = ''
    const app = createMockApp()
    registerEventRoutes({
      app,
      prefix: '/v1',
      deps: {
        createSupabaseRestClient: () => ({
          select: vi.fn(async () => []),
          selectWithCount: vi.fn(async (_table: string, queryString: string) => {
            capturedQuery = queryString
            return { data: [], total: 100 }
          }),
        }),
        getTraceId: () => 'trace-1',
        sendError: (_res, status, code, message) => {
          throw new Error(`${status}:${code}:${message}`)
        },
        getRoleScope: () => 'platform',
        getEnterpriseIdFromReq: () => null,
        resolveEnterpriseForReseller: async () => null,
        isValidUuid: () => true,
      },
    })

    const handler = app.routes.get('/v1/events')
    const res = createMockRes()
    await handler!(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { page: '2', pageSize: '50' },
      },
      res,
    )

    expect(capturedQuery).toContain('limit=20')
    expect(capturedQuery).toContain('offset=20')
    expect(res.body).toEqual({ items: [], total: 100, page: 2, pageSize: 20 })
  })
})
