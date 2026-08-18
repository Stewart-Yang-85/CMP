import { describe, expect, it } from 'vitest'
import { registerSimPhase4Routes } from '../src/routes/simPhase4.ts'

const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'
const otherEnterpriseId = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const missingEnterpriseId = 'dddddddd-1111-4111-8111-dddddddddddd'
const resellerId = '938ca03b-01c7-4f6a-bff6-9dbee00452a6'
const otherResellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const iccid = '89860123456789012345'
const subscriptionId = '11111111-1111-4111-8111-111111111111'
const addOnSubscriptionId = '11111111-1111-4111-8111-111111111112'
const packageId = '22222222-2222-4222-8222-222222222222'
const addOnPackageId = '22222222-2222-4222-8222-222222222223'
const pricePlanId = '33333333-3333-4333-8333-333333333333'
const addOnPricePlanId = '33333333-3333-4333-8333-333333333334'

function createMockApp() {
  const routes = new Map<string, (req: any, res: any) => Promise<void>>()
  const register = (method: string, path: string, args: any[]) => {
    const handler = args[args.length - 1]
    routes.set(`${method} ${path}`, handler)
  }
  return {
    routes,
    get(path: string, ...args: any[]) {
      register('GET', path, args)
    },
    post(path: string, ...args: any[]) {
      register('POST', path, args)
    },
    patch(path: string, ...args: any[]) {
      register('PATCH', path, args)
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

function parseEq(queryString: string, field: string): string | null {
  const match = queryString.match(new RegExp(`(?:^|&)${field}=eq\\.([^&]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function registerUsageRoute(captured: { error?: string; usageQuery?: string }, routeKey = 'GET /v1/sims/:iccid/usage') {
  const app = createMockApp()
  const supabase = {
    async select(table: string, queryString: string) {
      if (table === 'sims' && queryString.includes('select=reseller_id')) return []
      if (table === 'sims') {
        return [{
          sim_id: 'sim-1',
          iccid,
          enterprise_id: enterpriseId,
          department_id: null,
          reseller_id: otherResellerId,
          supplier_id: 'supplier-1',
          operator_id: 'operator-1',
        }]
      }
      if (table === 'tenants') {
        const id = parseEq(queryString, 'tenant_id')
        if (id === missingEnterpriseId) return []
        if (id === enterpriseId) {
          return [{ tenant_id: id, tenant_type: 'ENTERPRISE', parent_id: resellerId }]
        }
        if (id === otherEnterpriseId) {
          return [{ tenant_id: id, tenant_type: 'ENTERPRISE', parent_id: otherResellerId }]
        }
      }
      if (table === 'usage_package_daily_summary') {
        if (queryString.includes('sim_id=eq.sim-1')) {
          return [{
            subscription_id: subscriptionId,
            package_id: packageId,
            price_plan_id: pricePlanId,
            price_plan_type: 'FIXED_BUNDLE',
            in_profile_mb: 100,
            out_of_profile_mb: 0,
            total_mb: 100,
            usage_day: '2026-06-10',
          }]
        }
        if (queryString.includes(`package_id=eq.${packageId}`)) {
          return [
            { sim_id: 'sim-1', in_profile_mb: 100 },
            { sim_id: 'sim-2', in_profile_mb: 150 },
          ]
        }
        if (queryString.includes(`package_id=eq.${addOnPackageId}`)) {
          return []
        }
      }
      if (table === 'subscriptions') {
        return [
          { subscription_id: subscriptionId, package_id: packageId, state: 'ACTIVE' },
          { subscription_id: addOnSubscriptionId, package_id: addOnPackageId, state: 'ACTIVE' },
        ]
      }
      if (table === 'packages') {
        const id = parseEq(queryString, 'package_id')
        if (id === addOnPackageId) {
          return [{ package_id: addOnPackageId, name: 'June add-on', price_plan_id: addOnPricePlanId }]
        }
        return [{ package_id: packageId, name: 'June fixed bundle', price_plan_id: pricePlanId }]
      }
      if (table === 'price_plans') {
        const id = parseEq(queryString, 'price_plan_id')
        if (id === addOnPricePlanId) return [{ price_plan_id: addOnPricePlanId, type: 'ONE_TIME' }]
        return [{ price_plan_id: pricePlanId, type: 'FIXED_BUNDLE' }]
      }
      if (table === 'price_plan_fixed_bundle') {
        return [{ price_plan_id: pricePlanId, total_quota_mb: 1000 }]
      }
      if (table === 'price_plan_one_time') {
        return [{ price_plan_id: addOnPricePlanId, quota_mb: 500 }]
      }
      return []
    },
    async selectWithCount(table: string, queryString: string) {
      if (table === 'usage_package_daily_summary') {
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
    async delete() {
      return []
    },
  }

  registerSimPhase4Routes({
    app: app as any,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient: () => supabase as any,
      getTraceId: () => 'trace-1',
      sendError: (_reply: any, status: number, code: string, message: string) => {
        captured.error = `${status}:${code}:${message}`
        _reply.code(status).send({ code, message })
      },
      getRoleScope: (req: any) => req.cmpAuth?.roleScope ?? null,
      getEnterpriseIdFromReq: (req: any) => req.cmpAuth?.customerId ?? null,
      getDepartmentIdFromReq: (req: any) => req.cmpAuth?.departmentId ?? null,
      buildSimTenantFilter: () => '',
      ensureResellerAdmin: () => null,
      ensureResellerSales: () => null,
      ensureSubscriptionAccess: () => null,
      resolveEnterpriseForReseller: async () => null,
      resolveDepartmentForEnterprise: async () => null,
      normalizeIccid: (value: unknown) => String(value ?? '').trim(),
      isValidIccid: (value: unknown) => /^[0-9]{18,20}$/.test(String(value ?? '')),
      isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      readRequestBody: async () => Buffer.from(''),
      parseMultipartFormData: () => ({ fields: {}, files: {} }),
      toIsoDateTime: (value: unknown) => (value ? new Date(String(value)).toISOString() : null),
    },
  })
  return app.routes.get(routeKey)!
}

function registerSimPhase4Route(captured: { error?: string }) {
  const app = createMockApp()
  registerSimPhase4Routes({
    app: app as any,
    prefix: '/v1',
    deps: {
      createSupabaseRestClient: () => ({
        select: async () => [],
        selectWithCount: async () => ({ data: [], total: 0 }),
        insert: async () => [],
        update: async () => [],
        delete: async () => [],
      }) as any,
      getTraceId: () => 'trace-1',
      sendError: (_reply: any, status: number, code: string, message: string) => {
        captured.error = `${status}:${code}:${message}`
        _reply.code(status).send({ code, message })
      },
      getRoleScope: (req: any) => req.cmpAuth?.roleScope ?? null,
      getEnterpriseIdFromReq: (req: any) => req.cmpAuth?.customerId ?? null,
      getDepartmentIdFromReq: (req: any) => req.cmpAuth?.departmentId ?? null,
      buildSimTenantFilter: () => '',
      ensureResellerAdmin: (req: any, reply: any) => {
        if (req.cmpAuth?.roleScope === 'customer' || req.cmpAuth?.roleScope === 'department') {
          captured.error = '403:FORBIDDEN:Customer tokens are not permitted for this operation.'
          reply.code(403).send({ code: 'FORBIDDEN', message: 'Customer tokens are not permitted for this operation.' })
          return null
        }
        if (req.cmpAuth?.roleScope === 'reseller' && req.cmpAuth?.role === 'reseller_admin') {
          return { scope: 'reseller', roleScope: 'reseller', role: 'reseller_admin', resellerId: req.cmpAuth.resellerId }
        }
        return null
      },
      ensureResellerSales: () => null,
      ensureSubscriptionAccess: () => null,
      resolveEnterpriseForReseller: async () => null,
      resolveDepartmentForEnterprise: async () => null,
      normalizeIccid: (value: unknown) => String(value ?? '').trim(),
      isValidIccid: (value: unknown) => /^[0-9]{18,20}$/.test(String(value ?? '')),
      isValidUuid: (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value ?? '')),
      readRequestBody: async () => Buffer.from(''),
      parseMultipartFormData: () => ({ fields: {}, files: {} }),
      toIsoDateTime: (value: unknown) => (value ? new Date(String(value)).toISOString() : null),
    },
  })
  return app.routes
}

function customerUsageRequest(query: Record<string, unknown> = {}) {
  return {
    cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
    params: { iccid },
    query: {
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      ...query,
    },
  }
}

describe('GET /v1/sims/:iccid/usage customer enterpriseId validation', () => {
  it('allows customer token without enterpriseId', async () => {
    const captured: { error?: string; usageQuery?: string } = {}
    const handler = registerUsageRoute(captured)
    const reply = createReply()

    await handler(customerUsageRequest(), reply)

    expect(captured.error).toBeUndefined()
    expect(captured.usageQuery).toContain('limit=20')
    expect(reply.body).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 })
  })

  it('allows customer token with matching enterpriseId', async () => {
    const captured: { error?: string; usageQuery?: string } = {}
    const handler = registerUsageRoute(captured)
    const reply = createReply()

    await handler(customerUsageRequest({ enterpriseId }), reply)

    expect(captured.error).toBeUndefined()
    expect(captured.usageQuery).toContain('limit=20')
  })

  it('rejects customer token with unknown enterpriseId', async () => {
    const captured: { error?: string; usageQuery?: string } = {}
    const handler = registerUsageRoute(captured)
    const reply = createReply()

    await handler(customerUsageRequest({ enterpriseId: missingEnterpriseId }), reply)

    expect(captured.error).toBe(`404:RESOURCE_NOT_FOUND:enterprise ${missingEnterpriseId} not found.`)
    expect(captured.usageQuery).toBeUndefined()
  })

  it('rejects customer token with enterpriseId outside token scope', async () => {
    const captured: { error?: string; usageQuery?: string } = {}
    const handler = registerUsageRoute(captured)
    const reply = createReply()

    await handler(customerUsageRequest({ enterpriseId: otherEnterpriseId }), reply)

    expect(captured.error).toBe('403:FORBIDDEN:enterpriseId is out of token scope.')
    expect(captured.usageQuery).toBeUndefined()
  })

  it('exports customer usage as csv with larger page size cap', async () => {
    const captured: { error?: string; usageQuery?: string } = {}
    const handler = registerUsageRoute(captured, 'GET /v1/sims/:iccid/usage:csv')
    const reply = createReply()

    await handler(customerUsageRequest({ page: '2', pageSize: '5000' }), reply)

    expect(captured.error).toBeUndefined()
    expect(captured.usageQuery).toContain('limit=1000')
    expect(captured.usageQuery).toContain('offset=1000')
    expect(reply.headers['Content-Type']).toBe('text/csv; charset=utf-8')
    expect(reply.headers['Content-Disposition']).toBe(`attachment; filename="sim-usage-${iccid}.csv"`)
    expect(String(reply.body)).toContain('usagePackageSummaryId,supplierId,resellerId,enterpriseId')
  })
})

describe('GET /v1/sims/:iccid/quota-balance', () => {
  it('returns fixed bundle package quota balance after usage csv in SIM routes', async () => {
    const captured: { error?: string; usageQuery?: string } = {}
    const handler = registerUsageRoute(captured, 'GET /v1/sims/:iccid/quota-balance')
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        params: { iccid },
        query: { period: '2026-06', enterpriseId },
      },
      reply,
    )

    expect(captured.error).toBeUndefined()
    expect(reply.body).toMatchObject({
      iccid,
      period: '2026-06',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-06-30T23:59:59.999Z',
    })
    expect((reply.body as any).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subscriptionId,
        packageId,
        packageName: 'June fixed bundle',
        pricePlanId,
        pricePlanType: 'FIXED_BUNDLE',
        quotaScope: 'PACKAGE_SHARED',
        quotaMb: 1000,
        usedByThisSimMb: 100,
        usedByPackageMb: 250,
        remainingMb: 750,
        usagePercent: 25,
      }),
      expect.objectContaining({
        subscriptionId: addOnSubscriptionId,
        packageId: addOnPackageId,
        packageName: 'June add-on',
        pricePlanId: addOnPricePlanId,
        pricePlanType: 'ONE_TIME',
        quotaScope: 'SIM_DEDICATED',
        quotaMb: 500,
        usedByThisSimMb: 0,
        usedByPackageMb: 0,
        remainingMb: 500,
        usagePercent: 0,
      }),
    ]))
    expect((reply.body as any).items).toHaveLength(2)
  })

  it('rejects reseller token when SIM enterprise belongs to another reseller', async () => {
    const captured: { error?: string; usageQuery?: string } = {}
    const handler = registerUsageRoute(captured, 'GET /v1/sims/:iccid/quota-balance')
    const reply = createReply()

    await handler(
      {
        cmpAuth: {
          roleScope: 'reseller',
          role: 'reseller_admin',
          resellerId: otherResellerId,
        },
        params: { iccid },
        query: { period: '2026-06' },
      },
      reply,
    )

    expect(captured.error).toBe('403:FORBIDDEN:SIM does not belong to your reseller.')
    expect(reply.statusCode).toBe(403)
  })
})

describe('POST /v1/sims:batch-deactivate access control', () => {
  it('rejects customer token access', async () => {
    const captured: { error?: string } = {}
    const routes = registerSimPhase4Route(captured)
    const handler = routes.get('POST /v1/sims:batch-deactivate')!
    const reply = createReply()

    await handler(
      {
        cmpAuth: { roleScope: 'customer', role: 'customer_admin', customerId: enterpriseId },
        body: { enterpriseId, reason: 'suspended enterprise service interruption' },
      },
      reply,
    )

    expect(captured.error).toBe('403:FORBIDDEN:Customer tokens are not permitted for this operation.')
    expect(reply.statusCode).toBe(403)
  })
})
