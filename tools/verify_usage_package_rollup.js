import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

const DEFAULT_ENTERPRISE_ID = '43326e05-5704-4e0d-8175-547d6b555132'
const DEFAULT_RESELLER_ID = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const DEFAULT_FALLBACK_PACKAGE_ID = '0e5e200e-694c-431b-8139-28fd2c451ab8'

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

function periodBounds(period) {
  const raw = String(period || '').trim()
  if (!/^\d{4}-\d{2}$/.test(raw)) {
    throw new Error('--period must be YYYY-MM')
  }
  const [year, month] = raw.split('-').map(Number)
  const start = `${raw}-01`
  const endDate = new Date(Date.UTC(year, month, 0))
  const end = endDate.toISOString().slice(0, 10)
  return { period: raw, start, end }
}

function usageDay(value) {
  const raw = String(value ?? '').trim()
  return raw.length >= 10 ? raw.slice(0, 10) : raw
}

function normalizeVisited(value) {
  const raw = String(value ?? '').trim()
  return raw || 'UNKNOWN'
}

function n(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function round6(value) {
  return Number(n(value).toFixed(6))
}

function money(value) {
  return Number(n(value).toFixed(2))
}

function isInProfileClassification(value) {
  const c = String(value || '').trim().toUpperCase()
  return c === 'IN_PACKAGE' || c === 'OVERAGE' || c === 'TIERED_VOLUME'
}

function isOutOfProfileClassification(value) {
  const c = String(value || '').trim().toUpperCase()
  return c === 'OOP_ROAMING'
}

function chunk(values, size = 80) {
  const out = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

function unique(values) {
  return Array.from(new Set(values.map((value) => value ? String(value) : '').filter(Boolean)))
}

function inFilter(ids) {
  return ids.map((id) => encodeURIComponent(String(id))).join(',')
}

async function selectAll(supabase, table, query, options) {
  const rows = await supabase.select(table, query, options)
  return Array.isArray(rows) ? rows : []
}

async function selectByIds(supabase, table, select, field, ids, extra = '') {
  const result = []
  for (const part of chunk(unique(ids))) {
    if (!part.length) continue
    const suffix = extra ? `&${extra}` : ''
    const rows = await selectAll(supabase, table, `${select}&${field}=in.(${inFilter(part)})${suffix}`)
    result.push(...rows)
  }
  return result
}

function packageSummaryKey(row) {
  return [
    row?.sim_id ? String(row.sim_id) : '',
    usageDay(row?.usage_day),
    row?.subscription_id ? String(row.subscription_id) : '',
    row?.package_id ? String(row.package_id) : '',
    row?.price_plan_id ? String(row.price_plan_id) : '',
    normalizeVisited(row?.visited_mccmnc),
  ].join('|')
}

function ratingKey(row) {
  return [
    row?.sim_id ? String(row.sim_id) : '',
    usageDay(row?.usage_day),
    row?.matched_subscription_id ? String(row.matched_subscription_id) : '',
    row?.matched_package_id ? String(row.matched_package_id) : '',
    row?.matched_price_plan_id ? String(row.matched_price_plan_id) : '',
    normalizeVisited(row?.visited_mccmnc),
  ].join('|')
}

function aggregateRatingRows(rows) {
  const map = new Map()
  for (const row of rows) {
    const key = ratingKey(row)
    const current = map.get(key) ?? {
      key,
      simId: row?.sim_id ?? null,
      usageDay: usageDay(row?.usage_day),
      subscriptionId: row?.matched_subscription_id ?? null,
      packageId: row?.matched_package_id ?? null,
      pricePlanId: row?.matched_price_plan_id ?? null,
      visitedMccMnc: normalizeVisited(row?.visited_mccmnc),
      inProfileMb: 0,
      outOfProfileMb: 0,
      unclassifiedMb: 0,
      amount: 0,
      rows: 0,
      classifications: new Set(),
      calculationIds: new Set(),
    }
    const chargedMb = Math.max(0, n(row?.charged_mb))
    if (isInProfileClassification(row?.classification)) current.inProfileMb += chargedMb
    else if (isOutOfProfileClassification(row?.classification)) current.outOfProfileMb += chargedMb
    else current.unclassifiedMb += chargedMb
    current.amount += Math.max(0, n(row?.amount))
    current.rows += 1
    if (row?.classification) current.classifications.add(String(row.classification))
    if (row?.calculation_id) current.calculationIds.add(String(row.calculation_id))
    map.set(key, current)
  }
  return map
}

function aggregateSummaryRows(rows) {
  const map = new Map()
  for (const row of rows) {
    const key = packageSummaryKey(row)
    const current = map.get(key) ?? {
      key,
      simId: row?.sim_id ?? null,
      iccid: row?.iccid ?? null,
      usageDay: usageDay(row?.usage_day),
      subscriptionId: row?.subscription_id ?? null,
      packageId: row?.package_id ?? null,
      pricePlanId: row?.price_plan_id ?? null,
      pricePlanType: row?.price_plan_type ?? null,
      visitedMccMnc: normalizeVisited(row?.visited_mccmnc),
      inProfileMb: 0,
      outOfProfileMb: 0,
      unclassifiedMb: 0,
      amount: 0,
      rows: 0,
      calculationIds: new Set(),
    }
    current.inProfileMb += n(row?.in_profile_mb)
    current.outOfProfileMb += n(row?.out_of_profile_mb)
    current.unclassifiedMb += n(row?.unclassified_mb)
    current.amount += n(row?.amount)
    current.rows += 1
    if (row?.calculation_id) current.calculationIds.add(String(row.calculation_id))
    map.set(key, current)
  }
  return map
}

function diffNumber(actual, expected) {
  return round6(n(actual) - n(expected))
}

function closeEnough(actual, expected, tolerance) {
  return Math.abs(diffNumber(actual, expected)) <= tolerance
}

function fmt(value, digits = 3) {
  return n(value).toFixed(digits)
}

function summarizeByPackage(rows, source) {
  const map = new Map()
  for (const row of rows) {
    const packageId = source === 'rating' ? row?.matched_package_id : row?.package_id
    const key = packageId ? String(packageId) : '(null)'
    const current = map.get(key) ?? { packageId: key, inProfileMb: 0, outOfProfileMb: 0, unclassifiedMb: 0, amount: 0, rows: 0 }
    if (source === 'rating') {
      const chargedMb = Math.max(0, n(row?.charged_mb))
      if (isInProfileClassification(row?.classification)) current.inProfileMb += chargedMb
      else if (isOutOfProfileClassification(row?.classification)) current.outOfProfileMb += chargedMb
      else current.unclassifiedMb += chargedMb
      current.amount += n(row?.amount)
    } else {
      current.inProfileMb += n(row?.in_profile_mb)
      current.outOfProfileMb += n(row?.out_of_profile_mb)
      current.unclassifiedMb += n(row?.unclassified_mb)
      current.amount += n(row?.amount)
    }
    current.rows += 1
    map.set(key, current)
  }
  return Array.from(map.values()).sort((a, b) => (b.inProfileMb + b.outOfProfileMb + b.unclassifiedMb) - (a.inProfileMb + a.outOfProfileMb + a.unclassifiedMb))
}

function printPackageTotals(title, totals, limit) {
  console.log(`\n${title}`)
  if (!totals.length) {
    console.log('  (none)')
    return
  }
  for (const row of totals.slice(0, limit)) {
    const total = row.inProfileMb + row.outOfProfileMb + row.unclassifiedMb
    console.log(
      `  ${row.packageId} rows=${row.rows} totalMb=${fmt(total)} in=${fmt(row.inProfileMb)} out=${fmt(row.outOfProfileMb)} unclassified=${fmt(row.unclassifiedMb)} amount=${money(row.amount).toFixed(2)}`
    )
  }
  if (totals.length > limit) console.log(`  ... ${totals.length - limit} more`)
}

function printIssues(title, issues, limit) {
  console.log(`\n${title}: ${issues.length}`)
  for (const issue of issues.slice(0, limit)) {
    console.log(`  - ${issue}`)
  }
  if (issues.length > limit) console.log(`  ... ${issues.length - limit} more`)
}

function toPlainAggregate(row) {
  return {
    ...row,
    inProfileMb: round6(row.inProfileMb),
    outOfProfileMb: round6(row.outOfProfileMb),
    unclassifiedMb: round6(row.unclassifiedMb),
    amount: money(row.amount),
    classifications: row.classifications ? Array.from(row.classifications) : undefined,
    calculationIds: row.calculationIds ? Array.from(row.calculationIds) : undefined,
  }
}

async function main() {
  if (hasFlag('help')) {
    console.log('Usage: node tools/verify_usage_package_rollup.js [--period YYYY-MM] [--enterpriseId uuid] [--resellerId uuid] [--fallbackPackageId uuid] [--supplierId uuid] [--operatorId uuid] [--json]')
    return
  }

  const enterpriseId = arg('enterpriseId') || process.env.VERIFY_ENTERPRISE_ID || DEFAULT_ENTERPRISE_ID
  const resellerId = arg('resellerId') || process.env.VERIFY_RESELLER_ID || DEFAULT_RESELLER_ID
  const fallbackPackageId = arg('fallbackPackageId') || process.env.VERIFY_FALLBACK_PACKAGE_ID || DEFAULT_FALLBACK_PACKAGE_ID
  const supplierId = arg('supplierId') || process.env.VERIFY_SUPPLIER_ID || null
  const operatorId = arg('operatorId') || process.env.VERIFY_OPERATOR_ID || null
  const tolerance = Number(arg('tolerance') || process.env.VERIFY_TOLERANCE_MB || '0.01')
  const limit = Math.max(1, Number(arg('limit') || '20') || 20)
  const { period, start, end } = periodBounds(arg('period') || process.env.VERIFY_PERIOD || currentPeriodUtc())
  const supabase = createSupabaseRestClient({ useServiceRole: true })

  console.log('Usage Package Rollup Verification')
  console.log(`Scope: enterprise=${enterpriseId} reseller=${resellerId} period=${period} (${start}..${end})`)
  console.log(`Fallback target: package=${fallbackPackageId} supplier=${supplierId ?? '(any)'} operator=${operatorId ?? '(any)'}`)

  const usageRows = await selectAll(
    supabase,
    'usage_daily_summary',
    `select=usage_id,supplier_id,enterprise_id,sim_id,iccid,usage_day,visited_mccmnc,total_mb,in_profile_mb,out_of_profile_mb,unclassified_mb,rated_at&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&usage_day=gte.${encodeURIComponent(start)}&usage_day=lte.${encodeURIComponent(end)}&limit=10000`
  )
  const summaryRows = await selectAll(
    supabase,
    'usage_package_daily_summary',
    `select=usage_package_summary_id,supplier_id,reseller_id,enterprise_id,sim_id,iccid,usage_day,visited_mccmnc,subscription_id,package_id,price_plan_id,price_plan_type,in_profile_mb,out_of_profile_mb,unclassified_mb,amount,currency,calculation_id,rated_at&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&usage_day=gte.${encodeURIComponent(start)}&usage_day=lte.${encodeURIComponent(end)}&limit=10000`
  )
  const ratingRowsAll = await selectAll(
    supabase,
    'rating_results',
    `select=calculation_id,iccid,sim_id,enterprise_id,usage_day,visited_mccmnc,matched_subscription_id,matched_package_id,matched_price_plan_id,classification,charged_mb,amount,currency&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&usage_day=gte.${encodeURIComponent(start)}&usage_day=lte.${encodeURIComponent(end)}&limit=10000`
  )

  const summaryCalculationIds = unique(summaryRows.map((row) => row?.calculation_id))
  const ratingRows = summaryCalculationIds.length
    ? ratingRowsAll.filter((row) => summaryCalculationIds.includes(String(row?.calculation_id ?? '')))
    : ratingRowsAll

  const simIds = unique(usageRows.map((row) => row?.sim_id).concat(summaryRows.map((row) => row?.sim_id), ratingRows.map((row) => row?.sim_id)))
  const sims = await selectByIds(
    supabase,
    'sims',
    'select=sim_id,iccid,enterprise_id,supplier_id,operator_id,status',
    'sim_id',
    simIds
  )
  const activeSubscriptions = await selectByIds(
    supabase,
    'subscriptions',
    'select=subscription_id,sim_id,enterprise_id,package_id,subscription_kind,state',
    'sim_id',
    simIds,
    'state=eq.ACTIVE'
  )
  const fallbackRows = await selectAll(
    supabase,
    'default_fallback_package_mappings',
    `select=mapping_id,enterprise_id,reseller_id,supplier_id,operator_id,package_id,status&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&reseller_id=eq.${encodeURIComponent(resellerId)}&status=eq.ACTIVE`
  )
  const fallbackRowsForTarget = fallbackRows.filter((row) => {
    if (String(row?.package_id ?? '') !== fallbackPackageId) return false
    if (supplierId && String(row?.supplier_id ?? '') !== supplierId) return false
    if (operatorId && String(row?.operator_id ?? '') !== operatorId) return false
    return true
  })

  const simsById = new Map(sims.map((row) => [String(row.sim_id), row]))
  const activeSubBySim = new Map()
  for (const row of activeSubscriptions) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    if (!simId) continue
    const existing = activeSubBySim.get(simId)
    const kind = String(row?.subscription_kind ?? '').toUpperCase()
    if (!existing || kind === 'MAIN') activeSubBySim.set(simId, row)
  }

  const ratingAgg = aggregateRatingRows(ratingRows)
  const summaryAgg = aggregateSummaryRows(summaryRows)
  const metricMismatches = []
  const missingSummary = []
  const unexpectedSummary = []

  for (const [key, expected] of ratingAgg.entries()) {
    const actual = summaryAgg.get(key)
    if (!actual) {
      missingSummary.push(`${key} expected from rating rows=${expected.rows}`)
      continue
    }
    const diffs = [
      ['in', actual.inProfileMb, expected.inProfileMb],
      ['out', actual.outOfProfileMb, expected.outOfProfileMb],
      ['unclassified', actual.unclassifiedMb, expected.unclassifiedMb],
      ['amount', actual.amount, expected.amount],
    ].filter(([, actualValue, expectedValue]) => !closeEnough(actualValue, expectedValue, tolerance))
    if (diffs.length) {
      metricMismatches.push(`${key} ${diffs.map(([name, actualValue, expectedValue]) => `${name} actual=${fmt(actualValue)} expected=${fmt(expectedValue)} diff=${fmt(diffNumber(actualValue, expectedValue))}`).join('; ')}`)
    }
  }

  for (const [key, actual] of summaryAgg.entries()) {
    if (!ratingAgg.has(key)) {
      unexpectedSummary.push(`${key} summaryRows=${actual.rows} totalMb=${fmt(actual.inProfileMb + actual.outOfProfileMb + actual.unclassifiedMb)}`)
    }
  }

  const usageNoRating = []
  const ratingBySimDay = new Set(ratingRows.map((row) => `${row?.sim_id ?? ''}|${usageDay(row?.usage_day)}`))
  for (const row of usageRows) {
    const totalMb = n(row?.total_mb)
    if (totalMb <= 0) continue
    const simId = row?.sim_id ? String(row.sim_id) : ''
    const key = `${simId}|${usageDay(row?.usage_day)}`
    if (!ratingBySimDay.has(key)) {
      usageNoRating.push(`${key} iccid=${row?.iccid ?? ''} totalMb=${fmt(totalMb)} visited=${normalizeVisited(row?.visited_mccmnc)}`)
    }
  }

  const fallbackCandidates = []
  const fallbackIssues = []
  for (const row of usageRows) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    if (!simId || n(row?.total_mb) <= 0) continue
    const sim = simsById.get(simId)
    if (!sim) continue
    const scopeMatches =
      (!supplierId || String(sim?.supplier_id ?? '') === supplierId)
      && (!operatorId || String(sim?.operator_id ?? '') === operatorId)
    const noActiveSub = !activeSubBySim.has(simId)
    if (!scopeMatches || !noActiveSub) continue
    const day = usageDay(row?.usage_day)
    const ratingMatches = ratingRows.filter((rr) =>
      String(rr?.sim_id ?? '') === simId
      && usageDay(rr?.usage_day) === day
      && String(rr?.matched_package_id ?? '') === fallbackPackageId
    )
    const summaryMatches = summaryRows.filter((sr) =>
      String(sr?.sim_id ?? '') === simId
      && usageDay(sr?.usage_day) === day
      && String(sr?.package_id ?? '') === fallbackPackageId
    )
    fallbackCandidates.push({
      simId,
      iccid: row?.iccid ?? sim?.iccid ?? null,
      usageDay: day,
      totalMb: n(row?.total_mb),
      ratingRows: ratingMatches.length,
      summaryRows: summaryMatches.length,
      summaryOutProfileMb: summaryMatches.reduce((sum, item) => sum + n(item?.out_of_profile_mb), 0),
      summaryInProfileMb: summaryMatches.reduce((sum, item) => sum + n(item?.in_profile_mb), 0),
    })
    if (!ratingMatches.length) fallbackIssues.push(`${simId}|${day} expected fallback rating package=${fallbackPackageId}`)
    if (!summaryMatches.length) fallbackIssues.push(`${simId}|${day} expected fallback summary package=${fallbackPackageId}`)
  }

  const result = {
    scope: { enterpriseId, resellerId, period, start, end, fallbackPackageId, supplierId, operatorId },
    counts: {
      usageRows: usageRows.length,
      ratingRowsAll: ratingRowsAll.length,
      ratingRowsCompared: ratingRows.length,
      summaryRows: summaryRows.length,
      summaryCalculationIds: summaryCalculationIds.length,
      sims: sims.length,
      activeSubscriptions: activeSubscriptions.length,
      fallbackMappings: fallbackRows.length,
      fallbackMappingsForTarget: fallbackRowsForTarget.length,
      fallbackCandidates: fallbackCandidates.length,
    },
    packageTotals: {
      rating: summarizeByPackage(ratingRows, 'rating'),
      summary: summarizeByPackage(summaryRows, 'summary'),
    },
    issues: {
      metricMismatches,
      missingSummary,
      unexpectedSummary,
      usageNoRating,
      fallbackIssues,
    },
    fallbackCandidates,
    samples: {
      expectedFromRating: Array.from(ratingAgg.values()).slice(0, limit).map(toPlainAggregate),
      actualSummary: Array.from(summaryAgg.values()).slice(0, limit).map(toPlainAggregate),
    },
  }

  if (hasFlag('json')) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log('\nCounts')
  for (const [key, value] of Object.entries(result.counts)) {
    console.log(`  ${key}: ${value}`)
  }

  printPackageTotals('Rating totals by matched_package_id (compared calculation_ids)', result.packageTotals.rating, limit)
  printPackageTotals('Summary totals by package_id', result.packageTotals.summary, limit)

  console.log('\nFallback candidates')
  if (!fallbackCandidates.length) {
    console.log('  (none found: no positive-usage SIM matched fallback scope with no ACTIVE subscription)')
  } else {
    for (const row of fallbackCandidates.slice(0, limit)) {
      console.log(
        `  sim=${row.simId} iccid=${row.iccid ?? ''} day=${row.usageDay} totalMb=${fmt(row.totalMb)} ratingRows=${row.ratingRows} summaryRows=${row.summaryRows} summaryIn=${fmt(row.summaryInProfileMb)} summaryOut=${fmt(row.summaryOutProfileMb)}`
      )
    }
    if (fallbackCandidates.length > limit) console.log(`  ... ${fallbackCandidates.length - limit} more`)
  }

  printIssues('Metric mismatches between rating_results and usage_package_daily_summary', metricMismatches, limit)
  printIssues('Rating aggregate rows missing package summary', missingSummary, limit)
  printIssues('Package summary rows without compared rating aggregate', unexpectedSummary, limit)
  printIssues('Positive usage rows without compared rating result', usageNoRating, limit)
  printIssues('Fallback package attribution issues', fallbackIssues, limit)

  const issueCount = metricMismatches.length + missingSummary.length + unexpectedSummary.length + usageNoRating.length + fallbackIssues.length
  console.log(`\nResult: ${issueCount === 0 ? 'PASS' : `CHECK (${issueCount} issue(s))`}`)
  if (summaryCalculationIds.length) {
    console.log(`Compared calculation_id count: ${summaryCalculationIds.length}`)
  } else {
    console.log('No summary calculation_id found; compared all rating rows in scope.')
  }
}

main().catch((err) => {
  console.error('verify_usage_package_rollup failed:', err)
  process.exitCode = 1
})
