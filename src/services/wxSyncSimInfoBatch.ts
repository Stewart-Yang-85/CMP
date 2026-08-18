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

type WxClient = {
  ping: () => Promise<boolean>
  getSimInfoBatch: (iccids: string[]) => Promise<any>
}

export type WxSyncSimInfoBatchOptions = {
  /** Required: scopes SIMs and must match the loaded upstream integration. */
  supplierId: string
  /** Required: operators.operator_id (or dictionary id resolvable for supplier). */
  operatorId: string
  enterpriseId?: string | null
  page?: number | string | null
  pageSize?: number | string | null
  requestId?: string | null
  sourceIp?: string | null
  integrationId?: string | null
  toIsoDateTime: (value: unknown) => string | null
}

export type WxSyncSimInfoBatchIccidResult = {
  iccid: string
  /** Upstream SIM status when returned (status / state / ispType). */
  status: string
}

export type WxSyncSimInfoBatchResult = {
  jobId: string | null
  processed: number
  /** Total SIMs matching the scope across all pages. */
  total: number
  page: number
  pageSize: number
  /** ICCIDs from upstream that included a status field in this run. */
  processedIccids: WxSyncSimInfoBatchIccidResult[]
}

export class WxSyncSimInfoBatchError extends Error {
  status: number
  code: string
  upstreamType?: string
  retryAfter?: unknown
  body?: unknown

  constructor(opts: {
    message: string
    status: number
    code: string
    upstreamType?: string
    retryAfter?: unknown
    body?: unknown
  }) {
    super(opts.message)
    this.name = 'WxSyncSimInfoBatchError'
    this.status = opts.status
    this.code = opts.code
    this.upstreamType = opts.upstreamType
    this.retryAfter = opts.retryAfter
    this.body = opts.body
  }
}

function mapUpstreamError(err: any): WxSyncSimInfoBatchError {
  const status = Number(err?.status) || 502
  const type = String(err?.upstreamType || 'UPSTREAM_ERROR')
  const msg =
    type === 'UPSTREAM_TIMEOUT'
      ? 'Upstream timeout.'
      : type === 'UPSTREAM_RATE_LIMITED'
        ? 'Upstream rate limited.'
        : type === 'UPSTREAM_CIRCUIT_OPEN'
          ? 'Upstream circuit open.'
          : type === 'UPSTREAM_SERVER_ERROR'
            ? 'Upstream server error.'
            : type === 'UPSTREAM_NETWORK_ERROR'
              ? 'Upstream network error.'
              : 'Upstream bad response.'
  return new WxSyncSimInfoBatchError({
    message: msg,
    status,
    code: 'UPSTREAM_ERROR',
    upstreamType: type,
    retryAfter: err?.retryAfter,
    body: err?.body ?? null,
  })
}

