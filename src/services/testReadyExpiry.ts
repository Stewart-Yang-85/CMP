import { emitEvent } from './eventEmitter.js'
import { parsePagination } from '../utils/pagination.js'

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

export type TestReadyExpiryRunOptions = {
  enterpriseId?: string | null
  page?: number
  pageSize?: number
  requestId?: string | null
  sourceIp?: string | null
}

export type TestReadyExpiryProcessedItem = {
  iccid: string
  /** SIM lifecycle status after this run (steady state). */
  status: 'INVENTORY' | 'TEST_READY' | 'ACTIVATED' | 'DEACTIVATED' | 'RETIRED'
}

export type TestReadyExpiryRunResult = {
  jobId: string | null
  processed: number
  activated: number
  deactivated: number
  skipped: number
  total: number
  page: number
  pageSize: number
  processedICCID: TestReadyExpiryProcessedItem[]
}

type CommercialTermsConfig = {
  testPeriodDays: number
  testQuotaMb: number
  testExpiryCondition: 'PERIOD_ONLY' | 'QUOTA_ONLY' | 'PERIOD_OR_QUOTA'
  testExpiryAction: 'ACTIVATED' | 'DEACTIVATED'
  commercialTermsId: string
  packageId: string
}

function startOfDayUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
}

function addDaysUtc(date: Date, days: number) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function parseCommercialTerms(
  raw: unknown,
  packageId: string,
  commercialTermsId: string
): CommercialTermsConfig | null {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const periodRaw = src.testPeriodDays ?? src.test_period_days
  const quotaRaw = src.testQuotaMb ?? src.test_quota_mb
  const condRaw = String(src.testExpiryCondition ?? src.test_expiry_condition ?? 'PERIOD_OR_QUOTA')
    .trim()
    .toUpperCase()
  const actionRaw = String(src.testExpiryAction ?? src.test_expiry_action ?? 'ACTIVATED')
    .trim()
    .toUpperCase()

  const testPeriodDays = Number(periodRaw)
  const testQuotaMb = Number(quotaRaw)
  if (!Number.isFinite(testPeriodDays) || testPeriodDays < 0) return null
  if (!Number.isFinite(testQuotaMb) || testQuotaMb < 0) return null

  const testExpiryCondition =
    condRaw === 'PERIOD_ONLY' || condRaw === 'QUOTA_ONLY' || condRaw === 'PERIOD_OR_QUOTA'
      ? condRaw
      : 'PERIOD_OR_QUOTA'
  const testExpiryAction = actionRaw === 'DEACTIVATED' ? 'DEACTIVATED' : 'ACTIVATED'

  return {
    testPeriodDays: Math.max(0, Math.floor(testPeriodDays)),
    testQuotaMb: Math.max(0, testQuotaMb),
    testExpiryCondition,
    testExpiryAction,
    commercialTermsId,
    packageId,
  }
}

