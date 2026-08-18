import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { rbac, getAuthContext } from '../middleware/rbac.js'
import { currentUtcYearMonth, resolveUsageMonthlyRollupScope } from '../services/usageMonthlyRollup.js'

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
    options?: { returning?: 'minimal' | 'representation' }
  ) => Promise<unknown>
}

function parseJobPayload(job: Record<string, unknown>): Record<string, unknown> | null {
  const raw = job.payload
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'object' && parsed != null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return null
}

function resolveJobTenantScope(job: Record<string, unknown>): {
  resellerId: string | null
  customerId: string | null
} {
  const payload = parseJobPayload(job)
  const resellerRaw = job.reseller_id ?? payload?.resellerId ?? null
  const customerRaw = job.enterprise_id ?? payload?.enterpriseId ?? payload?.customerId ?? null
  const resellerId = resellerRaw != null && String(resellerRaw).trim() !== '' ? String(resellerRaw) : null
  const customerId = customerRaw != null && String(customerRaw).trim() !== '' ? String(customerRaw) : null
  return { resellerId, customerId }
}

type RouteDeps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => SupabaseClient
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  isValidUuid: (value: unknown) => boolean
  getRoleScope?: (req: FastifyRequest) => string | null
}

export function evaluateJobCancel(job: { job_type?: string | null; status?: string | null }):
  | { ok: true }
  | { ok: false; status: number; code: string; message: string } {
  const jobType = job.job_type ? String(job.job_type) : ''
  if (jobType === 'SIM_STATUS_CHANGE') {
    return {
      ok: false,
      status: 409,
      code: 'JOB_NOT_CANCELLABLE',
      message: 'SIM_STATUS_CHANGE jobs cannot be cancelled; submit a new lifecycle request.',
    }
  }
  const status = job.status ? String(job.status) : ''
  if (status !== 'QUEUED' && status !== 'RUNNING') {
    return {
      ok: false,
      status: 409,
      code: 'INVALID_STATE',
      message: 'Only QUEUED or RUNNING jobs can be cancelled.',
    }
  }
  return { ok: true }
}

