import { createSupabaseRestClient } from './supabaseRest.js'

/**
 * Billing Engine Implementation
 * Ported from tools/run_billing_engine.ps1
 */

// ============================================================
// T-NEW-4: Rounding Strategy
// ============================================================
// Global billing precision: ROUND_HALF_UP to 2 decimal places.
// - rating_results.amount: intermediate precision (stored as-is from calculation)
// - bill_line_items.amount: final precision (rounded to BILLING_PRECISION)
// - bill.total_amount = SUM(line_items.amount), NOT re-rounded from rating_results
export const BILLING_PRECISION = 2
export function roundAmount(value) {
  if (!Number.isFinite(value)) return 0
  // ROUND_HALF_UP: standard rounding (0.005 → 0.01)
  const factor = Math.pow(10, BILLING_PRECISION)
  return Math.round(value * factor + Number.EPSILON) / factor
}

// Helper: Convert MB to KB with Ceiling
function convertMbToKbCeil(mb, mbToKb = 1024) {
  return Math.ceil(mb * mbToKb)
}

function normalizeVisitedMccMnc(value) {
  const raw = String(value || '').trim()
  if (!raw) return raw
  const exact = raw.match(/^(\d{3})-?(\d{2,3})$/)
  if (!exact) return raw
  const mcc = exact[1]
  let mnc = exact[2]
  if (mnc.length === 2) mnc = `0${mnc}`
  return `${mcc}-${mnc}`
}

function matchMccMncPattern(visited, pattern) {
  const v = normalizeVisitedMccMnc(visited)
  const p = String(pattern || '').trim()
  if (!p) return false
  if (p === '*') return true
  const mccWildcard = p.match(/^(\d{3})-\*$/)
  if (mccWildcard) return v.startsWith(`${mccWildcard[1]}-`)
  const exact = p.match(/^(\d{3})-?(\d{2,3})$/)
  if (exact) return v === normalizeVisitedMccMnc(`${exact[1]}-${exact[2]}`)
  return false
}

function coverageIncludes(coverage, visitedMccMnc) {
  if (!coverage) return false
  if (coverage.type === 'GLOBAL') return true
  if (coverage.type === 'MCCMNC_ALLOWLIST') {
    const list = Array.isArray(coverage.mccmnc) ? coverage.mccmnc : []
    return list.some((entry) => matchMccMncPattern(visitedMccMnc, entry))
  }
  return false
}

// Helper: Calculate narrowness score (lower is better/more specific)
function coverageNarrownessScore(coverage) {
  if (!coverage) return 999999
  if (coverage.type === 'GLOBAL') return 999999
  if (coverage.type === 'MCCMNC_ALLOWLIST') {
    return Array.isArray(coverage.mccmnc) ? coverage.mccmnc.length : 999999
  }
  return 999999
}

// Helper: Select best matching package
function selectMatchingPackage(subscriptions, visitedMccMnc, packageDetailsMap) {
  const subs = Array.isArray(subscriptions) ? subscriptions : []

  // 1. Try Add-ons first
  const addOns = subs.filter(s => s.subscription_kind === 'ADD_ON')
  const addOnCandidates = []
  
  for (const sub of addOns) {
    const pkg = packageDetailsMap[sub.package_version_id]
    if (!pkg) continue
    // Assuming pkg.roaming_profile is the coverage object
    if (coverageIncludes(pkg.roaming_profile, visitedMccMnc)) {
      addOnCandidates.push({ sub, pkg })
    }
  }

  if (addOnCandidates.length > 0) {
    // Sort by narrowness (asc), then by ID (asc) for stability
    addOnCandidates.sort((a, b) => {
      const scoreA = coverageNarrownessScore(a.pkg.roaming_profile)
      const scoreB = coverageNarrownessScore(b.pkg.roaming_profile)
      if (scoreA !== scoreB) return scoreA - scoreB
      return String(a.sub.package_version_id).localeCompare(String(b.sub.package_version_id))
    })
    return addOnCandidates[0]
  }

  // 2. Try Main plans
  const mains = subs.filter(s => s.subscription_kind === 'MAIN')
  const mainCandidates = []
  for (const sub of mains) {
    const pkg = packageDetailsMap[sub.package_version_id]
    if (!pkg) continue
    if (coverageIncludes(pkg.roaming_profile, visitedMccMnc)) {
      mainCandidates.push({ sub, pkg })
    }
  }
  if (mainCandidates.length > 0) {
    mainCandidates.sort((a, b) => {
      const scoreA = coverageNarrownessScore(a.pkg.roaming_profile)
      const scoreB = coverageNarrownessScore(b.pkg.roaming_profile)
      if (scoreA !== scoreB) return scoreA - scoreB
      return String(a.sub.package_version_id).localeCompare(String(b.sub.package_version_id))
    })
    return mainCandidates[0]
  }

  return null
}

