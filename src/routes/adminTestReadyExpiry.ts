import { parsePagination } from '../utils/pagination.js'
import { runTestReadyExpiryEvaluation } from '../services/testReadyExpiry.js'

type Deps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  requireAdminAccess: (req: any, res: any) => boolean
  isValidUuid: (value: unknown) => boolean
}

export function registerAdminTestReadyExpiryRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const { createSupabaseRestClient, getTraceId, sendError, requireAdminAccess, isValidUuid } = deps

  // Fastify find-my-way: `::` so OpenAPI path `.../jobs:test-ready-expiry-run` matches.
  app.post(`${prefix}/admin/jobs::test-ready-expiry-run`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
    const enterpriseIdRaw = body.enterpriseId != null ? String(body.enterpriseId).trim() : ''
    const enterpriseId = enterpriseIdRaw || null
    if (enterpriseId && !isValidUuid(enterpriseId)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'enterpriseId must be a valid uuid.')
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

    const { page, pageSize } = parsePagination(
      { page: body.page as number | string | null | undefined, pageSize: body.pageSize as number | string | null | undefined },
      { defaultPage: 1, defaultPageSize: 100, maxPageSize: 100 }
    )

    if (enterpriseId) {
      const supabaseCheck = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const rows = await supabaseCheck.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const ent = Array.isArray(rows) ? rows[0] : null
      if (!ent) {
        return sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      }
    }

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await runTestReadyExpiryEvaluation(supabase, {
      enterpriseId,
      page,
      pageSize,
      requestId: getTraceId(res),
      sourceIp: req.ip ?? null,
    })
    res.send(result)
  })
}
