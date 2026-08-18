import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  listDefaultFallbackPackageMappings,
  setDefaultFallbackPackage,
  unsetDefaultFallbackPackage,
} from '../services/ratingFallbackPackage.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'

type Deps = {
  createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => {
    select: (table: string, queryString: string) => Promise<unknown>
    insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
    update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  }
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  ensureResellerAdmin: (req: any, reply: any) => { scope?: string | null; resellerId?: string | null } | null
  ensureResellerSales: (req: any, reply: any) => { scope?: string | null; resellerId?: string | null } | null
  isValidUuid: (value: unknown) => boolean
}

function resolveResellerIdForRoute({
  req,
  reply,
  auth,
  rawResellerId,
  sendError,
  isValidUuid,
}: {
  req: any
  reply: FastifyReply
  auth: { scope?: string | null; resellerId?: string | null }
  rawResellerId: unknown
  sendError: Deps['sendError']
  isValidUuid: Deps['isValidUuid']
}) {
  const tokenResellerId = String(req?.cmpAuth?.resellerId ?? auth.resellerId ?? '').trim()
  const bodyResellerId = rawResellerId == null ? '' : String(rawResellerId).trim()
  if (auth.scope === 'platform') {
    if (!bodyResellerId || !isValidUuid(bodyResellerId)) {
      sendError(reply, 400, 'BAD_REQUEST', 'resellerId is required and must be a valid uuid.')
      return null
    }
    return bodyResellerId
  }
  if (auth.scope === 'reseller') {
    if (!tokenResellerId || !isValidUuid(tokenResellerId)) {
      sendError(reply, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      return null
    }
    if (bodyResellerId && bodyResellerId !== tokenResellerId) {
      sendError(reply, 403, 'FORBIDDEN', 'resellerId must match the authenticated reseller.')
      return null
    }
    return tokenResellerId
  }
  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

async function resolveListResellerIdForRoute({
  req,
  reply,
  auth,
  rawResellerId,
  supabase,
  sendError,
  isValidUuid,
}: {
  req: any
  reply: FastifyReply
  auth: { scope?: string | null; resellerId?: string | null }
  rawResellerId: unknown
  supabase: ReturnType<Deps['createSupabaseRestClient']>
  sendError: Deps['sendError']
  isValidUuid: Deps['isValidUuid']
}) {
  const tokenResellerId = String(req?.cmpAuth?.resellerId ?? auth.resellerId ?? '').trim()
  const queryResellerId = rawResellerId == null ? '' : String(rawResellerId).trim()
  if (auth.scope === 'platform') {
    if (!queryResellerId || !isValidUuid(queryResellerId)) {
      sendError(reply, 400, 'BAD_REQUEST', 'resellerId is required and must be a valid uuid.')
      return null
    }
    const rows = await supabase.select('tenants', `select=tenant_id&tenant_id=eq.${encodeURIComponent(queryResellerId)}&tenant_type=eq.RESELLER&limit=1`)
    const reseller = Array.isArray(rows) ? rows[0] : null
    if (!(reseller as any)?.tenant_id) {
      sendError(reply, 400, 'BAD_REQUEST', 'resellerId is not a valid RESELLER tenant.')
      return null
    }
    return queryResellerId
  }
  if (auth.scope === 'reseller') {
    if (!tokenResellerId || !isValidUuid(tokenResellerId)) {
      sendError(reply, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      return null
    }
    const effectiveResellerId = queryResellerId || tokenResellerId
    if (!isValidUuid(effectiveResellerId)) {
      sendError(reply, 400, 'BAD_REQUEST', 'resellerId is invalid.')
      return null
    }
    const rows = await supabase.select('tenants', `select=tenant_id&tenant_id=eq.${encodeURIComponent(effectiveResellerId)}&tenant_type=eq.RESELLER&limit=1`)
    const reseller = Array.isArray(rows) ? rows[0] : null
    if (!(reseller as any)?.tenant_id) {
      sendError(reply, 400, 'BAD_REQUEST', 'resellerId is not a valid RESELLER tenant.')
      return null
    }
    if (effectiveResellerId !== tokenResellerId) {
      sendError(reply, 403, 'FORBIDDEN', 'resellerId must match the authenticated reseller.')
      return null
    }
    return effectiveResellerId
  }
  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

export function registerRatingFallbackPackageRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const { createSupabaseRestClient, getTraceId, sendError, ensureResellerAdmin, ensureResellerSales, isValidUuid } = deps

  app.get(`${prefix}/rating-fallback-packages`, async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = ensureResellerSales(req, reply)
    if (!auth) return
    const query = (req.query ?? {}) as Record<string, unknown>
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
    const resellerId = await resolveListResellerIdForRoute({
      req,
      reply,
      auth,
      rawResellerId: query.resellerId ?? query.reseller_id,
      supabase,
      sendError,
      isValidUuid,
    })
    if (!resellerId) return
    const result = await listDefaultFallbackPackageMappings({
      supabase,
      resellerId,
      enterpriseId: query.enterpriseId ? String(query.enterpriseId) : null,
      supplierId: query.supplierId ? String(query.supplierId) : null,
      operatorId: query.operatorId ? String(query.operatorId) : null,
      status: query.status ? String(query.status) : null,
      page: query.page != null ? String(query.page) : null,
      pageSize: query.pageSize != null ? String(query.pageSize) : null,
    })
    if (!result.ok) return sendError(reply, (result as any).status, (result as any).code, (result as any).message)
    reply.send((result as any).value)
  })

  app.post(`${prefix}/rating-fallback-packages/set-default`, async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = ensureResellerAdmin(req, reply)
    if (!auth) return
    const body = ((req.body ?? {}) as Record<string, unknown>)
    const resellerId = resolveResellerIdForRoute({
      req,
      reply,
      auth,
      rawResellerId: body.resellerId ?? body.reseller_id,
      sendError,
      isValidUuid,
    })
    if (!resellerId) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
    const result = await setDefaultFallbackPackage({
      supabase,
      payload: { ...body, resellerId },
      audit: { actorUserId: actorUserIdForDb((req as any)?.cmpAuth?.userId) },
    })
    if (!result.ok) return sendError(reply, (result as any).status, (result as any).code, (result as any).message)
    reply.code(201).send((result as any).value)
  })

  app.post(`${prefix}/rating-fallback-packages/unset-default`, async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = ensureResellerAdmin(req, reply)
    if (!auth) return
    const body = ((req.body ?? {}) as Record<string, unknown>)
    const resellerId = resolveResellerIdForRoute({
      req,
      reply,
      auth,
      rawResellerId: body.resellerId ?? body.reseller_id,
      sendError,
      isValidUuid,
    })
    if (!resellerId) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
    const result = await unsetDefaultFallbackPackage({
      supabase,
      payload: { ...body, resellerId },
      audit: { actorUserId: actorUserIdForDb((req as any)?.cmpAuth?.userId) },
    })
    if (!result.ok) return sendError(reply, (result as any).status, (result as any).code, (result as any).message)
    reply.send((result as any).value)
  })
}
