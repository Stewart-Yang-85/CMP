import {
  getAlertRuleConfig,
  listAlertRuleConfigs,
  patchAlertRuleConfig,
  resolveEffectiveAlertRuleConfig,
  upsertAlertRuleConfig,
} from '../services/alertRuleConfig.js'
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

function isCustomer(req: any, deps: Deps) {
  const auth = getAuth(req)
  const roleScope = deps.getRoleScope(req) ?? auth.roleScope
  return roleScope === 'customer' || roleScope === 'department'
}

function ensurePlatformOrReseller(req: any, res: any, deps: Deps) {
  if (isPlatform(req, deps)) return true
  if (isReseller(req, deps) && getAuth(req).resellerId) return true
  deps.sendError(res, 403, 'FORBIDDEN', 'Platform or reseller scope required.')
  return false
}

function applyResellerWriteScope(req: any, res: any, deps: Deps, payload: Record<string, unknown>) {
  if (isPlatform(req, deps)) return payload
  const auth = getAuth(req)
  const scopeType = String(payload.scopeType ?? '').trim().toUpperCase()
  if (!auth.resellerId) {
    deps.sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
    return null
  }
  if (scopeType === 'PLATFORM') {
    deps.sendError(res, 403, 'FORBIDDEN', 'Reseller cannot manage PLATFORM alert configs.')
    return null
  }
  if (payload.resellerId && String(payload.resellerId) !== auth.resellerId) {
    deps.sendError(res, 403, 'FORBIDDEN', 'resellerId is out of token scope.')
    return null
  }
  return { ...payload, resellerId: auth.resellerId }
}

async function loadCustomerResellerId(supabase: any, enterpriseId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row?.parent_id ? String(row.parent_id) : null
}