// Helper: Resolve PAYG rate
function resolvePaygRatePerKb(mainPkg, visitedMccMnc) {
  const planVersion = mainPkg?.resolved_price_plan_version ?? mainPkg?.price_plan_versions ?? null
  if (!mainPkg || !planVersion || !planVersion.payg_rates) return null
  
  const zones = planVersion.payg_rates.zones
  if (!zones) return null

  let bestScore = -1
  let bestRate = null
  const zoneNames = Object.keys(zones).sort()
  for (const zoneName of zoneNames) {
    const zone = zones[zoneName]
    if (!zone) continue
    const list = Array.isArray(zone.mccmnc) ? zone.mccmnc : []
    for (const entry of list) {
      const pattern = String(entry || '').trim()
      if (!matchMccMncPattern(visitedMccMnc, pattern)) continue
      let score = 0
      if (pattern === '*') score = 1
      else if (pattern.endsWith('-*')) score = 2
      else score = 3
      if (score > bestScore) {
        bestScore = score
        bestRate = Number(zone.ratePerMb)
      }
    }
  }
  return bestRate
}

function isOverlappingPeriod(startTime, endTime, rangeStart, rangeEnd) {
  const start = startTime ? new Date(startTime) : null
  const end = endTime ? new Date(endTime) : null
  if (!start || Number.isNaN(start.getTime())) return false
  const rangeStartMs = rangeStart.getTime()
  const rangeEndMs = rangeEnd.getTime()
  const startMs = start.getTime()
  const endMs = end ? end.getTime() : null
  if (startMs >= rangeEndMs) return false
  if (endMs !== null && endMs < rangeStartMs) return false
  return true
}

function resolveHighWaterStatus(history, rangeStart, rangeEnd, fallbackStatus) {
  let hasActivated = false
  let hasDeactivated = false
  for (const row of history) {
    if (!isOverlappingPeriod(row.start_time, row.end_time, rangeStart, rangeEnd)) continue
    if (row.after_status === 'ACTIVATED') hasActivated = true
    if (row.after_status === 'DEACTIVATED') hasDeactivated = true
  }
  if (!hasActivated && !hasDeactivated) {
    if (fallbackStatus === 'ACTIVATED') hasActivated = true
    if (fallbackStatus === 'DEACTIVATED') hasDeactivated = true
  }
  if (hasActivated) return 'ACTIVATED'
  if (hasDeactivated) return 'DEACTIVATED'
  return 'OTHER'
}

function isSimActivatedAt(history, moment, fallbackStatus) {
  for (const row of history) {
    if (!isOverlappingPeriod(row.start_time, row.end_time, moment, moment)) continue
    return row.after_status === 'ACTIVATED'
  }
  return fallbackStatus === 'ACTIVATED'
}

function isSubscriptionActiveOnDay(sub, dayStart, dayEndExclusive) {
  const effectiveAt = sub.effective_at ? new Date(sub.effective_at) : null
  if (!effectiveAt || Number.isNaN(effectiveAt.getTime())) return false
  if (effectiveAt.getTime() >= dayEndExclusive.getTime()) return false
  if (sub.expires_at) {
    const expiresAt = new Date(sub.expires_at)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < dayStart.getTime()) return false
  }
  const state = String(sub.state || '').toUpperCase()
  if (state !== 'ACTIVE' && state !== 'PENDING') return false
  return true
}

function isSubscriptionActiveInPeriod(sub, rangeStart, rangeEnd) {
  const effectiveAt = sub.effective_at ? new Date(sub.effective_at) : null
  if (!effectiveAt || Number.isNaN(effectiveAt.getTime())) return false
  if (effectiveAt.getTime() >= rangeEnd.getTime()) return false
  if (sub.expires_at) {
    const expiresAt = new Date(sub.expires_at)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < rangeStart.getTime()) return false
  }
  const state = String(sub.state || '').toUpperCase()
  if (state !== 'ACTIVE' && state !== 'PENDING') return false
  return true
}

function resolveQuotaKb(pricePlan) {
  if (!pricePlan) return null
  const quotaMb = Number(pricePlan.quota_mb ?? pricePlan.per_sim_quota_mb ?? null)
  if (Number.isNaN(quotaMb) || quotaMb === null) return null
  return quotaMb
}

