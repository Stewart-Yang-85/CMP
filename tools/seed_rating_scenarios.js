import 'dotenv/config'
import crypto from 'node:crypto'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import {
  CURRENT_BASELINE_FIXTURES,
  DEFAULT_RATING_SCENARIO_SCOPE,
  PRICE_PLAN_TYPES,
  RATING_SCENARIO_NAME_PREFIX,
  RATING_SCENARIOS,
  SCENARIO_GROUPS,
  scenarioById,
  scenarioDay,
  scenarioExternalRef,
  scenarioIccid,
  scenarioName,
  scenariosByGroup,
  validateScenarioCatalog,
} from './rating_scenario_catalog.js'

const PRICE_PLAN_DB_TYPE = Object.freeze({
  [PRICE_PLAN_TYPES.oneTime]: 'ONE_TIME',
  [PRICE_PLAN_TYPES.fixedBundle]: 'FIXED_BUNDLE',
  [PRICE_PLAN_TYPES.simDependentBundle]: 'SIM_DEPENDENT_BUNDLE',
  [PRICE_PLAN_TYPES.tieredPricing]: 'TIERED_VOLUME_PRICING',
})

const PRICE_PLAN_EXTENSION = Object.freeze({
  [PRICE_PLAN_TYPES.oneTime]: {
    table: 'price_plan_one_time',
    select: 'price_plan_id,one_time_fee,quota_mb,validity_days,expiry_boundary',
    row: { one_time_fee: 10, quota_mb: 1000, validity_days: 30, expiry_boundary: 'CALENDAR_DAY_END' },
  },
  [PRICE_PLAN_TYPES.fixedBundle]: {
    table: 'price_plan_fixed_bundle',
    select: 'price_plan_id,monthly_fee,deactivated_monthly_fee,total_quota_mb,overage_rate_per_mb',
    row: { monthly_fee: 20, deactivated_monthly_fee: 0, total_quota_mb: 10240, overage_rate_per_mb: 0.01 },
  },
  [PRICE_PLAN_TYPES.simDependentBundle]: {
    table: 'price_plan_sim_dependent_bundle',
    select: 'price_plan_id,monthly_fee,deactivated_monthly_fee,per_sim_quota_mb,overage_rate_per_mb',
    row: { monthly_fee: 5, deactivated_monthly_fee: 0, per_sim_quota_mb: 1000, overage_rate_per_mb: 0.01 },
  },
  [PRICE_PLAN_TYPES.tieredPricing]: {
    table: 'price_plan_tiered_volume_pricing',
    select: 'price_plan_id,monthly_fee,deactivated_monthly_fee,tiers,overage_rate_per_mb',
    row: {
      monthly_fee: 0,
      deactivated_monthly_fee: 0,
      tiers: [
        { fromMb: 0, toMb: 1000, ratePerMb: 0.01 },
        { fromMb: 1000, toMb: 5000, ratePerMb: 0.008 },
        { fromMb: 5000, toMb: 10000, ratePerMb: 0.006 },
      ],
      overage_rate_per_mb: 0.02,
    },
  },
})

const COVERED_ENTRIES = Object.freeze([
  { mcc: '520', mnc: '000' },
  { mcc: '234', mnc: '*' },
])

const NON_MATCHING_ADD_ON_COVERED_ENTRIES = Object.freeze([
  { mcc: '310', mnc: '260' },
])

const OOP_ROAMING_ENTRIES = Object.freeze([
  { mcc: '204', mnc: '008', ratePerMb: 0.02 },
  { mcc: '999', mnc: '*', ratePerMb: 0.5 },
])

const SUBSCRIPTION_PACKAGE_ROLE = Object.freeze({
  main: PRICE_PLAN_TYPES.fixedBundle,
  addOn: PRICE_PLAN_TYPES.oneTime,
})

const SUBSCRIPTION_STATE_DB_REPRESENTATION = Object.freeze({
  ACTIVE: { state: 'ACTIVE' },
  EXPIRED: { state: 'EXPIRED', inactiveAt: 'before-usage-day' },
  CANCELLED: { state: 'CANCELLED', inactiveAt: 'before-usage-day' },
  SUSPENDED: {
    state: 'PROVISIONING',
    note: 'Current subscription_state enum has no SUSPENDED; PROVISIONING is used as a non-active representative.',
  },
  SCHEDULED: {
    state: 'PENDING',
    effectiveTiming: 'after-usage-day',
    note: 'Current subscription_state enum has no SCHEDULED; future-effective PENDING represents not-yet-active.',
  },
})

const SIM_STATUS_DB_REPRESENTATION = Object.freeze({
  ACTIVE_OR_ACTIVATED: { status: 'ACTIVATED' },
  TEST_READY: { status: 'TEST_READY' },
  DEACTIVE: {
    status: 'DEACTIVATED',
    note: 'Current sim_status enum uses DEACTIVATED; catalog DEACTIVE maps to DEACTIVATED.',
  },
  INVENTORY: { status: 'INVENTORY' },
  RETIRED: { status: 'RETIRED' },
})

const FALLBACK_USAGE_BY_CLASS = Object.freeze({
  IN_PROFILE: { visitedMccMnc: '520-000', totalMb: 100 },
  OUT_OF_PROFILE: { visitedMccMnc: '204-008', totalMb: 100 },
  UNCLASSIFIED: { visitedMccMnc: '777-777', totalMb: 100 },
})

const BASELINE_TOTAL_MB_BY_SCENARIO = Object.freeze({
  'R-BL-001': 900,
  'R-BL-002': 4600,
  'R-BL-003': 4600,
  'R-BL-004': 250,
  'R-BL-005': 250,
})

