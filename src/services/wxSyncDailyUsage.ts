import { parsePagination } from '../utils/pagination.js'
import { refreshPastMonthsAfterDailyWrite } from './usageMonthlyRollup.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
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
}

type WxClient = {
  ping: () => Promise<boolean>
  request: (method: string, path: string, options?: { body?: unknown }) => Promise<any>
}

export type WxSyncDailyUsageOptions = {
  /** Required: scopes SIMs and must match the loaded upstream integration. */
  supplierId: string
  /** Required: operators.operator_id (or dictionary id resolvable for supplier). */
  operatorId: string
  enterpriseId?: string | null
  startDate?: Date
  endDate?: Date
  page?: number | string | null
  pageSize?: number | string | null
  usageDailyPath?: string
  requestId?: string | null
  sourceIp?: string | null
  integrationId?: string | null
}

export type WxSyncDailyUsageIccidResult = {
  iccid: string
  /** Number of usage_daily_summary rows upserted for this ICCID in this run. */
  upsertedRows: number
  /** Distinct usage days that received at least one upsert. */
  daysWithData: string[]
  /** Sum of total_mb written/updated across upserts in this run. */
  totalMb: number
}

export type WxSyncDailyUsageResult = {
  jobId: string | null
  /** Total usage_daily_summary upserts performed in this run. */
  processed: number
  /** Total ACTIVATED SIMs matching the scope (all pages). */
  total: number
  page: number
  pageSize: number
  startDate: string
  endDate: string
  /** True when upstream ping succeeded before sync. */
  upstreamReachable: boolean
  /** Upstream batch request failures swallowed during sync (date × batch). */
  upstreamBatchFailures: number
  /** Per-ICCID outcomes for SIMs on this page. */
  processedICCID: WxSyncDailyUsageIccidResult[]
}

function startOfDayUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addDaysUtc(date: Date, days: number) {
  const d = new Date(date.getTime())
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

async function finishSucceeded(
  supabase: SupabaseClient,
  jobId: string | null,
  audit: {
    enterpriseId: string | null
    requestId: string | null
    sourceIp: string | null
    processed: number
    total: number
    page: number
    pageSize: number
    startDate: Date
    endDate: Date
    upstreamReachable: boolean
    upstreamBatchFailures: number
    processedICCID: WxSyncDailyUsageIccidResult[]
    integrationId?: string | null
  }
) {
  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(jobId)}`,
      {
        status: 'SUCCEEDED',
        finished_at: new Date().toISOString(),
      },
      { returning: 'minimal' }
    )
  }
  await supabase.insert(
    'audit_logs',
    {
      actor_role: 'ADMIN',
      tenant_id: audit.enterpriseId ?? null,
      action: 'ADMIN_WX_SYNC_DAILY_USAGE_RUN',
      target_type: 'SIM_BATCH',
      target_id: audit.enterpriseId ?? 'ALL',
      request_id: audit.requestId,
      source_ip: audit.sourceIp,
      after_data: {
        processed: audit.processed,
        total: audit.total,
        page: audit.page,
        pageSize: audit.pageSize,
        startDate: audit.startDate.toISOString(),
        endDate: audit.endDate.toISOString(),
        upstreamReachable: audit.upstreamReachable,
        upstreamBatchFailures: audit.upstreamBatchFailures,
        integrationId: audit.integrationId ?? null,
        processedICCID: audit.processedICCID,
      },
    },
    { returning: 'minimal' }
  )
}

function emptyIccidResult(iccid: string): WxSyncDailyUsageIccidResult {
  return { iccid, upsertedRows: 0, daysWithData: [], totalMb: 0 }
}

export async function runWxSyncDailyUsage(
  supabase: SupabaseClient,
  client: WxClient,
  options: WxSyncDailyUsageOptions
): Promise<WxSyncDailyUsageResult> {
  const supplierId = String(options.supplierId).trim()
  const operatorId = String(options.operatorId).trim()
  const enterpriseId = options.enterpriseId ? String(options.enterpriseId) : null
  const startDate = options.startDate ?? new Date(Date.now() - 24 * 3600 * 1000)
  const endDate = options.endDate ?? new Date()
  const { page, pageSize } = parsePagination(
    { page: options.page, pageSize: options.pageSize },
    { defaultPage: 1, defaultPageSize: 100, maxPageSize: 100 }
  )
  const offset = (page - 1) * pageSize
  const path =
    options.usageDailyPath?.trim() ||
    '/sim-card/card/card-info/api/queryCdrFlowByDate'

  const filters: string[] = [
    `supplier_id=eq.${encodeURIComponent(supplierId)}`,
    `operator_id=eq.${encodeURIComponent(operatorId)}`,
    'status=eq.ACTIVATED',
  ]
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)

  const r = await supabase.selectWithCount(
    'sims',
    `select=sim_id,iccid,enterprise_id,supplier_id,operator_id,apn,status&${filters.join('&')}&order=sim_id.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
  )
  const sims: any[] = Array.isArray(r.data) ? (r.data as any[]) : []
  const total = typeof r.total === 'number' ? r.total : sims.length

  const perIccid = new Map<string, WxSyncDailyUsageIccidResult>()
  for (const s of sims) {
    const iccid = String(s.iccid || '')
    if (iccid) perIccid.set(iccid, emptyIccidResult(iccid))
  }

  const jobs = await supabase.insert('jobs', {
    job_type: 'WX_SYNC_DAILY_USAGE',
    status: 'RUNNING',
    progress_processed: 0,
    progress_total: Number(total ?? sims.length),
    started_at: new Date().toISOString(),
    request_id: options.requestId ?? null,
    ...(enterpriseId ? { enterprise_id: enterpriseId } : {}),
  })
  const jobId = Array.isArray(jobs) ? (jobs[0] as any)?.job_id ?? null : null
  let processed = 0
  let upstreamBatchFailures = 0
  let upstreamReachable = false

  const buildResult = (reachable: boolean): WxSyncDailyUsageResult => ({
    jobId,
    processed,
    total,
    page,
    pageSize,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    upstreamReachable: reachable,
    upstreamBatchFailures,
    processedICCID: Array.from(perIccid.values()),
  })

  const auditBase = {
    enterpriseId,
    requestId: options.requestId ?? null,
    sourceIp: options.sourceIp ?? null,
    total,
    page,
    pageSize,
    startDate,
    endDate,
    integrationId: options.integrationId ?? null,
  }

  if (!sims.length) {
    const result = buildResult(false)
    await finishSucceeded(supabase, jobId, {
      ...auditBase,
      processed: 0,
      upstreamReachable: false,
      upstreamBatchFailures: 0,
      processedICCID: result.processedICCID,
    })
    return result
  }

  try {
    upstreamReachable = await client.ping()
  } catch {
    upstreamReachable = false
  }
  if (!upstreamReachable) {
    const result = buildResult(false)
    await finishSucceeded(supabase, jobId, {
      ...auditBase,
      processed: 0,
      upstreamReachable: false,
      upstreamBatchFailures: 0,
      processedICCID: result.processedICCID,
    })
    return result
  }

  let startDay = startOfDayUtc(startDate)
  let endDay = startOfDayUtc(endDate)
  if (endDay < startDay) endDay = startDay
  const simMap = new Map(sims.map((s) => [String(s.iccid), s]))

  // Upstream batch size: reuse pageSize as max ICCIDs per upstream request (already ≤ 100).
  const upstreamBatchSize = pageSize

  for (let day = startDay; day <= endDay; day = addDaysUtc(day, 1)) {
    const dateStr = day.toISOString().slice(0, 10)
    for (let batchOffset = 0; batchOffset < sims.length; batchOffset += upstreamBatchSize) {
      const batch = sims.slice(batchOffset, batchOffset + upstreamBatchSize).map((s) => String(s.iccid))
      if (!batch.length) break
      let resp: any = null
      try {
        resp = await client.request('POST', path, {
          body: { iccids: batch, date: dateStr },
        })
      } catch {
        resp = null
      }
      if (resp == null) {
        upstreamBatchFailures += 1
        continue
      }
      const rows = Array.isArray(resp?.data) ? resp.data : []
      for (const row of rows) {
        const iccid = String(row.iccid || row.msisdn || '')
        if (!iccid) continue
        const usedFlow = Number(row.usedFlow ?? row.totalFlow ?? 0)
        const totalMb = Math.max(0, Math.floor(usedFlow))
        const uplinkMb = 0
        const downlinkMb = totalMb
        const apn = row.apn ? String(row.apn) : null
        const rat = row.rat ? String(row.rat) : null
        const sim = simMap.get(iccid)
        if (!sim) continue
        const usageDay = dateStr
        const visited = String(row.visitedMccMnc || row.mccmnc || row.mccMnc || '204-08')
        const match = `iccid=eq.${encodeURIComponent(iccid)}&usage_day=eq.${encodeURIComponent(usageDay)}&visited_mccmnc=eq.${encodeURIComponent(visited)}`
        const existing = await supabase.select('usage_daily_summary', `select=usage_id&${match}&limit=1`)
        if (Array.isArray(existing) && existing.length > 0) {
          const usageId = (existing[0] as any)?.usage_id
          await supabase.update(
            'usage_daily_summary',
            `usage_id=eq.${encodeURIComponent(String(usageId))}`,
            {
              uplink_mb: uplinkMb,
              downlink_mb: downlinkMb,
              total_mb: totalMb,
              apn: apn ?? null,
              rat: rat ?? null,
              input_ref: jobId ?? null,
              updated_at: new Date().toISOString(),
            },
            { returning: 'minimal' }
          )
        } else {
          await supabase.insert(
            'usage_daily_summary',
            {
              supplier_id: sim.supplier_id,
              enterprise_id: sim.enterprise_id ?? null,
              sim_id: sim.sim_id ?? null,
              iccid,
              usage_day: usageDay,
              visited_mccmnc: visited,
              uplink_mb: uplinkMb,
              downlink_mb: downlinkMb,
              total_mb: totalMb,
              apn: apn ?? null,
              rat: rat ?? null,
              input_ref: jobId ?? null,
              updated_at: new Date().toISOString(),
            },
            { returning: 'minimal' }
          )
        }
        processed += 1
        const item = perIccid.get(iccid) ?? emptyIccidResult(iccid)
        item.upsertedRows += 1
        item.totalMb += totalMb
        if (!item.daysWithData.includes(usageDay)) item.daysWithData.push(usageDay)
        perIccid.set(iccid, item)
      }
      if (jobId) {
        await supabase.update(
          'jobs',
          `job_id=eq.${encodeURIComponent(jobId)}`,
          {
            progress_processed: processed,
            progress_total: Math.max(processed, Number(total ?? sims.length)),
          },
          { returning: 'minimal' }
        )
      }
    }
  }

  const result = buildResult(true)
  const touchedDays = [...perIccid.values()].flatMap((item) => item.daysWithData)
  try {
    await refreshPastMonthsAfterDailyWrite(supabase, touchedDays)
  } catch (err) {
    console.error('[wx-sync-daily-usage] monthly rollup refresh failed:', err)
  }
  await finishSucceeded(supabase, jobId, {
    ...auditBase,
    processed,
    upstreamReachable: true,
    upstreamBatchFailures,
    processedICCID: result.processedICCID,
  })
  return result
}
