import { describe, expect, it } from 'vitest'
import { registerAlertConfigurationRoutes } from '../src/routes/alertConfigurations.ts'

const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const otherResellerId = '99999999-9999-4999-8999-999999999999'
const enterpriseId = '33333333-3333-4333-8333-333333333333'
const profileId = '11111111-1111-4111-8111-111111111111'
const itemId = '22222222-2222-4222-8222-222222222222'

function fullResellerItems() {
  return [
    {
      alertType: 'SILENT_SIM',
      enabled: true,
      severity: 'P3',
      thresholdValue: 4320,
      thresholdUnit: 'HOURS',
      windowMinutes: 60,
      suppressMinutes: 30,
      deliveryChannels: ['PORTAL'],
      deliveryTargets: {},
      thresholdConfig: {},
    },
    {
      alertType: 'WEBHOOK_DELIVERY_FAILED',
      enabled: true,
      severity: 'P2',
      thresholdValue: 3,
      thresholdUnit: 'ATTEMPTS',
      windowMinutes: 60,
      suppressMinutes: 30,
      deliveryChannels: ['PORTAL', 'WEBHOOK'],
      deliveryTargets: {},
      thresholdConfig: {},
    },
  ]
}

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
    put(path: string, handler: (req: any, res: any) => Promise<void>) {
      routes.set(`PUT ${path}`, handler)
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

function registerRoutes(captured: { inserts?: Array<{ table: string; row: Record<string, unknown> }>; updates?: Array<{ table: string; match: string; patch: Record<string, unknown> }>; selectsWithCount?: Array<{ table: string; queryString: string }>; rpc?: Array<{ functionName: string; args?: Record<string, unknown> }>; error?: string }) {
  const app = createMockApp()
  const supabase = {
    async select(table: string, queryString: string) {
      if (table === 'alert_type_catalog') {
        if (queryString.includes('allowed_scope_types=cs.{RESELLER}')) {
          return [
            {
              alert_type: 'SILENT_SIM',
              enabled: true,
              allowed_scope_types: ['PLATFORM', 'RESELLER', 'ENTERPRISE'],
              default_severity: 'P3',
              default_threshold_value: 4320,
              default_threshold_unit: 'HOURS',
              default_window_minutes: 60,
              default_suppress_minutes: 30,
              default_delivery_channels: ['PORTAL'],
              default_delivery_targets: {},
              default_threshold_config: {},
              display_name: 'Silent SIM',
              sort_order: 30,
            },
            {
              alert_type: 'WEBHOOK_DELIVERY_FAILED',
              enabled: true,
              allowed_scope_types: ['PLATFORM', 'RESELLER'],
              default_severity: 'P2',
              default_threshold_value: 3,
              default_threshold_unit: 'ATTEMPTS',
              default_window_minutes: 60,
              default_suppress_minutes: 30,
              default_delivery_channels: ['PORTAL', 'WEBHOOK'],
              default_delivery_targets: {},
              default_threshold_config: {},
              display_name: 'Webhook delivery failed',
              sort_order: 70,
            },
          ]
        }
        if (queryString.includes('alert_type=eq.SILENT_SIM')) {
          return [{
            alert_type: 'SILENT_SIM',
            enabled: true,
            allowed_scope_types: ['PLATFORM', 'RESELLER', 'ENTERPRISE'],
            default_severity: 'P3',
            default_threshold_value: 4320,
            default_threshold_unit: 'HOURS',
            default_window_minutes: 60,
            default_suppress_minutes: 30,
            default_delivery_channels: ['PORTAL'],
            default_delivery_targets: {},
            default_threshold_config: {},
            display_name: 'Silent SIM',
            sort_order: 30,
          }]
        }
        if (queryString.includes('alert_type=eq.WEBHOOK_DELIVERY_FAILED')) {
          return [{
            alert_type: 'WEBHOOK_DELIVERY_FAILED',
            enabled: true,
            allowed_scope_types: ['PLATFORM', 'RESELLER'],
            default_severity: 'P2',
            default_threshold_value: 3,
            default_threshold_unit: 'ATTEMPTS',
            default_window_minutes: 60,
            default_suppress_minutes: 30,
            default_delivery_channels: ['PORTAL', 'WEBHOOK'],
            default_delivery_targets: {},
            default_threshold_config: {},
            display_name: 'Webhook delivery failed',
            sort_order: 70,
          }]
        }
        return []
      }
      if (table === 'alert_config_profiles') {
        if (queryString.includes('config_profile_id=eq.')) {
          return [{
            config_profile_id: profileId,
            scope_type: 'RESELLER',
            reseller_id: resellerId,
            enterprise_id: null,
            status: 'ACTIVE',
            name: 'Reseller alerts',
            version: 1,
          }]
        }
        return []
      }
      if (table === 'alert_config_items') {
        return fullResellerItems().map((item, index) => ({
          config_item_id: index === 0 ? itemId : '33333333-3333-4333-8333-333333333333',
          config_profile_id: profileId,
          alert_type: item.alertType,
          enabled: item.enabled,
          severity: item.severity,
          threshold_value: item.thresholdValue,
          threshold_unit: item.thresholdUnit,
          window_minutes: item.windowMinutes,
          suppress_minutes: item.suppressMinutes,
          delivery_channels: item.deliveryChannels,
          delivery_targets: item.deliveryTargets,
          threshold_config: item.thresholdConfig,
          version: 1,
        }))
      }
      if (table === 'tenants') {
        if (queryString.includes('tenant_type=eq.RESELLER')) {
          if (queryString.includes(`tenant_id=eq.${resellerId}`)) return [{ tenant_id: resellerId, tenant_type: 'RESELLER' }]
          if (queryString.includes(`tenant_id=eq.${otherResellerId}`)) return [{ tenant_id: otherResellerId, tenant_type: 'RESELLER' }]
          return []
        }
        if (queryString.includes('tenant_type=eq.ENTERPRISE')) {
          if (queryString.includes(`tenant_id=eq.${enterpriseId}`)) return [{ tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId }]
          return []
        }
      }
      return []
    },
    async selectWithCount(table: string, queryString: string) {
      captured.selectsWithCount = [...(captured.selectsWithCount ?? []), { table, queryString }]
      if (table === 'alert_config_profiles') return { data: [], total: 0 }
      return { data: [], total: 0 }
    },
    async insert(table: string, row: Record<string, unknown>) {
      captured.inserts = [...(captured.inserts ?? []), { table, row }]
      if (table === 'alert_config_profiles') {
        return [{ ...row, config_profile_id: profileId }]
      }
      if (table === 'alert_config_items') {
        return [{ ...row, config_item_id: '22222222-2222-4222-8222-222222222222' }]
      }
      return []
    },
    async update(table: string, match: string, patch: Record<string, unknown>) {
      captured.updates = [...(captured.updates ?? []), { table, match, patch }]
      return []
    },
    async rpc(functionName: string, args?: Record<string, unknown>) {
      captured.rpc = [...(captured.rpc ?? []), { functionName, args }]
      return { profileId }
    },
  }
  registerAlertConfigurationRoutes({
    app,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient: () => supabase,
      getTraceId: () => 'trace-abc',
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

describe('Fastify alert configuration ABC routes', () => {
  it('lists alert type catalog items for platform users', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-types')!
    const res = createMockRes()

    await handler({ cmpAuth: { roleScope: 'platform', role: 'platform_admin' }, query: { alertType: 'SILENT_SIM' } }, res)

    expect(captured.error).toBeUndefined()
    expect((res.body as any).items[0].alertType).toBe('SILENT_SIM')
  })

  it('rejects reseller access to alert type catalog', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-types')!
    const res = createMockRes()

    await handler({ cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId }, query: {} }, res)

    expect(captured.error).toBe('403:FORBIDDEN:Platform scope required.')
  })

  it('paginates alert config profiles with default max pageSize 20', async () => {
    const captured: { selectsWithCount?: Array<{ table: string; queryString: string }>; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { page: '2', pageSize: '500' },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.selectsWithCount?.[0].queryString).toContain('limit=20')
    expect(captured.selectsWithCount?.[0].queryString).toContain('offset=20')
    expect((res.body as any).page).toBe(2)
    expect((res.body as any).pageSize).toBe(20)
  })

  it('rejects reseller list filters with resellerId outside token scope', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { resellerId: otherResellerId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:resellerId is out of token scope.')
  })

  it('rejects reseller list filters with enterpriseId outside token reseller', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId: otherResellerId },
        query: { enterpriseId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of reseller scope.')
  })

  it('rejects platform list filters with mismatched resellerId and enterpriseId', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId: otherResellerId, enterpriseId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of reseller scope.')
  })

  it('accepts platform list filters with matching resellerId and enterpriseId', async () => {
    const captured: { selectsWithCount?: Array<{ table: string; queryString: string }>; error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { resellerId, enterpriseId },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.selectsWithCount?.[0].queryString).toContain(`reseller_id=eq.${resellerId}`)
    expect(captured.selectsWithCount?.[0].queryString).toContain(`enterprise_id=eq.${enterpriseId}`)
  })

  it('rejects reseller effective query with resellerId outside token scope', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles/effective')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { alertType: 'SILENT_SIM', resellerId: otherResellerId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:resellerId is out of token scope.')
  })

  it('rejects reseller effective query with enterpriseId outside token reseller', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles/effective')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId: otherResellerId },
        query: { alertType: 'SILENT_SIM', enterpriseId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of reseller scope.')
  })

  it('rejects platform effective query with enterpriseId but no resellerId', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles/effective')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { alertType: 'SILENT_SIM', enterpriseId },
      },
      res,
    )

    expect(captured.error).toBe('400:BAD_REQUEST:resellerId is required when enterpriseId is provided.')
  })

  it('rejects platform effective query with mismatched resellerId and enterpriseId', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles/effective')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { alertType: 'SILENT_SIM', resellerId: otherResellerId, enterpriseId },
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of reseller scope.')
  })

  it('accepts platform effective query with matching resellerId and enterpriseId', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles/effective')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        query: { alertType: 'SILENT_SIM', resellerId, enterpriseId },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect((res.body as any).alertType).toBe('SILENT_SIM')
  })

  it('uses request body alertType as the patch target', async () => {
    const captured: { updates?: Array<{ table: string; match: string; patch: Record<string, unknown> }>; error?: string } = {}
    const handler = registerRoutes(captured).get('PATCH /v1/alert-types/:alertType')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'platform', role: 'platform_admin' },
        params: { alertType: 'POOL_USAGE_HIGH' },
        body: {
          alertType: 'WEBHOOK_DELIVERY_FAILED',
          enabled: true,
          defaultThresholdValue: 3,
          defaultThresholdUnit: 'ATTEMPTS',
          defaultDeliveryChannels: ['PORTAL', 'WEBHOOK'],
          displayName: 'Webhook delivery failed',
        },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.updates?.[0].table).toBe('alert_type_catalog')
    expect(captured.updates?.[0].match).toBe('alert_type=eq.WEBHOOK_DELIVERY_FAILED')
    expect((res.body as any).alertType).toBe('WEBHOOK_DELIVERY_FAILED')
  })

  it('creates full reseller-scoped profiles from reseller token scope', async () => {
    const captured: { rpc?: Array<{ functionName: string; args?: Record<string, unknown> }>; error?: string } = {}
    const handler = registerRoutes(captured).get('POST /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { scopeType: 'RESELLER', resellerId },
        body: { name: 'Reseller alerts', items: fullResellerItems() },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(res.statusCode).toBe(201)
    expect(captured.rpc?.[0].functionName).toBe('replace_alert_config_profile_with_items')
    expect(captured.rpc?.[0].args?.p_profile_id).toBeNull()
    expect(captured.rpc?.[0].args?.p_reseller_id).toBe(resellerId)
    expect(captured.rpc?.[0].args?.p_items).toHaveLength(2)
    expect((res.body as any).items).toHaveLength(2)
  })

  it('gets alert config profile details with all items', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles/:profileId')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        params: { profileId },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect((res.body as any).profileId).toBe(profileId)
    expect((res.body as any).items).toHaveLength(2)
  })

  it('replaces full alert config profile through PUT', async () => {
    const captured: { rpc?: Array<{ functionName: string; args?: Record<string, unknown> }>; error?: string } = {}
    const handler = registerRoutes(captured).get('PUT /v1/alert-config-profiles/:profileId')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        params: { profileId },
        query: { scopeType: 'RESELLER', resellerId },
        body: { name: 'Updated reseller alerts', items: fullResellerItems() },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.rpc?.[0].functionName).toBe('replace_alert_config_profile_with_items')
    expect(captured.rpc?.[0].args?.p_profile_id).toBe(profileId)
    expect(captured.rpc?.[0].args?.p_name).toBe('Updated reseller alerts')
    expect((res.body as any).items).toHaveLength(2)
  })

  it('uses query scope identity instead of body scope identity for profile writes', async () => {
    const captured: { rpc?: Array<{ functionName: string; args?: Record<string, unknown> }>; error?: string } = {}
    const handler = registerRoutes(captured).get('POST /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { scopeType: 'RESELLER', resellerId },
        body: {
          scopeType: 'PLATFORM',
          resellerId: '99999999-9999-4999-8999-999999999999',
          name: 'Reseller alerts',
          items: fullResellerItems(),
        },
      },
      res,
    )

    expect(captured.error).toBeUndefined()
    expect(captured.rpc?.[0].args?.p_scope_type).toBe('RESELLER')
    expect(captured.rpc?.[0].args?.p_reseller_id).toBe(resellerId)
  })

  it('requires resellerId query parameter for reseller-scoped writes', async () => {
    const captured: { rpc?: Array<{ functionName: string; args?: Record<string, unknown> }>; error?: string } = {}
    const handler = registerRoutes(captured).get('POST /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'reseller', role: 'reseller_admin', resellerId },
        query: { scopeType: 'RESELLER' },
        body: { name: 'Reseller alerts', items: fullResellerItems() },
      },
      res,
    )

    expect(captured.error).toBe('400:BAD_REQUEST:resellerId is required for reseller-scoped writes.')
    expect(captured.rpc).toBeUndefined()
  })

  it('does not register item-level alert config routes', async () => {
    const routes = registerRoutes({})

    expect(routes.has('GET /v1/alert-config-profiles/:profileId/items')).toBe(false)
    expect(routes.has('PUT /v1/alert-config-profiles/:profileId/items/:alertType')).toBe(false)
    expect(routes.has('PATCH /v1/alert-config-profiles/:profileId/items/:alertType')).toBe(false)
    expect(routes.has('PATCH /v1/alert-config-profiles/:profileId')).toBe(false)
    expect(routes.has('PUT /v1/alert-config-profiles/:profileId')).toBe(true)
  })

  it('rejects customer token access to configuration management', async () => {
    const captured: { error?: string } = {}
    const handler = registerRoutes(captured).get('GET /v1/alert-config-profiles')!
    const res = createMockRes()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: '33333333-3333-4333-8333-333333333333' },
        query: {},
      },
      res,
    )

    expect(captured.error).toBe('403:FORBIDDEN:Platform or reseller scope required.')
  })

  it('rejects enterprise token access to every Alert Configurations endpoint', async () => {
    const enterpriseAuth = {
      roleScope: 'enterprise',
      role: 'enterprise_admin',
      customerId: '33333333-3333-4333-8333-333333333333',
    }
    const cases = [
      {
        key: 'GET /v1/alert-types',
        req: { cmpAuth: enterpriseAuth, query: { alertType: 'SILENT_SIM' } },
        expected: '403:FORBIDDEN:Platform scope required.',
      },
      {
        key: 'PATCH /v1/alert-types/:alertType',
        req: { cmpAuth: enterpriseAuth, params: { alertType: 'SILENT_SIM' }, body: { alertType: 'SILENT_SIM' } },
        expected: '403:FORBIDDEN:Platform scope required.',
      },
      {
        key: 'GET /v1/alert-config-profiles',
        req: { cmpAuth: enterpriseAuth, query: {} },
        expected: '403:FORBIDDEN:Platform or reseller scope required.',
      },
      {
        key: 'POST /v1/alert-config-profiles',
        req: { cmpAuth: enterpriseAuth, query: { scopeType: 'ENTERPRISE', resellerId, enterpriseId: enterpriseAuth.customerId }, body: { items: fullResellerItems() } },
        expected: '403:FORBIDDEN:Platform or reseller scope required.',
      },
      {
        key: 'GET /v1/alert-config-profiles/effective',
        req: { cmpAuth: enterpriseAuth, query: { alertType: 'SILENT_SIM', enterpriseId: enterpriseAuth.customerId } },
        expected: '403:FORBIDDEN:Platform or reseller scope required.',
      },
      {
        key: 'GET /v1/alert-config-profiles/:profileId',
        req: { cmpAuth: enterpriseAuth, params: { profileId } },
        expected: '403:FORBIDDEN:Platform or reseller scope required.',
      },
      {
        key: 'PUT /v1/alert-config-profiles/:profileId',
        req: { cmpAuth: enterpriseAuth, params: { profileId }, query: { scopeType: 'ENTERPRISE', resellerId, enterpriseId: enterpriseAuth.customerId }, body: { items: fullResellerItems() } },
        expected: '403:FORBIDDEN:Platform or reseller scope required.',
      },
    ]

    for (const item of cases) {
      const captured: { error?: string } = {}
      const routes = registerRoutes(captured)
      const handler = routes.get(item.key)!
      const res = createMockRes()
      await handler(item.req, res)
      expect(captured.error).toBe(item.expected)
    }
  })
})
