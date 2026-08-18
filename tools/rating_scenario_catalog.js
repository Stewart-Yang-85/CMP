/**
 * Machine-readable Rating scenario catalog.
 *
 * T380 scope:
 * - centralize scenario IDs, groups, naming rules, and fixed fixture scope
 * - keep the data namespace isolated from production/manual fixtures
 * - do not perform any Supabase writes here
 *
 * Seed and verifier tools should import this file instead of duplicating IDs.
 */

export const RATING_SCENARIO_NAMESPACE = 'RATING_SCENARIO'
export const RATING_SCENARIO_NAME_PREFIX = 'RS46'

export const DEFAULT_RATING_SCENARIO_SCOPE = Object.freeze({
  enterpriseId: '43326e05-5704-4e0d-8175-547d6b555132',
  resellerId: '0925eb82-53ef-4522-8d81-07ebaa17d819',
  supplierId: '4699e98b-4b9c-4949-82fb-b1ecb7a089c1',
})

export const CURRENT_BASELINE_FIXTURES = Object.freeze({
  oneTime: {
    pricePlanName: 'US9_SCENARIO_ONE_TIME_1GB',
    packageName: 'US9_SCENARIO_ONE_TIME_PACKAGE_1GB',
  },
  fixedBundle: {
    packageId: '13dc6905-5070-420c-b9ec-8c45b54ebe1c',
    pricePlanId: 'c1703e59-f7d9-4d37-8eab-8fafaf2e792e',
    coveredProfileId: 'fa731051-3676-4c8f-a1b3-84a85baeee7f',
  },
  simDependentBundle: {
    packageId: 'd8283ced-2936-4349-92aa-eceb2013c611',
  },
})

export const SCENARIO_GROUPS = Object.freeze({
  baseline: 'baseline',
  pricePlan: 'pricePlan',
  fallback: 'fallback',
  subscription: 'subscription',
  subscriptionState: 'subscriptionState',
  simStatus: 'simStatus',
  usage: 'usage',
})

export const SUBSCRIPTION_STATES = Object.freeze({
  active: 'ACTIVE',
  expired: 'EXPIRED',
  cancelled: 'CANCELLED',
  suspended: 'SUSPENDED',
  scheduled: 'SCHEDULED',
})

export const SUBSCRIPTION_TYPES = Object.freeze({
  main: 'MAIN',
  addOn: 'ADD_ON',
})

export const PRICE_PLAN_TYPES = Object.freeze({
  oneTime: 'ONE_TIME',
  fixedBundle: 'FIXED_BUNDLE',
  simDependentBundle: 'SIM_DEPENDENT_BUNDLE',
  tieredPricing: 'TIERED_PRICING',
})

export const USAGE_CLASSES = Object.freeze({
  inProfile: 'IN_PROFILE',
  outOfProfile: 'OUT_OF_PROFILE',
  unclassified: 'UNCLASSIFIED',
})

export const SIM_STATUS_CASES = Object.freeze({
  active: 'ACTIVE_OR_ACTIVATED',
  testReady: 'TEST_READY',
  deactive: 'DEACTIVE',
  inventory: 'INVENTORY',
  retired: 'RETIRED',
})

export const SCENARIO_DAY_OFFSETS = Object.freeze({
  'R-BL-001': 10,
  'R-BL-002': 11,
  'R-BL-003': 11,
  'R-BL-004': 12,
  'R-BL-005': 13,
  'R-PP-001': 14,
  'R-PP-002': 15,
  'R-PP-003': 16,
  'R-PP-004': 17,
  'R-PP-005': 18,
  'R-PP-006': 19,
  'R-PP-007': 20,
  'R-PP-008': 21,
  'R-PP-009': 22,
  'R-PP-010': 23,
  'R-PP-011': 24,
  'R-PP-012': 25,
  'R-FB-001': 26,
  'R-FB-002': 27,
  'R-FB-003': 28,
  'R-FB-004': 29,
  'R-FB-005': 30,
  'R-FB-006': 31,
  'R-SUB-001': 32,
  'R-SUB-002': 33,
  'R-SUB-003': 34,
  'R-SUB-004': 35,
  'R-SUB-005': 36,
  'R-SUB-006': 37,
  'R-STATE-001': 38,
  'R-STATE-002': 39,
  'R-STATE-003': 40,
  'R-STATE-004': 41,
  'R-STATE-005': 42,
  'R-SIM-001': 43,
  'R-SIM-002': 44,
  'R-SIM-003': 45,
  'R-SIM-004': 46,
  'R-SIM-005': 47,
  'R-USAGE-001': 48,
  'R-USAGE-002': 49,
  'R-USAGE-003': 50,
  'R-USAGE-004': 51,
  'R-USAGE-005': 52,
  'R-PP-013': 53,
  'R-PP-014': 54,
  'R-PP-015': 55,
})