export async function runWxSyncSimInfoBatch(
  supabase: SupabaseClient,
  client: WxClient,
  options: WxSyncSimInfoBatchOptions
): Promise<WxSyncSimInfoBatchResult> {
  const supplierId = String(options.supplierId).trim()
  const operatorId = String(options.operatorId).trim()
  const enterpriseId = options.enterpriseId ? String(options.enterpriseId) : null
  const { page, pageSize, offset } = parsePagination(
    { page: options.page, pageSize: options.pageSize },
    { defaultPage: 1, defaultPageSize: 100, maxPageSize: 100 }
  )
  let jobId: string | null = null
  let processed = 0
  let total = 0
  const processedIccids: WxSyncSimInfoBatchIccidResult[] = []

  try {
    const filters: string[] = [
      `supplier_id=eq.${encodeURIComponent(supplierId)}`,
      `operator_id=eq.${encodeURIComponent(operatorId)}`,
    ]
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)

    const pageResp = await supabase.selectWithCount(
      'sims',
      `select=sim_id,iccid,primary_imsi,msisdn,activation_date,enterprise_id,supplier_id&${filters.join('&')}&order=sim_id.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
    )
    const sims = Array.isArray(pageResp.data) ? (pageResp.data as any[]) : []
    total =
      typeof pageResp.total === 'number'
        ? pageResp.total
        : sims.length

    const jobs = await supabase.insert('jobs', {
      job_type: 'WX_SYNC_SIM_INFO_BATCH',
      status: 'RUNNING',
      progress_processed: 0,
      progress_total: Number(total ?? 0),
      started_at: new Date().toISOString(),
      request_id: options.requestId ?? null,
      ...(enterpriseId ? { enterprise_id: enterpriseId } : {}),
    })
    jobId = Array.isArray(jobs) ? (jobs[0] as any)?.job_id ?? null : null

    if (total === 0 || !sims.length) {
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
          tenant_id: enterpriseId ?? null,
          action: 'ADMIN_WX_SYNC_SIM_INFO_BATCH_RUN',
          target_type: 'SIM_BATCH',
          target_id: enterpriseId ?? 'ALL',
          request_id: options.requestId ?? null,
          source_ip: options.sourceIp ?? null,
          after_data: { processed, total, page, pageSize, processedIccids },
        },
        { returning: 'minimal' }
      )
      return { jobId, processed, total, page, pageSize, processedIccids }
    }

    const ok = await client.ping()
    if (!ok) {
      if (jobId) {
        await supabase.update(
          'jobs',
          `job_id=eq.${encodeURIComponent(jobId)}`,
          {
            status: 'FAILED',
            finished_at: new Date().toISOString(),
            error_summary: 'upstream_ping_failed',
          },
          { returning: 'minimal' }
        )
      }
      throw new WxSyncSimInfoBatchError({
        message: 'WXZHONGGENG ping failed.',
        status: 502,
        code: 'UPSTREAM_UNAVAILABLE',
      })
    }

    let hasUpstreamColumns = true
    try {
      await supabase.select('sims', 'select=upstream_status,upstream_info&limit=1')
    } catch {
      hasUpstreamColumns = false
    }

    const simMap = new Map(sims.map((s) => [String(s.iccid), s]))
    const iccids = sims.map((s) => String(s.iccid)).filter((v) => /^\d{18,20}$/.test(v))
    if (iccids.length) {
      let resp: any = null
      try {
        resp = await client.getSimInfoBatch(iccids)
      } catch {
        resp = null
      }
      const list = Array.isArray(resp?.data) ? resp.data : Array.isArray(resp) ? resp : []
      for (const info of list) {
        const iccid = info?.iccid ? String(info.iccid) : ''
        if (!iccid) continue
        const sim = simMap.get(iccid)
        if (!sim) continue
        const update: Record<string, unknown> = {}
        const imsi = info?.imsi ? String(info.imsi) : null
        if (imsi && imsi !== sim.primary_imsi) update.primary_imsi = imsi
        const msisdn = info?.msisdn ? String(info.msisdn) : null
        if (msisdn && msisdn !== sim.msisdn) update.msisdn = msisdn
        const activationDate = options.toIsoDateTime(
          info?.activateTime || info?.activationTime || info?.activeTime
        )
        if (activationDate && activationDate !== sim.activation_date) update.activation_date = activationDate
        const upstreamStatus = info?.status
          ? String(info.status)
          : info?.state
            ? String(info.state)
            : info?.ispType
              ? String(info.ispType)
              : null
        if (upstreamStatus) {
          processedIccids.push({ iccid, status: upstreamStatus })
        }
        const upstreamInfo = {
          iccid,
          imsi: info?.imsi ?? null,
          msisdn: info?.msisdn ?? null,
          status: info?.status ?? null,
          state: info?.state ?? null,
          ispType: info?.ispType ?? null,
          chargeTime: info?.chargeTime ?? null,
          activateTime: info?.activateTime ?? info?.activationTime ?? info?.activeTime ?? null,
          expireTime: info?.expireTime ?? null,
          totalFlow: info?.totalFlow ?? null,
          usedFlow: info?.usedFlow ?? null,
          residualFlow: info?.residualFlow ?? null,
        }
        if (hasUpstreamColumns) {
          update.upstream_status = upstreamStatus
          update.upstream_info = upstreamInfo
        }
        if (!Object.keys(update).length) continue
        await supabase.update(
          'sims',
          `sim_id=eq.${encodeURIComponent(sim.sim_id)}`,
          update,
          { returning: 'minimal' }
        )
        try {
          await supabase.insert(
            'audit_logs',
            {
              actor_role: 'ADMIN',
              tenant_id: sim.enterprise_id ?? null,
              action: 'ADMIN_WX_SYNC_SIM_INFO_UPDATE',
              target_type: 'SIM',
              target_id: iccid,
              request_id: options.requestId ?? null,
              source_ip: options.sourceIp ?? null,
              after_data: { upstreamStatus, upstreamInfo },
            },
            { returning: 'minimal' }
          )
        } catch {
          /* ignore per-sim audit failure */
        }
        processed += 1
      }
    }

    if (jobId) {
      await supabase.update(
        'jobs',
        `job_id=eq.${encodeURIComponent(jobId)}`,
        {
          progress_processed: processed,
          progress_total: Math.max(processed, Number(total ?? processed)),
          status: 'SUCCEEDED',
          finished_at: new Date().toISOString(),
        },
        { returning: 'minimal' }
      )
    }
    try {
      await supabase.insert(
        'audit_logs',
        {
          actor_role: 'ADMIN',
          tenant_id: enterpriseId ?? null,
          action: 'ADMIN_WX_SYNC_SIM_INFO_BATCH_RUN',
          target_type: 'SIM_BATCH',
          target_id: enterpriseId ?? 'ALL',
          request_id: options.requestId ?? null,
          source_ip: options.sourceIp ?? null,
          after_data: { processed, total, page, pageSize, processedIccids },
        },
        { returning: 'minimal' }
      )
    } catch {
      /* ignore batch audit failure */
    }
    return { jobId, processed, total, page, pageSize, processedIccids }
  } catch (err: any) {
    if (err instanceof WxSyncSimInfoBatchError) throw err
    if (err?.name === 'UpstreamError') throw mapUpstreamError(err)

    if (jobId) {
      try {
        await supabase.update(
          'jobs',
          `job_id=eq.${encodeURIComponent(jobId)}`,
          {
            status: 'FAILED',
            error_summary: err?.message ? String(err.message) : 'wx_sync_sim_info_failed',
            finished_at: new Date().toISOString(),
          },
          { returning: 'minimal' }
        )
      } catch {
        /* ignore */
      }
    }
    try {
      await supabase.insert(
        'audit_logs',
        {
          actor_role: 'ADMIN',
          tenant_id: enterpriseId ?? null,
          action: 'ADMIN_WX_SYNC_SIM_INFO_BATCH_RUN',
          target_type: 'SIM_BATCH',
          target_id: enterpriseId ?? 'ALL',
          request_id: options.requestId ?? null,
          source_ip: options.sourceIp ?? null,
          after_data: { processed, total, page, pageSize, error: err?.message ?? 'upstream_error' },
        },
        { returning: 'minimal' }
      )
    } catch {
      /* ignore */
    }
    throw new WxSyncSimInfoBatchError({
      message: err?.message ? String(err.message) : 'wx_sync_sim_info_failed',
      status: 500,
      code: 'INTERNAL_ERROR',
    })
  }
}
