import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import {
  DEFAULT_RATING_SCENARIO_SCOPE,
  PRICE_PLAN_TYPES,
  RATING_SCENARIOS,
  SCENARIO_GROUPS,
  SUBSCRIPTION_STATES,
  SUBSCRIPTION_TYPES,
  USAGE_CLASSES,
  scenarioById,
  scenarioDay,
  scenarioExternalRef,
  scenarioIccid,
  scenarioName,
  scenariosByGroup,
  validateScenarioCatalog,
} from './rating_scenario_catalog.js'

const SOURCE_DOCUMENT = 'specs/20260208-iot-cmp-reseller/rating-scenario-catalog.md'

const PRICE_PLAN_DB_TYPE = Object.freeze({
  [PRICE_PLAN_TYPES.oneTime]: 'ONE_TIME',
  [PRICE_PLAN_TYPES.fixedBundle]: 'FIXED_BUNDLE',
  [PRICE_PLAN_TYPES.simDependentBundle]: 'SIM_DEPENDENT_BUNDLE',
  [PRICE_PLAN_TYPES.tieredPricing]: 'TIERED_VOLUME_PRICING',
})

const USAGE_BUCKET_EXPECTATIONS = Object.freeze({
  [USAGE_CLASSES.inProfile]: {
    bucket: 'inProfile',
    ratingClassifications: ['IN_PACKAGE', 'OVERAGE', 'TIERED_VOLUME'],
    metrics: { inProfileMb: '>0', outOfProfileMb: 0, unclassifiedMb: 0 },
  },
  [USAGE_CLASSES.outOfProfile]: {
    bucket: 'outOfProfile',
    ratingClassifications: ['OOP_ROAMING'],
    metrics: { inProfileMb: 0, outOfProfileMb: '>0', unclassifiedMb: 0 },
  },
  [USAGE_CLASSES.unclassified]: {
    bucket: 'unclassified',
    ratingClassifications: ['UNCLASSIFIED'],
    metrics: { inProfileMb: 0, outOfProfileMb: 0, unclassifiedMb: '>0' },
  },
  ZERO_USAGE: {
    bucket: 'zero',
    ratingClassifications: [],
    metrics: { inProfileMb: 0, outOfProfileMb: 0, unclassifiedMb: 0 },
  },
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

function currentPeriodUtc() {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function parsePeriod(value) {
  const period = String(value || currentPeriodUtc()).trim()
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('--period must be YYYY-MM')
  return period
}

function selectScenarios({ scenarioId, group }) {
  if (scenarioId && group) throw new Error('Use either --scenario or --group, not both.')
  if (scenarioId) {
    const scenario = scenarioById(scenarioId)
    if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`)
    return [scenario]
  }
  if (group) {
    if (!Object.values(SCENARIO_GROUPS).includes(group)) throw new Error(`Unknown group: ${group}`)
    return scenariosByGroup(group)
  }
  return RATING_SCENARIOS
}

function usageExpectation(scenario) {
  if (scenario.capacityOverflow) {
    return {
      usageClass: scenario.usageClass,
      bucket: 'capacityOverflow',
      ratingClassifications: ['IN_PACKAGE', 'OVERAGE', 'TIERED_VOLUME', 'OOP_ROAMING', 'UNCLASSIFIED'],
      metrics: { inProfileMb: '>0', outOfProfileMb: '>=0', unclassifiedMb: '>=0' },
    }
  }
  const usageClass = String(scenario.usageClass || USAGE_CLASSES.unclassified).toUpperCase()
  const spec = USAGE_BUCKET_EXPECTATIONS[usageClass]
  if (spec) return { usageClass, ...spec }
  return {
    usageClass,
    bucket: 'unknown',
    ratingClassifications: [],
    metrics: { inProfileMb: 'unknown', outOfProfileMb: 'unknown', unclassifiedMb: 'unknown' },
    issue: `Unknown usage class: ${usageClass}`,
  }
}

function expectedSubscriptionKind(scenario) {
  const expected = scenario.expectedSubscriptionType ?? scenario.subscriptionType ?? null
  if (expected === SUBSCRIPTION_TYPES.main || expected === SUBSCRIPTION_TYPES.addOn) return expected
  return null
}

function isActiveSubscriptionScenario(scenario) {
  return scenario.subscriptionState === SUBSCRIPTION_STATES.active
    || (scenario.subscriptionState == null && scenario.subscriptionType)
}

function attributionExpectation(scenario) {
  if (scenario.capacityOverflow) {
    return {
      mode: 'capacityOverflow',
      matchedSubscription: 'split-by-capacity',
      matchedPackage: 'subscription-main-or-fallback',
      matchedPricePlan: 'split-by-capacity',
      packageSummaryExpected: true,
    }
  }
  const subscriptionKind = expectedSubscriptionKind(scenario)
  if (scenario.fallback === true) {
    return {
      mode: 'fallbackPackage',
      matchedSubscription: 'null',
      matchedPackage: 'fallbackPackage',
      matchedPricePlan: 'fallbackPackagePricePlan',
      packageSummaryExpected: true,
    }
  }
  if (scenario.id === 'R-FB-003') {
    return {
      mode: 'noFallbackMapping',
      matchedSubscription: 'null',
      matchedPackage: 'null',
      matchedPricePlan: 'null',
      packageSummaryExpected: false,
    }
  }
  if (!scenario.subscriptionType) {
    return {
      mode: 'noSubscription',
      matchedSubscription: 'null',
      matchedPackage: 'none-or-fallback-if-configured',
      matchedPricePlan: 'none-or-fallback-if-configured',
      packageSummaryExpected: 'policy-dependent',
    }
  }
  if (!isActiveSubscriptionScenario(scenario)) {
    return {
      mode: 'nonActiveSubscriptionIgnored',
      matchedSubscription: 'null',
      ignoredSubscriptionState: scenario.subscriptionState,
      matchedPackage: 'none-or-fallback-if-configured',
      matchedPricePlan: 'none-or-fallback-if-configured',
      packageSummaryExpected: 'policy-dependent',
    }
  }
  return {
    mode: 'subscribedPackage',
    matchedSubscription: subscriptionKind ? { kind: subscriptionKind } : 'activeSubscription',
    matchedPackage: 'subscriptionPackage',
    matchedPricePlan: scenario.pricePlanType ? PRICE_PLAN_DB_TYPE[scenario.pricePlanType] : 'subscriptionPackagePricePlan',
    packageSummaryExpected: true,
  }
}

function buildExpectation(scenario, period) {
  const attribution = attributionExpectation(scenario)
  const usage = attribution.mode === 'nonActiveSubscriptionIgnored'
    ? usageExpectation({ ...scenario, usageClass: USAGE_CLASSES.unclassified })
    : usageExpectation(scenario)
  const usageDay = scenarioDay(period, scenario.id)
  const zeroUsage = usage.usageClass === 'ZERO_USAGE'
  return {
    scenarioId: scenario.id,
    group: scenario.group,
    sourceDocument: SOURCE_DOCUMENT,
    period,
    usageDay,
    identity: {
      iccid: scenarioIccid(scenario.id),
      simExternalRef: scenarioExternalRef(scenario.id, 'SIM'),
      subscriptionExternalRef: scenarioExternalRef(scenario.id, 'SUBSCRIPTION'),
      usageExternalRef: scenarioExternalRef(scenario.id, 'USAGE'),
      baseName: scenarioName(scenario.id),
    },
    inputs: {
      scope: DEFAULT_RATING_SCENARIO_SCOPE,
      pricePlanType: scenario.pricePlanType ?? null,
      pricePlanDbType: scenario.pricePlanType ? PRICE_PLAN_DB_TYPE[scenario.pricePlanType] : null,
      subscriptionType: scenario.subscriptionType ?? null,
      expectedSubscriptionType: expectedSubscriptionKind(scenario),
      subscriptionState: scenario.subscriptionState ?? null,
      simStatus: scenario.simStatus ?? null,
      usageClass: usage.usageClass,
      networkMatch: scenario.networkMatch ?? null,
      fallback: Boolean(scenario.fallback),
      totalMb: Number.isFinite(Number(scenario.totalMb)) ? Number(scenario.totalMb) : null,
      poolRole: scenario.poolRole ?? null,
      capacityOverflow: scenario.capacityOverflow ?? null,
    },
    expects: {
      ratingResults: {
        required: zeroUsage ? 'optional-zero-or-none' : true,
        calculationIdPrefix: `USAGE_ROLLUP:${period}:`,
        rowSelector: {
          iccid: scenarioIccid(scenario.id),
          usageDay,
        },
        classification: {
          bucket: usage.bucket,
          allowedValues: usage.ratingClassifications,
        },
        chargedMb: zeroUsage ? 0 : '>0',
        amount: 'policy-dependent',
        currency: 'present-if-amount-or-plan-currency',
        attribution,
      },
      usageDailySummary: {
        inputRef: scenarioExternalRef(scenario.id, 'USAGE'),
        metrics: usage.metrics,
        simDayTotals: {
          uplinkMb: zeroUsage ? 0 : '>=0',
          downlinkMb: zeroUsage ? 0 : '>=0',
          totalMb: zeroUsage ? 0 : '>0',
        },
      },
      usagePackageDailySummary: {
        expected: zeroUsage ? 'optional-zero-or-none' : attribution.packageSummaryExpected,
        pricePlanType: attribution.mode === 'subscribedPackage' && scenario.pricePlanType
          ? PRICE_PLAN_DB_TYPE[scenario.pricePlanType]
          : 'derived-from-rated-package',
        metrics: usage.metrics,
        simDayTotalsCopiedFromUsageDailySummary: true,
      },
    },
    notes: usage.issue ? [usage.issue] : [],
  }
}

function validateExpectation(expectation) {
  const issues = []
  if (!expectation.scenarioId) issues.push('missing scenarioId')
  if (!expectation.group) issues.push('missing group')
  if (!expectation.period) issues.push('missing period')
  if (!expectation.usageDay) issues.push('missing usageDay')
  if (!/^\d{20}$/.test(expectation.identity.iccid)) issues.push(`invalid iccid: ${expectation.identity.iccid}`)
  if (expectation.expects.ratingResults.classification.bucket === 'unknown') {
    issues.push(`unknown usage expectation for ${expectation.inputs.usageClass}`)
  }
  if (expectation.expects.ratingResults.attribution.mode === 'subscribedPackage'
    && !expectation.expects.ratingResults.attribution.matchedSubscription) {
    issues.push('subscribedPackage expectation missing matchedSubscription')
  }
  return {
    scenarioId: expectation.scenarioId,
    ok: issues.length === 0,
    issues,
  }
}

function summarize(results) {
  return results.reduce(
    (acc, row) => {
      acc.total += 1
      if (row.ok) acc.pass += 1
      else acc.fail += 1
      return acc
    },
    { total: 0, pass: 0, fail: 0 }
  )
}

function summarizeAssertions(assertions) {
  return Object.fromEntries(
    Object.entries(assertions).map(([name, assertion]) => [name, assertion.summary])
  )
}

function totalAssertionFailures(assertions) {
  return Object.values(assertions).reduce((sum, assertion) => sum + Number(assertion.summary?.fail ?? 0), 0)
}

async function selectAll(supabase, table, query, options) {
  const rows = await supabase.select(table, query, options)
  return Array.isArray(rows) ? rows : []
}

function n(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))
}

function usageDay(value) {
  const raw = String(value ?? '').trim()
  return raw.length >= 10 ? raw.slice(0, 10) : raw
}

function compareExpectedMetric(actual, expected, label, tolerance = 0.01) {
  const value = n(actual)
  if (expected === '>0') {
    return value > 0 ? null : `${label} must be >0, got ${actual ?? 'null'}`
  }
  if (expected === '>=0') {
    return value >= 0 ? null : `${label} must be >=0, got ${actual ?? 'null'}`
  }
  if (expected === 'unknown') return null
  const expectedNumber = Number(expected)
  if (Number.isFinite(expectedNumber) && Math.abs(value - expectedNumber) <= tolerance) return null
  return `${label} must be ${expected}, got ${actual ?? 'null'}`
}

function parseThreshold(name, fallback) {
  const raw = arg(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`)
  return value
}

function planTypeOf(plan) {
  const raw = String(plan?.type ?? plan?.price_plan_type ?? '').trim().toUpperCase()
  return raw === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : raw
}

function quotaMbForPlan(plan, activeSimCount) {
  const type = planTypeOf(plan)
  if (type === 'ONE_TIME') {
    const quota = Number(plan?.quota_mb)
    return Number.isFinite(quota) && quota > 0 ? quota : null
  }
  if (type === 'SIM_DEPENDENT_BUNDLE') {
    const perSim = Number(plan?.per_sim_quota_mb)
    return Number.isFinite(perSim) && perSim > 0 ? perSim * Math.max(1, Number(activeSimCount) || 0) : null
  }
  if (type === 'FIXED_BUNDLE') {
    const quota = Number(plan?.total_quota_mb)
    return Number.isFinite(quota) && quota > 0 ? quota : null
  }
  return null
}

function parseTierList(tiers) {
  if (Array.isArray(tiers)) return tiers
  if (typeof tiers === 'string' && tiers.trim()) {
    try {
      const parsed = JSON.parse(tiers)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function tierLimitMb(tier) {
  for (const value of [tier?.toMb, tier?.maxMb, tier?.upperBoundMb, tier?.thresholdMb, tier?.quotaMb, tier?.to, tier?.max, tier?.upperBound]) {
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return null
}

async function loadRatingRowsForExpectation(supabase, expectation) {
  const selector = expectation.expects.ratingResults.rowSelector
  return selectAll(
    supabase,
    'rating_results',
    [
      'select=rating_result_id,calculation_id,enterprise_id,sim_id,iccid,usage_day,visited_mccmnc,input_ref,matched_subscription_id,matched_package_id,matched_price_plan_id,classification,charged_mb,amount,currency',
      `iccid=eq.${encodeURIComponent(selector.iccid)}`,
      `usage_day=eq.${encodeURIComponent(selector.usageDay)}`,
      `enterprise_id=eq.${encodeURIComponent(expectation.inputs.scope.enterpriseId)}`,
      'order=created_at.desc',
      'limit=50',
    ].join('&')
  )
}

async function loadSubscriptionById(supabase, subscriptionId) {
  if (!isUuid(subscriptionId)) return null
  const rows = await selectAll(
    supabase,
    'subscriptions',
    `select=subscription_id,subscription_kind,state,package_id&subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`
  )
  return rows[0] ?? null
}

async function loadPricePlanById(supabase, pricePlanId) {
  if (!isUuid(pricePlanId)) return null
  const rows = await selectAll(
    supabase,
    'price_plans',
    `select=price_plan_id,type,currency&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  return rows[0] ?? null
}

function chooseComparedRatingRows(rows, expectation) {
  const prefix = expectation.expects.ratingResults.calculationIdPrefix
  const prefixed = rows.filter((row) => String(row?.calculation_id || '').startsWith(prefix))
  return prefixed.length ? prefixed : rows
}

async function assertOneRatingRow(supabase, expectation, row) {
  const issues = []
  const expected = expectation.expects.ratingResults
  const attribution = expected.attribution
  const classification = String(row?.classification || '').toUpperCase()
  const allowed = expected.classification.allowedValues

  if (!String(row?.calculation_id || '').startsWith(expected.calculationIdPrefix)) {
    issues.push(`calculation_id must start with ${expected.calculationIdPrefix}, got ${row?.calculation_id ?? 'null'}`)
  }
  if (allowed.length && !allowed.includes(classification)) {
    issues.push(`classification ${classification || 'null'} not in [${allowed.join(', ')}]`)
  }
  if (expected.chargedMb === '>0' && n(row?.charged_mb) <= 0) {
    issues.push(`charged_mb must be >0, got ${row?.charged_mb ?? 'null'}`)
  }
  if (expected.chargedMb === 0 && n(row?.charged_mb) !== 0) {
    issues.push(`charged_mb must be 0, got ${row?.charged_mb ?? 'null'}`)
  }
  if (!Number.isFinite(Number(row?.amount))) {
    issues.push(`amount must be numeric, got ${row?.amount ?? 'null'}`)
  } else if (n(row?.amount) < 0) {
    issues.push(`amount must be non-negative, got ${row?.amount}`)
  }
  if (!row?.currency) {
    issues.push('currency must be present on rating_results row')
  }

  if (attribution.mode === 'fallbackPackage') {
    if (row?.matched_subscription_id !== null && row?.matched_subscription_id !== undefined) {
      issues.push(`fallback rating must have matched_subscription_id null, got ${row.matched_subscription_id}`)
    }
    if (!row?.matched_package_id) issues.push('fallback rating must have matched_package_id')
    if (!row?.matched_price_plan_id) issues.push('fallback rating must have matched_price_plan_id')
  } else if (attribution.mode === 'noFallbackMapping') {
    if (row?.matched_subscription_id !== null && row?.matched_subscription_id !== undefined) {
      issues.push(`noFallbackMapping must have matched_subscription_id null, got ${row.matched_subscription_id}`)
    }
    if (row?.matched_package_id !== null && row?.matched_package_id !== undefined) {
      issues.push(`noFallbackMapping must have matched_package_id null, got ${row.matched_package_id}`)
    }
    if (row?.matched_price_plan_id !== null && row?.matched_price_plan_id !== undefined) {
      issues.push(`noFallbackMapping must have matched_price_plan_id null, got ${row.matched_price_plan_id}`)
    }
  } else if (attribution.mode === 'nonActiveSubscriptionIgnored') {
    if (row?.matched_subscription_id !== null && row?.matched_subscription_id !== undefined) {
      issues.push(`non-active subscription must be ignored; matched_subscription_id=${row.matched_subscription_id}`)
    }
  } else if (attribution.mode === 'subscribedPackage') {
    if (!row?.matched_subscription_id) issues.push('subscribedPackage must have matched_subscription_id')
    if (!row?.matched_package_id) issues.push('subscribedPackage must have matched_package_id')
    if (!row?.matched_price_plan_id) issues.push('subscribedPackage must have matched_price_plan_id')
    if (row?.matched_subscription_id && attribution.matchedSubscription?.kind) {
      const sub = await loadSubscriptionById(supabase, row.matched_subscription_id)
      if (!sub) {
        issues.push(`matched subscription not found: ${row.matched_subscription_id}`)
      } else if (String(sub.subscription_kind || '').toUpperCase() !== attribution.matchedSubscription.kind) {
        issues.push(`matched subscription kind must be ${attribution.matchedSubscription.kind}, got ${sub.subscription_kind}`)
      }
    }
  } else if (attribution.mode === 'capacityOverflow') {
    if (!row?.matched_package_id && classification !== 'UNCLASSIFIED') {
      issues.push('capacityOverflow rated rows should keep package attribution unless unclassified without fallback mapping')
    }
  }

  if (expectation.inputs.pricePlanDbType && row?.matched_price_plan_id && attribution.mode !== 'capacityOverflow') {
    const plan = await loadPricePlanById(supabase, row.matched_price_plan_id)
    if (!plan) {
      issues.push(`matched price plan not found: ${row.matched_price_plan_id}`)
    } else if (String(plan.type || '').toUpperCase() !== expectation.inputs.pricePlanDbType) {
      issues.push(`matched price plan type must be ${expectation.inputs.pricePlanDbType}, got ${plan.type}`)
    }
  }

  return issues
}

async function assertRatingResultsForExpectation(supabase, expectation) {
  const rows = await loadRatingRowsForExpectation(supabase, expectation)
  const comparedRows = chooseComparedRatingRows(rows, expectation)
  const required = expectation.expects.ratingResults.required
  const issues = []

  if (!comparedRows.length) {
    if (required === 'optional-zero-or-none') {
      return {
        scenarioId: expectation.scenarioId,
        ok: true,
        scope: 'rating_results',
        rowCount: 0,
        comparedRowCount: 0,
        issues,
      }
    }
    issues.push(`rating_results row missing for iccid=${expectation.identity.iccid} usage_day=${expectation.usageDay}`)
    return {
      scenarioId: expectation.scenarioId,
      ok: false,
      scope: 'rating_results',
      rowCount: rows.length,
      comparedRowCount: 0,
      issues,
    }
  }

  for (const row of comparedRows) {
    const rowIssues = await assertOneRatingRow(supabase, expectation, row)
    issues.push(...rowIssues.map((issue) => `${row.rating_result_id ?? row.calculation_id ?? 'rating_row'}: ${issue}`))
  }

  return {
    scenarioId: expectation.scenarioId,
    ok: issues.length === 0,
    scope: 'rating_results',
    rowCount: rows.length,
    comparedRowCount: comparedRows.length,
    sample: comparedRows.slice(0, 3).map((row) => ({
      ratingResultId: row.rating_result_id ?? null,
      calculationId: row.calculation_id ?? null,
      iccid: row.iccid ?? null,
      usageDay: usageDay(row.usage_day),
      classification: row.classification ?? null,
      chargedMb: n(row.charged_mb),
      amount: n(row.amount),
      currency: row.currency ?? null,
      matchedSubscriptionId: row.matched_subscription_id ?? null,
      matchedPackageId: row.matched_package_id ?? null,
      matchedPricePlanId: row.matched_price_plan_id ?? null,
    })),
    issues,
  }
}

async function runRatingResultsAssertions(expectations) {
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const results = []
  for (const expectation of expectations) {
    results.push(await assertRatingResultsForExpectation(supabase, expectation))
  }
  return results
}

async function loadUsageDailyRowsForExpectation(supabase, expectation) {
  return selectAll(
    supabase,
    'usage_daily_summary',
    [
      'select=usage_id,supplier_id,enterprise_id,sim_id,iccid,usage_day,visited_mccmnc,input_ref,total_mb,in_profile_mb,out_of_profile_mb,unclassified_mb,uplink_mb,downlink_mb,rated_at',
      `iccid=eq.${encodeURIComponent(expectation.identity.iccid)}`,
      `usage_day=eq.${encodeURIComponent(expectation.usageDay)}`,
      `enterprise_id=eq.${encodeURIComponent(expectation.inputs.scope.enterpriseId)}`,
      `input_ref=eq.${encodeURIComponent(expectation.expects.usageDailySummary.inputRef)}`,
      'limit=10',
    ].join('&')
  )
}

function assertUsageDailyRow(expectation, row) {
  const issues = []
  const expected = expectation.expects.usageDailySummary
  const metrics = expected.metrics
  const totalMb = n(row?.total_mb)
  const metricChecks = [
    ['in_profile_mb', row?.in_profile_mb, metrics.inProfileMb],
    ['out_of_profile_mb', row?.out_of_profile_mb, metrics.outOfProfileMb],
    ['unclassified_mb', row?.unclassified_mb, metrics.unclassifiedMb],
  ]
  for (const [label, actual, wanted] of metricChecks) {
    const issue = compareExpectedMetric(actual, wanted, label)
    if (issue) issues.push(issue)
  }

  const classifiedMb = n(row?.in_profile_mb) + n(row?.out_of_profile_mb) + n(row?.unclassified_mb)
  if (classifiedMb - totalMb > 0.01) {
    issues.push(`classified MB ${classifiedMb} must not exceed total_mb ${totalMb}`)
  }
  if (expected.simDayTotals.totalMb === '>0' && totalMb <= 0) {
    issues.push(`total_mb must be >0, got ${row?.total_mb ?? 'null'}`)
  }
  if (expected.simDayTotals.totalMb === 0 && totalMb !== 0) {
    issues.push(`total_mb must be 0, got ${row?.total_mb ?? 'null'}`)
  }

  const ratedAtRequired = expectation.expects.ratingResults.required !== 'optional-zero-or-none'
  if (ratedAtRequired && !row?.rated_at) {
    issues.push('rated_at must be present after rating rollup')
  }
  if (!ratedAtRequired && row?.rated_at && totalMb === 0 && classifiedMb !== 0) {
    issues.push('zero usage row with rated_at must still have zero classified MB')
  }

  return issues
}

async function assertUsageDailyForExpectation(supabase, expectation) {
  const rows = await loadUsageDailyRowsForExpectation(supabase, expectation)
  const issues = []
  if (!rows.length) {
    issues.push(`usage_daily_summary row missing for input_ref=${expectation.expects.usageDailySummary.inputRef}`)
    return {
      scenarioId: expectation.scenarioId,
      ok: false,
      scope: 'usage_daily_summary',
      rowCount: 0,
      issues,
    }
  }
  if (rows.length > 1) {
    issues.push(`expected one usage_daily_summary row, found ${rows.length}`)
  }
  const row = rows[0]
  issues.push(...assertUsageDailyRow(expectation, row))
  return {
    scenarioId: expectation.scenarioId,
    ok: issues.length === 0,
    scope: 'usage_daily_summary',
    rowCount: rows.length,
    sample: {
      usageId: row?.usage_id ?? null,
      iccid: row?.iccid ?? null,
      usageDay: usageDay(row?.usage_day),
      inputRef: row?.input_ref ?? null,
      totalMb: n(row?.total_mb),
      inProfileMb: n(row?.in_profile_mb),
      outOfProfileMb: n(row?.out_of_profile_mb),
      unclassifiedMb: n(row?.unclassified_mb),
      ratedAt: row?.rated_at ?? null,
    },
    issues,
  }
}

async function runUsageDailyAssertions(expectations) {
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const results = []
  for (const expectation of expectations) {
    results.push(await assertUsageDailyForExpectation(supabase, expectation))
  }
  return results
}

async function loadPackageSummaryRowsForExpectation(supabase, expectation) {
  return selectAll(
    supabase,
    'usage_package_daily_summary',
    [
      'select=usage_package_summary_id,supplier_id,reseller_id,enterprise_id,sim_id,iccid,usage_day,visited_mccmnc,subscription_id,package_id,price_plan_id,price_plan_type,in_profile_mb,out_of_profile_mb,unclassified_mb,uplink_mb,downlink_mb,total_mb,amount,currency,calculation_id,rated_at',
      `iccid=eq.${encodeURIComponent(expectation.identity.iccid)}`,
      `usage_day=eq.${encodeURIComponent(expectation.usageDay)}`,
      `enterprise_id=eq.${encodeURIComponent(expectation.inputs.scope.enterpriseId)}`,
      'order=visited_mccmnc.asc',
      'limit=50',
    ].join('&')
  )
}

function packageSummaryGrainKey(row) {
  return [
    row?.sim_id ?? '',
    usageDay(row?.usage_day),
    row?.subscription_id ?? '',
    row?.package_id ?? '',
    row?.price_plan_id ?? '',
    row?.visited_mccmnc ?? '',
  ].map((value) => String(value)).join('|')
}

function assertPackageSummaryRow(expectation, row, usageDailyRow) {
  const issues = []
  const expected = expectation.expects.usagePackageDailySummary
  const attribution = expectation.expects.ratingResults.attribution

  if (!String(row?.calculation_id || '').startsWith(expectation.expects.ratingResults.calculationIdPrefix)) {
    issues.push(`calculation_id must start with ${expectation.expects.ratingResults.calculationIdPrefix}, got ${row?.calculation_id ?? 'null'}`)
  }
  if (!row?.rated_at) issues.push('rated_at must be present')
  if (!Number.isFinite(Number(row?.amount))) {
    issues.push(`amount must be numeric, got ${row?.amount ?? 'null'}`)
  } else if (n(row?.amount) < 0) {
    issues.push(`amount must be non-negative, got ${row.amount}`)
  }
  if (!row?.currency) issues.push('currency must be present')

  if (expected.pricePlanType !== 'derived-from-rated-package' && expected.pricePlanType !== 'subscriptionPackagePricePlan') {
    if (String(row?.price_plan_type || '').toUpperCase() !== expected.pricePlanType) {
      issues.push(`price_plan_type must be ${expected.pricePlanType}, got ${row?.price_plan_type ?? 'null'}`)
    }
  }

  if (attribution.mode === 'fallbackPackage') {
    if (row?.subscription_id !== null && row?.subscription_id !== undefined) {
      issues.push(`fallback summary must have subscription_id null, got ${row.subscription_id}`)
    }
    if (!row?.package_id) issues.push('fallback summary must have package_id')
    if (!row?.price_plan_id) issues.push('fallback summary must have price_plan_id')
  } else if (attribution.mode === 'subscribedPackage') {
    if (!row?.subscription_id) issues.push('subscribed summary must have subscription_id')
    if (!row?.package_id) issues.push('subscribed summary must have package_id')
    if (!row?.price_plan_id) issues.push('subscribed summary must have price_plan_id')
  } else if (attribution.mode === 'noFallbackMapping') {
    issues.push(`noFallbackMapping should not produce package summary row ${row?.usage_package_summary_id ?? ''}`)
  }

  if (usageDailyRow) {
    const totalChecks = [
      ['uplink_mb', row?.uplink_mb, usageDailyRow.uplink_mb],
      ['downlink_mb', row?.downlink_mb, usageDailyRow.downlink_mb],
      ['total_mb', row?.total_mb, usageDailyRow.total_mb],
    ]
    for (const [label, actual, wanted] of totalChecks) {
      const expectedNumber = n(wanted)
      if (Math.abs(n(actual) - expectedNumber) > 0.01) {
        issues.push(`${label} must equal SIM-day usage_daily_summary value ${expectedNumber}, got ${actual ?? 'null'}`)
      }
    }
  }

  return issues
}

function aggregatePackageSummaryMetrics(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.inProfileMb += n(row?.in_profile_mb)
      acc.outOfProfileMb += n(row?.out_of_profile_mb)
      acc.unclassifiedMb += n(row?.unclassified_mb)
      acc.amount += n(row?.amount)
      return acc
    },
    { inProfileMb: 0, outOfProfileMb: 0, unclassifiedMb: 0, amount: 0 }
  )
}

async function assertPackageSummaryForExpectation(supabase, expectation) {
  const rows = await loadPackageSummaryRowsForExpectation(supabase, expectation)
  const usageDailyRows = await loadUsageDailyRowsForExpectation(supabase, expectation)
  const usageDailyRow = usageDailyRows[0] ?? null
  const expected = expectation.expects.usagePackageDailySummary
  const issues = []

  if (!rows.length) {
    if (expected.expected === false || expected.expected === 'optional-zero-or-none' || expected.expected === 'policy-dependent') {
      return {
        scenarioId: expectation.scenarioId,
        ok: true,
        scope: 'usage_package_daily_summary',
        rowCount: 0,
        issues,
      }
    }
    issues.push(`usage_package_daily_summary row missing for iccid=${expectation.identity.iccid} usage_day=${expectation.usageDay}`)
    return {
      scenarioId: expectation.scenarioId,
      ok: false,
      scope: 'usage_package_daily_summary',
      rowCount: 0,
      issues,
    }
  }

  if (expected.expected === false) {
    issues.push(`expected no package summary rows, found ${rows.length}`)
  }

  const seen = new Set()
  for (const row of rows) {
    const key = packageSummaryGrainKey(row)
    if (seen.has(key)) issues.push(`duplicate package summary grain ${key}`)
    seen.add(key)
    issues.push(...assertPackageSummaryRow(expectation, row, usageDailyRow).map((issue) => `${row.usage_package_summary_id ?? key}: ${issue}`))
  }

  const totals = aggregatePackageSummaryMetrics(rows)
  const metricChecks = [
    ['in_profile_mb total', totals.inProfileMb, expected.metrics.inProfileMb],
    ['out_of_profile_mb total', totals.outOfProfileMb, expected.metrics.outOfProfileMb],
    ['unclassified_mb total', totals.unclassifiedMb, expected.metrics.unclassifiedMb],
  ]
  for (const [label, actual, wanted] of metricChecks) {
    const issue = compareExpectedMetric(actual, wanted, label)
    if (issue) issues.push(issue)
  }

  return {
    scenarioId: expectation.scenarioId,
    ok: issues.length === 0,
    scope: 'usage_package_daily_summary',
    rowCount: rows.length,
    sample: rows.slice(0, 3).map((row) => ({
      usagePackageSummaryId: row.usage_package_summary_id ?? null,
      iccid: row.iccid ?? null,
      usageDay: usageDay(row.usage_day),
      visitedMccMnc: row.visited_mccmnc ?? null,
      subscriptionId: row.subscription_id ?? null,
      packageId: row.package_id ?? null,
      pricePlanId: row.price_plan_id ?? null,
      pricePlanType: row.price_plan_type ?? null,
      inProfileMb: n(row.in_profile_mb),
      outOfProfileMb: n(row.out_of_profile_mb),
      unclassifiedMb: n(row.unclassified_mb),
      uplinkMb: n(row.uplink_mb),
      downlinkMb: n(row.downlink_mb),
      totalMb: n(row.total_mb),
      amount: n(row.amount),
      currency: row.currency ?? null,
      calculationId: row.calculation_id ?? null,
      ratedAt: row.rated_at ?? null,
    })),
    totals,
    issues,
  }
}

async function runPackageSummaryAssertions(expectations) {
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const results = []
  for (const expectation of expectations) {
    results.push(await assertPackageSummaryForExpectation(supabase, expectation))
  }
  return results
}

async function loadPricePlansForPackageSummaryRows(supabase, rows) {
  const ids = Array.from(new Set(rows.map((row) => row?.price_plan_id).filter(Boolean).map(String)))
  if (!ids.length) return new Map()
  const planRows = await selectAll(
    supabase,
    'price_plans_expanded',
    `select=price_plan_id,enterprise_id,type,price_plan_type,quota_mb,per_sim_quota_mb,total_quota_mb,tiers&price_plan_id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`
  )
  return new Map(planRows.map((row) => [String(row.price_plan_id), row]))
}

function buildAlertCandidatesFromRows(rows, pricePlans, { poolThresholdPercent, outProfileThresholdPercent }) {
  const packageInProfile = new Map()
  const packageOutProfile = new Map()
  const packageSimInProfile = new Map()
  const packageSimOutProfile = new Map()
  const packageEnterprise = new Map()
  const packagePlanId = new Map()
  const packageSimCounts = new Map()

  for (const row of rows) {
    const packageId = row?.package_id ? String(row.package_id) : null
    if (!packageId) continue
    const simId = row?.sim_id ? String(row.sim_id) : null
    if (row?.enterprise_id && !packageEnterprise.has(packageId)) packageEnterprise.set(packageId, String(row.enterprise_id))
    if (row?.price_plan_id && !packagePlanId.has(packageId)) packagePlanId.set(packageId, String(row.price_plan_id))
    if (simId) {
      if (!packageSimCounts.has(packageId)) packageSimCounts.set(packageId, new Set())
      packageSimCounts.get(packageId).add(simId)
    }
    const inProfileMb = n(row?.in_profile_mb)
    const outProfileMb = n(row?.out_of_profile_mb)
    if (inProfileMb > 0) {
      packageInProfile.set(packageId, n(packageInProfile.get(packageId)) + inProfileMb)
      if (simId) {
        if (!packageSimInProfile.has(packageId)) packageSimInProfile.set(packageId, new Map())
        const simMap = packageSimInProfile.get(packageId)
        simMap.set(simId, n(simMap.get(simId)) + inProfileMb)
      }
    }
    if (outProfileMb > 0) {
      packageOutProfile.set(packageId, n(packageOutProfile.get(packageId)) + outProfileMb)
      if (simId) {
        if (!packageSimOutProfile.has(packageId)) packageSimOutProfile.set(packageId, new Map())
        const simMap = packageSimOutProfile.get(packageId)
        simMap.set(simId, n(simMap.get(simId)) + outProfileMb)
      }
    }
  }

  const candidates = {
    poolUsageHigh: [],
    outOfProfileSurge: [],
  }
  const buildForUsage = (usageMap, simUsageMap, thresholdPercent, alertType) => {
    for (const [packageId, planId] of packagePlanId.entries()) {
      const plan = pricePlans.get(planId)
      const planType = planTypeOf(plan)
      if (!planType) continue
      const activeSimCount = packageSimCounts.get(packageId)?.size ?? 0
      if (planType === 'ONE_TIME') {
        const quotaMb = quotaMbForPlan(plan, 1)
        if (!quotaMb) continue
        const perSim = simUsageMap.get(packageId) ?? new Map()
        for (const [simId, usedMb] of perSim.entries()) {
          const usageRatio = quotaMb > 0 ? (n(usedMb) / quotaMb) * 100 : 0
          if (usageRatio < thresholdPercent) continue
          candidates[alertType].push({
            alertType: alertType === 'poolUsageHigh' ? 'POOL_USAGE_HIGH' : 'OUT_OF_PROFILE_SURGE',
            enterpriseId: packageEnterprise.get(packageId) ?? null,
            packageId,
            pricePlanId: planId,
            pricePlanType: planType,
            simId,
            subjectKey: alertType === 'poolUsageHigh' ? `package:${packageId}:sim:${simId}` : `out:package:${packageId}:sim:${simId}`,
            usedMb: Number(n(usedMb).toFixed(3)),
            quotaMb,
            usageRatio: Number(usageRatio.toFixed(2)),
            thresholdPercent,
            tierIndex: null,
            tierLimitMb: null,
          })
        }
        continue
      }
      const usedMb = n(usageMap.get(packageId))
      if (planType === 'SIM_DEPENDENT_BUNDLE' || planType === 'FIXED_BUNDLE') {
        const quotaMb = quotaMbForPlan(plan, activeSimCount)
        if (!quotaMb) continue
        const usageRatio = quotaMb > 0 ? (usedMb / quotaMb) * 100 : 0
        if (usageRatio < thresholdPercent) continue
        candidates[alertType].push({
          alertType: alertType === 'poolUsageHigh' ? 'POOL_USAGE_HIGH' : 'OUT_OF_PROFILE_SURGE',
          enterpriseId: packageEnterprise.get(packageId) ?? null,
          packageId,
          pricePlanId: planId,
          pricePlanType: planType,
          simId: null,
          subjectKey: alertType === 'poolUsageHigh' ? `package:${packageId}:pool` : `out:package:${packageId}:pool`,
          usedMb: Number(usedMb.toFixed(3)),
          quotaMb,
          usageRatio: Number(usageRatio.toFixed(2)),
          thresholdPercent,
          tierIndex: null,
          tierLimitMb: null,
        })
        continue
      }
      if (planType === 'TIERED_VOLUME_PRICING') {
        const tiers = parseTierList(plan?.tiers)
        tiers.forEach((tier, index) => {
          const limitMb = tierLimitMb(tier)
          if (!limitMb) return
          const usageRatio = (usedMb / limitMb) * 100
          if (usageRatio < thresholdPercent) return
          candidates[alertType].push({
            alertType: alertType === 'poolUsageHigh' ? 'POOL_USAGE_HIGH' : 'OUT_OF_PROFILE_SURGE',
            enterpriseId: packageEnterprise.get(packageId) ?? null,
            packageId,
            pricePlanId: planId,
            pricePlanType: planType,
            simId: null,
            subjectKey: alertType === 'poolUsageHigh' ? `package:${packageId}:tier:${index + 1}` : `out:package:${packageId}:tier:${index + 1}`,
            usedMb: Number(usedMb.toFixed(3)),
            quotaMb: limitMb,
            usageRatio: Number(usageRatio.toFixed(2)),
            thresholdPercent,
            tierIndex: index + 1,
            tierLimitMb: limitMb,
          })
        })
      }
    }
  }

  buildForUsage(packageInProfile, packageSimInProfile, poolThresholdPercent, 'poolUsageHigh')
  buildForUsage(packageOutProfile, packageSimOutProfile, outProfileThresholdPercent, 'outOfProfileSurge')
  return candidates
}

async function runAlertCandidateReport(expectations) {
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const allRows = []
  const missingSummaryScenarios = []
  for (const expectation of expectations) {
    const rows = await loadPackageSummaryRowsForExpectation(supabase, expectation)
    if (!rows.length && expectation.expects.usagePackageDailySummary.expected === true) {
      missingSummaryScenarios.push(expectation.scenarioId)
    }
    allRows.push(...rows)
  }
  const uniqueRows = Array.from(new Map(allRows.map((row) => [row.usage_package_summary_id ?? packageSummaryGrainKey(row), row])).values())
  const pricePlans = await loadPricePlansForPackageSummaryRows(supabase, uniqueRows)
  const thresholds = {
    poolUsageHighPercent: parseThreshold('pool-threshold-percent', 80),
    outOfProfileSurgePercent: parseThreshold('out-profile-threshold-percent', 20),
  }
  const candidates = buildAlertCandidatesFromRows(uniqueRows, pricePlans, {
    poolThresholdPercent: thresholds.poolUsageHighPercent,
    outProfileThresholdPercent: thresholds.outOfProfileSurgePercent,
  })
  return {
    ok: true,
    scope: 'alert_candidates',
    thresholds,
    sourceRows: uniqueRows.length,
    missingSummaryScenarios,
    counts: {
      poolUsageHigh: candidates.poolUsageHigh.length,
      outOfProfileSurge: candidates.outOfProfileSurge.length,
    },
    candidates,
    note: 'Candidate report only; no alerts are created or updated.',
  }
}

function printHelp() {
  console.log(`Usage:
  node tools/verify_rating_scenarios.js [options]

Options:
  --period YYYY-MM          Rating period. Default: current UTC month.
  --scenario <id>           Load one scenario, for example R-FB-001.
  --group <group>           Load one group: baseline, pricePlan, fallback, subscription, subscriptionState, simStatus, usage.
  --rating-results          Read DB and assert rating_results rows for selected scenarios.
  --usage-daily             Read DB and assert usage_daily_summary classified MB for selected scenarios.
  --package-summary         Read DB and assert usage_package_daily_summary rows for selected scenarios.
  --alert-candidates        Output POOL_USAGE_HIGH / OUT_OF_PROFILE_SURGE candidates without creating alerts.
  --pool-threshold-percent <n>
                            Candidate threshold for POOL_USAGE_HIGH. Default: 80.
  --out-profile-threshold-percent <n>
                            Candidate threshold for OUT_OF_PROFILE_SURGE. Default: 20.
  --list                    List selected scenario IDs and expected attribution.
  --json                    Print machine-readable JSON.
  --help                    Show this help.

Without --rating-results this tool loads machine-readable expectations only.
T390 adds rating_results assertions. T391 adds usage_daily_summary assertions. T392 adds package summary assertions. T393 adds alert candidate assertions.
`)
}

function printTextReport(payload) {
  console.log('Rating scenario expectation verification')
  console.log(`Period: ${payload.period}`)
  console.log(`Selected scenarios: ${payload.count}`)
  console.log(`Source: ${SOURCE_DOCUMENT}`)
  if (payload.assertions?.ratingResults) {
    console.log(`rating_results assertions: ${payload.assertions.ratingResults.summary.pass}/${payload.assertions.ratingResults.summary.total} PASS`)
  }
  if (payload.assertions?.usageDailySummary) {
    console.log(`usage_daily_summary assertions: ${payload.assertions.usageDailySummary.summary.pass}/${payload.assertions.usageDailySummary.summary.total} PASS`)
  }
  if (payload.assertions?.packageSummary) {
    console.log(`usage_package_daily_summary assertions: ${payload.assertions.packageSummary.summary.pass}/${payload.assertions.packageSummary.summary.total} PASS`)
  }
  if (payload.alertCandidates) {
    console.log(`alert candidates: POOL_USAGE_HIGH=${payload.alertCandidates.counts.poolUsageHigh}, OUT_OF_PROFILE_SURGE=${payload.alertCandidates.counts.outOfProfileSurge}`)
  }
  console.log('')
  for (const expectation of payload.expectations) {
    const result = payload.results.find((row) => row.scenarioId === expectation.scenarioId)
    const ratingResult = payload.assertions?.ratingResults?.results?.find((row) => row.scenarioId === expectation.scenarioId)
    const usageDailyResult = payload.assertions?.usageDailySummary?.results?.find((row) => row.scenarioId === expectation.scenarioId)
    const packageSummaryResult = payload.assertions?.packageSummary?.results?.find((row) => row.scenarioId === expectation.scenarioId)
    const attribution = expectation.expects.ratingResults.attribution.mode
    const bucket = expectation.expects.ratingResults.classification.bucket
    const status = result?.ok
      && (!ratingResult || ratingResult.ok)
      && (!usageDailyResult || usageDailyResult.ok)
      && (!packageSummaryResult || packageSummaryResult.ok)
      ? 'PASS'
      : 'FAIL'
    const ratingInfo = ratingResult ? ` ratingRows=${ratingResult.comparedRowCount}/${ratingResult.rowCount}` : ''
    const usageInfo = usageDailyResult ? ` usageDailyRows=${usageDailyResult.rowCount}` : ''
    const packageInfo = packageSummaryResult ? ` packageSummaryRows=${packageSummaryResult.rowCount}` : ''
    console.log(`- ${expectation.scenarioId} [${expectation.group}] ${status} day=${expectation.usageDay} iccid=${expectation.identity.iccid} attribution=${attribution} bucket=${bucket}${ratingInfo}${usageInfo}${packageInfo}`)
    for (const issue of result?.issues ?? []) {
      console.log(`  issue: ${issue}`)
    }
    for (const issue of ratingResult?.issues ?? []) {
      console.log(`  rating_results: ${issue}`)
    }
    for (const issue of usageDailyResult?.issues ?? []) {
      console.log(`  usage_daily_summary: ${issue}`)
    }
    for (const issue of packageSummaryResult?.issues ?? []) {
      console.log(`  usage_package_daily_summary: ${issue}`)
    }
  }
  console.log('')
  if (payload.alertCandidates) {
    console.log('Alert Candidates')
    console.log(`  sourceRows: ${payload.alertCandidates.sourceRows}`)
    console.log(`  thresholds: pool=${payload.alertCandidates.thresholds.poolUsageHighPercent}% outProfile=${payload.alertCandidates.thresholds.outOfProfileSurgePercent}%`)
    if (payload.alertCandidates.missingSummaryScenarios.length) {
      console.log(`  missing package summary scenarios: ${payload.alertCandidates.missingSummaryScenarios.join(', ')}`)
    }
    for (const candidate of payload.alertCandidates.candidates.poolUsageHigh.slice(0, 20)) {
      console.log(`  POOL_USAGE_HIGH package=${candidate.packageId} sim=${candidate.simId ?? '(pool)'} usedMb=${candidate.usedMb} quotaMb=${candidate.quotaMb} ratio=${candidate.usageRatio}%`)
    }
    for (const candidate of payload.alertCandidates.candidates.outOfProfileSurge.slice(0, 20)) {
      console.log(`  OUT_OF_PROFILE_SURGE package=${candidate.packageId} sim=${candidate.simId ?? '(pool)'} outMb=${candidate.usedMb} quotaMb=${candidate.quotaMb} ratio=${candidate.usageRatio}%`)
    }
    console.log('')
  }
  console.log('Summary:', {
    catalog: payload.summary,
    assertions: payload.assertionSummary,
  })
  console.log(`Result: ${payload.ok ? 'PASS' : 'FAIL'}`)
}

async function main() {
  if (hasFlag('help')) {
    printHelp()
    return
  }

  const catalogValidation = validateScenarioCatalog()
  if (!catalogValidation.ok) {
    throw new Error(`Invalid rating scenario catalog:\n${catalogValidation.errors.join('\n')}`)
  }

  const period = parsePeriod(arg('period'))
  const selected = selectScenarios({ scenarioId: arg('scenario'), group: arg('group') })
  const expectations = selected.map((scenario) => buildExpectation(scenario, period))
  const results = expectations.map(validateExpectation)
  const summary = summarize(results)
  const assertionModes = {
    ratingResults: hasFlag('rating-results'),
    usageDailySummary: hasFlag('usage-daily'),
    packageSummary: hasFlag('package-summary'),
    alertCandidates: hasFlag('alert-candidates'),
  }
  const assertions = {}
  if (assertionModes.ratingResults && summary.fail === 0) {
    const ratingResults = await runRatingResultsAssertions(expectations)
    assertions.ratingResults = {
      summary: summarize(ratingResults),
      results: ratingResults,
    }
  }
  if (assertionModes.usageDailySummary && summary.fail === 0) {
    const usageDailySummary = await runUsageDailyAssertions(expectations)
    assertions.usageDailySummary = {
      summary: summarize(usageDailySummary),
      results: usageDailySummary,
    }
  }
  if (assertionModes.packageSummary && summary.fail === 0) {
    const packageSummary = await runPackageSummaryAssertions(expectations)
    assertions.packageSummary = {
      summary: summarize(packageSummary),
      results: packageSummary,
    }
  }
  const alertCandidates = assertionModes.alertCandidates && summary.fail === 0
    ? await runAlertCandidateReport(expectations)
    : null
  const payload = {
    ok: summary.fail === 0 && totalAssertionFailures(assertions) === 0,
    period,
    sourceDocument: SOURCE_DOCUMENT,
    count: selected.length,
    assertionModes,
    catalog: {
      count: catalogValidation.count,
      ok: catalogValidation.ok,
    },
    expectations,
    results,
    assertions,
    assertionSummary: summarizeAssertions(assertions),
    alertCandidates,
    summary,
  }

  if (hasFlag('list')) {
    if (hasFlag('json')) {
      console.log(JSON.stringify(payload, null, 2))
      return
    }
    for (const expectation of expectations) {
      console.log(`${expectation.scenarioId}\t${expectation.group}\t${expectation.usageDay}\t${expectation.identity.iccid}\t${expectation.expects.ratingResults.attribution.mode}\t${expectation.expects.ratingResults.classification.bucket}`)
    }
    return
  }

  if (hasFlag('json')) {
    console.log(JSON.stringify(payload, null, 2))
    if (!payload.ok) process.exitCode = 1
    return
  }

  printTextReport(payload)
  if (!payload.ok) process.exitCode = 1
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err)
  process.exitCode = 1
})