export const RATING_SCENARIOS = Object.freeze([
  { id: 'R-BL-001', group: SCENARIO_GROUPS.baseline, pricePlanType: PRICE_PLAN_TYPES.oneTime, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-BL-002', group: SCENARIO_GROUPS.baseline, pricePlanType: PRICE_PLAN_TYPES.fixedBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, poolRole: 'B' },
  { id: 'R-BL-003', group: SCENARIO_GROUPS.baseline, pricePlanType: PRICE_PLAN_TYPES.fixedBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, poolRole: 'C' },
  { id: 'R-BL-004', group: SCENARIO_GROUPS.baseline, pricePlanType: PRICE_PLAN_TYPES.simDependentBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.outOfProfile },
  { id: 'R-BL-005', group: SCENARIO_GROUPS.baseline, fallback: true, subscriptionType: null, subscriptionState: null, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.outOfProfile },

  { id: 'R-PP-001', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.oneTime, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-PP-002', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.oneTime, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.outOfProfile },
  { id: 'R-PP-003', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.oneTime, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.unclassified },
  { id: 'R-PP-004', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.fixedBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-PP-005', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.fixedBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.outOfProfile },
  { id: 'R-PP-006', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.fixedBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.unclassified },
  { id: 'R-PP-007', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.simDependentBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-PP-008', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.simDependentBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.outOfProfile },
  { id: 'R-PP-009', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.simDependentBundle, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.unclassified },
  { id: 'R-PP-010', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.tieredPricing, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-PP-011', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.tieredPricing, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.outOfProfile },
  { id: 'R-PP-012', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.tieredPricing, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.unclassified },
  { id: 'R-PP-013', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.oneTime, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, totalMb: 1200, capacityOverflow: 'ONE_TIME_MAIN_TO_FALLBACK' },
  { id: 'R-PP-014', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.oneTime, subscriptionType: 'MAIN_AND_ADD_ON', subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, totalMb: 1200, expectedSubscriptionType: SUBSCRIPTION_TYPES.addOn, capacityOverflow: 'ONE_TIME_ADD_ON_TO_MAIN' },
  { id: 'R-PP-015', group: SCENARIO_GROUPS.pricePlan, pricePlanType: PRICE_PLAN_TYPES.tieredPricing, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, totalMb: 12000, capacityOverflow: 'TIERED_MAIN_TO_FALLBACK' },

  { id: 'R-FB-001', group: SCENARIO_GROUPS.fallback, fallback: true, subscriptionType: null, subscriptionState: null, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-FB-002', group: SCENARIO_GROUPS.fallback, fallback: true, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.expired, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-FB-003', group: SCENARIO_GROUPS.fallback, fallback: false, subscriptionType: null, subscriptionState: null, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.unclassified },
  { id: 'R-FB-004', group: SCENARIO_GROUPS.fallback, fallback: true, subscriptionType: null, subscriptionState: null, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-FB-005', group: SCENARIO_GROUPS.fallback, fallback: true, subscriptionType: null, subscriptionState: null, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.outOfProfile },
  { id: 'R-FB-006', group: SCENARIO_GROUPS.fallback, fallback: true, subscriptionType: null, subscriptionState: null, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.unclassified },

  { id: 'R-SUB-001', group: SCENARIO_GROUPS.subscription, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-SUB-002', group: SCENARIO_GROUPS.subscription, subscriptionType: SUBSCRIPTION_TYPES.addOn, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-SUB-003', group: SCENARIO_GROUPS.subscription, subscriptionType: 'MAIN_AND_ADD_ON', subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, expectedSubscriptionType: SUBSCRIPTION_TYPES.addOn },
  { id: 'R-SUB-004', group: SCENARIO_GROUPS.subscription, subscriptionType: 'MAIN_AND_ADD_ON', subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, expectedSubscriptionType: SUBSCRIPTION_TYPES.main },
  { id: 'R-SUB-005', group: SCENARIO_GROUPS.subscription, subscriptionType: 'MAIN_ACTIVE_ADD_ON_NON_ACTIVE', subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-SUB-006', group: SCENARIO_GROUPS.subscription, subscriptionType: 'MAIN_NON_ACTIVE_ADD_ON_ACTIVE', subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, expectedSubscriptionType: SUBSCRIPTION_TYPES.addOn },

  { id: 'R-STATE-001', group: SCENARIO_GROUPS.subscriptionState, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-STATE-002', group: SCENARIO_GROUPS.subscriptionState, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.expired, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-STATE-003', group: SCENARIO_GROUPS.subscriptionState, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.cancelled, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-STATE-004', group: SCENARIO_GROUPS.subscriptionState, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.suspended, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-STATE-005', group: SCENARIO_GROUPS.subscriptionState, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.scheduled, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },

  { id: 'R-SIM-001', group: SCENARIO_GROUPS.simStatus, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-SIM-002', group: SCENARIO_GROUPS.simStatus, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.testReady, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-SIM-003', group: SCENARIO_GROUPS.simStatus, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.deactive, usageClass: USAGE_CLASSES.inProfile },
  { id: 'R-SIM-004', group: SCENARIO_GROUPS.simStatus, subscriptionType: null, subscriptionState: null, simStatus: SIM_STATUS_CASES.inventory, usageClass: USAGE_CLASSES.unclassified },
  { id: 'R-SIM-005', group: SCENARIO_GROUPS.simStatus, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.retired, usageClass: USAGE_CLASSES.inProfile },

  { id: 'R-USAGE-001', group: SCENARIO_GROUPS.usage, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, networkMatch: 'EXACT_COVERED' },
  { id: 'R-USAGE-002', group: SCENARIO_GROUPS.usage, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.inProfile, networkMatch: 'MCC_WILDCARD_COVERED' },
  { id: 'R-USAGE-003', group: SCENARIO_GROUPS.usage, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.outOfProfile, networkMatch: 'OOP_ROAMING' },
  { id: 'R-USAGE-004', group: SCENARIO_GROUPS.usage, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: USAGE_CLASSES.unclassified, networkMatch: 'NO_RULE' },
  { id: 'R-USAGE-005', group: SCENARIO_GROUPS.usage, subscriptionType: SUBSCRIPTION_TYPES.main, subscriptionState: SUBSCRIPTION_STATES.active, simStatus: SIM_STATUS_CASES.active, usageClass: 'ZERO_USAGE', totalMb: 0 },
])

export function scenarioById(id) {
  return RATING_SCENARIOS.find((scenario) => scenario.id === id) ?? null
}

export function scenariosByGroup(group) {
  return RATING_SCENARIOS.filter((scenario) => scenario.group === group)
}

export function scenarioDay(period, scenarioId) {
  const raw = String(period || '').trim()
  if (!/^\d{4}-\d{2}$/.test(raw)) throw new Error('period must be YYYY-MM')
  const offset = SCENARIO_DAY_OFFSETS[scenarioId]
  if (!offset) throw new Error(`unknown scenario day offset: ${scenarioId}`)
  const dayOfMonth = ((offset - 1) % 28) + 1
  return `${raw}-${String(dayOfMonth).padStart(2, '0')}`
}

export function scenarioToken(scenarioId) {
  return String(scenarioId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function scenarioName(scenarioId, suffix = '') {
  const tail = suffix ? `_${scenarioToken(suffix)}` : ''
  return `${RATING_SCENARIO_NAME_PREFIX}_${scenarioToken(scenarioId)}${tail}`
}

export function scenarioExternalRef(scenarioId, suffix = '') {
  return `${RATING_SCENARIO_NAMESPACE}:${scenarioName(scenarioId, suffix)}`
}

function stableNumericHash(value) {
  let hash = 2166136261
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash % 1000000000
}

export function scenarioIccid(scenarioId, ordinal = 1) {
  const digits = String(stableNumericHash(scenarioId)).padStart(9, '0')
  const ord = String(Math.max(1, Number(ordinal) || 1)).padStart(2, '0')
  return `893107046${digits}${ord}`
}

export function validateScenarioCatalog() {
  const ids = new Set()
  const iccids = new Set()
  const errors = []
  for (const scenario of RATING_SCENARIOS) {
    if (!scenario.id) errors.push('scenario missing id')
    if (ids.has(scenario.id)) errors.push(`duplicate scenario id: ${scenario.id}`)
    ids.add(scenario.id)
    if (!scenario.group) errors.push(`${scenario.id}: missing group`)
    if (!SCENARIO_DAY_OFFSETS[scenario.id]) errors.push(`${scenario.id}: missing day offset`)
    const iccid = scenarioIccid(scenario.id)
    if (!/^\d{20}$/.test(iccid)) errors.push(`${scenario.id}: invalid generated ICCID ${iccid}`)
    if (iccids.has(iccid)) errors.push(`${scenario.id}: duplicate generated ICCID ${iccid}`)
    iccids.add(iccid)
  }
  for (const id of Object.keys(SCENARIO_DAY_OFFSETS)) {
    if (!ids.has(id)) errors.push(`${id}: day offset without scenario`)
  }
  return { ok: errors.length === 0, errors, count: RATING_SCENARIOS.length }
}

const validation = validateScenarioCatalog()
if (!validation.ok) {
  throw new Error(`Invalid rating scenario catalog:\n${validation.errors.join('\n')}`)
}
