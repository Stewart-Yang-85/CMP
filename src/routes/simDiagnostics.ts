import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { rbac, getAuthContext } from '../middleware/rbac.js'
import { parsePagination } from '../utils/pagination.js'
import {
  getConnectivityStatus,
  getLocation,
  getLocationHistory,
  requestResetConnection,
} from '../services/connectivity.js'
import { ensureSimDiagnosticsAccess } from '../services/simDiagnosticsScope.js'
import { resolveDiagnosticsIntegration } from '../services/simDiagnosticsIntegration.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'

function safeHeaderValue(value: unknown) {
  return encodeURIComponent(String(value ?? '')).replace(/%0D|%0A|%00/gi, '')
}

function setXFilters(reply: FastifyReply, value: string) {
  reply.header('X-Filters', safeHeaderValue(value))
}

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (
    table: string,
    matchQueryString: string,
    patch: unknown,
    options?: { returning?: 'minimal' | 'representation' }
  ) => Promise<unknown>
}

type RouteDeps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => SupabaseClient
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  getRoleScope: (req: FastifyRequest) => string | null
  getEnterpriseIdFromReq: (req: FastifyRequest) => string | null
  getDepartmentIdFromReq: (req: FastifyRequest) => string | null
  normalizeIccid: (value: unknown) => string
  isValidIccid: (value: unknown) => boolean
}

function requireIccid(
  reply: FastifyReply,
  value: unknown,
  deps: Pick<RouteDeps, 'normalizeIccid' | 'isValidIccid' | 'sendError'>,
  label = 'iccid',
): string | null {
  const iccid = deps.normalizeIccid(value)
  if (!iccid || !deps.isValidIccid(iccid)) {
    deps.sendError(reply, 400, 'BAD_REQUEST', `${label} is required and must be 18-20 digits.`)
    return null
  }
  return iccid
}

async function resolveDiagnosticsRequestContext(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<
    RouteDeps,
    | 'createSupabaseRestClient'
    | 'getTraceId'
    | 'sendError'
    | 'getRoleScope'
    | 'getEnterpriseIdFromReq'
    | 'getDepartmentIdFromReq'
  >,
  iccid: string,
) {
  const auth = getAuthContext(req)
  const supabase = deps.createSupabaseRestClient({
    useServiceRole: true,
    traceId: deps.getTraceId(reply),
  })
  const access = await ensureSimDiagnosticsAccess({
    supabase,
    iccid,
    roleScope: deps.getRoleScope(req),
    role: auth.role ? String(auth.role) : null,
    authResellerId: auth.resellerId ? String(auth.resellerId) : null,
    userEnterpriseId: deps.getEnterpriseIdFromReq(req),
    userDepartmentId: deps.getDepartmentIdFromReq(req),
  })
  if (!access.ok) {
    deps.sendError(reply, access.status, access.code, access.message)
    return null
  }

  const integration = await resolveDiagnosticsIntegration(supabase, access.sim)
  if (!integration.ok) {
    deps.sendError(reply, integration.status, integration.code, integration.message)
    return null
  }

  return {
    supabase,
    enterpriseIdForQuery: access.enterpriseIdForQuery,
    sim: access.sim,
    adapter: integration.context.adapter,
    capabilities: integration.context.capabilities,
    integrationId: integration.context.integrationId,
  }
}

async function resolveLocalDiagnosticsRequestContext(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<
    RouteDeps,
    | 'createSupabaseRestClient'
    | 'getTraceId'
    | 'sendError'
    | 'getRoleScope'
    | 'getEnterpriseIdFromReq'
    | 'getDepartmentIdFromReq'
  >,
  iccid: string,
) {
  const auth = getAuthContext(req)
  const supabase = deps.createSupabaseRestClient({
    useServiceRole: true,
    traceId: deps.getTraceId(reply),
  })
  const access = await ensureSimDiagnosticsAccess({
    supabase,
    iccid,
    roleScope: deps.getRoleScope(req),
    role: auth.role ? String(auth.role) : null,
    authResellerId: auth.resellerId ? String(auth.resellerId) : null,
    userEnterpriseId: deps.getEnterpriseIdFromReq(req),
    userDepartmentId: deps.getDepartmentIdFromReq(req),
  })
  if (!access.ok) {
    deps.sendError(reply, access.status, access.code, access.message)
    return null
  }
  return {
    supabase,
    enterpriseIdForQuery: access.enterpriseIdForQuery,
    sim: access.sim,
  }
}

