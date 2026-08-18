import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

const RESELLER_ID = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const ENTERPRISE_ID = '43326e05-5704-4e0d-8175-547d6b555132'
const ICCIDS = [
  '893107032536642107',
  '893107032536642111',
  '893107032536642110',
  '893107032536642109',
  '893107032536642108',
  '893107032536642334',
  '8965012309280009884',
  '8965012309280009520',
]

function arg(name) {
  const flag = `--${name}`
  const idx = process.argv.indexOf(flag)
  if (idx >= 0) return process.argv[idx + 1] ?? ''
  return null
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function normalizeMccMnc(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (raw.includes('-')) {
    const [mcc, mnc] = raw.split('-')
    if (!mcc || !mnc) return raw
    return `${mcc.padStart(3, '0')}-${mnc.replace(/\*/g, '0').padStart(3, '0')}`
  }
  if (/^\d{5,6}$/.test(raw)) {
    return `${raw.slice(0, 3)}-${raw.slice(3).padStart(3, '0')}`
  }
  return raw
}

function coveredVisited(entries) {
  const first = entries.find((row) => row?.mcc && row?.mnc)
  if (!first) return '234-015'
  return normalizeMccMnc(`${first.mcc}-${first.mnc}`) ?? '234-015'
}

function outOfProfileVisited(coveredSet) {
  const candidates = ['999-999', '424-002', '310-260', '505-001']
  return candidates.find((candidate) => !coveredSet.has(candidate)) ?? '999-999'
}

function planQuotaMb(plan, simCountForPackage) {
  const type = String(plan?.type ?? plan?.price_plan_type ?? '').toUpperCase()
  if (type === 'ONE_TIME') return Number(plan?.quota_mb ?? 0) || 0
  if (type === 'SIM_DEPENDENT_BUNDLE') return (Number(plan?.per_sim_quota_mb ?? 0) || 0) * Math.max(1, simCountForPackage || 1)
  if (type === 'FIXED_BUNDLE') return Number(plan?.total_quota_mb ?? 0) || 0
  if (type === 'TIERED_VOLUME_PRICING' || type === 'TIERED_PRICING') {
    const tiers = Array.isArray(plan?.tiers) ? plan.tiers : []
    const maxTo = tiers.reduce((max, tier) => Math.max(max, Number(tier?.toMb ?? tier?.to_mb ?? 0) || 0), 0)
    return maxTo
  }
  return Number(plan?.quota_mb ?? plan?.total_quota_mb ?? 0) || 0
}

function inProfileMbFor(plan, idx, simCountForPackage) {
  const type = String(plan?.type ?? plan?.price_plan_type ?? '').toUpperCase()
  const quota = planQuotaMb(plan, simCountForPackage)
  if (type === 'SIM_DEPENDENT_BUNDLE') {
    return idx < 2 ? Math.max(800, quota * 0.65) : Math.max(20, quota * 0.04)
  }
  if (type === 'FIXED_BUNDLE') return idx < 2 ? Math.max(500, quota * 0.55) : Math.max(25, quota * 0.05)
  if (type === 'ONE_TIME') return Math.max(10, quota * 0.35 || 50)
  if (type === 'TIERED_VOLUME_PRICING' || type === 'TIERED_PRICING') return Math.max(50, quota * 0.25 || 80)
  return 50
}

function outProfileMbFor(plan, idx, simCountForPackage) {
  const quota = planQuotaMb(plan, simCountForPackage)
  const type = String(plan?.type ?? plan?.price_plan_type ?? '').toUpperCase()
  if (type === 'SIM_DEPENDENT_BUNDLE') return idx < 2 ? Math.max(200, quota * 0.18) : 15
  if (type === 'FIXED_BUNDLE') return idx < 2 ? Math.max(120, quota * 0.12) : 10
  if (type === 'ONE_TIME') return Math.max(5, quota * 0.12 || 20)
  if (type === 'TIERED_VOLUME_PRICING' || type === 'TIERED_PRICING') return Math.max(20, quota * 0.10 || 30)
  return 10
}

function splitMb(totalMb, uplinkRatio) {
  const total = Math.max(0, Math.round(Number(totalMb) || 0))
  const uplink = Math.max(0, Math.round(total * uplinkRatio))
  return { uplink, downlink: Math.max(0, total - uplink), total }
}

async function selectAll(supabase, table, query) {
  const rows = await supabase.select(table, query)
  return Array.isArray(rows) ? rows : []
}

async function upsertUsage(supabase, row) {
  const match = [
    `iccid=eq.${encodeURIComponent(row.iccid)}`,
    `usage_day=eq.${encodeURIComponent(row.usage_day)}`,
    `visited_mccmnc=eq.${encodeURIComponent(row.visited_mccmnc)}`,
  ].join('&')
  const existing = await selectAll(supabase, 'usage_daily_summary', `select=usage_id&${match}&limit=1`)
  if (existing[0]?.usage_id) {
    await supabase.update(
      'usage_daily_summary',
      `usage_id=eq.${encodeURIComponent(String(existing[0].usage_id))}`,
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
    return 'updated'
  }
  await supabase.insert('usage_daily_summary', row, { returning: 'minimal', suppressMissingColumns: true })
  return 'inserted'
}

async function main() {
  const dryRun = hasFlag('dry-run')
  const apply = hasFlag('apply')
  if (!dryRun && !apply) {
    throw new Error('Use --dry-run to preview or --apply to write usage_daily_summary.')
  }
  const period = arg('period') || '2026-06'
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const iccidFilter = ICCIDS.map((iccid) => encodeURIComponent(iccid)).join(',')
  const sims = await selectAll(
    supabase,
    'sims',
    `select=sim_id,iccid,enterprise_id,supplier_id,apn&enterprise_id=eq.${encodeURIComponent(ENTERPRISE_ID)}&iccid=in.(${iccidFilter})&limit=100`
  )
  const simById = new Map(sims.map((sim) => [String(sim.sim_id), sim]))
  const foundIccids = new Set(sims.map((sim) => String(sim.iccid)))
  const missingIccids = ICCIDS.filter((iccid) => !foundIccids.has(iccid))
  const simIds = sims.map((sim) => String(sim.sim_id)).filter(Boolean)
  const subscriptions = simIds.length
    ? await selectAll(
      supabase,
      'subscriptions',
      `select=subscription_id,sim_id,enterprise_id,package_id,state,subscription_kind&sim_id=in.(${simIds.map((id) => encodeURIComponent(id)).join(',')})&state=eq.ACTIVE&limit=1000`
    )
    : []
  const mainSubBySim = new Map()
  for (const sub of subscriptions) {
    const simId = sub?.sim_id ? String(sub.sim_id) : null
    if (!simId) continue
    const existing = mainSubBySim.get(simId)
    const kind = String(sub?.subscription_kind ?? '').toUpperCase()
    if (!existing || kind === 'MAIN') mainSubBySim.set(simId, sub)
  }
  const packageIds = Array.from(new Set(subscriptions.map((sub) => sub?.package_id ? String(sub.package_id) : '').filter(Boolean)))
  const packages = packageIds.length
    ? await selectAll(
      supabase,
      'packages',
      `select=package_id,price_plan_id,enterprise_id&package_id=in.(${packageIds.map((id) => encodeURIComponent(id)).join(',')})&limit=1000`
    )
    : []
  const packageById = new Map(packages.map((pkg) => [String(pkg.package_id), pkg]))
  const pricePlanIds = Array.from(new Set(packages.map((pkg) => pkg?.price_plan_id ? String(pkg.price_plan_id) : '').filter(Boolean)))
  const pricePlans = pricePlanIds.length
    ? await selectAll(
      supabase,
      'price_plans_expanded',
      `select=price_plan_id,type,quota_mb,per_sim_quota_mb,total_quota_mb,tiers,covered_network_profile_id&price_plan_id=in.(${pricePlanIds.map((id) => encodeURIComponent(id)).join(',')})&limit=1000`
    )
    : []
  const pricePlanById = new Map(pricePlans.map((plan) => [String(plan.price_plan_id), plan]))
  const coveredIds = Array.from(new Set(pricePlans.map((plan) => plan?.covered_network_profile_id ? String(plan.covered_network_profile_id) : '').filter(Boolean)))
  const coveredEntries = coveredIds.length
    ? await selectAll(
      supabase,
      'covered_network_profile_entries',
      `select=covered_network_profile_id,mcc,mnc&covered_network_profile_id=in.(${coveredIds.map((id) => encodeURIComponent(id)).join(',')})&limit=10000`
    )
    : []
  const entriesByCoveredId = new Map()
  for (const entry of coveredEntries) {
    const id = entry?.covered_network_profile_id ? String(entry.covered_network_profile_id) : null
    if (!id) continue
    if (!entriesByCoveredId.has(id)) entriesByCoveredId.set(id, [])
    entriesByCoveredId.get(id).push(entry)
  }
  const simCountByPackage = new Map()
  for (const sub of subscriptions) {
    const pkgId = sub?.package_id ? String(sub.package_id) : null
    if (!pkgId) continue
    simCountByPackage.set(pkgId, (simCountByPackage.get(pkgId) ?? 0) + 1)
  }
  const operations = []
  let perPackageIndex = new Map()
  for (const sim of sims) {
    const simId = String(sim.sim_id)
    const sub = mainSubBySim.get(simId)
    const pkg = sub?.package_id ? packageById.get(String(sub.package_id)) : null
    const plan = pkg?.price_plan_id ? pricePlanById.get(String(pkg.price_plan_id)) : null
    if (!sub || !pkg || !plan) {
      operations.push({ skipped: true, iccid: sim.iccid, reason: 'missing active subscription/package/price plan' })
      continue
    }
    const pkgId = String(pkg.package_id)
    const idx = perPackageIndex.get(pkgId) ?? 0
    perPackageIndex.set(pkgId, idx + 1)
    const entries = entriesByCoveredId.get(String(plan.covered_network_profile_id ?? '')) ?? []
    const inVisited = coveredVisited(entries)
    const coveredSet = new Set(entries.map((entry) => normalizeMccMnc(`${entry.mcc}-${entry.mnc}`)).filter(Boolean))
    const outVisited = outOfProfileVisited(coveredSet)
    const simCount = simCountByPackage.get(pkgId) ?? 1
    const inMb = splitMb(inProfileMbFor(plan, idx, simCount), 0.2)
    const outMb = splitMb(outProfileMbFor(plan, idx, simCount), 0.15)
    const base = {
      supplier_id: sim.supplier_id,
      enterprise_id: ENTERPRISE_ID,
      sim_id: simId,
      iccid: sim.iccid,
      apn: sim.apn ?? null,
      rat: '4G',
    }
    operations.push({
      kind: 'in-profile',
      packageId: pkgId,
      pricePlanId: plan.price_plan_id,
      pricePlanType: plan.type,
      row: {
        ...base,
        usage_day: `${period}-05`,
        visited_mccmnc: inVisited,
        uplink_mb: inMb.uplink,
        downlink_mb: inMb.downlink,
        total_mb: inMb.total,
        in_profile_mb: 0,
        out_of_profile_mb: 0,
        unclassified_mb: inMb.total,
        rated_at: null,
        input_ref: `seed:${period}:in-profile:${sim.iccid}`,
      },
    })
    operations.push({
      kind: 'out-of-profile',
      packageId: pkgId,
      pricePlanId: plan.price_plan_id,
      pricePlanType: plan.type,
      row: {
        ...base,
        usage_day: `${period}-06`,
        visited_mccmnc: outVisited,
        uplink_mb: outMb.uplink,
        downlink_mb: outMb.downlink,
        total_mb: outMb.total,
        in_profile_mb: 0,
        out_of_profile_mb: 0,
        unclassified_mb: outMb.total,
        rated_at: null,
        input_ref: `seed:${period}:out-of-profile:${sim.iccid}`,
      },
    })
  }

  const planned = operations.filter((op) => op.row)
  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'apply',
    resellerId: RESELLER_ID,
    enterpriseId: ENTERPRISE_ID,
    requestedIccids: ICCIDS.length,
    foundSims: sims.length,
    missingIccids,
    plannedRows: planned.length,
    skipped: operations.filter((op) => op.skipped),
    packageSummary: Array.from(perPackageIndex.entries()).map(([packageId, count]) => ({ packageId, simCount: count })),
    preview: planned.slice(0, 12).map((op) => ({
      kind: op.kind,
      iccid: op.row.iccid,
      usageDay: op.row.usage_day,
      visitedMccMnc: op.row.visited_mccmnc,
      totalMb: op.row.total_mb,
      packageId: op.packageId,
      pricePlanId: op.pricePlanId,
      pricePlanType: op.pricePlanType,
    })),
  }, null, 2))

  if (dryRun) return

  let inserted = 0
  let updated = 0
  for (const op of planned) {
    const result = await upsertUsage(supabase, op.row)
    if (result === 'inserted') inserted += 1
    if (result === 'updated') updated += 1
  }
  console.log(JSON.stringify({ inserted, updated }, null, 2))
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err)
  process.exit(1)
})
