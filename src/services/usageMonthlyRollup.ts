type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  insert: (
    table: string,
    rows: unknown,
    options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
  ) => Promise<unknown>
  update: (
    table: string,
    matchQueryString: string,
    patch: unknown,
    options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
  ) => Promise<unknown>
  delete?: (table: string, matchQueryString: string) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

type DailyUsageRow = {
  supplier_id?: string | null
  enterprise_id?: string | null
  sim_id?: string | null
  iccid?: string | null
  usage_day?: string | null
  visited_mccmnc?: string | null
  uplink_mb?: number | string | null
  downlink_mb?: number | string | null
  total_mb?: number | string | null
  in_profile_mb?: number | string | null
  out_of_profile_mb?: number | string | null
  unclassified_mb?: number | string | null
  rated_at?: string | null
}

type MonthlyAgg = {
  supplier_id: string
  enterprise_id: string | null
  sim_id: string | null
  iccid: string
  usage_month: string
  visited_mccmnc: string
  uplink_mb: number
  downlink_mb: number
  total_mb: number
  in_profile_mb: number
  out_of_profile_mb: number
  unclassified_mb: number
  rated_at: string | null
}

function toError(status: number, code: string, message: string): ServiceResult<never> {
  return { ok: false, status, code, message }
}

function isValidPeriod(value: unknown) {
  return /^\d{4}-\d{2}$/.test(String(value || '').trim())
}

/** YYYY-MM → first day date YYYY-MM-01 */
export function periodToMonthStart(period: string) {
  return `${String(period).trim()}-01`
}

export function monthStartFromDate(isoDay: string) {
  const day = String(isoDay || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  return `${day.slice(0, 7)}-01`
}

export function currentUtcYearMonth(now: Date = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export function previousUtcYearMonth(now: Date = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0-based
  if (m === 0) return `${y - 1}-12`
  return `${y}-${String(m).padStart(2, '0')}`
}

/**
 * Past complete calendar months touched by usage_day values (strictly before current UTC month).
 * Used after daily writes (late CDR / sync) to refresh monthly snapshots without touching the open month.
 */
export function pastMonthsTouchedByUsageDays(usageDays: Iterable<string>, now: Date = new Date()): string[] {
  const current = currentUtcYearMonth(now)
  const set = new Set<string>()
  for (const raw of usageDays) {
    const day = String(raw || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const ym = day.slice(0, 7)
    if (ym < current) set.add(ym)
  }
  return [...set].sort()
}

function num(value: unknown) {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function monthDateRange(period: string) {
  const [ys, ms] = period.split('-').map(Number)
  const start = `${period}-01`
  const endExclusive = ms === 12 ? `${ys + 1}-01-01` : `${ys}-${String(ms + 1).padStart(2, '0')}-01`
  // inclusive end = day before endExclusive
  const endDate = new Date(Date.UTC(ys, ms, 0)) // day 0 of next month = last day of period month
  // ms is 1-12 from period; Date.UTC month is 0-based so Date.UTC(ys, ms, 0) works when ms is 1-12...
  // Date.UTC(2026, 7, 0) = last day of July if ms=7. period "2026-07" → ms=7 → Date.UTC(2026,7,0)=July 31. Good.
  const end = endDate.toISOString().slice(0, 10)
  return { start, end, endExclusive }
}

async function loadResellerTenant(supabase: SupabaseClient, resellerId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,tenant_type&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
}

async function loadEnterpriseTenant(supabase: SupabaseClient, enterpriseId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
}

async function listEnterpriseIdsForReseller(supabase: SupabaseClient, resellerId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
  )
  return Array.isArray(rows)
    ? rows.map((r) => (r as Record<string, unknown>)?.tenant_id).filter(Boolean).map(String)
    : []
}

export type MonthlyRollupScopeResult =
  | { ok: true; resellerId: string | null; enterpriseId: string | null; enterpriseIds: string[] | null }
  | { ok: false; status: number; code: string; message: string }

/**
 * Validate resellerId / enterpriseId for USAGE_MONTHLY_ROLLUP enqueue + execution.
 * - reseller callers: resellerId optional but must match token; enterprise must belong to that reseller
 * - platform callers: optional resellerId and/or enterpriseId; combinations must exist and match
 */
export async function resolveUsageMonthlyRollupScope(
  supabase: SupabaseClient,
  {
    roleScope,
    tokenResellerId,
    resellerId: resellerIdParam,
    enterpriseId: enterpriseIdParam,
  }: {
    roleScope: 'platform' | 'reseller'
    tokenResellerId?: string | null
    resellerId?: string | null
    enterpriseId?: string | null
  }
): Promise<MonthlyRollupScopeResult> {
  let resellerId = resellerIdParam ? String(resellerIdParam).trim() : null
  const enterpriseId = enterpriseIdParam ? String(enterpriseIdParam).trim() : null

  if (roleScope === 'reseller') {
    const token = tokenResellerId ? String(tokenResellerId).trim() : ''
    if (!token) {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Reseller scope is missing resellerId.' }
    }
    if (resellerId && resellerId !== token) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN',
        message: 'resellerId does not match reseller token.',
      }
    }
    resellerId = token
  }

  if (resellerId) {
    const reseller = await loadResellerTenant(supabase, resellerId)
    if (!reseller?.tenant_id) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Reseller not found.' }
    }
  }

  if (enterpriseId) {
    const enterprise = await loadEnterpriseTenant(supabase, enterpriseId)
    if (!enterprise?.tenant_id) {
      return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Enterprise not found.' }
    }
    const parentId = enterprise.parent_id ? String(enterprise.parent_id) : ''
    if (resellerId && parentId !== resellerId) {
      return {
        ok: false,
        status: 403,
        code: 'FORBIDDEN',
        message: 'Enterprise is not in reseller scope.',
      }
    }
    // Platform may pass enterpriseId alone: scope to that enterprise.
    if (!resellerId && roleScope === 'platform') {
      return {
        ok: true,
        resellerId: parentId || null,
        enterpriseId,
        enterpriseIds: null,
      }
    }
    return { ok: true, resellerId, enterpriseId, enterpriseIds: null }
  }

  if (resellerId) {
    const enterpriseIds = await listEnterpriseIdsForReseller(supabase, resellerId)
    return { ok: true, resellerId, enterpriseId: null, enterpriseIds }
  }

  // Platform global (cron / admin with no scope filters)
  if (roleScope === 'platform') {
    return { ok: true, resellerId: null, enterpriseId: null, enterpriseIds: null }
  }

  return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Reseller scope required.' }
}

