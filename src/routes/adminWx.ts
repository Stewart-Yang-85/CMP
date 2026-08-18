import {
  resolveAdminWxIntegration,
  resolveAdminWxIntegrationForSim,
  resolveWxUsageDailyPath,
} from '../services/adminWxIntegration.js'
import { runWxSyncDailyUsage } from '../services/wxSyncDailyUsage.js'
import { runWxSyncSimInfoBatch, WxSyncSimInfoBatchError } from '../services/wxSyncSimInfoBatch.js'

type Deps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  requireAdminAccess: (req: any, res: any) => boolean
  requireIccid: (res: any, value: unknown, label?: string) => string | null
  isValidUuid: (value: unknown) => boolean
  toIsoDateTime: (value: unknown) => string | null
}

type WxOutboundClient = {
  ping?: () => Promise<boolean>
  request?: (method: string, path: string, options?: { body?: unknown }) => Promise<any>
  getSimCardStatus?: (iccid: string) => Promise<unknown>
  getSimInfoBatch?: (iccids: string[]) => Promise<any>
}

/**
 * Admin WX helpers + sync jobs.
 * Outbound calls MUST use `upstream_integrations` via adapter (same path as Diagnostics).
 * Colon job paths use Fastify `::` registration.
 */
export function registerAdminWxRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    requireAdminAccess,
    requireIccid,
    isValidUuid,
    toIsoDateTime,
  } = deps

  app.get(`${prefix}/admin/wx/sims/:iccid/status`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const iccid = requireIccid(res, req.params?.iccid)
    if (!iccid) return

    const simRows = await supabase.select(
      'sims',
      `select=sim_id,iccid,enterprise_id,supplier_id,operator_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(simRows) ? simRows[0] : null
    if (!sim) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }

    const q = (req.query && typeof req.query === 'object' ? req.query : {}) as Record<string, unknown>
    const resolved = await resolveAdminWxIntegrationForSim(supabase, sim as Record<string, unknown>, {
      supplierId: q.supplierId,
      operatorId: q.operatorId,
    })
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message)
    }

    const client = resolved.context.adapter as unknown as WxOutboundClient
    if (typeof client.getSimCardStatus !== 'function') {
      return sendError(res, 501, 'NOT_IMPLEMENTED', 'Adapter does not support getSimCardStatus.')
    }

    try {
      const upstream = await client.getSimCardStatus(iccid)
      const base = upstream && typeof upstream === 'object' ? upstream : {}
      const success = (base as any).success ?? true
      const rawData = (base as any).data
      const payload = Array.isArray(rawData)
        ? { items: rawData }
        : rawData && typeof rawData === 'object'
          ? { ...rawData }
          : {}
      if (!(payload as any).iccid && !(payload as any).imsi) {
        ;(payload as any).iccid = iccid
      }
      const data = { ...base, success, data: payload }
      await supabase.insert(
        'audit_logs',
        {
          actor_role: 'ADMIN',
          tenant_id: (sim as any).enterprise_id ?? null,
          action: 'ADMIN_WX_QUERY_STATUS',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip ?? null,
          after_data: {
            iccid,
            integrationId: resolved.context.integrationId,
            supplierId: resolved.context.supplierId,
            operatorId: resolved.context.operatorId,
          },
        },
        { returning: 'minimal' }
      )
      res.send(data ?? null)
    } catch (err: any) {
      await supabase.insert(
        'audit_logs',
        {
          actor_role: 'ADMIN',
          tenant_id: (sim as any).enterprise_id ?? null,
          action: 'ADMIN_WX_QUERY_STATUS',
          target_type: 'SIM',
          target_id: iccid,
          request_id: getTraceId(res),
          source_ip: req.ip ?? null,
          after_data: {
            iccid,
            integrationId: resolved.context.integrationId,
            error: err?.message ?? 'upstream_error',
          },
        },
        { returning: 'minimal' }
      )
      return sendError(res, 502, 'UPSTREAM_BAD_RESPONSE', 'Upstream SIM status request failed.')
    }
  })

  app.post(`${prefix}/admin/jobs::wx-sync-daily-usage`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

    const resolved = await resolveAdminWxIntegration(supabase, body.supplierId, body.operatorId)
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message)
    }

    const enterpriseIdRaw = body.enterpriseId != null ? String(body.enterpriseId).trim() : ''
    const enterpriseId = enterpriseIdRaw || null
    if (enterpriseId && !isValidUuid(enterpriseId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid enterpriseId.')
    }

    const startDate = body.startDate ? new Date(String(body.startDate)) : new Date(Date.now() - 24 * 3600 * 1000)
    const endDate = body.endDate ? new Date(String(body.endDate)) : new Date()
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return sendError(res, 400, 'BAD_REQUEST', 'startDate/endDate must be valid dates.')
    }

    if (body.page !== undefined && body.page !== null && String(body.page).trim() !== '') {
      const n = Number(body.page)
      if (!Number.isFinite(n) || n < 1) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'page must be a positive integer.')
      }
    }
    if (body.pageSize !== undefined && body.pageSize !== null && String(body.pageSize).trim() !== '') {
      const n = Number(body.pageSize)
      if (!Number.isFinite(n) || n < 1) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'pageSize must be a positive integer.')
      }
    }

    const client = resolved.context.adapter as unknown as WxOutboundClient
    if (typeof client.ping !== 'function' || typeof client.request !== 'function') {
      return sendError(res, 501, 'NOT_IMPLEMENTED', 'Adapter does not support daily usage sync.')
    }

    const result = await runWxSyncDailyUsage(
      supabase,
      { ping: client.ping.bind(client), request: client.request.bind(client) },
      {
        supplierId: resolved.context.supplierId,
        operatorId: resolved.context.operatorId,
        enterpriseId,
        startDate,
        endDate,
        page: body.page as number | string | undefined,
        pageSize: body.pageSize as number | string | undefined,
        usageDailyPath: resolveWxUsageDailyPath(resolved.context.runtime),
        requestId: getTraceId(res),
        sourceIp: req.ip ?? null,
        integrationId: resolved.context.integrationId,
      }
    )
    res.send({
      ...result,
      integrationId: resolved.context.integrationId,
    })
  })

  app.post(`${prefix}/admin/jobs::wx-sync-sim-info-batch`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

    const resolved = await resolveAdminWxIntegration(supabase, body.supplierId, body.operatorId)
    if (!resolved.ok) {
      return sendError(res, resolved.status, resolved.code, resolved.message)
    }

    const enterpriseIdRaw = body.enterpriseId != null ? String(body.enterpriseId).trim() : ''
    const enterpriseId = enterpriseIdRaw || null
    if (enterpriseId && !isValidUuid(enterpriseId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'Invalid enterpriseId.')
    }

    if (body.page !== undefined && body.page !== null && String(body.page).trim() !== '') {
      const n = Number(body.page)
      if (!Number.isFinite(n) || n < 1) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'page must be a positive integer.')
      }
    }
    if (body.pageSize !== undefined && body.pageSize !== null && String(body.pageSize).trim() !== '') {
      const n = Number(body.pageSize)
      if (!Number.isFinite(n) || n < 1) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'pageSize must be a positive integer.')
      }
    }

    const client = resolved.context.adapter as unknown as WxOutboundClient
    if (typeof client.ping !== 'function' || typeof client.getSimInfoBatch !== 'function') {
      return sendError(res, 501, 'NOT_IMPLEMENTED', 'Adapter does not support SIM info batch sync.')
    }

    try {
      const result = await runWxSyncSimInfoBatch(
        supabase,
        {
          ping: client.ping.bind(client),
          getSimInfoBatch: client.getSimInfoBatch.bind(client),
        },
        {
          supplierId: resolved.context.supplierId,
          operatorId: resolved.context.operatorId,
          enterpriseId,
          page: body.page as number | string | undefined,
          pageSize: body.pageSize as number | string | undefined,
          requestId: getTraceId(res),
          sourceIp: req.ip ?? null,
          integrationId: resolved.context.integrationId,
          toIsoDateTime,
        }
      )
      res.send({
        ...result,
        integrationId: resolved.context.integrationId,
      })
    } catch (err: any) {
      if (err instanceof WxSyncSimInfoBatchError) {
        if (err.upstreamType) res.header('X-Upstream-Type', err.upstreamType)
        if (err.retryAfter !== undefined && err.retryAfter !== null) {
          res.header('Retry-After', String(err.retryAfter))
        }
        return sendError(res, err.status, err.code, err.message)
      }
      return sendError(res, 500, 'INTERNAL_ERROR', err?.message ? String(err.message) : 'wx_sync_sim_info_failed')
    }
  })
}