export function registerSimDiagnosticsRoutes({
  app,
  prefix,
  deps,
}: {
  app: FastifyInstance
  prefix: string
  deps: RouteDeps
}) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getRoleScope,
    getEnterpriseIdFromReq,
    getDepartmentIdFromReq,
    normalizeIccid,
    isValidIccid,
  } = deps

  const iccidDeps = { normalizeIccid, isValidIccid, sendError }
  const scopeDeps = {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getRoleScope,
    getEnterpriseIdFromReq,
    getDepartmentIdFromReq,
  }

  app.get(
    `${prefix}/sims/:iccid/connectivity-status`,
    { preHandler: rbac(['sims.connectivity.read']) },
    async (req, reply) => {
      const iccid = requireIccid(reply, (req.params as { iccid?: string }).iccid, iccidDeps)
      if (!iccid) return
      const ctx = await resolveDiagnosticsRequestContext(req, reply, scopeDeps, iccid)
      if (!ctx) return
      const result = await getConnectivityStatus({
        supabase: ctx.supabase,
        upstreamClient: ctx.adapter,
        connectivityMode: ctx.capabilities.connectivityStatus,
        iccid,
        enterpriseId: ctx.enterpriseIdForQuery,
      })
      if (!result.ok) return sendError(reply, result.status, result.code, result.message)
      return reply.send(result.value)
    },
  )

  app.get(
    `${prefix}/sims/:iccid/visited-network`,
    { preHandler: rbac(['sims.location.read']) },
    async (req, reply) => {
      const iccid = requireIccid(reply, (req.params as { iccid?: string }).iccid, iccidDeps)
      if (!iccid) return
      const ctx = await resolveLocalDiagnosticsRequestContext(req, reply, scopeDeps, iccid)
      if (!ctx) return
      const result = await getLocation({
        supabase: ctx.supabase,
        iccid,
        enterpriseId: ctx.enterpriseIdForQuery,
      })
      if (!result.ok) return sendError(reply, result.status, result.code, result.message)
      return reply.send(result.value)
    },
  )

  app.get(
    `${prefix}/sims/:iccid/visited-network-records`,
    { preHandler: rbac(['sims.location.history']) },
    async (req, reply) => {
      const iccid = requireIccid(reply, (req.params as { iccid?: string }).iccid, iccidDeps)
      if (!iccid) return
      const ctx = await resolveLocalDiagnosticsRequestContext(req, reply, scopeDeps, iccid)
      if (!ctx) return
      const query = req.query as Record<string, unknown>
      const fromRaw = query.from ?? query.startDate
      const toRaw = query.to ?? query.endDate
      const fromDate = fromRaw ? new Date(String(fromRaw)) : null
      const toDate = toRaw ? new Date(String(toRaw)) : null
      if (!fromDate || !toDate || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        return sendError(reply, 400, 'BAD_REQUEST', 'from and to are required and must be valid date-time.')
      }
      const { page, pageSize, offset } = parsePagination(query, {
        defaultPage: 1,
        defaultPageSize: 20,
        maxPageSize: 20,
      })
      const result = await getLocationHistory({
        supabase: ctx.supabase,
        iccid,
        enterpriseId: ctx.enterpriseIdForQuery,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        limit: pageSize,
        offset,
      })
      if (!result.ok) return sendError(reply, result.status, result.code, result.message)
      const filterPairs = [
        `from=${fromDate.toISOString()}`,
        `to=${toDate.toISOString()}`,
        `pageSize=${pageSize}`,
        `page=${page}`,
      ]
      setXFilters(reply, filterPairs.join(';'))
      return reply.send({
        items: result.value.items,
        total: result.value.total,
        page,
        pageSize,
      })
    },
  )

  app.post(
    `${prefix}/sims/:iccid/cancel-location`,
    { preHandler: rbac(['sims.reset_connection']) },
    async (req, reply) => {
      const iccid = requireIccid(reply, (req.params as { iccid?: string }).iccid, iccidDeps)
      if (!iccid) return
      const ctx = await resolveDiagnosticsRequestContext(req, reply, scopeDeps, iccid)
      if (!ctx) return
      const body = (req.body ?? {}) as Record<string, unknown>
      const auth = getAuthContext(req)
      const result = await requestResetConnection({
        supabase: ctx.supabase,
        iccid,
        enterpriseId: ctx.enterpriseIdForQuery,
        resellerId: auth.resellerId ? String(auth.resellerId) : null,
        actorUserId: actorUserIdForDb(auth.userId),
        traceId: getTraceId(reply),
        reason: body.reason != null ? String(body.reason) : null,
        idempotencyKey: body.idempotencyKey != null ? String(body.idempotencyKey) : null,
        upstreamClient: ctx.adapter,
        cancelLocationMode: ctx.capabilities.cancelLocation,
        integrationId: ctx.integrationId,
      })
      if (!result.ok) return sendError(reply, result.status, result.code, result.message)
      return reply.status(202).send({
        jobId: result.value.jobId,
        simId: result.value.simId ?? null,
        message: 'Cancel location request submitted',
      })
    },
  )
}