function resolveOverageRatePerKb(pricePlan) {
  if (!pricePlan) return null
  const rate = Number(pricePlan.overage_rate_per_mb ?? null)
  if (Number.isNaN(rate) || rate === null) return null
  return rate
}

function resolvePlanType(pricePlanRow) {
  if (!pricePlanRow || !pricePlanRow.type) return null
  return String(pricePlanRow.type).toUpperCase()
}

function resolvePlanCurrency(pricePlanRow) {
  if (!pricePlanRow || !pricePlanRow.currency) return 'USD'
  return String(pricePlanRow.currency)
}

function calculateProratedFee({ fee, effectiveAt, rangeStart, rangeEnd }) {
  if (!fee || !effectiveAt) return fee
  const effective = new Date(effectiveAt)
  if (Number.isNaN(effective.getTime())) return fee
  if (effective.getTime() < rangeStart.getTime() || effective.getTime() >= rangeEnd.getTime()) return fee
  const start = new Date(Date.UTC(effective.getUTCFullYear(), effective.getUTCMonth(), effective.getUTCDate(), 0, 0, 0, 0))
  const daysInMonth = new Date(Date.UTC(rangeStart.getUTCFullYear(), rangeStart.getUTCMonth() + 1, 0)).getUTCDate()
  const msPerDay = 24 * 60 * 60 * 1000
  const activeDays = Math.max(0, Math.ceil((rangeEnd.getTime() - start.getTime()) / msPerDay))
  const perDayFee = fee / Math.max(1, daysInMonth)
  return roundAmount(perDayFee * activeDays)
}

function calculateTieredCharge(usageKb, tiers) {
  const list = Array.isArray(tiers) ? tiers : []
  if (!list.length) return 0
  const sorted = list
    .map((t) => ({
      fromMb: Number(t?.fromMb),
      toMb: Number(t?.toMb),
      ratePerMb: Number(t?.ratePerMb),
    }))
    .filter((t) => Number.isFinite(t.fromMb) && Number.isFinite(t.toMb) && t.toMb > t.fromMb && Number.isFinite(t.ratePerMb) && t.ratePerMb >= 0)
    .sort((a, b) => a.fromMb - b.fromMb)
  if (!sorted.length) return 0
  let remaining = Math.max(0, usageKb)
  let total = 0
  for (const tier of sorted) {
    if (remaining <= 0) break
    const tierSize = Math.max(0, tier.toMb - tier.fromMb)
    const charged = Math.min(remaining, tierSize)
    total += charged * tier.ratePerMb
    remaining -= charged
  }
  if (remaining > 0) {
    const last = sorted[sorted.length - 1]
    total += remaining * last.ratePerMb
  }
  return roundAmount(total)
}

