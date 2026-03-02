import type { FastifyReply, FastifyRequest } from 'fastify'

type RoleScope = 'platform' | 'reseller' | 'customer' | 'department' | string

type AuthContext = {
  resellerId?: string | null
  customerId?: string | null
  departmentId?: string | null
  roleScope?: RoleScope | null
}

export type TenantScope = {
  resellerId?: string | null
  customerId?: string | null
  departmentId?: string | null
}

function getAuthContext(req: FastifyRequest): AuthContext {
  const raw = (req as { cmpAuth?: AuthContext }).cmpAuth
  return raw ?? {}
}

export function tenantScope() {
  return async function tenantScopeGuard(req: FastifyRequest, reply: FastifyReply) {
    const auth = getAuthContext(req)
    const roleScope = auth.roleScope ? String(auth.roleScope) : null
    if (roleScope === 'platform') {
      ;(req as { tenantScope?: TenantScope }).tenantScope = {}
      return
    }
    if (roleScope === 'reseller') {
      if (!auth.resellerId) {
        reply.status(403).send({ code: 'FORBIDDEN', message: 'Reseller scope required.' })
        return
      }
      ;(req as { tenantScope?: TenantScope }).tenantScope = { resellerId: String(auth.resellerId) }
      return
    }
    if (roleScope === 'department') {
      if (!auth.customerId || !auth.departmentId) {
        reply.status(403).send({ code: 'FORBIDDEN', message: 'Department scope required.' })
        return
      }
      ;(req as { tenantScope?: TenantScope }).tenantScope = {
        customerId: String(auth.customerId),
        departmentId: String(auth.departmentId),
      }
      return
    }
    if (roleScope === 'customer') {
      if (!auth.customerId) {
        reply.status(403).send({ code: 'FORBIDDEN', message: 'Customer scope required.' })
        return
      }
      ;(req as { tenantScope?: TenantScope }).tenantScope = { customerId: String(auth.customerId) }
      return
    }
    reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' })
  }
}
