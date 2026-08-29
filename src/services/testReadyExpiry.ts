import { parsePagination } from '../utils/pagination.js'
import { changeSimStatus } from './simLifecycle.js'
import { isLifecycleInProgress } from './simStatusChangeJob.js'

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

export type TestReadyExpiryTrigger = 'ADMIN' | 'CRON'

export type TestReadyExpiryRunOptions = {
  enterpriseId?: string | null
  page?: number
  pageSize?: number
  requestId?: string | null
  sourceIp?: string | null
  /** ADMIN = manual API; CRON = worker schedule. Same rules either way. */
  trigger?: TestReadyExpiryTrigger
  /**
   * Cron/drain: walk all TEST_READY SIMs via sim_id cursor (ignores page).
   * Admin default remains paginated.
   */
  sweepAll?: boolean
  /** Max SIMs to examine per sweep (safety). Default 5000. */
  maxExamine?: number
}

export type TestReadyExpiryProcessedItem = {
  iccid: string
  /** Target after enqueue, or TEST_READY when skipped. */
  status: 'INVENTORY' | 'TEST_READY' | 'ACTIVATED' | 'DEACTIVATED' | 'RETIRED'
  path?: 'COMMERCIAL_TERMS' | 'NO_MAIN_OR_TERMS_FALLBACK'
  lifecycleJobId?: string | null
  skipReason?: string | null
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

type SimRow = {
  sim_id: string
  iccid: string
  enterprise_id?: string | null
  reseller_id?: string | null
  status?: string | null
  last_status_change_at?: string | null
  lifecycle_sub_status?: string | null
}

/** Days in TEST_READY without resolvable MAIN+Commercial Terms before force DEACTIVATED. */
export function getTestReadyDaysWithoutMainSubscription(): number {
  const raw =
    process.env.TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION ??
    process.env.TEST_PERIOD_DAYS /* legacy alias */
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return 30
  return Math.min(3650, Math.floor(n))
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

/** MAIN in ACTIVE | PROVISIONING | PENDING, plus parseable Commercial Terms — or null. */
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

async function enqueueLifecycleTransition({
  supabase,
  sim,
  targetStatus,
  reason,
  requestId,
}: {
  supabase: SupabaseClient
  sim: SimRow
  targetStatus: 'ACTIVATED' | 'DEACTIVATED'
  reason: string
  requestId: string | null
}): Promise<{ ok: true; jobId: string | null } | { ok: false; skipReason: string }> {
  const action = targetStatus === 'ACTIVATED' ? 'SIM_ACTIVATE' : 'SIM_DEACTIVATE'
  // No fixed idempotency key: failed *ing can retry next cron; in-progress is blocked by LIFECYCLE_IN_PROGRESS.
  const result = await changeSimStatus({
    supabase,
    simIdentifier: { field: 'sim_id', value: String(sim.sim_id) },
    tenantQs: '',
    action,
    newStatus: targetStatus,
    allowedFrom: new Set(['TEST_READY']),
    reason,
    idempotencyKey: null,
    actor: {
      userId: null,
      resellerId: sim.reseller_id ? String(sim.reseller_id) : null,
      role: 'SYSTEM',
      roleScope: 'platform',
    },
    traceId: requestId,
    sourceIp: null,
  })
  if (!result.ok) {
    return { ok: false, skipReason: `${result.code}:${result.message}` }
  }
  return { ok: true, jobId: (result as { jobId?: string | null }).jobId ?? null }
}

type EvalDecision =
  | { kind: 'skip'; reason: string }
  | {
      kind: 'enqueue'
      targetStatus: 'ACTIVATED' | 'DEACTIVATED'
      path: 'COMMERCIAL_TERMS' | 'NO_MAIN_OR_TERMS_FALLBACK'
      reason: string
      meta: Record<string, unknown>
    }

async function decideTestReadyExpiry(
  supabase: SupabaseClient,
  sim: SimRow,
  fallbackDays: number
): Promise<EvalDecision> {
  if (isLifecycleInProgress(sim.lifecycle_sub_status)) {
    return { kind: 'skip', reason: `LIFECYCLE_IN_PROGRESS:${sim.lifecycle_sub_status}` }
  }

  const startTimeIso = await resolveTestReadyStartIso(supabase, sim)
  if (!startTimeIso) {
    return { kind: 'skip', reason: 'NO_TEST_READY_START' }
  }
  const startTime = new Date(startTimeIso)

  const terms = await resolveCommercialTermsForSim(supabase, String(sim.sim_id))
  if (terms) {
    const expireByPeriod = Date.now() >= addDaysUtc(startTime, terms.testPeriodDays).getTime()
    const totalMb = await sumUsageMbSince(supabase, sim, startTime)
    const expireByQuota = terms.testQuotaMb > 0 ? totalMb >= terms.testQuotaMb : false
    const expired = shouldExpire({
      condition: terms.testExpiryCondition,
      expireByPeriod,
      expireByQuota,
    })
    if (!expired) {
      return { kind: 'skip', reason: 'COMMERCIAL_TERMS_NOT_EXPIRED' }
    }
    const expiryBy =
      expireByPeriod && expireByQuota ? 'PERIOD_OR_QUOTA' : expireByPeriod ? 'PERIOD' : 'QUOTA'
    return {
      kind: 'enqueue',
      targetStatus: terms.testExpiryAction,
      path: 'COMMERCIAL_TERMS',
      reason: `TEST_READY_EXPIRY_COMMERCIAL_TERMS:${expiryBy}`,
      meta: {
        expiryBy,
        totalMb,
        testPeriodDays: terms.testPeriodDays,
        testQuotaMb: terms.testQuotaMb,
        testExpiryCondition: terms.testExpiryCondition,
        testExpiryAction: terms.testExpiryAction,
        packageId: terms.packageId,
        commercialTermsId: terms.commercialTermsId,
        startTime: startTimeIso,
      },
    }
  }

  // No MAIN (ACTIVE/PROVISIONING/PENDING) or MAIN without parseable Commercial Terms → fallback.
  const fallbackExpired = Date.now() >= addDaysUtc(startTime, fallbackDays).getTime()
  if (!fallbackExpired) {
    return { kind: 'skip', reason: 'FALLBACK_NOT_EXPIRED' }
  }
  return {
    kind: 'enqueue',
    targetStatus: 'DEACTIVATED',
    path: 'NO_MAIN_OR_TERMS_FALLBACK',
    reason: `TEST_READY_EXPIRY_NO_MAIN_OR_TERMS:${fallbackDays}d`,
    meta: {
      fallbackDays,
      envKey: 'TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION',
      startTime: startTimeIso,
    },
  }
}

async function processSimBatch({
  supabase,
  sims,
  requestId,
  fallbackDays,
}: {
  supabase: SupabaseClient
  sims: SimRow[]
  requestId: string | null
  fallbackDays: number
}): Promise<{
  processed: number
  activated: number
  deactivated: number
  skipped: number
  processedICCID: TestReadyExpiryProcessedItem[]
}> {
  let processed = 0
  let activated = 0
  let deactivated = 0
  let skipped = 0
  const processedICCID: TestReadyExpiryProcessedItem[] = []

  for (const sim of sims) {
    processed += 1
    const iccid = String(sim.iccid)
    const decision = await decideTestReadyExpiry(supabase, sim, fallbackDays)
    if (decision.kind === 'skip') {
      skipped += 1
      processedICCID.push({ iccid, status: 'TEST_READY', skipReason: decision.reason })
      continue
    }

    const enq = await enqueueLifecycleTransition({
      supabase,
      sim,
      targetStatus: decision.targetStatus,
      reason: decision.reason,
      requestId,
    })
    if (!enq.ok) {
      skipped += 1
      processedICCID.push({
        iccid,
        status: 'TEST_READY',
        path: decision.path,
        skipReason: enq.skipReason,
      })
      continue
    }

    // SIM_STATUS_CHANGED is emitted when SIM_STATUS_CHANGE job finalizes (upstream complete).

    if (decision.targetStatus === 'ACTIVATED') {
      activated += 1
      processedICCID.push({
        iccid,
        status: 'ACTIVATED',
        path: decision.path,
        lifecycleJobId: enq.jobId,
      })
    } else {
      deactivated += 1
      processedICCID.push({
        iccid,
        status: 'DEACTIVATED',
        path: decision.path,
        lifecycleJobId: enq.jobId,
      })
    }
  }

  return { processed, activated, deactivated, skipped, processedICCID }
}

/**
 * Evaluate TEST_READY SIMs:
 * - With MAIN + Commercial Terms → period/quota/action from terms; enqueue SIM_STATUS_CHANGE (upstream).
 * - Without MAIN or without parseable terms → after TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION, enqueue DEACTIVATE.
 * Does not use autoSuspendEnabled / enterprise auto-suspend.
 */
export async function runTestReadyExpiryEvaluation(
  supabase: SupabaseClient,
  options: TestReadyExpiryRunOptions = {}
): Promise<TestReadyExpiryRunResult> {
  const enterpriseId = options.enterpriseId ? String(options.enterpriseId).trim() : null
  const trigger: TestReadyExpiryTrigger = options.trigger === 'CRON' ? 'CRON' : 'ADMIN'
  const sweepAll = options.sweepAll === true || trigger === 'CRON'
  const fallbackDays = getTestReadyDaysWithoutMainSubscription()
  const requestId = options.requestId ?? null
  const maxExamine = Math.max(100, Math.min(20000, Number(options.maxExamine) || 5000))

  const { page, pageSize, offset } = parsePagination(
    { page: options.page, pageSize: options.pageSize },
    { defaultPage: 1, defaultPageSize: 100, maxPageSize: 100 }
  )

  const baseFilters = [`status=eq.TEST_READY`]
  if (enterpriseId) baseFilters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)

  const jobs = await supabase.insert(
    'jobs',
    {
      job_type: 'TEST_READY_EXPIRY',
      status: 'RUNNING',
      progress_processed: 0,
      progress_total: 0,
      started_at: new Date().toISOString(),
      request_id: requestId,
      enterprise_id: enterpriseId,
      payload: {
        page,
        pageSize,
        enterpriseId,
        trigger,
        sweepAll,
        fallbackDays,
      },
    },
    { suppressMissingColumns: true }
  )
  const jobId = Array.isArray(jobs) ? ((jobs[0] as { job_id?: string })?.job_id ?? null) : null

  let processed = 0
  let activated = 0
  let deactivated = 0
  let skipped = 0
  const processedICCID: TestReadyExpiryProcessedItem[] = []
  let totalCount = 0

  if (sweepAll) {
    let afterSimId = ''
    let examined = 0
    for (;;) {
      if (examined >= maxExamine) break
      const limit = Math.min(100, maxExamine - examined)
      const cursorQs = afterSimId ? `&sim_id=gt.${encodeURIComponent(afterSimId)}` : ''
      const rows = await supabase.select(
        'sims',
        `select=sim_id,iccid,enterprise_id,reseller_id,status,last_status_change_at,lifecycle_sub_status&${baseFilters.join('&')}&order=sim_id.asc&limit=${limit}${cursorQs}`
      )
      const sims = (Array.isArray(rows) ? rows : []) as SimRow[]
      if (sims.length === 0) break
      examined += sims.length
      afterSimId = String(sims[sims.length - 1]?.sim_id || afterSimId)

      const batch = await processSimBatch({
        supabase,
        sims,
        requestId,
        fallbackDays,
      })
      processed += batch.processed
      activated += batch.activated
      deactivated += batch.deactivated
      skipped += batch.skipped
      processedICCID.push(...batch.processedICCID)

      if (sims.length < limit) break
    }
    totalCount = processed
  } else {
    const { data, total } = await supabase.selectWithCount(
      'sims',
      `select=sim_id,iccid,enterprise_id,reseller_id,status,last_status_change_at,lifecycle_sub_status&${baseFilters.join('&')}&order=last_status_change_at.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
    )
    const sims = (Array.isArray(data) ? data : []) as SimRow[]
    totalCount = typeof total === 'number' ? total : sims.length
    const batch = await processSimBatch({
      supabase,
      sims,
      requestId,
      fallbackDays,
    })
    processed = batch.processed
    activated = batch.activated
    deactivated = batch.deactivated
    skipped = batch.skipped
    processedICCID.push(...batch.processedICCID)
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
      actor_role: trigger === 'CRON' ? 'SYSTEM' : 'ADMIN',
      tenant_id: enterpriseId ?? null,
      action: trigger === 'CRON' ? 'CRON_TEST_READY_EXPIRY_RUN' : 'ADMIN_TEST_READY_EXPIRY_RUN',
      target_type: 'SIM_BATCH',
      target_id: enterpriseId ?? 'ALL',
      request_id: requestId,
      source_ip: options.sourceIp ?? null,
      after_data: {
        processed,
        activated,
        deactivated,
        skipped,
        total: totalCount,
        page,
        pageSize,
        sweepAll,
        fallbackDays,
        trigger,
        processedICCID,
      },
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
    page: sweepAll ? 1 : page,
    pageSize: sweepAll ? processed : pageSize,
    processedICCID,
  }
}
