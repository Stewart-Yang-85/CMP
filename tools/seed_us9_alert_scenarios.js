import 'dotenv/config'
import crypto from 'node:crypto'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

const ENTERPRISE_ID = '43326e05-5704-4e0d-8175-547d6b555132'
const RESELLER_ID = '0925eb82-53ef-4522-8d81-07ebaa17d819'

const ONE_TIME_PLAN_NAME = 'US9_SCENARIO_ONE_TIME_1GB'
const ONE_TIME_PACKAGE_NAME = 'US9_SCENARIO_ONE_TIME_PACKAGE_1GB'
const FIXED_PACKAGE_ID = '13dc6905-5070-420c-b9ec-8c45b54ebe1c'
const FIXED_PRICE_PLAN_ID = 'c1703e59-f7d9-4d37-8eab-8fafaf2e792e'
const FIXED_COVERED_PROFILE_ID = 'fa731051-3676-4c8f-a1b3-84a85baeee7f'

const SCENARIO_SIMS = {
  A_ONE_TIME_IN_PROFILE: '3f142517-4f19-4ca6-97c3-95a5c8d3458d',
  B_FIXED_POOL_IN_PROFILE: 'd43e44e5-6184-4ca1-ab15-6207ca02b8ad',
  C_FIXED_POOL_IN_PROFILE: '8b7ecdc2-b954-41d2-979d-f7ae699178ce',
  D_SUBSCRIPTION_OUT_PROFILE: '19f55dde-065d-4007-b204-a7ffe2845ebc',
}

const D_EXISTING_PACKAGE_ID = 'd8283ced-2936-4349-92aa-eceb2013c611'

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

function periodBounds(period) {
  const raw = String(period || '').trim()
  if (!/^\d{4}-\d{2}$/.test(raw)) throw new Error('--period must be YYYY-MM')
  return { period: raw, dayA: `${raw}-10`, dayBC: `${raw}-11`, dayD: `${raw}-12` }
}

