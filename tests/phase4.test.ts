import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSimImport, parseIccidsFromAssignInventoryCsv } from '../src/services/simImport.ts'
import {
  assignEnterpriseSimsToDepartment,
  assignInventorySimsToEnterprise,
  batchChangeSimStatus,
  batchDeactivateSims,
  changeSimStatus,
  parseSimIdentifier,
} from '../src/services/simLifecycle.ts'
import { createPricePlan, getPricePlanDetail, publishPricePlan, deprecatePricePlan } from '../src/services/pricePlan.js'
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
  publishCarrierService,
  publishCommercialTerms,
  publishControlPolicy,
  publishPackage,
  updateCarrierService,
  updateCommercialTerms,
  updateControlPolicy,
  validateCarrierServiceModule,
  validateCommercialTermsModule,
  validateControlPolicyModule,
  formatCarrierServiceValidationResponseForApi,
} from '../src/services/package.js'
import {
  createApnProfile,
  createRoamingProfile,
  deprecateRoamingProfile,
  getApnProfileDetail,
  listApnProfiles,
  listRoamingProfiles,
  publishApnProfile,
  publishRoamingProfile,
  updateRoamingProfile,
} from '../src/services/networkProfile.js'
import { createSubscription, switchSubscription, cancelSubscription, listSimSubscriptions } from '../src/services/subscription.ts'
import {
  processSubscriptionProvisionJob,
  SUBSCRIPTION_PROVISION_JOB_TYPE,
} from '../src/services/subscriptionProvisionJob.js'
import * as vendorRegistry from '../src/vendors/registry.js'
import { createSupplierAdapter, createSupplierAdapterFromIntegration, negotiateChangePlanStrategy } from '../src/vendors/registry.js'
import { vi } from 'vitest'

const TEST_UPSTREAM_PRODUCT_ID = 'upstream-prod-test-001'

const VALID_COMMERCIAL_TERMS = {
  testPeriodDays: 7,
  testQuotaMb: 1024,
  testExpiryCondition: 'PERIOD_OR_QUOTA',
  testExpiryAction: 'ACTIVATED',
  commitmentPeriodMonths: 12,
  commitmentPeriodDays: 0,
}

async function publishPackageWithMapping(
  args: Parameters<typeof publishPackage>[0] & {
    publishInput?: { externalProductId?: string; provisioningParameters?: unknown }
  }
) {
  return publishPackage({
    ...args,
    publishInput: {
      externalProductId: args.publishInput?.externalProductId ?? TEST_UPSTREAM_PRODUCT_ID,
      provisioningParameters: args.publishInput?.provisioningParameters,
    },
  })
}

function seedSellablePackageWithMapping(
  supabase: ReturnType<typeof createFakeSupabase>,
  opts: {
    packageId: string
    enterpriseId: string
    supplierId: string
    operatorId: string
    pricePlanId?: string
    commercialTermsId?: string
    externalProductId?: string
  }
) {
  const carrierServiceId = randomUUID()
  supabase.getTable('carrier_service_modules').push({
    carrier_service_id: carrierServiceId,
    supplier_id: opts.supplierId,
    operator_id: opts.operatorId,
    status: 'PUBLISHED',
    name: 'Subscription test CS',
    apn_profile_id: randomUUID(),
    roaming_profile_id: randomUUID(),
    rat: '4G',
  })
  supabase.getTable('packages').push({
    package_id: opts.packageId,
    enterprise_id: opts.enterpriseId,
    status: 'PUBLISHED',
    name: 'Subscription test pkg',
    carrier_service_id: carrierServiceId,
    commercial_terms_id: opts.commercialTermsId ?? randomUUID(),
    price_plan_id: opts.pricePlanId ?? randomUUID(),
  })
  supabase.getTable('vendor_product_mappings').push({
    mapping_id: randomUUID(),
    package_id: opts.packageId,
    supplier_id: opts.supplierId,
    external_product_id: opts.externalProductId ?? TEST_UPSTREAM_PRODUCT_ID,
  })
}

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

