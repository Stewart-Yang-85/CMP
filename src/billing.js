import { createSupabaseRestClient } from './supabaseRest.js'

/**
 * Billing Engine Implementation
 * Ported from tools/run_billing_engine.ps1
 */

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
  if (!mainPkg || !mainPkg.price_plan_versions || !mainPkg.price_plan_versions.payg_rates) return null
  
  const zones = mainPkg.price_plan_versions.payg_rates.zones
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
        bestRate = Number(zone.ratePerKb)
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
  const quotaKb = Number(pricePlan.quota_kb ?? pricePlan.per_sim_quota_kb ?? null)
  if (Number.isNaN(quotaKb) || quotaKb === null) return null
  return quotaKb
}

function resolveOverageRatePerKb(pricePlan) {
  if (!pricePlan) return null
  const rate = Number(pricePlan.overage_rate_per_kb ?? null)
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
  return Number((perDayFee * activeDays).toFixed(2))
}

function calculateTieredCharge(usageKb, tiers) {
  const list = Array.isArray(tiers) ? tiers : []
  if (!list.length) return 0
  const sorted = list
    .map((t) => ({
      fromKb: Number(t?.fromKb),
      toKb: Number(t?.toKb),
      ratePerKb: Number(t?.ratePerKb),
    }))
    .filter((t) => Number.isFinite(t.fromKb) && Number.isFinite(t.toKb) && t.toKb > t.fromKb && Number.isFinite(t.ratePerKb) && t.ratePerKb >= 0)
    .sort((a, b) => a.fromKb - b.fromKb)
  if (!sorted.length) return 0
  let remaining = Math.max(0, usageKb)
  let total = 0
  for (const tier of sorted) {
    if (remaining <= 0) break
    const tierSize = Math.max(0, tier.toKb - tier.fromKb)
    const charged = Math.min(remaining, tierSize)
    total += charged * tier.ratePerKb
    remaining -= charged
  }
  if (remaining > 0) {
    const last = sorted[sorted.length - 1]
    total += remaining * last.ratePerKb
  }
  return Number(total.toFixed(2))
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

  // 2. Fetch SIMs (simplified: all SIMs or by enterprise)
  let simQuery = 'select=sim_id,iccid,enterprise_id,status&limit=1000'
  if (enterpriseId) simQuery += `&enterprise_id=eq.${enterpriseId}`
  
  // supabaseRest selectWithCount returns { data, total }
  const { data: sims } = await supabase.selectWithCount('sims', simQuery)

  if (!sims || sims.length === 0) {
      console.log('[Billing] No SIMs found.')
      return
  }
  console.log(`[Billing] Found ${sims.length} SIMs to process`)

  // 3. Pre-fetch Packages and Price Plans
  // supabaseRest select returns array directly
  const packagesData = await supabase.select('package_versions', 'select=*,packages(*),price_plan_versions(*)')
  
  const packageMap = {}
  if (packagesData) {
    packagesData.forEach(p => {
      if (p.package_version_id) packageMap[p.package_version_id] = p
    })
  }

  const pricePlanIds = Object.values(packageMap)
    .map((p) => p?.price_plan_versions?.price_plan_id)
    .filter(Boolean)
    .map((id) => String(id))
  const uniquePlanIds = Array.from(new Set(pricePlanIds))
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

  const simContexts = []
  for (const sim of sims) {
    const subs = await supabase.select('subscriptions', `select=*&sim_id=eq.${sim.sim_id}`)
    const usageLogs = await supabase.select(
      'usage_daily_summary',
      `select=*&sim_id=eq.${sim.sim_id}&usage_day=gte.${startDate.toISOString().slice(0, 10)}&usage_day=lt.${endDate.toISOString().slice(0, 10)}`
    )
    const historyRows = await supabase.select(
      'sim_state_history',
      `select=after_status,start_time,end_time&sim_id=eq.${sim.sim_id}&start_time=lt.${endDate.toISOString()}`
    )
    const history = Array.isArray(historyRows) ? historyRows : []
    if ((!subs || subs.length === 0) && (!usageLogs || usageLogs.length === 0)) continue
    const highWater = resolveHighWaterStatus(history, startDate, endDate, sim.status)
    simContexts.push({ sim, subs, usageLogs, history, highWater })
  }

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
    const pricePlanVersion = pkg?.price_plan_versions ?? null
    const pricePlanId = pricePlanVersion?.price_plan_id ? String(pricePlanVersion.price_plan_id) : null
    const planRow = pricePlanId ? pricePlanMap.get(pricePlanId) : null
    const planType = resolvePlanType(planRow)
    const currency = resolvePlanCurrency(planRow)
    const counts = packageCounts.get(packageVersionId) || { activated: 0, deactivated: 0 }
    let totalQuotaKb = null
    if (planType === 'SIM_DEPENDENT_BUNDLE') {
      const perSim = Number(pricePlanVersion?.per_sim_quota_kb ?? 0)
      totalQuotaKb = Number.isFinite(perSim) ? perSim * counts.activated : null
    } else if (planType === 'FIXED_BUNDLE') {
      totalQuotaKb = Number(pricePlanVersion?.total_quota_kb ?? null)
    } else {
      totalQuotaKb = resolveQuotaKb(pricePlanVersion)
    }
    packagePool.set(packageVersionId, {
      planType,
      currency,
      totalQuotaKb,
      overageRatePerKb: resolveOverageRatePerKb(pricePlanVersion),
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
        const pricePlanVersion = pkg.price_plan_versions ?? null
        const pricePlanId = pricePlanVersion?.price_plan_id ? String(pricePlanVersion.price_plan_id) : null
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
          matchedPricePlanVersionId = match.pkg?.price_plan_versions?.price_plan_version_id ?? null
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
            const totalQuotaKb = pool?.totalQuotaKb
            if (totalQuotaKb === null || !Number.isFinite(totalQuotaKb)) {
              chargeType = 'IN_PACKAGE'
              deductFromPackageVersionId = matchedPackageVersionId
              poolUsageByPackage.set(usageKey, usedKb + totalKb)
            } else {
              const remainingKb = Math.max(0, totalQuotaKb - usedKb)
              const overKb = Math.max(0, totalKb - remainingKb)
              const overageRate = pool?.overageRatePerKb ?? 0
              chargeType = overKb > 0 ? 'OVERAGE' : 'IN_PACKAGE'
              rateApplied = overKb > 0 ? overageRate : null
              chargeAmount = overKb > 0 ? Number((overKb * overageRate).toFixed(2)) : 0
              deductFromPackageVersionId = matchedPackageVersionId
              poolUsageByPackage.set(usageKey, usedKb + totalKb)
            }
            currency = pool?.currency ?? currencyFallback
          } else {
            const pricePlan = match.pkg?.price_plan_versions ?? null
            const quotaKb = resolveQuotaKb(pricePlan)
            const usageKey = `${sim.sim_id}:${matchedPackageVersionId || 'unknown'}`
            const usedKb = Number(usageByPackage.get(usageKey) || 0)
            if (quotaKb === null) {
              chargeType = 'IN_PACKAGE'
              deductFromPackageVersionId = matchedPackageVersionId
              usageByPackage.set(usageKey, usedKb + totalKb)
            } else {
              const remainingKb = Math.max(0, quotaKb - usedKb)
              const overKb = Math.max(0, totalKb - remainingKb)
              const overageRate = resolveOverageRatePerKb(pricePlan) ?? 0
              chargeType = overKb > 0 ? 'OVERAGE' : 'IN_PACKAGE'
              rateApplied = overKb > 0 ? overageRate : null
              chargeAmount = overKb > 0 ? Number((overKb * overageRate).toFixed(2)) : 0
              deductFromPackageVersionId = matchedPackageVersionId
              usageByPackage.set(usageKey, usedKb + totalKb)
            }
            currency = pool?.currency ?? currencyFallback
          }
        } else {
          const mainSub = validSubs.find(s => s.subscription_kind === 'MAIN') || activeSubs.find(s => s.subscription_kind === 'MAIN')
          const mainPkg = mainSub ? packageMap[mainSub.package_version_id] : null
          const rate = resolvePaygRatePerKb(mainPkg, visitedMccMnc)
          matchedPricePlanVersionId = mainPkg?.price_plan_versions?.price_plan_version_id ?? null
          currency = resolvePlanCurrency(pricePlanMap.get(String(mainPkg?.price_plan_versions?.price_plan_id ?? '')))
          if (rate !== null) {
            chargeAmount = Number((totalKb * rate).toFixed(2))
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
          charged_kb: Math.max(0, Math.floor(totalKb)),
          rate_per_kb: rateApplied,
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
              chargedKb: totalKb,
              ratePerKb: rateApplied,
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
        chargedKb: Number(usedKb || 0),
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

  const result = await computeMonthlyCharges({ enterpriseId, billPeriod, calculationId }, supabase)

  const startDate = new Date(`${billPeriod}-01T00:00:00Z`)
  const nextMonth = new Date(startDate)
  nextMonth.setMonth(nextMonth.getMonth() + 1)
  const endDate = nextMonth

  const billRows = await supabase.insert('bills', {
    enterprise_id: enterpriseId,
    period_start: startDate.toISOString().slice(0, 10),
    period_end: endDate.toISOString().slice(0, 10),
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