function n(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function splitMb(totalMb) {
  const total = Math.max(0, Math.round(n(totalMb)))
  const uplink = Math.round(total * 0.2)
  return { uplink, downlink: total - uplink, total }
}

async function selectOne(supabase, table, query) {
  const rows = await supabase.select(table, `${query}&limit=1`)
  return Array.isArray(rows) ? rows[0] ?? null : null
}

async function selectAll(supabase, table, query) {
  const rows = await supabase.select(table, query)
  return Array.isArray(rows) ? rows : []
}

async function ensureOneTimePlan(supabase, fixedPlan, dryRun) {
  const existing = await selectOne(
    supabase,
    'price_plans',
    `select=price_plan_id,name,type,status,covered_network_profile_id&enterprise_id=eq.${encodeURIComponent(ENTERPRISE_ID)}&name=eq.${encodeURIComponent(ONE_TIME_PLAN_NAME)}`
  )
  if (existing?.price_plan_id) {
    const extension = await selectOne(
      supabase,
      'price_plan_one_time',
      `select=price_plan_id,quota_mb,one_time_fee,validity_days,expiry_boundary&price_plan_id=eq.${encodeURIComponent(String(existing.price_plan_id))}`
    )
    return {
      pricePlanId: String(existing.price_plan_id),
      created: false,
      extensionCreated: false,
      extension,
    }
  }

  const pricePlanId = crypto.randomUUID()
  if (dryRun) {
    return { pricePlanId, created: true, extensionCreated: true, dryRun: true }
  }

  const now = new Date().toISOString()
  await supabase.insert('price_plans', {
    price_plan_id: pricePlanId,
    enterprise_id: ENTERPRISE_ID,
    reseller_id: RESELLER_ID,
    name: ONE_TIME_PLAN_NAME,
    type: 'ONE_TIME',
    service_type: 'DATA',
    currency: fixedPlan?.currency ?? 'USD',
    billing_cycle_type: fixedPlan?.billing_cycle_type ?? 'CALENDAR_MONTH',
    first_cycle_proration: fixedPlan?.first_cycle_proration ?? 'DAILY_PRORATION',
    version: 1,
    effective_from: now,
    is_current: true,
    status: 'PUBLISHED',
    covered_network_profile_id: FIXED_COVERED_PROFILE_ID,
    proration_rounding: fixedPlan?.proration_rounding ?? 'ROUND_HALF_UP',
  }, { returning: 'minimal', suppressMissingColumns: true })
  await supabase.insert('price_plan_one_time', {
    price_plan_id: pricePlanId,
    one_time_fee: 10,
    quota_mb: 1000,
    validity_days: 30,
    expiry_boundary: 'CALENDAR_DAY_END',
  }, { returning: 'minimal' })
  return { pricePlanId, created: true, extensionCreated: true }
}

async function ensureOneTimePackage(supabase, oneTimePlanId, fixedPackage, dryRun) {
  const existing = await selectOne(
    supabase,
    'packages',
    `select=package_id,name,price_plan_id,status&enterprise_id=eq.${encodeURIComponent(ENTERPRISE_ID)}&name=eq.${encodeURIComponent(ONE_TIME_PACKAGE_NAME)}`
  )
  if (existing?.package_id) {
    return { packageId: String(existing.package_id), created: false }
  }

  const packageId = crypto.randomUUID()
  if (dryRun) return { packageId, created: true, dryRun: true }

  const now = new Date().toISOString()
  await supabase.insert('packages', {
    package_id: packageId,
    enterprise_id: ENTERPRISE_ID,
    name: ONE_TIME_PACKAGE_NAME,
    description: 'US9 scenario seed: ONE_TIME package for alert/rating verification.',
    status: 'PUBLISHED',
    published_at: now,
    effective_from: now,
    price_plan_id: oneTimePlanId,
    carrier_service_id: fixedPackage?.carrier_service_id ?? null,
    control_policy_id: fixedPackage?.control_policy_id ?? null,
    commercial_terms_id: fixedPackage?.commercial_terms_id ?? null,
  }, { returning: 'minimal', suppressMissingColumns: true })
  return { packageId, created: true }
}

async function ensureActiveSubscription(supabase, simId, packageId, dryRun) {
  const existing = await selectOne(
    supabase,
    'subscriptions',
    `select=subscription_id,sim_id,package_id,state&sim_id=eq.${encodeURIComponent(simId)}&package_id=eq.${encodeURIComponent(packageId)}&state=eq.ACTIVE`
  )
  if (existing?.subscription_id) {
    return { subscriptionId: String(existing.subscription_id), created: false }
  }
  const subscriptionId = crypto.randomUUID()
  if (dryRun) return { subscriptionId, created: true, dryRun: true }
  await supabase.insert('subscriptions', {
    subscription_id: subscriptionId,
    enterprise_id: ENTERPRISE_ID,
    sim_id: simId,
    subscription_kind: 'MAIN',
    package_id: packageId,
    state: 'ACTIVE',
    effective_at: '2026-06-01T00:00:00.000Z',
    first_subscribed_at: '2026-06-01T00:00:00.000Z',
    commitment_end_at: '2027-06-01T00:00:00.000Z',
  }, { returning: 'minimal', suppressMissingColumns: true })
  return { subscriptionId, created: true }
}

async function activateSim(supabase, simId, dryRun) {
  if (dryRun) return { simId, updated: true, dryRun: true }
  await supabase.update(
    'sims',
    `sim_id=eq.${encodeURIComponent(simId)}`,
    {
      status: 'ACTIVATED',
      activation_date: '2026-06-01T00:00:00.000Z',
      upstream_status: 'CONNECTED',
      upstream_status_updated_at: new Date().toISOString(),
    },
    { returning: 'minimal', suppressMissingColumns: true }
  )
  return { simId, updated: true }
}

async function upsertUsage(supabase, row, dryRun) {
  const match = [
    `iccid=eq.${encodeURIComponent(row.iccid)}`,
    `usage_day=eq.${encodeURIComponent(row.usage_day)}`,
    `visited_mccmnc=eq.${encodeURIComponent(row.visited_mccmnc)}`,
  ].join('&')
  const existing = await selectOne(supabase, 'usage_daily_summary', `select=usage_id&${match}`)
  if (dryRun) {
    return { inputRef: row.input_ref, action: existing?.usage_id ? 'would-update' : 'would-insert' }
  }
  if (existing?.usage_id) {
    await supabase.update(
      'usage_daily_summary',
      `usage_id=eq.${encodeURIComponent(String(existing.usage_id))}`,
      {
        supplier_id: row.supplier_id,
        enterprise_id: row.enterprise_id,
        sim_id: row.sim_id,
        uplink_mb: row.uplink_mb,
        downlink_mb: row.downlink_mb,
        total_mb: row.total_mb,
        in_profile_mb: 0,
        out_of_profile_mb: 0,
        unclassified_mb: row.total_mb,
        rated_at: null,
        apn: row.apn,
        rat: row.rat,
        input_ref: row.input_ref,
        updated_at: new Date().toISOString(),
      },
      { returning: 'minimal', suppressMissingColumns: true }
    )
    return { inputRef: row.input_ref, action: 'updated' }
  }
  await supabase.insert('usage_daily_summary', row, { returning: 'minimal', suppressMissingColumns: true })
  return { inputRef: row.input_ref, action: 'inserted' }
}

function usageRow({ sim, usageDay, visitedMccMnc, totalMb, inputRef }) {
  const split = splitMb(totalMb)
  return {
    supplier_id: sim.supplier_id,
    enterprise_id: ENTERPRISE_ID,
    sim_id: sim.sim_id,
    iccid: sim.iccid,
    usage_day: usageDay,
    visited_mccmnc: visitedMccMnc,
    uplink_mb: split.uplink,
    downlink_mb: split.downlink,
    total_mb: split.total,
    in_profile_mb: 0,
    out_of_profile_mb: 0,
    unclassified_mb: split.total,
    rated_at: null,
    apn: sim.apn ?? null,
    rat: '4G',
    input_ref: inputRef,
  }
}

async function main() {
  const dryRun = hasFlag('dry-run')
  const apply = hasFlag('apply')
  if (!dryRun && !apply) throw new Error('Use --dry-run to preview or --apply to write scenario data.')

  const { period, dayA, dayBC, dayD } = periodBounds(arg('period') || '2026-06')
  const supabase = createSupabaseRestClient({ useServiceRole: true })

  const fixedPackage = await selectOne(
    supabase,
    'packages',
    `select=package_id,name,price_plan_id,carrier_service_id,control_policy_id,commercial_terms_id,status&package_id=eq.${encodeURIComponent(FIXED_PACKAGE_ID)}`
  )
  if (!fixedPackage) throw new Error(`Fixed package not found: ${FIXED_PACKAGE_ID}`)
  const fixedPlan = await selectOne(
    supabase,
    'price_plans',
    `select=price_plan_id,currency,billing_cycle_type,first_cycle_proration,proration_rounding&price_plan_id=eq.${encodeURIComponent(FIXED_PRICE_PLAN_ID)}`
  )
  const fixedExtension = await selectOne(
    supabase,
    'price_plan_fixed_bundle',
    `select=price_plan_id,total_quota_mb,overage_rate_per_mb&price_plan_id=eq.${encodeURIComponent(FIXED_PRICE_PLAN_ID)}`
  )

  const simIds = Object.values(SCENARIO_SIMS)
  const sims = await selectAll(
    supabase,
    'sims',
    `select=sim_id,iccid,supplier_id,operator_id,status,apn&sim_id=in.(${simIds.map((id) => encodeURIComponent(id)).join(',')})`
  )
  const simById = new Map(sims.map((sim) => [String(sim.sim_id), sim]))
  for (const [name, simId] of Object.entries(SCENARIO_SIMS)) {
    if (!simById.has(simId)) throw new Error(`Scenario SIM missing for ${name}: ${simId}`)
  }

  const oneTimePlan = await ensureOneTimePlan(supabase, fixedPlan, dryRun)
  const oneTimePackage = await ensureOneTimePackage(supabase, oneTimePlan.pricePlanId, fixedPackage, dryRun)

  const subscriptionPlans = [
    { scenario: 'A_ONE_TIME_IN_PROFILE', simId: SCENARIO_SIMS.A_ONE_TIME_IN_PROFILE, packageId: oneTimePackage.packageId },
    { scenario: 'B_FIXED_POOL_IN_PROFILE', simId: SCENARIO_SIMS.B_FIXED_POOL_IN_PROFILE, packageId: FIXED_PACKAGE_ID },
    { scenario: 'C_FIXED_POOL_IN_PROFILE', simId: SCENARIO_SIMS.C_FIXED_POOL_IN_PROFILE, packageId: FIXED_PACKAGE_ID },
    { scenario: 'D_SUBSCRIPTION_OUT_PROFILE', simId: SCENARIO_SIMS.D_SUBSCRIPTION_OUT_PROFILE, packageId: D_EXISTING_PACKAGE_ID },
  ]

  const activations = []
  const subscriptions = []
  for (const plan of subscriptionPlans) {
    activations.push(await activateSim(supabase, plan.simId, dryRun))
    subscriptions.push({
      scenario: plan.scenario,
      ...(await ensureActiveSubscription(supabase, plan.simId, plan.packageId, dryRun)),
      packageId: plan.packageId,
    })
  }

  const rows = [
    {
      scenario: 'SIM A: ONE_TIME in-profile > 80%',
      row: usageRow({
        sim: simById.get(SCENARIO_SIMS.A_ONE_TIME_IN_PROFILE),
        usageDay: dayA,
        visitedMccMnc: '520-000',
        totalMb: 850,
        inputRef: `seed:us9-scenario:${period}:A-one-time-in-profile`,
      }),
    },
    {
      scenario: 'SIM B: FIXED_BUNDLE pool in-profile part 1',
      row: usageRow({
        sim: simById.get(SCENARIO_SIMS.B_FIXED_POOL_IN_PROFILE),
        usageDay: dayBC,
        visitedMccMnc: '520-000',
        totalMb: 4600,
        inputRef: `seed:us9-scenario:${period}:B-fixed-pool-in-profile`,
      }),
    },
    {
      scenario: 'SIM C: FIXED_BUNDLE pool in-profile part 2',
      row: usageRow({
        sim: simById.get(SCENARIO_SIMS.C_FIXED_POOL_IN_PROFILE),
        usageDay: dayBC,
        visitedMccMnc: '520-000',
        totalMb: 4600,
        inputRef: `seed:us9-scenario:${period}:C-fixed-pool-in-profile`,
      }),
    },
    {
      scenario: 'SIM D: active subscription out-of-profile > 20%',
      row: usageRow({
        sim: simById.get(SCENARIO_SIMS.D_SUBSCRIPTION_OUT_PROFILE),
        usageDay: dayD,
        visitedMccMnc: '204-008',
        totalMb: 50,
        inputRef: `seed:us9-scenario:${period}:D-subscription-out-profile`,
      }),
    },
  ]

  const usageOps = []
  for (const item of rows) {
    usageOps.push({ scenario: item.scenario, ...(await upsertUsage(supabase, item.row, dryRun)), row: item.row })
  }

  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'apply',
    enterpriseId: ENTERPRISE_ID,
    resellerId: RESELLER_ID,
    period,
    oneTimePlan,
    oneTimePackage,
    fixedPackage: {
      packageId: FIXED_PACKAGE_ID,
      pricePlanId: FIXED_PRICE_PLAN_ID,
      totalQuotaMb: n(fixedExtension?.total_quota_mb),
    },
    scenarioSims: Object.fromEntries(Object.entries(SCENARIO_SIMS).map(([name, simId]) => {
      const sim = simById.get(simId)
      return [name, { simId, iccid: sim?.iccid ?? null, previousStatus: sim?.status ?? null }]
    })),
    activations,
    subscriptions,
    usageOps: usageOps.map((op) => ({
      scenario: op.scenario,
      action: op.action,
      inputRef: op.inputRef,
      iccid: op.row.iccid,
      usageDay: op.row.usage_day,
      visitedMccMnc: op.row.visited_mccmnc,
      totalMb: op.row.total_mb,
    })),
  }, null, 2))
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err)
  process.exit(1)
})