/** Mirrors DB view `price_plans_expanded` for fake Supabase (subscription + billing tests). */
function buildPricePlansExpandedRows(getTable: (name: string) => Record<string, any>[]) {
  const parents = getTable('price_plans')
  return parents.map((parent) => {
    const pid = String(parent?.price_plan_id ?? '')
    const t = String(parent?.type ?? '').trim()
    const out: Record<string, any> = { ...parent }
    if (t === 'FIXED_BUNDLE') {
      const ch = getTable('price_plan_fixed_bundle').find((r) => String(r?.price_plan_id) === pid)
      if (ch) {
        out.monthly_fee = ch.monthly_fee
        out.deactivated_monthly_fee = ch.deactivated_monthly_fee
        out.total_quota_mb = ch.total_quota_mb
        out.overage_rate_per_mb = ch.overage_rate_per_mb
      }
    } else if (t === 'SIM_DEPENDENT_BUNDLE') {
      const ch = getTable('price_plan_sim_dependent_bundle').find((r) => String(r?.price_plan_id) === pid)
      if (ch) {
        out.monthly_fee = ch.monthly_fee
        out.deactivated_monthly_fee = ch.deactivated_monthly_fee
        out.per_sim_quota_mb = ch.per_sim_quota_mb
        out.overage_rate_per_mb = ch.overage_rate_per_mb
      }
    } else if (t === 'ONE_TIME') {
      const ch = getTable('price_plan_one_time').find((r) => String(r?.price_plan_id) === pid)
      if (ch) {
        out.one_time_fee = ch.one_time_fee
        out.quota_mb = ch.quota_mb
        out.validity_days = ch.validity_days
        out.expiry_boundary = ch.expiry_boundary
      }
    } else if (t === 'TIERED_VOLUME_PRICING') {
      const ch = getTable('price_plan_tiered_volume_pricing').find((r) => String(r?.price_plan_id) === pid)
      if (ch) {
        out.monthly_fee = ch.monthly_fee
        out.deactivated_monthly_fee = ch.deactivated_monthly_fee
        out.tiers = ch.tiers
        out.overage_rate_per_mb = ch.overage_rate_per_mb
      }
    }
    return out
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
      if (row.status === undefined || row.status === null) row.status = 'DRAFT'
    }
    if (
      table === 'price_plan_fixed_bundle' ||
      table === 'price_plan_sim_dependent_bundle' ||
      table === 'price_plan_one_time' ||
      table === 'price_plan_tiered_volume_pricing'
    ) {
      if (!row.price_plan_id) row.price_plan_id = randomUUID()
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
      if (row.status === undefined || row.status === null) row.status = 'DRAFT'
      if (row.name === undefined || row.name === null || String(row.name).trim() === '') {
        row.name = `Commercial terms ${row.commercial_terms_id}`
      }
    }
    if (table === 'control_policy_modules') {
      if (!row.control_policy_id) row.control_policy_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
      if (row.status === undefined || row.status === null) row.status = 'DRAFT'
      if (row.name === undefined || row.name === null || String(row.name).trim() === '') {
        row.name = `Control policy ${row.control_policy_id}`
      }
    }
    if (table === 'carrier_service_modules') {
      if (!row.carrier_service_id) row.carrier_service_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
      if (row.name === undefined || row.name === null || String(row.name).trim() === '') {
        row.name = `Carrier service ${row.carrier_service_id}`
      }
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
    if (table === 'vendor_product_mappings') {
      if (!row.mapping_id) row.mapping_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'jobs') {
      if (!row.job_id) row.job_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    return row
  }
  return {
    getTable,
    async select(table: string, queryString: string) {
      const { filters, limit, offset, order } = parseQuery(queryString)
      if (table === 'price_plans_expanded') {
        const rows = buildPricePlansExpandedRows(getTable)
        const filtered = applyFilters(rows, filters)
        const sorted = sortRows(filtered, order)
        const sliced = sorted.slice(offset, limit ? offset + limit : undefined)
        return sliced.map((r) => ({ ...r }))
      }
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
    async delete(table: string, matchQueryString: string) {
      const { filters } = parseQuery(matchQueryString)
      const tableRows = getTable(table)
      for (let i = tableRows.length - 1; i >= 0; i -= 1) {
        if (applyFilters([tableRows[i]], filters).length > 0) {
          tableRows.splice(i, 1)
        }
      }
      return null
    },
  }
}

function preparePackageModules({
  supabase,
  supplierId,
  operatorId,
  resellerId,
  apnProfileId,
  apnLiteral = 'iot',
}: {
  supabase: ReturnType<typeof createFakeSupabase>
  supplierId: string
  operatorId: string
  resellerId: string
  apnProfileId?: string
  apnLiteral?: string
}) {
  const roamingProfileId = randomUUID()
  const nowIso = new Date().toISOString()
  supabase.getTable('roaming_profiles').push({
    roaming_profile_id: roamingProfileId,
    name: 'Prep Roaming',
    supplier_id: supplierId,
    operator_id: operatorId,
    status: 'PUBLISHED',
    mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
    published_at: nowIso,
    effective_from: nowIso,
    source_roaming_profile_id: null,
  })
  const resolvedApnProfileId = apnProfileId ?? randomUUID()
  if (!apnProfileId) {
    supabase.getTable('apn_profiles').push({
      apn_profile_id: resolvedApnProfileId,
      name: 'Prep APN',
      apn: apnLiteral,
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: nowIso,
      effective_from: nowIso,
      source_apn_profile_id: null,
    })
  }

  const commercialTermsId = randomUUID()
  const controlPolicyId = randomUUID()
  const carrierServiceId = randomUUID()
  supabase.getTable('commercial_terms_modules').push({
    commercial_terms_id: commercialTermsId,
    name: 'Prep Commercial',
    reseller_id: resellerId,
    commercial_terms: { ...VALID_COMMERCIAL_TERMS },
    status: 'PUBLISHED',
    published_at: nowIso,
    effective_from: nowIso,
  })
  supabase.getTable('control_policy_modules').push({
    control_policy_id: controlPolicyId,
    name: 'Prep control',
    reseller_id: resellerId,
    control_policy: {
      enabled: true,
      cutoff: { timeWindow: 'DAILY', thresholdMb: 512, action: 'DEACTIVATED' },
    },
    status: 'PUBLISHED',
    published_at: nowIso,
    effective_from: nowIso,
  })
  supabase.getTable('carrier_service_modules').push({
    carrier_service_id: carrierServiceId,
    name: 'Prep carrier',
    supplier_id: supplierId,
    operator_id: operatorId,
    reseller_id: resellerId,
    apn_profile_id: resolvedApnProfileId,
    roaming_profile_id: roamingProfileId,
    rat: '4G',
    status: 'PUBLISHED',
    published_at: nowIso,
    effective_from: nowIso,
    deprecated_at: null,
  })

  return {
    carrierServiceId,
    controlPolicyId,
    commercialTermsId,
    commercialTerms: {
      ...VALID_COMMERCIAL_TERMS,
      testExpiryAction: 'DEACTIVATED',
    },
    controlPolicy: {
      enabled: true,
      cutoff: { timeWindow: 'DAILY', thresholdMb: 512, action: 'DEACTIVATED' },
    },
    carrierServiceConfig: {
      supplierId,
      operatorId,
      apnProfileId: resolvedApnProfileId,
      roamingProfileId,
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

  const sampleImportImei = '123456789012345'

  it('accepts platform M2M actor id (non-uuid sub) without db uuid error', async () => {
    const csv = ['iccid,imsi', '8986012345678901299,imsi-z', ''].join('\n')
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      operatorId,
      enterpriseId: null,
      batchId: 'batch-cmp-admin-actor',
      traceId: 'trace-cmp-admin',
      actorUserId: 'cmp-admin',
      actorRole: 'platform_admin',
      resellerId,
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(true)
    expect(supabase.getTable('jobs')[0]?.actor_user_id).toBeNull()
  })

  it('imports sims via csv with idempotency', async () => {
    const csv = [
      'iccid,imsi',
      '8986012345678901234,imsi1',
      '8986012345678901235,imsi2',
      '',
    ].join('\n')
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
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
    expect(supabase.getTable('sims').every((sim: any) => sim.apn == null)).toBe(true)
    expect(supabase.getTable('sims').every((sim: any) => sim.bound_imei == null)).toBe(true)
    expect(supabase.getTable('jobs')[0]?.status).toBe('SUCCEEDED')
    expect(supabase.getTable('audit_logs').length).toBe(2)

    const dup = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
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

  it('rejects import when binding is enabled but imei is missing', async () => {
    const csv = [
      'iccid,imsi,imeiLockEnabled,imei',
      '8986012345678901236,imsi3,true,',
      '',
    ].join('\n')
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      operatorId,
      enterpriseId: null,
      batchId: 'batch-imei-lock-missing-imei',
      traceId: 'trace-imei-lock',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId,
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_FORMAT')
    }
  })

  it('imports mixed binding and non-binding rows', async () => {
    const csv = [
      'iccid,imsi,imeiLockEnabled,imei',
      '8986012345678901290,imsi-a,,',
      `8986012345678901291,imsi-b,true,${sampleImportImei}`,
      '',
    ].join('\n')
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      operatorId,
      enterpriseId: null,
      batchId: 'batch-mixed-binding',
      traceId: 'trace-mixed',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId,
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.totalRows).toBe(2)
    }
    const byIccid = new Map(supabase.getTable('sims').map((s: any) => [s.iccid, s]))
    expect(byIccid.get('8986012345678901290')?.bound_imei ?? null).toBeNull()
    expect(byIccid.get('8986012345678901291')?.bound_imei).toBe(sampleImportImei)
  })

  it('rejects import when operator is not linked to supplier', async () => {
    const csv = [
      'iccid,imsi',
      '8986012345678901299,imsi-wrong-op',
      '',
    ].join('\n')
    const wrongOperator = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const result = await runSimImport({
      supabase,
      csvText: csv,
      supplierId,
      operatorId: wrongOperator,
      enterpriseId: null,
      batchId: 'batch-wrong-operator-001',
      traceId: 'trace-wrong-operator-1',
      actorUserId: 'user-1',
      actorRole: 'reseller_admin',
      resellerId,
      sourceIp: '127.0.0.1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_OPERATOR')
    }
    expect(supabase.getTable('jobs').length).toBe(0)
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

  it('queues status change job when actor sub is cmp-admin (non-uuid)', async () => {
    const simId = randomUUID()
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678901298',
      status: 'INVENTORY',
      enterprise_id: enterpriseId,
    })
    const simIdentifier = parseSimIdentifier(simId)
    if (!simIdentifier.ok) throw new Error('invalid sim identifier')
    const result = await changeSimStatus({
      supabase,
      simIdentifier,
      tenantQs: '',
      action: 'SIM_ACTIVATE',
      newStatus: 'ACTIVATED',
      allowedFrom: new Set(['INVENTORY']),
      reason: null,
      idempotencyKey: null,
      actor: { userId: 'cmp-admin', role: 'platform_admin', roleScope: 'platform' },
      traceId: 'trace-cmp-admin-lifecycle',
      sourceIp: '127.0.0.1',
      commitmentExempt: false,
    })
    expect(result.ok).toBe(true)
    expect(supabase.getTable('jobs')[0]?.actor_user_id).toBeNull()
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
    expect(sim.status).toBe('INVENTORY')
    expect(sim.lifecycle_sub_status).toBe('activating')
    expect(supabase.getTable('sim_state_history').length).toBe(0)
    expect(supabase.getTable('jobs')[0]?.status).toBe('QUEUED')
    if (result.ok) {
      expect(result.jobId).toBeTruthy()
      expect(result.sim?.targetStatus).toBe('ACTIVATED')
    }
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
    const tenant = supabase.getTable('tenants').find((row) => row.tenant_id === enterpriseId)
    tenant.enterprise_status = 'SUSPENDED'
    tenant.parent_id = resellerId
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

  it('batch deactivate requires a non-empty reason', async () => {
    const tenant = supabase.getTable('tenants').find((row) => row.tenant_id === enterpriseId)
    tenant.enterprise_status = 'SUSPENDED'
    tenant.parent_id = resellerId

    const result = await batchDeactivateSims({
      supabase,
      enterpriseId,
      reason: ' ',
      idempotencyKey: null,
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId, roleScope: 'reseller' },
      traceId: 'trace-batch-reason',
      sourceIp: '127.0.0.1',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('reason is required.')
    }
  })

  it('batch deactivate only allows suspended enterprises', async () => {
    const tenant = supabase.getTable('tenants').find((row) => row.tenant_id === enterpriseId)
    tenant.enterprise_status = 'ACTIVE'
    tenant.parent_id = resellerId

    const result = await batchDeactivateSims({
      supabase,
      enterpriseId,
      reason: 'suspended enterprise service interruption',
      idempotencyKey: null,
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId, roleScope: 'reseller' },
      traceId: 'trace-batch-active-enterprise',
      sourceIp: '127.0.0.1',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('INVALID_ENTERPRISE_STATUS')
    }
  })

  it('batch deactivate rejects enterprise outside reseller scope', async () => {
    const tenant = supabase.getTable('tenants').find((row) => row.tenant_id === enterpriseId)
    tenant.enterprise_status = 'SUSPENDED'
    tenant.parent_id = 'other-reseller'

    const result = await batchDeactivateSims({
      supabase,
      enterpriseId,
      reason: 'suspended enterprise service interruption',
      idempotencyKey: null,
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId, roleScope: 'reseller' },
      traceId: 'trace-batch-reseller-scope',
      sourceIp: '127.0.0.1',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.code).toBe('FORBIDDEN')
      expect(result.message).toBe('enterpriseId is out of reseller scope.')
    }
  })

  it('batch deactivate rejects reused idempotencyKey', async () => {
    const tenant = supabase.getTable('tenants').find((row) => row.tenant_id === enterpriseId)
    tenant.enterprise_status = 'SUSPENDED'
    tenant.parent_id = resellerId
    const idempotencyKey = 'batch-deactivate-idem-1'

    const first = await batchDeactivateSims({
      supabase,
      enterpriseId,
      reason: 'suspended enterprise service interruption',
      idempotencyKey,
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId, roleScope: 'reseller' },
      traceId: 'trace-batch-idem-1',
      sourceIp: '127.0.0.1',
    })
    expect(first.ok).toBe(true)

    const second = await batchDeactivateSims({
      supabase,
      enterpriseId,
      reason: 'suspended enterprise service interruption',
      idempotencyKey,
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId, roleScope: 'reseller' },
      traceId: 'trace-batch-idem-2',
      sourceIp: '127.0.0.1',
    })

    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.status).toBe(409)
      expect(second.code).toBe('IDEMPOTENCY_CONFLICT')
    }
  })

  it('batch status change rejects duplicate batchId', async () => {
    const iccid = '8986012345678905599'
    supabase.getTable('sims').push({
      sim_id: randomUUID(),
      iccid,
      status: 'ACTIVATED',
      enterprise_id: enterpriseId,
    })
    const batchKey = 'batch-status-change-dup-test'
    const common = {
      supabase,
      iccids: [iccid],
      tenantQs: '',
      enterpriseId,
      action: 'DEACTIVATE',
      reason: 'batch dup test',
      actor: { userId: 'user-1', role: 'reseller_admin', resellerId: 'reseller-1', roleScope: 'reseller' },
      traceId: 'trace-batch-dup',
      sourceIp: '127.0.0.1',
    }
    const r1 = await batchChangeSimStatus({ ...common, batchId: batchKey })
    expect(r1.ok).toBe(true)
    const r2 = await batchChangeSimStatus({ ...common, batchId: batchKey })
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.code).toBe('DUPLICATE_BATCH')
      expect(r2.status).toBe(409)
    }
    const batchJobs = supabase.getTable('jobs').filter((j) => j.job_type === 'SIM_BATCH_STATUS_CHANGE')
    expect(batchJobs.length).toBe(1)
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
      iccids: [simOk, '8986012345678902002', 'bad-id'],
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
      const retiring = sims.find((s) => s.sim_id === simOk)
      expect(retiring?.status).toBe('DEACTIVATED')
      expect(retiring?.lifecycle_sub_status).toBe('retiring')
      const okItem = result.items.find((item) => item.ok === true)
      expect(okItem?.jobId).toBeTruthy()
      expect(okItem?.lifecycleSubStatus).toBe('retiring')
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

  describe('assignInventorySimsToEnterprise', () => {
    const resellerTenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const childEnterpriseId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const otherEnterpriseId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const foreignEnterpriseId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const otherResellerTenant = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    let localSupabase: ReturnType<typeof createFakeSupabase>

    beforeEach(() => {
      localSupabase = createFakeSupabase({
        tenants: [
          { tenant_id: resellerTenantId, tenant_type: 'RESELLER' },
          {
            tenant_id: childEnterpriseId,
            tenant_type: 'ENTERPRISE',
            parent_id: resellerTenantId,
            enterprise_status: 'ACTIVE',
          },
          { tenant_id: otherEnterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerTenantId, enterprise_status: 'ACTIVE' },
          { tenant_id: foreignEnterpriseId, tenant_type: 'ENTERPRISE', parent_id: otherResellerTenant, enterprise_status: 'ACTIVE' },
          { tenant_id: otherResellerTenant, tenant_type: 'RESELLER' },
        ],
        resellers: [{ id: '11111111-1111-1111-1111-111199999999', tenant_id: resellerTenantId }],
      })
    })

    it('assigns INVENTORY sims to child enterprise', async () => {
      const simId = randomUUID()
      localSupabase.getTable('sims').push({
        sim_id: simId,
        iccid: '8986012345678905511',
        status: 'INVENTORY',
        enterprise_id: null,
        reseller_id: resellerTenantId,
      })
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905511'],
        actor: { userId: 'user-1', role: 'reseller_admin', resellerId: resellerTenantId, roleScope: 'reseller' },
        traceId: 'trace-assign-1',
        sourceIp: '127.0.0.1',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.succeeded).toBe(1)
        expect(result.skipped).toBe(0)
        const row = localSupabase.getTable('sims').find((s) => s.iccid === '8986012345678905511')
        expect(row?.enterprise_id).toBe(childEnterpriseId)
      }
      const summary = localSupabase.getTable('audit_logs').find((a) => a.action === 'SIM_ASSIGN_INVENTORY')
      expect(summary?.after_data?.succeeded).toBe(1)
      expect(summary?.after_data?.skipped).toBe(0)
    })

    it('returns DUPLICATE_BATCH when the same batchId is submitted twice', async () => {
      const simId = randomUUID()
      localSupabase.getTable('sims').push({
        sim_id: simId,
        iccid: '8986012345678905588',
        status: 'INVENTORY',
        enterprise_id: null,
        reseller_id: resellerTenantId,
      })
      const csv = 'iccid\n8986012345678905588\n'
      const fileHash = createHash('sha256').update(Buffer.from(csv, 'utf8')).digest('hex')
      const batchKey = 'assign-inv-batch-dup-test'
      const r1 = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905588'],
        actor: null,
        traceId: 't-dup-1',
        sourceIp: null,
        batchId: batchKey,
        fileHash,
      })
      expect(r1.ok).toBe(true)
      const r2 = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905588'],
        actor: null,
        traceId: 't-dup-2',
        sourceIp: null,
        batchId: batchKey,
        fileHash,
      })
      expect(r2.ok).toBe(false)
      if (!r2.ok) {
        expect(r2.code).toBe('DUPLICATE_BATCH')
        expect(r2.status).toBe(409)
      }
    })

    it('rejects enterprise not under resellerId', async () => {
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: foreignEnterpriseId,
        simIds: ['8986012345678905522'],
        actor: null,
        traceId: 't2',
        sourceIp: null,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('FORBIDDEN')
      }
    })

    it('rejects inactive enterprise', async () => {
      const inactiveId = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      localSupabase.getTable('tenants').push({
        tenant_id: inactiveId,
        tenant_type: 'ENTERPRISE',
        parent_id: resellerTenantId,
        enterprise_status: 'SUSPENDED',
      })
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: inactiveId,
        simIds: ['8986012345678905523'],
        actor: null,
        traceId: 't3',
        sourceIp: null,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('ENTERPRISE_INACTIVE')
      }
    })

    it('returns succeeded 0 when every ICCID is already assigned to an enterprise', async () => {
      localSupabase.getTable('sims').push(
        {
          sim_id: randomUUID(),
          iccid: '8986012345678905701',
          status: 'INVENTORY',
          enterprise_id: childEnterpriseId,
          reseller_id: resellerTenantId,
        },
        {
          sim_id: randomUUID(),
          iccid: '8986012345678905702',
          status: 'INVENTORY',
          enterprise_id: otherEnterpriseId,
          reseller_id: resellerTenantId,
        }
      )
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905701', '8986012345678905702'],
        actor: null,
        traceId: 't-all-skip',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.total).toBe(2)
        expect(result.succeeded).toBe(0)
        expect(result.skipped).toBe(2)
        expect(result.failed).toBe(0)
      }
    })

    it('fails non-INVENTORY sim', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905533',
        status: 'ACTIVATED',
        enterprise_id: null,
        reseller_id: resellerTenantId,
      })
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905533'],
        actor: null,
        traceId: 't4',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.succeeded).toBe(0)
        expect(result.failed).toBe(1)
        const item = result.items[0] as { errorCode?: string }
        expect(item.errorCode).toBe('INVALID_STATE')
      }
    })

    it('skips SIM already on target enterprise without DB update or succeeded count', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905555',
        status: 'INVENTORY',
        enterprise_id: childEnterpriseId,
        reseller_id: resellerTenantId,
      })
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905555'],
        actor: null,
        traceId: 't6',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.total).toBe(1)
        expect(result.succeeded).toBe(0)
        expect(result.failed).toBe(0)
        expect(result.skipped).toBe(1)
        const item = result.items[0] as { skipped?: boolean; currentEnterpriseId?: string }
        expect(item.skipped).toBe(true)
        expect(item.currentEnterpriseId).toBe(childEnterpriseId)
      }
    })

    it('skips SIM already on another enterprise (transfer not implemented)', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905544',
        status: 'INVENTORY',
        enterprise_id: otherEnterpriseId,
        reseller_id: resellerTenantId,
      })
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905544'],
        actor: null,
        traceId: 't5',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.total).toBe(1)
        expect(result.succeeded).toBe(0)
        expect(result.failed).toBe(0)
        expect(result.skipped).toBe(1)
        const item = result.items[0] as { skipped?: boolean; transferNotSupported?: boolean }
        expect(item.skipped).toBe(true)
        expect(item.transferNotSupported).toBe(true)
      }
    })

    it('assigns only unassigned ICCIDs when file mixes pool and already-assigned', async () => {
      localSupabase.getTable('sims').push(
        {
          sim_id: randomUUID(),
          iccid: '8986012345678905601',
          status: 'INVENTORY',
          enterprise_id: null,
          reseller_id: resellerTenantId,
        },
        {
          sim_id: randomUUID(),
          iccid: '8986012345678905602',
          status: 'INVENTORY',
          enterprise_id: otherEnterpriseId,
          reseller_id: resellerTenantId,
        }
      )
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905601', '8986012345678905602'],
        actor: null,
        traceId: 't-mix',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.total).toBe(2)
        expect(result.succeeded).toBe(1)
        expect(result.skipped).toBe(1)
        expect(result.failed).toBe(0)
        const row = localSupabase.getTable('sims').find((s) => s.iccid === '8986012345678905601')
        expect(row?.enterprise_id).toBe(childEnterpriseId)
      }
    })

    it('fails wrong reseller_id on sim', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905566',
        status: 'INVENTORY',
        enterprise_id: null,
        reseller_id: 'bad-reseller-ref-999',
      })
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905566'],
        actor: null,
        traceId: 't7',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.failed).toBe(1)
        const item = result.items[0] as { errorCode?: string }
        expect(item.errorCode).toBe('WRONG_RESELLER')
      }
    })

    it('parses assign-inventory CSV (iccid only)', () => {
      const iccidOnly = parseIccidsFromAssignInventoryCsv('iccid\n8986012345678905511\n')
      expect(iccidOnly.ok).toBe(true)
      if (iccidOnly.ok) {
        expect(iccidOnly.iccids).toEqual(['8986012345678905511'])
      }
      const withImsi = parseIccidsFromAssignInventoryCsv('iccid,imsi\n8986012345678905511,460001234567890\n')
      expect(withImsi.ok).toBe(true)
      if (withImsi.ok) {
        expect(withImsi.iccids).toEqual(['8986012345678905511'])
      }
      const imsiEmptyOk = parseIccidsFromAssignInventoryCsv('iccid,imsi\n8986012345678905511,\n')
      expect(imsiEmptyOk.ok).toBe(true)
      if (imsiEmptyOk.ok) {
        expect(imsiEmptyOk.iccids).toEqual(['8986012345678905511'])
      }
      const missingIccid = parseIccidsFromAssignInventoryCsv('imsi,msisdn\n460001234567890,123\n')
      expect(missingIccid.ok).toBe(false)
    })

    it('accepts sim owned by reseller business id', async () => {
      const bridgeId = '11111111-1111-1111-1111-111199999999'
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905577',
        status: 'INVENTORY',
        enterprise_id: null,
        reseller_id: bridgeId,
      })
      const result = await assignInventorySimsToEnterprise({
        supabase: localSupabase,
        resellerId: resellerTenantId,
        enterpriseId: childEnterpriseId,
        simIds: ['8986012345678905577'],
        actor: null,
        traceId: 't8',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.succeeded).toBe(1)
      }
    })
  })

  describe('assignEnterpriseSimsToDepartment', () => {
    const enterpriseId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const departmentId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const otherDepartmentId = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const otherEnterpriseId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    let localSupabase: ReturnType<typeof createFakeSupabase>

    beforeEach(() => {
      localSupabase = createFakeSupabase({
        tenants: [
          {
            tenant_id: enterpriseId,
            tenant_type: 'ENTERPRISE',
            parent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            enterprise_status: 'ACTIVE',
          },
          { tenant_id: departmentId, tenant_type: 'DEPARTMENT', parent_id: enterpriseId },
          { tenant_id: otherDepartmentId, tenant_type: 'DEPARTMENT', parent_id: enterpriseId },
          {
            tenant_id: otherEnterpriseId,
            tenant_type: 'ENTERPRISE',
            parent_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            enterprise_status: 'ACTIVE',
          },
        ],
      })
    })

    it('assigns enterprise SIMs to department', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905701',
        status: 'ACTIVATED',
        enterprise_id: enterpriseId,
        department_id: null,
      })
      const result = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId,
        iccids: ['8986012345678905701'],
        actor: { userId: 'u1', role: 'customer_admin', roleScope: 'customer' },
        traceId: 'dept-1',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.total).toBe(1)
        expect(result.succeeded).toBe(1)
        expect(result.failed).toBe(0)
        expect(result.skipped).toBe(0)
        const row = localSupabase.getTable('sims').find((s) => s.iccid === '8986012345678905701')
        expect(row?.department_id).toBe(departmentId)
        const item = result.items[0] as { ok?: boolean; departmentId?: string }
        expect(item.ok).toBe(true)
        expect(item.departmentId).toBe(departmentId)
      }
    })

    it('skips SIM already on target department', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905702',
        status: 'ACTIVATED',
        enterprise_id: enterpriseId,
        department_id: departmentId,
      })
      const result = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId,
        iccids: ['8986012345678905702'],
        actor: null,
        traceId: 'dept-2',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.succeeded).toBe(0)
        expect(result.skipped).toBe(1)
        expect(result.failed).toBe(0)
      }
    })

    it('moves SIM from another department within enterprise', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905703',
        status: 'ACTIVATED',
        enterprise_id: enterpriseId,
        department_id: otherDepartmentId,
      })
      const result = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId,
        iccids: ['8986012345678905703'],
        actor: null,
        traceId: 'dept-3',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.succeeded).toBe(1)
        const row = localSupabase.getTable('sims').find((s) => s.iccid === '8986012345678905703')
        expect(row?.department_id).toBe(departmentId)
      }
    })

    it('fails when SIM is not on enterprise', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905704',
        status: 'INVENTORY',
        enterprise_id: null,
        department_id: null,
      })
      const result = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId,
        iccids: ['8986012345678905704'],
        actor: null,
        traceId: 'dept-4',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.failed).toBe(1)
        const item = result.items[0] as { errorCode?: string }
        expect(item.errorCode).toBe('WRONG_ENTERPRISE')
      }
    })

    it('fails when SIM belongs to another enterprise', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905705',
        status: 'ACTIVATED',
        enterprise_id: otherEnterpriseId,
        department_id: null,
      })
      const result = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId,
        iccids: ['8986012345678905705'],
        actor: null,
        traceId: 'dept-5',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.failed).toBe(1)
        const item = result.items[0] as { errorCode?: string }
        expect(item.errorCode).toBe('WRONG_ENTERPRISE')
      }
    })

    it('fails when ICCID not in database', async () => {
      const result = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId,
        iccids: ['8986012345678905799'],
        actor: null,
        traceId: 'dept-6',
        sourceIp: null,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.failed).toBe(1)
        const item = result.items[0] as { errorCode?: string; simId?: string | null }
        expect(item.errorCode).toBe('RESOURCE_NOT_FOUND')
        expect(item.simId).toBeNull()
      }
    })

    it('rejects department not under enterprise', async () => {
      const foreignDept = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
      localSupabase.getTable('tenants').push({
        tenant_id: foreignDept,
        tenant_type: 'DEPARTMENT',
        parent_id: otherEnterpriseId,
      })
      const result = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId: foreignDept,
        iccids: ['8986012345678905701'],
        actor: null,
        traceId: 'dept-7',
        sourceIp: null,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(403)
      }
    })

    it('returns DUPLICATE_BATCH when the same batchId is submitted twice', async () => {
      localSupabase.getTable('sims').push({
        sim_id: randomUUID(),
        iccid: '8986012345678905710',
        status: 'ACTIVATED',
        enterprise_id: enterpriseId,
        department_id: null,
      })
      const batchKey = 'assign-dept-batch-dup'
      const fileHash = createHash('sha256').update('iccid\n8986012345678905710\n', 'utf8').digest('hex')
      const r1 = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId,
        iccids: ['8986012345678905710'],
        actor: null,
        traceId: 'dept-dup-1',
        sourceIp: null,
        batchId: batchKey,
        fileHash,
      })
      expect(r1.ok).toBe(true)
      const r2 = await assignEnterpriseSimsToDepartment({
        supabase: localSupabase,
        enterpriseId,
        departmentId,
        iccids: ['8986012345678905710'],
        actor: null,
        traceId: 'dept-dup-2',
        sourceIp: null,
        batchId: batchKey,
        fileHash,
      })
      expect(r2.ok).toBe(false)
      if (!r2.ok) {
        expect(r2.code).toBe('DUPLICATE_BATCH')
        expect(r2.status).toBe(409)
      }
    })
  })
})