export async function computeMonthlyCharges({ enterpriseId, billPeriod, calculationId }, supabaseClient) {
  const supabase = supabaseClient || createSupabaseRestClient({ useServiceRole: true })
  if (!billPeriod) throw new Error('Missing billPeriod in payload')
  const calcId = calculationId || `calc-${Date.now()}`

  // 1. Determine period date range
  const startDate = new Date(`${billPeriod}-01T00:00:00Z`)
  const nextMonth = new Date(startDate)
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  const endDate = nextMonth
  const periodStart = startDate.toISOString().slice(0, 10)
  const periodEnd = endDate.toISOString().slice(0, 10)

  // 2. Fetch SIMs — paginated to handle >1000 SIMs
  const allSims = []
  const SIM_PAGE_SIZE = 500
  let simOffset = 0
  while (true) {
    let simQuery = `select=sim_id,iccid,enterprise_id,status&order=sim_id.asc&limit=${SIM_PAGE_SIZE}&offset=${simOffset}`
    if (enterpriseId) simQuery += `&enterprise_id=eq.${enterpriseId}`
    const { data: page } = await supabase.selectWithCount('sims', simQuery)
    if (!page || page.length === 0) break
    allSims.push(...page)
    if (page.length < SIM_PAGE_SIZE) break
    simOffset += SIM_PAGE_SIZE
  }
  const sims = allSims

  if (!sims || sims.length === 0) {
      console.log('[Billing] No SIMs found.')
      return { calculationId: calcId, totalBillAmount: 0, lineItems: [], ratingResults: [], currency: 'USD' }
  }
  console.log(`[Billing] Found ${sims.length} SIMs to process`)

  // 3. Pre-fetch Packages and Price Plans (unchanged — these are global/small sets)
  const packagesData = await supabase.select(
    'package_versions',
    'select=*,packages(*),price_plan_id,price_plan_version_id'
  )

  const packageMap = {}
  if (packagesData) {
    packagesData.forEach(p => {
      if (p.package_version_id) packageMap[p.package_version_id] = p
    })
  }

  const pricePlanIds = Object.values(packageMap)
    .map((p) => p?.price_plan_id)
    .filter(Boolean)
    .map((id) => String(id))
  const uniquePlanIds = Array.from(new Set(pricePlanIds))
  const versionIds = Object.values(packageMap)
    .map((p) => p?.price_plan_version_id)
    .filter(Boolean)
    .map((id) => String(id))
  const uniqueVersionIds = Array.from(new Set(versionIds))
  const latestPlanVersionMap = new Map()
  const versionByIdMap = new Map()
  if (uniquePlanIds.length) {
    const idFilter = uniquePlanIds.map((id) => encodeURIComponent(id)).join(',')
    const rows = await supabase.select(
      'price_plan_versions',
      `select=price_plan_version_id,price_plan_id,version,payg_rates,monthly_fee,deactivated_monthly_fee,quota_mb,per_sim_quota_mb,total_quota_mb,overage_rate_per_mb,tiers&price_plan_id=in.(${idFilter})&order=version.desc`
    )
    const versions = Array.isArray(rows) ? rows : []
    for (const version of versions) {
      if (version?.price_plan_version_id) {
        versionByIdMap.set(String(version.price_plan_version_id), version)
      }
      if (version?.price_plan_id && !latestPlanVersionMap.has(String(version.price_plan_id))) {
        latestPlanVersionMap.set(String(version.price_plan_id), version)
      }
    }
  }
  if (uniqueVersionIds.length) {
    const missing = uniqueVersionIds.filter((id) => !versionByIdMap.has(id))
    if (missing.length) {
      const idFilter = missing.map((id) => encodeURIComponent(id)).join(',')
      const rows = await supabase.select(
        'price_plan_versions',
        `select=price_plan_version_id,price_plan_id,version,payg_rates,monthly_fee,deactivated_monthly_fee,quota_mb,per_sim_quota_mb,total_quota_mb,overage_rate_per_mb,tiers&price_plan_version_id=in.(${idFilter})`
      )
      const versions = Array.isArray(rows) ? rows : []
      for (const version of versions) {
        if (version?.price_plan_version_id) versionByIdMap.set(String(version.price_plan_version_id), version)
        if (version?.price_plan_id && !latestPlanVersionMap.has(String(version.price_plan_id))) {
          latestPlanVersionMap.set(String(version.price_plan_id), version)
        }
      }
    }
  }
  for (const pkg of Object.values(packageMap)) {
    const planId = pkg?.price_plan_id ? String(pkg.price_plan_id) : null
    const versionId = pkg?.price_plan_version_id ? String(pkg.price_plan_version_id) : null
    const resolved = (planId ? latestPlanVersionMap.get(planId) : null) || (versionId ? versionByIdMap.get(versionId) : null) || null
    if (resolved) pkg.resolved_price_plan_version = resolved
  }
  const pricePlanMap = new Map()
  if (uniquePlanIds.length) {
    const idFilter = uniquePlanIds.map((id) => encodeURIComponent(id)).join(',')
    const planRows = await supabase.select(
      'price_plans',
      `select=price_plan_id,type,first_cycle_proration,currency&price_plan_id=in.(${idFilter})`
    )
    const plans = Array.isArray(planRows) ? planRows : []
    for (const plan of plans) {
      if (plan?.price_plan_id) pricePlanMap.set(String(plan.price_plan_id), plan)
    }
  }

  let totalBillAmount = 0
  const lineItems = []
  const ratingResults = []
  const currencyFallback = (() => {
    const firstPlan = pricePlanMap.size ? Array.from(pricePlanMap.values())[0] : null
    return resolvePlanCurrency(firstPlan)
  })()

  // ============================================================
  // FIX: Batch-fetch subscriptions, usage, and state history
  // instead of N+1 per-SIM queries (30万→3 queries)
  // ============================================================

  // Process SIMs in batches to avoid too-long IN clauses
  const BATCH_SIZE = 500
  const simContexts = []

  for (let batchStart = 0; batchStart < sims.length; batchStart += BATCH_SIZE) {
    const batch = sims.slice(batchStart, batchStart + BATCH_SIZE)
    const simIds = batch.map(s => s.sim_id)
    const simIdFilter = simIds.map(id => encodeURIComponent(id)).join(',')

    // Batch-fetch all 3 data sets in parallel
    const [allSubs, allUsage, allHistory] = await Promise.all([
      supabase.select('subscriptions', `select=*&sim_id=in.(${simIdFilter})`),
      supabase.select(
        'usage_daily_summary',
        `select=*&sim_id=in.(${simIdFilter})&usage_day=gte.${periodStart}&usage_day=lt.${periodEnd}`
      ),
      supabase.select(
        'sim_state_history',
        `select=sim_id,after_status,start_time,end_time&sim_id=in.(${simIdFilter})&start_time=lt.${endDate.toISOString()}`
      ),
    ])

    // Index by sim_id
    const subsBySimId = new Map()
    for (const sub of (Array.isArray(allSubs) ? allSubs : [])) {
      const key = sub.sim_id
      if (!subsBySimId.has(key)) subsBySimId.set(key, [])
      subsBySimId.get(key).push(sub)
    }
    const usageBySimId = new Map()
    for (const usage of (Array.isArray(allUsage) ? allUsage : [])) {
      const key = usage.sim_id
      if (!usageBySimId.has(key)) usageBySimId.set(key, [])
      usageBySimId.get(key).push(usage)
    }
    const historyBySimId = new Map()
    for (const h of (Array.isArray(allHistory) ? allHistory : [])) {
      const key = h.sim_id
      if (!historyBySimId.has(key)) historyBySimId.set(key, [])
      historyBySimId.get(key).push(h)
    }

    for (const sim of batch) {
      const subs = subsBySimId.get(sim.sim_id) || []
      const usageLogs = usageBySimId.get(sim.sim_id) || []
      const history = historyBySimId.get(sim.sim_id) || []
      if (subs.length === 0 && usageLogs.length === 0) continue
      const highWater = resolveHighWaterStatus(history, startDate, endDate, sim.status)
      simContexts.push({ sim, subs, usageLogs, history, highWater })
    }
  }

  // FIX: Sort simContexts by sim_id for deterministic pool usage order
  // This ensures FIXED_BUNDLE/SIM_DEPENDENT_BUNDLE shared pool deduction
  // follows a stable, reproducible order (alphabetical by sim_id).
  simContexts.sort((a, b) => String(a.sim.sim_id).localeCompare(String(b.sim.sim_id)))

  const packageCounts = new Map()
  for (const ctx of simContexts) {
    const subs = Array.isArray(ctx.subs) ? ctx.subs : []
    const counted = new Set()
    for (const sub of subs) {
      if (!isSubscriptionActiveInPeriod(sub, startDate, endDate)) continue
      const key = String(sub.package_version_id || '')
      if (!key || counted.has(key)) continue
      counted.add(key)
      const current = packageCounts.get(key) || { activated: 0, deactivated: 0 }
      if (ctx.highWater === 'ACTIVATED') current.activated += 1
      else if (ctx.highWater === 'DEACTIVATED') current.deactivated += 1
      packageCounts.set(key, current)
    }
  }

  const packagePool = new Map()
  for (const [packageVersionId, pkg] of Object.entries(packageMap)) {
    const pricePlanVersion = pkg?.resolved_price_plan_version ?? pkg?.price_plan_versions ?? null
    const pricePlanId = pkg?.price_plan_id
      ? String(pkg.price_plan_id)
      : pricePlanVersion?.price_plan_id
        ? String(pricePlanVersion.price_plan_id)
        : null
    const planRow = pricePlanId ? pricePlanMap.get(pricePlanId) : null
    const planType = resolvePlanType(planRow)
    const currency = resolvePlanCurrency(planRow)
    const counts = packageCounts.get(packageVersionId) || { activated: 0, deactivated: 0 }
    let totalQuotaMb = null
    if (planType === 'SIM_DEPENDENT_BUNDLE') {
      const perSim = Number(pricePlanVersion?.per_sim_quota_mb ?? 0)
      totalQuotaMb = Number.isFinite(perSim) ? perSim * counts.activated : null
    } else if (planType === 'FIXED_BUNDLE') {
      totalQuotaMb = Number(pricePlanVersion?.total_quota_mb ?? null)
    } else {
      totalQuotaMb = resolveQuotaKb(pricePlanVersion)
    }
    packagePool.set(packageVersionId, {
      planType,
      currency,
      totalQuotaMb,
      overageRatePerMb: resolveOverageRatePerKb(pricePlanVersion),
      tiers: pricePlanVersion?.tiers ?? null,
      pricePlanVersionId: pricePlanVersion?.price_plan_version_id ?? null,
      pricePlanId,
    })
  }

  const poolUsageByPackage = new Map()
  const tieredUsageByPackage = new Map()

  for (const ctx of simContexts) {
    const usageByPackage = new Map()
    const { sim, subs, usageLogs, history, highWater } = ctx

    if (subs) {
      for (const sub of subs) {
        const pkg = packageMap[sub.package_version_id]
        if (!pkg) continue
        const pricePlanVersion = pkg?.resolved_price_plan_version ?? pkg?.price_plan_versions ?? null
        const pricePlanId = pkg?.price_plan_id
          ? String(pkg.price_plan_id)
          : pricePlanVersion?.price_plan_id
            ? String(pricePlanVersion.price_plan_id)
            : null
        const planRow = pricePlanId ? pricePlanMap.get(pricePlanId) : null
        let fee = 0
        let feeType = 'NO_CHARGE'
        if (highWater === 'ACTIVATED') {
          fee = Number(pricePlanVersion?.monthly_fee || 0)
          feeType = 'MONTHLY_FEE'
        } else if (highWater === 'DEACTIVATED') {
          fee = Number(pricePlanVersion?.deactivated_monthly_fee || 0)
          feeType = 'DEACTIVATED_MONTHLY_FEE'
        }
        if (fee > 0 && planRow?.first_cycle_proration === 'DAILY_PRORATION') {
          fee = calculateProratedFee({ fee, effectiveAt: sub.effective_at, rangeStart: startDate, rangeEnd: endDate })
        }
        if (fee > 0) {
          lineItems.push({
            sim_id: sim.sim_id,
            item_type: 'MONTHLY_FEE',
            package_version_id: sub.package_version_id ?? null,
            amount: fee,
            metadata: {
              description: `${feeType} - ${pkg.packages?.name || pkg.package_version_id}`,
              currency: resolvePlanCurrency(planRow),
              chargeType: feeType,
              pricePlanVersionId: pricePlanVersion?.price_plan_version_id ?? null,
            },
          })
          totalBillAmount += fee
        }
      }
    }

    if (usageLogs && usageLogs.length > 0) {
      for (const log of usageLogs) {
        const totalKb = Number(log.total_kb || 0)
        if (totalKb <= 0) continue

        const visitedMccMnc = normalizeVisitedMccMnc(log.visited_mccmnc)
        const dayStart = new Date(`${log.usage_day}T00:00:00Z`)
        const dayEnd = new Date(dayStart)
        dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)
        const activeSubs = (subs || []).filter((s) => isSubscriptionActiveOnDay(s, dayStart, dayEnd))
        const validSubs = activeSubs.map(s => {
          const pkg = packageMap[s.package_version_id]
          return {
            ...s,
            subscription_kind: s.subscription_kind,
            roaming_profile: pkg?.roaming_profile
          }
        })

        const simActive = isSimActivatedAt(history, dayStart, sim.status)
        const match = simActive ? selectMatchingPackage(validSubs, visitedMccMnc, packageMap) : null

        let chargeAmount = 0
        let chargeType = 'IN_PACKAGE'
        let rateApplied = null
        let matchedPackageVersionId = null
        let matchedSubscriptionId = null
        let matchedPricePlanVersionId = null
        let deductFromPackageVersionId = null
        let inProfile = false
        let alerts = []
        let currency = currencyFallback

        if (match) {
          inProfile = true
          matchedPackageVersionId = match.pkg?.package_version_id ?? null
          matchedSubscriptionId = match.sub?.subscription_id ?? null
          const matchedPlanVersion = match.pkg?.resolved_price_plan_version ?? match.pkg?.price_plan_versions ?? null
          matchedPricePlanVersionId = matchedPlanVersion?.price_plan_version_id ?? match.pkg?.price_plan_version_id ?? null
          const pool = matchedPackageVersionId ? packagePool.get(String(matchedPackageVersionId)) : null
          const planType = pool?.planType ?? null
          if (planType === 'TIERED_VOLUME_PRICING') {
            const used = Number(tieredUsageByPackage.get(String(matchedPackageVersionId)) || 0)
            tieredUsageByPackage.set(String(matchedPackageVersionId), used + totalKb)
            chargeType = 'TIERED_VOLUME'
            deductFromPackageVersionId = matchedPackageVersionId
            currency = pool?.currency ?? currencyFallback
          } else if (planType === 'SIM_DEPENDENT_BUNDLE' || planType === 'FIXED_BUNDLE') {
            const usageKey = String(matchedPackageVersionId)
            const usedKb = Number(poolUsageByPackage.get(usageKey) || 0)
            const totalQuotaMb = pool?.totalQuotaMb
            if (totalQuotaMb === null || !Number.isFinite(totalQuotaMb)) {
              chargeType = 'IN_PACKAGE'
              deductFromPackageVersionId = matchedPackageVersionId
              poolUsageByPackage.set(usageKey, usedKb + totalKb)
            } else {
              const remainingKb = Math.max(0, totalQuotaMb - usedKb)
              const overKb = Math.max(0, totalKb - remainingKb)
              const overageRate = pool?.overageRatePerMb ?? 0
              chargeType = overKb > 0 ? 'OVERAGE' : 'IN_PACKAGE'
              rateApplied = overKb > 0 ? overageRate : null
              chargeAmount = overKb > 0 ? roundAmount(overKb * overageRate) : 0
              deductFromPackageVersionId = matchedPackageVersionId
              poolUsageByPackage.set(usageKey, usedKb + totalKb)
            }
            currency = pool?.currency ?? currencyFallback
          } else {
            const pricePlan = match.pkg?.resolved_price_plan_version ?? match.pkg?.price_plan_versions ?? null
            const quotaMb = resolveQuotaKb(pricePlan)
            const usageKey = `${sim.sim_id}:${matchedPackageVersionId || 'unknown'}`
            const usedKb = Number(usageByPackage.get(usageKey) || 0)
            if (quotaMb === null) {
              chargeType = 'IN_PACKAGE'
              deductFromPackageVersionId = matchedPackageVersionId
              usageByPackage.set(usageKey, usedKb + totalKb)
            } else {
              const remainingKb = Math.max(0, quotaMb - usedKb)
              const overKb = Math.max(0, totalKb - remainingKb)
              const overageRate = resolveOverageRatePerKb(pricePlan) ?? 0
              chargeType = overKb > 0 ? 'OVERAGE' : 'IN_PACKAGE'
              rateApplied = overKb > 0 ? overageRate : null
              chargeAmount = overKb > 0 ? roundAmount(overKb * overageRate) : 0
              deductFromPackageVersionId = matchedPackageVersionId
              usageByPackage.set(usageKey, usedKb + totalKb)
            }
            currency = pool?.currency ?? currencyFallback
          }
        } else {
          const mainSub = validSubs.find(s => s.subscription_kind === 'MAIN') || activeSubs.find(s => s.subscription_kind === 'MAIN')
          const mainPkg = mainSub ? packageMap[mainSub.package_version_id] : null
          const rate = resolvePaygRatePerKb(mainPkg, visitedMccMnc)
          const mainPlanVersion = mainPkg?.resolved_price_plan_version ?? mainPkg?.price_plan_versions ?? null
          matchedPricePlanVersionId = mainPlanVersion?.price_plan_version_id ?? mainPkg?.price_plan_version_id ?? null
          const mainPlanId = mainPkg?.price_plan_id ?? mainPlanVersion?.price_plan_id ?? null
          currency = resolvePlanCurrency(pricePlanMap.get(String(mainPlanId ?? '')))
          if (rate !== null) {
            chargeAmount = roundAmount(totalKb * rate)
            chargeType = simActive ? 'PAYG' : 'PAYG_INACTIVE'
            rateApplied = rate
            alerts = simActive ? ['UNEXPECTED_ROAMING'] : ['INACTIVE_USAGE', 'UNEXPECTED_ROAMING']
          } else {
            chargeType = simActive ? 'PAYG_RULE_MISSING' : 'PAYG_INACTIVE_RULE_MISSING'
            alerts = simActive ? ['UNEXPECTED_ROAMING', 'PAYG_RULE_MISSING'] : ['INACTIVE_USAGE', 'UNEXPECTED_ROAMING', 'PAYG_RULE_MISSING']
          }
        }

        ratingResults.push({
          calculation_id: calcId,
          rule_version_id: matchedPricePlanVersionId,
          enterprise_id: sim.enterprise_id ?? null,
          sim_id: sim.sim_id ?? null,
          iccid: sim.iccid ?? null,
          usage_day: log.usage_day ?? null,
          visited_mccmnc: visitedMccMnc ?? null,
          input_ref: log.input_ref ?? null,
          matched_subscription_id: matchedSubscriptionId,
          matched_package_version_id: matchedPackageVersionId,
          matched_price_plan_version_id: matchedPricePlanVersionId,
          classification: chargeType,
          charged_mb: Math.max(0, Math.floor(totalKb)),
          rate_per_mb: rateApplied,
          amount: chargeAmount,
          currency,
        })

        if (chargeAmount > 0) {
          lineItems.push({
            sim_id: sim.sim_id,
            item_type: 'USAGE_CHARGE',
            package_version_id: matchedPackageVersionId,
            amount: chargeAmount,
            metadata: {
              description: `Data Usage (${visitedMccMnc}) - ${chargeType}`,
              currency,
              chargeType,
              inProfile,
              visitedMccMnc,
              chargedMb: totalKb,
              ratePerMb: rateApplied,
              matchedPackageVersionId,
              matchedSubscriptionId,
              deductFromPackageVersionId,
              alerts,
              inputRef: log.input_ref ?? null,
            },
          })
          totalBillAmount += chargeAmount
        }
      }
    }
  }

  for (const [packageVersionId, usedKb] of tieredUsageByPackage.entries()) {
    const pool = packagePool.get(String(packageVersionId))
    if (!pool) continue
    const amount = calculateTieredCharge(Number(usedKb || 0), pool.tiers)
    if (amount <= 0) continue
    lineItems.push({
      sim_id: null,
      item_type: 'USAGE_CHARGE',
      package_version_id: packageVersionId,
      amount,
      metadata: {
        description: `Tiered Usage - ${packageVersionId}`,
        currency: pool.currency,
        chargeType: 'TIERED_VOLUME',
        chargedMb: Number(usedKb || 0),
        matchedPackageVersionId: packageVersionId,
        pricePlanVersionId: pool.pricePlanVersionId ?? null,
      },
    })
    totalBillAmount += amount
  }

  return {
    calculationId: calcId,
    totalBillAmount,
    lineItems,
    ratingResults,
    currency: currencyFallback,
  }
}

  // 7. Save Bill
