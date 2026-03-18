import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSimImport } from '../src/services/simImport.js'
import { batchChangeSimStatus, batchDeactivateSims, changeSimStatus, parseSimIdentifier } from '../src/services/simLifecycle.js'
import { createPricePlan, createPricePlanVersion } from '../src/services/pricePlan.js'
import {
  createCarrierService,
  createCommercialTerms,
  createControlPolicy,
  createPackage,
  getPackageDetail,
  getCarrierServiceDetail,
  getCommercialTermsDetail,
  getControlPolicyDetail,
  listCarrierServices,
  listPackagesByModuleRefs,
  publishPackage,
  updateCarrierService,
  updateCommercialTerms,
  updateControlPolicy,
  validateCarrierServiceModule,
  validateCommercialTermsModule,
  validateControlPolicyModule,
} from '../src/services/package.js'
import {
  createApnProfile,
  createRoamingProfile,
  deriveRoamingProfileVersion,
  getApnProfileDetail,
  listApnProfiles,
  listRoamingProfileEntries,
  listRoamingProfiles,
  patchRoamingProfileEntries,
  publishApnProfile,
  publishRoamingProfile,
} from '../src/services/networkProfile.js'
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
    if (table === 'commercial_terms_modules') {
      if (!row.commercial_terms_id) row.commercial_terms_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
    }
    if (table === 'control_policy_modules') {
      if (!row.control_policy_id) row.control_policy_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
    }
    if (table === 'carrier_service_modules') {
      if (!row.carrier_service_id) row.carrier_service_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
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

function preparePackageModules({
  supabase,
  supplierId,
  operatorId,
  apnProfileVersionId,
}: {
  supabase: ReturnType<typeof createFakeSupabase>
  supplierId: string
  operatorId: string
  apnProfileVersionId?: string
}) {
  const roamingProfileVersionId = randomUUID()
  supabase.getTable('profile_versions').push({
    profile_version_id: roamingProfileVersionId,
    profile_type: 'ROAMING',
    profile_id: randomUUID(),
    version: 1,
    status: 'PUBLISHED',
    config: { mccmncList: ['001-01'] },
  })
  return {
    commercialTerms: {
      testPeriodDays: 7,
      testQuotaKb: 1024,
      testExpiryCondition: 'PERIOD_OR_QUOTA',
      testExpiryAction: 'DEACTIVATED',
    },
    controlPolicy: {
      enabled: true,
      cutoffThresholdMb: 512,
    },
    carrierServiceConfig: {
      supplierId,
      operatorId,
      apn: 'iot',
      roamingProfileVersionId,
      ...(apnProfileVersionId ? { apnProfileVersionId } : {}),
    },
  }
}

describe('phase4', () => {
  const supplierId = '11111111-1111-1111-1111-111111111111'
  const operatorId = '22222222-2222-2222-2222-222222222222'
  const carrierId = '99999999-9999-9999-9999-999999999999'
  const enterpriseId = '33333333-3333-3333-3333-333333333333'
  const resellerId = 'reseller-1'
  let supabase: ReturnType<typeof createFakeSupabase>

  beforeEach(() => {
    supabase = createFakeSupabase({
      suppliers: [{ supplier_id: supplierId }],
      operators: [{ operator_id: operatorId, supplier_id: supplierId, carrier_id: carrierId }],
      business_operators: [{ operator_id: operatorId, mcc: '001', mnc: '01', name: 'Operator A' }],
      reseller_suppliers: [{ reseller_id: resellerId, supplier_id: supplierId }],
      tenants: [{ tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', enterprise_status: 'ACTIVE' }],
    })
  })

  it('imports sims via csv with idempotency', async () => {
    const csv = [
      'iccid,imsi,msisdn',
      '8986012345678901234,imsi1,123',
      '8986012345678901235,imsi2,456',
      '',
    ].join('\n')
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      apn: 'apn1',
      operatorId,
      enterpriseId: null,
      batchId: 'batch-001',
      traceId: 'trace-1',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId,
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(true)
    expect(supabase.getTable('sims').length).toBe(2)
    expect(supabase.getTable('sims').every((sim: any) => sim.enterprise_id === null)).toBe(true)
    expect(supabase.getTable('sims').every((sim: any) => sim.reseller_id === resellerId)).toBe(true)
    expect(supabase.getTable('jobs')[0]?.status).toBe('SUCCEEDED')
    expect(supabase.getTable('audit_logs').length).toBe(1)

    const dup = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      apn: 'apn1',
      operatorId,
      enterpriseId: null,
      batchId: 'batch-001',
      traceId: 'trace-2',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId,
      sourceIp: '127.0.0.1',
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) {
      expect(dup.code).toBe('DUPLICATE_BATCH')
    }
  })

  it('rejects import when supplier is not linked to reseller', async () => {
    const csv = [
      'iccid,imsi',
      '8986012345678901277,imsi-no-binding',
      '',
    ].join('\n')
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      apn: 'apn1',
      operatorId,
      enterpriseId: null,
      batchId: 'batch-unbound-reseller-001',
      traceId: 'trace-unbound-reseller-1',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId: 'reseller-unbound',
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_SUPPLIER')
    }
  })

  it('accepts business operator id linked by operators relation', async () => {
    const mappedOperatorId = '44444444-4444-4444-4444-444444444444'
    supabase.getTable('operators').splice(0, 1, {
      operator_id: operatorId,
      business_operator_id: mappedOperatorId,
      supplier_id: supplierId,
      carrier_id: carrierId,
    })
    supabase.getTable('business_operators').splice(0, 1, {
      operator_id: mappedOperatorId,
      mcc: '001',
      mnc: '01',
      name: 'Operator A',
    })
    const csv = [
      'iccid,imsi',
      '8986012345678901288,imsi-mapped-1',
      '',
    ].join('\n')
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      apn: 'apn1',
      operatorId: mappedOperatorId,
      enterpriseId: null,
      batchId: 'batch-mapped-operator-001',
      traceId: 'trace-mapped-operator-1',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId,
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(true)
    const sim = supabase.getTable('sims')[0]
    expect(sim?.operator_id).toBe(operatorId)
    expect(supabase.getTable('jobs')[0]?.status).toBe('SUCCEEDED')
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

  it('batch retires sims with per-item results', async () => {
    const simOk = randomUUID()
    const simBlocked = randomUUID()
    supabase.getTable('sims').push(
      {
        sim_id: simOk,
        iccid: '8986012345678902001',
        status: 'DEACTIVATED',
        enterprise_id: enterpriseId,
      },
      {
        sim_id: simBlocked,
        iccid: '8986012345678902002',
        status: 'DEACTIVATED',
        enterprise_id: enterpriseId,
      }
    )
    supabase.getTable('subscriptions').push({
      sim_id: simBlocked,
      commitment_end_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    })
    const result = await batchChangeSimStatus({
      supabase,
      simIds: [simOk, '8986012345678902002', 'bad-id'],
      tenantQs: '',
      enterpriseId,
      action: 'RETIRE',
      reason: 'cleanup',
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId: 'reseller-1', roleScope: 'reseller' },
      traceId: 'trace-6',
      sourceIp: '127.0.0.1',
      commitmentExempt: false,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.total).toBe(3)
      expect(result.succeeded).toBe(1)
      expect(result.failed).toBe(2)
      const sims = supabase.getTable('sims')
      const retired = sims.filter((s) => s.status === 'RETIRED')
      expect(retired.length).toBe(1)
      const blocked = result.items.find((item) => item.errorCode === 'COMMITMENT_NOT_MET')
      expect(blocked).toBeTruthy()
      const invalid = result.items.find((item) => item.errorCode === 'INVALID_SIM_ID')
      expect(invalid).toBeTruthy()
      const audits = supabase.getTable('audit_logs')
      const summary = audits.find((a) => a.action === 'SIM_BATCH_STATUS_CHANGE')
      expect(summary?.before_data?.requested?.total).toBe(3)
      const invalidAudit = audits.find((a) => a.target_id === 'bad-id' && a.action === 'SIM_BATCH_STATUS_CHANGE_RESULT')
      expect(invalidAudit?.before_data?.input).toBe('bad-id')
      const events = supabase.getTable('events')
      expect(events.length).toBe(4)
      const summaryEvent = events.find((e) => e.event_type === 'SIM_BATCH_STATUS_CHANGE')
      expect(summaryEvent?.payload?.beforeData?.requested?.total).toBe(3)
    }
  })
})

describe('phase5', () => {
  const supplierId = '11111111-1111-1111-1111-111111111111'
  const operatorId = '22222222-2222-2222-2222-222222222222'
  const carrierId = '99999999-9999-9999-9999-999999999999'
  const enterpriseId = '33333333-3333-3333-3333-333333333333'
  const resellerId = '55555555-5555-5555-5555-555555555555'
  let supabase: ReturnType<typeof createFakeSupabase>

  beforeEach(() => {
    supabase = createFakeSupabase({
      operators: [{ operator_id: operatorId, supplier_id: supplierId, carrier_id: carrierId }],
      business_operators: [{ operator_id: operatorId, mcc: '001', mnc: '01', name: 'Operator A' }],
    })
  })

  it('creates apn profile with business operator id mapped to supplier operator', async () => {
    const mappedOperatorId = '44444444-4444-4444-4444-444444444444'
    supabase.getTable('operators').splice(0, 1, {
      operator_id: operatorId,
      business_operator_id: mappedOperatorId,
      supplier_id: supplierId,
      carrier_id: carrierId,
    })
    supabase.getTable('business_operators').splice(0, 1, {
      operator_id: mappedOperatorId,
      mcc: '001',
      mnc: '01',
      name: 'Operator A',
    })
    const result = await createApnProfile({
      supabase,
      payload: {
        name: 'APN mapped',
        apn: 'iot',
        supplierId,
        operatorId: mappedOperatorId,
      },
    })
    expect(result.ok).toBe(true)
    const row = supabase.getTable('apn_profiles')[0]
    expect(row?.operator_id).toBe(operatorId)
  })

  it('rejects apn profile creation when operatorId is empty', async () => {
    const result = await createApnProfile({
      supabase,
      payload: {
        name: 'APN no operator',
        apn: 'iot',
        supplierId,
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('operatorId is required.')
    }
  })

  it('rejects apn profile creation when operatorId is invalid', async () => {
    const result = await createApnProfile({
      supabase,
      payload: {
        name: 'APN invalid operator',
        apn: 'iot',
        supplierId,
        operatorId: 'not-a-uuid',
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('operatorId must be a valid uuid.')
    }
  })

  it('lists apn profiles by supplier and backfills from sims apn data', async () => {
    supabase.getTable('sims').push({
      sim_id: randomUUID(),
      iccid: '8986012345678906661',
      apn: 'iot',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'INVENTORY',
    })
    const result = await listApnProfiles({
      supabase,
      supplierId,
      page: 1,
      pageSize: 20,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.total).toBeGreaterThan(0)
      expect((result.value.items[0] as any)?.operatorId).toBe(operatorId)
      expect((result.value.items[0] as any)?.carrierId).toBeUndefined()
    }
    expect(supabase.getTable('apn_profiles').length).toBeGreaterThan(0)
  })

  it('lists apn profiles with business operatorId in response', async () => {
    const mappedOperatorId = '44444444-4444-4444-4444-444444444444'
    supabase.getTable('operators').splice(0, 1, {
      operator_id: operatorId,
      business_operator_id: mappedOperatorId,
      supplier_id: supplierId,
      carrier_id: carrierId,
    })
    const createResult = await createApnProfile({
      supabase,
      payload: {
        name: 'APN mapped list',
        apn: 'mapped.list.apn',
        supplierId,
        operatorId: mappedOperatorId,
      },
    })
    expect(createResult.ok).toBe(true)
    const listResult = await listApnProfiles({
      supabase,
      operatorId: mappedOperatorId,
      page: 1,
      pageSize: 20,
    })
    expect(listResult.ok).toBe(true)
    if (listResult.ok) {
      expect(listResult.value.total).toBeGreaterThan(0)
      expect((listResult.value.items[0] as any)?.operatorId).toBe(mappedOperatorId)
    }
  })

  it('rejects apn profile list when supplierId and operatorId are both empty', async () => {
    const result = await listApnProfiles({
      supabase,
      page: 1,
      pageSize: 20,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('supplierId or operatorId is required.')
    }
  })

  it('rejects roaming profile creation when resellerId is empty', async () => {
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming missing reseller',
        mccmncList: [{ mcc: '001', mnc: '01', ratePerKb: 0.001 }],
        supplierId,
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('resellerId must be a valid uuid.')
    }
  })

  it('creates roaming profile with resellerId and mccmncList entries', async () => {
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming list',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [
          { mcc: '001', mnc: '01', ratePerKb: 0.0005 },
          { mcc: '001', mnc: '01', ratePerKb: 0.0004 },
        ],
      },
    })
    expect(result.ok).toBe(true)
    const row = supabase.getTable('roaming_profiles')[0]
    expect(row?.supplier_id).toBe(supplierId)
    expect(Array.isArray(row?.mccmnc_list)).toBe(true)
    expect(row?.mccmnc_list?.[0]?.ratePerKb).toBe(0.0005)
  })

  it('creates roaming profile even when mccmncList values are not in business_operators', async () => {
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming external operators',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [
          { mcc: '250', mnc: '20', ratePerKb: 0.0008 },
          { mcc: '502', mnc: '*', ratePerKb: 0.0012 },
        ],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('DRAFT')
      expect(result.value.version).toBe(1)
    }
    const row = supabase.getTable('roaming_profiles')[0]
    expect(row?.mccmnc_list?.[0]).toMatchObject({ mcc: '250', mnc: '20', ratePerKb: 0.0008 })
    expect(row?.mccmnc_list?.[1]).toMatchObject({ mcc: '502', mnc: '*', ratePerKb: 0.0012 })
  })

  it('rejects roaming profile list when supplierId and operatorId are both empty', async () => {
    const result = await listRoamingProfiles({
      supabase,
      page: 1,
      pageSize: 20,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('supplierId or operatorId is required.')
    }
  })

  it('derives new roaming profile version and supports partial row patching', async () => {
    const created = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming patch flow',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [
          { mcc: '460', mnc: '00', ratePerKb: 0.001 },
          { mcc: '454', mnc: '*', ratePerKb: 0.002 },
        ],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const derived = await deriveRoamingProfileVersion({
      supabase,
      roamingProfileId: created.value.roamingProfileId,
      payload: { baseVersionId: created.value.profileVersionId },
    })
    expect(derived.ok).toBe(true)
    if (!derived.ok) return
    const derivedVersion = derived.value
    expect(derivedVersion).toBeTruthy()
    if (!derivedVersion) return
    expect(derivedVersion.version).toBe(2)
    const listBefore = await listRoamingProfileEntries({
      supabase,
      roamingProfileId: created.value.roamingProfileId,
      profileVersionId: derivedVersion.profileVersionId,
      includeDeleted: false,
      page: 1,
      pageSize: 20,
    })
    expect(listBefore.ok).toBe(true)
    if (!listBefore.ok) return
    const deleteTarget = listBefore.value.items.find((item) => item.mcc === '454' && item.mnc === '*') ?? listBefore.value.items[0]
    const patchResult = await patchRoamingProfileEntries({
      supabase,
      roamingProfileId: created.value.roamingProfileId,
      profileVersionId: derivedVersion.profileVersionId,
      payload: {
        operations: [
          { op: 'DELETE', entryId: deleteTarget.entryId },
          { op: 'UPSERT', mcc: '460', mnc: '00', ratePerKb: 0.0015 },
          { op: 'UPSERT', mcc: '001', mnc: '99', ratePerKb: 0.003 },
        ],
      },
    })
    expect(patchResult.ok).toBe(true)
    const listAfter = await listRoamingProfileEntries({
      supabase,
      roamingProfileId: created.value.roamingProfileId,
      profileVersionId: derivedVersion.profileVersionId,
      includeDeleted: false,
      page: 1,
      pageSize: 20,
    })
    expect(listAfter.ok).toBe(true)
    if (listAfter.ok) {
      expect(listAfter.value.total).toBe(2)
      const upserted = listAfter.value.items.find((item) => item.mcc === '460' && item.mnc === '00')
      expect(upserted?.ratePerKb).toBe(0.0015)
      const inserted = listAfter.value.items.find((item) => item.mcc === '001' && item.mnc === '99')
      expect(inserted?.ratePerKb).toBe(0.003)
    }
  })

  it('allows derive when base version is latest by version number even if another row has same version', async () => {
    const created = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming derive tie',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [{ mcc: '460', mnc: '11', ratePerKb: 0.001 }],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const baseVersionId = created.value.profileVersionId
    expect(baseVersionId).toBeTruthy()
    if (!baseVersionId) return
    supabase.getTable('profile_versions').unshift({
      profile_version_id: randomUUID(),
      profile_type: 'ROAMING',
      profile_id: created.value.roamingProfileId,
      version: 1,
      status: 'DRAFT',
      config: { mccmncList: [{ mcc: '460', mnc: '11', ratePerKb: 0.001 }] },
    })
    const derived = await deriveRoamingProfileVersion({
      supabase,
      roamingProfileId: created.value.roamingProfileId,
      payload: { baseVersionId },
    })
    expect(derived.ok).toBe(true)
    if (derived.ok && derived.value) {
      expect(derived.value.version).toBe(2)
    }
  })

  it('locks roaming profile draft version when referenced by package versions', async () => {
    const created = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming lock flow',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [{ mcc: '460', mnc: '01', ratePerKb: 0.002 }],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const lockedProfileVersionId = created.value.profileVersionId
    expect(lockedProfileVersionId).toBeTruthy()
    if (!lockedProfileVersionId) return
    const packageId = randomUUID()
    supabase.getTable('package_versions').push({
      package_version_id: randomUUID(),
      package_id: packageId,
      version: 1,
      status: 'PUBLISHED',
      roaming_profile: {
        profileVersionId: lockedProfileVersionId,
      },
      carrier_service_config: {
        roamingProfileVersionId: lockedProfileVersionId,
      },
    })
    const patched = await patchRoamingProfileEntries({
      supabase,
      roamingProfileId: created.value.roamingProfileId,
      profileVersionId: lockedProfileVersionId,
      payload: {
        operations: [{ op: 'UPSERT', mcc: '460', mnc: '01', ratePerKb: 0.004 }],
      },
    })
    expect(patched.ok).toBe(false)
    if (!patched.ok) {
      expect(patched.code).toBe('RESOURCE_LOCKED')
    }
  })

  it('gets apn profile detail without carrierId field', async () => {
    const createResult = await createApnProfile({
      supabase,
      payload: {
        name: 'APN detail',
        apn: 'detail.apn',
        supplierId,
        operatorId,
      },
    })
    expect(createResult.ok).toBe(true)
    const apnProfileId = createResult.ok ? createResult.value.apnProfileId : ''
    const detailResult = await getApnProfileDetail({ supabase, apnProfileId })
    expect(detailResult.ok).toBe(true)
    if (detailResult.ok) {
      expect((detailResult.value as any)?.operatorId).toBe(operatorId)
      expect((detailResult.value as any)?.carrierId).toBeUndefined()
    }
  })

  it('creates price plan and publishes package', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Bundle A',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        paygRates: [{ zoneCode: 'Z1', countries: ['001-01'], ratePerKb: 0.01 }],
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package A',
        pricePlanId: planId,
        ...preparePackageModules({ supabase, supplierId, operatorId }),
      },
    })
    expect(packageResult.ok).toBe(true)
    const publishResult = await publishPackage({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishResult.ok).toBe(true)
  })

  it('validates commercial terms module independently', async () => {
    const result = validateCommercialTermsModule({
      commercialTerms: {
        testPeriodDays: 7,
        testQuotaKb: 1024,
        testExpiryCondition: 'PERIOD_OR_QUOTA',
        testExpiryAction: 'ACTIVATED',
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as any).commercialTerms?.testPeriodDays).toBe(7)
    }
  })

  it('validates control policy module independently', async () => {
    const cutoffPolicyId = randomUUID()
    const throttlingPolicyId = randomUUID()
    supabase.getTable('cutoff_policies').push({ cutoff_policy_id: cutoffPolicyId })
    supabase.getTable('throttling_policies').push({ throttling_policy_id: throttlingPolicyId })
    const result = await validateControlPolicyModule({
      supabase,
      payload: {
        controlPolicy: {
          enabled: true,
          cutoffPolicyId,
          throttlingPolicyId,
          cutoffThresholdMb: 512,
        },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as any).controlPolicy?.cutoffPolicyId).toBe(cutoffPolicyId)
    }
  })

  it('validates carrier service module independently', async () => {
    const roamingProfileVersionId = randomUUID()
    supabase.getTable('profile_versions').push({
      profile_version_id: roamingProfileVersionId,
      profile_type: 'ROAMING',
      status: 'PUBLISHED',
    })
    const result = await validateCarrierServiceModule({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apn: 'iot',
          roamingProfileVersionId,
        },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as any).carrierServiceConfig?.operatorId).toBe(operatorId)
    }
  })

  it('creates, updates and queries commercial terms module', async () => {
    const createResult = await createCommercialTerms({
      supabase,
      payload: {
        enterpriseId,
        commercialTerms: {
          testPeriodDays: 7,
          testQuotaKb: 1024,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'ACTIVATED',
        },
      },
      audit: {
        actorUserId: 'user-1',
        actorRole: 'reseller_admin',
        requestId: 'req-commercial-create',
        sourceIp: '127.0.0.1',
      },
    })
    expect(createResult.ok).toBe(true)
    const commercialTermsId = createResult.ok ? (createResult.value as any).commercialTermsId : null
    expect(commercialTermsId).toBeTruthy()

    const updateResult = await updateCommercialTerms({
      supabase,
      commercialTermsId,
      payload: {
        commercialTerms: {
          commitmentPeriodMonths: 12,
        },
      },
      audit: {
        actorUserId: 'user-2',
        actorRole: 'reseller_admin',
        requestId: 'req-commercial-update',
        sourceIp: '127.0.0.1',
      },
    })
    expect(updateResult.ok).toBe(true)
    if (updateResult.ok) {
      expect((updateResult.value as any).commercialTerms?.testPeriodDays).toBe(7)
      expect((updateResult.value as any).commercialTerms?.commitmentPeriodMonths).toBe(12)
    }

    const detailResult = await getCommercialTermsDetail({ supabase, commercialTermsId })
    expect(detailResult.ok).toBe(true)
    if (detailResult.ok) {
      expect((detailResult.value as any).commercialTermsId).toBe(commercialTermsId)
    }
  })

  it('creates, updates and queries control policy module', async () => {
    const cutoffPolicyId = randomUUID()
    const throttlingPolicyId = randomUUID()
    supabase.getTable('cutoff_policies').push({ cutoff_policy_id: cutoffPolicyId })
    supabase.getTable('throttling_policies').push({ throttling_policy_id: throttlingPolicyId })
    const createResult = await createControlPolicy({
      supabase,
      payload: {
        enterpriseId,
        controlPolicy: {
          enabled: true,
          cutoffPolicyId,
          cutoffThresholdMb: 256,
        },
      },
      audit: {
        actorUserId: 'user-1',
        actorRole: 'reseller_admin',
        requestId: 'req-control-create',
        sourceIp: '127.0.0.1',
      },
    })
    expect(createResult.ok).toBe(true)
    const controlPolicyId = createResult.ok ? (createResult.value as any).controlPolicyId : null
    expect(controlPolicyId).toBeTruthy()

    const updateResult = await updateControlPolicy({
      supabase,
      controlPolicyId,
      payload: {
        controlPolicy: {
          throttlingPolicyId,
          cutoffThresholdMb: 512,
        },
      },
      audit: {
        actorUserId: 'user-2',
        actorRole: 'reseller_admin',
        requestId: 'req-control-update',
        sourceIp: '127.0.0.1',
      },
    })
    expect(updateResult.ok).toBe(true)
    if (updateResult.ok) {
      expect((updateResult.value as any).controlPolicy?.cutoffPolicyId).toBe(cutoffPolicyId)
      expect((updateResult.value as any).controlPolicy?.throttlingPolicyId).toBe(throttlingPolicyId)
      expect((updateResult.value as any).controlPolicy?.cutoffThresholdMb).toBe(512)
    }

    const detailResult = await getControlPolicyDetail({ supabase, controlPolicyId })
    expect(detailResult.ok).toBe(true)
    if (detailResult.ok) {
      expect((detailResult.value as any).controlPolicyId).toBe(controlPolicyId)
    }
  })

  it('creates, updates and queries carrier service module', async () => {
    const roamingProfileVersionId = randomUUID()
    const apnProfileVersionId = randomUUID()
    supabase.getTable('profile_versions').push(
      {
        profile_version_id: roamingProfileVersionId,
        profile_type: 'ROAMING',
        profile_id: randomUUID(),
        version: 1,
        status: 'PUBLISHED',
        config: { mccmncList: ['001-01'] },
      },
      {
        profile_version_id: apnProfileVersionId,
        profile_type: 'APN',
        profile_id: randomUUID(),
        version: 1,
        status: 'PUBLISHED',
        config: { apn: 'iot' },
      }
    )
    const createResult = await createCarrierService({
      supabase,
      payload: {
        enterpriseId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apn: 'iot',
          roamingProfileVersionId,
          apnProfileVersionId,
        },
      },
      audit: {
        actorUserId: 'user-1',
        actorRole: 'reseller_admin',
        requestId: 'req-carrier-create',
        sourceIp: '127.0.0.1',
      },
    })
    expect(createResult.ok).toBe(true)
    const carrierServiceId = createResult.ok ? (createResult.value as any).carrierServiceId : null
    expect(carrierServiceId).toBeTruthy()

    const updateResult = await updateCarrierService({
      supabase,
      carrierServiceId,
      payload: {
        carrierServiceConfig: {
          apn: 'iot-updated',
        },
      },
      audit: {
        actorUserId: 'user-2',
        actorRole: 'reseller_admin',
        requestId: 'req-carrier-update',
        sourceIp: '127.0.0.1',
      },
    })
    expect(updateResult.ok).toBe(true)
    if (updateResult.ok) {
      expect((updateResult.value as any).carrierServiceConfig?.apn).toBe('iot-updated')
      expect((updateResult.value as any).carrierServiceConfig?.roamingProfileVersionId).toBe(roamingProfileVersionId)
    }

    const detailResult = await getCarrierServiceDetail({ supabase, carrierServiceId })
    expect(detailResult.ok).toBe(true)
    if (detailResult.ok) {
      expect((detailResult.value as any).carrierServiceId).toBe(carrierServiceId)
    }
  })

  it('creates package by module ids and stores module references', async () => {
    const roamingProfileVersionId = randomUUID()
    const apnProfileVersionId = randomUUID()
    supabase.getTable('profile_versions').push(
      {
        profile_version_id: roamingProfileVersionId,
        profile_type: 'ROAMING',
        profile_id: randomUUID(),
        version: 1,
        status: 'PUBLISHED',
        config: { mccmncList: ['001-01'] },
      },
      {
        profile_version_id: apnProfileVersionId,
        profile_type: 'APN',
        profile_id: randomUUID(),
        version: 1,
        status: 'PUBLISHED',
        config: { apn: 'iot' },
      }
    )
    const carrierResult = await createCarrierService({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apn: 'iot',
          roamingProfileVersionId,
          apnProfileVersionId,
        },
      },
    })
    expect(carrierResult.ok).toBe(true)
    const controlResult = await createControlPolicy({
      supabase,
      payload: {
        controlPolicy: {
          enabled: true,
          cutoffThresholdMb: 128,
        },
      },
    })
    expect(controlResult.ok).toBe(true)
    const commercialResult = await createCommercialTerms({
      supabase,
      payload: {
        commercialTerms: {
          testPeriodDays: 7,
          testQuotaKb: 1024,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'ACTIVATED',
        },
      },
    })
    expect(commercialResult.ok).toBe(true)
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Module ID Plan',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 20,
        deactivatedMonthlyFee: 2,
        perSimQuotaKb: 4096,
        paygRates: [{ zoneCode: 'Z1', countries: ['001-01'], ratePerKb: 0.01 }],
      },
    })
    expect(planResult.ok).toBe(true)
    const pricePlanId = planResult.ok ? planResult.value.pricePlanId : ''
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package by IDs',
        pricePlanId,
        carrierServiceId: carrierResult.ok ? (carrierResult.value as any).carrierServiceId : '',
        controlPolicyId: controlResult.ok ? (controlResult.value as any).controlPolicyId : '',
        commercialTermsId: commercialResult.ok ? (commercialResult.value as any).commercialTermsId : '',
      },
    })
    expect(packageResult.ok).toBe(true)
    const packageVersion = supabase.getTable('package_versions')[0]
    expect(packageVersion?.carrier_service_id).toBe(carrierResult.ok ? (carrierResult.value as any).carrierServiceId : null)
    expect(packageVersion?.control_policy_id).toBe(controlResult.ok ? (controlResult.value as any).controlPolicyId : null)
    expect(packageVersion?.commercial_terms_id).toBe(commercialResult.ok ? (commercialResult.value as any).commercialTermsId : null)
    expect(packageVersion?.carrier_service_config?.apn).toBe('iot')
  })

  it('indexes four modules from price plan version when package payload omits module details', async () => {
    const roamingProfileId = randomUUID()
    const roamingProfileVersionId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Package Meta Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVE',
      mccmnc_list: ['001-01'],
    })
    supabase.getTable('profile_versions').push({
      profile_version_id: roamingProfileVersionId,
      profile_type: 'ROAMING',
      profile_id: roamingProfileId,
      version: 1,
      status: 'PUBLISHED',
      config: { mccmncList: ['001-01'] },
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: randomUUID(),
      name: 'Package Meta APN',
      apn: 'iot',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVE',
    })
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Bundle Meta Index',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        commercialTerms: {
          testPeriodDays: 14,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'DEACTIVATED',
        },
        controlPolicy: {
          enabled: true,
          cutoffThresholdMb: 256,
        },
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apn: 'iot',
          roamingProfileVersionId,
        },
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package Meta Index',
        pricePlanId: planId,
      },
    })
    expect(packageResult.ok).toBe(true)
    const packageVersion = supabase.getTable('package_versions')[0]
    expect(packageVersion?.commercial_terms?.testPeriodDays).toBe(14)
    expect(packageVersion?.control_policy?.enabled).toBe(true)
    expect(packageVersion?.roaming_profile?.profileVersionId).toBe(roamingProfileVersionId)
  })

  it('creates price plan with price_plan_type tiered pricing payload', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Tiered A',
        price_plan_type: 'TIERED_PRICING',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        tiers: [{ fromKb: 0, toKb: 1024, ratePerKb: 0.01 }],
      },
    })
    expect(planResult.ok).toBe(true)
    const row = supabase.getTable('price_plans')[0]
    expect(row?.type).toBe('TIERED_VOLUME_PRICING')
  })

  it('creates price plan version with price_plan_type tiered pricing payload', async () => {
    const createResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Tiered Version',
        price_plan_type: 'TIERED_PRICING',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        tiers: [{ fromKb: 0, toKb: 1024, ratePerKb: 0.01 }],
      },
    })
    expect(createResult.ok).toBe(true)
    const pricePlanId = supabase.getTable('price_plans')[0]?.price_plan_id
    const versionResult = await createPricePlanVersion({
      supabase,
      pricePlanId,
      payload: {
        price_plan_type: 'TIERED_PRICING',
        monthlyFee: 12,
        deactivatedMonthlyFee: 1,
        tiers: [{ fromKb: 0, toKb: 2048, ratePerKb: 0.008 }],
      },
    })
    expect(versionResult.ok).toBe(true)
  })

  it('rejects price plan version when price_plan_type does not match existing type', async () => {
    const createResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Type Mismatch',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
      },
    })
    expect(createResult.ok).toBe(true)
    const pricePlanId = supabase.getTable('price_plans')[0]?.price_plan_id
    const versionResult = await createPricePlanVersion({
      supabase,
      pricePlanId,
      payload: {
        price_plan_type: 'FIXED_BUNDLE',
        monthlyFee: 12,
        deactivatedMonthlyFee: 1,
        totalQuotaKb: 2048,
      },
    })
    expect(versionResult.ok).toBe(false)
    if (!versionResult.ok) {
      expect((versionResult as any).code).toBe('BAD_REQUEST')
      expect((versionResult as any).message).toBe('price_plan_type must match the existing price plan type.')
    }
  })

  it('blocks publish on PAYG conflicts', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Bundle Conflict',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
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
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package Conflict',
        pricePlanId: planId,
        ...preparePackageModules({ supabase, supplierId, operatorId }),
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
        operatorId,
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
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 2048,
        paygRates: [{ zoneCode: 'Z1', countries: ['001-01'], ratePerKb: 0.01 }],
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const modules = preparePackageModules({ supabase, supplierId, operatorId, apnProfileVersionId })
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package APN',
        pricePlanId: planId,
        ...modules,
        carrierServiceConfig: {
          ...modules.carrierServiceConfig,
          apn: 'apn1',
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

  it('rejects invalid firstCycleProration with bad request', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Invalid Proration',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NO_PRORATION',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
      },
    })
    expect(planResult.ok).toBe(false)
    if (!planResult.ok) {
      expect((planResult as any).code).toBe('BAD_REQUEST')
      expect((planResult as any).message).toBe('firstCycleProration is invalid.')
    }
  })

  it('requires mandatory fields for all four price plan types', async () => {
    const cases = [
      {
        payload: {
          name: 'Missing One Time Fee',
          type: 'ONE_TIME',
          serviceType: 'DATA',
          currency: 'USD',
          billingCycleType: 'CALENDAR_MONTH',
          firstCycleProration: 'NONE',
          prorationRounding: 'ROUND_HALF_UP',
          quotaKb: 1024,
          validityDays: 30,
          expiryBoundary: 'CALENDAR_DAY_END',
        },
        message: 'oneTimeFee must be >= 0.',
      },
      {
        payload: {
          name: 'Missing Sim Quota',
          type: 'SIM_DEPENDENT_BUNDLE',
          serviceType: 'DATA',
          currency: 'USD',
          billingCycleType: 'CALENDAR_MONTH',
          firstCycleProration: 'NONE',
          prorationRounding: 'ROUND_HALF_UP',
          monthlyFee: 10,
          deactivatedMonthlyFee: 1,
        },
        message: 'perSimQuotaKb must be >= 0.',
      },
      {
        payload: {
          name: 'Missing Total Quota',
          type: 'FIXED_BUNDLE',
          serviceType: 'DATA',
          currency: 'USD',
          billingCycleType: 'CALENDAR_MONTH',
          firstCycleProration: 'NONE',
          prorationRounding: 'ROUND_HALF_UP',
          monthlyFee: 10,
          deactivatedMonthlyFee: 1,
        },
        message: 'totalQuotaKb must be >= 0.',
      },
      {
        payload: {
          name: 'Missing Tiers',
          type: 'TIERED_VOLUME_PRICING',
          serviceType: 'DATA',
          currency: 'USD',
          billingCycleType: 'CALENDAR_MONTH',
          firstCycleProration: 'NONE',
          prorationRounding: 'ROUND_HALF_UP',
          monthlyFee: 10,
          deactivatedMonthlyFee: 1,
        },
        message: 'tiers must be provided.',
      },
    ]
    for (const testCase of cases) {
      const result = await createPricePlan({ supabase, enterpriseId, payload: testCase.payload })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect((result as any).code).toBe('BAD_REQUEST')
        expect((result as any).message).toBe(testCase.message)
      }
    }
  })

  it('stores carrier service, commercial terms and control policy in price plan meta', async () => {
    const roamingProfileId = randomUUID()
    const roamingProfileVersionId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Meta Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVE',
      mccmnc_list: ['001-01'],
    })
    supabase.getTable('profile_versions').push({
      profile_version_id: roamingProfileVersionId,
      profile_type: 'ROAMING',
      profile_id: roamingProfileId,
      version: 1,
      status: 'PUBLISHED',
      config: { mccmncList: ['001-01'] },
    })
    const result = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Bundle Meta',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 18,
        deactivatedMonthlyFee: 3,
        perSimQuotaKb: 2048,
        commercialTerms: {
          testPeriodDays: 15,
          testQuotaKb: 10240,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'DEACTIVATED',
          commitmentPeriodMonths: 12,
        },
        controlPolicy: {
          enabled: true,
          cutoffPolicyId: randomUUID(),
          throttlingPolicyId: randomUUID(),
          cutoffThresholdMb: 1024,
        },
        carrierServiceConfig: {
          roamingProfileVersionId,
        },
      },
    })
    expect(result.ok).toBe(true)
    const versionRow = supabase.getTable('price_plan_versions')[0]
    expect(versionRow?.payg_rates?.meta?.commercialTerms?.testExpiryAction).toBe('DEACTIVATED')
    expect(versionRow?.payg_rates?.meta?.controlPolicy?.enabled).toBe(true)
    expect(versionRow?.payg_rates?.meta?.carrierService?.roamingProfileVersionId).toBe(roamingProfileVersionId)
  })

  it('supports common modules for all four price plan types', async () => {
    const roamingProfileId = randomUUID()
    const roamingProfileVersionId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Common Modules Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVE',
      mccmnc_list: ['001-01'],
    })
    supabase.getTable('profile_versions').push({
      profile_version_id: roamingProfileVersionId,
      profile_type: 'ROAMING',
      profile_id: roamingProfileId,
      version: 1,
      status: 'PUBLISHED',
      config: { mccmncList: ['001-01'] },
    })
    const basePayload = {
      serviceType: 'DATA',
      currency: 'USD',
      billingCycleType: 'CALENDAR_MONTH',
      firstCycleProration: 'NONE',
      prorationRounding: 'ROUND_HALF_UP',
      commercialTerms: {
        testPeriodDays: 10,
        testQuotaKb: 1024,
        testExpiryCondition: 'PERIOD_OR_QUOTA',
        testExpiryAction: 'ACTIVATED',
      },
      controlPolicy: {
        enabled: true,
        cutoffThresholdMb: 512,
      },
      carrierServiceConfig: {
        roamingProfileVersionId,
      },
    }
    const cases = [
      {
        name: 'OneTime Modules',
        payload: {
          ...basePayload,
          type: 'ONE_TIME',
          oneTimeFee: 9.9,
          quotaKb: 2048,
          validityDays: 30,
          expiryBoundary: 'CALENDAR_DAY_END',
        },
      },
      {
        name: 'SimBundle Modules',
        payload: {
          ...basePayload,
          type: 'SIM_DEPENDENT_BUNDLE',
          monthlyFee: 10,
          deactivatedMonthlyFee: 1,
          perSimQuotaKb: 2048,
        },
      },
      {
        name: 'FixedBundle Modules',
        payload: {
          ...basePayload,
          type: 'FIXED_BUNDLE',
          monthlyFee: 20,
          deactivatedMonthlyFee: 2,
          totalQuotaKb: 4096,
        },
      },
      {
        name: 'Tiered Modules',
        payload: {
          ...basePayload,
          type: 'TIERED_VOLUME_PRICING',
          monthlyFee: 15,
          deactivatedMonthlyFee: 1,
          tiers: [
            { fromKb: 0, toKb: 1024, ratePerKb: 0.001 },
            { fromKb: 1024, toKb: 2048, ratePerKb: 0.0008 },
          ],
        },
      },
    ]
    for (const [index, testCase] of cases.entries()) {
      const result = await createPricePlan({
        supabase,
        enterpriseId,
        payload: {
          name: testCase.name,
          ...testCase.payload,
        },
      })
      expect(result.ok).toBe(true)
      const versionRow = supabase.getTable('price_plan_versions')[index]
      expect(versionRow?.payg_rates?.meta?.commercialTerms?.testPeriodDays).toBe(10)
      expect(versionRow?.payg_rates?.meta?.controlPolicy?.enabled).toBe(true)
      expect(versionRow?.payg_rates?.meta?.carrierService?.roamingProfileVersionId).toBe(roamingProfileVersionId)
    }
  })

  it('rejects invalid carrier service and commercial terms payload in price plan creation', async () => {
    const invalidCarrier = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Invalid Carrier',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        carrierService: {
          rat: '6G',
          apn: 'iot.bad',
        },
      },
    })
    expect(invalidCarrier.ok).toBe(false)
    if (!invalidCarrier.ok) {
      expect((invalidCarrier as any).message).toBe('carrierService.rat is invalid.')
    }

    const invalidCommercial = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Invalid Commercial',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        commercialTerms: {
          testExpiryAction: 'PAUSED',
        },
      },
    })
    expect(invalidCommercial.ok).toBe(false)
    if (!invalidCommercial.ok) {
      expect((invalidCommercial as any).message).toBe('commercialTerms.testExpiryAction is invalid.')
    }
  })

  it('rejects carrier service when apn is not in supplier capability directory', async () => {
    const result = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Missing APN Directory',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        carrierService: {
          supplierId,
          operatorId,
          apn: 'not-found.apn',
          roamingProfile: {
            allowedMccMnc: ['001-01'],
          },
        },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result as any).message).toBe('carrierService.apn is not found in supplier capability directory.')
    }
  })

  it('rejects carrier service roaming mccmnc when supplier has no operator capability mapping', async () => {
    supabase.getTable('apn_profiles').push({
      apn_profile_id: randomUUID(),
      name: 'Capability APN',
      apn: 'iot.meta',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVE',
    })
    const unsupportedBusinessOperatorId = randomUUID()
    supabase.getTable('business_operators').push({
      operator_id: unsupportedBusinessOperatorId,
      mcc: '460',
      mnc: '00',
      name: 'Unsupported Carrier',
    })
    const result = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Unsupported Roaming Capability',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        carrierService: {
          supplierId,
          operatorId,
          apn: 'iot.meta',
          roamingProfile: {
            allowedMccMnc: ['460-00'],
          },
        },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result as any).message).toBe('carrierService.roamingProfile.allowedMccMnc is not supported by supplier: 460-00')
    }
  })

  it('validates carrier service table references when creating price plan version', async () => {
    supabase.getTable('apn_profiles').push({
      apn_profile_id: randomUUID(),
      name: 'Version APN',
      apn: 'version.apn',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVE',
    })
    const createResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Version Base Plan',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 8,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
      },
    })
    expect(createResult.ok).toBe(true)
    const pricePlanId = (createResult as any).value.pricePlanId
    const versionResult = await createPricePlanVersion({
      supabase,
      pricePlanId,
      payload: {
        monthlyFee: 9,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apn: 'version.apn',
          roamingProfile: {
            allowedMccMnc: ['001-01'],
          },
        },
      },
    })
    expect(versionResult.ok).toBe(true)
    if (versionResult.ok) {
      expect((versionResult.value as any)?.carrierService?.apn).toBe('version.apn')
    }
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

  it('reverse looks up carrier service after APN and roaming clone publish', async () => {
    const apnResult = await createApnProfile({
      supabase,
      payload: {
        name: 'APN Reverse Lookup',
        apn: 'reverse.apn',
        supplierId,
        operatorId,
      },
    })
    expect(apnResult.ok).toBe(true)
    if (!apnResult.ok) return
    const apnPublishResult = await publishApnProfile({ supabase, apnProfileId: apnResult.value.apnProfileId })
    expect(apnPublishResult.ok).toBe(true)
    if (!apnPublishResult.ok) return

    const roamingResult = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming Reverse Lookup',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [{ mcc: '001', mnc: '01', ratePerKb: 0.0006 }],
      },
    })
    expect(roamingResult.ok).toBe(true)
    if (!roamingResult.ok) return
    const roamingPublishV1 = await publishRoamingProfile({ supabase, roamingProfileId: roamingResult.value.roamingProfileId })
    expect(roamingPublishV1.ok).toBe(true)
    if (!roamingPublishV1.ok) return
    const roamingDerived = await deriveRoamingProfileVersion({
      supabase,
      roamingProfileId: roamingResult.value.roamingProfileId,
      payload: { baseVersionId: roamingResult.value.profileVersionId },
    })
    expect(roamingDerived.ok).toBe(true)
    if (!roamingDerived.ok || !roamingDerived.value) return
    const roamingPublishV2 = await publishRoamingProfile({ supabase, roamingProfileId: roamingResult.value.roamingProfileId })
    expect(roamingPublishV2.ok).toBe(true)

    const carrierResult = await createCarrierService({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apn: 'reverse.apn',
          apnProfileVersionId: apnPublishResult.value.profileVersionId,
          roamingProfileVersionId: roamingDerived.value.profileVersionId,
        },
      },
    })
    expect(carrierResult.ok).toBe(true)
    if (!carrierResult.ok) return

    const commercialResult = await createCommercialTerms({
      supabase,
      payload: {
        commercialTerms: {
          testPeriodDays: 7,
          testQuotaKb: 1024,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'DEACTIVATED',
        },
      },
    })
    expect(commercialResult.ok).toBe(true)
    if (!commercialResult.ok) return

    const controlResult = await createControlPolicy({
      supabase,
      payload: {
        controlPolicy: {
          enabled: true,
          cutoffThresholdMb: 512,
        },
      },
    })
    expect(controlResult.ok).toBe(true)
    if (!controlResult.ok) return

    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Plan Reverse Lookup',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 18,
        deactivatedMonthlyFee: 2,
        perSimQuotaKb: 2048,
      },
    })
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return
    const planId = planResult.value.pricePlanId

    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package Reverse Lookup',
        pricePlanId: planId,
        carrierServiceId: carrierResult.value.carrierServiceId,
        controlPolicyId: controlResult.value.controlPolicyId,
        commercialTermsId: commercialResult.value.commercialTermsId,
      },
    })
    expect(packageResult.ok).toBe(true)
    if (!packageResult.ok) return
    const packagePublish = await publishPackage({ supabase, packageId: packageResult.value.packageId })
    expect(packagePublish.ok).toBe(true)

    const reverseResult = await listCarrierServices({
      supabase,
      apnProfileId: apnResult.value.apnProfileId,
      roamingProfileId: roamingResult.value.roamingProfileId,
      status: 'PUBLISHED',
      page: 1,
      pageSize: 20,
    })
    expect(reverseResult.ok).toBe(true)
    if (!reverseResult.ok) return
    expect(reverseResult.value.total).toBe(1)
    expect((reverseResult.value.items[0] as any)?.carrierServiceId).toBe(carrierResult.value.carrierServiceId)
    expect((reverseResult.value.items[0] as any)?.status).toBe('PUBLISHED')
    expect((reverseResult.value.items[0] as any)?.effectiveFrom).toBeTruthy()
  })

  it('reverse looks up package by price plan and module references', async () => {
    const roamingProfileVersionId = randomUUID()
    const apnProfileVersionId = randomUUID()
    supabase.getTable('profile_versions').push(
      {
        profile_version_id: roamingProfileVersionId,
        profile_type: 'ROAMING',
        profile_id: randomUUID(),
        version: 1,
        status: 'PUBLISHED',
        config: { mccmncList: ['001-01'] },
      },
      {
        profile_version_id: apnProfileVersionId,
        profile_type: 'APN',
        profile_id: randomUUID(),
        version: 1,
        status: 'PUBLISHED',
        config: { apn: 'lookup.apn' },
      }
    )
    const carrierResult = await createCarrierService({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apn: 'lookup.apn',
          apnProfileVersionId,
          roamingProfileVersionId,
        },
      },
    })
    expect(carrierResult.ok).toBe(true)
    if (!carrierResult.ok) return

    const commercialResult = await createCommercialTerms({
      supabase,
      payload: {
        commercialTerms: {
          testPeriodDays: 10,
          testQuotaKb: 2048,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'ACTIVATED',
        },
      },
    })
    expect(commercialResult.ok).toBe(true)
    if (!commercialResult.ok) return
    const controlResult = await createControlPolicy({
      supabase,
      payload: {
        controlPolicy: {
          enabled: true,
          cutoffThresholdMb: 700,
        },
      },
    })
    expect(controlResult.ok).toBe(true)
    if (!controlResult.ok) return

    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Plan Module Refs',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 12,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
      },
    })
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return

    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package By Module Refs',
        pricePlanVersionId: supabase.getTable('price_plan_versions')[0]?.price_plan_version_id,
        carrierServiceId: carrierResult.value.carrierServiceId,
        controlPolicyId: controlResult.value.controlPolicyId,
        commercialTermsId: commercialResult.value.commercialTermsId,
      },
    })
    expect(packageResult.ok).toBe(true)
    if (!packageResult.ok) return
    const published = await publishPackage({ supabase, packageId: packageResult.value.packageId })
    expect(published.ok).toBe(true)

    const byPlan = await listPackagesByModuleRefs({
      supabase,
      pricePlanId: planResult.value.pricePlanId,
      enterpriseId,
      status: 'PUBLISHED',
      page: 1,
      pageSize: 20,
    })
    expect(byPlan.ok).toBe(true)
    if (!byPlan.ok) return
    expect(byPlan.value.total).toBe(1)
    expect((byPlan.value.items[0] as any)?.packageId).toBe(packageResult.value.packageId)

    const byPolicies = await listPackagesByModuleRefs({
      supabase,
      commercialTermsId: String(commercialResult.value.commercialTermsId),
      controlPolicyId: String(controlResult.value.controlPolicyId),
      enterpriseId,
      status: 'PUBLISHED',
      page: 1,
      pageSize: 20,
    })
    expect(byPolicies.ok).toBe(true)
    if (!byPolicies.ok) return
    expect(byPolicies.value.total).toBe(1)
    expect(((byPolicies.value.items[0] as any)?.latestVersion as any)?.commercialTermsId).toBe(
      commercialResult.value.commercialTermsId
    )
    expect(((byPolicies.value.items[0] as any)?.latestVersion as any)?.controlPolicyId).toBe(controlResult.value.controlPolicyId)
  })

  it('keeps package snapshot history traceable after switching to a new snapshot', async () => {
    const roamingProfileVersionId = randomUUID()
    supabase.getTable('profile_versions').push({
      profile_version_id: roamingProfileVersionId,
      profile_type: 'ROAMING',
      profile_id: randomUUID(),
      version: 1,
      status: 'PUBLISHED',
      config: { mccmncList: ['001-01'] },
    })
    const carrierResult = await createCarrierService({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apn: 'history.apn',
          roamingProfileVersionId,
        },
      },
    })
    expect(carrierResult.ok).toBe(true)
    if (!carrierResult.ok) return

    const commercialV1 = await createCommercialTerms({
      supabase,
      payload: {
        commercialTerms: {
          testPeriodDays: 5,
          testQuotaKb: 1024,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'DEACTIVATED',
        },
      },
    })
    expect(commercialV1.ok).toBe(true)
    if (!commercialV1.ok) return
    const controlV1 = await createControlPolicy({
      supabase,
      payload: {
        controlPolicy: {
          enabled: true,
          cutoffThresholdMb: 256,
        },
      },
    })
    expect(controlV1.ok).toBe(true)
    if (!controlV1.ok) return

    const planV1 = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Snapshot Plan V1',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaKb: 1024,
      },
    })
    expect(planV1.ok).toBe(true)
    if (!planV1.ok) return

    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Snapshot Package',
        pricePlanVersionId: supabase.getTable('price_plan_versions')[0]?.price_plan_version_id,
        carrierServiceId: carrierResult.value.carrierServiceId,
        controlPolicyId: controlV1.value.controlPolicyId,
        commercialTermsId: commercialV1.value.commercialTermsId,
      },
    })
    expect(packageResult.ok).toBe(true)
    if (!packageResult.ok) return
    const published = await publishPackage({ supabase, packageId: packageResult.value.packageId })
    expect(published.ok).toBe(true)

    const commercialV2 = await createCommercialTerms({
      supabase,
      payload: {
        commercialTerms: {
          testPeriodDays: 20,
          testQuotaKb: 4096,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'ACTIVATED',
        },
      },
    })
    expect(commercialV2.ok).toBe(true)
    if (!commercialV2.ok) return
    const controlV2 = await createControlPolicy({
      supabase,
      payload: {
        controlPolicy: {
          enabled: true,
          cutoffThresholdMb: 1024,
        },
      },
    })
    expect(controlV2.ok).toBe(true)
    if (!controlV2.ok) return
    const planV2 = await createPricePlan({
      supabase,
      enterpriseId,
      payload: {
        name: 'Snapshot Plan V2',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 16,
        deactivatedMonthlyFee: 2,
        perSimQuotaKb: 4096,
      },
    })
    expect(planV2.ok).toBe(true)
    if (!planV2.ok) return

    const versionV1 = supabase.getTable('package_versions').find((row) => row.package_id === packageResult.value.packageId)
    expect(versionV1).toBeTruthy()
    if (!versionV1) return
    const versionV2CreatedAt = new Date(Date.now() + 60 * 1000).toISOString()
    supabase.getTable('package_versions').push({
      ...versionV1,
      package_version_id: randomUUID(),
      version: 2,
      status: 'PUBLISHED',
      created_at: versionV2CreatedAt,
      effective_from: versionV2CreatedAt,
      price_plan_version_id: supabase.getTable('price_plan_versions')[1]?.price_plan_version_id,
      commercial_terms_id: commercialV2.value.commercialTermsId,
      control_policy_id: controlV2.value.controlPolicyId,
      commercial_terms: {
        testPeriodDays: 20,
        testQuotaKb: 4096,
        testExpiryCondition: 'PERIOD_OR_QUOTA',
        testExpiryAction: 'ACTIVATED',
      },
      control_policy: {
        enabled: true,
        cutoffThresholdMb: 1024,
      },
    })

    const detail = await getPackageDetail({ supabase, packageId: packageResult.value.packageId })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect((detail.value.currentVersion as any)?.version).toBe(2)
    expect(Array.isArray((detail.value as any).versions)).toBe(true)
    expect((detail.value as any).versions.length).toBe(2)
    const historical = (detail.value as any).versions.find((item: any) => item.version === 1)
    expect(historical?.commercialTermsId).toBe(commercialV1.value.commercialTermsId)
    const current = (detail.value as any).versions.find((item: any) => item.version === 2)
    expect(current?.commercialTermsId).toBe(commercialV2.value.commercialTermsId)

    const oldRefLookup = await listPackagesByModuleRefs({
      supabase,
      commercialTermsId: String(commercialV1.value.commercialTermsId),
      enterpriseId,
      status: 'PUBLISHED',
      page: 1,
      pageSize: 20,
    })
    expect(oldRefLookup.ok).toBe(true)
    if (!oldRefLookup.ok) return
    expect(oldRefLookup.value.total).toBe(0)

    const newRefLookup = await listPackagesByModuleRefs({
      supabase,
      commercialTermsId: String(commercialV2.value.commercialTermsId),
      enterpriseId,
      status: 'PUBLISHED',
      page: 1,
      pageSize: 20,
    })
    expect(newRefLookup.ok).toBe(true)
    if (!newRefLookup.ok) return
    expect(newRefLookup.value.total).toBe(1)
    expect((newRefLookup.value.items[0] as any)?.packageId).toBe(packageResult.value.packageId)
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