async function loadEnterpriseList(
  supabase: SupabaseClient,
  enterpriseId?: string | null,
  resellerId?: string | null,
  enterpriseIds?: string[] | null
) {
  if (enterpriseId) {
    return [{ tenant_id: enterpriseId }]
  }
  if (enterpriseIds) {
    return enterpriseIds.map((id) => ({ tenant_id: id }))
  }
  if (resellerId) {
    const ids = await listEnterpriseIdsForReseller(supabase, resellerId)
    return ids.map((id) => ({ tenant_id: id }))
  }
  return null // null = global
}

function aggregateDailyRows(rows: DailyUsageRow[], usageMonth: string): MonthlyAgg[] {
  const map = new Map<string, MonthlyAgg>()
  for (const row of rows) {
    const iccid = row.iccid ? String(row.iccid) : ''
    const visited = row.visited_mccmnc != null ? String(row.visited_mccmnc) : ''
    if (!iccid || !visited) continue
    const supplierId = row.supplier_id ? String(row.supplier_id) : ''
    if (!supplierId) continue
    const key = `${iccid}\0${visited}`
    let agg = map.get(key)
    if (!agg) {
      agg = {
        supplier_id: supplierId,
        enterprise_id: row.enterprise_id ? String(row.enterprise_id) : null,
        sim_id: row.sim_id ? String(row.sim_id) : null,
        iccid,
        usage_month: usageMonth,
        visited_mccmnc: visited,
        uplink_mb: 0,
        downlink_mb: 0,
        total_mb: 0,
        in_profile_mb: 0,
        out_of_profile_mb: 0,
        unclassified_mb: 0,
        rated_at: null,
      }
      map.set(key, agg)
    }
    agg.uplink_mb += num(row.uplink_mb)
    agg.downlink_mb += num(row.downlink_mb)
    agg.total_mb += num(row.total_mb)
    agg.in_profile_mb += num(row.in_profile_mb)
    agg.out_of_profile_mb += num(row.out_of_profile_mb)
    agg.unclassified_mb += num(row.unclassified_mb)
    if (row.enterprise_id) agg.enterprise_id = String(row.enterprise_id)
    if (row.sim_id) agg.sim_id = String(row.sim_id)
    if (row.supplier_id) agg.supplier_id = String(row.supplier_id)
    if (row.rated_at) {
      if (!agg.rated_at || String(row.rated_at) > agg.rated_at) agg.rated_at = String(row.rated_at)
    }
  }
  return [...map.values()].map((a) => ({
    ...a,
    uplink_mb: Number(a.uplink_mb.toFixed(6)),
    downlink_mb: Number(a.downlink_mb.toFixed(6)),
    total_mb: Number(a.total_mb.toFixed(6)),
    in_profile_mb: Number(a.in_profile_mb.toFixed(6)),
    out_of_profile_mb: Number(a.out_of_profile_mb.toFixed(6)),
    unclassified_mb: Number(a.unclassified_mb.toFixed(6)),
  }))
}

