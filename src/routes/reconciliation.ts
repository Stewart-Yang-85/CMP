import {
  createReconciliationRun,
  getReconciliationRun,
  listReconciliationMismatches,
  getReconciliationMismatchTrace,
} from '../services/reconciliation.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  ensurePlatformAdmin: (req: any, res: any) => any
  isValidUuid: (value: string) => boolean
}

export function registerReconciliationRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const { createSupabaseRestClient, getTraceId, sendError, ensurePlatformAdmin, isValidUuid } = deps

  app.get(`${prefix}/reconciliation/runs`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const query = req.query ?? {}
    const supplierId = query.supplierId ? String(query.supplierId).trim() : null
    const date = query.date ? String(query.date).trim() : null
    const scope = query.scope ? String(query.scope).trim().toUpperCase() : null
    const status = query.status ? String(query.status).trim().toUpperCase() : null
    if (supplierId && !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendError(res, 400, 'BAD_REQUEST', 'date must be in YYYY-MM-DD format.')
    }
    const scopeValue = scope === 'FULL' ? 'FULL' : scope === 'INCREMENTAL' ? 'INCREMENTAL' : null
    if (scope && !scopeValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'scope must be FULL or INCREMENTAL.')
    }
    const statusValue =
      status === 'RUNNING' || status === 'COMPLETED' || status === 'FAILED' ? status : null
    if (status && !statusValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'status must be RUNNING, COMPLETED, or FAILED.')
    }
    const page = Math.max(1, Number(query.page ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? query.limit ?? 20) || 20))
    const offset = (page - 1) * pageSize
    const filters: string[] = []
    if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
    if (date) filters.push(`run_date=eq.${encodeURIComponent(date)}`)
    if (scopeValue) filters.push(`scope=eq.${encodeURIComponent(scopeValue)}`)
    if (statusValue) filters.push(`status=eq.${encodeURIComponent(statusValue)}`)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const { data, total } = await supabase.selectWithCount(
      'reconciliation_runs',
      `select=run_id,supplier_id,run_date,scope,status,total_checked,matched,mismatches,local_only,upstream_only,started_at,finished_at&order=started_at.desc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const items = rows.map((row: any) => ({
      runId: row.run_id,
      supplierId: row.supplier_id,
      date: row.run_date,
      scope: row.scope,
      status: row.status,
      summary: {
        totalSimsChecked: Number(row.total_checked ?? 0),
        matched: Number(row.matched ?? 0),
        mismatched: Number(row.mismatches ?? 0),
        localOnly: Number(row.local_only ?? 0),
        upstreamOnly: Number(row.upstream_only ?? 0),
      },
      startedAt: row.started_at ?? null,
      completedAt: row.finished_at ?? null,
    }))
    res.json({ items, total: typeof total === 'number' ? total : items.length, page, pageSize })
  })

  app.post(`${prefix}/reconciliation/runs`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const body = req.body ?? {}
    const supplierId = body.supplierId ? String(body.supplierId).trim() : null
    const date = body.date ? String(body.date).trim() : null
    const scope = body.scope ? String(body.scope).trim() : null
    if (!supplierId || !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
    }
    if (!date) {
      return sendError(res, 400, 'BAD_REQUEST', 'date is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await createReconciliationRun({
      supabase,
      supplierId,
      date,
      scope,
      traceId: getTraceId(res),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    const jobRows = await supabase.insert(
      'jobs',
      {
        job_type: 'RECONCILIATION_RUN',
        status: 'QUEUED',
        progress_processed: 0,
        progress_total: 1,
        request_id: JSON.stringify({
          runId: result.value.runId,
          supplierId,
          date,
          scope: result.value.scope,
          traceId: getTraceId(res),
        }),
      },
      { returning: 'representation' }
    )
    const job = Array.isArray(jobRows) ? jobRows[0] : null
    res.status(202).json({
      runId: result.value.runId,
      jobId: job?.job_id ?? null,
      status: 'RUNNING',
    })
  })

  app.get(`${prefix}/reconciliation/runs/:runId/mismatches`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const runId = req.params?.runId ? String(req.params.runId).trim() : ''
    if (!runId || !isValidUuid(runId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'runId must be a valid uuid.')
    }
    const query = req.query ?? {}
    const field = query.field ? String(query.field).trim() : null
    const resolution = query.resolution ? String(query.resolution).trim() : null
    const iccid = query.iccid ? String(query.iccid).trim() : null
    const enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listReconciliationMismatches({
      supabase,
      runId,
      field,
      resolution,
      iccid,
      enterpriseId,
      page: query.page,
      pageSize: query.pageSize,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/reconciliation/runs/:runId/mismatches/:iccid/trace`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const runId = req.params?.runId ? String(req.params.runId).trim() : ''
    if (!runId || !isValidUuid(runId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'runId must be a valid uuid.')
    }
    const iccid = req.params?.iccid ? String(req.params.iccid).trim() : ''
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getReconciliationMismatchTrace({ supabase, runId, iccid })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/reconciliation/runs/:runId`, async (req: any, res: any) => {
    const auth = ensurePlatformAdmin(req, res)
    if (!auth) return
    const runId = req.params?.runId ? String(req.params.runId).trim() : ''
    if (!runId || !isValidUuid(runId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'runId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getReconciliationRun({ supabase, runId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })
}
