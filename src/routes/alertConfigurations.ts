import { getAlertType, listAlertTypes, patchAlertType } from '../services/alertTypeCatalog.js'
import {
  createAlertConfigProfileWithItems,
  getAlertConfigProfile,
  getAlertConfigProfileWithItems,
  listAlertConfigProfiles,
  replaceAlertConfigProfileWithItems,
  resolveEffectiveAlertConfigProfile,
} from '../services/alertConfigProfile.js'
import { recordAlertAuditLog, recordAlertInternalEvent } from '../services/alertAuditTrail.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  getRoleScope: (req: any) => string | null
  getEnterpriseIdFromReq: (req: any) => string | null
  isValidUuid: (value: string) => boolean
}

function getAuth(req: any) {
  const auth = req?.cmpAuth ?? {}
  return {
    roleScope: auth.roleScope ? String(auth.roleScope) : null,
    role: auth.role ? String(auth.role) : null,
    resellerId: auth.resellerId ? String(auth.resellerId) : null,
    customerId: auth.customerId ? String(auth.customerId) : null,
    userId: auth.userId ? String(auth.userId) : null,
  }
}

function isPlatform(req: any, deps: Deps) {
  const auth = getAuth(req)
  const roleScope = deps.getRoleScope(req) ?? auth.roleScope
  return roleScope === 'platform' || auth.role === 'platform_admin'
}

function isReseller(req: any, deps: Deps) {
  const auth = getAuth(req)
  const roleScope = deps.getRoleScope(req) ?? auth.roleScope
  return roleScope === 'reseller'
}

function ensurePlatform(req: any, res: any, deps: Deps) {
  if (isPlatform(req, deps)) return true
  deps.sendError(res, 403, 'FORBIDDEN', 'Platform scope required.')
  return false
}

function ensurePlatformOrReseller(req: any, res: any, deps: Deps) {
  if (isPlatform(req, deps)) return true
  if (isReseller(req, deps) && getAuth(req).resellerId) return true
  deps.sendError(res, 403, 'FORBIDDEN', 'Platform or reseller scope required.')
  return false
}

async function loadEnterprise(supabase: any, enterpriseId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  return Array.isArray(rows) ? rows[0] ?? null : null
}

async function loadReseller(supabase: any, resellerId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
  )
  return Array.isArray(rows) ? rows[0] ?? null : null
}

async function resolveProfileListScope(
  req: any,
  res: any,
  deps: Deps,
  supabase: any,
  options: { requireResellerForEnterprise?: boolean } = {}
) {
  const query = req.query ?? {}
  const auth = getAuth(req)
  const resellerId = query.resellerId ? String(query.resellerId).trim() : null
  const enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null

  if (resellerId && !deps.isValidUuid(resellerId)) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    return null
  }
  if (enterpriseId && !deps.isValidUuid(enterpriseId)) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    return null
  }

  if (isPlatform(req, deps)) {
    if (resellerId) {
      const reseller = await loadReseller(supabase, resellerId)
      if (!reseller) {
        deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `reseller ${resellerId} not found.`)
        return null
      }
    }
    if (enterpriseId) {
      if (options.requireResellerForEnterprise && !resellerId) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId is required when enterpriseId is provided.')
        return null
      }
      const enterprise = await loadEnterprise(supabase, enterpriseId)
      if (!enterprise) {
        deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
        return null
      }
      if (resellerId && String(enterprise.parent_id ?? '') !== resellerId) {
        deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
        return null
      }
    }
    return { resellerId, enterpriseId }
  }

  if (!auth.resellerId) {
    deps.sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
    return null
  }
  if (resellerId && resellerId !== auth.resellerId) {
    deps.sendError(res, 403, 'FORBIDDEN', 'resellerId is out of token scope.')
    return null
  }
  if (enterpriseId) {
    const enterprise = await loadEnterprise(supabase, enterpriseId)
    if (!enterprise) {
      deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      return null
    }
    if (String(enterprise.parent_id ?? '') !== auth.resellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
      return null
    }
  }
  return { resellerId: auth.resellerId, enterpriseId }
}