async function fetchDailyForMonth(
  supabase: SupabaseClient,
  period: string,
  enterpriseIds: string[] | null
): Promise<DailyUsageRow[]> {
  const { start, end } = monthDateRange(period)
  const filters = [
    `usage_day=gte.${encodeURIComponent(start)}`,
    `usage_day=lte.${encodeURIComponent(end)}`,
  ]
  if (enterpriseIds) {
    if (!enterpriseIds.length) return []
    filters.push(`enterprise_id=in.(${enterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
  }
  const rows = await supabase.select(
    'usage_daily_summary',
    `select=supplier_id,enterprise_id,sim_id,iccid,usage_day,visited_mccmnc,uplink_mb,downlink_mb,total_mb,in_profile_mb,out_of_profile_mb,unclassified_mb,rated_at&${filters.join('&')}&limit=50000`,
    { suppressMissingColumns: true }
  )
  return Array.isArray(rows) ? (rows as DailyUsageRow[]) : []
}

async function replaceMonthlyRows(
  supabase: SupabaseClient,
  usageMonth: string,
  enterpriseIds: string[] | null,
  aggs: MonthlyAgg[],
  inputRef: string | null
) {
  if (typeof supabase.delete === 'function') {
    if (enterpriseIds) {
      for (const eid of enterpriseIds) {
        await supabase.delete(
          'usage_monthly_summary',
          `usage_month=eq.${encodeURIComponent(usageMonth)}&enterprise_id=eq.${encodeURIComponent(eid)}`
        )
      }
    } else {
      await supabase.delete('usage_monthly_summary', `usage_month=eq.${encodeURIComponent(usageMonth)}`)
    }
  }

  const nowIso = new Date().toISOString()
  const batchSize = 200
  for (let i = 0; i < aggs.length; i += batchSize) {
    const batch = aggs.slice(i, i + batchSize).map((a) => ({
      ...a,
      rolled_up_at: nowIso,
      updated_at: nowIso,
      input_ref: inputRef,
    }))
    // Prefer insert after delete; if delete unavailable, upsert via select+update/insert
    if (typeof supabase.delete === 'function') {
      await supabase.insert('usage_monthly_summary', batch, { returning: 'minimal', suppressMissingColumns: true })
      continue
    }
    for (const row of batch) {
      const match = `iccid=eq.${encodeURIComponent(row.iccid)}&usage_month=eq.${encodeURIComponent(row.usage_month)}&visited_mccmnc=eq.${encodeURIComponent(row.visited_mccmnc)}`
      const existing = await supabase.select('usage_monthly_summary', `select=usage_month_id&${match}&limit=1`, {
        suppressMissingColumns: true,
      })
      if (Array.isArray(existing) && existing[0] && (existing[0] as any).usage_month_id) {
        await supabase.update(
          'usage_monthly_summary',
          `usage_month_id=eq.${encodeURIComponent(String((existing[0] as any).usage_month_id))}`,
          row,
          { returning: 'minimal', suppressMissingColumns: true }
        )
      } else {
        await supabase.insert('usage_monthly_summary', row, { returning: 'minimal', suppressMissingColumns: true })
      }
    }
  }
}

/**
 * Roll up one calendar month from usage_daily_summary into usage_monthly_summary.
 * Idempotent: replaces scoped monthly rows for the month then inserts aggregates.
 * Does not create bills. Independent of package / ONE_TIME quota accounting.
 *
 * - Current UTC month is allowed (partial snapshot; later rollups overwrite).
 * - Future months are rejected.
 * - Periods with no usage_daily_summary rows in scope are rejected.
 */
export async function runUsageMonthlyRollup({
  supabase,
  period,
  enterpriseId,
  resellerId,
  jobId,
  now,
}: {
  supabase: SupabaseClient
  period?: string | null
  enterpriseId?: string | null
  resellerId?: string | null
  jobId?: string | null
  now?: Date
}): Promise<ServiceResult<Record<string, unknown>>> {
  const clock = now ?? new Date()
  const effectivePeriod = String(period || previousUtcYearMonth(clock)).trim()
  if (!isValidPeriod(effectivePeriod)) return toError(400, 'BAD_REQUEST', 'period must be YYYY-MM.')

  const currentPeriod = currentUtcYearMonth(clock)
  if (effectivePeriod > currentPeriod) {
    return toError(400, 'BAD_REQUEST', 'period cannot be a future calendar month.')
  }

  // Re-validate tenant scope at execution from job payload (worker has no user token).
  const scopeAtExec = await resolveUsageMonthlyRollupScope(supabase, {
    roleScope: 'platform',
    tokenResellerId: null,
    resellerId: resellerId ?? null,
    enterpriseId: enterpriseId ?? null,
  })
  if (!scopeAtExec.ok) {
    return toError(scopeAtExec.status, scopeAtExec.code, scopeAtExec.message)
  }

  const enterprises = await loadEnterpriseList(
    supabase,
    scopeAtExec.enterpriseId,
    scopeAtExec.resellerId,
    scopeAtExec.enterpriseIds
  )
  if (enterprises !== null && !enterprises.length) {
    return toError(404, 'NOT_FOUND', 'No enterprises found for usage monthly rollup scope.')
  }
  const enterpriseIds =
    enterprises === null ? null : enterprises.map((e) => String((e as any).tenant_id)).filter(Boolean)

  const usageMonth = periodToMonthStart(effectivePeriod)
  const daily = await fetchDailyForMonth(supabase, effectivePeriod, enterpriseIds)
  if (!daily.length) {
    return toError(
      404,
      'NOT_FOUND',
      `No usage_daily_summary rows found for period ${effectivePeriod}.`,
    )
  }
  const aggs = aggregateDailyRows(daily, usageMonth)
  await replaceMonthlyRows(supabase, usageMonth, enterpriseIds, aggs, jobId ? String(jobId) : 'USAGE_MONTHLY_ROLLUP')

  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(jobId)}`,
      {
        status: 'SUCCEEDED',
        progress_processed: aggs.length,
        progress_total: aggs.length,
        finished_at: new Date().toISOString(),
      },
      { returning: 'minimal', suppressMissingColumns: true }
    )
  }

  return {
    ok: true,
    value: {
      period: effectivePeriod,
      usageMonth,
      sourceDailyRows: daily.length,
      monthlyRows: aggs.length,
    },
  }
}

