import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getAuthContext, checkPermissions } from '../middleware/rbac.js'
import { approveAdjustmentNote, listAdjustmentNotes, type AdjustmentNoteListScope } from '../services/adjustmentNote.js'

type RouteDeps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => {
    select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
    selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
    update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
    insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  }
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  getRoleScope: (req: FastifyRequest) => string | null
}

function isCustomerBillToken(roleScope: string | null, role: string | null) {
  return roleScope === 'customer' || roleScope === 'department' || role === 'customer_m2m'
}

function adjustmentNotePreHandler(requiredPermissions: string[]) {
  return async function adjustmentNoteGuard(req: FastifyRequest, reply: FastifyReply) {
    const auth = getAuthContext(req)
    if (!auth || (!auth.userId && !auth.role && !auth.roleScope)) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' })
      return
    }
    const roleScope = auth.roleScope ? String(auth.roleScope) : null
    const role = auth.role ? String(auth.role) : null
    if (isCustomerBillToken(roleScope, role)) {
      reply.status(403).send({ code: 'FORBIDDEN', message: 'Customer tokens are not permitted for this bill operation.' })
      return
    }
    if (roleScope === 'platform' || role === 'platform_admin') return
    if (!(await checkPermissions(auth, requiredPermissions))) {
      reply.status(403).send({ code: 'FORBIDDEN', message: 'Insufficient permissions.' })
    }
  }
}

function buildListScope(req: FastifyRequest, getRoleScope: RouteDeps['getRoleScope']): AdjustmentNoteListScope {
  const auth = getAuthContext(req)
  return {
    roleScope: getRoleScope(req),
    role: auth.role ? String(auth.role) : null,
    resellerId: auth.resellerId ? String(auth.resellerId) : null,
  }
}

export function registerAdjustmentNoteRoutes({
  app,
  prefix,
  deps,
}: {
  app: FastifyInstance
  prefix: string
  deps: RouteDeps
}) {
  const { createSupabaseRestClient, getTraceId, sendError, getRoleScope } = deps
  const listGuard = adjustmentNotePreHandler(['bills.adjust.list'])
  const approveGuard = adjustmentNotePreHandler(['bills.adjust.approve'])

  app.get(
    `${prefix}/adjustment-notes`,
    { preHandler: listGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = (req.query ?? {}) as Record<string, unknown>
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const result = await listAdjustmentNotes({
        supabase,
        billId: query.billId != null && String(query.billId).trim() !== '' ? String(query.billId).trim() : null,
        type: query.type != null && String(query.type).trim() !== '' ? String(query.type).trim() : null,
        status: query.status != null && String(query.status).trim() !== '' ? String(query.status).trim() : null,
        page: query.page != null ? Number(query.page) : null,
        pageSize: query.pageSize != null ? Number(query.pageSize) : null,
        scope: buildListScope(req, getRoleScope),
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      return reply.send(result.value)
    }
  )

  app.post(
    `${prefix}/adjustment-notes/:noteId/approve`,
    { preHandler: approveGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const noteId = String((req.params as { noteId?: string }).noteId || '')
      const auth = getAuthContext(req)
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const result = await approveAdjustmentNote({
        supabase,
        noteId,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(reply),
        scope: buildListScope(req, getRoleScope),
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      return reply.send(result.value)
    }
  )
}
