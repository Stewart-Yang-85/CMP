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

/** Normalize DB covered_network_profile_entries (mcc,mnc) to the same key as visited_mccmnc. */
function normalizeCoveredEntryMccMnc(mcc, mnc) {
  const m = String(mcc ?? '').trim()
  let n = String(mnc ?? '').trim()
  if (!m || !n) return ''
  if (n.length === 2) n = `0${n}`
  return normalizeVisitedMccMnc(`${m}-${n}`)
}

function ingestCoveredRowsIntoMap(entryRows, targetMap) {
  const rows = Array.isArray(entryRows) ? entryRows : []
  for (const row of rows) {
    const pid = row.covered_network_profile_id ? String(row.covered_network_profile_id).trim() : ''
    if (!pid) continue
    const key = normalizeCoveredEntryMccMnc(row.mcc, row.mnc)
    if (!key) continue
    if (!targetMap.has(pid)) targetMap.set(pid, new Set())
    targetMap.get(pid).add(key)
  }
}

/** True when visited PLMN matches any Covered entry (`234-015` exact or `234-*` mcc wildcard). */
function coveredEntrySetIncludes(patternSet, visitedMccMnc) {
  if (!(patternSet instanceof Set) || patternSet.size === 0) return false
  for (const pattern of patternSet) {
    if (matchMccMncPattern(visitedMccMnc, pattern)) return true
  }
  return false
}

/**
 * In-profile visit: Phase 30 — CoveredNetworkProfile via price plan; legacy packages use package.roaming_profile allowlist.
 * @param {Map<string, Set<string>>} coveredEntrySets profileId -> normalized patterns (`mcc-mnc` or `mcc-*`)
 */
function subscriptionMatchesInProfileVisit(sub, pkg, visitedMccMnc, coveredEntrySets) {
  const planVersion = pkg?.resolved_price_plan_version ?? pkg?.price_plans ?? null
  const coveredIdRaw = planVersion?.covered_network_profile_id
  const coveredId = coveredIdRaw ? String(coveredIdRaw).trim() : ''
  if (coveredId) {
    if (!(coveredEntrySets instanceof Map) || !coveredEntrySets.has(coveredId)) return false
    return coveredEntrySetIncludes(coveredEntrySets.get(coveredId), visitedMccMnc)
  }
  return coverageIncludes(pkg.roaming_profile, visitedMccMnc)
}

function inProfileNarrownessScore(pkg, coveredEntrySets) {
  const planVersion = pkg?.resolved_price_plan_version ?? pkg?.price_plans ?? null
  const coveredIdRaw = planVersion?.covered_network_profile_id
  const coveredId = coveredIdRaw ? String(coveredIdRaw).trim() : ''
  if (coveredId) {
    if (!(coveredEntrySets instanceof Map) || !coveredEntrySets.has(coveredId)) return 999999
    return coveredEntrySets.get(coveredId).size
  }
  return coverageNarrownessScore(pkg.roaming_profile)
}

// Helper: Select best matching package (in-profile only — billing-api §4.2 step 3a)
function selectMatchingPackage(subscriptions, visitedMccMnc, packageDetailsMap, coveredEntrySets) {
  const subs = Array.isArray(subscriptions) ? subscriptions : []
  const covMap = coveredEntrySets instanceof Map ? coveredEntrySets : new Map()

  const addOns = subs.filter((s) => s.subscription_kind === 'ADD_ON')
  const addOnCandidates = []
  for (const sub of addOns) {
    const pkg = packageDetailsMap[sub.package_id]
    if (!pkg) continue
    if (subscriptionMatchesInProfileVisit(sub, pkg, visitedMccMnc, covMap)) {
      addOnCandidates.push({ sub, pkg })
    }
  }
  if (addOnCandidates.length > 0) {
    addOnCandidates.sort((a, b) => {
      const scoreA = inProfileNarrownessScore(a.pkg, covMap)
      const scoreB = inProfileNarrownessScore(b.pkg, covMap)
      if (scoreA !== scoreB) return scoreA - scoreB
      return String(a.sub.package_id).localeCompare(String(b.sub.package_id))
    })
    return addOnCandidates[0]
  }

  const mains = subs.filter((s) => s.subscription_kind === 'MAIN')
  const mainCandidates = []
  for (const sub of mains) {
    const pkg = packageDetailsMap[sub.package_id]
    if (!pkg) continue
    if (subscriptionMatchesInProfileVisit(sub, pkg, visitedMccMnc, covMap)) {
      mainCandidates.push({ sub, pkg })
    }
  }
  if (mainCandidates.length > 0) {
    mainCandidates.sort((a, b) => {
      const scoreA = inProfileNarrownessScore(a.pkg, covMap)
      const scoreB = inProfileNarrownessScore(b.pkg, covMap)
      if (scoreA !== scoreB) return scoreA - scoreB
      return String(a.sub.package_id).localeCompare(String(b.sub.package_id))
    })
    return mainCandidates[0]
  }
  return null
}

/** OOP roaming: Package → carrier_service_config.roamingProfileId only (pricing-api / billing-api §4.2.3b). */
function extractRoamingProfileIdFromPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return null
  const cfg = pkg.carrier_service_config
  if (cfg && typeof cfg === 'object' && cfg.roamingProfileId) {
    const id = String(cfg.roamingProfileId).trim()
    return id || null
  }
  return null
}

function buildRoamingTariffLookup(mccmncList) {
  const map = new Map()
  const list = Array.isArray(mccmncList) ? mccmncList : []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const mcc = entry.mcc != null ? String(entry.mcc).trim() : ''
    let mnc = entry.mnc != null ? String(entry.mnc).trim() : ''
    if (!mcc || !mnc) continue
    if (mnc.length === 2) mnc = `0${mnc}`
    const norm = normalizeVisitedMccMnc(`${mcc}-${mnc}`)
    const rate = Number(entry.ratePerMb)
    if (!norm || !Number.isFinite(rate)) continue
    if (!map.has(norm)) map.set(norm, rate)
  }
  return map
}

function resolveOopRoamingRatePerMb(pkg, visitedMccMnc, roamingTariffByProfileId) {
  const rid = extractRoamingProfileIdFromPackage(pkg)
  if (!rid || !(roamingTariffByProfileId instanceof Map) || !roamingTariffByProfileId.has(rid)) return null
  const lookup = roamingTariffByProfileId.get(rid)
  const v = normalizeVisitedMccMnc(visitedMccMnc)
  if (lookup.has(v)) return lookup.get(v)
  const mcc = v.match(/^(\d{3})-/)
  if (mcc) {
    const wildcardKey = `${mcc[1]}-*`
    if (lookup.has(wildcardKey)) return lookup.get(wildcardKey)
  }
  return null
}