async function applyResellerProfileWriteScope(req: any, res: any, deps: Deps, supabase: any, payload: Record<string, unknown>) {
  if (isPlatform(req, deps)) return payload
  const auth = getAuth(req)
  if (!auth.resellerId) {
    deps.sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
    return null
  }
  const scopeType = String(payload.scopeType ?? '').trim().toUpperCase()
  if (scopeType === 'PLATFORM') {
    deps.sendError(res, 403, 'FORBIDDEN', 'Reseller cannot manage PLATFORM alert config profiles.')
    return null
  }
  if (!payload.resellerId) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId is required for reseller-scoped writes.')
    return null
  }
  if (String(payload.resellerId) !== auth.resellerId) {
    deps.sendError(res, 403, 'FORBIDDEN', 'resellerId is out of token scope.')
    return null
  }
  if (scopeType === 'ENTERPRISE') {
    const enterpriseId = payload.enterpriseId ? String(payload.enterpriseId).trim() : ''
    if (!enterpriseId || !deps.isValidUuid(enterpriseId)) {
      deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return null
    }
    const enterprise = await loadEnterprise(supabase, enterpriseId)
    if (!enterprise) {
      deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
      return null
    }
    if (String(enterprise.parent_id ?? '') !== auth.resellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
      return null
    }
  }
  return { ...payload, resellerId: auth.resellerId }
}

function profileWritePayloadFromRequest(req: any) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const query = req.query ?? {}
  return {
    ...body,
    scopeType: query.scopeType,
    resellerId: query.resellerId === undefined || query.resellerId === '' ? null : String(query.resellerId),
    enterpriseId: query.enterpriseId === undefined || query.enterpriseId === '' ? null : String(query.enterpriseId),
  }
}

function profileInResellerScope(profile: { scopeType: string; resellerId: string | null }, resellerId: string | null) {
  return resellerId && profile.scopeType !== 'PLATFORM' && profile.resellerId === resellerId
}

async function ensureProfileAccess(req: any, res: any, deps: Deps, supabase: any, profileId: string) {
  const profile = await getAlertConfigProfile({ supabase, profileId })
  if (!profile.ok) {
    deps.sendError(res, profile.status, profile.code, profile.message)
    return null
  }
  if (isPlatform(req, deps)) return profile.value
  const auth = getAuth(req)
  if (!profileInResellerScope(profile.value, auth.resellerId)) {
    deps.sendError(res, 403, 'FORBIDDEN', 'alert config profile is out of token scope.')
    return null
  }
  return profile.value
}

async function auditConfigChange({
  req,
  res,
  supabase,
  action,
  targetType,
  targetId,
  tenantId,
  beforeData,
  afterData,
}: {
  req: any
  res: any
  supabase: any
  action: string
  targetType: string
  targetId?: string | null
  tenantId?: string | null
  beforeData?: Record<string, unknown> | null
  afterData?: Record<string, unknown> | null
}) {
  const auth = getAuth(req)
  await recordAlertInternalEvent({
    supabase,
    eventType: 'ALERT_RULE_CONFIG_CHANGED',
    enterpriseId: afterData?.enterpriseId as string ?? null,
    resellerId: afterData?.resellerId as string ?? null,
    actorUserId: actorUserIdForDb(auth.userId),
    requestId: res?.requestId ?? null,
    payload: { action, targetType, targetId, afterData },
  })
  await recordAlertAuditLog({
    supabase,
    action,
    targetType,
    targetId,
    tenantId,
    actorUserId: actorUserIdForDb(auth.userId),
    actorRole: auth.role ?? auth.roleScope ?? null,
    beforeData: beforeData ?? null,
    afterData: afterData ?? null,
    requestId: res?.requestId ?? null,
    sourceIp: req.ip ?? null,
  })
}