export async function generateMonthlyBill(job, supabaseClient) {
  const supabase = supabaseClient || createSupabaseRestClient({ useServiceRole: true })
  const payload = job.payload || {}
  const { enterpriseId, billPeriod } = payload
  if (!billPeriod) throw new Error('Missing billPeriod in payload')
  const calculationId = payload.calculationId || job.job_id || `calc-${Date.now()}`
  console.log(`[Billing] Generating bill for period ${billPeriod}, enterprise: ${enterpriseId || 'ALL'}`)

  const startDate = new Date(`${billPeriod}-01T00:00:00Z`)
  const nextMonth = new Date(startDate)
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  const endDate = nextMonth
  const periodStartStr = startDate.toISOString().slice(0, 10)
  const periodEndStr = endDate.toISOString().slice(0, 10)

  // FIX: Idempotency check — skip if bill already exists for this enterprise+period
  if (enterpriseId) {
    const existing = await supabase.select(
      'bills',
      `select=bill_id,status,total_amount&enterprise_id=eq.${enterpriseId}&period_start=eq.${periodStartStr}&period_end=eq.${periodEndStr}&limit=1`
    )
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`[Billing] Bill already exists for enterprise ${enterpriseId} period ${billPeriod} (bill_id=${existing[0].bill_id}), skipping.`)
      return { billId: existing[0].bill_id, skipped: true, totalBillAmount: Number(existing[0].total_amount) }
    }
  }

  const result = await computeMonthlyCharges({ enterpriseId, billPeriod, calculationId }, supabase)

  const billRows = await supabase.insert('bills', {
    enterprise_id: enterpriseId,
    period_start: periodStartStr,
    period_end: periodEndStr,
    status: 'GENERATED',
    total_amount: result.totalBillAmount,
    currency: result.currency ?? 'USD',
  }, { returning: 'representation' })

  const billId = billRows && billRows.length > 0 ? billRows[0].bill_id : null

  if (billId && result.lineItems.length > 0) {
    const batchSize = 100
    for (let i = 0; i < result.lineItems.length; i += batchSize) {
      const batch = result.lineItems.slice(i, i + batchSize).map(item => ({
        ...item,
        bill_id: billId
      }))
      await supabase.insert('bill_line_items', batch)
    }
  }

  if (result.ratingResults.length > 0) {
    const batchSize = 200
    for (let i = 0; i < result.ratingResults.length; i += batchSize) {
      const batch = result.ratingResults.slice(i, i + batchSize)
      try {
        await supabase.insert('rating_results', batch, { returning: 'minimal', suppressMissingColumns: true })
      } catch (err) {
        const body = String(err?.body || '')
        if (body.includes('rule_version_id') && body.includes('PGRST204')) {
          const sanitized = batch.map(({ rule_version_id, ...rest }) => rest)
          await supabase.insert('rating_results', sanitized, { returning: 'minimal' })
        } else {
          throw err
        }
      }
    }
  }

  console.log(`[Billing] Bill ${billId} generated. Total: ${result.totalBillAmount}`)
}

export async function runBillingTask(job) {
    await generateMonthlyBill(job)
}
