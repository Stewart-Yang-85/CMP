import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSimImport } from '../src/services/simImport.js'
import { batchDeactivateSims, changeSimStatus, parseSimIdentifier } from '../src/services/simLifecycle.js'
import { createPricePlan } from '../src/services/pricePlan.js'
import { createPackage, publishPackage } from '../src/services/package.js'
import { createApnProfile, publishApnProfile } from '../src/services/networkProfile.js'
import { createSubscription, switchSubscription, cancelSubscription, listSimSubscriptions } from '../src/services/subscription.js'
import { createSupplierAdapter, negotiateChangePlanStrategy } from '../src/vendors/registry.js'

function parseQuery(queryString: string) {
  const parts = String(queryString || '').split('&').filter(Boolean)
  const filters: Array<{ field: string; op: string; value: string | string[] }> = []
  let limit: number | null = null
  let offset = 0
  let order: string | null = null
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx)
    const value = part.slice(idx + 1)
    if (key === 'select') continue
    if (key === 'limit') {
      const n = Number(value)
      limit = Number.isFinite(n) ? n : null
      continue
    }
    if (key === 'offset') {
      const n = Number(value)
      offset = Number.isFinite(n) ? n : 0
      continue
    }
    if (key === 'order') {
      order = decodeURIComponent(value)
      continue
    }
    const opIdx = value.indexOf('.')
    if (opIdx < 0) continue
    const op = value.slice(0, opIdx)
    const raw = value.slice(opIdx + 1)
    if (op === 'in') {
      const inner = raw.startsWith('(') && raw.endsWith(')') ? raw.slice(1, -1) : raw
      const values = inner.length ? inner.split(',').map((v) => decodeURIComponent(v)) : []
      filters.push({ field: key, op, value: values })
      continue
    }
    filters.push({ field: key, op, value: decodeURIComponent(raw) })
  }
  return { filters, limit, offset, order }
}

function applyFilters(rows: Record<string, any>[], filters: Array<{ field: string; op: string; value: string | string[] }>) {
  if (!filters.length) return rows
  return rows.filter((row) => {
    for (const f of filters) {
      const actual = row?.[f.field]
      if (f.op === 'eq') {
        if (String(actual ?? '') !== String(f.value ?? '')) return false
        continue
      }
      if (f.op === 'in') {
        const values = Array.isArray(f.value) ? f.value : []
        if (!values.includes(String(actual ?? ''))) return false
        continue
      }
      if (f.op === 'ilike') {
        const target = String(actual ?? '').toLowerCase()
        const pattern = String(f.value ?? '').toLowerCase()
        const token = pattern.replace(/%/g, '')
        if (!target.includes(token)) return false
        continue
      }
      if (f.op === 'gte') {
        const a = new Date(String(actual ?? '')).getTime()
        const b = new Date(String(f.value ?? '')).getTime()
        if (Number.isFinite(a) && Number.isFinite(b)) {
          if (a < b) return false
        } else {
          if (String(actual ?? '') < String(f.value ?? '')) return false
        }
        continue
      }
    }
    return true
  })
}

function sortRows(rows: Record<string, any>[], order: string | null) {
  if (!order) return rows
  const parts = order.split('.')
  const field = parts[0]
  const dir = parts[1]?.toLowerCase() === 'desc' ? -1 : 1
  return rows.slice().sort((a, b) => {
    const av = a?.[field]
    const bv = b?.[field]
    if (av === bv) return 0
    if (av === undefined || av === null) return 1
    if (bv === undefined || bv === null) return -1
    return av < bv ? -1 * dir : 1 * dir
  })
}