async function resolveCommercialTermsForSim(
  supabase: SupabaseClient,
  simId: string
): Promise<CommercialTermsConfig | null> {
  const subRows = await supabase.select(
    'subscriptions',
    `select=subscription_id,package_id,state,effective_at&sim_id=eq.${encodeURIComponent(simId)}&subscription_kind=eq.MAIN&state=in.(ACTIVE,PROVISIONING,PENDING)&order=effective_at.desc&limit=1`
  )
  const sub = Array.isArray(subRows) ? (subRows[0] as { package_id?: string } | undefined) : undefined
  const packageId = sub?.package_id ? String(sub.package_id) : ''
  if (!packageId) return null

  const pkgRows = await supabase.select(
    'packages',
    `select=package_id,commercial_terms_id&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  const pkg = Array.isArray(pkgRows)
    ? (pkgRows[0] as { commercial_terms_id?: string } | undefined)
    : undefined
  const commercialTermsId = pkg?.commercial_terms_id ? String(pkg.commercial_terms_id) : ''
  if (!commercialTermsId) return null

  const ctRows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,commercial_terms&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const ct = Array.isArray(ctRows)
    ? (ctRows[0] as { commercial_terms?: unknown } | undefined)
    : undefined
  return parseCommercialTerms(ct?.commercial_terms, packageId, commercialTermsId)
}

async function resolveTestReadyStartIso(
  supabase: SupabaseClient,
  sim: { sim_id: string; last_status_change_at?: string | null }
): Promise<string | null> {
  if (sim.last_status_change_at) {
    const d = new Date(sim.last_status_change_at)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  const hist = await supabase.select(
    'sim_state_history',
    `select=start_time&sim_id=eq.${encodeURIComponent(sim.sim_id)}&after_status=eq.TEST_READY&order=start_time.desc&limit=1`
  )
  const h = Array.isArray(hist) ? (hist[0] as { start_time?: string } | undefined) : undefined
  if (!h?.start_time) return null
  const d = new Date(h.start_time)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

async function sumUsageMbSince(
  supabase: SupabaseClient,
  sim: { iccid: string; enterprise_id?: string | null },
  startTime: Date
): Promise<number> {
  const startDay = startOfDayUtc(startTime).toISOString().slice(0, 10)
  const enterpriseQs = sim.enterprise_id
    ? `&enterprise_id=eq.${encodeURIComponent(String(sim.enterprise_id))}`
    : ''
  const usageRows = await supabase.select(
    'usage_daily_summary',
    `select=total_mb,usage_day&iccid=eq.${encodeURIComponent(sim.iccid)}${enterpriseQs}&usage_day=gte.${encodeURIComponent(startDay)}`
  )
  let totalMb = 0
  if (Array.isArray(usageRows)) {
    for (const r of usageRows as Array<{ total_mb?: number }>) {
      totalMb += Number(r.total_mb ?? 0)
    }
  }
  return totalMb
}

function shouldExpire(opts: {
  condition: CommercialTermsConfig['testExpiryCondition']
  expireByPeriod: boolean
  expireByQuota: boolean
}) {
  if (opts.condition === 'PERIOD_ONLY') return opts.expireByPeriod
  if (opts.condition === 'QUOTA_ONLY') return opts.expireByQuota
  return opts.expireByPeriod || opts.expireByQuota
}

/**
 * Manual admin batch: evaluate TEST_READY SIMs using each SIM's MAIN subscription
 * Package → Commercial Terms (testPeriodDays / testQuotaMb / testExpiryCondition / testExpiryAction).
 * Does NOT use process.env TEST_EXPIRY_* globals.
 */
export async function runTestReadyExpiryEvaluation(
  supabase: SupabaseClient,
  options: TestReadyExpiryRunOptions = {}
): Promise<TestReadyExpiryRunResult> {
  const enterpriseId = options.enterpriseId ? String(options.enterpriseId).trim() : null
  const { page, pageSize, offset } = parsePagination(
    { page: options.page, pageSize: options.pageSize },
    { defaultPage: 1, defaultPageSize: 100, maxPageSize: 100 }
  )
  const requestId = options.requestId ?? null

  const filters = [`status=eq.TEST_READY`]
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)

  const { data, total } = await supabase.selectWithCount(
    'sims',
    `select=sim_id,iccid,enterprise_id,reseller_id,status,last_status_change_at&${filters.join('&')}&order=last_status_change_at.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
  )
  const sims = Array.isArray(data) ? data : []
  const totalCount = typeof total === 'number' ? total : sims.length

  const jobs = await supabase.insert(
    'jobs',
    {
      job_type: 'TEST_READY_EXPIRY',
      status: 'RUNNING',
      progress_processed: 0,
      progress_total: sims.length,
      started_at: new Date().toISOString(),
      request_id: requestId,
      enterprise_id: enterpriseId,
      payload: { page, pageSize, enterpriseId },
    },
    { suppressMissingColumns: true }
  )
  const jobId = Array.isArray(jobs) ? ((jobs[0] as { job_id?: string })?.job_id ?? null) : null

  let processed = 0
  let activated = 0
  let deactivated = 0
  let skipped = 0
  const processedICCID: TestReadyExpiryProcessedItem[] = []

  for (const sim of sims as Array<{
    sim_id: string
    iccid: string
    enterprise_id?: string | null
    reseller_id?: string | null
    last_status_change_at?: string | null
  }>) {
    processed += 1
    const iccid = String(sim.iccid)

    const terms = await resolveCommercialTermsForSim(supabase, String(sim.sim_id))
    if (!terms) {
      skipped += 1
      processedICCID.push({ iccid, status: 'TEST_READY' })
      continue
    }

    const startTimeIso = await resolveTestReadyStartIso(supabase, sim)
    if (!startTimeIso) {
      skipped += 1
      processedICCID.push({ iccid, status: 'TEST_READY' })
      continue
    }

    const startTime = new Date(startTimeIso)
    const expireByPeriod = Date.now() >= addDaysUtc(startTime, terms.testPeriodDays).getTime()
    const totalMb = await sumUsageMbSince(supabase, sim, startTime)
    const expireByQuota = terms.testQuotaMb > 0 ? totalMb >= terms.testQuotaMb : false
    const expired = shouldExpire({
      condition: terms.testExpiryCondition,
      expireByPeriod,
      expireByQuota,
    })
    if (!expired) {
      skipped += 1
      processedICCID.push({ iccid, status: 'TEST_READY' })
      continue
    }

    const nowIso = new Date().toISOString()
    const afterStatus = terms.testExpiryAction
    await supabase.update(
      'sims',
      `sim_id=eq.${encodeURIComponent(sim.sim_id)}`,
      {
        status: afterStatus,
        lifecycle_sub_status: 'normal',
        last_status_change_at: nowIso,
      },
      { returning: 'minimal', suppressMissingColumns: true }
    )
    await supabase.insert(
      'sim_state_history',
      {
        sim_id: sim.sim_id,
        before_status: 'TEST_READY',
        after_status: afterStatus,
        start_time: startTimeIso,
        end_time: nowIso,
        source: 'TEST_EXPIRY_JOB',
        request_id: requestId,
      },
      { returning: 'minimal', suppressMissingColumns: true }
    )

    await emitEvent({
      eventType: 'SIM_STATUS_CHANGED',
      enterpriseId: sim.enterprise_id ?? null,
      resellerId: sim.reseller_id ?? null,
      requestId,
      jobId,
      occurredAt: nowIso,
      payload: {
        simId: sim.sim_id,
        iccid: sim.iccid,
        beforeStatus: 'TEST_READY',
        afterStatus,
        reason: 'TEST_EXPIRY_JOB',
        expiryBy:
          expireByPeriod && expireByQuota ? 'PERIOD_OR_QUOTA' : expireByPeriod ? 'PERIOD' : 'QUOTA',
        totalMb,
        testPeriodDays: terms.testPeriodDays,
        testQuotaMb: terms.testQuotaMb,
        testExpiryCondition: terms.testExpiryCondition,
        testExpiryAction: terms.testExpiryAction,
        packageId: terms.packageId,
        commercialTermsId: terms.commercialTermsId,
        startTime: startTimeIso,
        endTime: nowIso,
      },
    })

    if (afterStatus === 'ACTIVATED') {
      activated += 1
      processedICCID.push({ iccid, status: 'ACTIVATED' })
    } else {
      deactivated += 1
      processedICCID.push({ iccid, status: 'DEACTIVATED' })
    }
  }

  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(jobId)}`,
      {
        status: 'SUCCEEDED',
        finished_at: new Date().toISOString(),
        progress_processed: processed,
        progress_total: processed,
      },
      { returning: 'minimal' }
    )
  }

  await supabase.insert(
    'audit_logs',
    {
      actor_role: 'ADMIN',
      tenant_id: enterpriseId ?? null,
      action: 'ADMIN_TEST_READY_EXPIRY_RUN',
      target_type: 'SIM_BATCH',
      target_id: enterpriseId ?? 'ALL',
      request_id: requestId,
      source_ip: options.sourceIp ?? null,
      after_data: { processed, activated, deactivated, skipped, total: totalCount, page, pageSize, processedICCID },
    },
    { returning: 'minimal', suppressMissingColumns: true }
  )

  return {
    jobId,
    processed,
    activated,
    deactivated,
    skipped,
    total: totalCount,
    page,
    pageSize,
    processedICCID,
  }
}
