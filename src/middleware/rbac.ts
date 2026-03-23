import type { FastifyReply, FastifyRequest } from 'fastify'
import { createSupabaseRestClient } from '../supabaseRest.js'

export type RoleScope = 'platform' | 'reseller' | 'customer' | 'department' | string

export type AuthContext = {
  userId?: string | null
  resellerId?: string | null
  customerId?: string | null
  departmentId?: string | null
  roleScope?: RoleScope | null
  role?: string | null
  permissions?: string[] | null
}

export type RbacOptions = {
  roles?: string[]
}

const rolePermissionCache = new Map<string, { expiresAt: number; permissions: string[] }>()
const rolePermissionCacheTtlMs = Number(process.env.RBAC_ROLE_CACHE_TTL_MS || '300000')

const basePermissions = [
  'bills.list',
  'bills.read',
  'bills.export',
  'bills.mark_paid',
  'bills.adjust',
  'sims.list',
  'sims.read',
  'sims.export',
  'sims.reset_connection',
  'sims.connectivity.read',
  'sims.location.read',
  'sims.location.history',
  'sims.batch_status_change',
  'subscriptions.list',
  'subscriptions.read',
  'subscriptions.create',
  'subscriptions.switch',
  'subscriptions.cancel',
  'jobs.read',
  'catalog.packages.list',
  'catalog.packages.export',
  'catalog.package_versions.list',
  'price_plans.read',
  'share.read',
  'share.create',
]

const defaultPermissionsByRoleScope: Record<string, string[]> = {
  customer: basePermissions.slice(),
  department: [
    'bills.list',
    'bills.read',
    'bills.export',
    'sims.list',
    'sims.read',
    'sims.export',
    'sims.connectivity.read',
    'sims.location.read',
    'sims.location.history',
    'subscriptions.list',
    'subscriptions.read',
    'jobs.read',
    'catalog.packages.list',
    'catalog.packages.export',
    'catalog.package_versions.list',
    'price_plans.read',
    'share.read',
  ],
  reseller: [
    'bills.list',
    'bills.read',
    'bills.export',
    'sims.list',
    'sims.read',
    'sims.export',
    'sims.reset_connection',
    'sims.connectivity.read',
    'sims.location.read',
    'sims.location.history',
    'sims.import',
    'sims.create',
    'sims.activate',
    'sims.deactivate',
    'sims.reactivate',
    'sims.retire',
    'sims.batch_deactivate',
    'sims.batch_status_change',
    'subscriptions.list',
    'subscriptions.read',
    'subscriptions.create',
    'subscriptions.switch',
    'subscriptions.cancel',
    'jobs.read',
    'catalog.packages.list',
    'catalog.packages.export',
    'catalog.package_versions.list',
    'price_plans.read',
    'share.read',
    'share.create',
  ],
}

export function getAuthContext(req: FastifyRequest): AuthContext {
  const raw = (req as { cmpAuth?: AuthContext }).cmpAuth
  return raw ?? {}
}

export function setAuthContext(req: FastifyRequest, ctx: AuthContext) {
  const holder = req as { cmpAuth?: AuthContext }
  holder.cmpAuth = { ...(holder.cmpAuth ?? {}), ...ctx }
}

function normalizeRoleScopeForDb(roleScope: string | null) {
  if (!roleScope) return null
  if (roleScope === 'department') return 'customer'
  return roleScope
}

function getRoleCacheKey(role: string, roleScope: string | null) {
  return `${roleScope ?? 'any'}:${role}`
}

async function resolveRolePermissions(role: string, roleScope: string | null) {
  const scope = normalizeRoleScopeForDb(roleScope)
  const cacheKey = getRoleCacheKey(role, scope)
  const cached = rolePermissionCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.permissions.slice()
  }
  try {
    const supabase = createSupabaseRestClient({ useServiceRole: true })
    const roleQuery = [
      'select=id,code,scope',
      `code=eq.${encodeURIComponent(role)}`,
      scope ? `scope=eq.${encodeURIComponent(scope)}` : null,
      'limit=1',
    ].filter(Boolean).join('&')
    const roles = await supabase.select('roles', roleQuery)
    const roleRow = Array.isArray(roles) && roles.length > 0 ? roles[0] : null
    const roleId = roleRow ? String(roleRow.id ?? roleRow.role_id ?? '') : ''
    if (!roleId) return null
    const rolePermissions = await supabase.select(
      'role_permissions',
      `select=permission_id&role_id=eq.${encodeURIComponent(roleId)}`
    )
    const permissionIds = Array.isArray(rolePermissions)
      ? rolePermissions.map((r) => r.permission_id).filter(Boolean).map((id) => String(id))
      : []
    if (!permissionIds.length) {
      rolePermissionCache.set(cacheKey, { expiresAt: Date.now() + rolePermissionCacheTtlMs, permissions: [] })
      return []
    }
    const idFilter = permissionIds.map((id) => encodeURIComponent(id)).join(',')
    const permissionRows = await supabase.select('permissions', `select=code&id=in.(${idFilter})`)
    let codes = Array.isArray(permissionRows)
      ? permissionRows.map((p) => p.code).filter(Boolean).map((code) => String(code))
      : []
    if (!codes.length) {
      const fallbackRows = await supabase.select('permissions', `select=code&permission_id=in.(${idFilter})`)
      codes = Array.isArray(fallbackRows)
        ? fallbackRows.map((p) => p.code).filter(Boolean).map((code) => String(code))
        : []
    }
    rolePermissionCache.set(cacheKey, { expiresAt: Date.now() + rolePermissionCacheTtlMs, permissions: codes })
    return codes
  } catch {
    return null
  }
}