function createFakeSupabase(seed: Record<string, Record<string, any>[]> = {}) {
  const tables = new Map<string, Record<string, any>[]>()
  const ensureTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name) as Record<string, any>[]
  }
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((r) => ({ ...r })))
  }
  const getTable = (name: string) => ensureTable(name)
  const insertRow = (table: string, row: Record<string, any>) => {
    const nowIso = new Date().toISOString()
    if (table === 'jobs') {
      if (!row.job_id) row.job_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'sims') {
      if (!row.sim_id) row.sim_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'price_plans') {
      if (!row.price_plan_id) row.price_plan_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'price_plan_versions') {
      if (!row.price_plan_version_id) row.price_plan_version_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'packages') {
      if (!row.package_id) row.package_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'package_versions') {
      if (!row.package_version_id) row.package_version_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'apn_profiles') {
      if (!row.apn_profile_id) row.apn_profile_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
    }
    if (table === 'roaming_profiles') {
      if (!row.roaming_profile_id) row.roaming_profile_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
    }
    if (table === 'profile_versions') {
      if (!row.profile_version_id) row.profile_version_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'carriers') {
      if (!row.carrier_id) row.carrier_id = randomUUID()
    }
    if (table === 'sim_state_history') {
      if (!row.history_id) row.history_id = randomUUID()
    }
    if (table === 'events') {
      if (!row.event_id) row.event_id = randomUUID()
    }
    if (table === 'audit_logs') {
      if (!row.audit_id) row.audit_id = randomUUID()
    }
    if (table === 'subscriptions') {
      if (!row.subscription_id) row.subscription_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    return row
  }
  return {
    getTable,
    async select(table: string, queryString: string) {
      const { filters, limit, offset, order } = parseQuery(queryString)
      const rows = applyFilters(getTable(table), filters)
      const sorted = sortRows(rows, order)
      const sliced = sorted.slice(offset, limit ? offset + limit : undefined)
      return sliced.map((r) => ({ ...r }))
    },
    async selectWithCount(table: string, queryString: string) {
      const { filters, limit, offset, order } = parseQuery(queryString)
      const rows = applyFilters(getTable(table), filters)
      const total = rows.length
      const sorted = sortRows(rows, order)
      const sliced = sorted.slice(offset, limit ? offset + limit : undefined)
      return { data: sliced.map((r) => ({ ...r })), total }
    },
    async insert(table: string, rows: any, options: { returning?: 'minimal' | 'representation' } = {}) {
      const payload = Array.isArray(rows) ? rows : [rows]
      const inserted = payload.map((r) => insertRow(table, { ...r }))
      getTable(table).push(...inserted)
      if (options.returning === 'minimal') return null
      return inserted.map((r) => ({ ...r }))
    },
    async update(table: string, matchQueryString: string, patch: unknown, options: { returning?: 'minimal' | 'representation' } = {}) {
      const { filters } = parseQuery(matchQueryString)
      const rows = applyFilters(getTable(table), filters)
      const patchData = patch && typeof patch === 'object' ? (patch as Record<string, any>) : {}
      const updated = rows.map((row) => Object.assign(row, { ...patchData }))
      if (options.returning === 'minimal') return null
      return updated.map((r) => ({ ...r }))
    },
  }
}

