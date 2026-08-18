import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { actorUserIdForDb } from '../utils/actorUserId.js'
import { getAuthContext } from '../middleware/rbac.js'
import { isPastBillingPeriod } from '../services/billingGenerate.js'
import {
  readOptionalBodyUuid,
  validateEnterpriseForReseller,
  validateResellerTenant,
  parseJobPayload,
  billingGenerateScopeFromPayload,
  billingGenerateScopesEqual,
  buildBillingGenerateJobResponse,
  billingGenerateReplayStatusCode,
  type BillingGenerateScope,
} from '../services/billingGenerateScope.js'
import { parseOptionalIdempotencyKey } from '../utils/idempotencyKeyInput.js'

type RouteDeps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => any
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  isValidUuid: (value: unknown) => boolean
}

function isValidBillingPeriod(value: unknown): value is string {
  return /^\d{4}-\d{2}$/.test(String(value ?? '').trim())
}

function applyScopeError(reply: FastifyReply, sendError: RouteDeps['sendError'], result: { status: number; code: string; message: string }) {
  sendError(reply, result.status, result.code, result.message)
}

export function registerBillingRoutes({
  app,
  prefix,
  deps,
}: {
  app: FastifyInstance
  prefix: string
  deps: RouteDeps
}) {
  const { createSupabaseRestClient, getTraceId, sendError, isValidUuid } = deps

  app.post(`${prefix}/billing:generate`, async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = getAuthContext(req)
    if (!auth.roleScope && !auth.role) {
      return sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
    }

    const roleScope = auth.roleScope ? String(auth.roleScope) : null
    const role = auth.role ? String(auth.role) : null
    const isCustomerScope = roleScope === 'customer' || roleScope === 'department' || role === 'customer_m2m'
    if (isCustomerScope) {
      return sendError(reply, 403, 'FORBIDDEN', 'Customer tokens are not permitted to trigger billing generation.')
    }

    const isPlatform = roleScope === 'platform' || role === 'platform_admin'
    const isResellerAdmin = roleScope === 'reseller' && role === 'reseller_admin'
    if (!isPlatform && !isResellerAdmin) {
      return sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const periodRaw = body.period != null && String(body.period).trim() !== '' ? String(body.period).trim() : null
    const resellerIdRaw = readOptionalBodyUuid(body, 'resellerId')
    const enterpriseIdRaw = readOptionalBodyUuid(body, 'enterpriseId')
    const idempotencyKeyParsed = parseOptionalIdempotencyKey(body.idempotencyKey)
    if (!idempotencyKeyParsed.ok) {
      return sendError(reply, 400, 'BAD_REQUEST', idempotencyKeyParsed.message)
    }
    const idempotencyKey = idempotencyKeyParsed.value

    if (!periodRaw) {
      return sendError(reply, 400, 'BAD_REQUEST', 'period is required.')
    }
    if (!isValidBillingPeriod(periodRaw)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'period must be YYYY-MM.')
    }
    if (!isPastBillingPeriod(periodRaw)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'period must be a month before the current month.')
    }

    const traceId = getTraceId(reply)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId })
    const actorUserId = auth.userId ?? null

    let payloadResellerId: string | null = null
    let payloadEnterpriseId: string | null = null

    if (isResellerAdmin) {
      const tokenResellerId = auth.resellerId ? String(auth.resellerId) : null
      if (!tokenResellerId) {
        return sendError(reply, 403, 'FORBIDDEN', 'resellerId is required for reseller billing.')
      }

      let scopedResellerId = tokenResellerId
      if (resellerIdRaw) {
        if (!isValidUuid(resellerIdRaw)) {
          return sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        }
        if (resellerIdRaw !== tokenResellerId) {
          return sendError(reply, 403, 'FORBIDDEN', 'resellerId does not match token.')
        }
        scopedResellerId = resellerIdRaw
      }

      payloadResellerId = scopedResellerId
      if (enterpriseIdRaw) {
        if (!isValidUuid(enterpriseIdRaw)) {
          return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        const enterpriseCheck = await validateEnterpriseForReseller(supabase, enterpriseIdRaw, scopedResellerId)
        if (!enterpriseCheck.ok) {
          applyScopeError(reply, sendError, enterpriseCheck)
          return
        }
        payloadEnterpriseId = enterpriseCheck.value
      }
    } else {
      if (resellerIdRaw && !isValidUuid(resellerIdRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      }
      if (enterpriseIdRaw && !isValidUuid(enterpriseIdRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      if (enterpriseIdRaw && !resellerIdRaw) {
        return sendError(reply, 400, 'BAD_REQUEST', 'resellerId is required when enterpriseId is provided.')
      }

      if (resellerIdRaw) {
        const resellerCheck = await validateResellerTenant(supabase, resellerIdRaw)
        if (!resellerCheck.ok) {
          applyScopeError(reply, sendError, resellerCheck)
          return
        }
        payloadResellerId = resellerCheck.value

        if (enterpriseIdRaw) {
          const enterpriseCheck = await validateEnterpriseForReseller(supabase, enterpriseIdRaw, payloadResellerId)
          if (!enterpriseCheck.ok) {
            applyScopeError(reply, sendError, enterpriseCheck)
            return
          }
          payloadEnterpriseId = enterpriseCheck.value
        }
      }
    }

    const payload: Record<string, unknown> = {
      period: periodRaw,
      enterpriseId: payloadEnterpriseId,
      resellerId: payloadResellerId,
      traceId,
      actorUserId,
      actorRole: isPlatform ? auth.role ?? 'platform_admin' : auth.role ?? 'reseller_admin',
    }
    const requestScope: BillingGenerateScope = {
      period: periodRaw,
      resellerId: payloadResellerId,
      enterpriseId: payloadEnterpriseId,
    }

    if (idempotencyKey) {
      const existingJobs = await supabase.select(
        'jobs',
        `select=job_id,status,payload,reseller_id,enterprise_id&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&job_type=eq.BILLING_GENERATE&limit=1`
      )
      const existingJob = Array.isArray(existingJobs)
        ? (existingJobs[0] as Record<string, unknown>)
        : null
      if (existingJob) {
        const existingScope = billingGenerateScopeFromPayload(parseJobPayload(existingJob.payload))
        if (!billingGenerateScopesEqual(existingScope, requestScope)) {
          return sendError(
            reply,
            409,
            'IDEMPOTENCY_CONFLICT',
            'idempotencyKey was already used for a different billing generate scope.'
          )
        }
        const response = buildBillingGenerateJobResponse(existingJob, requestScope, idempotencyKey)
        return reply.code(billingGenerateReplayStatusCode(existingJob.status)).send(response)
      }
    }

    const jobs = await supabase.insert(
      'jobs',
      {
        job_type: 'BILLING_GENERATE',
        status: 'QUEUED',
        progress_processed: 0,
        progress_total: 0,
        payload,
        request_id: JSON.stringify(payload),
        actor_user_id: actorUserIdForDb(actorUserId),
        reseller_id: payloadResellerId,
        enterprise_id: payloadEnterpriseId,
        idempotency_key: idempotencyKey,
      },
      { returning: 'representation', suppressMissingColumns: true }
    )
    const job = Array.isArray(jobs) ? (jobs[0] as Record<string, unknown>) : null
    if (!job?.job_id && idempotencyKey) {
      const existingJobs = await supabase.select(
        'jobs',
        `select=job_id,status,payload,reseller_id,enterprise_id&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&job_type=eq.BILLING_GENERATE&limit=1`
      )
      const existingJob = Array.isArray(existingJobs)
        ? (existingJobs[0] as Record<string, unknown>)
        : null
      if (existingJob) {
        const existingScope = billingGenerateScopeFromPayload(parseJobPayload(existingJob.payload))
        if (!billingGenerateScopesEqual(existingScope, requestScope)) {
          return sendError(
            reply,
            409,
            'IDEMPOTENCY_CONFLICT',
            'idempotencyKey was already used for a different billing generate scope.'
          )
        }
        const response = buildBillingGenerateJobResponse(existingJob, requestScope, idempotencyKey)
        return reply.code(billingGenerateReplayStatusCode(existingJob.status)).send(response)
      }
    }
    const jobId = job?.job_id ? String(job.job_id) : null
    reply.code(202).send(buildBillingGenerateJobResponse(job ?? {}, requestScope, idempotencyKey))
  })
}