async function assertJobReadable(
  supabase: SupabaseClient,
  job: Record<string, unknown>,
  req: FastifyRequest,
  reply: FastifyReply,
  sendError: RouteDeps['sendError'],
  jobId: string
): Promise<boolean> {
  const auth = getAuthContext(req)
  const roleScope = auth.roleScope ? String(auth.roleScope) : null
  const role = auth.role ? String(auth.role) : null
  if (roleScope === 'platform' || role === 'platform_admin') {
    return true
  }

  const { resellerId: jobResellerId, customerId: jobCustomerId } = resolveJobTenantScope(job)

  if (roleScope === 'reseller' && auth.resellerId) {
    const rid = String(auth.resellerId)
    if (jobResellerId === rid) return true
    if (jobCustomerId) {
      const rows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(jobCustomerId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const ent = Array.isArray(rows) ? (rows[0] as { parent_id?: string | null } | undefined) : undefined
      if (ent && String(ent.parent_id || '') === rid) return true
    }
    sendError(reply, 404, 'RESOURCE_NOT_FOUND', `Job ${jobId} not found.`)
    return false
  }

  if ((roleScope === 'customer' || roleScope === 'department') && auth.customerId) {
    const cid = String(auth.customerId)
    if (jobCustomerId === cid) return true
    sendError(reply, 404, 'RESOURCE_NOT_FOUND', `Job ${jobId} not found.`)
    return false
  }

  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return false
}

/** Internal policy helper (T273). Not mounted on tenant JWT API — see registerJobRoutes. */
export function registerJobRoutes({ app, prefix, deps }: { app: FastifyInstance; prefix: string; deps: RouteDeps }) {
  const { createSupabaseRestClient, getTraceId, sendError, isValidUuid } = deps

  app.post(
    `${prefix}/jobs/usage-rating-rollup`,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuthContext(req)
      const roleScope = auth.roleScope ? String(auth.roleScope) : null
      const role = auth.role ? String(auth.role) : null
      if (roleScope !== 'platform' && role !== 'platform_admin' && roleScope !== 'reseller') {
        return sendError(reply, 403, 'FORBIDDEN', 'Only platform or reseller users can enqueue usage rating rollup.')
      }
      const body = ((req.body ?? {}) as Record<string, unknown>)
      const period = body.period ? String(body.period).trim() : null
      if (period && !/^\d{4}-\d{2}$/.test(period)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'period must be YYYY-MM.')
      }
      if (period && period > currentUtcYearMonth()) {
        return sendError(reply, 400, 'BAD_REQUEST', 'period cannot be a future calendar month.')
      }
      let resellerId = body.resellerId ? String(body.resellerId).trim() : null
      const enterpriseId = body.enterpriseId ? String(body.enterpriseId).trim() : null
      if (resellerId && !isValidUuid(resellerId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      }
      if (enterpriseId && !isValidUuid(enterpriseId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      const isPlatform = roleScope === 'platform' || role === 'platform_admin'
      const scopeRole = isPlatform ? 'platform' : 'reseller'
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const scope = await resolveUsageMonthlyRollupScope(supabase, {
        roleScope: scopeRole,
        tokenResellerId: auth.resellerId ? String(auth.resellerId) : null,
        resellerId,
        enterpriseId,
      })
      if (!scope.ok) {
        return sendError(reply, scope.status, scope.code, scope.message)
      }
      resellerId = scope.resellerId
      const scopedEnterpriseId = scope.enterpriseId
      const idempotencyKey =
        body.idempotencyKey != null && String(body.idempotencyKey).trim() !== ''
          ? String(body.idempotencyKey).trim()
          : null
      if (idempotencyKey) {
        const existingRows = await supabase.select(
          'jobs',
          `select=job_id,status,payload,reseller_id,enterprise_id&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&job_type=eq.USAGE_RATING_ROLLUP&limit=1`,
          { suppressMissingColumns: true }
        )
        const existing = Array.isArray(existingRows) ? existingRows[0] as Record<string, unknown> | undefined : undefined
        if (existing?.job_id) {
          return sendError(
            reply,
            409,
            'IDEMPOTENCY_CONFLICT',
            'idempotencyKey was already used for USAGE_RATING_ROLLUP.',
          )
        }
      }
      const payload = {
        period,
        resellerId,
        enterpriseId: scopedEnterpriseId,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(reply),
      }
      let rows: unknown
      try {
        rows = await supabase.insert(
          'jobs',
          {
            job_type: 'USAGE_RATING_ROLLUP',
            status: 'QUEUED',
            progress_processed: 0,
            progress_total: 0,
            reseller_id: resellerId,
            enterprise_id: scopedEnterpriseId,
            idempotency_key: idempotencyKey,
            payload,
          },
          { returning: 'representation', suppressMissingColumns: true }
        )
      } catch (err: any) {
        const bodyText = String(err?.body || err?.message || '')
        if (/duplicate|unique|23505/i.test(bodyText)) {
          return sendError(
            reply,
            409,
            'IDEMPOTENCY_CONFLICT',
            'idempotencyKey was already used for USAGE_RATING_ROLLUP.',
          )
        }
        throw err
      }
      const job = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
      reply.code(202).send({ jobId: job?.job_id ?? null, status: job?.status ?? 'QUEUED' })
    }
  )

  app.post(
    `${prefix}/jobs/usage-monthly-rollup`,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuthContext(req)
      const roleScope = auth.roleScope ? String(auth.roleScope) : null
      const role = auth.role ? String(auth.role) : null
      if (roleScope !== 'platform' && role !== 'platform_admin' && roleScope !== 'reseller') {
        return sendError(reply, 403, 'FORBIDDEN', 'Only platform or reseller users can enqueue usage monthly rollup.')
      }
      const body = ((req.body ?? {}) as Record<string, unknown>)
      const period = body.period ? String(body.period).trim() : null
      if (period && !/^\d{4}-\d{2}$/.test(period)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'period must be YYYY-MM.')
      }
      if (period && period > currentUtcYearMonth()) {
        return sendError(reply, 400, 'BAD_REQUEST', 'period cannot be a future calendar month.')
      }
      let resellerId = body.resellerId ? String(body.resellerId).trim() : null
      const enterpriseId = body.enterpriseId ? String(body.enterpriseId).trim() : null
      if (resellerId && !isValidUuid(resellerId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      }
      if (enterpriseId && !isValidUuid(enterpriseId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      const isPlatform = roleScope === 'platform' || role === 'platform_admin'
      const scopeRole = isPlatform ? 'platform' : 'reseller'
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const scope = await resolveUsageMonthlyRollupScope(supabase, {
        roleScope: scopeRole,
        tokenResellerId: auth.resellerId ? String(auth.resellerId) : null,
        resellerId,
        enterpriseId,
      })
      if (!scope.ok) {
        return sendError(reply, scope.status, scope.code, scope.message)
      }
      resellerId = scope.resellerId
      const scopedEnterpriseId = scope.enterpriseId
      const idempotencyRaw =
        body.idempotencyKey != null && String(body.idempotencyKey).trim() !== ''
          ? String(body.idempotencyKey).trim()
          : null
      const idempotencyKey = idempotencyRaw
      if (idempotencyKey) {
        const existingRows = await supabase.select(
          'jobs',
          `select=job_id,status,payload,reseller_id,enterprise_id&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&job_type=eq.USAGE_MONTHLY_ROLLUP&limit=1`,
          { suppressMissingColumns: true }
        )
        const existing = Array.isArray(existingRows) ? existingRows[0] as Record<string, unknown> | undefined : undefined
        if (existing?.job_id) {
          return sendError(
            reply,
            409,
            'IDEMPOTENCY_CONFLICT',
            'idempotencyKey was already used for USAGE_MONTHLY_ROLLUP.',
          )
        }
      }
      const payload = {
        period,
        resellerId,
        enterpriseId: scopedEnterpriseId,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(reply),
      }
      let rows: unknown
      try {
        rows = await supabase.insert(
          'jobs',
          {
            job_type: 'USAGE_MONTHLY_ROLLUP',
            status: 'QUEUED',
            progress_processed: 0,
            progress_total: 0,
            reseller_id: resellerId,
            enterprise_id: scopedEnterpriseId,
            idempotency_key: idempotencyKey,
            payload,
          },
          { returning: 'representation', suppressMissingColumns: true }
        )
      } catch (err: any) {
        const bodyText = String(err?.body || err?.message || '')
        if (/duplicate|unique|23505/i.test(bodyText)) {
          return sendError(
            reply,
            409,
            'IDEMPOTENCY_CONFLICT',
            'idempotencyKey was already used for USAGE_MONTHLY_ROLLUP.',
          )
        }
        throw err
      }
      const job = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
      reply.code(202).send({ jobId: job?.job_id ?? null, status: job?.status ?? 'QUEUED' })
    }
  )

  app.get(
    `${prefix}/jobs/:jobId`,
    { preHandler: rbac(['jobs.read']) },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const jobId = String((req.params as { jobId?: string }).jobId || '').trim()
      if (!jobId || !isValidUuid(jobId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'jobId must be a valid uuid.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const rows = await supabase.select(
        'jobs',
        `select=job_id,job_type,status,progress_processed,progress_total,error_summary,actor_user_id,reseller_id,enterprise_id,payload,created_at,started_at,finished_at&job_id=eq.${encodeURIComponent(jobId)}&limit=1`
      )
      const job = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
      if (!job) {
        return sendError(reply, 404, 'RESOURCE_NOT_FOUND', `Job ${jobId} not found.`)
      }
      const allowed = await assertJobReadable(supabase, job, req, reply, sendError, jobId)
      if (!allowed) return

      reply.send({
        jobId: job.job_id,
        type: job.job_type,
        status: job.status,
        progress: {
          processed: Number(job.progress_processed ?? 0),
          total: Number(job.progress_total ?? 0),
        },
        errorSummary: job.error_summary ?? null,
        createdAt: job.created_at ?? null,
        updatedAt: job.finished_at ?? job.started_at ?? job.created_at ?? null,
      })
    }
  )
}