export function registerAlertConfigurationRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps

  app.get(`${prefix}/alert-types`, async (req: any, res: any) => {
    if (!ensurePlatform(req, res, deps)) return
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listAlertTypes({ supabase, enabled: query.enabled, scopeType: query.scopeType, alertType: query.alertType })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/alert-types/:alertType`, async (req: any, res: any) => {
    if (!ensurePlatform(req, res, deps)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getAlertType({ supabase, alertType: req.params?.alertType })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.patch(`${prefix}/alert-types/:alertType`, async (req: any, res: any) => {
    if (!ensurePlatform(req, res, deps)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const targetAlertType = body.alertType ?? req.params?.alertType
    const before = await getAlertType({ supabase, alertType: targetAlertType })
    if (!before.ok) return sendError(res, before.status, before.code, before.message)
    const result = await patchAlertType({ supabase, alertType: targetAlertType, payload: body })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    await auditConfigChange({
      req,
      res,
      supabase,
      action: 'ALERT_TYPE_PATCH',
      targetType: 'ALERT_TYPE',
      targetId: result.value.alertType,
      beforeData: before.value as any,
      afterData: result.value as any,
    })
    res.send(result.value)
  })

  app.get(`${prefix}/alert-config-profiles`, async (req: any, res: any) => {
    if (!ensurePlatformOrReseller(req, res, deps)) return
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const scope = await resolveProfileListScope(req, res, deps, supabase)
    if (!scope) return
    const result = await listAlertConfigProfiles({
      supabase,
      scopeType: query.scopeType,
      resellerId: scope.resellerId,
      enterpriseId: scope.enterpriseId,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/alert-config-profiles`, async (req: any, res: any) => {
    if (!ensurePlatformOrReseller(req, res, deps)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const payload = await applyResellerProfileWriteScope(req, res, deps, supabase, profileWritePayloadFromRequest(req))
    if (!payload) return
    const result = await createAlertConfigProfileWithItems({ supabase, payload, actorUserId: actorUserIdForDb(getAuth(req).userId) })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    await auditConfigChange({
      req,
      res,
      supabase,
      action: 'ALERT_CONFIG_PROFILE_CREATE',
      targetType: 'ALERT_CONFIG_PROFILE',
      targetId: result.value.profileId,
      tenantId: result.value.enterpriseId ?? result.value.resellerId ?? null,
      afterData: result.value as any,
    })
    res.code(201).send(result.value)
  })

  app.get(`${prefix}/alert-config-profiles/effective`, async (req: any, res: any) => {
    if (!ensurePlatformOrReseller(req, res, deps)) return
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const scope = await resolveProfileListScope(req, res, deps, supabase, { requireResellerForEnterprise: true })
    if (!scope) return
    const result = await resolveEffectiveAlertConfigProfile({
      supabase,
      alertType: query.alertType,
      resellerId: scope.resellerId,
      enterpriseId: scope.enterpriseId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/alert-config-profiles/:profileId`, async (req: any, res: any) => {
    if (!ensurePlatformOrReseller(req, res, deps)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const profile = await ensureProfileAccess(req, res, deps, supabase, String(req.params?.profileId ?? ''))
    if (!profile) return
    const result = await getAlertConfigProfileWithItems({ supabase, profileId: profile.profileId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.put(`${prefix}/alert-config-profiles/:profileId`, async (req: any, res: any) => {
    if (!ensurePlatformOrReseller(req, res, deps)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const before = await ensureProfileAccess(req, res, deps, supabase, String(req.params?.profileId ?? ''))
    if (!before) return
    const payload = await applyResellerProfileWriteScope(req, res, deps, supabase, profileWritePayloadFromRequest(req))
    if (!payload) return
    const result = await replaceAlertConfigProfileWithItems({
      supabase,
      profileId: before.profileId,
      payload,
      actorUserId: actorUserIdForDb(getAuth(req).userId),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    await auditConfigChange({
      req,
      res,
      supabase,
      action: 'ALERT_CONFIG_PROFILE_REPLACE',
      targetType: 'ALERT_CONFIG_PROFILE',
      targetId: result.value.profileId,
      tenantId: result.value.enterpriseId ?? result.value.resellerId ?? null,
      beforeData: before as any,
      afterData: result.value as any,
    })
    res.send(result.value)
  })
}