describe('phase4', () => {
  const supplierId = '11111111-1111-1111-1111-111111111111'
  const carrierId = '22222222-2222-2222-2222-222222222222'
  const enterpriseId = '33333333-3333-3333-3333-333333333333'
  let supabase: ReturnType<typeof createFakeSupabase>

  beforeEach(() => {
    supabase = createFakeSupabase({
      suppliers: [{ supplier_id: supplierId }],
      supplier_carriers: [{ supplier_id: supplierId, carrier_id: carrierId }],
      tenants: [{ tenant_id: enterpriseId, enterprise_status: 'ACTIVE' }],
    })
  })

  it('imports sims via csv with idempotency', async () => {
    const csv = [
      'iccid,imsi,apn,operatorId,msisdn',
      `8986012345678901234,imsi1,apn1,${carrierId},123`,
      `8986012345678901235,imsi2,apn1,${carrierId},456`,
      '',
    ].join('\n')
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      enterpriseId,
      batchId: 'batch-001',
      traceId: 'trace-1',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId: 'reseller-1',
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(true)
    expect(supabase.getTable('sims').length).toBe(2)
    expect(supabase.getTable('jobs')[0]?.status).toBe('SUCCEEDED')
    expect(supabase.getTable('audit_logs').length).toBe(1)

    const dup = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      enterpriseId,
      batchId: 'batch-001',
      traceId: 'trace-2',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId: 'reseller-1',
      sourceIp: '127.0.0.1',
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) {
      expect(dup.code).toBe('DUPLICATE_BATCH')
    }
  })

  it('activates sim and records lifecycle artifacts', async () => {
    const simId = randomUUID()
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678901236',
      status: 'INVENTORY',
      enterprise_id: enterpriseId,
      activation_date: null,
    })
    const simIdentifier = parseSimIdentifier(simId)
    if (!simIdentifier.ok) {
      throw new Error('invalid sim identifier')
    }
    const result = await changeSimStatus({
      supabase,
      simIdentifier,
      tenantQs: '',
      action: 'SIM_ACTIVATE',
      newStatus: 'ACTIVATED',
      allowedFrom: new Set(['INVENTORY']),
      reason: null,
      idempotencyKey: null,
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId: 'reseller-1', roleScope: 'reseller' },
      traceId: 'trace-3',
      sourceIp: '127.0.0.1',
      commitmentExempt: false,
    })
    expect(result.ok).toBe(true)
    const sim = supabase.getTable('sims')[0]
    expect(sim.status).toBe('ACTIVATED')
    expect(sim.activation_date).toBeTruthy()
    expect(supabase.getTable('sim_state_history').length).toBe(1)
    expect(supabase.getTable('events').length).toBe(1)
    expect(supabase.getTable('audit_logs').length).toBe(1)
    expect(supabase.getTable('jobs')[0]?.status).toBe('SUCCEEDED')
  })

  it('blocks retire when commitment is active', async () => {
    const simId = randomUUID()
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678901237',
      status: 'ACTIVATED',
      enterprise_id: enterpriseId,
    })
    supabase.getTable('subscriptions').push({
      sim_id: simId,
      commitment_end_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    const simIdentifier = parseSimIdentifier(simId)
    if (!simIdentifier.ok) {
      throw new Error('invalid sim identifier')
    }
    const result = await changeSimStatus({
      supabase,
      simIdentifier,
      tenantQs: '',
      action: 'SIM_RETIRE',
      newStatus: 'RETIRED',
      allowedFrom: new Set(['ACTIVATED']),
      reason: 'retire',
      idempotencyKey: null,
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId: 'reseller-1', roleScope: 'reseller' },
      traceId: 'trace-4',
      sourceIp: '127.0.0.1',
      commitmentExempt: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('COMMITMENT_NOT_MET')
    }
    expect(supabase.getTable('jobs').length).toBe(0)
  })

  it('batch deactivates activated sims by enterprise', async () => {
    supabase.getTable('sims').push(
      {
        sim_id: randomUUID(),
        iccid: '8986012345678901238',
        status: 'ACTIVATED',
        enterprise_id: enterpriseId,
      },
      {
        sim_id: randomUUID(),
        iccid: '8986012345678901239',
        status: 'ACTIVATED',
        enterprise_id: enterpriseId,
      },
      {
        sim_id: randomUUID(),
        iccid: '8986012345678901240',
        status: 'INVENTORY',
        enterprise_id: enterpriseId,
      },
    )
    const result = await batchDeactivateSims({
      supabase,
      enterpriseId,
      reason: 'policy',
      idempotencyKey: null,
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId: 'reseller-1', roleScope: 'reseller' },
      traceId: 'trace-5',
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(true)
    const sims = supabase.getTable('sims')
    const deactivated = sims.filter((s) => s.status === 'DEACTIVATED')
    expect(deactivated.length).toBe(2)
    expect(supabase.getTable('sim_state_history').length).toBe(2)
    expect(supabase.getTable('audit_logs').length).toBe(3)
    expect(supabase.getTable('jobs')[0]?.status).toBe('SUCCEEDED')
  })
})