export function registerAlertConfigRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const { createSupabaseRestClient, getTraceId, sendError } = deps

  app.get(`${prefix}/alert-configs`, async (req: any, res: any) => {
    if (!ensurePlatformOrReseller(req, res, deps)) return
    const query = req.query ?? {}
    const auth = getAuth(req)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const resellerId = isPlatform(req, deps)
      ? query.resellerId ? String(query.resellerId).trim() : null
      : auth.resellerId
    if (!isPlatform(req, deps) && query.resellerId && String(query.resellerId) !== auth.resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'resellerId is out of token scope.')
    }
    const result = await listAlertRuleConfigs({
      supabase,
      scopeType: query.scopeType,
      resellerId,
      enterpriseId: query.enterpriseId,
      alertType: query.alertType,
      page: query.page,
      pageSize: query.pageSize,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/alert-configs`, async (req: any, res: any) => {
    if (!ensurePlatformOrReseller(req, res, deps)) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const payload = applyResellerWriteScope(req, res, deps, (req.body ?? {}) as Record<string, unknown>)
    if (!payload) return
    const result = await upsertAlertRuleConfig({ supabase, payload })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    const auth = getAuth(req)
    await recordAlertInternalEvent({
      supabase,
      eventType: 'ALERT_RULE_CONFIG_CHANGED',
      enterpriseId: result.value.enterpriseId,
      resellerId: result.value.resellerId,
      actorUserId: actorUserIdForDb(auth.userId),
      requestId: getTraceId(res),
      payload: {
        action: 'UPSERT',
        configId: result.value.configId,
        scopeType: result.value.scopeType,
        alertType: result.value.alertType,
        enabled: result.value.enabled,
        version: result.value.version,
      },
    })
    await recordAlertAuditLog({
      supabase,
      action: 'ALERT_RULE_CONFIG_UPSERT',
      targetType: 'ALERT_RULE_CONFIG',
      targetId: result.value.configId,
      tenantId: result.value.enterpriseId ?? result.value.resellerId ?? null,
      actorUserId: actorUserIdForDb(auth.userId),
      actorRole: auth.role ?? auth.roleScope ?? null,
      afterData: {
        scopeType: result.value.scopeType,
        resellerId: result.value.resellerId,
        enterpriseId: result.value.enterpriseId,
        alertType: result.value.alertType,
        enabled: result.value.enabled,
        severity: result.value.severity,
        thresholdValue: result.value.thresholdValue,
        thresholdUnit: result.value.thresholdUnit,
        windowMinutes: result.value.windowMinutes,
        suppressMinutes: result.value.suppressMinutes,
        deliveryChannels: result.value.deliveryChannels,
        version: result.value.version,
      },
      requestId: getTraceId(res),
      sourceIp: req.ip ?? null,
    })
    res.code(200).send(result.value)
  })

  app.patch(`${prefix}/alert-configs/:configId`, async (req: any, res: any) => {
    if (!ensurePlatformOrReseller(req, res, deps)) return
    const configId = String(req.params?.configId ?? '').trim()
    if (!deps.isValidUuid(configId)) return sendError(res, 400, 'BAD_REQUEST', 'configId must be a valid uuid.')
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const existing = await getAlertRuleConfig({ supabase, configId })
    if (!existing.ok) return sendError(res, existing.status, existing.code, existing.message)
    if (!isPlatform(req, deps)) {
      const auth = getAuth(req)
      if (!auth.resellerId || existing.value.resellerId !== auth.resellerId || existing.value.scopeType === 'PLATFORM') {
        return sendError(res, 403, 'FORBIDDEN', 'alert config is out of token scope.')
      }
    }
    const payload = applyResellerWriteScope(req, res, deps, (req.body ?? {}) as Record<string, unknown>)
    if (!payload) return
    const result = await patchAlertRuleConfig({ supabase, configId, payload })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    const auth = getAuth(req)
    await recordAlertInternalEvent({
      supabase,
      eventType: 'ALERT_RULE_CONFIG_CHANGED',
      enterpriseId: result.value.enterpriseId,
      resellerId: result.value.resellerId,
      actorUserId: actorUserIdForDb(auth.userId),
      requestId: getTraceId(res),
      payload: {
        action: 'PATCH',
        configId: result.value.configId,
        scopeType: result.value.scopeType,
        alertType: result.value.alertType,
        enabled: result.value.enabled,
        version: result.value.version,
      },
    })
    await recordAlertAuditLog({
      supabase,
      action: 'ALERT_RULE_CONFIG_PATCH',
      targetType: 'ALERT_RULE_CONFIG',
      targetId: result.value.configId,
      tenantId: result.value.enterpriseId ?? result.value.resellerId ?? null,
      actorUserId: actorUserIdForDb(auth.userId),
      actorRole: auth.role ?? auth.roleScope ?? null,
      beforeData: existing.value,
      afterData: {
        scopeType: result.value.scopeType,
        resellerId: result.value.resellerId,
        enterpriseId: result.value.enterpriseId,
        alertType: result.value.alertType,
        enabled: result.value.enabled,
        severity: result.value.severity,
        thresholdValue: result.value.thresholdValue,
        thresholdUnit: result.value.thresholdUnit,
        windowMinutes: result.value.windowMinutes,
        suppressMinutes: result.value.suppressMinutes,
        deliveryChannels: result.value.deliveryChannels,
        version: result.value.version,
      },
      requestId: getTraceId(res),
      sourceIp: req.ip ?? null,
    })
    res.send(result.value)
  })

  app.get(`${prefix}/alert-configs/effective`, async (req: any, res: any) => {
    const query = req.query ?? {}
    const auth = getAuth(req)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let resellerId = query.resellerId ? String(query.resellerId).trim() : null
    let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
    if (isReseller(req, deps)) {
      if (!auth.resellerId) return sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      if (resellerId && resellerId !== auth.resellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId is out of token scope.')
      }
      resellerId = auth.resellerId
    } else if (isCustomer(req, deps)) {
      enterpriseId = deps.getEnterpriseIdFromReq(req) ?? auth.customerId
      if (!enterpriseId) return sendError(res, 403, 'FORBIDDEN', 'Customer scope required.')
      resellerId = auth.resellerId ?? await loadCustomerResellerId(supabase, enterpriseId)
    } else if (!isPlatform(req, deps)) {
      return sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    }
    const result = await resolveEffectiveAlertRuleConfig({
      supabase,
      alertType: query.alertType,
      resellerId,
      enterpriseId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })
}