function arg(name) {
  const flag = `--${name}`
  const idx = process.argv.indexOf(flag)
  if (idx < 0) return null
  const value = process.argv[idx + 1]
  return value && !value.startsWith('--') ? value : ''
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function addDaysIsoDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function isoStartOfDay(isoDate) {
  return `${isoDate}T00:00:00.000Z`
}

function resolveSimStatusRepresentation(plan) {
  const catalogStatus = String(plan.sim.statusCase || 'ACTIVE_OR_ACTIVATED').toUpperCase()
  return {
    catalogStatus,
    ...(SIM_STATUS_DB_REPRESENTATION[catalogStatus] ?? { status: 'ACTIVATED' }),
  }
}

function splitMb(totalMb) {
  const total = Math.max(0, Math.round(Number(totalMb) || 0))
  const uplink = Math.round(total * 0.2)
  return { uplink, downlink: total - uplink, total }
}

function usageSpecForPlan(plan) {
  const usageClass = String(plan.ratingInputs.usageClass || 'UNCLASSIFIED').toUpperCase()
  const networkMatch = String(plan.ratingInputs.networkMatch || '').toUpperCase()
  const hasExplicitTotal = plan.ratingInputs.totalMb !== null
    && plan.ratingInputs.totalMb !== undefined
    && plan.ratingInputs.totalMb !== ''
  const explicitTotal = hasExplicitTotal ? Number(plan.ratingInputs.totalMb) : NaN
  const totalMb = Number.isFinite(explicitTotal)
    ? explicitTotal
    : BASELINE_TOTAL_MB_BY_SCENARIO[plan.scenarioId] ?? 100

  if (usageClass === 'ZERO_USAGE') {
    return { visitedMccMnc: '520-000', totalMb: 0 }
  }
  if (networkMatch === 'MCC_WILDCARD_COVERED') {
    return { visitedMccMnc: '234-015', totalMb }
  }
  if (networkMatch === 'OOP_ROAMING' || usageClass === 'OUT_OF_PROFILE') {
    return { visitedMccMnc: '204-008', totalMb }
  }
  if (networkMatch === 'NO_RULE' || usageClass === 'UNCLASSIFIED') {
    return { visitedMccMnc: '777-777', totalMb }
  }
  return { visitedMccMnc: '520-000', totalMb }
}

function encodeInList(values) {
  const unique = [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
  return unique.map((value) => encodeURIComponent(value)).join(',')
}

async function selectOne(supabase, table, query) {
  try {
    const rows = await supabase.select(table, `${query}&limit=1`)
    return Array.isArray(rows) ? rows[0] ?? null : null
  } catch (err) {
    throw new Error(`selectOne failed table=${table} query=${query}: ${err?.message ?? err} ${err?.status ?? ''} ${err?.body ?? ''}`)
  }
}

async function insertRow(supabase, table, row) {
  try {
    await supabase.insert(table, row, { returning: 'minimal', suppressMissingColumns: true })
    return row
  } catch (err) {
    throw new Error(`insertRow failed table=${table} row=${JSON.stringify(row)}: ${err?.message ?? err} ${err?.status ?? ''} ${err?.body ?? ''}`)
  }
}

async function updateRow(supabase, table, query, row) {
  try {
    await supabase.update(table, query, row, { returning: 'minimal', suppressMissingColumns: true })
    return row
  } catch (err) {
    throw new Error(`updateRow failed table=${table} query=${query} row=${JSON.stringify(row)}: ${err?.message ?? err} ${err?.status ?? ''} ${err?.body ?? ''}`)
  }
}

async function countRows(supabase, table, query) {
  try {
    const { total } = await supabase.selectWithCount(table, `select=*&${query}&limit=1`)
    return Number(total || 0)
  } catch (err) {
    throw new Error(`countRows failed table=${table} query=${query}: ${err?.message ?? err} ${err?.status ?? ''} ${err?.body ?? ''}`)
  }
}

async function deleteRows(supabase, table, query, mode, result, reason) {
  const count = await countRows(supabase, table, query)
  if (mode === 'dry-run') {
    result.skipped += count
    result.actions.push({ action: 'deleteRows', table, status: 'would-delete', count, reason, query })
    return count
  }
  if (count > 0) {
    await supabase.delete(table, query)
  }
  result.deleted += count
  result.actions.push({ action: 'deleteRows', table, status: 'deleted', count, reason, query })
  return count
}

async function ensureByName(supabase, table, select, name, buildRow, mode, result, actionName) {
  const existing = await selectOne(
    supabase,
    table,
    `${select}&name=eq.${encodeURIComponent(name)}`
  )
  if (existing) {
    result.reused += 1
    result.actions.push({ action: actionName, table, status: 'reused', name })
    return existing
  }
  const row = buildRow()
  if (mode === 'dry-run') {
    result.skipped += 1
    result.actions.push({ action: actionName, table, status: 'would-create', name, row })
    return row
  }
  const created = await insertRow(supabase, table, row)
  result.created += 1
  result.actions.push({ action: actionName, table, status: 'created', name })
  return created
}

async function loadReferenceContext(supabase, result) {
  const fixedPackageId = CURRENT_BASELINE_FIXTURES.fixedBundle.packageId
  const fixedPlanId = CURRENT_BASELINE_FIXTURES.fixedBundle.pricePlanId
  const fixedCoveredProfileId = CURRENT_BASELINE_FIXTURES.fixedBundle.coveredProfileId
  const [fixedPackage, fixedPlan, fixedCoveredProfile] = await Promise.all([
    selectOne(
      supabase,
      'packages',
      `select=package_id,carrier_service_id,commercial_terms_id,control_policy_id,price_plan_id&package_id=eq.${encodeURIComponent(fixedPackageId)}`
    ),
    selectOne(
      supabase,
      'price_plans',
      `select=price_plan_id,currency,billing_cycle_type,first_cycle_proration,proration_rounding,covered_network_profile_id&price_plan_id=eq.${encodeURIComponent(fixedPlanId)}`
    ),
    selectOne(
      supabase,
      'covered_network_profiles',
      `select=covered_network_profile_id,supplier_id,operator_id&covered_network_profile_id=eq.${encodeURIComponent(fixedCoveredProfileId)}`
    ),
  ])

  let carrierService = null
  if (fixedPackage?.carrier_service_id) {
    carrierService = await selectOne(
      supabase,
      'carrier_service_modules',
      `select=carrier_service_id,supplier_id,operator_id,apn_profile_id,roaming_profile_id,rat&carrier_service_id=eq.${encodeURIComponent(String(fixedPackage.carrier_service_id))}`
    )
  }

  const operatorId =
    carrierService?.operator_id ??
    fixedCoveredProfile?.operator_id ??
    null
  if (!operatorId) {
    result.actions.push({
      action: 'loadReferenceContext',
      status: 'missing-operator',
      reason: 'Cannot create covered/roaming/carrier fixtures without an operator_id.',
    })
  }

  return {
    fixedPackage,
    fixedPlan,
    fixedCoveredProfile,
    carrierService,
    supplierId: fixedCoveredProfile?.supplier_id ?? carrierService?.supplier_id ?? DEFAULT_RATING_SCENARIO_SCOPE.supplierId,
    operatorId,
  }
}

async function ensureCoveredProfile(supabase, context, mode, result) {
  const now = new Date().toISOString()
  const name = scenarioName('COVERED_STANDARD')
  const profile = await ensureByName(
    supabase,
    'covered_network_profiles',
    'select=covered_network_profile_id,name,status,supplier_id,operator_id',
    name,
    () => ({
      covered_network_profile_id: crypto.randomUUID(),
      name,
      reseller_id: DEFAULT_RATING_SCENARIO_SCOPE.resellerId,
      supplier_id: context.supplierId,
      operator_id: context.operatorId,
      status: 'PUBLISHED',
      published_at: now,
      effective_from: now,
    }),
    mode,
    result,
    'ensureCoveredProfile'
  )

  const profileId = profile.covered_network_profile_id
  if (!profileId || mode === 'dry-run') return profile
  for (const entry of COVERED_ENTRIES) {
    const existing = await selectOne(
      supabase,
      'covered_network_profile_entries',
      `select=entry_id&covered_network_profile_id=eq.${encodeURIComponent(String(profileId))}&mcc=eq.${encodeURIComponent(entry.mcc)}&mnc=eq.${encodeURIComponent(entry.mnc)}`
    )
    if (existing) {
      result.reused += 1
      result.actions.push({ action: 'ensureCoveredEntry', table: 'covered_network_profile_entries', status: 'reused', entry })
      continue
    }
    await insertRow(supabase, 'covered_network_profile_entries', {
      entry_id: crypto.randomUUID(),
      covered_network_profile_id: profileId,
      mcc: entry.mcc,
      mnc: entry.mnc,
    })
    result.created += 1
    result.actions.push({ action: 'ensureCoveredEntry', table: 'covered_network_profile_entries', status: 'created', entry })
  }
  return profile
}

async function ensureRoamingProfile(supabase, context, mode, result) {
  const now = new Date().toISOString()
  const name = scenarioName('ROAMING_OOP')
  return ensureByName(
    supabase,
    'roaming_profiles',
    'select=roaming_profile_id,name,status,supplier_id,operator_id,mccmnc_list',
    name,
    () => ({
      roaming_profile_id: crypto.randomUUID(),
      name,
      supplier_id: context.supplierId,
      operator_id: context.operatorId,
      mccmnc_list: OOP_ROAMING_ENTRIES,
      status: 'PUBLISHED',
      published_at: now,
      effective_from: now,
    }),
    mode,
    result,
    'ensureRoamingProfile'
  )
}

async function ensureCarrierService(supabase, context, roamingProfile, mode, result) {
  const now = new Date().toISOString()
  const name = scenarioName('CARRIER_SERVICE')
  const roamingProfileId = roamingProfile?.roaming_profile_id ?? null
  return ensureByName(
    supabase,
    'carrier_service_modules',
    'select=carrier_service_id,name,status,supplier_id,operator_id,roaming_profile_id,rat',
    name,
    () => ({
      carrier_service_id: crypto.randomUUID(),
      name,
      reseller_id: DEFAULT_RATING_SCENARIO_SCOPE.resellerId,
      supplier_id: context.supplierId,
      operator_id: context.operatorId,
      roaming_profile_id: roamingProfileId,
      rat: '4G',
      status: 'PUBLISHED',
      published_at: now,
      effective_from: now,
    }),
    mode,
    result,
    'ensureCarrierService'
  )
}

async function ensureCoveredProfileFixture(supabase, context, mode, result, name, entries, actionName = 'ensureCoveredProfile') {
  const now = new Date().toISOString()
  const profile = await ensureByName(
    supabase,
    'covered_network_profiles',
    'select=covered_network_profile_id,name,status,supplier_id,operator_id',
    name,
    () => ({
      covered_network_profile_id: crypto.randomUUID(),
      name,
      reseller_id: DEFAULT_RATING_SCENARIO_SCOPE.resellerId,
      supplier_id: context.supplierId,
      operator_id: context.operatorId,
      status: 'PUBLISHED',
      published_at: now,
      effective_from: now,
    }),
    mode,
    result,
    actionName
  )

  const profileId = profile.covered_network_profile_id
  if (!profileId || mode === 'dry-run') return profile
  for (const entry of entries) {
    const existing = await selectOne(
      supabase,
      'covered_network_profile_entries',
      `select=entry_id&covered_network_profile_id=eq.${encodeURIComponent(String(profileId))}&mcc=eq.${encodeURIComponent(entry.mcc)}&mnc=eq.${encodeURIComponent(entry.mnc)}`
    )
    if (existing) {
      result.reused += 1
      result.actions.push({ action: `${actionName}Entry`, table: 'covered_network_profile_entries', status: 'reused', entry })
      continue
    }
    await insertRow(supabase, 'covered_network_profile_entries', {
      entry_id: crypto.randomUUID(),
      covered_network_profile_id: profileId,
      mcc: entry.mcc,
      mnc: entry.mnc,
    })
    result.created += 1
    result.actions.push({ action: `${actionName}Entry`, table: 'covered_network_profile_entries', status: 'created', entry })
  }
  return profile
}

async function ensurePricePlanFixture(supabase, pricePlanType, shared, mode, result, nameToken = pricePlanType) {
  const extension = PRICE_PLAN_EXTENSION[pricePlanType]
  const dbType = PRICE_PLAN_DB_TYPE[pricePlanType]
  if (!extension || !dbType) {
    result.pendingHandlers += 1
    result.actions.push({ action: 'ensurePricePlanFixture', status: 'unsupported-type', pricePlanType })
    return null
  }

  const now = new Date().toISOString()
  const planName = scenarioName(nameToken, 'PLAN')
  const existingPlan = await selectOne(
    supabase,
    'price_plans',
    `select=price_plan_id,name,type,status,covered_network_profile_id&enterprise_id=eq.${encodeURIComponent(DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId)}&name=eq.${encodeURIComponent(planName)}`
  )
  let pricePlan = existingPlan
  if (pricePlan) {
    result.reused += 1
    result.actions.push({ action: 'ensurePricePlan', table: 'price_plans', status: 'reused', name: planName, pricePlanType })
  } else {
    const row = {
      price_plan_id: crypto.randomUUID(),
      enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
      reseller_id: DEFAULT_RATING_SCENARIO_SCOPE.resellerId,
      name: planName,
      type: dbType,
      service_type: 'DATA',
      currency: shared.context.fixedPlan?.currency ?? 'USD',
      billing_cycle_type: shared.context.fixedPlan?.billing_cycle_type ?? 'CALENDAR_MONTH',
      first_cycle_proration: shared.context.fixedPlan?.first_cycle_proration ?? 'DAILY_PRORATION',
      proration_rounding: shared.context.fixedPlan?.proration_rounding ?? 'ROUND_HALF_UP',
      version: 1,
      effective_from: now,
      is_current: true,
      status: 'PUBLISHED',
      covered_network_profile_id: shared.coveredProfile?.covered_network_profile_id ?? null,
    }
    if (mode === 'dry-run') {
      pricePlan = row
      result.skipped += 1
      result.actions.push({ action: 'ensurePricePlan', table: 'price_plans', status: 'would-create', name: planName, pricePlanType, row })
    } else {
      pricePlan = await insertRow(supabase, 'price_plans', row)
      result.created += 1
      result.actions.push({ action: 'ensurePricePlan', table: 'price_plans', status: 'created', name: planName, pricePlanType })
    }
  }

  const pricePlanId = pricePlan?.price_plan_id
  const existingExtension = pricePlanId
    ? await selectOne(
      supabase,
      extension.table,
      `select=${extension.select}&price_plan_id=eq.${encodeURIComponent(String(pricePlanId))}`
    )
    : null
  if (existingExtension) {
    result.reused += 1
    result.actions.push({ action: 'ensurePricePlanExtension', table: extension.table, status: 'reused', pricePlanType })
  } else if (pricePlanId) {
    const row = { price_plan_id: pricePlanId, ...extension.row }
    if (mode === 'dry-run') {
      result.skipped += 1
      result.actions.push({ action: 'ensurePricePlanExtension', table: extension.table, status: 'would-create', pricePlanType, row })
    } else {
      await insertRow(supabase, extension.table, row)
      result.created += 1
      result.actions.push({ action: 'ensurePricePlanExtension', table: extension.table, status: 'created', pricePlanType })
    }
  }

  const packageName = scenarioName(nameToken, 'PACKAGE')
  const existingPackage = await selectOne(
    supabase,
    'packages',
    `select=package_id,name,status,price_plan_id&enterprise_id=eq.${encodeURIComponent(DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId)}&name=eq.${encodeURIComponent(packageName)}`
  )
  if (existingPackage) {
    result.reused += 1
    result.actions.push({ action: 'ensurePackage', table: 'packages', status: 'reused', name: packageName, pricePlanType })
    return { pricePlan, package: existingPackage }
  }

  const packageRow = {
    package_id: crypto.randomUUID(),
    enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
    name: packageName,
    description: `Phase 46 rating scenario package for ${nameToken}.`,
    status: 'PUBLISHED',
    published_at: now,
    effective_from: now,
    price_plan_id: pricePlanId,
    carrier_service_id: shared.carrierService?.carrier_service_id ?? shared.context.fixedPackage?.carrier_service_id ?? null,
    commercial_terms_id: shared.context.fixedPackage?.commercial_terms_id ?? null,
    control_policy_id: shared.context.fixedPackage?.control_policy_id ?? null,
  }
  if (mode === 'dry-run') {
    result.skipped += 1
    result.actions.push({ action: 'ensurePackage', table: 'packages', status: 'would-create', name: packageName, pricePlanType, row: packageRow })
    return { pricePlan, package: packageRow }
  }
  const createdPackage = await insertRow(supabase, 'packages', packageRow)
  result.created += 1
  result.actions.push({ action: 'ensurePackage', table: 'packages', status: 'created', name: packageName, pricePlanType })
  return { pricePlan, package: createdPackage }
}

async function ensureNonMatchingAddOnPackageFixture(supabase, mode, context, result) {
  const now = new Date().toISOString()
  const coveredProfile = await ensureCoveredProfileFixture(
    supabase,
    context.sharedPricePlanFixtures.context,
    mode,
    result,
    scenarioName('R_SUB_004', 'ADD_ON_NONMATCH_COVERED'),
    NON_MATCHING_ADD_ON_COVERED_ENTRIES,
    'ensureNonMatchingAddOnCoveredProfile'
  )
  const planName = scenarioName('R_SUB_004', 'ADD_ON_NONMATCH_PLAN')
  let pricePlan = await selectOne(
    supabase,
    'price_plans',
    `select=price_plan_id,name,type,status,covered_network_profile_id&enterprise_id=eq.${encodeURIComponent(DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId)}&name=eq.${encodeURIComponent(planName)}`
  )
  if (pricePlan) {
    result.reused += 1
    result.actions.push({ action: 'ensureNonMatchingAddOnPricePlan', table: 'price_plans', status: 'reused', name: planName })
  } else {
    const row = {
      price_plan_id: crypto.randomUUID(),
      enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
      reseller_id: DEFAULT_RATING_SCENARIO_SCOPE.resellerId,
      name: planName,
      type: PRICE_PLAN_DB_TYPE[PRICE_PLAN_TYPES.oneTime],
      service_type: 'DATA',
      currency: context.sharedPricePlanFixtures.context.fixedPlan?.currency ?? 'USD',
      billing_cycle_type: context.sharedPricePlanFixtures.context.fixedPlan?.billing_cycle_type ?? 'CALENDAR_MONTH',
      first_cycle_proration: context.sharedPricePlanFixtures.context.fixedPlan?.first_cycle_proration ?? 'DAILY_PRORATION',
      proration_rounding: context.sharedPricePlanFixtures.context.fixedPlan?.proration_rounding ?? 'ROUND_HALF_UP',
      version: 1,
      effective_from: now,
      is_current: true,
      status: 'PUBLISHED',
      covered_network_profile_id: coveredProfile?.covered_network_profile_id ?? null,
    }
    if (mode === 'dry-run') {
      pricePlan = row
      result.skipped += 1
      result.actions.push({ action: 'ensureNonMatchingAddOnPricePlan', table: 'price_plans', status: 'would-create', name: planName, row })
    } else {
      pricePlan = await insertRow(supabase, 'price_plans', row)
      result.created += 1
      result.actions.push({ action: 'ensureNonMatchingAddOnPricePlan', table: 'price_plans', status: 'created', name: planName })
    }
  }

  const pricePlanId = pricePlan?.price_plan_id
  const extension = PRICE_PLAN_EXTENSION[PRICE_PLAN_TYPES.oneTime]
  const existingExtension = pricePlanId
    ? await selectOne(
      supabase,
      extension.table,
      `select=${extension.select}&price_plan_id=eq.${encodeURIComponent(String(pricePlanId))}`
    )
    : null
  if (existingExtension) {
    result.reused += 1
    result.actions.push({ action: 'ensureNonMatchingAddOnPricePlanExtension', table: extension.table, status: 'reused' })
  } else if (pricePlanId) {
    const row = { price_plan_id: pricePlanId, ...extension.row }
    if (mode === 'dry-run') {
      result.skipped += 1
      result.actions.push({ action: 'ensureNonMatchingAddOnPricePlanExtension', table: extension.table, status: 'would-create', row })
    } else {
      await insertRow(supabase, extension.table, row)
      result.created += 1
      result.actions.push({ action: 'ensureNonMatchingAddOnPricePlanExtension', table: extension.table, status: 'created' })
    }
  }

  const packageName = scenarioName('R_SUB_004', 'ADD_ON_NONMATCH_PACKAGE')
  const existingPackage = await selectOne(
    supabase,
    'packages',
    `select=package_id,name,status,price_plan_id&enterprise_id=eq.${encodeURIComponent(DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId)}&name=eq.${encodeURIComponent(packageName)}`
  )
  if (existingPackage) {
    result.reused += 1
    result.actions.push({ action: 'ensureNonMatchingAddOnPackage', table: 'packages', status: 'reused', name: packageName })
    return existingPackage
  }
  const packageRow = {
    package_id: crypto.randomUUID(),
    enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
    name: packageName,
    description: 'Phase 46 R-SUB-004 ADD_ON package with non-matching covered profile.',
    status: 'PUBLISHED',
    published_at: now,
    effective_from: now,
    price_plan_id: pricePlanId,
    carrier_service_id: context.sharedPricePlanFixtures.carrierService?.carrier_service_id ?? context.sharedPricePlanFixtures.context.fixedPackage?.carrier_service_id ?? null,
    commercial_terms_id: context.sharedPricePlanFixtures.context.fixedPackage?.commercial_terms_id ?? null,
    control_policy_id: context.sharedPricePlanFixtures.context.fixedPackage?.control_policy_id ?? null,
  }
  if (mode === 'dry-run') {
    result.skipped += 1
    result.actions.push({ action: 'ensureNonMatchingAddOnPackage', table: 'packages', status: 'would-create', name: packageName, row: packageRow })
    return packageRow
  }
  await insertRow(supabase, 'packages', packageRow)
  result.created += 1
  result.actions.push({ action: 'ensureNonMatchingAddOnPackage', table: 'packages', status: 'created', name: packageName })
  return packageRow
}

async function preparePricePlanSharedFixtures(supabase, mode, result) {
  const context = await loadReferenceContext(supabase, result)
  if (!context.operatorId) {
    if (mode === 'dry-run') {
      context.operatorId = '00000000-0000-0000-0000-000000000000'
    } else {
      throw new Error('Cannot seed price plan fixtures: operator_id could not be resolved from baseline fixtures.')
    }
  }
  const coveredProfile = await ensureCoveredProfile(supabase, context, mode, result)
  const roamingProfile = await ensureRoamingProfile(supabase, context, mode, result)
  const carrierService = await ensureCarrierService(supabase, context, roamingProfile, mode, result)
  return { context, coveredProfile, roamingProfile, carrierService }
}

async function ensureScenarioSim(supabase, plan, mode, result) {
  const iccid = plan.sim.iccid
  const statusRepresentation = resolveSimStatusRepresentation(plan)
  const existing = await selectOne(
    supabase,
    'sims',
    `select=sim_id,iccid,status,supplier_id,enterprise_id,operator_id&iccid=eq.${encodeURIComponent(iccid)}`
  )
  if (existing?.sim_id) {
    result.reused += 1
    result.actions.push({
      action: 'ensureScenarioSim',
      table: 'sims',
      status: 'reused',
      iccid,
      catalogStatus: statusRepresentation.catalogStatus,
      dbStatus: existing.status,
      note: statusRepresentation.note ?? null,
    })
    return existing
  }

  const row = {
    sim_id: crypto.randomUUID(),
    iccid,
    primary_imsi: `460${iccid.slice(-12)}`,
    supplier_id: DEFAULT_RATING_SCENARIO_SCOPE.supplierId,
    enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
    operator_id: plan.sim.operatorId ?? null,
    status: statusRepresentation.status,
    apn: 'iot',
    activation_date: statusRepresentation.status === 'INVENTORY' ? null : `${plan.period}-01T00:00:00.000Z`,
    upstream_status: statusRepresentation.status === 'INVENTORY' ? 'INVENTORY' : 'CONNECTED',
    upstream_status_updated_at: new Date().toISOString(),
  }
  if (mode === 'dry-run') {
    result.skipped += 1
    result.actions.push({
      action: 'ensureScenarioSim',
      table: 'sims',
      status: 'would-create',
      iccid,
      catalogStatus: statusRepresentation.catalogStatus,
      dbStatus: row.status,
      note: statusRepresentation.note ?? null,
      row,
    })
    return row
  }
  await insertRow(supabase, 'sims', row)
  result.created += 1
  result.actions.push({
    action: 'ensureScenarioSim',
    table: 'sims',
    status: 'created',
    iccid,
    catalogStatus: statusRepresentation.catalogStatus,
    dbStatus: row.status,
    note: statusRepresentation.note ?? null,
  })
  return row
}

async function loadPackageFixture(supabase, pricePlanType) {
  const packageName = scenarioName(pricePlanType, 'PACKAGE')
  return selectOne(
    supabase,
    'packages',
    `select=package_id,name,price_plan_id,status&enterprise_id=eq.${encodeURIComponent(DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId)}&name=eq.${encodeURIComponent(packageName)}`
  )
}

async function ensureSharedPackageFixture(supabase, pricePlanType, mode, context, result) {
  const ensured = await ensurePricePlanFixture(
    supabase,
    pricePlanType,
    context.sharedPricePlanFixtures,
    mode,
    result
  )
  return ensured?.package ?? loadPackageFixture(supabase, pricePlanType)
}

async function ensureScenarioPackageFixture(supabase, plan, pricePlanType, mode, context, result) {
  const ensured = await ensurePricePlanFixture(
    supabase,
    pricePlanType,
    context.sharedPricePlanFixtures,
    mode,
    result,
    plan.scenarioId
  )
  return ensured?.package ?? loadPackageFixture(supabase, pricePlanType)
}

async function loadPackageById(supabase, packageId) {
  if (!packageId) return null
  return selectOne(
    supabase,
    'packages',
    `select=package_id,name,price_plan_id,status,carrier_service_id&package_id=eq.${encodeURIComponent(String(packageId))}`
  )
}

async function ensureDefaultFallbackMapping(supabase, shared, fallbackPackage, mode, result) {
  const operatorId = shared.context.operatorId
  if (!operatorId) {
    result.pendingHandlers += 1
    result.actions.push({ action: 'ensureDefaultFallbackMapping', table: 'default_fallback_package_mappings', status: 'missing-operator' })
    return null
  }
  const filters = [
    `enterprise_id=eq.${encodeURIComponent(DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId)}`,
    `reseller_id=eq.${encodeURIComponent(DEFAULT_RATING_SCENARIO_SCOPE.resellerId)}`,
    `supplier_id=eq.${encodeURIComponent(DEFAULT_RATING_SCENARIO_SCOPE.supplierId)}`,
    `operator_id=eq.${encodeURIComponent(String(operatorId))}`,
    'status=eq.ACTIVE',
  ].join('&')
  const existing = await selectOne(
    supabase,
    'default_fallback_package_mappings',
    `select=mapping_id,enterprise_id,reseller_id,supplier_id,operator_id,package_id,status&${filters}`
  )
  if (existing?.mapping_id) {
    result.reused += 1
    result.actions.push({
      action: 'ensureDefaultFallbackMapping',
      table: 'default_fallback_package_mappings',
      status: 'reused',
      mappingId: existing.mapping_id,
      packageId: existing.package_id,
    })
    return existing
  }
  if (!fallbackPackage?.package_id) {
    result.pendingHandlers += 1
    result.actions.push({ action: 'ensureDefaultFallbackMapping', table: 'default_fallback_package_mappings', status: 'missing-package' })
    return null
  }
  const row = {
    mapping_id: crypto.randomUUID(),
    enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
    reseller_id: DEFAULT_RATING_SCENARIO_SCOPE.resellerId,
    supplier_id: DEFAULT_RATING_SCENARIO_SCOPE.supplierId,
    operator_id: operatorId,
    package_id: fallbackPackage.package_id,
    status: 'ACTIVE',
  }
  if (mode === 'dry-run') {
    result.skipped += 1
    result.actions.push({ action: 'ensureDefaultFallbackMapping', table: 'default_fallback_package_mappings', status: 'would-create', row })
    return row
  }
  await insertRow(supabase, 'default_fallback_package_mappings', row)
  result.created += 1
  result.actions.push({
    action: 'ensureDefaultFallbackMapping',
    table: 'default_fallback_package_mappings',
    status: 'created',
    mappingId: row.mapping_id,
    packageId: row.package_id,
  })
  return row
}

function subscriptionRowsForPlan(plan, mainPackage, addOnPackage) {
  const base = {
    enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
    effective_at: `${plan.period}-01T00:00:00.000Z`,
    first_subscribed_at: `${plan.period}-01T00:00:00.000Z`,
    commitment_end_at: `${Number(plan.period.slice(0, 4)) + 1}${plan.period.slice(4)}-01T00:00:00.000Z`,
  }
  const cancelled = {
    state: 'CANCELLED',
    cancelled_at: `${plan.period}-02T00:00:00.000Z`,
    expires_at: `${plan.period}-02T00:00:00.000Z`,
  }
  switch (plan.scenarioId) {
    case 'R-SUB-001':
      return [{ ...base, subscription_kind: 'MAIN', package_id: mainPackage?.package_id, state: 'ACTIVE' }]
    case 'R-SUB-002':
      return [{ ...base, subscription_kind: 'ADD_ON', package_id: addOnPackage?.package_id, state: 'ACTIVE' }]
    case 'R-SUB-003':
    case 'R-SUB-004':
      return [
        { ...base, subscription_kind: 'MAIN', package_id: mainPackage?.package_id, state: 'ACTIVE' },
        { ...base, subscription_kind: 'ADD_ON', package_id: addOnPackage?.package_id, state: 'ACTIVE' },
      ]
    case 'R-SUB-005':
      return [
        { ...base, subscription_kind: 'MAIN', package_id: mainPackage?.package_id, state: 'ACTIVE' },
        { ...base, subscription_kind: 'ADD_ON', package_id: addOnPackage?.package_id, ...cancelled },
      ]
    case 'R-SUB-006':
      return [
        { ...base, subscription_kind: 'MAIN', package_id: mainPackage?.package_id, ...cancelled },
        { ...base, subscription_kind: 'ADD_ON', package_id: addOnPackage?.package_id, state: 'ACTIVE' },
      ]
    default:
      return []
  }
}

async function ensureScenarioSubscription(supabase, sim, row, mode, result) {
  if (!row.package_id) {
    result.pendingHandlers += 1
    result.actions.push({
      action: 'ensureScenarioSubscription',
      table: 'subscriptions',
      status: 'missing-package',
      kind: row.subscription_kind,
    })
    return null
  }
  const existing = await selectOne(
    supabase,
    'subscriptions',
    [
      'select=subscription_id,sim_id,package_id,subscription_kind,state',
      `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
      `package_id=eq.${encodeURIComponent(String(row.package_id))}`,
      `subscription_kind=eq.${encodeURIComponent(String(row.subscription_kind))}`,
    ].join('&')
  )
  if (existing?.subscription_id) {
    result.reused += 1
    result.actions.push({
      action: 'ensureScenarioSubscription',
      table: 'subscriptions',
      status: 'reused',
      kind: row.subscription_kind,
      state: existing.state,
      packageId: row.package_id,
    })
    return existing
  }
  const payload = {
    subscription_id: crypto.randomUUID(),
    ...row,
    sim_id: sim.sim_id,
  }
  if (mode === 'dry-run') {
    result.skipped += 1
    result.actions.push({
      action: 'ensureScenarioSubscription',
      table: 'subscriptions',
      status: 'would-create',
      kind: row.subscription_kind,
      state: row.state,
      packageId: row.package_id,
      row: payload,
    })
    return payload
  }
  await insertRow(supabase, 'subscriptions', payload)
  result.created += 1
  result.actions.push({
    action: 'ensureScenarioSubscription',
    table: 'subscriptions',
    status: 'created',
    kind: row.subscription_kind,
    state: row.state,
    packageId: row.package_id,
  })
  return payload
}

async function ensureUsageDailySummary(supabase, plan, sim, usageSpec, mode, result) {
  const split = splitMb(usageSpec.totalMb)
  const match = [
    `iccid=eq.${encodeURIComponent(String(sim.iccid))}`,
    `usage_day=eq.${encodeURIComponent(plan.usageDay)}`,
    `visited_mccmnc=eq.${encodeURIComponent(usageSpec.visitedMccMnc)}`,
  ].join('&')
  const existing = await selectOne(supabase, 'usage_daily_summary', `select=usage_id&${match}`)
  const row = {
    supplier_id: sim.supplier_id ?? DEFAULT_RATING_SCENARIO_SCOPE.supplierId,
    enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
    sim_id: sim.sim_id,
    iccid: sim.iccid,
    usage_day: plan.usageDay,
    visited_mccmnc: usageSpec.visitedMccMnc,
    uplink_mb: split.uplink,
    downlink_mb: split.downlink,
    total_mb: split.total,
    in_profile_mb: 0,
    out_of_profile_mb: 0,
    unclassified_mb: split.total,
    rated_at: null,
    apn: sim.apn ?? 'iot',
    rat: '4G',
    input_ref: scenarioExternalRef(plan.scenarioId, 'USAGE'),
    updated_at: new Date().toISOString(),
  }
  if (existing?.usage_id) {
    if (mode === 'dry-run') {
      result.skipped += 1
      result.actions.push({ action: 'ensureUsageDailySummary', table: 'usage_daily_summary', status: 'would-update', usageId: existing.usage_id, row })
      return { ...row, usage_id: existing.usage_id }
    }
    await updateRow(supabase, 'usage_daily_summary', `usage_id=eq.${encodeURIComponent(String(existing.usage_id))}`, row)
    result.reused += 1
    result.actions.push({ action: 'ensureUsageDailySummary', table: 'usage_daily_summary', status: 'updated', usageId: existing.usage_id, visitedMccMnc: usageSpec.visitedMccMnc, totalMb: split.total })
    return { ...row, usage_id: existing.usage_id }
  }
  const insert = {
    ...row,
    created_at: new Date().toISOString(),
  }
  if (mode === 'dry-run') {
    result.skipped += 1
    result.actions.push({ action: 'ensureUsageDailySummary', table: 'usage_daily_summary', status: 'would-create', row: insert })
    return insert
  }
  await insertRow(supabase, 'usage_daily_summary', insert)
  result.created += 1
  result.actions.push({ action: 'ensureUsageDailySummary', table: 'usage_daily_summary', status: 'created', iccid: sim.iccid, usageDay: plan.usageDay, visitedMccMnc: usageSpec.visitedMccMnc, totalMb: split.total })
  return insert
}

async function ensureSimActivatedHistoryForUsage(supabase, plan, sim, mode, result) {
  if (!sim?.sim_id) return null
  const startTime = isoStartOfDay(addDaysIsoDate(plan.usageDay, -1))
  const endTime = isoStartOfDay(addDaysIsoDate(plan.usageDay, 1))
  const requestId = scenarioExternalRef(plan.scenarioId, 'SIM_ACTIVE_HISTORY')
  const existing = await selectOne(
    supabase,
    'sim_state_history',
    [
      'select=history_id,sim_id,after_status,start_time,end_time,request_id',
      `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
      `request_id=eq.${encodeURIComponent(requestId)}`,
    ].join('&')
  )
  const row = {
    sim_id: sim.sim_id,
    before_status: 'INVENTORY',
    after_status: 'ACTIVATED',
    start_time: startTime,
    end_time: endTime,
    source: 'rating_scenario_seed',
    request_id: requestId,
  }
  if (existing?.history_id) {
    result.reused += 1
    result.actions.push({
      action: 'ensureSimActivatedHistoryForUsage',
      table: 'sim_state_history',
      status: 'reused',
      historyId: existing.history_id,
      requestId,
    })
    return existing
  }
  if (mode === 'dry-run') {
    result.skipped += 1
    result.actions.push({
      action: 'ensureSimActivatedHistoryForUsage',
      table: 'sim_state_history',
      status: 'would-create',
      requestId,
      row,
    })
    return row
  }
  await insertRow(supabase, 'sim_state_history', row)
  result.created += 1
  result.actions.push({
    action: 'ensureSimActivatedHistoryForUsage',
    table: 'sim_state_history',
    status: 'created',
    requestId,
  })
  return row
}

async function ensureSubscriptionScenarioData(supabase, plan, mode, context, result) {
  if (plan.group !== SCENARIO_GROUPS.subscription) return
  const sim = await ensureScenarioSim(supabase, plan, mode, result)
  const mainPackage = await ensureSharedPackageFixture(supabase, SUBSCRIPTION_PACKAGE_ROLE.main, mode, context, result)
  const addOnPackage = plan.scenarioId === 'R-SUB-004'
    ? await ensureNonMatchingAddOnPackageFixture(supabase, mode, context, result)
    : await ensureSharedPackageFixture(supabase, SUBSCRIPTION_PACKAGE_ROLE.addOn, mode, context, result)
  const rows = subscriptionRowsForPlan(plan, mainPackage, addOnPackage)
  for (const row of rows) {
    await ensureScenarioSubscription(supabase, sim, row, mode, result)
  }
  await ensureUsageDailySummary(supabase, plan, sim, usageSpecForPlan(plan), mode, result)
}

function subscriptionStateRowForPlan(plan, mainPackage) {
  const catalogState = String(plan.subscription.state || '').toUpperCase()
  const representation = SUBSCRIPTION_STATE_DB_REPRESENTATION[catalogState]
  if (!representation) return null

  const inactiveDate = addDaysIsoDate(plan.usageDay, -1)
  const futureDate = addDaysIsoDate(plan.usageDay, 2)
  const effectiveAt = representation.effectiveTiming === 'after-usage-day'
    ? isoStartOfDay(futureDate)
    : isoStartOfDay(addDaysIsoDate(plan.usageDay, -7))
  const row = {
    enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
    subscription_kind: 'MAIN',
    package_id: mainPackage?.package_id,
    state: representation.state,
    effective_at: effectiveAt,
    first_subscribed_at: effectiveAt,
    commitment_end_at: `${Number(plan.period.slice(0, 4)) + 1}${plan.period.slice(4)}-01T00:00:00.000Z`,
    _catalogState: catalogState,
    _representationNote: representation.note ?? null,
  }
  if (representation.inactiveAt === 'before-usage-day') {
    row.expires_at = isoStartOfDay(inactiveDate)
  }
  if (representation.state === 'CANCELLED') {
    row.cancelled_at = isoStartOfDay(inactiveDate)
  }
  return row
}

async function ensureSubscriptionStateScenarioData(supabase, plan, mode, context, result) {
  if (plan.group !== SCENARIO_GROUPS.subscriptionState) return
  const sim = await ensureScenarioSim(supabase, plan, mode, result)
  const mainPackage = await ensureSharedPackageFixture(supabase, SUBSCRIPTION_PACKAGE_ROLE.main, mode, context, result)
  const row = subscriptionStateRowForPlan(plan, mainPackage)
  if (!row) {
    result.pendingHandlers += 1
    result.actions.push({
      action: 'ensureSubscriptionStateScenarioData',
      status: 'unsupported-state',
      catalogState: plan.subscription.state,
    })
    return
  }
  const note = row._representationNote
  const catalogState = row._catalogState
  delete row._representationNote
  delete row._catalogState
  const subscription = await ensureScenarioSubscription(supabase, sim, row, mode, result)
  result.actions.push({
    action: 'recordSubscriptionStateRepresentation',
    status: 'mapped',
    catalogState,
    dbState: row.state,
    effectiveAt: row.effective_at,
    expiresAt: row.expires_at ?? null,
    subscriptionId: subscription?.subscription_id ?? null,
    note,
  })
  await ensureUsageDailySummary(supabase, plan, sim, usageSpecForPlan(plan), mode, result)
}

async function ensureSimStatusScenarioData(supabase, plan, mode, context, result) {
  if (plan.group !== SCENARIO_GROUPS.simStatus) return
  const sim = await ensureScenarioSim(supabase, plan, mode, result)
  const statusRepresentation = resolveSimStatusRepresentation(plan)
  if (statusRepresentation.status === 'INVENTORY') {
    result.actions.push({
      action: 'ensureSimStatusScenarioData',
      status: 'no-subscription',
      reason: 'Inventory SIM anomaly scenario intentionally has no subscription.',
      catalogStatus: statusRepresentation.catalogStatus,
      dbStatus: statusRepresentation.status,
    })
    await ensureUsageDailySummary(supabase, plan, sim, usageSpecForPlan(plan), mode, result)
    return
  }
  if (statusRepresentation.status !== 'ACTIVATED') {
    await ensureSimActivatedHistoryForUsage(supabase, plan, sim, mode, result)
  }
  const mainPackage = await ensureSharedPackageFixture(supabase, SUBSCRIPTION_PACKAGE_ROLE.main, mode, context, result)
  await ensureScenarioSubscription(
    supabase,
    sim,
    {
      enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
      subscription_kind: 'MAIN',
      package_id: mainPackage?.package_id,
      state: 'ACTIVE',
      effective_at: isoStartOfDay(addDaysIsoDate(plan.usageDay, -7)),
      first_subscribed_at: isoStartOfDay(addDaysIsoDate(plan.usageDay, -7)),
      commitment_end_at: `${Number(plan.period.slice(0, 4)) + 1}${plan.period.slice(4)}-01T00:00:00.000Z`,
    },
    mode,
    result
  )
  result.actions.push({
    action: 'recordSimStatusRepresentation',
    status: 'mapped',
    catalogStatus: statusRepresentation.catalogStatus,
    dbStatus: statusRepresentation.status,
    note: statusRepresentation.note ?? null,
  })
  await ensureUsageDailySummary(supabase, plan, sim, usageSpecForPlan(plan), mode, result)
}

async function ensureActivePackageScenarioData(supabase, plan, mode, context, result) {
  const pricePlanType = plan.ratingInputs.pricePlanType ?? SUBSCRIPTION_PACKAGE_ROLE.main
  const packageFixture = plan.ratingInputs.capacityOverflow
    ? await ensureScenarioPackageFixture(supabase, plan, pricePlanType, mode, context, result)
    : await ensureSharedPackageFixture(supabase, pricePlanType, mode, context, result)
  const sim = await ensureScenarioSim(supabase, plan, mode, result)
  if (plan.subscription.type === 'MAIN_AND_ADD_ON') {
    const mainPackage = await ensureSharedPackageFixture(supabase, SUBSCRIPTION_PACKAGE_ROLE.main, mode, context, result)
    await ensureScenarioSubscription(
      supabase,
      sim,
      {
        enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
        subscription_kind: 'MAIN',
        package_id: mainPackage?.package_id,
        state: 'ACTIVE',
        effective_at: isoStartOfDay(addDaysIsoDate(plan.usageDay, -7)),
        first_subscribed_at: isoStartOfDay(addDaysIsoDate(plan.usageDay, -7)),
        commitment_end_at: `${Number(plan.period.slice(0, 4)) + 1}${plan.period.slice(4)}-01T00:00:00.000Z`,
      },
      mode,
      result
    )
    await ensureScenarioSubscription(
      supabase,
      sim,
      {
        enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
        subscription_kind: 'ADD_ON',
        package_id: packageFixture?.package_id,
        state: 'ACTIVE',
        effective_at: isoStartOfDay(addDaysIsoDate(plan.usageDay, -7)),
        first_subscribed_at: isoStartOfDay(addDaysIsoDate(plan.usageDay, -7)),
        commitment_end_at: `${Number(plan.period.slice(0, 4)) + 1}${plan.period.slice(4)}-01T00:00:00.000Z`,
      },
      mode,
      result
    )
  } else if (plan.subscription.type) {
    await ensureScenarioSubscription(
      supabase,
      sim,
      {
        enterprise_id: DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId,
        subscription_kind: plan.subscription.expectedType === 'ADD_ON' ? 'ADD_ON' : 'MAIN',
        package_id: packageFixture?.package_id,
        state: 'ACTIVE',
        effective_at: isoStartOfDay(addDaysIsoDate(plan.usageDay, -7)),
        first_subscribed_at: isoStartOfDay(addDaysIsoDate(plan.usageDay, -7)),
        commitment_end_at: `${Number(plan.period.slice(0, 4)) + 1}${plan.period.slice(4)}-01T00:00:00.000Z`,
      },
      mode,
      result
    )
  }
  await ensureUsageDailySummary(supabase, plan, sim, usageSpecForPlan(plan), mode, result)
  if (plan.ratingInputs.capacityOverflow) {
    const fallbackPackage = await ensureSharedPackageFixture(supabase, SUBSCRIPTION_PACKAGE_ROLE.main, mode, context, result)
    await ensureDefaultFallbackMapping(supabase, context.sharedPricePlanFixtures, fallbackPackage, mode, result)
  }
}

async function ensureFallbackScenarioData(supabase, plan, mode, context, result) {
  if (plan.group !== SCENARIO_GROUPS.fallback && !plan.ratingInputs.fallback) return

  const mainPackage = await ensureSharedPackageFixture(supabase, SUBSCRIPTION_PACKAGE_ROLE.main, mode, context, result)
  let fallbackMapping = null
  let fallbackPackage = mainPackage
  if (plan.ratingInputs.fallback) {
    fallbackMapping = await ensureDefaultFallbackMapping(supabase, context.sharedPricePlanFixtures, mainPackage, mode, result)
    if (fallbackMapping?.package_id) {
      fallbackPackage = await loadPackageById(supabase, fallbackMapping.package_id) ?? mainPackage
    }
    plan.sim.operatorId = context.sharedPricePlanFixtures.context.operatorId
  } else {
    plan.sim.operatorId = null
    result.actions.push({
      action: 'ensureFallbackScenarioData',
      status: 'no-fallback-scope',
      reason: 'Scenario intentionally leaves sim.operator_id null so the enterprise/reseller/supplier/operator fallback key cannot match.',
    })
  }

  const sim = await ensureScenarioSim(supabase, plan, mode, result)
  if (plan.scenarioId === 'R-FB-002') {
    const row = subscriptionStateRowForPlan(
      {
        ...plan,
        subscription: { ...plan.subscription, state: 'EXPIRED' },
      },
      mainPackage
    )
    if (row) {
      const note = row._representationNote
      const catalogState = row._catalogState
      delete row._representationNote
      delete row._catalogState
      const subscription = await ensureScenarioSubscription(supabase, sim, row, mode, result)
      result.actions.push({
        action: 'recordFallbackNonActiveSubscription',
        status: 'mapped',
        catalogState,
        dbState: row.state,
        expiresAt: row.expires_at ?? null,
        subscriptionId: subscription?.subscription_id ?? null,
        note,
      })
    }
  }

  const usageClass = String(plan.ratingInputs.usageClass || 'UNCLASSIFIED').toUpperCase()
  const usageSpec = FALLBACK_USAGE_BY_CLASS[usageClass] ?? FALLBACK_USAGE_BY_CLASS.UNCLASSIFIED
  await ensureUsageDailySummary(supabase, plan, sim, usageSpec, mode, result)
  result.actions.push({
    action: 'recordFallbackScenario',
    status: 'seeded',
    fallbackExpected: plan.ratingInputs.fallback,
    mappingId: fallbackMapping?.mapping_id ?? null,
    fallbackPackageId: fallbackPackage?.package_id ?? null,
    usageClass,
    visitedMccMnc: usageSpec.visitedMccMnc,
  })
}

function buildCleanupScope(plans) {
  const iccids = plans.map((plan) => plan.sim.iccid)
  const usageRefs = plans.map((plan) => scenarioExternalRef(plan.scenarioId, 'USAGE'))
  const usageDays = plans.map((plan) => plan.usageDay)
  return {
    iccids: [...new Set(iccids)],
    usageRefs: [...new Set(usageRefs)],
    usageDays: [...new Set(usageDays)],
    scenarioIds: plans.map((plan) => plan.scenarioId),
  }
}

function sharedFixtureNames() {
  return Object.values(PRICE_PLAN_TYPES).map((pricePlanType) => ({
    pricePlanType,
    planName: scenarioName(pricePlanType, 'PLAN'),
    packageName: scenarioName(pricePlanType, 'PACKAGE'),
  }))
}

async function cleanupSharedFixtures(supabase, mode, result) {
  const fixtures = sharedFixtureNames()
  const packageNames = fixtures.map((fixture) => fixture.packageName)
  const planNames = fixtures.map((fixture) => fixture.planName)
  const packageRows = await supabase.select(
    'packages',
    `select=package_id,name,price_plan_id&name=in.(${encodeInList(packageNames)})`
  )
  const packages = Array.isArray(packageRows) ? packageRows : []
  for (const pkg of packages) {
    const packageId = String(pkg.package_id || '')
    const refs = {
      subscriptions: await countRows(supabase, 'subscriptions', `package_id=eq.${encodeURIComponent(packageId)}`),
      packageSummary: await countRows(supabase, 'usage_package_daily_summary', `package_id=eq.${encodeURIComponent(packageId)}`),
      fallbackMappings: await countRows(supabase, 'default_fallback_package_mappings', `package_id=eq.${encodeURIComponent(packageId)}`),
    }
    const refTotal = Object.values(refs).reduce((sum, count) => sum + Number(count || 0), 0)
    if (refTotal > 0) {
      result.actions.push({
        action: 'cleanupSharedPackage',
        table: 'packages',
        status: 'skipped-referenced',
        packageId,
        name: pkg.name,
        refs,
      })
      continue
    }
    await deleteRows(supabase, 'packages', `package_id=eq.${encodeURIComponent(packageId)}`, mode, result, 'unreferenced RS46 package fixture')
  }

  const planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,name,type&name=in.(${encodeInList(planNames)})`
  )
  const plans = Array.isArray(planRows) ? planRows : []
  for (const plan of plans) {
    const pricePlanId = String(plan.price_plan_id || '')
    const packageRefs = await countRows(supabase, 'packages', `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`)
    if (packageRefs > 0) {
      result.actions.push({
        action: 'cleanupSharedPricePlan',
        table: 'price_plans',
        status: 'skipped-referenced',
        pricePlanId,
        name: plan.name,
        refs: { packages: packageRefs },
      })
      continue
    }
    const fixture = fixtures.find((item) => item.planName === plan.name)
    const extension = fixture ? PRICE_PLAN_EXTENSION[fixture.pricePlanType] : null
    if (extension) {
      await deleteRows(supabase, extension.table, `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`, mode, result, 'RS46 price plan extension fixture')
    }
    await deleteRows(supabase, 'price_plans', `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`, mode, result, 'unreferenced RS46 price plan fixture')
  }
}

async function cleanupCapacityOverflowFixtures(supabase, plans, mode, result) {
  const fixtures = plans
    .filter((plan) => plan.ratingInputs?.capacityOverflow && plan.ratingInputs?.pricePlanType)
    .map((plan) => ({
      scenarioId: plan.scenarioId,
      pricePlanType: plan.ratingInputs.pricePlanType,
      planName: scenarioName(plan.scenarioId, 'PLAN'),
      packageName: scenarioName(plan.scenarioId, 'PACKAGE'),
    }))
  if (!fixtures.length) return

  const packageRows = await supabase.select(
    'packages',
    `select=package_id,name,price_plan_id&name=in.(${encodeInList(fixtures.map((fixture) => fixture.packageName))})`
  )
  for (const pkg of Array.isArray(packageRows) ? packageRows : []) {
    const packageId = String(pkg.package_id || '')
    if (!packageId) continue
    const refs = {
      subscriptions: await countRows(supabase, 'subscriptions', `package_id=eq.${encodeURIComponent(packageId)}`),
      packageSummary: await countRows(supabase, 'usage_package_daily_summary', `package_id=eq.${encodeURIComponent(packageId)}`),
      fallbackMappings: await countRows(supabase, 'default_fallback_package_mappings', `package_id=eq.${encodeURIComponent(packageId)}`),
    }
    const refTotal = Object.values(refs).reduce((sum, count) => sum + Number(count || 0), 0)
    if (refTotal > 0) {
      result.actions.push({
        action: 'cleanupCapacityOverflowPackage',
        table: 'packages',
        status: 'skipped-referenced',
        packageId,
        name: pkg.name,
        refs,
      })
      continue
    }
    await deleteRows(supabase, 'packages', `package_id=eq.${encodeURIComponent(packageId)}`, mode, result, 'unreferenced capacity overflow scenario package fixture')
  }

  const planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,name,type&name=in.(${encodeInList(fixtures.map((fixture) => fixture.planName))})`
  )
  for (const plan of Array.isArray(planRows) ? planRows : []) {
    const pricePlanId = String(plan.price_plan_id || '')
    if (!pricePlanId) continue
    const packageRefs = await countRows(supabase, 'packages', `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`)
    if (packageRefs > 0) {
      result.actions.push({
        action: 'cleanupCapacityOverflowPricePlan',
        table: 'price_plans',
        status: 'skipped-referenced',
        pricePlanId,
        name: plan.name,
        refs: { packages: packageRefs },
      })
      continue
    }
    const fixture = fixtures.find((item) => item.planName === plan.name)
    const extension = fixture ? PRICE_PLAN_EXTENSION[fixture.pricePlanType] : null
    if (extension) {
      await deleteRows(supabase, extension.table, `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`, mode, result, 'capacity overflow price plan extension fixture')
    }
    await deleteRows(supabase, 'price_plans', `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`, mode, result, 'unreferenced capacity overflow price plan fixture')
  }
}

async function executeCleanup({ supabase, plans, mode, includeSharedFixtures = false }) {
  const scope = buildCleanupScope(plans)
  const result = {
    scenarioId: '__cleanup__',
    group: 'cleanup',
    mode,
    status: mode === 'dry-run' ? 'dry-run' : 'cleaned',
    created: 0,
    reused: 0,
    skipped: 0,
    deleted: 0,
    pendingHandlers: 0,
    scope,
    actions: [],
  }

  if (!scope.iccids.length) {
    result.status = 'empty'
    result.actions.push({ action: 'cleanup', status: 'empty-scope' })
    return result
  }

  const iccidFilter = `iccid=in.(${encodeInList(scope.iccids)})`
  const inputRefFilter = `input_ref=in.(${encodeInList(scope.usageRefs)})`
  const simIds = await loadScenarioSimIds(supabase, scope.iccids)

  await deleteRows(supabase, 'usage_package_daily_summary', iccidFilter, mode, result, 'rating rollup package summaries for selected scenario ICCIDs')
  await deleteRows(supabase, 'rating_results', iccidFilter, mode, result, 'rating results for selected scenario ICCIDs')
  await deleteRows(supabase, 'usage_daily_summary', inputRefFilter, mode, result, 'seeded usage_daily_summary rows with scenario input_ref')
  if (simIds.length) {
    await deleteRows(supabase, 'alerts', `sim_id=in.(${encodeInList(simIds)})`, mode, result, 'alerts generated for selected scenario SIMs')
    await deleteRows(supabase, 'sim_state_history', `sim_id=in.(${encodeInList(simIds)})`, mode, result, 'SIM state history generated for selected scenario SIMs')
    await deleteRows(supabase, 'subscriptions', `sim_id=in.(${encodeInList(simIds)})`, mode, result, 'subscriptions for selected scenario SIMs')
  } else {
    result.actions.push({ action: 'deleteRows', table: 'subscriptions', status: 'skipped-empty-scope', count: 0 })
  }
  await deleteRows(supabase, 'sims', iccidFilter, mode, result, 'selected scenario SIMs')
  await cleanupCapacityOverflowFixtures(supabase, plans, mode, result)

  if (includeSharedFixtures) {
    await cleanupSharedFixtures(supabase, mode, result)
  } else {
    result.actions.push({
      action: 'cleanupSharedFixtures',
      status: 'skipped',
      reason: 'Shared RS46 price plans/packages/profiles and fallback mappings are not deleted by default because they may be reused or pre-existing. Use --include-shared-fixtures to attempt unreferenced RS46 package/price plan cleanup.',
    })
  }
  return result
}

async function loadScenarioSimIds(supabase, iccids) {
  if (!iccids.length) return []
  const rows = await supabase.select(
    'sims',
    `select=sim_id,iccid&iccid=in.(${encodeInList(iccids)})`
  )
  return (Array.isArray(rows) ? rows : []).map((row) => String(row.sim_id || '')).filter(Boolean)
}

function printHelp() {
  console.log(`
Usage:
  node tools/seed_rating_scenarios.js [options]

Options:
  --period YYYY-MM          Rating period to seed. Default: current UTC month.
  --scenario <id>           Seed one scenario, for example R-PP-004.
  --group <group>           Seed one group: ${Object.values(SCENARIO_GROUPS).join(', ')}.
  --dry-run                 Preview actions only. This is the default.
  --apply                   Execute seed actions.
  --cleanup                 Cleanup selected scenario/group outputs. Defaults to dry-run unless --apply is also set.
  --include-shared-fixtures Also try deleting unreferenced RS46 package/price plan fixtures during cleanup.
  --json                    Print machine-readable JSON.
  --list                    List selected scenarios.
  --help                    Show this help.

Phase 46 status:
  T381 provides the CLI framework.
  T382 seeds reusable PricePlan/Package/Profile fixtures.
  T383 seeds MAIN/ADD_ON subscription combinations.
  T384 seeds subscription state filtering cases.
  T385 seeds SIM status coverage cases.
  T386 seeds fallback package attribution cases.
  T387 provides cleanup/reset support.
  Rollup/verifier utilities are added by T388-T389.
  Baseline, pricePlan, and usage groups share the same concrete usage writer.
`.trim())
}

function currentUtcPeriod() {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function parsePeriod(value) {
  const period = String(value || currentUtcPeriod()).trim()
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error('--period must be YYYY-MM')
  }
  return period
}

function parseMode() {
  if (hasFlag('apply') && hasFlag('dry-run')) {
    throw new Error('Use either --apply or --dry-run, not both.')
  }
  return hasFlag('apply') ? 'apply' : 'dry-run'
}

function selectScenarios({ scenarioId, group }) {
  if (scenarioId && group) {
    throw new Error('Use either --scenario or --group, not both.')
  }
  if (scenarioId) {
    const scenario = scenarioById(scenarioId)
    if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`)
    return [scenario]
  }
  if (group) {
    if (!Object.values(SCENARIO_GROUPS).includes(group)) {
      throw new Error(`Unknown group: ${group}`)
    }
    return scenariosByGroup(group)
  }
  return RATING_SCENARIOS
}

function buildScenarioPlan(scenario, period) {
  const day = scenarioDay(period, scenario.id)
  const primaryIccid = scenarioIccid(scenario.id)
  const implementedSeedGroups = new Set([
    SCENARIO_GROUPS.baseline,
    SCENARIO_GROUPS.pricePlan,
    SCENARIO_GROUPS.subscription,
    SCENARIO_GROUPS.subscriptionState,
    SCENARIO_GROUPS.simStatus,
    SCENARIO_GROUPS.fallback,
    SCENARIO_GROUPS.usage,
  ])
  return {
    scenarioId: scenario.id,
    group: scenario.group,
    period,
    usageDay: day,
    mode: 'planned',
    names: {
      base: scenarioName(scenario.id),
      simExternalRef: scenarioExternalRef(scenario.id, 'SIM'),
      subscriptionExternalRef: scenarioExternalRef(scenario.id, 'SUBSCRIPTION'),
      usageExternalRef: scenarioExternalRef(scenario.id, 'USAGE'),
    },
    scope: DEFAULT_RATING_SCENARIO_SCOPE,
    sim: {
      iccid: primaryIccid,
      statusCase: scenario.simStatus ?? null,
    },
    subscription: {
      type: scenario.subscriptionType ?? null,
      state: scenario.subscriptionState ?? null,
      expectedType: scenario.expectedSubscriptionType ?? scenario.subscriptionType ?? null,
    },
    ratingInputs: {
      pricePlanType: scenario.pricePlanType ?? null,
      usageClass: scenario.usageClass ?? null,
      fallback: Boolean(scenario.fallback),
      networkMatch: scenario.networkMatch ?? null,
      totalMb: Number.isFinite(Number(scenario.totalMb)) ? Number(scenario.totalMb) : null,
      capacityOverflow: scenario.capacityOverflow ?? null,
    },
    implementationStatus: {
      seedHandler: implementedSeedGroups.has(scenario.group) ? 'implemented' : 'pending',
      phase: implementedSeedGroups.has(scenario.group) ? 'T382-T386' : 'T387-T388',
    },
  }
}

async function executeScenarioPlan(plan, mode, context) {
  const result = {
    scenarioId: plan.scenarioId,
    group: plan.group,
    mode,
    status: 'planned',
    created: 0,
    reused: 0,
    skipped: 0,
    pendingHandlers: 0,
    actions: [],
  }
  if (plan.group === SCENARIO_GROUPS.subscription) {
    await ensureSubscriptionScenarioData(context.supabase, plan, mode, context, result)
  } else if (plan.group === SCENARIO_GROUPS.subscriptionState) {
    await ensureSubscriptionStateScenarioData(context.supabase, plan, mode, context, result)
  } else if (plan.group === SCENARIO_GROUPS.simStatus) {
    await ensureSimStatusScenarioData(context.supabase, plan, mode, context, result)
  } else if (plan.group === SCENARIO_GROUPS.fallback || plan.ratingInputs.fallback) {
    await ensureFallbackScenarioData(context.supabase, plan, mode, context, result)
  } else if (plan.group === SCENARIO_GROUPS.baseline || plan.group === SCENARIO_GROUPS.pricePlan || plan.group === SCENARIO_GROUPS.usage) {
    await ensureActivePackageScenarioData(context.supabase, plan, mode, context, result)
  } else {
    result.pendingHandlers += 1
    result.actions.push({
      action: 'seedScenarioData',
      status: 'pending-handler',
      reason: `No seed handler registered for group ${plan.group}.`,
    })
  }
  if (mode === 'dry-run') {
    result.status = 'dry-run'
    return result
  }
  result.status = result.created > 0 ? 'applied' : 'reused'
  return result
}

function summarize(results) {
  return results.reduce(
    (acc, row) => {
      acc.total += 1
      acc.created += row.created
      acc.reused += row.reused
      acc.skipped += row.skipped
      acc.deleted += row.deleted ?? 0
      acc.pendingHandlers += row.pendingHandlers
      acc.byStatus[row.status] = (acc.byStatus[row.status] ?? 0) + 1
      return acc
    },
    { total: 0, created: 0, reused: 0, skipped: 0, deleted: 0, pendingHandlers: 0, byStatus: {} }
  )
}

function printTextReport({ period, mode, selected, plans, results }) {
  console.log(`Rating scenario seed ${mode}`)
  console.log(`Period: ${period}`)
  console.log(`Namespace prefix: ${RATING_SCENARIO_NAME_PREFIX}`)
  console.log(`Selected scenarios: ${selected.length}`)
  console.log('')
  for (const plan of plans) {
    console.log(`- ${plan.scenarioId} [${plan.group}] day=${plan.usageDay} iccid=${plan.sim.iccid} usage=${plan.ratingInputs.usageClass ?? 'n/a'} plan=${plan.ratingInputs.pricePlanType ?? 'n/a'} fallback=${plan.ratingInputs.fallback}`)
  }
  console.log('')
  console.log('Summary:', summarize(results))
  if (results.some((row) => row.pendingHandlers > 0)) {
    console.log('')
    console.log('Note: some selected scenarios still have no concrete seed handler; inspect pendingHandlers before running --apply.')
  }
}

async function main() {
  if (hasFlag('help')) {
    printHelp()
    return
  }

  const validation = validateScenarioCatalog()
  if (!validation.ok) {
    throw new Error(`Invalid rating scenario catalog:\n${validation.errors.join('\n')}`)
  }

  const period = parsePeriod(arg('period'))
  const mode = parseMode()
  const json = hasFlag('json')
  const cleanup = hasFlag('cleanup')
  const includeSharedFixtures = hasFlag('include-shared-fixtures')
  const selected = selectScenarios({
    scenarioId: arg('scenario'),
    group: arg('group'),
  })
  const plans = selected.map((scenario) => buildScenarioPlan(scenario, period))

  if (hasFlag('list')) {
    if (json) {
      console.log(JSON.stringify({ period, count: selected.length, scenarios: plans }, null, 2))
    } else {
      for (const plan of plans) {
        console.log(`${plan.scenarioId}\t${plan.group}\t${plan.usageDay}\t${plan.sim.iccid}`)
      }
    }
    return
  }

  const supabase = createSupabaseRestClient({ useServiceRole: true })
  if (cleanup) {
    const result = await executeCleanup({ supabase, plans, mode, includeSharedFixtures })
    const payload = {
      ok: true,
      period,
      mode,
      operation: 'cleanup',
      includeSharedFixtures,
      scope: DEFAULT_RATING_SCENARIO_SCOPE,
      count: selected.length,
      plans,
      results: [result],
      summary: summarize([result]),
    }
    if (json) {
      console.log(JSON.stringify(payload, null, 2))
      return
    }
    console.log(`Rating scenario cleanup ${mode}`)
    console.log(`Period: ${period}`)
    console.log(`Selected scenarios: ${selected.length}`)
    console.log('Summary:', payload.summary)
    return
  }

  const seedContext = { supabase, sharedPricePlanFixtures: null }
  let bootstrapResult = null
  if (plans.some((plan) => plan.ratingInputs.pricePlanType
    || plan.ratingInputs.fallback
    || plan.group === SCENARIO_GROUPS.baseline
    || plan.group === SCENARIO_GROUPS.subscription
    || plan.group === SCENARIO_GROUPS.subscriptionState
    || plan.group === SCENARIO_GROUPS.simStatus
    || plan.group === SCENARIO_GROUPS.fallback
    || plan.group === SCENARIO_GROUPS.usage)) {
    bootstrapResult = {
      scenarioId: '__shared__',
      group: 'shared',
      mode,
      status: 'bootstrap',
      created: 0,
      reused: 0,
      skipped: 0,
      pendingHandlers: 0,
      actions: [],
    }
    seedContext.sharedPricePlanFixtures = await preparePricePlanSharedFixtures(supabase, mode, bootstrapResult)
  }

  const results = bootstrapResult ? [bootstrapResult] : []
  for (const plan of plans) {
    results.push(await executeScenarioPlan(plan, mode, seedContext))
  }

  const payload = {
    ok: true,
    period,
    mode,
    scope: DEFAULT_RATING_SCENARIO_SCOPE,
    count: selected.length,
    plans,
    results,
    summary: summarize(results),
  }

  if (json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  printTextReport({ period, mode, selected, plans, results })
}

main().catch((err) => {
  console.error(err?.message ?? err)
  process.exitCode = 1
})