describe('phase5', () => {
  const supplierId = '11111111-1111-1111-1111-111111111111'
  const carrierId = '22222222-2222-2222-2222-222222222222'
  const enterpriseId = '33333333-3333-3333-3333-333333333333'
  let supabase: ReturnType<typeof createFakeSupabase>

  beforeEach(() => {
    supabase = createFakeSupabase({
      supplier_carriers: [{ supplier_id: supplierId, carrier_id: carrierId }],
    })
  })

  it('creates price plan and publishes package', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Bundle A',
        type: 'SIM_DEPENDENT_BUNDLE',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        paygRates: [{ zoneCode: 'Z1', countries: ['001-01'], ratePerKb: 0.01 }],
      },
    })
    expect(planResult.ok).toBe(true)
    const planVersionId = supabase.getTable('price_plan_versions')[0]?.price_plan_version_id
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package A',
        pricePlanVersionId: planVersionId,
        carrierServiceConfig: {
          supplierId,
          carrierId,
          apn: 'iot',
        },
      },
    })
    expect(packageResult.ok).toBe(true)
    const publishResult = await publishPackage({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishResult.ok).toBe(true)
  })

  it('blocks publish on PAYG conflicts', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Bundle Conflict',
        type: 'SIM_DEPENDENT_BUNDLE',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        paygRates: [
          { zoneCode: 'Z1', countries: ['001-01'], ratePerKb: 0.01 },
          { zoneCode: 'Z2', countries: ['001-01'], ratePerKb: 0.02 },
        ],
      },
    })
    expect(planResult.ok).toBe(true)
    const planVersionId = supabase.getTable('price_plan_versions')[0]?.price_plan_version_id
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package Conflict',
        pricePlanVersionId: planVersionId,
        carrierServiceConfig: {
          supplierId,
          carrierId,
          apn: 'iot',
        },
      },
    })
    expect(packageResult.ok).toBe(true)
    const publishResult = await publishPackage({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishResult.ok).toBe(false)
    expect((publishResult as any).code).toBe('PAYG_CONFLICT')
  })

  it('requires published apn profile version', async () => {
    const apnResult = await createApnProfile({
      supabase,
      payload: {
        name: 'APN Base',
        apn: 'apn1',
        supplierId,
        carrierId,
      },
    })
    expect(apnResult.ok).toBe(true)
    const apnProfileId = (apnResult as any).value.apnProfileId
    const apnProfileVersionId = (apnResult as any).value.profileVersionId
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Bundle APN',
        type: 'SIM_DEPENDENT_BUNDLE',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 2048,
        paygRates: [{ zoneCode: 'Z1', countries: ['001-01'], ratePerKb: 0.01 }],
      },
    })
    expect(planResult.ok).toBe(true)
    const planVersionId = supabase.getTable('price_plan_versions')[0]?.price_plan_version_id
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package APN',
        pricePlanVersionId: planVersionId,
        carrierServiceConfig: {
          supplierId,
          carrierId,
          apn: 'apn1',
          apnProfileVersionId,
        },
      },
    })
    expect(packageResult.ok).toBe(true)
    const publishResult = await publishPackage({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishResult.ok).toBe(false)
    expect((publishResult as any).code).toBe('PROFILE_VERSION_INVALID')
    const publishProfileResult = await publishApnProfile({ supabase, apnProfileId })
    expect(publishProfileResult.ok).toBe(true)
    const publishAfterProfile = await publishPackage({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishAfterProfile.ok).toBe(true)
  })

  it('creates one-time subscription with expiry and commitment', async () => {
    const simId = randomUUID()
    const pricePlanId = randomUUID()
    const pricePlanVersionId = randomUUID()
    const packageId = randomUUID()
    const packageVersionId = randomUUID()
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678909999',
      enterprise_id: enterpriseId,
      status: 'ACTIVATED',
    })
    supabase.getTable('price_plans').push({
      price_plan_id: pricePlanId,
      type: 'ONE_TIME',
    })
    supabase.getTable('price_plan_versions').push({
      price_plan_version_id: pricePlanVersionId,
      price_plan_id: pricePlanId,
      validity_days: 7,
      payg_rates: { meta: { expiryBoundary: 'CALENDAR_DAY_END' } },
    })
    supabase.getTable('packages').push({
      package_id: packageId,
      name: 'OneTime Plan',
      enterprise_id: enterpriseId,
    })
    supabase.getTable('package_versions').push({
      package_version_id: packageVersionId,
      package_id: packageId,
      status: 'PUBLISHED',
      price_plan_version_id: pricePlanVersionId,
      commercial_terms: { commitmentPeriodDays: 30 },
    })
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678909999',
      packageVersionId,
      kind: 'MAIN',
      effectiveAt: new Date().toISOString(),
      tenantFilter: '',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.state).toBe('ACTIVE')
      expect(result.value.expiresAt).toBeTruthy()
      expect(result.value.commitmentEndAt).toBeTruthy()
    }
  })

  it('prevents duplicate active main subscription', async () => {
    const simId = randomUUID()
    const packageVersionId = randomUUID()
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678908888',
      enterprise_id: enterpriseId,
      status: 'ACTIVATED',
    })
    supabase.getTable('package_versions').push({
      package_version_id: packageVersionId,
      status: 'PUBLISHED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: randomUUID(),
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'ACTIVE',
    })
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678908888',
      packageVersionId,
      kind: 'MAIN',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('MAIN_SUBSCRIPTION_EXISTS')
    }
  })

  it('switches main subscription for next cycle', async () => {
    const simId = randomUUID()
    const oldSubId = randomUUID()
    const packageVersionId = randomUUID()
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678907777',
      enterprise_id: enterpriseId,
      status: 'ACTIVATED',
    })
    supabase.getTable('package_versions').push({
      package_version_id: packageVersionId,
      status: 'PUBLISHED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: oldSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'ACTIVE',
      effective_at: new Date().toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678907777',
      newPackageVersionId: packageVersionId,
      effectiveStrategy: 'NEXT_CYCLE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(true)
    const oldSub = supabase.getTable('subscriptions').find((r) => r.subscription_id === oldSubId)
    expect(oldSub?.state).toBe('EXPIRED')
    const newSub = supabase.getTable('subscriptions').find((r) => r.subscription_id !== oldSubId)
    expect(newSub?.state).toBe('PENDING')
  })

  it('cancels subscription immediately', async () => {
    const subId = randomUUID()
    supabase.getTable('subscriptions').push({
      subscription_id: subId,
      enterprise_id: enterpriseId,
      state: 'ACTIVE',
    })
    const result = await cancelSubscription({
      supabase,
      enterpriseId,
      subscriptionId: subId,
      immediate: true,
    })
    expect(result.ok).toBe(true)
    const row = supabase.getTable('subscriptions').find((r) => r.subscription_id === subId)
    expect(row?.state).toBe('CANCELLED')
  })

  it('lists subscriptions with filters', async () => {
    const simId = randomUUID()
    const packageVersionId = randomUUID()
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678906666',
      enterprise_id: enterpriseId,
      status: 'ACTIVATED',
    })
    supabase.getTable('package_versions').push({
      package_version_id: packageVersionId,
      package_id: randomUUID(),
      status: 'PUBLISHED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: randomUUID(),
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'ACTIVE',
      effective_at: new Date().toISOString(),
      package_version_id: packageVersionId,
    })
    supabase.getTable('subscriptions').push({
      subscription_id: randomUUID(),
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'ADD_ON',
      state: 'CANCELLED',
      effective_at: new Date().toISOString(),
      package_version_id: packageVersionId,
    })
    const result = await listSimSubscriptions({
      supabase,
      enterpriseId,
      simIdentifier: { field: 'sim_id', value: simId },
      tenantFilter: '',
      state: 'ACTIVE',
      kind: 'MAIN',
      page: 1,
      pageSize: 10,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.items.length).toBe(1)
      expect(result.value.items[0]?.state).toBe('ACTIVE')
    }
  })
})