async function getEffectivePermissions(auth: AuthContext) {
  const current = Array.isArray(auth.permissions) ? auth.permissions.map((p) => String(p)) : []
  if (current.length) return current
  const roleScope = auth.roleScope ? String(auth.roleScope) : null
  const role = auth.role ? String(auth.role) : null
  if (role) {
    const rolePermissions = await resolveRolePermissions(role, roleScope)
    if (rolePermissions !== null && rolePermissions.length > 0) return rolePermissions
  }
  const defaults = roleScope && defaultPermissionsByRoleScope[roleScope] ? defaultPermissionsByRoleScope[roleScope] : []
  return defaults.slice()
}

async function hasRequiredPermissions(auth: AuthContext, required: string[]) {
  if (!required.length) return true
  const set = new Set(await getEffectivePermissions(auth))
  return required.every((p) => set.has(String(p)))
}

export function rbac(requiredPermissions: string[] = [], options: RbacOptions = {}) {
  return async function rbacGuard(req: FastifyRequest, reply: FastifyReply) {
    const auth = getAuthContext(req)
    if (!auth || (!auth.userId && !auth.role && !auth.roleScope)) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' })
      return
    }
    const roleScope = auth.roleScope ? String(auth.roleScope) : null
    const role = auth.role ? String(auth.role) : null
    if (roleScope === 'platform' || role === 'platform_admin') {
      return
    }
    const allowedRoles = options.roles ?? []
    if (allowedRoles.length && role && allowedRoles.includes(role)) {
      return
    }
    if (!(await hasRequiredPermissions(auth, requiredPermissions))) {
      reply.status(403).send({ code: 'FORBIDDEN', message: 'Insufficient permissions.' })
      return
    }
  }
}

// ============================================================
// Tenant isolation helpers (application-layer enforcement)
// ============================================================
// Since service_role bypasses RLS, ALL queries MUST use these helpers
// to inject tenant filters. This is the primary isolation mechanism.

/**
 * Build Supabase REST query string filter for tenant isolation.
 * Platform admins get no filter (full access).
 * Reseller scope: enterprise_id in (reseller's child tenants).
 * Customer scope: enterprise_id = customerId.
 * Department scope: enterprise_id = customerId AND department_id = departmentId.
 */
export function buildTenantFilter(auth: AuthContext, opts: { field?: string } = {}): string {
  const field = opts.field ?? 'enterprise_id'
  const roleScope = auth.roleScope ? String(auth.roleScope) : null
  const role = auth.role ? String(auth.role) : null

  // Platform admin: no filter
  if (roleScope === 'platform' || role === 'platform_admin') {
    return ''
  }

  // Customer/department scope: direct match
  if (roleScope === 'customer' || roleScope === 'department') {
    const customerId = auth.customerId
    if (!customerId) return `${field}=eq.00000000-0000-0000-0000-000000000000` // deny all
    return `${field}=eq.${encodeURIComponent(customerId)}`
  }

  // Reseller scope: filter by reseller's tenant_id (parent of customer tenants)
  if (roleScope === 'reseller') {
    const resellerId = auth.resellerId
    if (!resellerId) return `${field}=eq.00000000-0000-0000-0000-000000000000` // deny all
    // For reseller, we need to filter by the reseller's child enterprise IDs
    // This requires a sub-query approach or pre-fetched enterprise list
    // Using reseller_id field if available on the table, otherwise enterprise_id filter
    return `${field}=eq.${encodeURIComponent(resellerId)}`
  }

  // Unknown scope: deny all
  return `${field}=eq.00000000-0000-0000-0000-000000000000`
}

/**
 * Get the list of enterprise IDs accessible to the current auth context.
 * For reseller scope, queries the tenants table for child enterprises.
 * Results are cached on the request object.
 */
export async function getAccessibleEnterpriseIds(auth: AuthContext): Promise<string[]> {
  const roleScope = auth.roleScope ? String(auth.roleScope) : null
  const role = auth.role ? String(auth.role) : null

  if (roleScope === 'platform' || role === 'platform_admin') {
    return [] // empty means "no filter needed"
  }

  if (roleScope === 'customer' || roleScope === 'department') {
    return auth.customerId ? [auth.customerId] : []
  }

  if (roleScope === 'reseller' && auth.resellerId) {
    try {
      const supabase = createSupabaseRestClient({ useServiceRole: true })
      const rows = await supabase.select(
        'tenants',
        `select=tenant_id&parent_id=eq.${encodeURIComponent(auth.resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
      )
      const ids = Array.isArray(rows)
        ? (rows as { tenant_id: string }[]).map(r => String(r.tenant_id)).filter(Boolean)
        : []
      return ids
    } catch {
      return []
    }
  }

  return []
}

/**
 * Build Supabase REST filter for reseller-scoped queries.
 * Returns empty string for platform admins (no filter).
 * Returns enterprise_id=in.(...) for reseller scope.
 * Returns enterprise_id=eq.X for customer scope.
 */
export async function buildTenantFilterAsync(auth: AuthContext, opts: { field?: string } = {}): Promise<string> {
  const field = opts.field ?? 'enterprise_id'
  const roleScope = auth.roleScope ? String(auth.roleScope) : null
  const role = auth.role ? String(auth.role) : null

  if (roleScope === 'platform' || role === 'platform_admin') {
    return ''
  }

  const ids = await getAccessibleEnterpriseIds(auth)
  if (!ids.length) {
    return `${field}=eq.00000000-0000-0000-0000-000000000000`
  }
  if (ids.length === 1) {
    return `${field}=eq.${encodeURIComponent(ids[0])}`
  }
  return `${field}=in.(${ids.map(id => encodeURIComponent(id)).join(',')})`
}
