import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createSupabaseRestClient } from '../supabaseRest.js'

type AuthContext = {
  userId?: string | null
  role?: string | null
  resellerId?: string | null
  customerId?: string | null
}

type AuditLogOptions = {
  action: string
  targetType?: string
  targetId?: string | ((req: FastifyRequest, reply: FastifyReply) => string | null)
  before?: unknown | ((req: FastifyRequest) => unknown)
  after?: unknown | ((req: FastifyRequest, reply: FastifyReply) => unknown)
  actorRole?: string
  actorUserId?: string
  resellerId?: string
  customerId?: string
  requestId?: string
  sourceIp?: string
}

type AuditLogContext = {
  action: string
  targetType?: string
  targetId?: string | ((req: FastifyRequest, reply: FastifyReply) => string | null)
  before?: unknown | ((req: FastifyRequest) => unknown)
  after?: unknown | ((req: FastifyRequest, reply: FastifyReply) => unknown)
  actorRole?: string | null
  actorUserId?: string | null
  resellerId?: string | null
  customerId?: string | null
  requestId?: string | null
  sourceIp?: string | null
}

function getAuthContext(req: FastifyRequest): AuthContext {
  const raw = (req as { cmpAuth?: AuthContext }).cmpAuth
  return raw ?? {}
}

function readHeader(req: FastifyRequest, name: string) {
  const key = name.toLowerCase()
  const value = req.headers[key]
  if (Array.isArray(value)) return value[0]
  return value ? String(value) : null
}

export function auditLog(options: AuditLogOptions) {
  return async function auditLogMiddleware(req: FastifyRequest, reply: FastifyReply) {
    const auth = getAuthContext(req)
    const ctx: AuditLogContext = {
      action: options.action,
      targetType: options.targetType,
      targetId: options.targetId,
      before: options.before,
      after: options.after,
      actorRole: options.actorRole ?? auth.role ?? null,
      actorUserId: options.actorUserId ?? auth.userId ?? null,
      resellerId: options.resellerId ?? auth.resellerId ?? null,
      customerId: options.customerId ?? auth.customerId ?? null,
      requestId: options.requestId ?? readHeader(req, 'x-request-id') ?? null,
      sourceIp: options.sourceIp ?? req.ip ?? null,
    }
    ;(req as { auditLogContext?: AuditLogContext }).auditLogContext = ctx
  }
}

export function registerAuditLogHook(app: FastifyInstance) {
  app.addHook('onResponse', async (req, reply) => {
    const ctx = (req as { auditLogContext?: AuditLogContext }).auditLogContext
    if (!ctx) return
    const targetId = typeof ctx.targetId === 'function' ? ctx.targetId(req, reply) : ctx.targetId
    const beforeData = typeof ctx.before === 'function' ? ctx.before(req) : ctx.before
    const afterData = typeof ctx.after === 'function' ? ctx.after(req, reply) : ctx.after
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: ctx.requestId ?? null })
    const tenantId = ctx.customerId ?? ctx.resellerId ?? null
    const payload = {
      actor_user_id: ctx.actorUserId ?? null,
      actor_role: ctx.actorRole ?? null,
      tenant_id: tenantId,
      action: ctx.action,
      target_type: ctx.targetType ?? null,
      target_id: targetId ?? null,
      before_data: beforeData ?? null,
      after_data: afterData ?? null,
      request_id: ctx.requestId ?? null,
      source_ip: ctx.sourceIp ?? null,
    }
    await supabase.insert('audit_logs', payload, { returning: 'minimal' })
  })
}