describe('phase12', () => {
  const wxSupplierId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const savedEnv = { ...process.env }

  beforeEach(() => {
    process.env.WXZHONGGENG_SUPPLIER_ID = wxSupplierId
    delete process.env.SUPPLIER_ADAPTERS
    delete process.env.SUPPLIER_ADAPTERS_JSON
    delete process.env.SUPPLIER_DEFAULT_ADAPTER
  })

  it('creates adapter via registry and negotiates future plan change', async () => {
    const adapter = createSupplierAdapter({ supplierId: wxSupplierId })
    expect(adapter).toBeTruthy()
    expect(adapter.capabilities).toBeTruthy()
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const strategy = negotiateChangePlanStrategy({ adapter, effectiveAt: future })
    expect(strategy.mode).toBe('VIRTUAL')
  })

  it('uses upstream mode for immediate plan change', async () => {
    const adapter = createSupplierAdapter({ supplierId: wxSupplierId })
    const now = new Date()
    const strategy = negotiateChangePlanStrategy({ adapter, effectiveAt: now })
    expect(strategy.mode).toBe('UPSTREAM')
  })

  it('returns not supported for changePlan when endpoint missing', async () => {
    const adapter = createSupplierAdapter({ supplierId: wxSupplierId })
    const result = await adapter.changePlan({
      iccid: '8986012345678901999',
      externalProductId: 'EXT-001',
      effectiveAt: new Date(),
      idempotencyKey: 'test-idem',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('NOT_SUPPORTED')
  })

  it('throws when adapter mapping is unknown', async () => {
    delete process.env.WXZHONGGENG_SUPPLIER_ID
    expect(() => createSupplierAdapter({ supplierId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).toThrow()
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      process.env[key] = value
    }
  })
})

describe('phase12:integration', () => {
  const savedEnv = { ...process.env }
  const supplierId = process.env.WXZHONGGENG_SUPPLIER_ID
  const iccid = process.env.SMOKE_SIM_ICCID
  const hasCredentials = Boolean(
    process.env.WXZHONGGENG_URL &&
      ((process.env.WXZHONGGENG_USERNAME && process.env.WXZHONGGENG_PASSWORD) ||
        (process.env.WXZHONGGENG_API_KEY && process.env.WXZHONGGENG_API_SECRET))
  )
  const hasProvisioningOps = Boolean(process.env.WXZHONGGENG_ACTIVATE_OP && process.env.WXZHONGGENG_SUSPEND_OP)
  const runProvisioning = iccid && hasCredentials && hasProvisioningOps ? it : it.skip
  const runUsage = iccid && hasCredentials ? it : it.skip

  beforeEach(() => {
    if (!process.env.SUPPLIER_DEFAULT_ADAPTER) {
      process.env.SUPPLIER_DEFAULT_ADAPTER = 'wxzhonggeng'
    }
  })

  runProvisioning('activates and suspends sim via upstream adapter', async () => {
    const adapter = createSupplierAdapter({ supplierId })
    const simIccid = iccid ?? ''
    const activate = await adapter.activateSim({ iccid: simIccid, idempotencyKey: `itest-${Date.now()}-activate` })
    expect(activate.ok).toBe(true)
    const suspend = await adapter.suspendSim({ iccid: simIccid, idempotencyKey: `itest-${Date.now()}-suspend` })
    expect(suspend.ok).toBe(true)
  }, 20000)

  runUsage('fetches daily usage via upstream adapter', async () => {
    const adapter = createSupplierAdapter({ supplierId })
    const simIccid = iccid ?? ''
    const date = new Date().toISOString().slice(0, 10)
    const usage = await adapter.getDailyUsage({ iccid: simIccid, date })
    expect(Array.isArray(usage)).toBe(true)
    if (usage.length) {
      expect(typeof usage[0]?.totalKb).toBe('number')
    }
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      process.env[key] = value
    }
  })
})