/**
 * After daily summary writes: refresh monthly snapshots for any **past** calendar months touched.
 * Current open month is left to the month-end / cron job.
 */
export async function refreshPastMonthsAfterDailyWrite(
  supabase: SupabaseClient,
  usageDays: Iterable<string>,
  options?: { jobId?: string | null }
): Promise<{ months: string[]; results: Array<ServiceResult<Record<string, unknown>>> }> {
  const months = pastMonthsTouchedByUsageDays(usageDays)
  const results: Array<ServiceResult<Record<string, unknown>>> = []
  for (const period of months) {
    results.push(
      await runUsageMonthlyRollup({
        supabase,
        period,
        jobId: options?.jobId ?? null,
      })
    )
  }
  return { months, results }
}

/**
 * Split a report date window for hybrid monthly/daily reads.
 * Complete past calendar months fully inside [start,end] → monthly table; remainder → daily.
 */
export function splitReportWindowForUsageSources(
  startDay: Date,
  endDay: Date,
  now: Date = new Date()
): {
  monthlyPeriods: string[]
  dailyRanges: Array<{ startDay: Date; endDay: Date }>
} {
  const currentYm = currentUtcYearMonth(now)
  const monthlyPeriods: string[] = []
  const dailyRanges: Array<{ startDay: Date; endDay: Date }> = []

  let cursor = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), 1))
  const endMonth = new Date(Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth(), 1))

  while (cursor.getTime() <= endMonth.getTime()) {
    const y = cursor.getUTCFullYear()
    const m = cursor.getUTCMonth()
    const ym = `${y}-${String(m + 1).padStart(2, '0')}`
    const monthStart = new Date(Date.UTC(y, m, 1))
    const monthEnd = new Date(Date.UTC(y, m + 1, 0))
    const sliceStart = startDay.getTime() > monthStart.getTime() ? startDay : monthStart
    const sliceEnd = endDay.getTime() < monthEnd.getTime() ? endDay : monthEnd
    if (sliceStart.getTime() > sliceEnd.getTime()) {
      cursor = new Date(Date.UTC(y, m + 1, 1))
      continue
    }
    const fullyCovered =
      startDay.getTime() <= monthStart.getTime() && endDay.getTime() >= monthEnd.getTime()
    const isPastComplete = ym < currentYm
    if (fullyCovered && isPastComplete) {
      monthlyPeriods.push(ym)
    } else {
      dailyRanges.push({ startDay: sliceStart, endDay: sliceEnd })
    }
    cursor = new Date(Date.UTC(y, m + 1, 1))
  }

  return { monthlyPeriods, dailyRanges }
}