describe('phase5', () => {
  const supplierId = '11111111-1111-1111-1111-111111111111'
  const operatorId = '22222222-2222-2222-2222-222222222222'
  const carrierId = '99999999-9999-9999-9999-999999999999'
  const enterpriseId = '33333333-3333-3333-3333-333333333333'
  const resellerId = '55555555-5555-5555-5555-555555555555'
  let supabase: ReturnType<typeof createFakeSupabase>
  let sharedCoveredNetworkProfileId: string

  function seedCoveredNetworkProfile(opts: { status?: 'DRAFT' | 'PUBLISHED'; resellerId?: string | null; coverageMode?: 'LIST' | 'NONE' } = {}) {
    const id = randomUUID()
    const status = opts.status ?? 'DRAFT'
    const nowIso = new Date().toISOString()
    supabase.getTable('covered_network_profiles').push({
      covered_network_profile_id: id,
      name: 'Phase5 covered',
      reseller_id: opts.resellerId === undefined ? null : opts.resellerId,
      supplier_id: supplierId,
      operator_id: operatorId,
      coverage_mode: opts.coverageMode ?? 'LIST',
      status,
      published_at: status === 'PUBLISHED' ? nowIso : null,
      effective_from: status === 'PUBLISHED' ? nowIso : null,
      source_covered_network_profile_id: null,
    })
    return id
  }

  beforeEach(() => {
    supabase = createFakeSupabase({
      suppliers: [{ supplier_id: supplierId }],
      operators: [{ operator_id: operatorId, supplier_id: supplierId, carrier_id: carrierId }],
      business_operators: [{ operator_id: operatorId, mcc: '001', mnc: '01', name: 'Operator A' }],
      reseller_suppliers: [{ reseller_id: resellerId, supplier_id: supplierId }],
      tenants: [
        { tenant_id: resellerId, tenant_type: 'RESELLER', parent_id: null, name: 'Phase5 reseller', enterprise_status: null },
        {
          tenant_id: enterpriseId,
          tenant_type: 'ENTERPRISE',
          parent_id: resellerId,
          name: 'Phase5 enterprise',
          enterprise_status: 'ACTIVE',
        },
      ],
      resellers: [
        {
          id: resellerId,
          tenant_id: resellerId,
          name: 'Phase5 reseller',
          status: 'ACTIVE',
        },
      ],
    })
    sharedCoveredNetworkProfileId = seedCoveredNetworkProfile({ status: 'PUBLISHED' })
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
    if (!result.ok) return
    expect((result.value as any).profileId).toBeUndefined()
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
      expect(result.message).toBe('supplierId, operatorId, or apnProfileId is required.')
    }
  })

  it('rejects roaming profile creation when resellerId is not a uuid', async () => {
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming bad reseller',
        resellerId: 'not-a-uuid',
        mccmncList: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
        supplierId,
        operatorId,
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('resellerId must be a valid uuid.')
    }
  })

  it('rejects roaming profile creation when operatorId is empty string', async () => {
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming no operator',
        resellerId,
        supplierId,
        operatorId: '',
        mccmncList: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('operatorId is required.')
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
          { mcc: '001', mnc: '01', ratePerMb: 0.0005 },
          { mcc: '001', mnc: '01', ratePerMb: 0.0004 },
        ],
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as any).profileId).toBeUndefined()
    const row = supabase.getTable('roaming_profiles')[0]
    expect(row?.supplier_id).toBe(supplierId)
    expect(Array.isArray(row?.mccmnc_list)).toBe(true)
    expect(row?.mccmnc_list?.[0]?.ratePerMb).toBe(0.0005)
  })

  it('persists optional country and network on mccmncList entries (display only)', async () => {
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming with labels',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [
          {
            mcc: '460',
            mnc: '*',
            country: 'China',
            network: '',
            ratePerMb: 0.0038,
          },
          {
            mcc: '502',
            mnc: '12',
            country: 'Malaysia',
            network: 'Maxis',
            ratePerMb: 0.0012,
          },
        ],
      },
    })
    expect(result.ok).toBe(true)
    const row = supabase.getTable('roaming_profiles')[0]
    expect(row?.mccmnc_list?.[0]).toMatchObject({
      mcc: '460',
      mnc: '*',
      country: 'China',
      network: '',
      ratePerMb: 0.0038,
    })
    expect(row?.mccmnc_list?.[1]).toMatchObject({
      mcc: '502',
      mnc: '12',
      country: 'Malaysia',
      network: 'Maxis',
      ratePerMb: 0.0012,
    })
  })

  it('rejects mccmncList country longer than 128 characters', async () => {
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming long country',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [{ mcc: '460', mnc: '00', country: 'x'.repeat(129), ratePerMb: 0.001 }],
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('country')
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
          { mcc: '250', mnc: '20', ratePerMb: 0.0008 },
          { mcc: '502', mnc: '*', ratePerMb: 0.0012 },
        ],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('DRAFT')
    }
    const row = supabase.getTable('roaming_profiles')[0]
    expect(row?.mccmnc_list?.[0]).toMatchObject({ mcc: '250', mnc: '20', ratePerMb: 0.0008 })
    expect(row?.mccmnc_list?.[1]).toMatchObject({ mcc: '502', mnc: '*', ratePerMb: 0.0012 })
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
      expect(result.message).toBe('supplierId, operatorId, or roamingProfileId is required.')
    }
  })

  it('updates DRAFT roaming profile snapshot mccmncList in place', async () => {
    const created = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming snapshot edit',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [
          { mcc: '460', mnc: '00', ratePerMb: 0.001 },
          { mcc: '454', mnc: '*', ratePerMb: 0.002 },
        ],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const updated = await updateRoamingProfile({
      supabase,
      roamingProfileId: created.value.roamingProfileId,
      payload: {
        mccmncList: [
          { mcc: '460', mnc: '00', ratePerMb: 0.0015 },
          { mcc: '001', mnc: '99', ratePerMb: 0.003 },
        ],
      },
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    const row = supabase
      .getTable('roaming_profiles')
      .find((r: any) => r.roaming_profile_id === created.value.roamingProfileId)
    expect(row?.mccmnc_list?.length).toBe(2)
    expect(row?.mccmnc_list?.find((e: any) => e.mcc === '460' && e.mnc === '00')?.ratePerMb).toBe(0.0015)
  })

  it('rejects update when roaming profile is not DRAFT', async () => {
    const created = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming published immutability',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [{ mcc: '460', mnc: '11', ratePerMb: 0.001 }],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const pub = await publishRoamingProfile({ supabase, roamingProfileId: created.value.roamingProfileId })
    expect(pub.ok).toBe(true)
    const updated = await updateRoamingProfile({
      supabase,
      roamingProfileId: created.value.roamingProfileId,
      payload: { name: 'Should fail' },
    })
    expect(updated.ok).toBe(false)
    if (!updated.ok) {
      expect(updated.code).toBe('INVALID_STATUS')
    }
  })

  it('deprecates PUBLISHED roaming profile snapshot', async () => {
    const created = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Roaming deprecate',
        resellerId,
        supplierId,
        operatorId,
        mccmncList: [{ mcc: '460', mnc: '01', ratePerMb: 0.002 }],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const pub = await publishRoamingProfile({ supabase, roamingProfileId: created.value.roamingProfileId })
    expect(pub.ok).toBe(true)
    if (!pub.ok) return
    expect((pub.value as any).profileId).toBeUndefined()
    const dep = await deprecateRoamingProfile({ supabase, roamingProfileId: created.value.roamingProfileId })
    expect(dep.ok).toBe(true)
    if (dep.ok) {
      expect((dep.value as any).profileId).toBeUndefined()
      expect(dep.value.status).toBe('DEPRECATED')
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

  it('createPricePlan stores null actor_user_id when platform token sub is cmp-admin', async () => {
    const result = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Admin price plan',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
      audit: { actorUserId: 'cmp-admin', actorRole: 'platform_admin' },
    })
    expect(result.ok).toBe(true)
    const audits = supabase.getTable('audit_logs')
    expect(audits.length).toBe(1)
    expect(audits[0].actor_user_id).toBeNull()
    expect(audits[0].action).toBe('PRICE_PLAN_CREATED')
  })

  it('creates price plan and publishes package', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const publishPlanFirst = await publishPricePlan({ supabase, pricePlanId: planId })
    expect(publishPlanFirst.ok).toBe(true)
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package A',
        pricePlanId: planId,
        ...preparePackageModules({ supabase, supplierId, operatorId, resellerId }),
      },
    })
    expect(packageResult.ok).toBe(true)
    const publishResult = await publishPackageWithMapping({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishResult.ok).toBe(true)
  })

  it('fails package create when price plan is still DRAFT', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Draft plan block',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package draft PP',
        pricePlanId: planId,
        ...preparePackageModules({ supabase, supplierId, operatorId, resellerId }),
      },
    })
    expect(packageResult.ok).toBe(false)
    if (packageResult.ok === false) {
      expect(packageResult.code).toBe('BAD_REQUEST')
      expect(String(packageResult.message || '')).toMatch(/PUBLISHED/i)
    }
  })

  it('blocks deprecating published price plan when latest package version still references it', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Deprecate blocked plan',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 12,
        deactivatedMonthlyFee: 2,
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const pricePlanId = planResult.ok ? planResult.value.pricePlanId : ''
    const publishPlanResult = await publishPricePlan({ supabase, pricePlanId })
    expect(publishPlanResult.ok).toBe(true)
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Blocking package',
        pricePlanId,
        ...preparePackageModules({ supabase, supplierId, operatorId, resellerId }),
      },
    })
    expect(packageResult.ok).toBe(true)
    const packageId = packageResult.ok ? packageResult.value.packageId : ''
    const deprecateResult = await deprecatePricePlan({ supabase, pricePlanId })
    expect(deprecateResult.ok).toBe(false)
    expect((deprecateResult as any).code).toBe('RESOURCE_IN_USE')
    expect(String((deprecateResult as any).message || '')).toContain(packageId)
  })

  it('deprecates published price plan when no package references it', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Deprecate free plan',
        type: 'FIXED_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 20,
        deactivatedMonthlyFee: 3,
        totalQuotaMb: 2048,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const pricePlanId = planResult.ok ? planResult.value.pricePlanId : ''
    const publishPlanResult = await publishPricePlan({ supabase, pricePlanId })
    expect(publishPlanResult.ok).toBe(true)
    const deprecateResult = await deprecatePricePlan({ supabase, pricePlanId })
    expect(deprecateResult.ok).toBe(true)
    if (deprecateResult.ok) {
      expect((deprecateResult.value as any).status).toBe('DEPRECATED')
    }
  })

  it('creates fallback-compatible fixed bundle price plan with zero fees and quota', async () => {
    const fallbackCoveredNetworkProfileId = seedCoveredNetworkProfile({
      status: 'PUBLISHED',
      resellerId,
      coverageMode: 'NONE',
    })
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Default fallback fixed bundle',
        type: 'FIXED_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 0,
        deactivatedMonthlyFee: 0,
        totalQuotaMb: 0,
        coveredNetworkProfileId: fallbackCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return

    const detail = await getPricePlanDetail({ supabase, pricePlanId: planResult.value.pricePlanId })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect((detail.value as any).monthlyFee).toBe(0)
    expect((detail.value as any).deactivatedMonthlyFee).toBe(0)
    expect((detail.value as any).totalQuotaMb).toBe(0)
  })

  it('validates commercial terms module independently', async () => {
    const result = validateCommercialTermsModule({
      commercialTerms: { ...VALID_COMMERCIAL_TERMS },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as any).commercialTerms?.testPeriodDays).toBe(7)
    }
  })

  it('validates control policy module independently', async () => {
    const result = await validateControlPolicyModule({
      supabase,
      payload: {
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'DAILY', thresholdMb: 512, action: 'DEACTIVATED' },
          throttling: {
            timeWindow: 'MONTHLY',
            tiers: [{ thresholdMb: 0, downlinkKbps: 1000, uplinkKbps: 1000 }],
          },
        },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as any).controlPolicy?.cutoff?.thresholdMb).toBe(512)
    }
  })

  it('rejects legacy controlPolicy keys (cutoffPolicyId / throttlingPolicyId / cutoffThresholdMb)', async () => {
    const bad = await validateControlPolicyModule({
      supabase,
      payload: {
        controlPolicy: {
          enabled: true,
          cutoffPolicyId: randomUUID(),
        },
      },
    })
    expect(bad.ok).toBe(false)
  })

  it('validates carrier service module independently', async () => {
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Validate Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'Validate APN',
      apn: 'iot',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const result = await validateCarrierServiceModule({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apnProfileId,
          roamingProfileId,
        },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as any).carrierServiceConfig?.operatorId).toBe(operatorId)
    }
  })

  it('validates carrier service when operatorId is business_operators.operator_id (resolves to operators.operator_id)', async () => {
    const businessOperatorId = randomUUID()
    const supplierOperatorPk = randomUUID()
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('business_operators').push({
      operator_id: businessOperatorId,
      mcc: '460',
      mnc: '02',
      name: 'Business op for carrier',
    })
    supabase.getTable('operators').push({
      operator_id: supplierOperatorPk,
      supplier_id: supplierId,
      business_operator_id: businessOperatorId,
      carrier_id: carrierId,
    })
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Validate Roaming BO',
      supplier_id: supplierId,
      operator_id: supplierOperatorPk,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'Validate APN BO',
      apn: 'iot.bo',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: supplierOperatorPk,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const result = await validateCarrierServiceModule({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId: businessOperatorId,
          apnProfileId,
          roamingProfileId,
        },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as any).carrierServiceConfig?.operatorId).toBe(supplierOperatorPk)
    }
  })

  it('returns catalog operator id in carrier service create, detail, list, and validate-for-API responses', async () => {
    const businessOperatorId = randomUUID()
    const supplierOperatorPk = randomUUID()
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('business_operators').push({
      operator_id: businessOperatorId,
      mcc: '460',
      mnc: '03',
      name: 'Catalog op carrier response',
    })
    supabase.getTable('operators').push({
      operator_id: supplierOperatorPk,
      supplier_id: supplierId,
      business_operator_id: businessOperatorId,
      carrier_id: carrierId,
    })
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'CS response Roaming',
      supplier_id: supplierId,
      operator_id: supplierOperatorPk,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'CS response APN',
      apn: 'iot.cr',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: supplierOperatorPk,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const validateResult = await validateCarrierServiceModule({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId: businessOperatorId,
          apnProfileId,
          roamingProfileId,
        },
      },
    })
    expect(validateResult.ok).toBe(true)
    if (validateResult.ok) {
      const apiPayload = await formatCarrierServiceValidationResponseForApi(supabase, validateResult.value)
      expect((apiPayload as any).carrierServiceConfig?.operatorId).toBe(businessOperatorId)
    }

    const createResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Carrier service (business operator)',
        carrierServiceConfig: {
          supplierId,
          operatorId: businessOperatorId,
          apnProfileId,
          roamingProfileId,
        },
      },
    })
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return
    expect((createResult.value as any).carrierServiceConfig?.operatorId).toBe(businessOperatorId)

    const modRow = supabase
      .getTable('carrier_service_modules')
      .find((r: any) => r.carrier_service_id === (createResult.value as any).carrierServiceId)
    expect(modRow?.operator_id).toBe(supplierOperatorPk)

    const detailResult = await getCarrierServiceDetail({
      supabase,
      carrierServiceId: (createResult.value as any).carrierServiceId,
    })
    expect(detailResult.ok).toBe(true)
    if (detailResult.ok) {
      expect((detailResult.value as any).carrierServiceConfig?.operatorId).toBe(businessOperatorId)
    }

    const listResult = await listCarrierServices({ supabase, page: 1, pageSize: 50 })
    expect(listResult.ok).toBe(true)
    if (!listResult.ok) return
    const listed = listResult.value.items.find(
      (it: any) => it?.carrierServiceId === (createResult.value as any).carrierServiceId
    )
    expect((listed as any)?.carrierServiceConfig?.operatorId).toBe(businessOperatorId)
  })

  it('rejects carrier service when apnProfileId operator does not match resolved operator', async () => {
    const otherOperatorPk = randomUUID()
    supabase.getTable('operators').push({
      operator_id: otherOperatorPk,
      supplier_id: supplierId,
      business_operator_id: null,
      carrier_id: carrierId,
    })
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Roaming op mismatch',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'APN wrong operator',
      apn: 'wrong.op',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: otherOperatorPk,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const result = await validateCarrierServiceModule({
      supabase,
      payload: {
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apnProfileId,
          roamingProfileId,
        },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('apnProfileId')
      expect(result.message).toContain('operatorId')
    }
  })

  it('creates carrier service when resellerId is tenants.tenant_id (stored as reseller tenant FK)', async () => {
    const resellerRecordId = randomUUID()
    const resellerTenantId = randomUUID()
    supabase.getTable('resellers').push({
      id: resellerRecordId,
      tenant_id: resellerTenantId,
      name: 'Reseller for carrier FK',
      status: 'ACTIVE',
    })
    supabase.getTable('reseller_suppliers').push({
      reseller_id: resellerTenantId,
      supplier_id: supplierId,
      created_at: new Date().toISOString(),
    })
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Carrier Roaming FR058',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'Test APN FR058',
      apn: 'iot',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const createResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Carrier service FR058',
        resellerId: resellerTenantId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          roamingProfileId,
          apnProfileId,
        },
      },
      audit: {
        actorUserId: 'user-1',
        actorRole: 'reseller_admin',
        requestId: 'req-carrier-reseller-fr058',
        sourceIp: '127.0.0.1',
      },
    })
    expect(createResult.ok).toBe(true)
    if (createResult.ok) {
      expect((createResult.value as any).resellerId).toBe(resellerTenantId)
    }
    const modRows = supabase.getTable('carrier_service_modules')
    const row = modRows.find((r: any) => r.carrier_service_id === (createResult as any).value?.carrierServiceId)
    expect(row?.reseller_id).toBe(resellerTenantId)
  })

  it('createCarrierService stores null actor_user_id when platform token sub is cmp-admin', async () => {
    const resellerRecordId = randomUUID()
    const resellerTenantId = randomUUID()
    supabase.getTable('resellers').push({
      id: resellerRecordId,
      tenant_id: resellerTenantId,
      name: 'Reseller platform admin CS',
      status: 'ACTIVE',
    })
    supabase.getTable('reseller_suppliers').push({
      reseller_id: resellerTenantId,
      supplier_id: supplierId,
      created_at: new Date().toISOString(),
    })
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Roam platform admin CS',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'APN platform admin CS',
      apn: 'iot',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const createResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Platform admin carrier service',
        resellerId: resellerTenantId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          roamingProfileId,
          apnProfileId,
        },
      },
      auth: { scope: 'platform', resellerTenantId: null },
      audit: { actorUserId: 'cmp-admin', actorRole: 'platform_admin' },
    })
    expect(createResult.ok).toBe(true)
    const audits = supabase.getTable('audit_logs')
    expect(audits.length).toBe(1)
    expect(audits[0].actor_user_id).toBeNull()
    expect(audits[0].action).toBe('CARRIER_SERVICE_CREATED')
  })

  it('createCarrierService with platform auth rejects missing resellerId', async () => {
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Roam platform req',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'APN platform req',
      apn: 'iot',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const result = await createCarrierService({
      supabase,
      payload: {
        name: 'Platform missing reseller',
        enterpriseId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          roamingProfileId,
          apnProfileId,
        },
      },
      auth: { scope: 'platform', resellerTenantId: null },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe('resellerId is required.')
    }
  })

  it('createCarrierService with reseller auth fills reseller from token when body omits resellerId', async () => {
    const resellerRecordId = randomUUID()
    const resellerTenantId = randomUUID()
    supabase.getTable('resellers').push({
      id: resellerRecordId,
      tenant_id: resellerTenantId,
      name: 'Implicit reseller CS',
      status: 'ACTIVE',
    })
    supabase.getTable('reseller_suppliers').push({
      reseller_id: resellerTenantId,
      supplier_id: supplierId,
      created_at: new Date().toISOString(),
    })
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Roam implicit',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'APN implicit',
      apn: 'iot',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const createResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Implicit reseller carrier service',
        enterpriseId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          roamingProfileId,
          apnProfileId,
        },
      },
      auth: { scope: 'reseller', resellerTenantId: resellerTenantId },
    })
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return
    expect((createResult.value as any).resellerId).toBe(resellerTenantId)
    const row = supabase
      .getTable('carrier_service_modules')
      .find((r: any) => r.carrier_service_id === (createResult.value as any).carrierServiceId)
    expect(row?.reseller_id).toBe(resellerTenantId)
  })

  it('creates, updates and queries commercial terms module', async () => {
    const createResult = await createCommercialTerms({
      supabase,
      payload: {
        name: 'Commercial terms CRUD',
        enterpriseId,
        commercialTerms: {
          ...VALID_COMMERCIAL_TERMS,
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
          ...VALID_COMMERCIAL_TERMS,
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
    const createResult = await createControlPolicy({
      supabase,
      payload: {
        name: 'Control policy CRUD',
        enterpriseId,
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'DAILY', thresholdMb: 256, action: 'DEACTIVATED' },
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
          throttling: {
            timeWindow: 'MONTHLY',
            tiers: [{ thresholdMb: 0, downlinkKbps: 2048, uplinkKbps: 1024 }],
          },
          cutoff: { timeWindow: 'DAILY', thresholdMb: 512, action: 'DEACTIVATED' },
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
      expect((updateResult.value as any).controlPolicy?.cutoff?.thresholdMb).toBe(512)
      expect((updateResult.value as any).controlPolicy?.throttling?.tiers?.length).toBe(1)
    }

    const detailResult = await getControlPolicyDetail({ supabase, controlPolicyId })
    expect(detailResult.ok).toBe(true)
    if (detailResult.ok) {
      expect((detailResult.value as any).controlPolicyId).toBe(controlPolicyId)
    }
  })

  it('creates, updates and queries carrier service module', async () => {
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Carrier Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'Test APN',
      apn: 'iot',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const apnProfileIdUpdated = randomUUID()
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileIdUpdated,
      name: 'Test APN updated',
      apn: 'iot-updated',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const createResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Carrier create/update flow',
        enterpriseId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          roamingProfileId,
          apnProfileId,
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
          apnProfileId: apnProfileIdUpdated,
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
      expect((updateResult.value as any).carrierServiceConfig?.apnProfileId).toBe(apnProfileIdUpdated)
      expect((updateResult.value as any).carrierServiceConfig?.roamingProfileId).toBe(roamingProfileId)
    }

    const detailResult = await getCarrierServiceDetail({ supabase, carrierServiceId })
    expect(detailResult.ok).toBe(true)
    if (detailResult.ok) {
      expect((detailResult.value as any).carrierServiceId).toBe(carrierServiceId)
    }
  })

  it('uses apn/roaming/rat columns for carrier module (detail, list filter, package create)', async () => {
    const apnColumn = randomUUID()
    const apnStaleJson = randomUUID()
    const roamingColumn = randomUUID()
    const carrierServiceId = randomUUID()
    const nowIso = new Date().toISOString()

    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingColumn,
      name: 'R col',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: nowIso,
      effective_from: nowIso,
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push(
      {
        apn_profile_id: apnColumn,
        name: 'APN col',
        apn: 'iot-col',
        auth_type: 'NONE',
        username: null,
        password_ref: null,
        supplier_id: supplierId,
        operator_id: operatorId,
        status: 'PUBLISHED',
        published_at: nowIso,
        effective_from: nowIso,
        source_apn_profile_id: null,
      },
      {
        apn_profile_id: apnStaleJson,
        name: 'APN stale',
        apn: 'iot-stale',
        auth_type: 'NONE',
        username: null,
        password_ref: null,
        supplier_id: supplierId,
        operator_id: operatorId,
        status: 'PUBLISHED',
        published_at: nowIso,
        effective_from: nowIso,
        source_apn_profile_id: null,
      }
    )

    supabase.getTable('carrier_service_modules').push({
      carrier_service_id: carrierServiceId,
      name: 'Column wins carrier',
      status: 'PUBLISHED',
      supplier_id: supplierId,
      operator_id: operatorId,
      reseller_id: resellerId,
      apn_profile_id: apnColumn,
      roaming_profile_id: roamingColumn,
      rat: '5G',
      effective_from: nowIso,
      published_at: nowIso,
      deprecated_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    })

    const detailResult = await getCarrierServiceDetail({ supabase, carrierServiceId })
    expect(detailResult.ok).toBe(true)
    if (detailResult.ok) {
      expect((detailResult.value as any).carrierServiceConfig?.apnProfileId).toBe(apnColumn)
      expect((detailResult.value as any).carrierServiceConfig?.roamingProfileId).toBe(roamingColumn)
      expect((detailResult.value as any).carrierServiceConfig?.rat).toBe('5G')
    }

    const listByColumnApn = await listCarrierServices({ supabase, apnProfileId: apnColumn, page: 1, pageSize: 20 })
    expect(listByColumnApn.ok).toBe(true)
    if (listByColumnApn.ok) {
      expect(listByColumnApn.value.items.some((it: any) => it.carrierServiceId === carrierServiceId)).toBe(true)
    }

    const listByStaleApn = await listCarrierServices({ supabase, apnProfileId: apnStaleJson, page: 1, pageSize: 20 })
    expect(listByStaleApn.ok).toBe(true)
    if (listByStaleApn.ok) {
      expect(listByStaleApn.value.items.some((it: any) => it.carrierServiceId === carrierServiceId)).toBe(false)
    }

    const listByColumnRoaming = await listCarrierServices({
      supabase,
      roamingProfileId: roamingColumn,
      page: 1,
      pageSize: 20,
    })
    expect(listByColumnRoaming.ok).toBe(true)
    if (listByColumnRoaming.ok) {
      expect(listByColumnRoaming.value.items.some((it: any) => it.carrierServiceId === carrierServiceId)).toBe(true)
    }

    const controlResult = await createControlPolicy({
      supabase,
      payload: {
        name: 'Control for column-win carrier',
        resellerId,
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'DAILY', thresholdMb: 128, action: 'DEACTIVATED' },
        },
      },
    })
    expect(controlResult.ok).toBe(true)
    const commercialResult = await createCommercialTerms({
      supabase,
      payload: {
        name: 'Commercial for column-win carrier',
        resellerId,
        commercialTerms: {
          ...VALID_COMMERCIAL_TERMS,
        },
      },
    })
    expect(commercialResult.ok).toBe(true)
    const commercialPublish = await publishCommercialTerms({
      supabase,
      commercialTermsId: (commercialResult as any).value.commercialTermsId,
    })
    expect(commercialPublish.ok).toBe(true)
    const controlPublish = await publishControlPolicy({
      supabase,
      controlPolicyId: (controlResult as any).value.controlPolicyId,
    })
    expect(controlPublish.ok).toBe(true)

    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Plan column-win carrier',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 20,
        deactivatedMonthlyFee: 2,
        perSimQuotaMb: 4096,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const pubPlanCol = await publishPricePlan({ supabase, pricePlanId: (planResult as any).value.pricePlanId })
    expect(pubPlanCol.ok).toBe(true)
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package column-win carrier',
        pricePlanId: (planResult as any).value.pricePlanId,
        carrierServiceId,
        controlPolicyId: (controlResult as any).value.controlPolicyId,
        commercialTermsId: (commercialResult as any).value.commercialTermsId,
      },
    })
    expect(packageResult.ok).toBe(true)
    const packageRow = supabase
      .getTable('packages')
      .find((r: any) => r.package_id === (packageResult as any).value.packageId)
    expect(packageRow?.carrier_service_id).toBe(carrierServiceId)
    const pkgDetail = await getPackageDetail({ supabase, packageId: (packageResult as any).value.packageId })
    expect(pkgDetail.ok).toBe(true)
    if (pkgDetail.ok) {
      expect((pkgDetail.value as any).apnProfile?.apn).toBe('iot-col')
      expect((pkgDetail.value as any).carrierService?.carrierServiceConfig?.apnProfileId).toBe(apnColumn)
      expect((pkgDetail.value as any).carrierService?.carrierServiceConfig?.roamingProfileId).toBe(roamingColumn)
      expect((pkgDetail.value as any).carrierService?.carrierServiceConfig?.rat).toBe('5G')
    }
  })

  it('creates package by module ids and stores module references', async () => {
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Package IDs Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'Test APN',
      apn: 'iot',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const carrierResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Package module IDs carrier',
        resellerId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          roamingProfileId,
          apnProfileId,
        },
      },
    })
    expect(carrierResult.ok).toBe(true)
    const carrierPublishForPackage = await publishCarrierService({
      supabase,
      carrierServiceId: (carrierResult as any).value.carrierServiceId,
    })
    expect(carrierPublishForPackage.ok).toBe(true)
    const controlResult = await createControlPolicy({
      supabase,
      payload: {
        name: 'Control for package by module ids',
        resellerId,
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'DAILY', thresholdMb: 128, action: 'DEACTIVATED' },
        },
      },
    })
    expect(controlResult.ok).toBe(true)
    const commercialResult = await createCommercialTerms({
      supabase,
      payload: {
        name: 'Commercial for package by module ids',
        resellerId,
        commercialTerms: {
          ...VALID_COMMERCIAL_TERMS,
        },
      },
    })
    expect(commercialResult.ok).toBe(true)
    const commercialPublishForPackage = await publishCommercialTerms({
      supabase,
      commercialTermsId: (commercialResult as any).value.commercialTermsId,
    })
    expect(commercialPublishForPackage.ok).toBe(true)
    const controlPublishForPackage = await publishControlPolicy({
      supabase,
      controlPolicyId: (controlResult as any).value.controlPolicyId,
    })
    expect(controlPublishForPackage.ok).toBe(true)
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 4096,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const pricePlanId = planResult.ok ? planResult.value.pricePlanId : ''
    const pubIdsPlan = await publishPricePlan({ supabase, pricePlanId })
    expect(pubIdsPlan.ok).toBe(true)
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
    const packageRow = supabase
      .getTable('packages')
      .find((r) => r.package_id === (packageResult as any).value.packageId)
    expect(packageRow?.carrier_service_id).toBe(carrierResult.ok ? (carrierResult.value as any).carrierServiceId : null)
    expect(packageRow?.control_policy_id).toBe(controlResult.ok ? (controlResult.value as any).controlPolicyId : null)
    expect(packageRow?.commercial_terms_id).toBe(commercialResult.ok ? (commercialResult.value as any).commercialTermsId : null)
    const byIdsDetail = await getPackageDetail({ supabase, packageId: (packageResult as any).value.packageId })
    expect(byIdsDetail.ok).toBe(true)
    if (byIdsDetail.ok) {
      expect((byIdsDetail.value as any).apnProfile?.apn).toBe('iot')
      expect((byIdsDetail.value as any).carrierService?.carrierServiceConfig?.apnProfileId).toBe(apnProfileId)
    }
  })

  it('rejects package create when only pricePlanId is given (modules are not copied from price plan)', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Lean plan for package-only-modules',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const leanPub = await publishPricePlan({ supabase, pricePlanId: planId })
    expect(leanPub.ok).toBe(true)
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package missing modules',
        pricePlanId: planId,
      },
    })
    expect(packageResult.ok).toBe(false)
    if (!packageResult.ok) {
      expect(packageResult.code).toBe('BAD_REQUEST')
    }
  })

  it('creates price plan with price_plan_type tiered pricing payload', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        tiers: [{ fromMb: 0, toMb: 1024, ratePerMb: 0.01 }],
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const row = supabase.getTable('price_plans')[0]
    expect(row?.type).toBe('TIERED_VOLUME_PRICING')
  })

  it('creates tiered price plan with price_plan_type payload alias', async () => {
    const createResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Tiered Alias',
        price_plan_type: 'TIERED_PRICING',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 12,
        deactivatedMonthlyFee: 1,
        tiers: [{ fromMb: 0, toMb: 2048, ratePerMb: 0.008 }],
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(createResult.ok).toBe(true)
  })

  it('rejects tiered price plan when tiers are not continuous ascending ranges', async () => {
    const basePayload = {
      name: 'Tiered Invalid',
      price_plan_type: 'TIERED_PRICING',
      serviceType: 'DATA',
      currency: 'USD',
      billingCycleType: 'CALENDAR_MONTH',
      firstCycleProration: 'NONE',
      prorationRounding: 'ROUND_HALF_UP',
      monthlyFee: 12,
      deactivatedMonthlyFee: 1,
      coveredNetworkProfileId: sharedCoveredNetworkProfileId,
    }
    const cases = [
      {
        name: 'gap',
        tiers: [
          { fromMb: 0, toMb: 1024, ratePerMb: 0.008 },
          { fromMb: 1536, toMb: 2048, ratePerMb: 0.01 },
        ],
      },
      {
        name: 'overlap',
        tiers: [
          { fromMb: 0, toMb: 1024, ratePerMb: 0.008 },
          { fromMb: 800, toMb: 2048, ratePerMb: 0.01 },
        ],
      },
      {
        name: 'not ascending',
        tiers: [
          { fromMb: 1024, toMb: 2048, ratePerMb: 0.008 },
          { fromMb: 0, toMb: 1024, ratePerMb: 0.01 },
        ],
      },
    ]
    for (const tc of cases) {
      const result = await createPricePlan({
        supabase,
        enterpriseId,
        resellerId,
        payload: {
          ...basePayload,
          name: `Tiered Invalid ${tc.name}`,
          tiers: tc.tiers,
        },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('BAD_REQUEST')
      }
    }
  })

  it('rejects price plan create with paygRates', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 1024,
        paygRates: [
          { zoneCode: 'Z1', countries: ['001-01'], ratePerMb: 0.01 },
          { zoneCode: 'Z2', countries: ['001-01'], ratePerMb: 0.02 },
        ],
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(false)
    if (!planResult.ok) {
      expect(String((planResult as any).message || '')).toMatch(/paygRates/i)
    }
  })

  it('requires published apn profile snapshot', async () => {
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
    const apnPublishSetup = await publishApnProfile({ supabase, apnProfileId })
    expect(apnPublishSetup.ok).toBe(true)
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 2048,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const prepPricePublished = await publishPricePlan({ supabase, pricePlanId: planId })
    expect(prepPricePublished.ok).toBe(true)
    const modules = preparePackageModules({ supabase, supplierId, operatorId, resellerId, apnProfileId })
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package APN',
        pricePlanId: planId,
        ...modules,
      },
    })
    expect(packageResult.ok).toBe(true)
    const apnRow = supabase.getTable('apn_profiles').find((r: any) => r.apn_profile_id === apnProfileId)
    if (apnRow) apnRow.status = 'DRAFT'
    const publishResult = await publishPackageWithMapping({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishResult.ok).toBe(false)
    expect((publishResult as any).code).toBe('PROFILE_VERSION_INVALID')
    const publishProfileResult = await publishApnProfile({ supabase, apnProfileId })
    expect(publishProfileResult.ok).toBe(true)
    const publishAfterProfile = await publishPackageWithMapping({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishAfterProfile.ok).toBe(true)
  })

  it('blocks package publish for FIXED_BUNDLE when CoveredNetworkProfile is not PUBLISHED', async () => {
    const coveredNetworkProfileId = seedCoveredNetworkProfile({ status: 'PUBLISHED' })
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Fixed bundle covered gate',
        type: 'FIXED_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        totalQuotaMb: 1024,
        coveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    const publishPlanOk = await publishPricePlan({ supabase, pricePlanId: planId })
    expect(publishPlanOk.ok).toBe(true)
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Pkg covered gate',
        pricePlanId: planId,
        ...preparePackageModules({ supabase, supplierId, operatorId, resellerId }),
      },
    })
    expect(packageResult.ok).toBe(true)
    const covRow = supabase.getTable('covered_network_profiles').find((r: any) => r.covered_network_profile_id === coveredNetworkProfileId)
    if (covRow) covRow.status = 'DRAFT'
    const blocked = await publishPackage({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(blocked.ok).toBe(false)
    expect((blocked as any).code).toBe('INVALID_STATUS')
    expect(String((blocked as any).message || '')).toMatch(/CoveredNetworkProfile/i)
    if (covRow) covRow.status = 'PUBLISHED'
    const ok = await publishPackageWithMapping({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(ok.ok).toBe(true)
  })

  it('rejects invalid firstCycleProration with bad request', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
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
          quotaMb: 1024,
          validityDays: 30,
          expiryBoundary: 'CALENDAR_DAY_END',
          coveredNetworkProfileId: sharedCoveredNetworkProfileId,
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
          coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        },
        message: 'perSimQuotaMb must be >= 0.',
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
          coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        },
        message: 'totalQuotaMb must be >= 0.',
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
          coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        },
        message: 'tiers must be provided.',
      },
    ]
    for (const testCase of cases) {
      const result = await createPricePlan({ supabase, enterpriseId, resellerId, payload: testCase.payload })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect((result as any).code).toBe('BAD_REQUEST')
        expect((result as any).message).toBe(testCase.message)
      }
    }
  })

  it('rejects commercial terms and control policy on price plan create', async () => {
    const roamingProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Meta Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    const result = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 2048,
        commercialTerms: {
          testPeriodDays: 15,
          testQuotaMb: 10240,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'DEACTIVATED',
          commitmentPeriodMonths: 12,
          commitmentPeriodDays: 0,
        },
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'MONTHLY', thresholdMb: 1024, action: 'DEACTIVATED' },
          throttling: {
            timeWindow: 'DAILY',
            tiers: [{ thresholdMb: 0, downlinkKbps: 500, uplinkKbps: 500 }],
          },
        },
        carrierServiceConfig: {
          supplierId,
          operatorId,
          roamingProfileId,
        },
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(String((result as any).message || '')).toMatch(/commercialTerms/)
    }
  })

  it('supports common modules for all four price plan types', async () => {
    const roamingProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Common Modules Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    const basePayload = {
      serviceType: 'DATA',
      currency: 'USD',
      billingCycleType: 'CALENDAR_MONTH',
      firstCycleProration: 'NONE',
      prorationRounding: 'ROUND_HALF_UP',
      carrierServiceConfig: {
        supplierId,
        operatorId,
        roamingProfileId,
      },
    }
    const cases = [
      {
        name: 'OneTime Modules',
        payload: {
          ...basePayload,
          type: 'ONE_TIME',
          oneTimeFee: 9.9,
          quotaMb: 2048,
          validityDays: 30,
          expiryBoundary: 'CALENDAR_DAY_END',
          coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        },
      },
      {
        name: 'SimBundle Modules',
        payload: {
          ...basePayload,
          type: 'SIM_DEPENDENT_BUNDLE',
          monthlyFee: 10,
          deactivatedMonthlyFee: 1,
          perSimQuotaMb: 2048,
          coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        },
      },
      {
        name: 'FixedBundle Modules',
        payload: {
          ...basePayload,
          type: 'FIXED_BUNDLE',
          monthlyFee: 20,
          deactivatedMonthlyFee: 2,
          totalQuotaMb: 4096,
          coveredNetworkProfileId: sharedCoveredNetworkProfileId,
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
            { fromMb: 0, toMb: 1024, ratePerMb: 0.001 },
            { fromMb: 1024, toMb: 2048, ratePerMb: 0.0008 },
          ],
          coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        },
      },
    ]
    for (const [index, testCase] of cases.entries()) {
      const result = await createPricePlan({
        supabase,
        enterpriseId,
        resellerId,
        payload: {
          name: testCase.name,
          ...testCase.payload,
        },
      })
      expect(result.ok).toBe(true)
      const versionRow = supabase.getTable('price_plans')[index]
      expect(versionRow?.proration_rounding).toBe('ROUND_HALF_UP')
      expect(versionRow?.payg_rates).toBeUndefined()
    }
  })

  it('rejects legacy carrier service fields and commercial terms payload in price plan creation', async () => {
    const legacyCarrier = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        carrierService: {
          carrierServiceId: randomUUID(),
        },
      },
    })
    expect(legacyCarrier.ok).toBe(false)
    if (!legacyCarrier.ok) {
      expect((legacyCarrier as any).message).toBe('carrierService must not be set on a price plan; use package carrierServiceId.')
    }

    const legacyCarrierConfig = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Legacy Carrier Config',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        carrierServiceConfig: {
          carrierServiceId: randomUUID(),
        },
      },
    })
    expect(legacyCarrierConfig.ok).toBe(false)
    if (!legacyCarrierConfig.ok) {
      expect((legacyCarrierConfig as any).message).toBe(
        'carrierServiceConfig must not be set on a price plan; use package carrierServiceId.'
      )
    }

    const invalidCommercial = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
        commercialTerms: {
          testExpiryAction: 'PAUSED',
        },
      },
    })
    expect(invalidCommercial.ok).toBe(false)
    if (!invalidCommercial.ok) {
      expect(String((invalidCommercial as any).message || '')).toMatch(/commercialTerms must not be set/)
    }
  })

  it('creates one-time subscription with expiry and commitment', async () => {
    const simId = randomUUID()
    const pricePlanSnapshotId = randomUUID()
    const sellablePackageId = randomUUID()
    const oneTimeCommercialTermsId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: sellablePackageId,
      enterpriseId,
      supplierId,
      operatorId,
      pricePlanId: pricePlanSnapshotId,
      commercialTermsId: oneTimeCommercialTermsId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678909999',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('price_plans').push({
      price_plan_id: pricePlanSnapshotId,
      type: 'ONE_TIME',
    })
    supabase.getTable('price_plan_one_time').push({
      price_plan_id: pricePlanSnapshotId,
      one_time_fee: 0,
      quota_mb: 0,
      validity_days: 7,
      expiry_boundary: 'CALENDAR_DAY_END',
    })
    supabase.getTable('commercial_terms_modules').push({
      commercial_terms_id: oneTimeCommercialTermsId,
      name: 'One-time pkg CT',
      commercial_terms: { commitmentPeriodDays: 30 },
      status: 'PUBLISHED',
    })
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678909999',
      packageId: sellablePackageId,
      kind: 'MAIN',
      effectiveAt: new Date().toISOString(),
      tenantFilter: '',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.state).toBe('PROVISIONING')
      expect(result.value.jobId).toBeTruthy()
      expect(result.value.expiresAt).toBeTruthy()
      expect(result.value.commitmentEndAt).toBeTruthy()
      expect(supabase.getTable('jobs').length).toBe(1)
      expect(supabase.getTable('jobs')[0]?.job_type).toBe(SUBSCRIPTION_PROVISION_JOB_TYPE)
    }
  })

  it('rejects subscription when vendor product mapping is missing', async () => {
    const simId = randomUUID()
    const sellablePackageId = randomUUID()
    const carrierServiceId = randomUUID()
    supabase.getTable('carrier_service_modules').push({
      carrier_service_id: carrierServiceId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
    })
    supabase.getTable('packages').push({
      package_id: sellablePackageId,
      enterprise_id: enterpriseId,
      status: 'PUBLISHED',
      carrier_service_id: carrierServiceId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678909988',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678909988',
      packageId: sellablePackageId,
      kind: 'MAIN',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('VENDOR_PRODUCT_MAPPING_NOT_FOUND')
    }
  })

  it('rejects subscription when package is not PUBLISHED', async () => {
    const simId = randomUUID()
    const draftPackageId = randomUUID()
    const carrierServiceId = randomUUID()
    supabase.getTable('carrier_service_modules').push({
      carrier_service_id: carrierServiceId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
    })
    supabase.getTable('packages').push({
      package_id: draftPackageId,
      enterprise_id: enterpriseId,
      status: 'DRAFT',
      carrier_service_id: carrierServiceId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678909966',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678909966',
      packageId: draftPackageId,
      kind: 'MAIN',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('INVALID_STATUS')
      expect(result.message).toMatch(/DRAFT/)
      expect(result.message).toMatch(/PUBLISHED/)
    }
  })

  it('rejects subscription when kind is empty', async () => {
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678909955',
      packageId: randomUUID(),
      kind: '',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toMatch(/kind must be MAIN or ADD_ON/)
    }
  })

  it('rejects subscription when kind is not MAIN or ADD_ON', async () => {
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678909954',
      packageId: randomUUID(),
      kind: 'BONUS',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toMatch(/kind must be MAIN or ADD_ON/)
    }
  })

  it('rejects subscription when SIM supplier mismatches package carrier service', async () => {
    const simId = randomUUID()
    const sellablePackageId = randomUUID()
    const mismatchSupplierId = '44444444-4444-4444-4444-444444444444'
    seedSellablePackageWithMapping(supabase, {
      packageId: sellablePackageId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678909977',
      enterprise_id: enterpriseId,
      supplier_id: mismatchSupplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678909977',
      packageId: sellablePackageId,
      kind: 'MAIN',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('PACKAGE_SUPPLIER_MISMATCH')
      expect(result.status).toBe(409)
    }
  })

  it('rejects package publish without externalProductId', async () => {
    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
      payload: {
        name: 'Publish mapping gate',
        type: 'SIM_DEPENDENT_BUNDLE',
        serviceType: 'DATA',
        currency: 'USD',
        billingCycleType: 'CALENDAR_MONTH',
        firstCycleProration: 'NONE',
        prorationRounding: 'ROUND_HALF_UP',
        monthlyFee: 10,
        deactivatedMonthlyFee: 1,
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    const planId = planResult.ok ? planResult.value.pricePlanId : ''
    await publishPricePlan({ supabase, pricePlanId: planId })
    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Publish mapping pkg',
        pricePlanId: planId,
        ...preparePackageModules({ supabase, supplierId, operatorId, resellerId }),
      },
    })
    expect(packageResult.ok).toBe(true)
    const publishResult = await publishPackage({
      supabase,
      packageId: (packageResult as any).value.packageId,
    })
    expect(publishResult.ok).toBe(false)
    if (!publishResult.ok) {
      expect(publishResult.code).toBe('BAD_REQUEST')
      expect(String(publishResult.message || '')).toMatch(/externalProductId/i)
    }
  })

  it('deletes subscription when SUBSCRIPTION_PROVISION worker fails upstream', async () => {
    const savedWxEnv = process.env.WXZHONGGENG_SUPPLIER_ID
    process.env.WXZHONGGENG_SUPPLIER_ID = supplierId
    try {
      const simId = randomUUID()
      const subscriptionId = randomUUID()
      const sellablePackageId = randomUUID()
      seedSellablePackageWithMapping(supabase, {
        packageId: sellablePackageId,
        enterpriseId,
        supplierId,
        operatorId,
      })
      supabase.getTable('sims').push({
        sim_id: simId,
        iccid: '8986012345678909966',
        enterprise_id: enterpriseId,
        supplier_id: supplierId,
        operator_id: operatorId,
        status: 'ACTIVATED',
      })
      supabase.getTable('subscriptions').push({
        subscription_id: subscriptionId,
        sim_id: simId,
        enterprise_id: enterpriseId,
        package_id: sellablePackageId,
        subscription_kind: 'MAIN',
        state: 'PROVISIONING',
        effective_at: new Date().toISOString(),
      })
      const emitted: Array<{ eventType: string; payload?: Record<string, unknown> }> = []
      const result = await processSubscriptionProvisionJob({
        supabase,
        job: {
          job_id: randomUUID(),
          job_type: SUBSCRIPTION_PROVISION_JOB_TYPE,
          actor_user_id: null,
          request_id: 'req-provision-fail',
          payload: {
            subscriptionId,
            enterpriseId,
            iccid: '8986012345678909966',
            packageId: sellablePackageId,
            externalProductId: TEST_UPSTREAM_PRODUCT_ID,
            effectiveAt: new Date().toISOString(),
            beforeState: 'PROVISIONING',
          },
        },
        emitEvent: async (input) => {
          emitted.push({ eventType: input.eventType, payload: input.payload ?? undefined })
        },
      })
      expect(result.failed).toBe(true)
      expect(
        supabase.getTable('subscriptions').find((r) => r.subscription_id === subscriptionId)
      ).toBeUndefined()
      expect(emitted.some((e) => e.eventType === 'SUBSCRIPTION_PROVISION_FAILED')).toBe(true)
      expect(emitted.some((e) => e.eventType === 'JOB_FINISHED')).toBe(true)
    } finally {
      if (savedWxEnv === undefined) delete process.env.WXZHONGGENG_SUPPLIER_ID
      else process.env.WXZHONGGENG_SUPPLIER_ID = savedWxEnv
    }
  })

  it('activates subscription when SUBSCRIPTION_PROVISION worker succeeds upstream', async () => {
    const simId = randomUUID()
    const subscriptionId = randomUUID()
    const sellablePackageId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: sellablePackageId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678909955',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: subscriptionId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      package_id: sellablePackageId,
      subscription_kind: 'MAIN',
      state: 'PROVISIONING',
      effective_at: new Date().toISOString(),
    })
    const adapterSpy = vi.spyOn(vendorRegistry, 'createSupplierAdapter').mockResolvedValue({
      capabilities: { supportsFutureDatedChange: false },
      changePlan: async () => ({ ok: true, status: 'COMPLETED', vendorRequestId: 'mock-vreq-1' }),
    } as any)
    const emitted: Array<{ eventType: string; payload?: Record<string, unknown> }> = []
    try {
      const result = await processSubscriptionProvisionJob({
        supabase,
        job: {
          job_id: randomUUID(),
          job_type: SUBSCRIPTION_PROVISION_JOB_TYPE,
          actor_user_id: null,
          request_id: 'req-provision-ok',
          payload: {
            subscriptionId,
            enterpriseId,
            iccid: '8986012345678909955',
            packageId: sellablePackageId,
            externalProductId: TEST_UPSTREAM_PRODUCT_ID,
            effectiveAt: new Date().toISOString(),
            beforeState: 'PROVISIONING',
          },
        },
        emitEvent: async (input) => {
          emitted.push({ eventType: input.eventType, payload: input.payload ?? undefined })
        },
      })
      expect(result.ok).toBe(true)
      const row = supabase.getTable('subscriptions').find((r) => r.subscription_id === subscriptionId)
      expect(row?.state).toBe('ACTIVE')
      expect(emitted.some((e) => e.eventType === 'SUBSCRIPTION_CHANGED')).toBe(true)
      expect(emitted.some((e) => e.eventType === 'JOB_FINISHED')).toBe(true)
    } finally {
      adapterSpy.mockRestore()
    }
  })

  it('prevents duplicate active main subscription', async () => {
    const simId = randomUUID()
    const sellablePackageId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: sellablePackageId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678908888',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: randomUUID(),
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'PROVISIONING',
      effective_at: new Date().toISOString(),
    })
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678908888',
      packageId: sellablePackageId,
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
    const newPkgId = randomUUID()
    const switchPlanId = randomUUID()
    const switchCtId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
      pricePlanId: switchPlanId,
      commercialTermsId: switchCtId,
    })
    supabase.getTable('price_plans').push({
      price_plan_id: switchPlanId,
      type: 'SIM_DEPENDENT_BUNDLE',
    })
    supabase.getTable('price_plan_sim_dependent_bundle').push({
      price_plan_id: switchPlanId,
      monthly_fee: 0,
      deactivated_monthly_fee: 0,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678907777',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('commercial_terms_modules').push({
      commercial_terms_id: switchCtId,
      name: 'Switch CT',
      commercial_terms: { commitmentPeriodDays: 30 },
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
      toPackageId: newPkgId,
      effectiveStrategy: 'NEXT_CYCLE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.scheduled).toBe(true)
    expect(result.value.jobId).toBeTruthy()
    const oldSub = supabase.getTable('subscriptions').find((r) => r.subscription_id === oldSubId)
    expect(oldSub?.state).toBe('ACTIVE')
    const schedules = supabase.getTable('subscription_cancel_schedules')
    expect(schedules.length).toBe(1)
    expect(schedules[0]?.subscription_id).toBe(oldSubId)
    const newSub = supabase.getTable('subscriptions').find((r) => r.subscription_id !== oldSubId)
    expect(newSub?.state).toBe('PENDING')
    const provisionJobs = supabase
      .getTable('jobs')
      .filter((j) => j.job_type === SUBSCRIPTION_PROVISION_JOB_TYPE)
    expect(provisionJobs.length).toBe(1)
  })

  it('rejects IMMEDIATE switch when old MAIN is ACTIVE', async () => {
    const simId = randomUUID()
    const oldSubId = randomUUID()
    const newPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678906666',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
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
      iccid: '8986012345678906666',
      toPackageId: newPkgId,
      effectiveStrategy: 'IMMEDIATE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toContain('cannot be switched immediately')
    }
  })

  it('rejects switch when toPackageId equals current subscription package', async () => {
    const simId = randomUUID()
    const oldSubId = randomUUID()
    const currentPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: currentPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678905555',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: oldSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      package_id: currentPkgId,
      subscription_kind: 'MAIN',
      state: 'ACTIVE',
      effective_at: new Date().toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678905555',
      fromSubscriptionId: oldSubId,
      toPackageId: currentPkgId,
      effectiveStrategy: 'NEXT_CYCLE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('SAME_TARGET_PACKAGE')
    }
    expect(supabase.getTable('subscription_cancel_schedules').length).toBe(0)
    expect(supabase.getTable('subscriptions').length).toBe(1)
  })

  it('switches IMMEDIATE when only PENDING MAIN exists', async () => {
    const simId = randomUUID()
    const oldSubId = randomUUID()
    const oldPkgId = randomUUID()
    const newPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: oldPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678904444',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: oldSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      package_id: oldPkgId,
      subscription_kind: 'MAIN',
      state: 'PENDING',
      effective_at: new Date(Date.now() + 86400_000 * 30).toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678904444',
      toPackageId: newPkgId,
      effectiveStrategy: 'IMMEDIATE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const oldSub = supabase.getTable('subscriptions').find((r) => r.subscription_id === oldSubId)
    expect(oldSub?.state).toBe('CANCELLED')
    const newSub = supabase.getTable('subscriptions').find((r) => r.subscription_id === result.value.newSubscriptionId)
    expect(newSub?.state).toBe('PROVISIONING')
  })

  it('switches NEXT_CYCLE when only PENDING MAIN exists', async () => {
    const simId = randomUUID()
    const oldSubId = randomUUID()
    const oldPkgId = randomUUID()
    const newPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: oldPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678903333',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: oldSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      package_id: oldPkgId,
      subscription_kind: 'MAIN',
      state: 'PENDING',
      effective_at: new Date(Date.now() + 86400_000 * 30).toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678903333',
      toPackageId: newPkgId,
      effectiveStrategy: 'NEXT_CYCLE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const oldSub = supabase.getTable('subscriptions').find((r) => r.subscription_id === oldSubId)
    expect(oldSub?.state).toBe('CANCELLED')
    const newSub = supabase.getTable('subscriptions').find((r) => r.subscription_id === result.value.newSubscriptionId)
    expect(newSub?.state).toBe('PENDING')
  })

  it('rejects switch when only PROVISIONING MAIN exists', async () => {
    const simId = randomUUID()
    const oldSubId = randomUUID()
    const newPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678902222',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: oldSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'PROVISIONING',
      effective_at: new Date().toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678902222',
      toPackageId: newPkgId,
      effectiveStrategy: 'IMMEDIATE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('SUBSCRIPTION_PROVISION_IN_PROGRESS')
    }
  })

  it('rejects switch when fromSubscriptionId is CANCELLED', async () => {
    const simId = randomUUID()
    const oldSubId = randomUUID()
    const newPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678901111',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: oldSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'CANCELLED',
      effective_at: new Date().toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678901111',
      fromSubscriptionId: oldSubId,
      toPackageId: newPkgId,
      effectiveStrategy: 'IMMEDIATE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('SUBSCRIPTION_ALREADY_CANCELLED')
    }
  })

  it('rejects switch when fromSubscriptionId is EXPIRED', async () => {
    const simId = randomUUID()
    const oldSubId = randomUUID()
    const newPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678900000',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: oldSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'EXPIRED',
      effective_at: new Date().toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678900000',
      fromSubscriptionId: oldSubId,
      toPackageId: newPkgId,
      effectiveStrategy: 'IMMEDIATE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('SUBSCRIPTION_ALREADY_EXPIRED')
    }
  })

  it('switches PENDING MAIN by fromSubscriptionId while ACTIVE also exists', async () => {
    const simId = randomUUID()
    const activeSubId = randomUUID()
    const pendingSubId = randomUUID()
    const activePkgId = randomUUID()
    const pendingPkgId = randomUUID()
    const newPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: activePkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    seedSellablePackageWithMapping(supabase, {
      packageId: pendingPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678901212',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: activeSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      package_id: activePkgId,
      subscription_kind: 'MAIN',
      state: 'ACTIVE',
      effective_at: new Date().toISOString(),
    })
    supabase.getTable('subscriptions').push({
      subscription_id: pendingSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      package_id: pendingPkgId,
      subscription_kind: 'MAIN',
      state: 'PENDING',
      effective_at: new Date(Date.now() + 86400_000 * 30).toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678901212',
      fromSubscriptionId: pendingSubId,
      toPackageId: newPkgId,
      effectiveStrategy: 'NEXT_CYCLE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const activeSub = supabase.getTable('subscriptions').find((r) => r.subscription_id === activeSubId)
    expect(activeSub?.state).toBe('ACTIVE')
    const pendingSub = supabase.getTable('subscriptions').find((r) => r.subscription_id === pendingSubId)
    expect(pendingSub?.state).toBe('CANCELLED')
    const replacement = supabase
      .getTable('subscriptions')
      .find((r) => r.subscription_id === result.value.newSubscriptionId)
    expect(replacement?.state).toBe('PENDING')
  })

  it('rejects IMMEDIATE switch on PENDING when ACTIVE MAIN also exists', async () => {
    const simId = randomUUID()
    const activeSubId = randomUUID()
    const pendingSubId = randomUUID()
    const newPkgId = randomUUID()
    seedSellablePackageWithMapping(supabase, {
      packageId: newPkgId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678901313',
      enterprise_id: enterpriseId,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'ACTIVATED',
    })
    supabase.getTable('subscriptions').push({
      subscription_id: activeSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'ACTIVE',
      effective_at: new Date().toISOString(),
    })
    supabase.getTable('subscriptions').push({
      subscription_id: pendingSubId,
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'PENDING',
      effective_at: new Date(Date.now() + 86400_000 * 30).toISOString(),
    })
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: '8986012345678901313',
      fromSubscriptionId: pendingSubId,
      toPackageId: newPkgId,
      effectiveStrategy: 'IMMEDIATE',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toContain('Cannot switch PENDING immediately')
    }
  })

  it('cancels subscription immediately', async () => {
    const subId = randomUUID()
    supabase.getTable('subscriptions').push({
      subscription_id: subId,
      enterprise_id: enterpriseId,
      state: 'PENDING',
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

  it('rejects cancel when subscription is already CANCELLED', async () => {
    const subId = randomUUID()
    supabase.getTable('subscriptions').push({
      subscription_id: subId,
      enterprise_id: enterpriseId,
      state: 'CANCELLED',
      effective_at: new Date(Date.now() + 86400_000).toISOString(),
      expires_at: new Date().toISOString(),
    })
    const result = await cancelSubscription({
      supabase,
      enterpriseId,
      subscriptionId: subId,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.code).toBe('SUBSCRIPTION_ALREADY_CANCELLED')
    const row = supabase.getTable('subscriptions').find((r) => r.subscription_id === subId)
    expect(row?.state).toBe('CANCELLED')
  })

  it('rejects cancel when subscription is PROVISIONING', async () => {
    const subId = randomUUID()
    supabase.getTable('subscriptions').push({
      subscription_id: subId,
      enterprise_id: enterpriseId,
      state: 'PROVISIONING',
    })
    const result = await cancelSubscription({
      supabase,
      enterpriseId,
      subscriptionId: subId,
      immediate: true,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.code).toBe('SUBSCRIPTION_PROVISION_IN_PROGRESS')
    expect(result.message).toContain('SUBSCRIPTION_PROVISION')
    const row = supabase.getTable('subscriptions').find((r) => r.subscription_id === subId)
    expect(row?.state).toBe('PROVISIONING')
  })

  it('cancels pending subscription when immediate is omitted', async () => {
    const subId = randomUUID()
    const futureEffective = new Date(Date.now() + 86400_000).toISOString()
    const futureExpiry = new Date(Date.now() + 90 * 86400_000).toISOString()
    supabase.getTable('subscriptions').push({
      subscription_id: subId,
      enterprise_id: enterpriseId,
      state: 'PENDING',
      effective_at: futureEffective,
      expires_at: futureExpiry,
    })
    const result = await cancelSubscription({
      supabase,
      enterpriseId,
      subscriptionId: subId,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.state).toBe('CANCELLED')
    expect(result.value.expiresAt).toBe(futureExpiry)
    const row = supabase.getTable('subscriptions').find((r) => r.subscription_id === subId)
    expect(row?.state).toBe('CANCELLED')
    expect(row?.expires_at).toBe(futureExpiry)
  })

  it('lists subscriptions with filters', async () => {
    const simId = randomUUID()
    const sellablePackageId = randomUUID()
    supabase.getTable('sims').push({
      sim_id: simId,
      iccid: '8986012345678906666',
      enterprise_id: enterpriseId,
      status: 'ACTIVATED',
    })
    const listCtId = randomUUID()
    supabase.getTable('commercial_terms_modules').push({
      commercial_terms_id: listCtId,
      name: 'List sub CT',
      commercial_terms: {},
      status: 'PUBLISHED',
    })
    supabase.getTable('packages').push({
      package_id: sellablePackageId,
      enterprise_id: enterpriseId,
      name: 'List sub pkg',
      status: 'PUBLISHED',
      commercial_terms_id: listCtId,
    })
    supabase.getTable('subscriptions').push({
      subscription_id: randomUUID(),
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'MAIN',
      state: 'ACTIVE',
      effective_at: new Date().toISOString(),
      package_id: sellablePackageId,
    })
    supabase.getTable('subscriptions').push({
      subscription_id: randomUUID(),
      sim_id: simId,
      enterprise_id: enterpriseId,
      subscription_kind: 'ADD_ON',
      state: 'CANCELLED',
      effective_at: new Date().toISOString(),
      package_id: sellablePackageId,
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
        mccmncList: [{ mcc: '001', mnc: '01', ratePerMb: 0.0006 }],
      },
    })
    expect(roamingResult.ok).toBe(true)
    if (!roamingResult.ok) return
    const roamingPublishV1 = await publishRoamingProfile({ supabase, roamingProfileId: roamingResult.value.roamingProfileId })
    expect(roamingPublishV1.ok).toBe(true)
    if (!roamingPublishV1.ok) return

    const carrierResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Reverse lookup carrier',
        resellerId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apnProfileId: apnResult.value.apnProfileId,
          roamingProfileId: roamingResult.value.roamingProfileId,
        },
      },
    })
    expect(carrierResult.ok).toBe(true)
    if (!carrierResult.ok) return
    const carrierPublishReverse = await publishCarrierService({
      supabase,
      carrierServiceId: String((carrierResult.value as { carrierServiceId: string }).carrierServiceId),
    })
    expect(carrierPublishReverse.ok).toBe(true)
    if (!carrierPublishReverse.ok) return

    const commercialResult = await createCommercialTerms({
      supabase,
      payload: {
        name: 'Commercial reverse lookup',
        resellerId,
        commercialTerms: {
          testPeriodDays: 7,
          testQuotaMb: 1024,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'DEACTIVATED',
          commitmentPeriodMonths: 12,
          commitmentPeriodDays: 0,
        },
      },
    })
    expect(commercialResult.ok).toBe(true)
    if (!commercialResult.ok) return

    const controlResult = await createControlPolicy({
      supabase,
      payload: {
        name: 'Control reverse lookup',
        resellerId,
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'DAILY', thresholdMb: 512, action: 'DEACTIVATED' },
        },
      },
    })
    expect(controlResult.ok).toBe(true)
    if (!controlResult.ok) return

    const commercialPublishReverse = await publishCommercialTerms({
      supabase,
      commercialTermsId: commercialResult.value.commercialTermsId,
    })
    expect(commercialPublishReverse.ok).toBe(true)
    if (!commercialPublishReverse.ok) return
    const controlPublishReverse = await publishControlPolicy({
      supabase,
      controlPolicyId: controlResult.value.controlPolicyId,
    })
    expect(controlPublishReverse.ok).toBe(true)
    if (!controlPublishReverse.ok) return

    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 2048,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return
    const planId = planResult.value.pricePlanId
    const publishPlanReverse = await publishPricePlan({ supabase, pricePlanId: planId })
    expect(publishPlanReverse.ok).toBe(true)
    if (!publishPlanReverse.ok) return

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
    const packagePublish = await publishPackageWithMapping({ supabase, packageId: packageResult.value.packageId })
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

  it('lists carrier services without profile refs', async () => {
    const apnProfileId = randomUUID()
    const roamingProfileId = randomUUID()
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'Carrier list APN',
      apn: 'carrier.list.apn',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Carrier list Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    const created = await createCarrierService({
      supabase,
      payload: {
        name: 'Listed carrier service',
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apnProfileId,
          roamingProfileId,
        },
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const listed = await listCarrierServices({
      supabase,
      page: 1,
      pageSize: 20,
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.total).toBeGreaterThan(0)
    const ids = listed.value.items.map((item: any) => item?.carrierServiceId)
    expect(ids).toContain(created.value.carrierServiceId)
  })

  it('reverse looks up package by price plan and module references', async () => {
    const roamingProfileId = randomUUID()
    const apnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'Lookup Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: apnProfileId,
      name: 'Lookup APN',
      apn: 'lookup.apn',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const carrierResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Refs carrier service',
        resellerId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apnProfileId,
          roamingProfileId,
        },
      },
    })
    expect(carrierResult.ok).toBe(true)
    if (!carrierResult.ok) return
    const carrierPublishByRefs = await publishCarrierService({
      supabase,
      carrierServiceId: String((carrierResult.value as { carrierServiceId: string }).carrierServiceId),
    })
    expect(carrierPublishByRefs.ok).toBe(true)
    if (!carrierPublishByRefs.ok) return

    const commercialResult = await createCommercialTerms({
      supabase,
      payload: {
        name: 'Commercial module refs',
        resellerId,
        commercialTerms: {
          testPeriodDays: 10,
          testQuotaMb: 2048,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'ACTIVATED',
          commitmentPeriodMonths: 12,
          commitmentPeriodDays: 0,
        },
      },
    })
    expect(commercialResult.ok).toBe(true)
    if (!commercialResult.ok) return
    const controlResult = await createControlPolicy({
      supabase,
      payload: {
        name: 'Control module refs',
        resellerId,
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'DAILY', thresholdMb: 700, action: 'DEACTIVATED' },
        },
      },
    })
    expect(controlResult.ok).toBe(true)
    if (!controlResult.ok) return

    const commercialPublishRefs = await publishCommercialTerms({
      supabase,
      commercialTermsId: commercialResult.value.commercialTermsId,
    })
    expect(commercialPublishRefs.ok).toBe(true)
    if (!commercialPublishRefs.ok) return
    const controlPublishRefs = await publishControlPolicy({
      supabase,
      controlPolicyId: controlResult.value.controlPolicyId,
    })
    expect(controlPublishRefs.ok).toBe(true)
    if (!controlPublishRefs.ok) return

    const planResult = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planResult.ok).toBe(true)
    if (!planResult.ok) return
    const publishPlanRefs = await publishPricePlan({ supabase, pricePlanId: planResult.value.pricePlanId })
    expect(publishPlanRefs.ok).toBe(true)
    if (!publishPlanRefs.ok) return

    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Package By Module Refs',
        pricePlanId: supabase.getTable('price_plans')[0]?.price_plan_id,
        carrierServiceId: carrierResult.value.carrierServiceId,
        controlPolicyId: controlResult.value.controlPolicyId,
        commercialTermsId: commercialResult.value.commercialTermsId,
      },
    })
    expect(packageResult.ok).toBe(true)
    if (!packageResult.ok) return
    const published = await publishPackageWithMapping({ supabase, packageId: packageResult.value.packageId })
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
    expect(((byPolicies.value.items[0] as any)?.moduleRef as any)?.commercialTermsId).toBe(
      commercialResult.value.commercialTermsId
    )
    expect(((byPolicies.value.items[0] as any)?.moduleRef as any)?.controlPolicyId).toBe(controlResult.value.controlPolicyId)
  })

  it('keeps package snapshot history traceable after switching to a new snapshot', async () => {
    const roamingProfileId = randomUUID()
    const historyApnProfileId = randomUUID()
    supabase.getTable('roaming_profiles').push({
      roaming_profile_id: roamingProfileId,
      name: 'History Roaming',
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      mccmnc_list: [{ mcc: '001', mnc: '01', ratePerMb: 0.001 }],
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_roaming_profile_id: null,
    })
    supabase.getTable('apn_profiles').push({
      apn_profile_id: historyApnProfileId,
      name: 'History APN',
      apn: 'history.apn',
      auth_type: 'NONE',
      username: null,
      password_ref: null,
      supplier_id: supplierId,
      operator_id: operatorId,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
      effective_from: new Date().toISOString(),
      source_apn_profile_id: null,
    })
    const carrierResult = await createCarrierService({
      supabase,
      payload: {
        name: 'Snapshot history carrier',
        resellerId,
        carrierServiceConfig: {
          supplierId,
          operatorId,
          apnProfileId: historyApnProfileId,
          roamingProfileId,
        },
      },
    })
    expect(carrierResult.ok).toBe(true)
    if (!carrierResult.ok) return
    const carrierPublishSnapshot = await publishCarrierService({
      supabase,
      carrierServiceId: String((carrierResult.value as { carrierServiceId: string }).carrierServiceId),
    })
    expect(carrierPublishSnapshot.ok).toBe(true)
    if (!carrierPublishSnapshot.ok) return

    const commercialV1 = await createCommercialTerms({
      supabase,
      payload: {
        name: 'Commercial snapshot v1',
        resellerId,
        commercialTerms: {
          testPeriodDays: 5,
          testQuotaMb: 1024,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'DEACTIVATED',
          commitmentPeriodMonths: 12,
          commitmentPeriodDays: 0,
        },
      },
    })
    expect(commercialV1.ok).toBe(true)
    if (!commercialV1.ok) return
    const controlV1 = await createControlPolicy({
      supabase,
      payload: {
        name: 'Control snapshot v1',
        resellerId,
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'DAILY', thresholdMb: 256, action: 'DEACTIVATED' },
        },
      },
    })
    expect(controlV1.ok).toBe(true)
    if (!controlV1.ok) return

    const commercialV1Publish = await publishCommercialTerms({
      supabase,
      commercialTermsId: commercialV1.value.commercialTermsId,
    })
    expect(commercialV1Publish.ok).toBe(true)
    if (!commercialV1Publish.ok) return
    const controlV1Publish = await publishControlPolicy({
      supabase,
      controlPolicyId: controlV1.value.controlPolicyId,
    })
    expect(controlV1Publish.ok).toBe(true)
    if (!controlV1Publish.ok) return

    const planV1 = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 1024,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planV1.ok).toBe(true)
    if (!planV1.ok) return
    const publishSnapshotPlan = await publishPricePlan({ supabase, pricePlanId: planV1.value.pricePlanId })
    expect(publishSnapshotPlan.ok).toBe(true)
    if (!publishSnapshotPlan.ok) return

    const packageResult = await createPackage({
      supabase,
      enterpriseId,
      payload: {
        name: 'Snapshot Package',
        pricePlanId: supabase.getTable('price_plans')[0]?.price_plan_id,
        carrierServiceId: carrierResult.value.carrierServiceId,
        controlPolicyId: controlV1.value.controlPolicyId,
        commercialTermsId: commercialV1.value.commercialTermsId,
      },
    })
    expect(packageResult.ok).toBe(true)
    if (!packageResult.ok) return
    const published = await publishPackageWithMapping({ supabase, packageId: packageResult.value.packageId })
    expect(published.ok).toBe(true)

    const commercialV2 = await createCommercialTerms({
      supabase,
      payload: {
        name: 'Commercial snapshot v2',
        resellerId,
        commercialTerms: {
          testPeriodDays: 20,
          testQuotaMb: 4096,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          testExpiryAction: 'ACTIVATED',
          commitmentPeriodMonths: 12,
          commitmentPeriodDays: 0,
        },
      },
    })
    expect(commercialV2.ok).toBe(true)
    if (!commercialV2.ok) return
    const controlV2 = await createControlPolicy({
      supabase,
      payload: {
        name: 'Control snapshot v2',
        resellerId,
        controlPolicy: {
          enabled: true,
          cutoff: { timeWindow: 'DAILY', thresholdMb: 1024, action: 'DEACTIVATED' },
        },
      },
    })
    expect(controlV2.ok).toBe(true)
    if (!controlV2.ok) return
    const planV2 = await createPricePlan({
      supabase,
      enterpriseId,
      resellerId,
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
        perSimQuotaMb: 4096,
        coveredNetworkProfileId: sharedCoveredNetworkProfileId,
      },
    })
    expect(planV2.ok).toBe(true)
    if (!planV2.ok) return
    const publishPlanV2 = await publishPricePlan({ supabase, pricePlanId: planV2.value.pricePlanId })
    expect(publishPlanV2.ok).toBe(true)
    if (!publishPlanV2.ok) return

    const pkgTable = supabase.getTable('packages')
    const pkgIdx = pkgTable.findIndex((row) => row.package_id === packageResult.value.packageId)
    expect(pkgIdx).toBeGreaterThanOrEqual(0)
    if (pkgIdx < 0) return
    const versionV2CreatedAt = new Date(Date.now() + 60 * 1000).toISOString()
    pkgTable[pkgIdx] = {
      ...pkgTable[pkgIdx],
      price_plan_id: planV2.value.pricePlanId,
      commercial_terms_id: commercialV2.value.commercialTermsId,
      control_policy_id: controlV2.value.controlPolicyId,
      updated_at: versionV2CreatedAt,
    }

    const detail = await getPackageDetail({ supabase, packageId: packageResult.value.packageId })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect((detail.value as any)?.moduleRef?.commercialTermsId).toBe(commercialV2.value.commercialTermsId)
    expect((detail.value as any)?.moduleRef?.controlPolicyId).toBe(controlV2.value.controlPolicyId)
    expect((detail.value as any)?.moduleRef?.pricePlanId).toBe(planV2.value.pricePlanId)

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

  function wxIntegration() {
    return {
      integrationId: wxSupplierId,
      supplierId: wxSupplierId,
      operatorId: wxSupplierId,
      adapterType: 'wxzhonggeng' as const,
      apiEndpoint: 'https://upstream.example.com',
      apiKey: 'k',
      apiSecret: 's',
      webhookKey: null,
      authType: 'api_key',
      tokenUrl: null,
      enabled: true,
      config: {},
    }
  }

  beforeEach(() => {
    delete process.env.UPSTREAM_INTEGRATION_ENV_FALLBACK
    delete process.env.WXZHONGGENG_SUPPLIER_ID
    delete process.env.SUPPLIER_ADAPTERS
    delete process.env.SUPPLIER_ADAPTERS_JSON
    delete process.env.SUPPLIER_DEFAULT_ADAPTER
  })

  it('creates adapter via registry and negotiates future plan change', async () => {
    const adapter = createSupplierAdapterFromIntegration(wxIntegration())
    expect(adapter).toBeTruthy()
    expect(adapter.capabilities).toBeTruthy()
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const strategy = negotiateChangePlanStrategy({ adapter, effectiveAt: future })
    expect(strategy.mode).toBe('VIRTUAL')
  })

  it('uses upstream mode for immediate plan change', async () => {
    const adapter = createSupplierAdapterFromIntegration(wxIntegration())
    const now = new Date()
    const strategy = negotiateChangePlanStrategy({ adapter, effectiveAt: now })
    expect(strategy.mode).toBe('UPSTREAM')
  })

  it('returns not supported for changePlan when endpoint missing', async () => {
    const adapter = createSupplierAdapterFromIntegration(wxIntegration())
    const result = await adapter.changePlan({
      iccid: '8986012345678901999',
      externalProductId: 'EXT-001',
      effectiveAt: new Date(),
      idempotencyKey: 'test-idem',
    })
    expect(result.ok).toBe(false)
    expect(result.message).toBe('NOT_SUPPORTED')
  })

  it('throws when adapter mapping is unknown', () => {
    expect(() =>
      createSupplierAdapterFromIntegration({
        ...wxIntegration(),
        adapterType: 'unknown_vendor' as any,
      })
    ).toThrow()
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
    delete process.env.UPSTREAM_INTEGRATION_ENV_FALLBACK
    delete process.env.SUPPLIER_DEFAULT_ADAPTER
  })

  runProvisioning('activates and suspends sim via upstream adapter', async () => {
    const adapter = await createSupplierAdapter({ supplierId })
    const simIccid = iccid ?? ''
    const activate = await adapter.activateSim({ iccid: simIccid, idempotencyKey: `itest-${Date.now()}-activate` })
    expect(activate.ok).toBe(true)
    const suspend = await adapter.suspendSim({ iccid: simIccid, idempotencyKey: `itest-${Date.now()}-suspend` })
    expect(suspend.ok).toBe(true)
  }, 20000)

  runUsage('fetches daily usage via upstream adapter', async () => {
    const adapter = await createSupplierAdapter({ supplierId })
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
