import { describe, expect, it } from 'vitest'
import { registerAlertConfigRoutes } from '../src/routes/alertConfigs.ts'

const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'

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
    patch(path: string, handler: (req: any, res: any) => Promise<void>) {
      routes.set(`PATCH ${path}`, handler)
    },
  }
}

function createMockRes() {
  const res: {
    body?: unknown
    statusCode?: number
    send: (payload: unknown) => void
    code: (status: number) => typeof res
  } = {
    send(payload: unknown) {
      res.body = payload
    },
    code(status: number) {
      res.statusCode = status
      return res
    },
  }
  return res
}

function parseEq(queryString: string, field: string): string | null {
  const match = queryString.match(new RegExp(`(?:^|&)${field}=eq\\.([^&]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function registerRoutes(captured: { insertRow?: Record<string, unknown>; inserts?: Array<{ table: string; row: Record<string, unknown> }>; error?: string }) {
  const app = createMockApp()
  const supabase = {
    async select(table: string, queryString: string) {
      if (table === 'tenants') {
        const tenantId = parseEq(queryString, 'tenant_id')
        const tenantType = parseEq(queryString, 'tenant_type')
        if (tenantId === resellerId && tenantType === 'RESELLER') {
          return [{ tenant_id: resellerId, tenant_type: 'RESELLER' }]
        }
        return []
      }
      if (table === 'alert_rule_configs') return []
      return []
    },
    async selectWithCount() {
      return { data: [], total: 0 }
    },
    async insert(table: string, row: Record<string, unknown>) {
      captured.inserts = [...(captured.inserts ?? []), { table, row }]
      if (table === 'alert_rule_configs') {
        captured.insertRow = row
        return [{ ...row, config_id: 'cfg-new', version: row.version ?? 1 }]
      }
      return []
    },
    async update() {
      return []
    },
  }
  registerAlertConfigRoutes({
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

describe('Fastify alert-configs routes', () => {
  it('applies reseller token scope when reseller creates a config', async () => {
    const captured: { insertRow?: Record<string, unknown>; inserts?: Array<{ table: string; row: Record<string, unknown> }>; error?: string } = {}
    const handler = registerRoutes(captured).get('POST /v1/alert-configs')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        body: {
          scopeType: 'RESELLER',
          alertType: 'SILENT_SIM',
          enabled: true,
          severity: 'P3',
          thresholdValue: 24,
          thresholdUnit: 'HOURS',
        },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.insertRow?.scope_type).toBe('RESELLER')
    expect(captured.insertRow?.reseller_id).toBe(resellerId)
    expect(captured.insertRow?.enterprise_id).toBeNull()
    expect(captured.inserts?.map((entry) => entry.table)).toEqual(['alert_rule_configs', 'events', 'audit_logs'])
    expect(captured.inserts?.[1].row.event_type).toBe('ALERT_RULE_CONFIG_CHANGED')
    expect(captured.inserts?.[2].row.action).toBe('ALERT_RULE_CONFIG_UPSERT')
  })

  it('rejects reseller attempts to manage PLATFORM configs', async () => {
    const captured: { insertRow?: Record<string, unknown>; error?: string } = {}
    const handler = registerRoutes(captured).get('POST /v1/alert-configs')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        body: {
          scopeType: 'PLATFORM',
          alertType: 'POOL_USAGE_HIGH',
          severity: 'P2',
        },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:Reseller cannot manage PLATFORM alert configs.')
    expect(captured.insertRow).toBeUndefined()
  })
})
