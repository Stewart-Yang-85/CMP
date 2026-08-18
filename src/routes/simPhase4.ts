import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { checkPermissions, getAuthContext, rbac } from '../middleware/rbac.js'
import { runSimImport, parseIccidsFromAssignInventoryCsv } from '../services/simImport.js'
import {
  parseSimIdentifier,
  fetchSimStateHistory,
  changeSimStatus,
  markSimTestReady,
  loadSim,
  batchDeactivateSims,
  batchChangeSimStatus,
  assignInventorySimsToEnterprise,
  assignEnterpriseSimsToDepartment,
} from '../services/simLifecycle.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'
import { resolveBatchStatusChangeInput } from '../utils/batchStatusChangeInput.js'
import { parsePagination } from '../utils/pagination.js'
import {
  findIccidsOutOfLifecycleScope,
  loadSimsByIccidsForScopeCheck,
} from '../services/batchLifecycleScope.js'

function escapeCsv(value: unknown) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`
  }
  return s
}

function safeHeaderValue(value: unknown) {
  return encodeURIComponent(String(value ?? '')).replace(/%0D|%0A|%00/gi, '')
}

function setXFilters(reply: FastifyReply, value: string) {
  reply.header('X-Filters', safeHeaderValue(value))
}

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string>; suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  delete: (table: string, matchQueryString: string) => Promise<unknown>
}

type AuthResult = {
  scope: 'platform' | 'reseller' | 'customer' | 'department'
  roleScope?: string | null
  role?: string | null
  resellerId?: string | null
  customerId?: string | null
  userId?: string | null
}

type RouteDeps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => SupabaseClient
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  getRoleScope: (req: FastifyRequest) => string | null
  getEnterpriseIdFromReq: (req: FastifyRequest) => string | null
  getDepartmentIdFromReq: (req: FastifyRequest) => string | null
  buildSimTenantFilter: (
    req: FastifyRequest,
    enterpriseId: string | null,
    options?: { mode?: 'default' | 'lifecycle' },
  ) => string
  ensureResellerAdmin: (req: FastifyRequest, reply: FastifyReply) => AuthResult | null
  ensureResellerSales: (req: FastifyRequest, reply: FastifyReply) => AuthResult | null
  ensureSubscriptionAccess: (req: FastifyRequest, reply: FastifyReply) => AuthResult | null
  resolveEnterpriseForReseller: (req: FastifyRequest, reply: FastifyReply, supabase: SupabaseClient, enterpriseId: string | null) => Promise<string | null>
  resolveDepartmentForEnterprise: (req: FastifyRequest, reply: FastifyReply, supabase: SupabaseClient, enterpriseId: string | null, departmentId: string | null) => Promise<string | null>
  normalizeIccid: (value: unknown) => string
  isValidIccid: (value: unknown) => boolean
  isValidUuid: (value: unknown) => boolean
  readRequestBody: (req: FastifyRequest, maxBytes: number) => Promise<Buffer>
  parseMultipartFormData: (buffer: Buffer, boundary: string) => { fields: Record<string, unknown>; files: Record<string, { filename: string; content: string }> }
  toIsoDateTime: (value: unknown) => string | null
  pushSimStatusToUpstream?: (input: { iccid: string; status: string; traceId?: string | null; supplierId?: string | null }) => Promise<unknown>
}

export function registerSimPhase4Routes({ app, prefix, deps }: { app: FastifyInstance; prefix: string; deps: RouteDeps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getRoleScope,
    getEnterpriseIdFromReq,
    getDepartmentIdFromReq,
    buildSimTenantFilter,
    ensureResellerAdmin,
    ensureResellerSales,
    ensureSubscriptionAccess,
    resolveEnterpriseForReseller,
    resolveDepartmentForEnterprise,
    normalizeIccid,
    isValidIccid,
    isValidUuid,
    readRequestBody,
    parseMultipartFormData,
    toIsoDateTime,
    pushSimStatusToUpstream,
  } = deps
  function cmpAuthActorForDb(req: FastifyRequest) {
    const raw = (req as {
      cmpAuth?: { userId?: string | null; resellerId?: string | null; role?: string | null; roleScope?: string | null }
    }).cmpAuth
    return raw ? { ...raw, userId: actorUserIdForDb(raw.userId) } : null
  }

  const resellerSalesRoles = new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director'])
  const LIFECYCLE_RESELLER_ROLES = ['reseller_admin', 'reseller_sales', 'reseller_sales_director'] as const
  const LIFECYCLE_CUSTOMER_ADMIN_ROLES = ['customer_admin'] as const
  const LIFECYCLE_RESELLER_ADMIN_ONLY = ['reseller_admin'] as const

  const ensureSimLifecycleResellerOrPlatformAdmin = (
    req: FastifyRequest,
    reply: FastifyReply,
  ): AuthResult | null => {
    const cmpAuth = (req as {
      cmpAuth?: {
        role?: string | null
        roleScope?: string | null
        resellerId?: string | null
        userId?: string | null
      }
    }).cmpAuth
    if (!cmpAuth?.roleScope && !cmpAuth?.role) {
      sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    const roleScope = getRoleScope(req)
    const role = cmpAuth.role ? String(cmpAuth.role) : null
    if (roleScope === 'platform' || role === 'platform_admin') {
      return {
        scope: 'platform',
        role,
        roleScope,
        userId: actorUserIdForDb(cmpAuth.userId),
        resellerId: null,
      }
    }
    if (roleScope === 'reseller' && role === 'reseller_admin') {
      const rid =
        cmpAuth.resellerId ??
        (req as { tenantScope?: { resellerId?: string | null } }).tenantScope?.resellerId ??
        null
      return {
        scope: 'reseller',
        role,
        roleScope,
        resellerId: rid ? String(rid) : null,
        userId: actorUserIdForDb(cmpAuth.userId),
      }
    }
    sendError(reply, 403, 'FORBIDDEN', 'Reseller admin or platform admin role required.')
    return null
  }

  const ensureSimLifecycleAccess = (
    req: FastifyRequest,
    reply: FastifyReply,
    options?: { enterpriseAdminOnly?: boolean },
  ): AuthResult | null => {
    const cmpAuth = (req as {
      cmpAuth?: {
        role?: string | null
        roleScope?: string | null
        customerId?: string | null
        resellerId?: string | null
        userId?: string | null
      }
    }).cmpAuth
    if (!cmpAuth?.roleScope && !cmpAuth?.role) {
      sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    const roleScope = getRoleScope(req)
    const role = cmpAuth.role ? String(cmpAuth.role) : null

    if (roleScope === 'platform' || role === 'platform_admin') {
      return {
        scope: 'platform',
        role,
        roleScope,
        userId: actorUserIdForDb(cmpAuth.userId),
        customerId: getEnterpriseIdFromReq(req),
        resellerId: null,
      }
    }
    if (roleScope === 'reseller') {
      if (options?.enterpriseAdminOnly) {
        if (role !== 'reseller_admin') {
          sendError(reply, 403, 'FORBIDDEN', 'Reseller admin role required.')
          return null
        }
      } else if (role && !resellerSalesRoles.has(role)) {
        sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
        return null
      }
      const rid =
        cmpAuth.resellerId ??
        (req as { tenantScope?: { resellerId?: string | null } }).tenantScope?.resellerId ??
        null
      return {
        scope: 'reseller',
        role,
        roleScope,
        resellerId: rid ? String(rid) : null,
        userId: actorUserIdForDb(cmpAuth.userId),
      }
    }
    if (roleScope === 'customer' || roleScope === 'department') {
      if (options?.enterpriseAdminOnly && role !== 'customer_admin') {
        sendError(reply, 403, 'FORBIDDEN', 'Enterprise admin role required.')
        return null
      }
      return {
        scope: roleScope === 'department' ? 'department' : 'customer',
        role,
        roleScope,
        userId: actorUserIdForDb(cmpAuth.userId),
        customerId: getEnterpriseIdFromReq(req),
      }
    }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  const ensureSimReadAccess = (req: FastifyRequest, reply: FastifyReply): AuthResult | null => {
    const roleScope = getRoleScope(req)
    const role = (req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role
      ? String((req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role)
      : null
    if (!roleScope && !role) {
      sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (roleScope === 'platform' || role === 'platform_admin') return { scope: 'platform' }
    if (roleScope === 'reseller' && role && resellerSalesRoles.has(role)) {
      const rid =
        (req as { cmpAuth?: { resellerId?: string | null } }).cmpAuth?.resellerId ??
        (req as { tenantScope?: { resellerId?: string | null } }).tenantScope?.resellerId ??
        null
      return { scope: 'reseller', resellerId: rid ? String(rid) : null }
    }
    if (roleScope === 'customer') return { scope: 'customer' }
    if (roleScope === 'department') return { scope: 'department' }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }
  const ensureChannelSimListAccess = (req: FastifyRequest, reply: FastifyReply) => {
    const roleScope = getRoleScope(req)
    const role = (req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role
      ? String((req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role)
      : null
    if (roleScope === 'platform' || role === 'platform_admin') return { scope: 'platform' as const }
    if (roleScope === 'reseller' && role && resellerSalesRoles.has(role)) return { scope: 'reseller' as const }
    if (roleScope === 'customer' || roleScope === 'department') {
      sendError(
        reply,
        403,
        'FORBIDDEN',
        'Enterprise users must use GET /v1/enterprises/{enterpriseId}/sims.'
      )
      return null
    }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }
  /** Customer / department JWT: optional query enterpriseId must match token enterprise (same idea as reseller scope check). */
  const resolveEnterpriseIdForCustomerScope = (
    reply: FastifyReply,
    tokenEnterprise: string | null,
    enterpriseIdQuery: string | null | undefined
  ): string | null => {
    const token = tokenEnterprise ? String(tokenEnterprise).trim() : ''
    if (!token || !isValidUuid(token)) {
      sendError(reply, 403, 'FORBIDDEN', 'Enterprise scope is required.')
      return null
    }
    const queryRaw = enterpriseIdQuery ? String(enterpriseIdQuery).trim() : ''
    if (!queryRaw) {
      return token
    }
    if (!isValidUuid(queryRaw)) {
      sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return null
    }
    if (queryRaw.toLowerCase() !== token.toLowerCase()) {
      sendError(reply, 403, 'FORBIDDEN', 'enterpriseId is out of scope.')
      return null
    }
    return queryRaw
  }

  const validateUsageEnterpriseIdForCustomerScope = async (
    req: FastifyRequest,
    reply: FastifyReply,
    supabase: SupabaseClient,
    enterpriseIdQuery: string | null,
  ): Promise<boolean> => {
    const roleScope = getRoleScope(req)
    if (roleScope !== 'customer' && roleScope !== 'department') return true
    if (!enterpriseIdQuery) return true
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id&tenant_id=eq.${encodeURIComponent(enterpriseIdQuery)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const enterprise = Array.isArray(rows) ? rows[0] : null
    if (!enterprise?.tenant_id) {
      sendError(reply, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseIdQuery} not found.`)
      return false
    }
    const tokenEnterprise = getEnterpriseIdFromReq(req)
    if (!tokenEnterprise || String(enterpriseIdQuery).toLowerCase() !== String(tokenEnterprise).toLowerCase()) {
      sendError(reply, 403, 'FORBIDDEN', 'enterpriseId is out of token scope.')
      return false
    }
    return true
  }

  const ensureSimAssignDepartmentAccess = (req: FastifyRequest, reply: FastifyReply): AuthResult | null => {
    const cmpAuth = (req as {
      cmpAuth?: {
        role?: string | null
        roleScope?: string | null
        customerId?: string | null
        resellerId?: string | null
        userId?: string | null
      }
    }).cmpAuth
    if (!cmpAuth?.roleScope && !cmpAuth?.role) {
      sendError(reply, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (cmpAuth.roleScope === 'platform' || cmpAuth.role === 'platform_admin') {
      return {
        scope: 'platform',
        role: cmpAuth.role,
        roleScope: cmpAuth.roleScope,
        userId: actorUserIdForDb(cmpAuth.userId),
      }
    }
    if (cmpAuth.roleScope === 'reseller' && cmpAuth.role === 'reseller_admin') {
      return {
        scope: 'reseller',
        role: cmpAuth.role,
        roleScope: cmpAuth.roleScope,
        resellerId: cmpAuth.resellerId ? String(cmpAuth.resellerId) : null,
        userId: actorUserIdForDb(cmpAuth.userId),
      }
    }
    if (cmpAuth.roleScope === 'customer' && cmpAuth.role === 'customer_admin') {
      return {
        scope: 'customer',
        role: cmpAuth.role,
        roleScope: cmpAuth.roleScope,
        customerId: cmpAuth.customerId ? String(cmpAuth.customerId) : null,
        userId: actorUserIdForDb(cmpAuth.userId),
      }
    }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  const simsListResellerScopeFromQuery = (query: Record<string, unknown>) => {
    const resellerQueryRaw =
      query.resellerId !== undefined && query.resellerId !== null && String(query.resellerId).trim() !== ''
        ? String(query.resellerId).trim()
        : null
    return { resellerQueryRaw, effective: resellerQueryRaw }
  }

  /** Reseller JWT: omit `resellerId` → token reseller; set and valid and matching → ok; else 400/403. */
  const resolveResellerIdForResellerQuery = (
    reply: FastifyReply,
    resellerIdQuery: string | null,
    authResellerId: string | null | undefined,
  ): string | null => {
    const token = authResellerId ? String(authResellerId).trim() : ''
    if (!token || !isValidUuid(token)) {
      sendError(reply, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      return null
    }
    if (!resellerIdQuery) return token
    if (!isValidUuid(resellerIdQuery)) {
      sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      return null
    }
    if (resellerIdQuery !== token) {
      sendError(reply, 403, 'FORBIDDEN', 'resellerId does not match the authenticated reseller.')
      return null
    }
    return token
  }

  const resolveOperatorFilter = async (supabase: SupabaseClient, operatorId: string, supplierId: string | null = null) => {
    const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
    const operatorRows = await supabase.select(
      'operators',
      `select=operator_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`
    )
    const operator = Array.isArray(operatorRows) ? operatorRows[0] : null
    if (operator?.operator_id) {
      return { operatorIds: [String(operator.operator_id)] }
    }
    const mappedRows = await supabase.select(
      'operators',
      `select=operator_id&business_operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}`
    )
    const operatorIds = Array.from(new Set(
      (Array.isArray(mappedRows) ? mappedRows : [])
        .map((row: any) => (row?.operator_id ? String(row.operator_id) : ''))
        .filter(Boolean)
    ))
    if (!operatorIds.length) return null
    return { operatorIds }
  }

  /**
   * When 2+ of resellerId / enterpriseId / supplierId / operatorId are provided,
   * they MUST form a consistent scope (parent/child or reseller_suppliers / operators).
   * departmentId is validated separately via resolveDepartmentForEnterprise.
   */
  const validateSimListIdFiltersMatch = async (
    supabase: SupabaseClient,
    input: {
      resellerId: string | null
      enterpriseId: string | null
      supplierId: string | null
      operatorId: string | null
    }
  ): Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }> => {
    const resellerId = input.resellerId ? String(input.resellerId).trim() : null
    const enterpriseId = input.enterpriseId ? String(input.enterpriseId).trim() : null
    const supplierId = input.supplierId ? String(input.supplierId).trim() : null
    const operatorId = input.operatorId ? String(input.operatorId).trim() : null
    const provided = [resellerId, enterpriseId, supplierId, operatorId].filter(Boolean)
    if (provided.length < 2) return { ok: true }

    let enterpriseParentId: string | null = null
    if (enterpriseId) {
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterprise = Array.isArray(enterpriseRows) ? (enterpriseRows[0] as { parent_id?: string } | undefined) : null
      if (!enterprise) {
        return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: `enterprise ${enterpriseId} not found.` }
      }
      enterpriseParentId = enterprise.parent_id ? String(enterprise.parent_id) : null
      if (resellerId && enterpriseParentId !== resellerId) {
        return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'resellerId and enterpriseId do not match.' }
      }
    }

    const scopeResellerId = resellerId || enterpriseParentId

    if (resellerId && (supplierId || operatorId)) {
      const resellerRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
      )
      if (!Array.isArray(resellerRows) || !resellerRows[0]) {
        return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: `reseller ${resellerId} not found.` }
      }
    }

    if (supplierId) {
      const supplierRows = await supabase.select(
        'suppliers',
        `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
      )
      if (!Array.isArray(supplierRows) || !supplierRows[0]) {
        return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: `supplier ${supplierId} not found.` }
      }
      if (scopeResellerId) {
        const bindRows = await supabase.select(
          'reseller_suppliers',
          `select=supplier_id&reseller_id=eq.${encodeURIComponent(scopeResellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
        )
        if (!Array.isArray(bindRows) || !bindRows[0]) {
          return {
            ok: false,
            status: 400,
            code: 'BAD_REQUEST',
            message: 'supplierId is not bound to resellerId.',
          }
        }
      }
    }

    if (operatorId) {
      const resolved = await resolveOperatorFilter(supabase, operatorId, supplierId)
      if (!resolved) {
        if (supplierId) {
          return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'supplierId and operatorId do not match.' }
        }
        return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: `operator ${operatorId} not found.` }
      }
      if (scopeResellerId && !supplierId) {
        const opRows = await supabase.select(
          'operators',
          `select=operator_id,supplier_id&operator_id=in.(${resolved.operatorIds.map((id) => encodeURIComponent(id)).join(',')})`
        )
        const opSupplierIds = Array.from(
          new Set(
            (Array.isArray(opRows) ? opRows : [])
              .map((row: any) => (row?.supplier_id ? String(row.supplier_id) : ''))
              .filter(Boolean)
          )
        )
        if (!opSupplierIds.length) {
          return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'operatorId does not match resellerId.' }
        }
        const bindRows = await supabase.select(
          'reseller_suppliers',
          `select=supplier_id&reseller_id=eq.${encodeURIComponent(scopeResellerId)}&supplier_id=in.(${opSupplierIds.map((id) => encodeURIComponent(id)).join(',')})`
        )
        if (!Array.isArray(bindRows) || bindRows.length === 0) {
          return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'operatorId does not match resellerId.' }
        }
      }
    }

    return { ok: true }
  }

  const appendOperatorFilter = (filters: string[], operatorFilter: { operatorIds: string[] } | null) => {
    const operatorIds = Array.isArray(operatorFilter?.operatorIds) ? operatorFilter.operatorIds : []
    if (!operatorIds.length) return
    if (operatorIds.length === 1) {
      filters.push(`operator_id=eq.${encodeURIComponent(operatorIds[0])}`)
      return
    }
    filters.push(`operator_id=in.(${operatorIds.map((id) => encodeURIComponent(id)).join(',')})`)
  }

  /** ICCID prefix search for 1–19 digits; exact match only when 20 digits. */
  const appendIccidListFilter = (filters: string[], iccidRaw: string) => {
    if (iccidRaw.length === 20) {
      filters.push(`iccid=eq.${encodeURIComponent(iccidRaw)}`)
    } else {
      filters.push(`iccid=ilike.${encodeURIComponent(iccidRaw + '%')}`)
    }
  }

  const resolveOperatorIdsByMccMnc = async (
    supabase: SupabaseClient,
    mcc: string | null,
    mnc: string | null
  ): Promise<{ operatorIds: string[] } | null> => {
    const mccVal = mcc ? String(mcc).trim() : ''
    const mncVal = mnc ? String(mnc).trim() : ''
    if (!mccVal && !mncVal) return null
    const bizFilters: string[] = []
    if (mccVal) bizFilters.push(`mcc=eq.${encodeURIComponent(mccVal)}`)
    if (mncVal) bizFilters.push(`mnc=eq.${encodeURIComponent(mncVal)}`)
    const bizRows = await supabase.select(
      'business_operators',
      `select=operator_id&${bizFilters.join('&')}`
    )
    const businessIds = Array.from(
      new Set(
        (Array.isArray(bizRows) ? bizRows : [])
          .map((row: { operator_id?: string }) => (row?.operator_id ? String(row.operator_id) : ''))
          .filter(Boolean)
      )
    )
    if (!businessIds.length) return { operatorIds: [] }
    const mappedRows = await supabase.select(
      'operators',
      `select=operator_id&business_operator_id=in.(${businessIds.map((id) => encodeURIComponent(id)).join(',')})`
    )
    const operatorIds = new Set<string>(businessIds)
    for (const row of Array.isArray(mappedRows) ? mappedRows : []) {
      if ((row as { operator_id?: string })?.operator_id) {
        operatorIds.add(String((row as { operator_id: string }).operator_id))
      }
    }
    return { operatorIds: Array.from(operatorIds) }
  }

  const resolveEnterpriseIdForEnterpriseSimList = async (
    req: FastifyRequest,
    reply: FastifyReply,
    supabase: SupabaseClient,
    pathEnterpriseId: string
  ): Promise<string | null> => {
    if (!isValidUuid(pathEnterpriseId)) {
      sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return null
    }
    const roleScope = getRoleScope(req)
    const role = (req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role
      ? String((req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role)
      : null
    if (roleScope === 'reseller') {
      return resolveEnterpriseForReseller(req, reply, supabase, pathEnterpriseId)
    }
    if (roleScope === 'platform' || role === 'platform_admin') {
      return pathEnterpriseId
    }
    if (roleScope === 'customer' || roleScope === 'department') {
      return resolveEnterpriseIdForCustomerScope(reply, getEnterpriseIdFromReq(req), pathEnterpriseId)
    }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  const loadBusinessOperatorMap = async (supabase: SupabaseClient, operatorIds: unknown[]) => {
    const ids = Array.from(new Set(
      (Array.isArray(operatorIds) ? operatorIds : [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
    ))
    if (!ids.length) return new Map<string, any>()
    const operatorRows = await supabase.select(
      'operators',
      `select=operator_id,business_operator_id&operator_id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`
    )
    const operatorToBusinessMap = new Map<string, string>()
    const businessIds = new Set(ids)
    for (const row of (Array.isArray(operatorRows) ? operatorRows : [])) {
      const operatorId = row?.operator_id ? String(row.operator_id) : null
      const businessOperatorId = row?.business_operator_id ? String(row.business_operator_id) : null
      if (!operatorId || !businessOperatorId) continue
      operatorToBusinessMap.set(operatorId, businessOperatorId)
      businessIds.add(businessOperatorId)
    }
    const rows = await supabase.select(
      'business_operators',
      `select=operator_id,name,mcc,mnc&operator_id=in.(${Array.from(businessIds).map((id) => encodeURIComponent(id)).join(',')})`
    )
    const businessMap = new Map(
      (Array.isArray(rows) ? rows : [])
        .filter((row: any) => row?.operator_id)
        .map((row: any) => [String(row.operator_id), row])
    )
    const resolvedMap = new Map<string, any>()
    for (const id of ids) {
      const resolvedId = operatorToBusinessMap.get(id) ?? id
      const business = businessMap.get(resolvedId)
      if (business) resolvedMap.set(id, business)
    }
    return resolvedMap
  }

  const isMissingSimResellerColumnError = (err: any) => {
    const text = String(err?.body ?? err?.message ?? '').toLowerCase()
    return text.includes('column sims.reseller_id does not exist')
  }

  const detectSimResellerColumn = async (supabase: SupabaseClient) => {
    try {
      await supabase.select('sims', 'select=reseller_id&limit=1', { suppressMissingColumns: true })
      return true
    } catch (err) {
      if (isMissingSimResellerColumnError(err)) return false
      throw err
    }
  }

  const isMissingSimImeiLockColumnError = (err: any) => {
    const text = String(err?.body ?? err?.message ?? '').toLowerCase()
    return text.includes('column sims.imei_lock_enabled does not exist')
  }

  const detectSimImeiLockColumn = async (supabase: SupabaseClient) => {
    try {
      await supabase.select('sims', 'select=imei_lock_enabled&limit=1', { suppressMissingColumns: true })
      return true
    } catch (err) {
      if (isMissingSimImeiLockColumnError(err)) return false
      throw err
    }
  }

  const loadSimTenantAndResellerMaps = async (
    supabase: SupabaseClient,
    rows: any[],
    hasSimResellerColumn: boolean,
    supplierResellerMap: Map<string, string>,
  ) => {
    const enterpriseIds = Array.from(
      new Set(rows.map((r: any) => r.enterprise_id).filter(Boolean).map((v: any) => String(v)))
    )
    const departmentIds = Array.from(
      new Set(rows.map((r: any) => r.department_id).filter(Boolean).map((v: any) => String(v)))
    )
    const tenantIds = Array.from(new Set([...enterpriseIds, ...departmentIds]))

    let tenantNameMap = new Map<string, string | null>()
    let tenantParentMap = new Map<string, string | null>()

    if (tenantIds.length) {
      const tRows = await supabase.select(
        'tenants',
        `select=tenant_id,name,parent_id&tenant_id=in.(${tenantIds.map((id) => encodeURIComponent(id)).join(',')})`
      )
      const tRowsArr = Array.isArray(tRows) ? tRows : []
      tenantNameMap = new Map(tRowsArr.map((t: any) => [String(t.tenant_id), t.name ?? null]))
      tenantParentMap = new Map(
        tRowsArr.map((t: any) => [String(t.tenant_id), t.parent_id ? String(t.parent_id) : null])
      )
    }

    const directResellerIds = hasSimResellerColumn
      ? Array.from(new Set(rows.map((r: any) => (r?.reseller_id ? String(r.reseller_id) : '')).filter(Boolean)))
      : []
    const resellerIdsFromParents = Array.from(tenantParentMap.values()).filter((id): id is string => Boolean(id))
    const allResellerIds = Array.from(
      new Set([
        ...directResellerIds,
        ...resellerIdsFromParents,
        ...Array.from(supplierResellerMap.values()),
      ])
    )

    let resellerNameMap = new Map<string, string | null>()
    if (allResellerIds.length) {
      const rRows = await supabase.select(
        'tenants',
        `select=tenant_id,name&tenant_id=in.(${allResellerIds.map((id) => encodeURIComponent(id)).join(',')})`
      )
      resellerNameMap = new Map(
        (Array.isArray(rRows) ? rRows : []).map((t: any) => [String(t.tenant_id), t.name ?? null])
      )
    }

    return { tenantNameMap, tenantParentMap, resellerNameMap }
  }

  const resolveSimResellerId = (
    r: any,
    hasSimResellerColumn: boolean,
    tenantParentMap: Map<string, string | null>,
    supplierResellerMap: Map<string, string>,
  ): string | null => {
    if (hasSimResellerColumn && r.reseller_id) return String(r.reseller_id)
    if (r.enterprise_id) return tenantParentMap.get(String(r.enterprise_id)) ?? null
    if (r.supplier_id) return supplierResellerMap.get(String(r.supplier_id)) ?? null
    return null
  }

  const buildResellerOwnerIds = async (supabase: SupabaseClient, resellerTenantId: string) => {
    const ownerIds = new Set<string>([resellerTenantId])
    try {
      const rows = await supabase.select(
        'resellers',
        `select=id&tenant_id=eq.${encodeURIComponent(resellerTenantId)}&limit=1`,
        { suppressMissingColumns: true }
      )
      const row = Array.isArray(rows) ? (rows[0] as { id?: string } | undefined) : undefined
      if (row?.id) ownerIds.add(String(row.id))
    } catch {
      // optional in some seeds
    }
    return ownerIds
  }

  /** Reseller may read inventory (reseller_id) or SIMs on child enterprises / linked suppliers. */
  const assertResellerCanReadSim = async (
    supabase: SupabaseClient,
    sim: Record<string, unknown>,
    resellerTenantId: string,
    hasSimResellerColumn: boolean
  ): Promise<boolean> => {
    const ownerIds = await buildResellerOwnerIds(supabase, resellerTenantId)
    if (sim.enterprise_id) {
      const entRows = await supabase.select(
        'tenants',
        `select=parent_id&tenant_id=eq.${encodeURIComponent(String(sim.enterprise_id))}&limit=1`
      )
      const ent = Array.isArray(entRows) ? (entRows[0] as { parent_id?: string | null }) : null
      if (ent && ent.parent_id && ownerIds.has(String(ent.parent_id))) return true
      return false
    }
    if (hasSimResellerColumn && sim.reseller_id != null && String(sim.reseller_id) !== '') {
      if (ownerIds.has(String(sim.reseller_id))) return true
    }
    if (sim.supplier_id) {
      const rsRows = await supabase.select(
        'reseller_suppliers',
        `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerTenantId)}&supplier_id=eq.${encodeURIComponent(String(sim.supplier_id))}&limit=1`
      )
      if (Array.isArray(rsRows) && rsRows.length > 0) return true
    }
    return false
  }

  const readLifecycleEnterpriseIdInput = (req: FastifyRequest, body: Record<string, unknown>) => {
    const query = (req.query ?? {}) as Record<string, unknown>
    const fromBody = body.enterpriseId != null && String(body.enterpriseId).trim() !== ''
      ? String(body.enterpriseId).trim()
      : null
    const fromQuery = query.enterpriseId != null && String(query.enterpriseId).trim() !== ''
      ? String(query.enterpriseId).trim()
      : null
    return fromBody ?? fromQuery
  }

  const resolveSimLifecycleEnterpriseId = async (
    req: FastifyRequest,
    reply: FastifyReply,
    supabase: SupabaseClient,
    enterpriseIdInput: string | null,
  ): Promise<string | null | false> => {
    const roleScope = getRoleScope(req)
    const role = (req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role
      ? String((req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role)
      : null

    if (roleScope === 'customer' || roleScope === 'department') {
      const resolved = resolveEnterpriseIdForCustomerScope(
        reply,
        getEnterpriseIdFromReq(req),
        enterpriseIdInput,
      )
      return resolved === null ? false : resolved
    }
    if (roleScope === 'reseller') {
      if (!enterpriseIdInput) return null
      const resolved = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdInput)
      return resolved === null ? false : resolved
    }
    if (roleScope === 'platform' || role === 'platform_admin') {
      if (!enterpriseIdInput) return null
      if (!isValidUuid(enterpriseIdInput)) {
        sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return false
      }
      return enterpriseIdInput
    }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return false
  }

  /** Batch status change: enterprise scope from token only (customer); reseller/platform rely on per-ICCID checks. */
  const resolveBatchStatusChangeEnterpriseScope = (
    req: FastifyRequest,
    reply: FastifyReply,
  ): string | null | false => {
    const roleScope = getRoleScope(req)
    if (roleScope === 'customer' || roleScope === 'department') {
      const resolved = resolveEnterpriseIdForCustomerScope(reply, getEnterpriseIdFromReq(req), null)
      return resolved === null ? false : resolved
    }
    return null
  }

  const assertSimLifecycleAccess = async (
    req: FastifyRequest,
    reply: FastifyReply,
    supabase: SupabaseClient,
    sim: Record<string, unknown>,
    auth: AuthResult,
    hasSimResellerColumn: boolean,
    enterpriseIdFilter: string | null,
  ): Promise<boolean> => {
    const roleScope = getRoleScope(req)
    const role = (req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role
      ? String((req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role)
      : null
    const userEnterpriseId = getEnterpriseIdFromReq(req)

    if (roleScope === 'reseller') {
      const authResellerId = auth.resellerId ?? getAuthContext(req).resellerId ?? null
      if (!authResellerId) {
        sendError(reply, 403, 'FORBIDDEN', 'Reseller scope is required.')
        return false
      }
      if (enterpriseIdFilter) {
        if (!sim.enterprise_id || String(sim.enterprise_id) !== String(enterpriseIdFilter)) {
          sendError(reply, 403, 'FORBIDDEN', 'SIM does not belong to the specified enterprise.')
          return false
        }
      }
      const allowed = await assertResellerCanReadSim(
        supabase,
        sim,
        String(authResellerId),
        hasSimResellerColumn,
      )
      if (!allowed) {
        sendError(reply, 403, 'FORBIDDEN', 'SIM does not belong to your reseller.')
        return false
      }
      return true
    }
    if (roleScope === 'customer' || roleScope === 'department') {
      if (
        !sim.enterprise_id ||
        !userEnterpriseId ||
        String(sim.enterprise_id) !== String(userEnterpriseId)
      ) {
        sendError(reply, 403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
        return false
      }
      if (roleScope === 'department') {
        const userDeptId = getDepartmentIdFromReq(req)
        if (sim.department_id && userDeptId && String(sim.department_id) !== String(userDeptId)) {
          sendError(reply, 403, 'FORBIDDEN', 'SIM does not belong to your department.')
          return false
        }
      }
      return true
    }
    if (roleScope === 'platform' || role === 'platform_admin') {
      return true
    }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return false
  }

  app.post(
    `${prefix}/sims/import-jobs`,
    { preHandler: rbac(['sims.import'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      const auth = ensureResellerAdmin(req, reply)
      if (!auth) return
      const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return sendError(reply, 400, 'BAD_REQUEST', 'multipart/form-data is required.')
      }
      const boundaryMatch = contentType.match(/boundary=([^;]+)/i)
      if (!boundaryMatch) {
        return sendError(reply, 400, 'BAD_REQUEST', 'multipart boundary is required.')
      }
      let bodyBuffer: Buffer
      try {
        bodyBuffer = await readRequestBody(req, 50 * 1024 * 1024)
      } catch {
        return sendError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
      }
      const { fields, files } = parseMultipartFormData(bodyBuffer, boundaryMatch[1])
      if (auth.scope !== 'reseller' && auth.scope !== 'platform') {
        return sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      const authResellerId = auth?.resellerId ? String(auth.resellerId).trim() : null
      const resellerId = fields.resellerId ? String(fields.resellerId).trim() : null
      const supplierId = fields.supplierId ? String(fields.supplierId).trim() : null
      const batchId = fields.batchId ? String(fields.batchId).trim() : null
      const apnOpt = fields.apn ? String(fields.apn).trim() : null
      const operatorId = fields.operatorId ? String(fields.operatorId).trim() : null
      if (!resellerId || !isValidUuid(resellerId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'resellerId is required and must be a valid uuid.')
      }
      if (auth.scope === 'reseller') {
        if (!authResellerId || !isValidUuid(authResellerId)) {
          return sendError(reply, 403, 'FORBIDDEN', 'Invalid reseller context.')
        }
        if (resellerId !== authResellerId) {
          return sendError(reply, 403, 'FORBIDDEN', 'resellerId is out of scope.')
        }
      }
      if (!supplierId || !isValidUuid(supplierId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
      }
      if (!operatorId || !isValidUuid(operatorId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
      }
      const file = files.file
      if (!file || !file.content) {
        return sendError(reply, 400, 'INVALID_FORMAT', 'file is required.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const enterpriseId = null
      const csvText = String(file.content ?? '')
      const result = await runSimImport({
        supabase,
        csvText,
        supplierId,
        apn: apnOpt,
        operatorId,
        enterpriseId,
        batchId,
        traceId: getTraceId(reply),
        actorUserId: actorUserIdForDb(auth.userId),
        actorRole: auth.role ?? null,
        resellerId,
        sourceIp: req.ip,
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      reply.status(202).send({
        jobId: result.jobId,
        status: result.status,
        totalRows: result.totalRows,
        createdAt: result.createdAt,
      })
    }
  )

  app.post(
    `${prefix}/sims`,
    { preHandler: rbac(['sims.create'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      const auth = ensureResellerAdmin(req, reply)
      if (!auth) return
      const {
        iccid: iccidRaw,
        imsi,
        secondaryImsi1,
        secondaryImsi2,
        secondaryImsi3,
        msisdn,
        apn,
        supplierId,
        operatorId,
        enterpriseId: enterpriseIdBody,
        formFactor,
        activationCode,
        imei,
        imeiLockEnabled,
      } = (req.body ?? {}) as Record<string, unknown>
      const iccid = normalizeIccid(iccidRaw)
      if (!iccid || !isValidIccid(iccid)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
      }
      const imsiValue = String(imsi ?? '').trim()
      if (!imsiValue) {
        return sendError(reply, 400, 'BAD_REQUEST', 'imsi is required.')
      }
      const apnValue = String(apn ?? '').trim()
      if (!apnValue) {
        return sendError(reply, 400, 'BAD_REQUEST', 'apn is required.')
      }
      const supplierIdValue = supplierId ? String(supplierId).trim() : null
      const operatorIdValue = operatorId ? String(operatorId).trim() : null
      if (!supplierIdValue || !isValidUuid(supplierIdValue)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
      }
      if (!operatorIdValue || !isValidUuid(operatorIdValue)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
      }
      if (enterpriseIdBody && !isValidUuid(enterpriseIdBody)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      const formFactorRaw = formFactor ? String(formFactor).trim() : ''
      const allowedFormFactors = new Set(['consumer_removable', 'industrial_removable', 'consumer_embedded', 'industrial_embedded'])
      if (formFactorRaw && !allowedFormFactors.has(formFactorRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'formFactor is invalid.')
      }
      const imeiValue = imei ? String(imei).trim() : ''
      if (imeiValue && !/^\d{15}$/.test(imeiValue)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'imei must be 15 digits.')
      }
      const lockOn = imeiLockEnabled === true
      const imeiProvided = Boolean(imeiValue)
      if (lockOn !== imeiProvided) {
        return sendError(
          reply,
          400,
          'BAD_REQUEST',
          'imeiLockEnabled and imei must be provided together (IME Lock on requires both true and a 15-digit imei; IME Lock off requires both omitted).'
        )
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const hasSimImeiLockColumn = await detectSimImeiLockColumn(supabase)
      let enterpriseId = enterpriseIdBody ? String(enterpriseIdBody).trim() : null
      if (auth.scope === 'reseller') {
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseId)
        if (!enterpriseId) return
      }
      const operatorRows = await supabase.select(
        'operators',
        `select=operator_id&operator_id=eq.${encodeURIComponent(operatorIdValue)}&supplier_id=eq.${encodeURIComponent(supplierIdValue)}&limit=1`
      )
      const operator = Array.isArray(operatorRows) ? operatorRows[0] : null
      if (!operator?.operator_id) {
        return sendError(reply, 400, 'INVALID_OPERATOR', 'Operator is not linked to supplier.')
      }
      const businessRows = await supabase.select(
        'business_operators',
        `select=operator_id&operator_id=eq.${encodeURIComponent(operatorIdValue)}&limit=1`
      )
      const business = Array.isArray(businessRows) ? businessRows[0] : null
      if (!business?.operator_id) {
        return sendError(reply, 400, 'INVALID_OPERATOR', 'Operator is not found in business operators.')
      }
      const existingRows = await supabase.select('sims', `select=sim_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
      const existing = Array.isArray(existingRows) ? existingRows[0] : null
      if (existing) {
        return sendError(reply, 409, 'DUPLICATE_ICCID', 'ICCID already exists.')
      }
      const insertPayload: Record<string, unknown> = {
        iccid,
        primary_imsi: imsiValue,
        imsi_secondary_1: secondaryImsi1 ? String(secondaryImsi1).trim() : null,
        imsi_secondary_2: secondaryImsi2 ? String(secondaryImsi2).trim() : null,
        imsi_secondary_3: secondaryImsi3 ? String(secondaryImsi3).trim() : null,
        msisdn: msisdn ? String(msisdn).trim() : null,
        supplier_id: supplierIdValue,
        operator_id: operator.operator_id,
        enterprise_id: enterpriseId ?? null,
        status: 'INVENTORY',
        apn: apnValue,
        bound_imei: lockOn ? imeiValue : null,
        ...(hasSimImeiLockColumn ? { imei_lock_enabled: lockOn } : {}),
        activation_code: activationCode ? String(activationCode).trim() : null,
        last_status_change_at: new Date().toISOString(),
      }
      if (formFactorRaw) {
        insertPayload.form_factor = formFactorRaw
      }
      const rows = await supabase.insert('sims', insertPayload)
      const sim = Array.isArray(rows) ? rows[0] : null
      reply.status(201).send({
        simId: sim?.sim_id ?? null,
        iccid,
        status: sim?.status ?? 'INVENTORY',
        createdAt: sim?.created_at ?? new Date().toISOString(),
      })
    }
  )

  app.get(
    `${prefix}/sims`,
    { preHandler: rbac(['sims.list']) },
    async (req, reply) => {
      const auth = ensureChannelSimListAccess(req, reply)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const roleScope = getRoleScope(req)
      const query = req.query as Record<string, unknown>
      const useCatalogSimFilters = roleScope === 'platform' || roleScope === 'reseller'
      const iccidRaw = query.iccid ? normalizeIccid(query.iccid) : null
      const imsiFilter = query.imsi ? String(query.imsi).trim() : null
      const status = query.status ? String(query.status) : null
      const supplierId =
        useCatalogSimFilters && query.supplierId ? String(query.supplierId).trim() : null
      const operatorId =
        useCatalogSimFilters && query.operatorId ? String(query.operatorId).trim() : null
      const qSimsReseller = simsListResellerScopeFromQuery(query)
      const resellerIdQuery = qSimsReseller.effective
      const enterpriseIdQuery = query.enterpriseId ? String(query.enterpriseId) : null
      const departmentIdQuery = query.departmentId ? String(query.departmentId) : null
      const packageIdQuery = query.packageId ? String(query.packageId).trim() : null
      const page = query.page ? Number(query.page) : 1
      const pageSizeRaw = query.pageSize !== undefined && query.pageSize !== null ? Number(query.pageSize) : 20
      const pageSize = Math.min(100, Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 20))
      const offset = Math.max(0, (Math.max(1, page) - 1) * pageSize)
      if (iccidRaw && !/^\d{1,20}$/.test(iccidRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
      }
      if (supplierId && !isValidUuid(supplierId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
      }
      if (operatorId && !isValidUuid(operatorId)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
      }
      if (useCatalogSimFilters && qSimsReseller.resellerQueryRaw && !isValidUuid(qSimsReseller.resellerQueryRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      }
      if (packageIdQuery && !isValidUuid(packageIdQuery)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'packageId must be a valid uuid.')
      }
      // T142: packageId requires enterpriseId for platform/reseller scope
      if (packageIdQuery && (roleScope === 'platform' || roleScope === 'reseller') && !enterpriseIdQuery) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required when filtering by packageId.')
      }
      // T142: Resolve SIM IDs from package subscriptions
      let packageSimIds: Set<string> | null = null
      if (packageIdQuery) {
        const subRows = await supabase.select(
          'subscriptions',
          `select=sim_id&package_id=eq.${encodeURIComponent(packageIdQuery)}&state=in.(ACTIVE,PENDING)`
        )
        packageSimIds = new Set(
          (Array.isArray(subRows) ? subRows : [])
            .map((r: any) => String(r?.sim_id ?? '').trim())
            .filter(Boolean)
        )
        if (packageSimIds.size === 0) {
          return reply.send({ items: [], total: 0, page, pageSize })
        }
      }
      let enterpriseId = getEnterpriseIdFromReq(req)
      let resellerId: string | null = null
      if (roleScope === 'reseller') {
        const tokenReseller = (req as { cmpAuth?: { resellerId?: string | null } }).cmpAuth?.resellerId ?? null
        resellerId = resolveResellerIdForResellerQuery(reply, resellerIdQuery, tokenReseller)
        if (!resellerId) return
        if (enterpriseIdQuery) {
          enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdQuery)
          if (!enterpriseId) return
        }
      } else if (roleScope === 'platform') {
        if (enterpriseIdQuery) enterpriseId = enterpriseIdQuery
        if (resellerIdQuery) resellerId = resellerIdQuery
      }
      const idFilterMatch = await validateSimListIdFiltersMatch(supabase, {
        resellerId,
        enterpriseId,
        supplierId,
        operatorId,
      })
      if (!idFilterMatch.ok) {
        return sendError(reply, idFilterMatch.status, idFilterMatch.code, idFilterMatch.message)
      }
      let operatorFilter: { operatorIds: string[] } | null = null
      if (operatorId) {
        const resolved = await resolveOperatorFilter(supabase, operatorId, supplierId)
        if (!resolved) {
          return reply.send({ items: [], total: 0, page, pageSize })
        }
        operatorFilter = resolved
      }
      const departmentId = roleScope === 'department'
        ? getDepartmentIdFromReq(req)
        : await resolveDepartmentForEnterprise(req, reply, supabase, enterpriseId, departmentIdQuery)
      if (departmentIdQuery && roleScope !== 'department' && departmentIdQuery && !departmentId) return

      const includeResellerInventory = !enterpriseId && roleScope === 'reseller' && !!resellerId
      const hasSimResellerColumn = await detectSimResellerColumn(supabase)
      const hasSimImeiLockColumn = await detectSimImeiLockColumn(supabase)
      let resellerEnterpriseIds: string[] | null = null
      let resellerSupplierIds: string[] | null = null
      if (!enterpriseId && resellerId) {
        const resellerRows = await supabase.select(
          'tenants',
          `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE`
        )
        resellerEnterpriseIds = (Array.isArray(resellerRows) ? resellerRows : []).map((t: any) => String(t.tenant_id))
        if (!hasSimResellerColumn) {
          const resellerSupplierRows = await supabase.select(
            'reseller_suppliers',
            `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerId)}`
          )
          resellerSupplierIds = Array.from(new Set(
            (Array.isArray(resellerSupplierRows) ? resellerSupplierRows : [])
              .map((row: any) => (row?.supplier_id ? String(row.supplier_id) : ''))
              .filter(Boolean)
          ))
        }
      }

      const filters = []
      if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      if (!enterpriseId && resellerEnterpriseIds) {
        if (resellerId) {
          if (hasSimResellerColumn) {
            // Prefer denormalized sims.reseller_id (backfilled). Avoid OR + huge enterprise_id.in.(...)
            // which can break PostgREST / hit URL limits and surface as INTERNAL_ERROR.
            filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
          } else {
            const parts: string[] = []
            if (resellerEnterpriseIds.length) {
              parts.push(`enterprise_id.in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
            }
            if (resellerSupplierIds?.length) {
              parts.push(`supplier_id.in.(${resellerSupplierIds.map((id) => encodeURIComponent(id)).join(',')})`)
            } else if (includeResellerInventory && !resellerEnterpriseIds.length) {
              return reply.send({ items: [], total: 0, page, pageSize })
            }
            if (parts.length > 1) {
              filters.push(`or=(${parts.join(',')})`)
            } else if (parts.length === 1) {
              filters.push(parts[0])
            } else {
              return reply.send({ items: [], total: 0, page, pageSize })
            }
          }
        } else {
          filters.push(`enterprise_id=in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
        }
      }
      if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
      if (iccidRaw) appendIccidListFilter(filters, iccidRaw)
      if (imsiFilter) filters.push(`primary_imsi=eq.${encodeURIComponent(imsiFilter)}`)
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
      appendOperatorFilter(filters, operatorFilter)
      // T142: Filter by package-derived SIM IDs
      if (packageSimIds) {
        const simIdArr = Array.from(packageSimIds)
        filters.push(`sim_id=in.(${simIdArr.map((id) => encodeURIComponent(id)).join(',')})`)
      }
      const filterQs = filters.length ? `&${filters.join('&')}` : ''

      const simSelectFields = [
        'sim_id', 'iccid', 'primary_imsi', 'status', 'apn', 'activation_date', 'bound_imei', 'activation_code',
        'supplier_id', 'operator_id',
        ...(hasSimResellerColumn ? ['reseller_id'] : []),
        ...(hasSimImeiLockColumn ? ['imei_lock_enabled'] : []),
        'enterprise_id', 'department_id', 'form_factor', 'upstream_status', 'upstream_status_updated_at', 'created_at',
        'suppliers(name)', 'operators(name)',
      ].join(',')
      const { data, total } = await supabase.selectWithCount(
        'sims',
        `select=${simSelectFields}&order=iccid.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )

      const rows = Array.isArray(data) ? data : []
      const businessOperatorMap = await loadBusinessOperatorMap(
        supabase,
        rows.map((r: any) => r.operator_id)
      )
      const supplierIds = Array.from(new Set(rows.map((r: any) => r.supplier_id).filter(Boolean).map((v: any) => String(v))))
      let supplierResellerMap = new Map<string, string>()
      if (supplierIds.length) {
        const supplierRows = await supabase.select(
          'reseller_suppliers',
          `select=supplier_id,reseller_id&supplier_id=in.(${supplierIds.map((id) => encodeURIComponent(id)).join(',')})`
        )
        supplierResellerMap = new Map(
          (Array.isArray(supplierRows) ? supplierRows : [])
            .filter((row: any) => row?.supplier_id && row?.reseller_id)
            .map((row: any) => [String(row.supplier_id), String(row.reseller_id)])
        )
      }
      const { tenantNameMap, tenantParentMap, resellerNameMap } = await loadSimTenantAndResellerMaps(
        supabase,
        rows,
        hasSimResellerColumn,
        supplierResellerMap
      )

      const includeReseller = roleScope === 'platform' || roleScope === 'reseller'
      const items = rows.map((r: any) => {
        const resolvedResellerId = includeReseller
          ? resolveSimResellerId(r, hasSimResellerColumn, tenantParentMap, supplierResellerMap)
          : null
        const businessOperator = r.operator_id ? businessOperatorMap.get(String(r.operator_id)) : null
        return {
        simId: r.sim_id,
        iccid: r.iccid,
        imsi: r.primary_imsi,
        status: r.status,
        lifecycleSubStatus: null,
        upstreamStatus: r.upstream_status ?? null,
        upstreamStatusUpdatedAt: r.upstream_status_updated_at ?? null,
        formFactor: r.form_factor ?? null,
        activationCode: r.activation_code ?? null,
        supplierId: r.supplier_id,
        supplierName: r.suppliers?.name ?? null,
            operatorId: businessOperator?.operator_id ?? r.operator_id ?? null,
        operatorName: businessOperator?.name ?? r.operators?.name ?? null,
        mcc: businessOperator?.mcc ?? null,
        mnc: businessOperator?.mnc ?? null,
        ...(includeReseller
          ? {
              resellerId: resolvedResellerId,
              resellerName: resolvedResellerId ? resellerNameMap.get(resolvedResellerId) ?? null : null,
            }
          : {}),
        enterpriseId: r.enterprise_id ?? null,
        enterpriseName: r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? null : null,
        departmentId: r.department_id ?? null,
        departmentName: r.department_id ? tenantNameMap.get(String(r.department_id)) ?? null : null,
        apn: r.apn,
        activationDate: toIsoDateTime(r.activation_date),
        totalUsageBytes: null,
        imei: r.bound_imei ?? null,
        imeiLockEnabled: hasSimImeiLockColumn
          ? Boolean(r.imei_lock_enabled)
          : Boolean(r.bound_imei),
        imeiLocked: hasSimImeiLockColumn
          ? Boolean(r.imei_lock_enabled)
          : Boolean(r.bound_imei),
        }
      })

      {
        const filterPairs = []
        if (iccidRaw) filterPairs.push(`iccid=${iccidRaw}`)
        if (imsiFilter) filterPairs.push(`imsi=${imsiFilter}`)
        if (status) filterPairs.push(`status=${status}`)
        if (supplierId) filterPairs.push(`supplierId=${supplierId}`)
        if (operatorId) filterPairs.push(`operatorId=${operatorId}`)
        if (resellerId) filterPairs.push(`resellerId=${resellerId}`)
        if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
        if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
        if (packageIdQuery) filterPairs.push(`packageId=${packageIdQuery}`)
        filterPairs.push(`pageSize=${pageSize}`)
        filterPairs.push(`page=${page}`)
        reply.header('X-Filters', filterPairs.join(';'))
      }
      reply.send({
        items,
        total: typeof total === 'number' ? total : items.length,
        page,
        pageSize,
      })
    }
  )

  app.get(
    `${prefix}/enterprises/:enterpriseId/sims`,
    { preHandler: rbac(['sims.list']) },
    async (req, reply) => {
      if (!ensureSimReadAccess(req, reply)) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const roleScope = getRoleScope(req)
      const query = req.query as Record<string, unknown>
      const pathEnterpriseId = String((req.params as Record<string, unknown>).enterpriseId ?? '').trim()
      const enterpriseId = await resolveEnterpriseIdForEnterpriseSimList(req, reply, supabase, pathEnterpriseId)
      if (!enterpriseId) return

      const departmentIdQuery = query.departmentId ? String(query.departmentId).trim() : null
      const iccidRaw = query.iccid ? normalizeIccid(query.iccid) : null
      const imsiFilter = query.imsi ? String(query.imsi).trim() : null
      const status = query.status ? String(query.status).trim() : null
      const mccFilter = query.mcc ? String(query.mcc).trim() : null
      const mncFilter = query.mnc ? String(query.mnc).trim() : null
      const page = query.page ? Number(query.page) : 1
      const pageSizeRaw = query.pageSize !== undefined && query.pageSize !== null ? Number(query.pageSize) : 20
      const pageSize = Math.min(100, Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 20))
      const offset = Math.max(0, (Math.max(1, page) - 1) * pageSize)

      if (iccidRaw && !/^\d{1,20}$/.test(iccidRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
      }
      if (departmentIdQuery && !isValidUuid(departmentIdQuery)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'departmentId must be a valid uuid.')
      }

      const departmentId =
        roleScope === 'department'
          ? getDepartmentIdFromReq(req)
          : await resolveDepartmentForEnterprise(req, reply, supabase, enterpriseId, departmentIdQuery)
      if (departmentIdQuery && roleScope !== 'department' && !departmentId) return

      let mccMncOperatorFilter: { operatorIds: string[] } | null = null
      if (mccFilter || mncFilter) {
        mccMncOperatorFilter = await resolveOperatorIdsByMccMnc(supabase, mccFilter, mncFilter)
        if (mccMncOperatorFilter && mccMncOperatorFilter.operatorIds.length === 0) {
          return reply.send({ items: [], total: 0, page, pageSize })
        }
      }

      const hasSimImeiLockColumn = await detectSimImeiLockColumn(supabase)
      const filters: string[] = [`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`]
      if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
      if (iccidRaw) appendIccidListFilter(filters, iccidRaw)
      if (imsiFilter) filters.push(`primary_imsi=eq.${encodeURIComponent(imsiFilter)}`)
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
      appendOperatorFilter(filters, mccMncOperatorFilter)
      const filterQs = `&${filters.join('&')}`

      const simSelectFields = [
        'sim_id', 'iccid', 'primary_imsi', 'status', 'apn', 'activation_date', 'bound_imei', 'activation_code',
        'operator_id', 'enterprise_id', 'department_id', 'form_factor', 'created_at',
        ...(hasSimImeiLockColumn ? ['imei_lock_enabled'] : []),
      ].join(',')
      const { data, total } = await supabase.selectWithCount(
        'sims',
        `select=${simSelectFields}&order=iccid.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
      )

      const rows = Array.isArray(data) ? data : []
      const businessOperatorMap = await loadBusinessOperatorMap(
        supabase,
        rows.map((r: { operator_id?: string }) => r.operator_id)
      )
      const tenantIdSet = new Set<string>([enterpriseId])
      for (const r of rows) {
        const dept = (r as { department_id?: string }).department_id
        if (dept) tenantIdSet.add(String(dept))
      }
      const tenantRows = await supabase.select(
        'tenants',
        `select=tenant_id,name&tenant_id=in.(${Array.from(tenantIdSet).map((id) => encodeURIComponent(id)).join(',')})`
      )
      const tenantNameMap = new Map(
        (Array.isArray(tenantRows) ? tenantRows : [])
          .filter((t: { tenant_id?: string }) => t?.tenant_id)
          .map((t: { tenant_id: string; name?: string }) => [String(t.tenant_id), t.name ?? null])
      )

      const items = rows.map((r: Record<string, unknown>) => {
        const businessOperator = r.operator_id ? businessOperatorMap.get(String(r.operator_id)) : null
        return {
          simId: r.sim_id,
          iccid: r.iccid,
          imsi: r.primary_imsi,
          status: r.status,
          lifecycleSubStatus: null,
          formFactor: r.form_factor ?? null,
          activationCode: r.activation_code ?? null,
          mcc: businessOperator?.mcc ?? null,
          mnc: businessOperator?.mnc ?? null,
          enterpriseId: r.enterprise_id ?? null,
          enterpriseName: r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? null : null,
          departmentId: r.department_id ?? null,
          departmentName: r.department_id ? tenantNameMap.get(String(r.department_id)) ?? null : null,
          apn: r.apn,
          activationDate: toIsoDateTime(r.activation_date),
          totalUsageBytes: null,
          imei: r.bound_imei ?? null,
          imeiLockEnabled: hasSimImeiLockColumn ? Boolean(r.imei_lock_enabled) : Boolean(r.bound_imei),
          imeiLocked: hasSimImeiLockColumn ? Boolean(r.imei_lock_enabled) : Boolean(r.bound_imei),
        }
      })

      const filterPairs: string[] = [`enterpriseId=${enterpriseId}`]
      if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
      if (iccidRaw) filterPairs.push(`iccid=${iccidRaw}`)
      if (imsiFilter) filterPairs.push(`imsi=${imsiFilter}`)
      if (status) filterPairs.push(`status=${status}`)
      if (mccFilter) filterPairs.push(`mcc=${mccFilter}`)
      if (mncFilter) filterPairs.push(`mnc=${mncFilter}`)
      filterPairs.push(`page=${page}`)
      filterPairs.push(`pageSize=${pageSize}`)
      reply.header('X-Filters', filterPairs.join(';'))

      reply.send({
        items,
        total: typeof total === 'number' ? total : items.length,
        page,
        pageSize,
      })
    }
  )

  const channelSimCsvHeaders = () => [
    'simId',
    'iccid',
    'imsi',
    'msisdn',
    'status',
    'lifecycleSubStatus',
    'upstreamStatus',
    'upstreamStatusUpdatedAt',
    'formFactor',
    'activationCode',
    'supplierId',
    'supplierName',
    'operatorId',
    'operatorName',
    'mcc',
    'mnc',
    'apn',
    'resellerId',
    'resellerName',
    'enterpriseId',
    'enterpriseName',
    'departmentId',
    'departmentName',
    'activationDate',
    'totalUsageBytes',
    'imeiLockEnabled',
    'imei',
    'remark',
  ]

  const enterpriseSimCsvHeaders = () => [
    'simId',
    'iccid',
    'imsi',
    'status',
    'lifecycleSubStatus',
    'formFactor',
    'activationCode',
    'mcc',
    'mnc',
    'apn',
    'enterpriseId',
    'enterpriseName',
    'departmentId',
    'departmentName',
    'activationDate',
    'totalUsageBytes',
    'imeiLockEnabled',
    'imei',
  ]

  const sendChannelSimCsvHeadersOnly = (reply: FastifyReply, filterPairs: string[]) => {
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="sims.csv"')
    setXFilters(reply, filterPairs.join(';'))
    reply.send(`${channelSimCsvHeaders().map(escapeCsv).join(',')}\n`)
  }

  const sendEnterpriseSimCsvHeadersOnly = (reply: FastifyReply, filterPairs: string[]) => {
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="enterprise-sims.csv"')
    setXFilters(reply, filterPairs.join(';'))
    reply.send(`${enterpriseSimCsvHeaders().map(escapeCsv).join(',')}\n`)
  }

  const ensureEnterpriseSimExportAccess = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ensureSimReadAccess(req, reply)) return null
    const auth = getAuthContext(req)
    const roleScope = auth.roleScope ? String(auth.roleScope) : null
    const role = auth.role ? String(auth.role) : null
    if (roleScope === 'platform' || role === 'platform_admin') {
      return auth
    }
    if ((await checkPermissions(auth, ['sims.export'])) || (await checkPermissions(auth, ['sims.list']))) {
      return auth
    }
    sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  const handleChannelSimCsvExport = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ensureChannelSimListAccess(req, reply)) return

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
    const roleScope = getRoleScope(req)
    const query = req.query as Record<string, unknown>
    const iccidRaw = query.iccid ? normalizeIccid(query.iccid) : null
    const imsiFilter = query.imsi ? String(query.imsi).trim() : null
    const status = query.status ? String(query.status) : null
    const supplierId = query.supplierId ? String(query.supplierId).trim() : null
    const operatorId = query.operatorId ? String(query.operatorId).trim() : null
    const qSimsReseller = simsListResellerScopeFromQuery(query)
    const resellerIdQuery = qSimsReseller.effective
    const enterpriseIdQuery = query.enterpriseId ? String(query.enterpriseId) : null
    const departmentIdQuery = query.departmentId ? String(query.departmentId) : null
    const packageIdQuery = query.packageId ? String(query.packageId).trim() : null
    const page = query.page ? Number(query.page) : 1
    const pageSizeRaw = query.pageSize !== undefined && query.pageSize !== null ? Number(query.pageSize) : 1000
    const pageSize = Math.min(1000, Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 1000))
    const offset = Math.max(0, (Math.max(1, page) - 1) * pageSize)

    if (iccidRaw && !/^\d{1,20}$/.test(iccidRaw)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
    }
    if (supplierId && !isValidUuid(supplierId)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    if (qSimsReseller.resellerQueryRaw && !isValidUuid(qSimsReseller.resellerQueryRaw)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    if (packageIdQuery && !isValidUuid(packageIdQuery)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'packageId must be a valid uuid.')
    }
    if (packageIdQuery && (roleScope === 'platform' || roleScope === 'reseller') && !enterpriseIdQuery) {
      return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required when filtering by packageId.')
    }

    let packageSimIds: Set<string> | null = null
    if (packageIdQuery) {
      const subRows = await supabase.select(
        'subscriptions',
        `select=sim_id&package_id=eq.${encodeURIComponent(packageIdQuery)}&state=in.(ACTIVE,PENDING)`
      )
      packageSimIds = new Set(
        (Array.isArray(subRows) ? subRows : [])
          .map((r: { sim_id?: string }) => String(r?.sim_id ?? '').trim())
          .filter(Boolean)
      )
      if (packageSimIds.size === 0) {
        const emptyPairs = [
          ...(iccidRaw ? [`iccid=${iccidRaw}`] : []),
          ...(imsiFilter ? [`imsi=${imsiFilter}`] : []),
          ...(status ? [`status=${status}`] : []),
          ...(supplierId ? [`supplierId=${supplierId}`] : []),
          ...(operatorId ? [`operatorId=${operatorId}`] : []),
          ...(resellerIdQuery ? [`resellerId=${resellerIdQuery}`] : []),
          ...(packageIdQuery ? [`packageId=${packageIdQuery}`] : []),
          `page=${page}`,
          `pageSize=${pageSize}`,
        ]
        return sendChannelSimCsvHeadersOnly(reply, emptyPairs)
      }
    }

    let enterpriseId = getEnterpriseIdFromReq(req)
    let resellerId: string | null = null
    if (roleScope === 'reseller') {
      const tokenReseller = (req as { cmpAuth?: { resellerId?: string | null } }).cmpAuth?.resellerId ?? null
      resellerId = resolveResellerIdForResellerQuery(reply, resellerIdQuery, tokenReseller)
      if (!resellerId) return
      if (enterpriseIdQuery) {
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdQuery)
        if (!enterpriseId) return
      }
    } else if (roleScope === 'platform') {
      if (enterpriseIdQuery) enterpriseId = enterpriseIdQuery
      if (resellerIdQuery) resellerId = resellerIdQuery
    }

    const idFilterMatch = await validateSimListIdFiltersMatch(supabase, {
      resellerId,
      enterpriseId,
      supplierId,
      operatorId,
    })
    if (!idFilterMatch.ok) {
      return sendError(reply, idFilterMatch.status, idFilterMatch.code, idFilterMatch.message)
    }

    let operatorFilter: { operatorIds: string[] } | null = null
    if (operatorId) {
      const resolved = await resolveOperatorFilter(supabase, operatorId, supplierId)
      if (!resolved) {
        const emptyPairs = [
          ...(iccidRaw ? [`iccid=${iccidRaw}`] : []),
          ...(imsiFilter ? [`imsi=${imsiFilter}`] : []),
          ...(status ? [`status=${status}`] : []),
          ...(supplierId ? [`supplierId=${supplierId}`] : []),
          `operatorId=${operatorId}`,
          ...(resellerIdQuery ? [`resellerId=${resellerIdQuery}`] : []),
          `page=${page}`,
          `pageSize=${pageSize}`,
        ]
        return sendChannelSimCsvHeadersOnly(reply, emptyPairs)
      }
      operatorFilter = resolved
    }

    const departmentId =
      roleScope === 'department'
        ? getDepartmentIdFromReq(req)
        : await resolveDepartmentForEnterprise(req, reply, supabase, enterpriseId, departmentIdQuery)
    if (departmentIdQuery && roleScope !== 'department' && departmentIdQuery && !departmentId) return

    const buildFilterPairs = () => {
      const filterPairs: string[] = []
      if (iccidRaw) filterPairs.push(`iccid=${iccidRaw}`)
      if (imsiFilter) filterPairs.push(`imsi=${imsiFilter}`)
      if (status) filterPairs.push(`status=${status}`)
      if (supplierId) filterPairs.push(`supplierId=${supplierId}`)
      if (operatorId) filterPairs.push(`operatorId=${operatorId}`)
      if (resellerId) filterPairs.push(`resellerId=${resellerId}`)
      if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
      if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
      if (packageIdQuery) filterPairs.push(`packageId=${packageIdQuery}`)
      filterPairs.push(`page=${page}`)
      filterPairs.push(`pageSize=${pageSize}`)
      return filterPairs
    }

    const includeResellerInventory = !enterpriseId && roleScope === 'reseller' && !!resellerId
    const hasSimResellerColumn = await detectSimResellerColumn(supabase)
    const hasSimImeiLockColumn = await detectSimImeiLockColumn(supabase)
    let resellerEnterpriseIds: string[] | null = null
    let resellerSupplierIds: string[] | null = null
    if (!enterpriseId && resellerId) {
      const resellerRows = await supabase.select(
        'tenants',
        `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE`
      )
      resellerEnterpriseIds = (Array.isArray(resellerRows) ? resellerRows : []).map((t: { tenant_id: string }) =>
        String(t.tenant_id)
      )
      if (!hasSimResellerColumn) {
        const resellerSupplierRows = await supabase.select(
          'reseller_suppliers',
          `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerId)}`
        )
        resellerSupplierIds = Array.from(
          new Set(
            (Array.isArray(resellerSupplierRows) ? resellerSupplierRows : [])
              .map((row: { supplier_id?: string }) => (row?.supplier_id ? String(row.supplier_id) : ''))
              .filter(Boolean)
          )
        )
      }
    }

    const filters: string[] = []
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (!enterpriseId && resellerEnterpriseIds) {
      if (resellerId) {
        if (hasSimResellerColumn) {
          // Prefer denormalized sims.reseller_id; avoid OR + huge enterprise_id.in.(...) URL failures.
          filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
        } else {
          const parts: string[] = []
          if (resellerEnterpriseIds.length) {
            parts.push(`enterprise_id.in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
          }
          if (resellerSupplierIds?.length) {
            parts.push(`supplier_id.in.(${resellerSupplierIds.map((id) => encodeURIComponent(id)).join(',')})`)
          } else if (includeResellerInventory && !resellerEnterpriseIds.length) {
            return sendChannelSimCsvHeadersOnly(reply, buildFilterPairs())
          }
          if (parts.length > 1) {
            filters.push(`or=(${parts.join(',')})`)
          } else if (parts.length === 1) {
            filters.push(parts[0])
          } else {
            return sendChannelSimCsvHeadersOnly(reply, buildFilterPairs())
          }
        }
      } else {
        filters.push(`enterprise_id=in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
      }
    }
    if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
    if (iccidRaw) appendIccidListFilter(filters, iccidRaw)
    if (imsiFilter) filters.push(`primary_imsi=eq.${encodeURIComponent(imsiFilter)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
    appendOperatorFilter(filters, operatorFilter)
    if (packageSimIds) {
      const simIdArr = Array.from(packageSimIds)
      filters.push(`sim_id=in.(${simIdArr.map((id) => encodeURIComponent(id)).join(',')})`)
    }
    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const simSelectFields = [
      'sim_id', 'iccid', 'primary_imsi', 'msisdn', 'status', 'lifecycle_sub_status', 'apn', 'activation_date', 'bound_imei', 'activation_code',
      'supplier_id', 'operator_id',
      ...(hasSimResellerColumn ? ['reseller_id'] : []),
      ...(hasSimImeiLockColumn ? ['imei_lock_enabled'] : []),
      'enterprise_id', 'department_id', 'form_factor', 'upstream_status', 'upstream_status_updated_at', 'remark', 'created_at',
      'suppliers(name)', 'operators(name)',
    ].join(',')
    const { data } = await supabase.selectWithCount(
      'sims',
      `select=${simSelectFields}&order=iccid.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const businessOperatorMap = await loadBusinessOperatorMap(
      supabase,
      rows.map((r: any) => r.operator_id)
    )

    const supplierIds = Array.from(
      new Set(rows.map((r: any) => r.supplier_id).filter(Boolean).map((v: any) => String(v)))
    )
    let supplierResellerMap = new Map<string, string>()
    if (supplierIds.length) {
      const supplierRows = await supabase.select(
        'reseller_suppliers',
        `select=supplier_id,reseller_id&supplier_id=in.(${supplierIds.map((id) => encodeURIComponent(id)).join(',')})`
      )
      supplierResellerMap = new Map(
        (Array.isArray(supplierRows) ? supplierRows : [])
          .filter((row: any) => row?.supplier_id && row?.reseller_id)
          .map((row: any) => [String(row.supplier_id), String(row.reseller_id)])
      )
    }
    const { tenantNameMap, tenantParentMap, resellerNameMap } = await loadSimTenantAndResellerMaps(
      supabase,
      rows,
      hasSimResellerColumn,
      supplierResellerMap
    )

    const csvRows = [channelSimCsvHeaders().map(escapeCsv).join(',')]
    for (const r of rows) {
      const resolvedResellerId = resolveSimResellerId(
        r,
        hasSimResellerColumn,
        tenantParentMap,
        supplierResellerMap
      )
      const operator = r.operator_id ? businessOperatorMap.get(String(r.operator_id)) : null
      csvRows.push(
        [
          escapeCsv(r.sim_id ?? ''),
          escapeCsv(r.iccid ?? ''),
          escapeCsv(r.primary_imsi ?? ''),
          escapeCsv(r.msisdn ?? ''),
          escapeCsv(r.status ?? ''),
          escapeCsv(r.lifecycle_sub_status || 'normal'),
          escapeCsv(r.upstream_status ?? ''),
          escapeCsv(toIsoDateTime(r.upstream_status_updated_at) ?? ''),
          escapeCsv(r.form_factor ?? ''),
          escapeCsv(r.activation_code ?? ''),
          escapeCsv(r.supplier_id ?? ''),
          escapeCsv(r.suppliers?.name ?? ''),
          escapeCsv(operator?.operator_id ?? r.operator_id ?? ''),
          escapeCsv(operator?.name ?? r.operators?.name ?? ''),
          escapeCsv(operator?.mcc ?? ''),
          escapeCsv(operator?.mnc ?? ''),
          escapeCsv(r.apn ?? ''),
          escapeCsv(resolvedResellerId ?? ''),
          escapeCsv(resolvedResellerId ? resellerNameMap.get(resolvedResellerId) ?? '' : ''),
          escapeCsv(r.enterprise_id ?? ''),
          escapeCsv(r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? '' : ''),
          escapeCsv(r.department_id ?? ''),
          escapeCsv(r.department_id ? tenantNameMap.get(String(r.department_id)) ?? '' : ''),
          escapeCsv(toIsoDateTime(r.activation_date) ?? ''),
          escapeCsv(''),
          escapeCsv(
            hasSimImeiLockColumn ? String(Boolean(r.imei_lock_enabled)) : String(Boolean(r.bound_imei))
          ),
          escapeCsv(r.bound_imei ?? ''),
          escapeCsv(r.remark ?? ''),
        ].join(',')
      )
    }

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="sims.csv"')
    setXFilters(reply, buildFilterPairs().join(';'))
    reply.send(`${csvRows.join('\n')}\n`)
  }

  const handleEnterpriseSimCsvExport = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await ensureEnterpriseSimExportAccess(req, reply))) return

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
    const roleScope = getRoleScope(req)
    const query = req.query as Record<string, unknown>
    const pathEnterpriseId = String((req.params as Record<string, unknown>).enterpriseId ?? '').trim()
    const enterpriseId = await resolveEnterpriseIdForEnterpriseSimList(req, reply, supabase, pathEnterpriseId)
    if (!enterpriseId) return

    const departmentIdQuery = query.departmentId ? String(query.departmentId).trim() : null
    const iccidRaw = query.iccid ? normalizeIccid(query.iccid) : null
    const imsiFilter = query.imsi ? String(query.imsi).trim() : null
    const status = query.status ? String(query.status).trim() : null
    const mccFilter = query.mcc ? String(query.mcc).trim() : null
    const mncFilter = query.mnc ? String(query.mnc).trim() : null
    const page = query.page ? Number(query.page) : 1
    const pageSizeRaw = query.pageSize !== undefined && query.pageSize !== null ? Number(query.pageSize) : 1000
    const pageSize = Math.min(1000, Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 1000))
    const offset = Math.max(0, (Math.max(1, page) - 1) * pageSize)

    if (iccidRaw && !/^\d{1,20}$/.test(iccidRaw)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
    }
    if (departmentIdQuery && !isValidUuid(departmentIdQuery)) {
      return sendError(reply, 400, 'BAD_REQUEST', 'departmentId must be a valid uuid.')
    }

    const departmentId =
      roleScope === 'department'
        ? getDepartmentIdFromReq(req)
        : await resolveDepartmentForEnterprise(req, reply, supabase, enterpriseId, departmentIdQuery)
    if (departmentIdQuery && roleScope !== 'department' && !departmentId) return

    let mccMncOperatorFilter: { operatorIds: string[] } | null = null
    if (mccFilter || mncFilter) {
      mccMncOperatorFilter = await resolveOperatorIdsByMccMnc(supabase, mccFilter, mncFilter)
      if (mccMncOperatorFilter && mccMncOperatorFilter.operatorIds.length === 0) {
        const filterPairs = [`enterpriseId=${enterpriseId}`]
        if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
        if (iccidRaw) filterPairs.push(`iccid=${iccidRaw}`)
        if (imsiFilter) filterPairs.push(`imsi=${imsiFilter}`)
        if (status) filterPairs.push(`status=${status}`)
        if (mccFilter) filterPairs.push(`mcc=${mccFilter}`)
        if (mncFilter) filterPairs.push(`mnc=${mncFilter}`)
        filterPairs.push(`page=${page}`, `pageSize=${pageSize}`)
        return sendEnterpriseSimCsvHeadersOnly(reply, filterPairs)
      }
    }

    const hasSimImeiLockColumn = await detectSimImeiLockColumn(supabase)
    const filters: string[] = [`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`]
    if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
    if (iccidRaw) appendIccidListFilter(filters, iccidRaw)
    if (imsiFilter) filters.push(`primary_imsi=eq.${encodeURIComponent(imsiFilter)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    appendOperatorFilter(filters, mccMncOperatorFilter)
    const filterQs = `&${filters.join('&')}`

    const simSelectFields = [
      'sim_id', 'iccid', 'primary_imsi', 'status', 'lifecycle_sub_status', 'apn', 'activation_date', 'bound_imei',
      'activation_code', 'operator_id', 'enterprise_id', 'department_id', 'form_factor', 'created_at',
      ...(hasSimImeiLockColumn ? ['imei_lock_enabled'] : []),
    ].join(',')
    const { data } = await supabase.selectWithCount(
      'sims',
      `select=${simSelectFields}&order=iccid.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const businessOperatorMap = await loadBusinessOperatorMap(
      supabase,
      rows.map((r: { operator_id?: string }) => r.operator_id)
    )
    const tenantIdSet = new Set<string>([enterpriseId])
    for (const r of rows) {
      const dept = (r as { department_id?: string }).department_id
      if (dept) tenantIdSet.add(String(dept))
    }
    const tenantRows = await supabase.select(
      'tenants',
      `select=tenant_id,name&tenant_id=in.(${Array.from(tenantIdSet).map((id) => encodeURIComponent(id)).join(',')})`
    )
    const tenantNameMap = new Map(
      (Array.isArray(tenantRows) ? tenantRows : [])
        .filter((t: { tenant_id?: string }) => t?.tenant_id)
        .map((t: { tenant_id: string; name?: string }) => [String(t.tenant_id), t.name ?? null])
    )

    const csvRows = [enterpriseSimCsvHeaders().map(escapeCsv).join(',')]
    for (const r of rows) {
      const businessOperator = r.operator_id ? businessOperatorMap.get(String(r.operator_id)) : null
      csvRows.push(
        [
          escapeCsv(r.sim_id ?? ''),
          escapeCsv(r.iccid ?? ''),
          escapeCsv(r.primary_imsi ?? ''),
          escapeCsv(r.status ?? ''),
          escapeCsv(r.lifecycle_sub_status || 'normal'),
          escapeCsv(r.form_factor ?? ''),
          escapeCsv(r.activation_code ?? ''),
          escapeCsv(businessOperator?.mcc ?? ''),
          escapeCsv(businessOperator?.mnc ?? ''),
          escapeCsv(r.apn ?? ''),
          escapeCsv(r.enterprise_id ?? ''),
          escapeCsv(r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? '' : ''),
          escapeCsv(r.department_id ?? ''),
          escapeCsv(r.department_id ? tenantNameMap.get(String(r.department_id)) ?? '' : ''),
          escapeCsv(toIsoDateTime(r.activation_date) ?? ''),
          escapeCsv(''),
          escapeCsv(hasSimImeiLockColumn ? String(Boolean(r.imei_lock_enabled)) : String(Boolean(r.bound_imei))),
          escapeCsv(r.bound_imei ?? ''),
        ].join(',')
      )
    }

    const filterPairs: string[] = [`enterpriseId=${enterpriseId}`]
    if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
    if (iccidRaw) filterPairs.push(`iccid=${iccidRaw}`)
    if (imsiFilter) filterPairs.push(`imsi=${imsiFilter}`)
    if (status) filterPairs.push(`status=${status}`)
    if (mccFilter) filterPairs.push(`mcc=${mccFilter}`)
    if (mncFilter) filterPairs.push(`mnc=${mncFilter}`)
    filterPairs.push(`page=${page}`, `pageSize=${pageSize}`)

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="enterprise-sims.csv"')
    setXFilters(reply, filterPairs.join(';'))
    reply.send(`${csvRows.join('\n')}\n`)
  }

  app.get(
    `${prefix}/sims:csv`,
    { preHandler: rbac(['sims.export']) },
    handleChannelSimCsvExport
  )

  app.get(
    `${prefix}/enterprises/:enterpriseId/sims:csv`,
    { preHandler: rbac(['sims.list']) },
    handleEnterpriseSimCsvExport
  )

  const simUsageCsvHeaders = [
    'usagePackageSummaryId',
    'supplierId',
    'resellerId',
    'enterpriseId',
    'simId',
    'iccid',
    'usageDay',
    'periodStart',
    'periodEnd',
    'visitedMccMnc',
    'subscriptionId',
    'packageId',
    'pricePlanId',
    'pricePlanType',
    'inProfileMb',
    'outOfProfileMb',
    'unclassifiedMb',
    'uplinkMb',
    'downlinkMb',
    'totalMb',
    'amount',
    'currency',
    'calculationId',
    'ratedAt',
  ]

  const simUsageItemsToCsv = (items: Array<Record<string, unknown>>) => {
    const lines = [simUsageCsvHeaders.map(escapeCsv).join(',')]
    for (const item of items) {
      lines.push(simUsageCsvHeaders.map((header) => escapeCsv(item[header])).join(','))
    }
    return `${lines.join('\n')}\n`
  }

  const parseBillingPeriod = (value: unknown) => {
    const raw = value === undefined || value === null || String(value).trim() === ''
      ? new Date().toISOString().slice(0, 7)
      : String(value).trim()
    const match = raw.match(/^(\d{4})-(\d{2})$/)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null
    const startDay = new Date(Date.UTC(year, month - 1, 1))
    const nextMonth = new Date(Date.UTC(year, month, 1))
    const endDay = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000)
    return {
      period: raw,
      startDay: startDay.toISOString().slice(0, 10),
      endDay: endDay.toISOString().slice(0, 10),
    }
  }

  const toFiniteNumber = (value: unknown, fallback = 0) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  const sumInProfileMb = (rows: Array<Record<string, unknown>>) =>
    rows.reduce((sum, row) => sum + toFiniteNumber(row.in_profile_mb), 0)

  const loadPricePlanExtension = async (supabase: SupabaseClient, pricePlanId: string, pricePlanType: string) => {
    const query = `select=*&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
    if (pricePlanType === 'ONE_TIME') {
      const rows = await supabase.select('price_plan_one_time', query)
      return Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
    }
    if (pricePlanType === 'SIM_DEPENDENT_BUNDLE') {
      const rows = await supabase.select('price_plan_sim_dependent_bundle', query)
      return Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
    }
    if (pricePlanType === 'FIXED_BUNDLE') {
      const rows = await supabase.select('price_plan_fixed_bundle', query)
      return Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
    }
    if (pricePlanType === 'TIERED_PRICING' || pricePlanType === 'TIERED_VOLUME_PRICING') {
      const rows = await supabase.select('price_plan_tiered_volume_pricing', query)
      return Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
    }
    return undefined
  }

  const resolveSimForRead = async (
    req: FastifyRequest,
    reply: FastifyReply,
    supabase: SupabaseClient,
    iccid: string,
    enterpriseIdFilter: string | null,
    auth: AuthResult,
  ) => {
    const hasSimResellerColumn = await detectSimResellerColumn(supabase)
    const simSelectFields = [
      'sim_id',
      'iccid',
      'supplier_id',
      'operator_id',
      'enterprise_id',
      'department_id',
      ...(hasSimResellerColumn ? ['reseller_id'] : []),
    ].join(',')
    const simRows = await supabase.select(
      'sims',
      `select=${simSelectFields}&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(simRows) ? (simRows[0] as Record<string, unknown> | undefined) : undefined
    if (!sim?.sim_id) {
      sendError(reply, 404, 'NOT_FOUND', 'SIM not found.')
      return null
    }
    const validCustomerEnterpriseId = await validateUsageEnterpriseIdForCustomerScope(
      req,
      reply,
      supabase,
      enterpriseIdFilter,
    )
    if (!validCustomerEnterpriseId) return null
    const canRead = await assertSimLifecycleAccess(
      req,
      reply,
      supabase,
      sim,
      auth,
      hasSimResellerColumn,
      enterpriseIdFilter,
    )
    return canRead ? sim : null
  }

  const resolveSimQuotaBalance = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = ensureSimReadAccess(req, reply)
    if (!auth) return null
    const rawIccid = (req.params as Record<string, unknown>).iccid
    const iccid = normalizeIccid(rawIccid)
    if (!iccid || !isValidIccid(iccid)) {
      sendError(reply, 400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
      return null
    }
    const query = (req.query ?? {}) as Record<string, unknown>
    const period = parseBillingPeriod(query.period)
    if (!period) {
      sendError(reply, 400, 'BAD_REQUEST', 'period must be YYYY-MM.')
      return null
    }
    const enterpriseIdFilter = query.enterpriseId ? String(query.enterpriseId).trim() : null
    if (enterpriseIdFilter && !isValidUuid(enterpriseIdFilter)) {
      sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return null
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
    const sim = await resolveSimForRead(req, reply, supabase, iccid, enterpriseIdFilter, auth)
    if (!sim) return null
    const usageRows = await supabase.select(
      'usage_package_daily_summary',
      [
        'select=subscription_id,package_id,price_plan_id,price_plan_type,in_profile_mb,out_of_profile_mb,total_mb,usage_day',
        `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
        `usage_day=gte.${encodeURIComponent(period.startDay)}`,
        `usage_day=lte.${encodeURIComponent(period.endDay)}`,
        'limit=10000',
      ].join('&')
    )
    const simUsageRows = Array.isArray(usageRows) ? usageRows as Array<Record<string, unknown>> : []
    type QuotaGroup = {
      subscriptionId: string | null
      packageId: string
      pricePlanId: string | null
      pricePlanType: string | null
      rows: Array<Record<string, unknown>>
    }
    const grouped = new Map<string, QuotaGroup>()
    for (const row of simUsageRows) {
      const packageId = row.package_id ? String(row.package_id) : ''
      if (!packageId) continue
      const key = [
        row.subscription_id ?? '',
        packageId,
        row.price_plan_id ?? '',
        row.price_plan_type ?? '',
      ].map((value) => String(value ?? '')).join('|')
      const existing = grouped.get(key)
      if (existing) {
        existing.rows.push(row)
      } else {
        grouped.set(key, {
          subscriptionId: row.subscription_id ? String(row.subscription_id) : null,
          packageId,
          pricePlanId: row.price_plan_id ? String(row.price_plan_id) : null,
          pricePlanType: row.price_plan_type ? String(row.price_plan_type).trim().toUpperCase() : null,
          rows: [row],
        })
      }
    }
    const subscriptionRows = await supabase.select(
      'subscriptions',
      `select=subscription_id,package_id,state,effective_at,expires_at&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=in.(ACTIVE,PENDING)&limit=1000`
    )
    const subscriptions = Array.isArray(subscriptionRows) ? subscriptionRows as Array<Record<string, unknown>> : []
    for (const sub of subscriptions) {
      const subPackageId = sub.package_id ? String(sub.package_id) : ''
      if (!subPackageId) continue
      const subSubscriptionId = sub.subscription_id ? String(sub.subscription_id) : null
      const exists = [...grouped.values()].some((group) =>
        group.subscriptionId === subSubscriptionId && group.packageId === subPackageId
      )
      if (!exists) {
        grouped.set(`${subSubscriptionId ?? ''}|${subPackageId}||`, {
          subscriptionId: subSubscriptionId,
          packageId: subPackageId,
          pricePlanId: null,
          pricePlanType: null,
          rows: [],
        })
      }
    }
    const items: Array<Record<string, unknown>> = []
    for (const group of grouped.values()) {
      const { subscriptionId, packageId } = group
      const packageRows = await supabase.select(
        'packages',
        `select=package_id,name,price_plan_id&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
      )
      const packageRow = Array.isArray(packageRows) ? packageRows[0] as Record<string, unknown> | undefined : undefined
      const pricePlanId = group.pricePlanId ?? (packageRow?.price_plan_id ? String(packageRow.price_plan_id) : null)
      if (!pricePlanId) continue
      let pricePlanType = group.pricePlanType
      if (!pricePlanType) {
        const pricePlanRows = await supabase.select(
          'price_plans',
          `select=price_plan_id,type&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
        )
        const pricePlanRow = Array.isArray(pricePlanRows) ? pricePlanRows[0] as Record<string, unknown> | undefined : undefined
        pricePlanType = pricePlanRow?.type ? String(pricePlanRow.type).trim().toUpperCase() : null
      }
      if (!pricePlanType) continue
      const planExt = await loadPricePlanExtension(supabase, pricePlanId, pricePlanType)
      const packageUsageRows = await supabase.select(
        'usage_package_daily_summary',
        [
          'select=sim_id,in_profile_mb',
          `package_id=eq.${encodeURIComponent(packageId)}`,
          `usage_day=gte.${encodeURIComponent(period.startDay)}`,
          `usage_day=lte.${encodeURIComponent(period.endDay)}`,
          'limit=10000',
        ].join('&')
      )
      const packageRowsForUsage = Array.isArray(packageUsageRows) ? packageUsageRows as Array<Record<string, unknown>> : []
      const usedByThisSimMb = sumInProfileMb(group.rows)
      const usedByPackageMb = sumInProfileMb(packageRowsForUsage)
      const base = {
        subscriptionId,
        packageId,
        packageName: packageRow?.name ?? null,
        pricePlanId,
        pricePlanType,
        usedByThisSimMb,
        usedByPackageMb,
      }
      if (pricePlanType === 'ONE_TIME') {
        const quotaMb = toFiniteNumber(planExt?.quota_mb)
        const remainingMb = Math.max(quotaMb - usedByThisSimMb, 0)
        items.push({
          ...base,
          quotaScope: 'SIM_DEDICATED',
          quotaMb,
          remainingMb,
          usagePercent: quotaMb > 0 ? (usedByThisSimMb / quotaMb) * 100 : null,
        })
        continue
      }
      if (pricePlanType === 'SIM_DEPENDENT_BUNDLE') {
        const highWaterActiveSimCount = new Set(packageRowsForUsage.map((row) => row.sim_id).filter(Boolean).map(String)).size
        const perSimQuotaMb = toFiniteNumber(planExt?.per_sim_quota_mb)
        const quotaMb = highWaterActiveSimCount * perSimQuotaMb
        const remainingMb = Math.max(quotaMb - usedByPackageMb, 0)
        items.push({
          ...base,
          quotaScope: 'PACKAGE_SHARED',
          perSimQuotaMb,
          highWaterActiveSimCount,
          quotaMb,
          remainingMb,
          usagePercent: quotaMb > 0 ? (usedByPackageMb / quotaMb) * 100 : null,
        })
        continue
      }
      if (pricePlanType === 'FIXED_BUNDLE') {
        const quotaMb = toFiniteNumber(planExt?.total_quota_mb)
        const remainingMb = Math.max(quotaMb - usedByPackageMb, 0)
        items.push({
          ...base,
          quotaScope: 'PACKAGE_SHARED',
          quotaMb,
          remainingMb,
          usagePercent: quotaMb > 0 ? (usedByPackageMb / quotaMb) * 100 : null,
        })
        continue
      }
      const tiers = Array.isArray(planExt?.tiers) ? planExt?.tiers as Array<Record<string, unknown>> : []
      const sortedTiers = tiers
        .map((tier, index) => ({
          index,
          fromMb: toFiniteNumber(tier.fromMb ?? tier.from_mb),
          toMb: toFiniteNumber(tier.toMb ?? tier.to_mb),
          ratePerMb: toFiniteNumber(tier.ratePerMb ?? tier.rate_per_mb),
        }))
        .sort((a, b) => a.toMb - b.toMb)
      const currentTier = sortedTiers.find((tier) => usedByPackageMb <= tier.toMb) ?? null
      const nextTier = currentTier
        ? sortedTiers.find((tier) => tier.index > currentTier.index) ?? null
        : null
      items.push({
        ...base,
        quotaScope: 'TIERED',
        quotaMb: null,
        remainingMb: null,
        usagePercent: null,
        currentTierIndex: currentTier?.index ?? null,
        currentTierFromMb: currentTier?.fromMb ?? null,
        currentTierToMb: currentTier?.toMb ?? null,
        currentTierRatePerMb: currentTier?.ratePerMb ?? null,
        currentTierRemainingMb: currentTier ? Math.max(currentTier.toMb - usedByPackageMb, 0) : null,
        nextTierRatePerMb: nextTier?.ratePerMb ?? null,
        isBeyondHighestTier: !currentTier && sortedTiers.length > 0,
      })
    }
    return {
      iccid,
      period: period.period,
      periodStart: `${period.startDay}T00:00:00.000Z`,
      periodEnd: `${period.endDay}T23:59:59.999Z`,
      items,
    }
  }

  const resolveSimUsageQuery = async (
    req: FastifyRequest,
    reply: FastifyReply,
    options: { defaultPageSize: number; maxPageSize: number },
  ) => {
    const auth = ensureSimReadAccess(req, reply)
    if (!auth) return null
      const rawIccid = (req.params as Record<string, unknown>).iccid
      const iccid = normalizeIccid(rawIccid)
      if (!iccid || !isValidIccid(iccid)) {
      sendError(reply, 400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
      return null
      }

      const query = (req.query ?? {}) as Record<string, unknown>
      const startDate = query.startDate ? new Date(String(query.startDate)) : null
      const endDate = query.endDate ? new Date(String(query.endDate)) : null
      if (!startDate || !endDate || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      sendError(reply, 400, 'BAD_REQUEST', 'startDate and endDate are required and must be valid date or date-time.')
      return null
      }
      const startDay = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()))
      const endDay = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()))
      if (startDay.getTime() > endDay.getTime()) {
      sendError(reply, 400, 'BAD_REQUEST', 'startDate must be before or equal to endDate.')
      return null
      }

      const { page, pageSize, offset } = parsePagination(
        { page: query.page as string | number | null | undefined, pageSize: query.pageSize as string | number | null | undefined },
      { defaultPage: 1, defaultPageSize: options.defaultPageSize, maxPageSize: options.maxPageSize }
      )
      const packageId = query.packageId ? String(query.packageId).trim() : null
      const pricePlanType = query.pricePlanType ? String(query.pricePlanType).trim().toUpperCase() : null
      if (packageId && !isValidUuid(packageId)) {
      sendError(reply, 400, 'BAD_REQUEST', 'packageId must be a valid uuid.')
      return null
      }

      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const hasSimResellerColumn = await detectSimResellerColumn(supabase)
      const simSelectFields = [
        'sim_id',
        'iccid',
        'supplier_id',
        'operator_id',
        'enterprise_id',
        'department_id',
        ...(hasSimResellerColumn ? ['reseller_id'] : []),
      ].join(',')
      const simRows = await supabase.select(
        'sims',
        `select=${simSelectFields}&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
      const sim = Array.isArray(simRows) ? (simRows[0] as Record<string, unknown> | undefined) : undefined
      if (!sim?.sim_id) {
      sendError(reply, 404, 'NOT_FOUND', 'SIM not found.')
      return null
      }

      const enterpriseIdFilter = query.enterpriseId ? String(query.enterpriseId).trim() : null
      if (enterpriseIdFilter && !isValidUuid(enterpriseIdFilter)) {
      sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return null
      }
      const validCustomerEnterpriseId = await validateUsageEnterpriseIdForCustomerScope(
        req,
        reply,
        supabase,
        enterpriseIdFilter,
      )
    if (!validCustomerEnterpriseId) return null
      const canRead = await assertSimLifecycleAccess(
        req,
        reply,
        supabase,
        sim,
        auth,
        hasSimResellerColumn,
        enterpriseIdFilter,
      )
    if (!canRead) return null

      const filters = [
        `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
        `usage_day=gte.${encodeURIComponent(startDay.toISOString().slice(0, 10))}`,
        `usage_day=lte.${encodeURIComponent(endDay.toISOString().slice(0, 10))}`,
      ]
      if (packageId) filters.push(`package_id=eq.${encodeURIComponent(packageId)}`)
      if (pricePlanType) filters.push(`price_plan_type=eq.${encodeURIComponent(pricePlanType)}`)

      const { data, total } = await supabase.selectWithCount(
        'usage_package_daily_summary',
        `select=usage_package_summary_id,supplier_id,reseller_id,enterprise_id,sim_id,iccid,usage_day,visited_mccmnc,subscription_id,package_id,price_plan_id,price_plan_type,in_profile_mb,out_of_profile_mb,unclassified_mb,uplink_mb,downlink_mb,total_mb,amount,currency,calculation_id,rated_at&${filters.join('&')}&order=usage_day.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
      )
      const rows = Array.isArray(data) ? data as Record<string, unknown>[] : []
      const items = rows.map((row) => {
        const usageDay = row.usage_day ? String(row.usage_day).slice(0, 10) : null
        const day = usageDay ? new Date(`${usageDay}T00:00:00.000Z`) : null
        const periodStart = day && !Number.isNaN(day.getTime()) ? day.toISOString() : null
        const periodEnd = day && !Number.isNaN(day.getTime())
          ? new Date(day.getTime() + 24 * 60 * 60 * 1000).toISOString()
          : null
        const inProfileMb = Number(row.in_profile_mb ?? 0)
        const outOfProfileMb = Number(row.out_of_profile_mb ?? 0)
        const unclassifiedMb = Number(row.unclassified_mb ?? 0)
        const uplinkMb = Number(row.uplink_mb ?? 0)
        const downlinkMb = Number(row.downlink_mb ?? 0)
        const totalMb = Number(row.total_mb ?? 0)
        return {
          usagePackageSummaryId: row.usage_package_summary_id ?? null,
          supplierId: row.supplier_id ?? null,
          resellerId: row.reseller_id ?? null,
          enterpriseId: row.enterprise_id ?? null,
          simId: row.sim_id ?? null,
          iccid: row.iccid ?? iccid,
          usageDay,
          periodStart,
          periodEnd,
          visitedMccMnc: row.visited_mccmnc ?? null,
          subscriptionId: row.subscription_id ?? null,
          packageId: row.package_id ?? null,
          pricePlanId: row.price_plan_id ?? null,
          pricePlanType: row.price_plan_type ?? null,
          inProfileMb,
          outOfProfileMb,
          unclassifiedMb,
          uplinkMb,
          downlinkMb,
          totalMb,
          amount: Number(row.amount ?? 0),
          currency: row.currency ?? null,
          calculationId: row.calculation_id ?? null,
          ratedAt: toIsoDateTime(row.rated_at),
        }
      })

      const filterPairs = [
        `iccid=${iccid}`,
        `startDate=${startDay.toISOString().slice(0, 10)}`,
        `endDate=${endDay.toISOString().slice(0, 10)}`,
        `page=${page}`,
        `pageSize=${pageSize}`,
      ]
      if (enterpriseIdFilter) filterPairs.push(`enterpriseId=${enterpriseIdFilter}`)
      if (packageId) filterPairs.push(`packageId=${packageId}`)
      if (pricePlanType) filterPairs.push(`pricePlanType=${pricePlanType}`)
    return {
      iccid,
      items,
      page,
      pageSize,
      total: typeof total === 'number' ? total : items.length,
      xFilters: filterPairs.join(';'),
    }
  }

  app.get(
    `${prefix}/sims/:iccid/usage`,
    { preHandler: rbac(['sims.read']) },
    async (req, reply) => {
      const result = await resolveSimUsageQuery(req, reply, { defaultPageSize: 20, maxPageSize: 20 })
      if (!result) return
      setXFilters(reply, result.xFilters)

      reply.send({
        items: result.items,
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
      })
    }
  )

  app.get(
    `${prefix}/sims/:iccid/usage:csv`,
    { preHandler: rbac(['sims.read']) },
    async (req, reply) => {
      const result = await resolveSimUsageQuery(req, reply, { defaultPageSize: 100, maxPageSize: 1000 })
      if (!result) return
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="sim-usage-${result.iccid}.csv"`)
      setXFilters(reply, result.xFilters)
      reply.send(simUsageItemsToCsv(result.items))
    }
  )

  app.get(
    `${prefix}/sims/:iccid/quota-balance`,
    { preHandler: rbac(['sims.read']) },
    async (req, reply) => {
      const result = await resolveSimQuotaBalance(req, reply)
      if (!result) return
      reply.send(result)
    }
  )

  app.get(
    `${prefix}/sims/:simId`,
    { preHandler: rbac(['sims.read']) },
    async (req, reply) => {
      const auth = ensureSimReadAccess(req, reply)
      if (!auth) return
      const simIdResult = parseSimIdentifier((req.params as Record<string, unknown>).simId)
      if (!simIdResult.ok) {
        return sendError(reply, simIdResult.status, simIdResult.code, simIdResult.message)
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const hasSimResellerColumn = await detectSimResellerColumn(supabase)
      const simSelectFields = [
        'sim_id', 'iccid', 'primary_imsi', 'msisdn', 'status', 'lifecycle_sub_status', 'apn', 'activation_date',
        'bound_imei', 'activation_code', 'supplier_id', 'operator_id', 'enterprise_id', 'department_id', 'form_factor',
        'upstream_status', 'upstream_status_updated_at', 'remark', 'created_at', 'suppliers(name)', 'operators(name)',
        ...(hasSimResellerColumn ? ['reseller_id'] : []),
      ].join(',')
      const rows = await supabase.select(
        'sims',
        `select=${simSelectFields}&${simIdResult.field}=eq.${encodeURIComponent(simIdResult.value)}&limit=1`
      )
      let sim: Record<string, unknown> | null = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
      if (!sim && simIdResult.field === 'iccid') {
        const iccidValue = String(simIdResult.value || '').trim()
        const fallbackRows = await supabase.select(
          'sims',
          `select=${simSelectFields}&iccid=ilike.${encodeURIComponent(`%${iccidValue}%`)}&limit=20`
        )
        const candidates = Array.isArray(fallbackRows) ? fallbackRows : []
        const normalizeDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '')
        const target = normalizeDigits(iccidValue)
        sim =
          (candidates as Record<string, unknown>[]).find(
            (row) => normalizeDigits(row.iccid) === target
          ) ?? null
      }
      if (!sim) {
        return sendError(reply, 404, 'NOT_FOUND', 'SIM not found.')
      }

      const roleScope = getRoleScope(req)
      const role = (req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role
        ? String((req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role)
        : null
      const userEnterpriseId = getEnterpriseIdFromReq(req)

      if (roleScope === 'reseller') {
        const authResellerId = auth.resellerId ?? getAuthContext(req).resellerId ?? null
        if (!authResellerId) {
          return sendError(reply, 403, 'FORBIDDEN', 'Reseller scope is required.')
        }
        const allowed = await assertResellerCanReadSim(
          supabase,
          sim,
          String(authResellerId),
          hasSimResellerColumn
        )
        if (!allowed) {
          return sendError(reply, 403, 'FORBIDDEN', 'SIM does not belong to your reseller.')
        }
      } else if (roleScope === 'customer' || roleScope === 'department') {
        if (
          !sim.enterprise_id ||
          !userEnterpriseId ||
          String(sim.enterprise_id) !== String(userEnterpriseId)
        ) {
          return sendError(reply, 403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
        }
        if (roleScope === 'department') {
          const userDeptId = getDepartmentIdFromReq(req)
          if (sim.department_id && String(sim.department_id) !== String(userDeptId)) {
            return sendError(reply, 403, 'FORBIDDEN', 'SIM does not belong to your department.')
          }
        }
      } else if (roleScope !== 'platform' && role !== 'platform_admin') {
        return sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }

      let enterpriseName: string | null = null
      let departmentName: string | null = null
      let resellerId: string | null = null
      let resellerName: string | null = null

      if (sim.enterprise_id) {
        const entRows = await supabase.select(
          'tenants',
          `select=tenant_id,name,parent_id&tenant_id=eq.${encodeURIComponent(String(sim.enterprise_id))}`
        )
        const ent = Array.isArray(entRows) ? (entRows[0] as { name?: string; parent_id?: string }) : null
        if (ent) {
          enterpriseName = ent.name ?? null
          resellerId = ent.parent_id ? String(ent.parent_id) : null
          if (resellerId) {
            const resRows = await supabase.select(
              'tenants',
              `select=name&tenant_id=eq.${encodeURIComponent(resellerId)}`
            )
            if (Array.isArray(resRows) && resRows[0]) {
              resellerName = (resRows[0] as { name?: string }).name ?? null
            }
          }
        }
      } else if (roleScope === 'platform' || roleScope === 'reseller' || role === 'platform_admin') {
        let supplierResellerMap = new Map<string, string>()
        if (sim.supplier_id) {
          const supplierRows = await supabase.select(
            'reseller_suppliers',
            `select=supplier_id,reseller_id&supplier_id=eq.${encodeURIComponent(String(sim.supplier_id))}`
          )
          supplierResellerMap = new Map(
            (Array.isArray(supplierRows) ? supplierRows : [])
              .filter((row: { supplier_id?: string; reseller_id?: string }) => row?.supplier_id && row?.reseller_id)
              .map((row: { supplier_id: string; reseller_id: string }) => [
                String(row.supplier_id),
                String(row.reseller_id),
              ])
          )
        }
        const { tenantParentMap, resellerNameMap } = await loadSimTenantAndResellerMaps(
          supabase,
          [sim],
          hasSimResellerColumn,
          supplierResellerMap
        )
        resellerId = resolveSimResellerId(sim, hasSimResellerColumn, tenantParentMap, supplierResellerMap)
        if (resellerId) {
          resellerName = resellerNameMap.get(resellerId) ?? null
        }
      }

      if (sim.department_id) {
        const deptRows = await supabase.select(
          'tenants',
          `select=name&tenant_id=eq.${encodeURIComponent(String(sim.department_id))}`
        )
        if (Array.isArray(deptRows) && deptRows[0]) {
          departmentName = (deptRows[0] as { name?: string }).name ?? null
        }
      }

      const businessOperatorMap = await loadBusinessOperatorMap(supabase, [sim.operator_id])
      const businessOperator = sim.operator_id
        ? businessOperatorMap.get(String(sim.operator_id))
        : null
      const includeReseller = roleScope === 'platform' || roleScope === 'reseller'
      const suppliers = sim.suppliers as { name?: string } | undefined
      const operators = sim.operators as { name?: string } | undefined

      reply.send({
        simId: sim.sim_id,
        iccid: sim.iccid,
        imsi: sim.primary_imsi,
        msisdn: sim.msisdn,
        status: sim.status,
        lifecycleSubStatus: sim.lifecycle_sub_status || 'normal',
        upstreamStatus: sim.upstream_status ?? null,
        upstreamStatusUpdatedAt: sim.upstream_status_updated_at ?? null,
        formFactor: sim.form_factor ?? null,
        activationCode: sim.activation_code ?? null,
        supplierId: sim.supplier_id,
        supplierName: suppliers?.name ?? null,
        operatorId: sim.operator_id ?? null,
        operatorName: businessOperator?.name ?? operators?.name ?? null,
        mcc: businessOperator?.mcc ?? null,
        mnc: businessOperator?.mnc ?? null,
        ...(includeReseller
          ? {
              resellerId,
              resellerName,
            }
          : {}),
        enterpriseId: sim.enterprise_id ?? null,
        enterpriseName,
        departmentId: sim.department_id ?? null,
        departmentName,
        apn: sim.apn,
        activationDate: toIsoDateTime(sim.activation_date),
        totalUsageBytes: null,
        imei: sim.bound_imei ?? null,
        remark: sim.remark ?? null,
      })
    }
  )

  app.patch(
    `${prefix}/sims/:simId`,
    {
      preHandler: rbac(['sims.update'], {
        roles: [...LIFECYCLE_RESELLER_ROLES, ...LIFECYCLE_CUSTOMER_ADMIN_ROLES],
      }),
    },
    async (req, reply) => {
      const auth = ensureSimLifecycleAccess(req, reply)
      if (!auth) return
      const simIdResult = parseSimIdentifier((req.params as Record<string, unknown>).simId)
      if (!simIdResult.ok) {
        return sendError(reply, simIdResult.status, simIdResult.code, simIdResult.message)
      }
      const body = (req.body ?? {}) as Record<string, unknown>
      const allowedFields = new Set(['remark'])
      const patchKeys = Object.keys(body).filter((k) => allowedFields.has(k))
      if (patchKeys.length === 0) {
        return sendError(reply, 400, 'BAD_REQUEST', 'No updatable fields provided. Supported: remark.')
      }
      const patch: Record<string, unknown> = {}
      if ('remark' in body) {
        patch.remark = body.remark === null ? null : String(body.remark).slice(0, 1000)
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const enterpriseIdInput = readLifecycleEnterpriseIdInput(req, body)
      const enterpriseId = await resolveSimLifecycleEnterpriseId(req, reply, supabase, enterpriseIdInput)
      if (enterpriseId === false) return
      const roleScope = getRoleScope(req)
      const tenantQs =
        roleScope === 'customer' || roleScope === 'department'
          ? buildSimTenantFilter(req, enterpriseId)
          : buildSimTenantFilter(req, enterpriseId, { mode: 'lifecycle' })
      const hasSimResellerColumn = await detectSimResellerColumn(supabase)
      const sim = await loadSim(supabase, simIdResult.field, simIdResult.value, tenantQs)
      if (!sim) {
        return sendError(reply, 404, 'NOT_FOUND', 'SIM not found.')
      }
      const allowed = await assertSimLifecycleAccess(
        req,
        reply,
        supabase,
        sim,
        auth,
        hasSimResellerColumn,
        enterpriseId,
      )
      if (!allowed) return
      const updatedRows = await supabase.update(
        'sims',
        `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
        patch,
        { returning: 'representation' }
      )
      const updated = Array.isArray(updatedRows) ? (updatedRows[0] as { sim_id: string; iccid: string; remark?: string | null }) : null
      if (!updated) {
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update SIM.')
      }
      reply.send({
        simId: updated.sim_id,
        iccid: updated.iccid,
        remark: updated.remark ?? null,
      })
    }
  )

  app.get(
    `${prefix}/sims/:simId/state-history`,
    { preHandler: rbac(['sims.read']) },
    async (req, reply) => {
      const auth = ensureSimReadAccess(req, reply)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const simId = parseSimIdentifier((req.params as Record<string, unknown>).simId)
      if (!simId.ok) {
        return sendError(reply, simId.status, simId.code, simId.message)
      }
      const roleScope = getRoleScope(req)
      const query = req.query as Record<string, unknown>
      const enterpriseIdInput = query.enterpriseId ? String(query.enterpriseId) : null
      let enterpriseId = getEnterpriseIdFromReq(req)
      if (roleScope === 'reseller') {
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdInput)
        if (!enterpriseId) return
      } else if (roleScope === 'platform' && enterpriseIdInput) {
        enterpriseId = enterpriseIdInput
      } else if (roleScope === 'customer' || roleScope === 'department') {
        enterpriseId = resolveEnterpriseIdForCustomerScope(reply, getEnterpriseIdFromReq(req), enterpriseIdInput)
        if (!enterpriseId) return
      }
      const page = query.page ? Number(query.page) : 1
      const pageSizeRaw =
        query.pageSize !== undefined && query.pageSize !== null ? Number(query.pageSize) : 20
      const pageSize = Math.min(100, Math.max(1, Number.isFinite(pageSizeRaw) ? pageSizeRaw : 20))
      const tenantQs = buildSimTenantFilter(req, enterpriseId)
      const result = await fetchSimStateHistory({
        supabase,
        simIdentifier: simId,
        tenantQs,
        page,
        limit: pageSize,
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      reply.send({
        simId: result.sim.sim_id,
        iccid: result.sim.iccid,
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        items: result.items,
      })
    }
  )

  const handleSimStatusChange = async ({
    req,
    reply,
    action,
    newStatus,
    allowedFrom,
    requireReason,
    auth,
    commitmentExempt,
  }: {
    req: FastifyRequest
    reply: FastifyReply
    action: string
    newStatus: string
    allowedFrom: Set<string>
    requireReason: boolean
    auth: AuthResult
    commitmentExempt?: boolean
  }) => {
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
    const simId = parseSimIdentifier((req.params as Record<string, unknown>).simId)
    if (!simId.ok) {
      sendError(reply, simId.status, simId.code, simId.message)
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const { reason, idempotencyKey } = body
    if (requireReason && !reason) {
      sendError(reply, 400, 'BAD_REQUEST', 'reason is required.')
      return
    }
    const enterpriseIdInput = readLifecycleEnterpriseIdInput(req, body)
    const enterpriseId = await resolveSimLifecycleEnterpriseId(req, reply, supabase, enterpriseIdInput)
    if (enterpriseId === false) return

    const tenantQs = buildSimTenantFilter(req, enterpriseId, { mode: 'lifecycle' })
    const hasSimResellerColumn = await detectSimResellerColumn(supabase)
    const simRow = await loadSim(supabase, simId.field, simId.value, tenantQs)
    if (!simRow) {
      sendError(reply, 404, 'SIM_NOT_FOUND', `sim ${simId.value} not found.`)
      return
    }
    const allowed = await assertSimLifecycleAccess(
      req,
      reply,
      supabase,
      simRow,
      auth,
      hasSimResellerColumn,
      enterpriseId,
    )
    if (!allowed) return

    const result = await changeSimStatus({
      supabase,
      simIdentifier: simId,
      tenantQs,
      action,
      newStatus,
      allowedFrom,
      reason: reason ? String(reason) : null,
      idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      actor: auth,
      traceId: getTraceId(reply),
      sourceIp: req.ip,
      pushSimStatusToUpstream,
      commitmentExempt: !!commitmentExempt,
    })
    if (!result.ok) {
      sendError(reply, result.status, result.code, result.message)
      return
    }
    const traceId = getTraceId(reply)
    reply.status(202).send({
      ...result,
      requestId: traceId,
    })
  }

  app.post(
    `${prefix}/sims/:simId/activate`,
    {
      preHandler: rbac(['sims.activate'], {
        roles: [...LIFECYCLE_RESELLER_ROLES, ...LIFECYCLE_CUSTOMER_ADMIN_ROLES],
      }),
    },
    async (req, reply) => {
      const auth = ensureSimLifecycleAccess(req, reply)
      if (!auth) return
      await handleSimStatusChange({
        req,
        reply,
        action: 'SIM_ACTIVATE',
        newStatus: 'ACTIVATED',
        allowedFrom: new Set(['INVENTORY', 'TEST_READY', 'DEACTIVATED']),
        requireReason: false,
        auth,
      })
    }
  )

  app.post(
    `${prefix}/sims/:simId/deactivate`,
    {
      preHandler: rbac(['sims.deactivate'], {
        roles: [...LIFECYCLE_RESELLER_ROLES, ...LIFECYCLE_CUSTOMER_ADMIN_ROLES],
      }),
    },
    async (req, reply) => {
      const auth = ensureSimLifecycleAccess(req, reply)
      if (!auth) return
      await handleSimStatusChange({
        req,
        reply,
        action: 'SIM_DEACTIVATE',
        newStatus: 'DEACTIVATED',
        allowedFrom: new Set(['ACTIVATED', 'TEST_READY']),
        requireReason: true,
        auth,
      })
    }
  )

  app.post(
    `${prefix}/sims/:simId/reactivate`,
    {
      preHandler: rbac(['sims.reactivate'], {
        roles: ['reseller_admin', ...LIFECYCLE_CUSTOMER_ADMIN_ROLES],
      }),
    },
    async (req, reply) => {
      const auth = ensureSimLifecycleAccess(req, reply, { enterpriseAdminOnly: true })
      if (!auth) return
      await handleSimStatusChange({
        req,
        reply,
        action: 'SIM_REACTIVATE',
        newStatus: 'ACTIVATED',
        allowedFrom: new Set(['DEACTIVATED']),
        requireReason: false,
        auth,
      })
    }
  )

  app.post(
    `${prefix}/sims/:simId/retire`,
    {
      preHandler: rbac(['sims.retire'], {
        roles: [...LIFECYCLE_RESELLER_ADMIN_ONLY],
      }),
    },
    async (req, reply) => {
      const auth = ensureSimLifecycleResellerOrPlatformAdmin(req, reply)
      if (!auth) return
      const { confirm, commitmentExempt } = (req.body ?? {}) as Record<string, unknown>
      if (confirm !== true) {
        return sendError(reply, 400, 'BAD_REQUEST', 'confirm must be true.')
      }
      await handleSimStatusChange({
        req,
        reply,
        action: 'SIM_RETIRE',
        newStatus: 'RETIRED',
        allowedFrom: new Set(['DEACTIVATED']),
        requireReason: true,
        auth,
        commitmentExempt: !!commitmentExempt,
      })
    }
  )

  app.post(
    `${prefix}/sims/:simId/mark-test-ready`,
    {
      preHandler: rbac(['sims.mark_test_ready'], {
        roles: [...LIFECYCLE_RESELLER_ADMIN_ONLY],
      }),
    },
    async (req, reply) => {
      const auth = ensureSimLifecycleResellerOrPlatformAdmin(req, reply)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const simId = parseSimIdentifier((req.params as Record<string, unknown>).simId)
      if (!simId.ok) {
        sendError(reply, simId.status, simId.code, simId.message)
        return
      }
      const body = (req.body ?? {}) as Record<string, unknown>
      const { reason, idempotencyKey } = body
      const enterpriseIdInput = readLifecycleEnterpriseIdInput(req, body)
      const enterpriseId = await resolveSimLifecycleEnterpriseId(req, reply, supabase, enterpriseIdInput)
      if (enterpriseId === false) return
      const tenantQs = buildSimTenantFilter(req, enterpriseId, { mode: 'lifecycle' })
      const hasSimResellerColumn = await detectSimResellerColumn(supabase)
      const simRow = await loadSim(supabase, simId.field, simId.value, tenantQs)
      if (!simRow) {
        sendError(reply, 404, 'SIM_NOT_FOUND', `sim ${simId.value} not found.`)
        return
      }
      const allowed = await assertSimLifecycleAccess(
        req,
        reply,
        supabase,
        simRow,
        auth,
        hasSimResellerColumn,
        enterpriseId,
      )
      if (!allowed) return
      const result = await markSimTestReady({
        supabase,
        simIdentifier: simId,
        tenantQs,
        reason: reason ? String(reason) : null,
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
        actor: auth,
        traceId: getTraceId(reply),
        sourceIp: req.ip,
      })
      if (!result.ok) {
        sendError(reply, result.status, result.code, result.message)
        return
      }
      reply.status(200).send({
        ...result,
        requestId: getTraceId(reply),
      })
    }
  )

  app.post(
    `${prefix}/sims:batch-status-change`,
    { preHandler: rbac(['sims.batch_status_change']) },
    async (req, reply) => {
      const auth = ensureSimReadAccess(req, reply)
      if (!auth) return
      const actor = cmpAuthActorForDb(req)
      const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
      const isMultipart = contentType.toLowerCase().includes('multipart/form-data')

      let resolved: ReturnType<typeof resolveBatchStatusChangeInput>
      let lifecycleBody: Record<string, unknown>

      if (isMultipart) {
        const boundaryMatch = contentType.match(/boundary=([^;]+)/i)
        if (!boundaryMatch) {
          return sendError(reply, 400, 'BAD_REQUEST', 'multipart boundary is required.')
        }
        let bodyBuffer: Buffer
        try {
          bodyBuffer = await readRequestBody(req, 50 * 1024 * 1024)
        } catch {
          return sendError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
        }
        const { fields, files } = parseMultipartFormData(bodyBuffer, boundaryMatch[1])
        lifecycleBody = fields
        resolved = resolveBatchStatusChangeInput({
          contentType,
          multipartFields: fields,
          multipartFiles: files,
          parseCsv: parseIccidsFromAssignInventoryCsv,
        })
      } else {
        const body = (req.body ?? {}) as Record<string, unknown>
        lifecycleBody = body
        resolved = resolveBatchStatusChangeInput({
          contentType,
          jsonBody: body,
          parseCsv: parseIccidsFromAssignInventoryCsv,
        })
      }

      if (!resolved.ok) {
        return sendError(reply, resolved.status, resolved.code, resolved.message)
      }

      const { iccids, fields, fileHash: batchFileHash } = resolved
      if (fields.action === 'RETIRE' || fields.action === 'MARK_TEST_READY') {
        const adminAuth = ensureSimLifecycleResellerOrPlatformAdmin(req, reply)
        if (!adminAuth) return
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const enterpriseId = resolveBatchStatusChangeEnterpriseScope(req, reply)
      if (enterpriseId === false) return

      const roleScope = getRoleScope(req)
      const role = (req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role
        ? String((req as { cmpAuth?: { role?: string | null } }).cmpAuth?.role)
        : null
      if (roleScope === 'reseller' || roleScope === 'customer' || roleScope === 'department') {
        const hasSimResellerColumn = await detectSimResellerColumn(supabase)
        const simRows = await loadSimsByIccidsForScopeCheck(supabase, iccids, hasSimResellerColumn)
        const outOfScope = await findIccidsOutOfLifecycleScope(
          supabase,
          iccids,
          simRows,
          {
            roleScope,
            role,
            authResellerId: auth.resellerId ?? getAuthContext(req).resellerId ?? null,
            userEnterpriseId: getEnterpriseIdFromReq(req),
            userDepartmentId: getDepartmentIdFromReq(req),
            enterpriseIdFilter: enterpriseId,
            hasSimResellerColumn,
          },
          normalizeIccid,
          (s, sim, resellerTenantId, hasCol) =>
            assertResellerCanReadSim(supabase, sim, resellerTenantId, hasCol),
        )
        if (outOfScope.length > 0) {
          const scopeLabel =
            roleScope === 'reseller'
              ? 'reseller'
              : roleScope === 'department'
                ? 'enterprise/department'
                : 'enterprise'
          return sendError(
            reply,
            403,
            'FORBIDDEN',
            `One or more ICCIDs are not in your ${scopeLabel} scope: ${outOfScope.join(', ')}.`,
          )
        }
      }

      const tenantQs = buildSimTenantFilter(req, enterpriseId, { mode: 'lifecycle' })
      const result = await batchChangeSimStatus({
        supabase,
        iccids,
        tenantQs,
        enterpriseId: enterpriseId ?? null,
        action: fields.action,
        reason: fields.reason,
        actor,
        traceId: getTraceId(reply),
        sourceIp: req.ip,
        pushSimStatusToUpstream,
        commitmentExempt: fields.commitmentExempt,
        batchId: fields.batchId,
        fileHash: batchFileHash ?? null,
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      const statusCode = result.failed === 0 ? 200 : (result.succeeded === 0 ? 400 : 207)
      reply.status(statusCode).send(result)
    }
  )

  app.post(
    `${prefix}/sims:batch-deactivate`,
    { preHandler: rbac(['sims.batch_deactivate'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      try {
        const auth = ensureResellerAdmin(req, reply)
        if (!auth) return
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
        const { reason, idempotencyKey, enterpriseId: enterpriseIdBody } = (req.body ?? {}) as Record<string, unknown>
        const roleScope = getRoleScope(req)
        let enterpriseId = getEnterpriseIdFromReq(req)
        if (roleScope === 'reseller') {
          enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, enterpriseIdBody ? String(enterpriseIdBody) : null)
          if (!enterpriseId) return
        } else if (roleScope === 'platform' && enterpriseIdBody) {
          enterpriseId = String(enterpriseIdBody)
        }
        if (!enterpriseId) {
          return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required.')
        }
        const result = await batchDeactivateSims({
          supabase,
          enterpriseId,
          reason: reason ? String(reason) : null,
          idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
          actor: auth,
          traceId: getTraceId(reply),
          sourceIp: req.ip,
          pushSimStatusToUpstream,
        })
        if (!result.ok) {
          return sendError(reply, result.status, result.code, result.message)
        }
        reply.status(202).send({
          jobId: result.jobId,
          status: result.status,
          totalRows: result.totalRows,
        })
      } catch (err: any) {
        const status = Number(err?.status) || 500
        const code = err?.code || (err?.upstreamType ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR')
        const message = status >= 500 ? 'Unexpected error.' : String(err?.message || 'Unexpected error.')
        return sendError(reply, status, code, message)
      }
    }
  )

  app.post(
    `${prefix}/sims:assign-inventory-to-enterprise`,
    { preHandler: rbac(['sims.assign_inventory'], { roles: ['reseller_admin'] }) },
    async (req, reply) => {
      const auth = ensureResellerAdmin(req, reply)
      if (!auth) return
      const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return sendError(reply, 400, 'BAD_REQUEST', 'multipart/form-data is required.')
      }
      const boundaryMatch = contentType.match(/boundary=([^;]+)/i)
      if (!boundaryMatch) {
        return sendError(reply, 400, 'BAD_REQUEST', 'multipart boundary is required.')
      }
      let bodyBuffer: Buffer
      try {
        bodyBuffer = await readRequestBody(req, 50 * 1024 * 1024)
      } catch {
        return sendError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
      }
      const { fields, files } = parseMultipartFormData(bodyBuffer, boundaryMatch[1])
      const roleScope = getRoleScope(req)
      const resellerPoolRaw = fields.resellerId ? String(fields.resellerId).trim() : ''
      if (!resellerPoolRaw || !isValidUuid(resellerPoolRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'resellerId is required and must be a valid uuid.')
      }
      if (roleScope === 'reseller') {
        const authTid = auth.resellerId ? String(auth.resellerId).trim() : null
        if (!authTid || resellerPoolRaw !== authTid) {
          return sendError(reply, 403, 'FORBIDDEN', 'resellerId is out of scope.')
        }
      }
      const entRaw = fields.enterpriseId ? String(fields.enterpriseId).trim() : ''
      if (!entRaw || !isValidUuid(entRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
      }
      const file = files.file
      if (!file || !file.content) {
        return sendError(reply, 400, 'INVALID_FORMAT', 'file is required.')
      }
      const csvText = String(file.content ?? '')
      const parsed = parseIccidsFromAssignInventoryCsv(csvText)
      if (!parsed.ok) {
        return sendError(reply, parsed.status, parsed.code, parsed.message)
      }
      const fileHash = crypto.createHash('sha256').update(Buffer.from(csvText, 'utf8')).digest('hex')
      const batchId = fields.batchId ? String(fields.batchId).trim() : null
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const result = await assignInventorySimsToEnterprise({
        supabase,
        resellerId: resellerPoolRaw,
        enterpriseId: entRaw,
        simIds: parsed.iccids,
        actor: cmpAuthActorForDb(req),
        traceId: getTraceId(reply),
        sourceIp: req.ip,
        batchId,
        fileHash,
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      const statusCode = result.failed === 0 ? 200 : (result.succeeded === 0 ? 400 : 207)
      const { ok: _ok, ...body } = result
      reply.status(statusCode).send(body)
    }
  )

  app.post(
    `${prefix}/sims:assign-to-department`,
    {
      preHandler: rbac(['sims.assign_department'], {
        roles: ['customer_admin', 'reseller_admin', 'platform_admin'],
      }),
    },
    async (req, reply) => {
      const auth = ensureSimAssignDepartmentAccess(req, reply)
      if (!auth) return
      const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return sendError(reply, 400, 'BAD_REQUEST', 'multipart/form-data is required.')
      }
      const boundaryMatch = contentType.match(/boundary=([^;]+)/i)
      if (!boundaryMatch) {
        return sendError(reply, 400, 'BAD_REQUEST', 'multipart boundary is required.')
      }
      let bodyBuffer: Buffer
      try {
        bodyBuffer = await readRequestBody(req, 50 * 1024 * 1024)
      } catch {
        return sendError(reply, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
      }
      const { fields, files } = parseMultipartFormData(bodyBuffer, boundaryMatch[1])
      const entFieldRaw = fields.enterpriseId ? String(fields.enterpriseId).trim() : ''
      const deptRaw = fields.departmentId ? String(fields.departmentId).trim() : ''
      if (!deptRaw || !isValidUuid(deptRaw)) {
        return sendError(reply, 400, 'BAD_REQUEST', 'departmentId is required and must be a valid uuid.')
      }
      const file = files.file
      if (!file || !file.content) {
        return sendError(reply, 400, 'INVALID_FORMAT', 'file is required.')
      }
      const csvText = String(file.content ?? '')
      const parsed = parseIccidsFromAssignInventoryCsv(csvText)
      if (!parsed.ok) {
        return sendError(reply, parsed.status, parsed.code, parsed.message)
      }
      const fileHash = crypto.createHash('sha256').update(Buffer.from(csvText, 'utf8')).digest('hex')
      const batchId = fields.batchId ? String(fields.batchId).trim() : null
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const roleScope = getRoleScope(req)
      let enterpriseId: string | null = null
      if (auth.scope === 'customer') {
        const tokenEnterprise = auth.customerId ? String(auth.customerId).trim() : ''
        if (!tokenEnterprise || !isValidUuid(tokenEnterprise)) {
          return sendError(reply, 403, 'FORBIDDEN', 'Enterprise scope is required.')
        }
        enterpriseId = entFieldRaw || tokenEnterprise
        if (!isValidUuid(enterpriseId)) {
          return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        if (entFieldRaw && entFieldRaw.toLowerCase() !== tokenEnterprise.toLowerCase()) {
          return sendError(reply, 403, 'FORBIDDEN', 'enterpriseId is out of scope.')
        }
      } else if (auth.scope === 'reseller' || roleScope === 'reseller') {
        if (!entFieldRaw || !isValidUuid(entFieldRaw)) {
          return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
        }
        enterpriseId = await resolveEnterpriseForReseller(req, reply, supabase, entFieldRaw)
        if (!enterpriseId) return
      } else if (auth.scope === 'platform' || roleScope === 'platform') {
        if (!entFieldRaw || !isValidUuid(entFieldRaw)) {
          return sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
        }
        enterpriseId = entFieldRaw
      } else {
        return sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
      }
      const departmentId = await resolveDepartmentForEnterprise(req, reply, supabase, enterpriseId, deptRaw)
      if (!departmentId) return
      const result = await assignEnterpriseSimsToDepartment({
        supabase,
        enterpriseId,
        departmentId,
        iccids: parsed.iccids,
        actor: cmpAuthActorForDb(req),
        traceId: getTraceId(reply),
        sourceIp: req.ip,
        batchId,
        fileHash,
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      const statusCode = result.failed === 0 ? 200 : result.succeeded === 0 ? 400 : 207
      reply.status(statusCode).send(result)
    }
  )
}