/** ADD_ON first, then MAIN — first package with carrier roaming tariff for visited MCC/MNC. */
function findFirstOopRoamingRate(activeSubs, packageMap, visitedMccMnc, roamingTariffByProfileId) {
  const subs = Array.isArray(activeSubs) ? activeSubs : []
  const ordered = subs
    .filter((s) => s.subscription_kind === 'ADD_ON' || s.subscription_kind === 'MAIN')
    .slice()
    .sort((a, b) => {
      const ao = a.subscription_kind === 'ADD_ON' ? 0 : 1
      const bo = b.subscription_kind === 'ADD_ON' ? 0 : 1
      if (ao !== bo) return ao - bo
      return String(a.package_id || '').localeCompare(String(b.package_id || ''))
    })
  for (const sub of ordered) {
    const pkg = packageMap[sub.package_id]
    if (!pkg) continue
    const rate = resolveOopRoamingRatePerMb(pkg, visitedMccMnc, roamingTariffByProfileId)
    if (rate !== null) return { sub, pkg, ratePerMb: rate }
  }
  return null
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

function resolveQuotaMb(pricePlan) {
  if (!pricePlan) return null
  const quotaMb = Number(pricePlan.quota_mb ?? pricePlan.per_sim_quota_mb ?? null)
  if (Number.isNaN(quotaMb) || quotaMb === null) return null
  return quotaMb
}

function resolveOverageRatePerMb(pricePlan) {
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

function calculateTieredCharge(usageMb, tiers) {
  const sorted = normalizeTiers(tiers)
  if (!sorted.length) return 0
  let remaining = Math.max(0, usageMb)
  let total = 0
  for (const tier of sorted) {
    if (remaining <= 0) break
    const tierSize = Math.max(0, tier.toMb - tier.fromMb)
    const charged = Math.min(remaining, tierSize)
    total += charged * tier.ratePerMb
    remaining -= charged
  }
  return roundAmount(total)
}

function normalizeTiers(tiers) {
  const list = Array.isArray(tiers) ? tiers : []
  return list
    .map((t) => ({
      fromMb: Number(t?.fromMb),
      toMb: Number(t?.toMb),
      ratePerMb: Number(t?.ratePerMb),
    }))
    .filter((t) => Number.isFinite(t.fromMb) && Number.isFinite(t.toMb) && t.toMb > t.fromMb && Number.isFinite(t.ratePerMb) && t.ratePerMb >= 0)
    .sort((a, b) => a.fromMb - b.fromMb)
}

function resolveTierLimitMb(tiers) {
  const sorted = normalizeTiers(tiers)
  if (!sorted.length) return null
  return sorted[sorted.length - 1].toMb
}

export async function computeMonthlyCharges({ enterpriseId, billPeriod, calculationId, logPrefix }, supabaseClient) {
  const supabase = supabaseClient || createSupabaseRestClient({ useServiceRole: true })
  if (!billPeriod) throw new Error('Missing billPeriod in payload')
  const calcId = calculationId || `calc-${Date.now()}`
  const tag = String(logPrefix || 'Billing').trim() || 'Billing'

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
    let simQuery = `select=sim_id,iccid,enterprise_id,status,supplier_id,operator_id&order=sim_id.asc&limit=${SIM_PAGE_SIZE}&offset=${simOffset}`
    if (enterpriseId) simQuery += `&enterprise_id=eq.${enterpriseId}`
    const { data: page } = await supabase.selectWithCount('sims', simQuery)
    if (!page || page.length === 0) break
    allSims.push(...page)
    if (page.length < SIM_PAGE_SIZE) break
    simOffset += SIM_PAGE_SIZE
  }
  const sims = allSims

  if (!sims || sims.length === 0) {
      console.log(`[${tag}] No SIMs found.`)
      return { calculationId: calcId, totalBillAmount: 0, lineItems: [], ratingResults: [], currency: 'USD' }
  }
  console.log(`[${tag}] Found ${sims.length} SIMs to process`)

  const enterpriseParentResellerById = new Map()
  const enterpriseIdsForFallback = [
    ...new Set(sims.map((s) => (s?.enterprise_id ? String(s.enterprise_id).trim() : '')).filter(Boolean)),
  ]
  if (enterpriseIdsForFallback.length) {
    const ef = enterpriseIdsForFallback.map((id) => encodeURIComponent(id)).join(',')
    const rows = await supabase.select('tenants', `select=tenant_id,parent_id&tenant_id=in.(${ef})`)
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = row?.tenant_id ? String(row.tenant_id).trim() : ''
      if (id) enterpriseParentResellerById.set(id, row?.parent_id ? String(row.parent_id).trim() : null)
    }
  }

  const fallbackPackageByScope = new Map()
  const fallbackRows = await supabase.select(
    'default_fallback_package_mappings',
    'select=enterprise_id,reseller_id,supplier_id,operator_id,package_id&status=eq.ACTIVE'
  )
  for (const row of Array.isArray(fallbackRows) ? fallbackRows : []) {
    const enterpriseId = row?.enterprise_id ? String(row.enterprise_id).trim() : ''
    const resellerId = row?.reseller_id ? String(row.reseller_id).trim() : ''
    const supplierId = row?.supplier_id ? String(row.supplier_id).trim() : ''
    const operatorId = row?.operator_id ? String(row.operator_id).trim() : ''
    const packageId = row?.package_id ? String(row.package_id).trim() : ''
    if (enterpriseId && resellerId && supplierId && operatorId && packageId) {
      fallbackPackageByScope.set(`${enterpriseId}|${resellerId}|${supplierId}|${operatorId}`, packageId)
    }
  }

  // 3. Pre-fetch Packages and Price Plans (unchanged — these are global/small sets)
  const packagesData = await supabase.select(
    'packages',
    'select=*'
  )

  const packageMap = {}
  if (packagesData) {
    packagesData.forEach(p => {
      if (p.package_id) packageMap[p.package_id] = p
    })
  }

  /** Phase 34: hydrate in-memory `carrier_service_config` + `roaming_profile` from `carrier_service_modules` columns (+ roaming rows). */
  const carrierRowById = new Map()
  const carrierIdsForHydrate = [
    ...new Set(
      Object.values(packageMap)
        .map((p) => (p?.carrier_service_id ? String(p.carrier_service_id).trim() : ''))
        .filter(Boolean)
    ),
  ]
  if (carrierIdsForHydrate.length) {
    const cf = carrierIdsForHydrate.map((id) => encodeURIComponent(id)).join(',')
    const csRows = await supabase.select(
      'carrier_service_modules',
      `select=carrier_service_id,supplier_id,operator_id,apn_profile_id,roaming_profile_id,rat&carrier_service_id=in.(${cf})`
    )
    for (const r of Array.isArray(csRows) ? csRows : []) {
      const id = r?.carrier_service_id ? String(r.carrier_service_id).trim() : ''
      if (id) carrierRowById.set(id, r)
    }
  }
  function mergedCarrierConfigFromModuleRow(row) {
    if (!row || typeof row !== 'object') return {}
    const supplierId = row.supplier_id != null ? String(row.supplier_id).trim() : ''
    const operatorId = row.operator_id != null ? String(row.operator_id).trim() : ''
    const apnProfileId =
      row.apn_profile_id != null && String(row.apn_profile_id).trim() !== '' ? String(row.apn_profile_id).trim() : ''
    const roamingProfileId =
      row.roaming_profile_id != null && String(row.roaming_profile_id).trim() !== ''
        ? String(row.roaming_profile_id).trim()
        : ''
    const rowRat = row.rat != null ? String(row.rat).trim() : ''
    let rat = (rowRat || '4G').toUpperCase().replace(/-/g, '')
    if (rat === 'NBIOT' || rat === 'NB_IOT') rat = 'NB-IOT'
    if (!['3G', '4G', '5G', 'NB-IOT'].includes(rat)) rat = '4G'
    return { supplierId, operatorId, apnProfileId, roamingProfileId, rat }
  }
  function mccmncAllowlistFromRoamingList(mccmncList) {
    const list = Array.isArray(mccmncList) ? mccmncList : []
    const mccmnc = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const mcc = entry.mcc != null ? String(entry.mcc).trim() : ''
      let mnc = entry.mnc != null ? String(entry.mnc).trim() : ''
      if (!mcc || !mnc) continue
      if (mnc === '*') mccmnc.push(`${mcc}-*`)
      else {
        if (mnc.length === 2) mnc = `0${mnc}`
        mccmnc.push(`${mcc}-${mnc}`)
      }
    }
    return { type: 'MCCMNC_ALLOWLIST', mccmnc }
  }
  for (const pkg of Object.values(packageMap)) {
    const cid = pkg?.carrier_service_id ? String(pkg.carrier_service_id).trim() : ''
    const cs = cid ? carrierRowById.get(cid) : null
    if (cs) {
      pkg.carrier_service_config = mergedCarrierConfigFromModuleRow(cs)
    }
  }

  const pricePlanIds = Object.values(packageMap)
    .map((p) => p?.price_plan_id)
    .filter(Boolean)
    .map((id) => String(id))
  const uniquePlanIds = Array.from(new Set(pricePlanIds))
  const latestPlanVersionMap = new Map()
  if (uniquePlanIds.length) {
    const idFilter = uniquePlanIds.map((id) => encodeURIComponent(id)).join(',')
    const rows = await supabase.select(
      'price_plans_expanded',
      `select=price_plan_id,version,type,first_cycle_proration,currency,monthly_fee,deactivated_monthly_fee,quota_mb,per_sim_quota_mb,total_quota_mb,overage_rate_per_mb,tiers,covered_network_profile_id&price_plan_id=in.(${idFilter})`
    )
    const versions = Array.isArray(rows) ? rows : []
    for (const version of versions) {
      if (version?.price_plan_id) {
        latestPlanVersionMap.set(String(version.price_plan_id), version)
      }
    }
  }
  const coveredEntrySets = new Map()
  const coveredIdsForFetch = [
    ...new Set(
      [...latestPlanVersionMap.values()]
        .map((v) => (v?.covered_network_profile_id ? String(v.covered_network_profile_id).trim() : ''))
        .filter(Boolean)
    ),
  ]
  if (coveredIdsForFetch.length) {
    const cf = coveredIdsForFetch.map((id) => encodeURIComponent(id)).join(',')
    const entryRows = await supabase.select(
      'covered_network_profile_entries',
      `select=covered_network_profile_id,mcc,mnc&covered_network_profile_id=in.(${cf})`
    )
    ingestCoveredRowsIntoMap(entryRows, coveredEntrySets)
  }
  for (const pkg of Object.values(packageMap)) {
    const planId = pkg?.price_plan_id ? String(pkg.price_plan_id) : null
    const resolved = planId ? latestPlanVersionMap.get(planId) : null
    if (resolved) pkg.resolved_price_plan_version = resolved
  }
  const pricePlanMap = new Map()
  for (const version of latestPlanVersionMap.values()) {
    if (version?.price_plan_id) pricePlanMap.set(String(version.price_plan_id), version)
  }

  const roamingTariffByProfileId = new Map()
  const roamingIdsForFetch = [
    ...new Set(
      Object.values(packageMap)
        .map((p) => extractRoamingProfileIdFromPackage(p))
        .filter(Boolean)
        .map(String)
    ),
  ]
  const roamingAllowlistById = new Map()
  if (roamingIdsForFetch.length) {
    const rf = roamingIdsForFetch.map((id) => encodeURIComponent(id)).join(',')
    const rpRows = await supabase.select(
      'roaming_profiles',
      `select=roaming_profile_id,mccmnc_list&roaming_profile_id=in.(${rf})`
    )
    for (const rp of Array.isArray(rpRows) ? rpRows : []) {
      const rid = rp?.roaming_profile_id ? String(rp.roaming_profile_id).trim() : ''
      if (!rid) continue
      roamingTariffByProfileId.set(rid, buildRoamingTariffLookup(rp.mccmnc_list))
      roamingAllowlistById.set(rid, mccmncAllowlistFromRoamingList(rp.mccmnc_list))
    }
  }
  for (const pkg of Object.values(packageMap)) {
    const rid = extractRoamingProfileIdFromPackage(pkg)
    if (rid && roamingAllowlistById.has(rid) && !pkg.roaming_profile) {
      const base = roamingAllowlistById.get(rid)
      const cfg = pkg.carrier_service_config && typeof pkg.carrier_service_config === 'object' ? pkg.carrier_service_config : {}
      pkg.roaming_profile = {
        ...base,
        rat: cfg.rat != null ? String(cfg.rat).trim() : '4G',
        profileId: rid,
        ...(cfg.apnProfileId ? { apnProfileId: String(cfg.apnProfileId).trim() } : {}),
      }
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
      const key = String(sub.package_id || '')
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
    const pricePlanVersion = pkg?.resolved_price_plan_version ?? pkg?.price_plans ?? null
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
      totalQuotaMb = resolveQuotaMb(pricePlanVersion)
    }
    packagePool.set(packageVersionId, {
      planType,
      currency,
      totalQuotaMb,
      overageRatePerMb: resolveOverageRatePerMb(pricePlanVersion),
      tiers: pricePlanVersion?.tiers ?? null,
      pricePlanId: pricePlanVersion?.price_plan_id ?? null,
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
        const pkg = packageMap[sub.package_id]
        if (!pkg) continue
        const pricePlanVersion = pkg?.resolved_price_plan_version ?? pkg?.price_plans ?? null
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
            package_id: sub.package_id ?? null,
            amount: fee,
            metadata: {
              description: `${feeType} - ${pkg.name || pkg.package_id}`,
              currency: resolvePlanCurrency(planRow),
              chargeType: feeType,
              pricePlanId: pricePlanVersion?.price_plan_id ?? null,
            },
          })
          totalBillAmount += fee
        }
      }
    }

    if (usageLogs && usageLogs.length > 0) {
      for (const log of usageLogs) {
        const totalMb = Number(log.total_mb ?? 0)
        if (totalMb <= 0) continue

        const visitedMccMnc = normalizeVisitedMccMnc(log.visited_mccmnc)
        const dayStart = new Date(`${log.usage_day}T00:00:00Z`)
        const dayEnd = new Date(dayStart)
        dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)
        const activeSubs = (subs || []).filter((s) => isSubscriptionActiveOnDay(s, dayStart, dayEnd))
        const validSubs = activeSubs.map(s => {
          const pkg = packageMap[s.package_id]
          return {
            ...s,
            subscription_kind: s.subscription_kind,
            roaming_profile: pkg?.roaming_profile
          }
        })

        const simActive = isSimActivatedAt(history, dayStart, sim.status)
        const match = simActive ? selectMatchingPackage(validSubs, visitedMccMnc, packageMap, coveredEntrySets) : null

        let chargeAmount = 0
        let chargeType = 'IN_PACKAGE'
        let rateApplied = null
        let matchedPackageVersionId = null
        let matchedSubscriptionId = null
        let matchedPricePlanId = null
        let deductFromPackageVersionId = null
        let inProfile = false
        let alerts = []
        let currency = currencyFallback

        const pushRatedUsage = ({
          usageMb,
          classification,
          amount = 0,
          ratePerMb = null,
          packageId = null,
          subscriptionId = null,
          pricePlanId = null,
          ratedCurrency = currencyFallback,
          lineAlerts = [],
          deductPackageId = null,
          ratedInProfile = false,
        }) => {
          const chargedMb = Math.max(0, Number(usageMb || 0))
          if (chargedMb <= 0) return
          ratingResults.push({
            calculation_id: calcId,
            rule_version_id: pricePlanId,
            enterprise_id: sim.enterprise_id ?? null,
            sim_id: sim.sim_id ?? null,
            iccid: sim.iccid ?? null,
            usage_day: log.usage_day ?? null,
            visited_mccmnc: visitedMccMnc ?? null,
            input_ref: log.input_ref ?? null,
            matched_subscription_id: subscriptionId,
            matched_package_id: packageId,
            matched_price_plan_id: pricePlanId,
            classification,
            charged_mb: Math.max(0, Math.floor(chargedMb)),
            rate_per_mb: ratePerMb,
            amount,
            currency: ratedCurrency,
          })
          if (amount > 0) {
            lineItems.push({
              sim_id: sim.sim_id,
              item_type: 'USAGE_CHARGE',
              package_id: packageId,
              amount,
              metadata: {
                description: `Data Usage (${visitedMccMnc}) - ${classification}`,
                currency: ratedCurrency,
                chargeType: classification,
                inProfile: ratedInProfile,
                visitedMccMnc,
                chargedMb,
                ratePerMb,
                matchedPackageVersionId: packageId,
                matchedSubscriptionId: subscriptionId,
                deductFromPackageVersionId: deductPackageId,
                alerts: lineAlerts,
                inputRef: log.input_ref ?? null,
              },
            })
            totalBillAmount += amount
          }
        }

        const resolveFallbackPackage = () => {
          const enterpriseResellerId = sim?.enterprise_id
            ? enterpriseParentResellerById.get(String(sim.enterprise_id).trim()) ?? null
            : null
          const simSupplierId = sim?.supplier_id ? String(sim.supplier_id).trim() : ''
          const simOperatorId = sim?.operator_id ? String(sim.operator_id).trim() : ''
          const fallbackPackageId =
            sim?.enterprise_id && enterpriseResellerId && simSupplierId && simOperatorId
              ? fallbackPackageByScope.get(`${String(sim.enterprise_id).trim()}|${enterpriseResellerId}|${simSupplierId}|${simOperatorId}`)
              : null
          return fallbackPackageId ? packageMap[fallbackPackageId] : null
        }

        const pushFallbackUsage = (usageMb, extraAlerts = []) => {
          const fallbackPkg = resolveFallbackPackage()
          if (!fallbackPkg) {
            pushRatedUsage({
              usageMb,
              classification: 'UNCLASSIFIED',
              amount: 0,
              lineAlerts: ['FALLBACK_PACKAGE_MISSING', ...extraAlerts],
            })
            return
          }
          const fallbackPlanVersion = fallbackPkg?.resolved_price_plan_version ?? fallbackPkg?.price_plans ?? null
          const fallbackPricePlanId = fallbackPlanVersion?.price_plan_id ?? fallbackPkg?.price_plan_id ?? null
          const fallbackPlanId = fallbackPkg?.price_plan_id ?? fallbackPricePlanId
          const fallbackCurrency = resolvePlanCurrency(pricePlanMap.get(String(fallbackPlanId ?? '')))
          const fallbackRate = resolveOopRoamingRatePerMb(fallbackPkg, visitedMccMnc, roamingTariffByProfileId)
          if (fallbackRate !== null) {
            pushRatedUsage({
              usageMb,
              classification: 'OOP_ROAMING',
              amount: roundAmount(Number(usageMb || 0) * fallbackRate),
              ratePerMb: fallbackRate,
              packageId: fallbackPkg?.package_id ?? null,
              subscriptionId: null,
              pricePlanId: fallbackPricePlanId,
              ratedCurrency: fallbackCurrency,
              lineAlerts: ['OUT_OF_PROFILE_ROAMING', 'FALLBACK_PACKAGE_RATED', ...extraAlerts],
            })
          } else {
            pushRatedUsage({
              usageMb,
              classification: 'UNCLASSIFIED',
              amount: 0,
              packageId: fallbackPkg?.package_id ?? null,
              subscriptionId: null,
              pricePlanId: fallbackPricePlanId,
              ratedCurrency: fallbackCurrency,
              lineAlerts: ['FALLBACK_PACKAGE_RATED', 'UNCLASSIFIED_USAGE', ...extraAlerts],
            })
          }
        }

        const pushMainOrFallbackUsage = (usageMb) => {
          const mainSub = validSubs.find(s => s.subscription_kind === 'MAIN') || activeSubs.find(s => s.subscription_kind === 'MAIN')
          const mainPkg = mainSub ? packageMap[mainSub.package_id] : null
          if (!mainSub || !mainPkg) {
            pushFallbackUsage(usageMb, ['MAIN_PACKAGE_MISSING'])
            return
          }
          if (subscriptionMatchesInProfileVisit(mainSub, mainPkg, visitedMccMnc, coveredEntrySets)) {
            pushMatchedPackageUsage({ sub: mainSub, pkg: mainPkg, usageMb, overflowTarget: 'fallback' })
            return
          }
          const oop = findFirstOopRoamingRate([mainSub], packageMap, visitedMccMnc, roamingTariffByProfileId)
          if (oop && !oop.missingRate) {
            const oopPlanVer = oop.pkg?.resolved_price_plan_version ?? oop.pkg?.price_plans ?? null
            const oopPricePlanId = oopPlanVer?.price_plan_id ?? oop.pkg?.price_plan_id ?? null
            const oopPlanId = oop.pkg?.price_plan_id ?? oopPricePlanId
            pushRatedUsage({
              usageMb,
              classification: 'OOP_ROAMING',
              amount: roundAmount(Number(usageMb || 0) * oop.ratePerMb),
              ratePerMb: oop.ratePerMb,
              packageId: oop.pkg?.package_id ?? null,
              subscriptionId: oop.sub?.subscription_id ?? null,
              pricePlanId: oopPricePlanId,
              ratedCurrency: resolvePlanCurrency(pricePlanMap.get(String(oopPlanId ?? ''))),
              lineAlerts: ['OUT_OF_PROFILE_ROAMING'],
            })
          } else {
            pushFallbackUsage(usageMb, ['MAIN_PACKAGE_UNABLE_TO_RATE'])
          }
        }

        function pushMatchedPackageUsage({ sub, pkg, usageMb, overflowTarget }) {
          const packageId = pkg?.package_id ?? null
          const planVersion = pkg?.resolved_price_plan_version ?? pkg?.price_plans ?? null
          const pricePlanId = planVersion?.price_plan_id ?? pkg?.price_plan_id ?? null
          const pool = packageId ? packagePool.get(String(packageId)) : null
          const planType = pool?.planType ?? null
          const ratedCurrency = pool?.currency ?? resolvePlanCurrency(pricePlanMap.get(String(pkg?.price_plan_id ?? pricePlanId ?? '')))
          if (planType === 'TIERED_VOLUME_PRICING') {
            const used = Number(tieredUsageByPackage.get(String(packageId)) || 0)
            const limitMb = resolveTierLimitMb(pool?.tiers)
            const remainingMb = limitMb === null ? Number(usageMb || 0) : Math.max(0, limitMb - used)
            const tieredMb = Math.min(Number(usageMb || 0), remainingMb)
            const overflowMb = Math.max(0, Number(usageMb || 0) - tieredMb)
            if (tieredMb > 0) {
              tieredUsageByPackage.set(String(packageId), used + tieredMb)
              pushRatedUsage({
                usageMb: tieredMb,
                classification: 'TIERED_VOLUME',
                packageId,
                subscriptionId: sub?.subscription_id ?? null,
                pricePlanId,
                ratedCurrency,
                deductPackageId: packageId,
                ratedInProfile: true,
              })
            }
            if (overflowMb > 0) pushFallbackUsage(overflowMb, ['TIERED_CAP_EXHAUSTED'])
            return
          }
          if (planType === 'SIM_DEPENDENT_BUNDLE' || planType === 'FIXED_BUNDLE') {
            const usageKey = String(packageId)
            const usedMb = Number(poolUsageByPackage.get(usageKey) || 0)
            const totalQuotaMb = pool?.totalQuotaMb
            let amount = 0
            let rate = null
            let classification = 'IN_PACKAGE'
            if (totalQuotaMb !== null && Number.isFinite(totalQuotaMb)) {
              const remainingMb = Math.max(0, totalQuotaMb - usedMb)
              const overMb = Math.max(0, Number(usageMb || 0) - remainingMb)
              const overageRate = pool?.overageRatePerMb ?? 0
              classification = overMb > 0 ? 'OVERAGE' : 'IN_PACKAGE'
              rate = overMb > 0 ? overageRate : null
              amount = overMb > 0 ? roundAmount(overMb * overageRate) : 0
            }
            poolUsageByPackage.set(usageKey, usedMb + Number(usageMb || 0))
            pushRatedUsage({
              usageMb,
              classification,
              amount,
              ratePerMb: rate,
              packageId,
              subscriptionId: sub?.subscription_id ?? null,
              pricePlanId,
              ratedCurrency,
              deductPackageId: packageId,
              ratedInProfile: true,
            })
            return
          }
          const quotaMb = resolveQuotaMb(planVersion)
          const usageKey = `${sim.sim_id}:${packageId || 'unknown'}`
          const usedMb = Number(usageByPackage.get(usageKey) || 0)
          if (quotaMb === null) {
            usageByPackage.set(usageKey, usedMb + Number(usageMb || 0))
            pushRatedUsage({
              usageMb,
              classification: 'IN_PACKAGE',
              packageId,
              subscriptionId: sub?.subscription_id ?? null,
              pricePlanId,
              ratedCurrency,
              deductPackageId: packageId,
              ratedInProfile: true,
            })
            return
          }
          const remainingMb = Math.max(0, quotaMb - usedMb)
          const inPackageMb = Math.min(Number(usageMb || 0), remainingMb)
          const overflowMb = Math.max(0, Number(usageMb || 0) - inPackageMb)
          if (inPackageMb > 0) {
            usageByPackage.set(usageKey, usedMb + inPackageMb)
            pushRatedUsage({
              usageMb: inPackageMb,
              classification: 'IN_PACKAGE',
              packageId,
              subscriptionId: sub?.subscription_id ?? null,
              pricePlanId,
              ratedCurrency,
              deductPackageId: packageId,
              ratedInProfile: true,
            })
          }
          if (overflowMb > 0) {
            if (overflowTarget === 'main') pushMainOrFallbackUsage(overflowMb)
            else pushFallbackUsage(overflowMb, ['ONE_TIME_QUOTA_EXHAUSTED'])
          }
        }

        if (match) {
          inProfile = true
          matchedPackageVersionId = match.pkg?.package_id ?? null
          matchedSubscriptionId = match.sub?.subscription_id ?? null
          const matchedPlanVersion = match.pkg?.resolved_price_plan_version ?? match.pkg?.price_plans ?? null
          matchedPricePlanId = matchedPlanVersion?.price_plan_id ?? match.pkg?.price_plan_id ?? null
          const pool = matchedPackageVersionId ? packagePool.get(String(matchedPackageVersionId)) : null
          const planType = pool?.planType ?? null
          if (planType === 'TIERED_VOLUME_PRICING') {
            const used = Number(tieredUsageByPackage.get(String(matchedPackageVersionId)) || 0)
            const limitMb = resolveTierLimitMb(pool?.tiers)
            if (limitMb !== null && used + totalMb > limitMb) {
              pushMatchedPackageUsage({
                sub: match.sub,
                pkg: match.pkg,
                usageMb: totalMb,
                overflowTarget: 'fallback',
              })
              continue
            }
            tieredUsageByPackage.set(String(matchedPackageVersionId), used + totalMb)
            chargeType = 'TIERED_VOLUME'
            deductFromPackageVersionId = matchedPackageVersionId
            currency = pool?.currency ?? currencyFallback
          } else if (planType === 'SIM_DEPENDENT_BUNDLE' || planType === 'FIXED_BUNDLE') {
            const usageKey = String(matchedPackageVersionId)
            const usedMb = Number(poolUsageByPackage.get(usageKey) || 0)
            const totalQuotaMb = pool?.totalQuotaMb
            if (totalQuotaMb === null || !Number.isFinite(totalQuotaMb)) {
              chargeType = 'IN_PACKAGE'
              deductFromPackageVersionId = matchedPackageVersionId
              poolUsageByPackage.set(usageKey, usedMb + totalMb)
            } else {
              const remainingMb = Math.max(0, totalQuotaMb - usedMb)
              const overMb = Math.max(0, totalMb - remainingMb)
              const overageRate = pool?.overageRatePerMb ?? 0
              chargeType = overMb > 0 ? 'OVERAGE' : 'IN_PACKAGE'
              rateApplied = overMb > 0 ? overageRate : null
              chargeAmount = overMb > 0 ? roundAmount(overMb * overageRate) : 0
              deductFromPackageVersionId = matchedPackageVersionId
              poolUsageByPackage.set(usageKey, usedMb + totalMb)
            }
            currency = pool?.currency ?? currencyFallback
          } else {
            const pricePlan = match.pkg?.resolved_price_plan_version ?? match.pkg?.price_plans ?? null
            const quotaMb = resolveQuotaMb(pricePlan)
            const usageKey = `${sim.sim_id}:${matchedPackageVersionId || 'unknown'}`
            const usedMb = Number(usageByPackage.get(usageKey) || 0)
            if (quotaMb === null) {
              chargeType = 'IN_PACKAGE'
              deductFromPackageVersionId = matchedPackageVersionId
              usageByPackage.set(usageKey, usedMb + totalMb)
            } else {
              const remainingMb = Math.max(0, quotaMb - usedMb)
              const overMb = Math.max(0, totalMb - remainingMb)
              if (overMb > 0) {
                pushMatchedPackageUsage({
                  sub: match.sub,
                  pkg: match.pkg,
                  usageMb: totalMb,
                  overflowTarget: match.sub?.subscription_kind === 'ADD_ON' ? 'main' : 'fallback',
                })
                continue
              } else {
                chargeType = 'IN_PACKAGE'
                rateApplied = null
                chargeAmount = 0
                deductFromPackageVersionId = matchedPackageVersionId
                usageByPackage.set(usageKey, usedMb + totalMb)
              }
            }
            currency = pool?.currency ?? currencyFallback
          }
        } else {
          const mainSub = validSubs.find(s => s.subscription_kind === 'MAIN') || activeSubs.find(s => s.subscription_kind === 'MAIN')
          const mainPkg = mainSub ? packageMap[mainSub.package_id] : null
          const mainPlanVersion = mainPkg?.resolved_price_plan_version ?? mainPkg?.price_plans ?? null
          matchedPricePlanId = mainPlanVersion?.price_plan_id ?? mainPkg?.price_plan_id ?? null
          const mainPlanId = mainPkg?.price_plan_id ?? mainPlanVersion?.price_plan_id ?? null
          currency = resolvePlanCurrency(pricePlanMap.get(String(mainPlanId ?? '')))

          let oop = simActive ? findFirstOopRoamingRate(activeSubs, packageMap, visitedMccMnc, roamingTariffByProfileId) : null
          const noActiveSubscription = activeSubs.length === 0
          const enterpriseResellerId = sim?.enterprise_id
            ? enterpriseParentResellerById.get(String(sim.enterprise_id).trim()) ?? null
            : null
          const simSupplierId = sim?.supplier_id ? String(sim.supplier_id).trim() : ''
          const simOperatorId = sim?.operator_id ? String(sim.operator_id).trim() : ''
          const fallbackPackageId =
            noActiveSubscription && sim?.enterprise_id && enterpriseResellerId && simSupplierId && simOperatorId
              ? fallbackPackageByScope.get(`${String(sim.enterprise_id).trim()}|${enterpriseResellerId}|${simSupplierId}|${simOperatorId}`)
              : null
          const fallbackPkg = fallbackPackageId ? packageMap[fallbackPackageId] : null
          let fallbackUnclassifiedHandled = false
          const fallbackInProfile = simActive && noActiveSubscription && fallbackPkg
            ? subscriptionMatchesInProfileVisit({ subscription_kind: 'FALLBACK' }, fallbackPkg, visitedMccMnc, coveredEntrySets)
            : false
          if (fallbackInProfile) {
            inProfile = true
            matchedPackageVersionId = fallbackPkg?.package_id ?? null
            matchedSubscriptionId = null
            const fallbackPlanVersion = fallbackPkg?.resolved_price_plan_version ?? fallbackPkg?.price_plans ?? null
            matchedPricePlanId = fallbackPlanVersion?.price_plan_id ?? fallbackPkg?.price_plan_id ?? matchedPricePlanId
            const pool = matchedPackageVersionId ? packagePool.get(String(matchedPackageVersionId)) : null
            const planType = pool?.planType ?? null
            if (planType === 'TIERED_VOLUME_PRICING') {
              const used = Number(tieredUsageByPackage.get(String(matchedPackageVersionId)) || 0)
              tieredUsageByPackage.set(String(matchedPackageVersionId), used + totalMb)
              chargeType = 'TIERED_VOLUME'
              deductFromPackageVersionId = matchedPackageVersionId
              currency = pool?.currency ?? currencyFallback
            } else if (planType === 'SIM_DEPENDENT_BUNDLE' || planType === 'FIXED_BUNDLE') {
              const usageKey = String(matchedPackageVersionId)
              const usedMb = Number(poolUsageByPackage.get(usageKey) || 0)
              const totalQuotaMb = pool?.totalQuotaMb
              if (totalQuotaMb === null || !Number.isFinite(totalQuotaMb)) {
                chargeType = 'IN_PACKAGE'
                deductFromPackageVersionId = matchedPackageVersionId
                poolUsageByPackage.set(usageKey, usedMb + totalMb)
              } else {
                const remainingMb = Math.max(0, totalQuotaMb - usedMb)
                const overMb = Math.max(0, totalMb - remainingMb)
                const overageRate = pool?.overageRatePerMb ?? 0
                chargeType = overMb > 0 ? 'OVERAGE' : 'IN_PACKAGE'
                rateApplied = overMb > 0 ? overageRate : null
                chargeAmount = overMb > 0 ? roundAmount(overMb * overageRate) : 0
                deductFromPackageVersionId = matchedPackageVersionId
                poolUsageByPackage.set(usageKey, usedMb + totalMb)
              }
              currency = pool?.currency ?? currencyFallback
            } else {
              const quotaMb = resolveQuotaMb(fallbackPlanVersion)
              const usageKey = `${sim.sim_id}:${matchedPackageVersionId || 'unknown'}`
              const usedMb = Number(usageByPackage.get(usageKey) || 0)
              if (quotaMb === null) {
                chargeType = 'IN_PACKAGE'
                deductFromPackageVersionId = matchedPackageVersionId
                usageByPackage.set(usageKey, usedMb + totalMb)
              } else {
                const remainingMb = Math.max(0, quotaMb - usedMb)
                const overMb = Math.max(0, totalMb - remainingMb)
                const overageRate = resolveOverageRatePerMb(fallbackPlanVersion) ?? 0
                chargeType = overMb > 0 ? 'OVERAGE' : 'IN_PACKAGE'
                rateApplied = overMb > 0 ? overageRate : null
                chargeAmount = overMb > 0 ? roundAmount(overMb * overageRate) : 0
                deductFromPackageVersionId = matchedPackageVersionId
                usageByPackage.set(usageKey, usedMb + totalMb)
              }
              currency = resolvePlanCurrency(pricePlanMap.get(String(matchedPricePlanId ?? '')))
            }
            alerts = ['FALLBACK_PACKAGE_RATED']
          }
          if (!oop && noActiveSubscription && fallbackPkg) {
            const fallbackRate = resolveOopRoamingRatePerMb(fallbackPkg, visitedMccMnc, roamingTariffByProfileId)
            if (fallbackRate !== null) {
              oop = {
                sub: null,
                pkg: fallbackPkg,
                ratePerMb: fallbackRate,
                fallbackPackage: true,
                missingRate: false,
              }
            } else if (!fallbackInProfile) {
              matchedPackageVersionId = fallbackPkg?.package_id ?? null
              matchedSubscriptionId = null
              const fallbackPlanVersion = fallbackPkg?.resolved_price_plan_version ?? fallbackPkg?.price_plans ?? null
              matchedPricePlanId = fallbackPlanVersion?.price_plan_id ?? fallbackPkg?.price_plan_id ?? matchedPricePlanId
              chargeType = 'UNCLASSIFIED'
              chargeAmount = 0
              rateApplied = null
              currency = resolvePlanCurrency(pricePlanMap.get(String(matchedPricePlanId ?? '')))
              alerts = ['FALLBACK_PACKAGE_RATED', 'UNCLASSIFIED_USAGE']
              fallbackUnclassifiedHandled = true
            }
          }
          if (!fallbackInProfile && oop) {
            chargeAmount = roundAmount(totalMb * oop.ratePerMb)
            chargeType = 'OOP_ROAMING'
            rateApplied = oop.ratePerMb
            matchedPackageVersionId = oop.pkg?.package_id ?? null
            matchedSubscriptionId = oop.sub?.subscription_id ?? null
            const oopPlanVer = oop.pkg?.resolved_price_plan_version ?? oop.pkg?.price_plans ?? null
            matchedPricePlanId = oopPlanVer?.price_plan_id ?? oop.pkg?.price_plan_id ?? matchedPricePlanId
            const oopPlanId = oop.pkg?.price_plan_id ?? matchedPricePlanId
            currency = resolvePlanCurrency(pricePlanMap.get(String(oopPlanId ?? '')))
            alerts = oop.fallbackPackage
              ? ['OUT_OF_PROFILE_ROAMING', 'FALLBACK_PACKAGE_RATED']
              : ['OUT_OF_PROFILE_ROAMING']
          } else if (!fallbackInProfile && !fallbackUnclassifiedHandled) {
            if (mainPkg) {
              matchedPackageVersionId = mainPkg?.package_id ?? null
              matchedSubscriptionId = mainSub?.subscription_id ?? null
              matchedPricePlanId = mainPlanVersion?.price_plan_id ?? mainPkg?.price_plan_id ?? matchedPricePlanId
            }
            chargeType = 'UNCLASSIFIED'
            rateApplied = null
            chargeAmount = 0
            alerts = noActiveSubscription
              ? ['FALLBACK_PACKAGE_MISSING']
              : ['UNCLASSIFIED_USAGE']
          }
        }

        ratingResults.push({
          calculation_id: calcId,
          rule_version_id: matchedPricePlanId,
          enterprise_id: sim.enterprise_id ?? null,
          sim_id: sim.sim_id ?? null,
          iccid: sim.iccid ?? null,
          usage_day: log.usage_day ?? null,
          visited_mccmnc: visitedMccMnc ?? null,
          input_ref: log.input_ref ?? null,
          matched_subscription_id: matchedSubscriptionId,
          matched_package_id: matchedPackageVersionId,
          matched_price_plan_id: matchedPricePlanId,
          classification: chargeType,
          charged_mb: Math.max(0, Math.floor(totalMb)),
          rate_per_mb: rateApplied,
          amount: chargeAmount,
          currency,
        })

        if (chargeAmount > 0) {
          lineItems.push({
            sim_id: sim.sim_id,
            item_type: 'USAGE_CHARGE',
            package_id: matchedPackageVersionId,
            amount: chargeAmount,
            metadata: {
              description: `Data Usage (${visitedMccMnc}) - ${chargeType}`,
              currency,
              chargeType,
              inProfile,
              visitedMccMnc,
              chargedMb: totalMb,
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

  for (const [packageVersionId, usedMb] of tieredUsageByPackage.entries()) {
    const pool = packagePool.get(String(packageVersionId))
    if (!pool) continue
    const amount = calculateTieredCharge(Number(usedMb || 0), pool.tiers)
    if (amount <= 0) continue
    lineItems.push({
      sim_id: null,
      item_type: 'USAGE_CHARGE',
      package_id: packageVersionId,
      amount,
      metadata: {
        description: `Tiered Usage - ${packageVersionId}`,
        currency: pool.currency,
        chargeType: 'TIERED_VOLUME',
        chargedMb: Number(usedMb || 0),
        matchedPackageVersionId: packageVersionId,
        pricePlanId: pool.pricePlanId ?? null,
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

function usageDayKey(value) {
  if (!value) return null
  const raw = String(value)
  return raw.length >= 10 ? raw.slice(0, 10) : raw
}

function isInProfileClassification(value) {
  const c = String(value || '').trim().toUpperCase()
  return c === 'IN_PACKAGE'
    || c === 'OVERAGE'
    || c === 'TIERED_VOLUME'
}

function isOutOfProfileClassification(value) {
  const c = String(value || '').trim().toUpperCase()
  return c === 'OOP_ROAMING'
}

export async function updateUsageDailySummaryClassifiedUsage(supabase, ratingResults) {
  if (!Array.isArray(ratingResults) || ratingResults.length === 0) return
  const aggregates = new Map()
  for (const row of ratingResults) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    const usageDay = usageDayKey(row?.usage_day)
    if (!simId || !usageDay) continue
    const key = `${simId}|${usageDay}`
    const current = aggregates.get(key) ?? {
      simId,
      usageDay,
      inProfileMb: 0,
      outOfProfileMb: 0,
      unclassifiedMb: 0,
    }
    const chargedMb = Math.max(0, Number(row?.charged_mb ?? row?.chargedMb ?? 0) || 0)
    if (isInProfileClassification(row?.classification)) {
      current.inProfileMb += chargedMb
    } else if (isOutOfProfileClassification(row?.classification)) {
      current.outOfProfileMb += chargedMb
    } else {
      current.unclassifiedMb += chargedMb
    }
    aggregates.set(key, current)
  }
  const ratedAt = new Date().toISOString()
  for (const item of aggregates.values()) {
    const match = `sim_id=eq.${encodeURIComponent(item.simId)}&usage_day=eq.${encodeURIComponent(item.usageDay)}`
    const existingRows = await supabase.select('usage_daily_summary', `select=usage_id,total_mb&${match}&limit=1`)
    const existing = Array.isArray(existingRows) ? existingRows[0] : null
    if (!existing?.usage_id) continue
    const totalMb = Number(existing.total_mb)
    const classifiedMb = item.inProfileMb + item.outOfProfileMb + item.unclassifiedMb
    const unclassifiedMb = Number.isFinite(totalMb)
      ? item.unclassifiedMb + Math.max(0, totalMb - classifiedMb)
      : item.unclassifiedMb
    await supabase.update(
      'usage_daily_summary',
      `usage_id=eq.${encodeURIComponent(String(existing.usage_id))}`,
      {
        in_profile_mb: Number(item.inProfileMb.toFixed(6)),
        out_of_profile_mb: Number(item.outOfProfileMb.toFixed(6)),
        unclassified_mb: Number(unclassifiedMb.toFixed(6)),
        rated_at: ratedAt,
      },
      { returning: 'minimal', suppressMissingColumns: true }
    )
  }
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => value ? String(value) : '').filter(Boolean)))
}

function nullableFilter(field, value) {
  return value ? `${field}=eq.${encodeURIComponent(String(value))}` : `${field}=is.null`
}

async function loadPricePlanTypesById(supabase, pricePlanIds) {
  const ids = uniqueStrings(pricePlanIds)
  const map = new Map()
  if (!ids.length) return map
  const rows = await supabase.select(
    'price_plans',
    `select=price_plan_id,type&price_plan_id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`
  )
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.price_plan_id ? String(row.price_plan_id) : null
    if (id) map.set(id, row?.type ? String(row.type) : null)
  }
  return map
}

async function loadResellerIdsByEnterpriseId(supabase, enterpriseIds) {
  const ids = uniqueStrings(enterpriseIds)
  const map = new Map()
  if (!ids.length) return map
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id&tenant_id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`
  )
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.tenant_id ? String(row.tenant_id) : null
    if (id) map.set(id, row?.parent_id ? String(row.parent_id) : null)
  }
  return map
}

async function loadSupplierIdsBySimId(supabase, simIds) {
  const ids = uniqueStrings(simIds)
  const map = new Map()
  if (!ids.length) return map
  const rows = await supabase.select(
    'sims',
    `select=sim_id,supplier_id&sim_id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`
  )
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.sim_id ? String(row.sim_id) : null
    if (id) map.set(id, row?.supplier_id ? String(row.supplier_id) : null)
  }
  return map
}

async function loadUsageDailySimDayTotals(supabase, simDayKeys) {
  const keys = Array.isArray(simDayKeys) ? simDayKeys : []
  const simIds = uniqueStrings(keys.map((item) => item?.simId))
  const usageDays = uniqueStrings(keys.map((item) => item?.usageDay)).sort()
  const totals = new Map()
  if (!simIds.length || !usageDays.length) return totals
  const minDay = usageDays[0]
  const maxDay = usageDays[usageDays.length - 1]
  const rows = await supabase.select(
    'usage_daily_summary',
    [
      'select=sim_id,usage_day,uplink_mb,downlink_mb,total_mb',
      `sim_id=in.(${simIds.map((id) => encodeURIComponent(id)).join(',')})`,
      `usage_day=gte.${encodeURIComponent(minDay)}`,
      `usage_day=lte.${encodeURIComponent(maxDay)}`,
    ].join('&')
  )
  for (const row of Array.isArray(rows) ? rows : []) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    const usageDay = usageDayKey(row?.usage_day)
    if (!simId || !usageDay) continue
    const key = `${simId}|${usageDay}`
    const current = totals.get(key) ?? { uplinkMb: 0, downlinkMb: 0, totalMb: 0 }
    current.uplinkMb += Math.max(0, Number(row?.uplink_mb ?? 0) || 0)
    current.downlinkMb += Math.max(0, Number(row?.downlink_mb ?? 0) || 0)
    current.totalMb += Math.max(0, Number(row?.total_mb ?? 0) || 0)
    totals.set(key, current)
  }
  return totals
}

export async function updateUsagePackageDailySummary(supabase, ratingResults) {
  if (!Array.isArray(ratingResults) || ratingResults.length === 0) return
  const pricePlanTypesById = await loadPricePlanTypesById(supabase, ratingResults.map((row) => row?.matched_price_plan_id))
  const resellerIdsByEnterpriseId = await loadResellerIdsByEnterpriseId(supabase, ratingResults.map((row) => row?.enterprise_id))
  const supplierIdsBySimId = await loadSupplierIdsBySimId(supabase, ratingResults.map((row) => row?.sim_id))
  const aggregates = new Map()
  for (const row of ratingResults) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    const usageDay = usageDayKey(row?.usage_day)
    if (!simId || !usageDay) continue
    const subscriptionId = row?.matched_subscription_id ? String(row.matched_subscription_id) : null
    const packageId = row?.matched_package_id ? String(row.matched_package_id) : null
    const pricePlanId = row?.matched_price_plan_id ? String(row.matched_price_plan_id) : null
    if (!packageId) continue
    const visitedMccMnc = normalizeVisitedMccMnc(row?.visited_mccmnc) ?? 'UNKNOWN'
    const key = [
      simId,
      usageDay,
      subscriptionId ?? '',
      packageId ?? '',
      pricePlanId ?? '',
      visitedMccMnc,
    ].join('|')
    const enterpriseId = row?.enterprise_id ? String(row.enterprise_id) : null
    const current = aggregates.get(key) ?? {
      supplierId: supplierIdsBySimId.get(simId) ?? null,
      resellerId: enterpriseId ? resellerIdsByEnterpriseId.get(enterpriseId) ?? null : null,
      enterpriseId,
      simId,
      iccid: row?.iccid ? String(row.iccid) : null,
      usageDay,
      visitedMccMnc,
      subscriptionId,
      packageId,
      pricePlanId,
      pricePlanType: pricePlanId ? pricePlanTypesById.get(pricePlanId) ?? null : null,
      inProfileMb: 0,
      outOfProfileMb: 0,
      unclassifiedMb: 0,
      amount: 0,
      currency: row?.currency ? String(row.currency) : null,
      calculationId: row?.calculation_id ? String(row.calculation_id) : null,
    }
    const chargedMb = Math.max(0, Number(row?.charged_mb ?? row?.chargedMb ?? 0) || 0)
    if (isInProfileClassification(row?.classification)) {
      current.inProfileMb += chargedMb
    } else if (isOutOfProfileClassification(row?.classification)) {
      current.outOfProfileMb += chargedMb
    } else {
      current.unclassifiedMb += chargedMb
    }
    current.amount += Math.max(0, Number(row?.amount ?? 0) || 0)
    if (!current.currency && row?.currency) current.currency = String(row.currency)
    if (!current.calculationId && row?.calculation_id) current.calculationId = String(row.calculation_id)
    aggregates.set(key, current)
  }
  const simDayTotals = await loadUsageDailySimDayTotals(
    supabase,
    Array.from(aggregates.values()).map((item) => ({ simId: item.simId, usageDay: item.usageDay }))
  )
  const ratedAt = new Date().toISOString()
  for (const item of aggregates.values()) {
    const simDayTotal = simDayTotals.get(`${item.simId}|${item.usageDay}`) ?? {
      uplinkMb: 0,
      downlinkMb: 0,
      totalMb: 0,
    }
    const match = [
      `sim_id=eq.${encodeURIComponent(item.simId)}`,
      `usage_day=eq.${encodeURIComponent(item.usageDay)}`,
      nullableFilter('subscription_id', item.subscriptionId),
      nullableFilter('package_id', item.packageId),
      nullableFilter('price_plan_id', item.pricePlanId),
      `visited_mccmnc=eq.${encodeURIComponent(item.visitedMccMnc)}`,
    ].join('&')
    const existingRows = await supabase.select(
      'usage_package_daily_summary',
      `select=usage_package_summary_id&${match}&limit=1`
    )
    const existing = Array.isArray(existingRows) ? existingRows[0] : null
    const patch = {
      supplier_id: item.supplierId,
      reseller_id: item.resellerId,
      enterprise_id: item.enterpriseId,
      sim_id: item.simId,
      iccid: item.iccid,
      usage_day: item.usageDay,
      visited_mccmnc: item.visitedMccMnc,
      subscription_id: item.subscriptionId,
      package_id: item.packageId,
      price_plan_id: item.pricePlanId,
      price_plan_type: item.pricePlanType,
      in_profile_mb: Number(item.inProfileMb.toFixed(6)),
      out_of_profile_mb: Number(item.outOfProfileMb.toFixed(6)),
      unclassified_mb: Number(item.unclassifiedMb.toFixed(6)),
      uplink_mb: Number(simDayTotal.uplinkMb.toFixed(6)),
      downlink_mb: Number(simDayTotal.downlinkMb.toFixed(6)),
      total_mb: Number(simDayTotal.totalMb.toFixed(6)),
      amount: Number(item.amount.toFixed(2)),
      currency: item.currency,
      calculation_id: item.calculationId,
      rated_at: ratedAt,
      updated_at: ratedAt,
    }
    if (existing?.usage_package_summary_id) {
      await supabase.update(
        'usage_package_daily_summary',
        `usage_package_summary_id=eq.${encodeURIComponent(String(existing.usage_package_summary_id))}`,
        patch,
        { returning: 'minimal', suppressMissingColumns: true }
      )
    } else {
      await supabase.insert(
        'usage_package_daily_summary',
        patch,
        { returning: 'minimal', suppressMissingColumns: true }
      )
    }
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
    await updateUsageDailySummaryClassifiedUsage(supabase, result.ratingResults)
    await updateUsagePackageDailySummary(supabase, result.ratingResults)
  }

  console.log(`[Billing] Bill ${billId} generated. Total: ${result.totalBillAmount}`)
}

export async function runBillingTask(job) {
    await generateMonthlyBill(job)
}
