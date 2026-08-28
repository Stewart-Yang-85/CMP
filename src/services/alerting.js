import { emitEvent } from './eventEmitter.js'
import { recordAlertDeliveries } from './alertDelivery.js'
import { recordAlertAuditLog, recordAlertInternalEvent } from './alertAuditTrail.js'

const alertTypes = new Set([
  'POOL_USAGE_HIGH',
  'OUT_OF_PROFILE_SURGE',
  'SILENT_SIM',
  'UNEXPECTED_ROAMING',
  'CDR_DELAY',
  'UPSTREAM_DISCONNECT',
  'WEBHOOK_DELIVERY_FAILED',
])

function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function normalizeAlertType(value) {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return null
  return alertTypes.has(raw) ? raw : null
}

function shouldDispatchAlertWebhook(deliveryChannels) {
  return Array.isArray(deliveryChannels)
    && deliveryChannels.some((channel) => String(channel || '').trim().toUpperCase() === 'WEBHOOK')
}

function normalizeIso(value) {
  if (!value) return null
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function toNumberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** True when merge should emit ALERT_MERGED / ALERT_MERGE (status or current_value changed). */
function isAlertMergeMaterialChange(existing, nextStatus, nextCurrentValue) {
  const prevStatus = existing?.status != null ? String(existing.status) : null
  if (prevStatus !== nextStatus) return true
  const prevNum = toNumberOrNull(existing?.current_value)
  const nextNum = toNumberOrNull(nextCurrentValue)
  if (prevNum == null && nextNum == null) {
    const prevRaw = existing?.current_value
    const nextRaw = nextCurrentValue
    if (prevRaw == null && nextRaw == null) return false
    return String(prevRaw ?? '') !== String(nextRaw ?? '')
  }
  if (prevNum == null || nextNum == null) return true
  return Math.abs(prevNum - nextNum) > 1e-6
}

/** PostgREST ClientError often has object `body`; don't use String(body) alone or message is lost. */
function supabaseErrorText(err) {
  const parts = []
  if (err?.message) parts.push(String(err.message))
  if (err?.body != null) {
    parts.push(typeof err.body === 'string' ? err.body : JSON.stringify(err.body))
  }
  if (err?.code) parts.push(String(err.code))
  return parts.join(' ')
}

function isMissingRelationError(err, relationName) {
  const text = supabaseErrorText(err)
  return (
    (relationName && text.includes(relationName)) ||
    text.includes('PGRST205') ||
    text.includes('does not exist') ||
    text.includes('schema cache')
  )
}

function buildAlertFilters({ resellerId, enterpriseId, alertType, from, to, acknowledged }) {
  const filters = []
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  if (enterpriseId) filters.push(`customer_id=eq.${encodeURIComponent(enterpriseId)}`)
  if (alertType) filters.push(`alert_type=eq.${encodeURIComponent(alertType)}`)
  if (from) {
    const encodedFrom = encodeURIComponent(from)
    filters.push(`or=(window_end.gte.${encodedFrom},and(window_end.is.null,window_start.gte.${encodedFrom}))`)
  }
  if (to) filters.push(`window_start=lte.${encodeURIComponent(to)}`)
  if (acknowledged === true) filters.push(`status=eq.ACKED`)
  if (acknowledged === false) filters.push(`status=neq.ACKED`)
  return filters
}

function mapAlertRow(row) {
  return {
    alertId: row.alert_id ?? null,
    alertType: row.alert_type ?? null,
    severity: row.severity ?? null,
    status: row.status ?? null,
    resellerId: row.reseller_id ?? null,
    enterpriseId: row.customer_id ?? null,
    simId: row.sim_id ?? null,
    iccid: row.sims?.iccid ?? null,
    threshold: toNumberOrNull(row.threshold),
    currentValue: toNumberOrNull(row.current_value),
    windowStart: row.window_start ? new Date(row.window_start).toISOString() : null,
    windowEnd: row.window_end ? new Date(row.window_end).toISOString() : null,
    firstSeenAt: row.first_seen_at ? new Date(row.first_seen_at).toISOString() : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : null,
    acknowledgedBy: row.acknowledged_by ?? null,
    suppressedUntil: row.suppressed_until ? new Date(row.suppressed_until).toISOString() : null,
    message: row.metadata?.message ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

async function loadAlertById(supabase, alertIdValue) {
  const rows = await supabase.select(
    'alerts',
    `select=alert_id,alert_type,severity,status,rule_id,reseller_id,customer_id,sim_id,threshold,current_value,window_start,window_end,first_seen_at,last_seen_at,acknowledged_at,acknowledged_by,suppressed_until,created_at,updated_at,metadata,sims(iccid)&alert_id=eq.${encodeURIComponent(alertIdValue)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] ?? null : null
}

function validateAlertScope(row, resellerId, enterpriseId) {
  if (resellerId && String(row.reseller_id ?? '') !== resellerId) {
    return toError(403, 'FORBIDDEN', 'alert does not belong to reseller scope.')
  }
  if (enterpriseId && String(row.customer_id ?? '') !== enterpriseId) {
    return toError(403, 'FORBIDDEN', 'alert does not belong to enterprise scope.')
  }
  return null
}

export async function listAlerts(input) {
  const { supabase, resellerId, enterpriseId, alertType, from, to, acknowledged, limit, offset } = input
  const normalizedType = alertType ? normalizeAlertType(alertType) : null
  if (alertType && !normalizedType) {
    return toError(400, 'BAD_REQUEST', 'alertType is invalid.')
  }
  const fromIso = from ? normalizeIso(from) : null
  const toIso = to ? normalizeIso(to) : null
  if (from && !fromIso) return toError(400, 'BAD_REQUEST', 'from must be a valid date-time.')
  if (to && !toIso) return toError(400, 'BAD_REQUEST', 'to must be a valid date-time.')
  const filters = buildAlertFilters({
    resellerId,
    enterpriseId,
    alertType: normalizedType,
    from: fromIso,
    to: toIso,
    acknowledged,
  })
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const limitValue = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 50
  const offsetValue = Number.isFinite(offset) ? Math.max(0, Number(offset)) : 0
  const { data, total } = await supabase.selectWithCount(
    'alerts',
    `select=alert_id,alert_type,severity,status,rule_id,reseller_id,customer_id,sim_id,threshold,current_value,window_start,window_end,first_seen_at,last_seen_at,acknowledged_at,acknowledged_by,suppressed_until,created_at,updated_at,metadata,sims(iccid)&order=window_start.desc&limit=${encodeURIComponent(String(limitValue))}&offset=${encodeURIComponent(String(offsetValue))}${filterQs}`
  )
  const rows = Array.isArray(data) ? data : []
  const items = rows.map(mapAlertRow)
  return {
    ok: true,
    value: {
      items,
      total: typeof total === 'number' ? total : items.length,
    },
  }
}

export async function getAlert(input) {
  const { supabase, alertId, resellerId, enterpriseId } = input
  const alertIdValue = String(alertId || '').trim()
  if (!alertIdValue) return toError(400, 'BAD_REQUEST', 'alertId is required.')
  const row = await loadAlertById(supabase, alertIdValue)
  if (!row) return toError(404, 'RESOURCE_NOT_FOUND', 'alert not found.')
  const scopeError = validateAlertScope(row, resellerId, enterpriseId)
  if (scopeError) return scopeError
  return { ok: true, value: mapAlertRow(row) }
}

export async function acknowledgeAlert(input) {
  const { supabase, alertId, resellerId, enterpriseId, actorUserId } = input
  const alertIdValue = String(alertId || '').trim()
  if (!alertIdValue) return toError(400, 'BAD_REQUEST', 'alertId is required.')
  const existing = await loadAlertById(supabase, alertIdValue)
  if (!existing) return toError(404, 'RESOURCE_NOT_FOUND', 'alert not found.')
  const scopeError = validateAlertScope(existing, resellerId, enterpriseId)
  if (scopeError) return scopeError
  if (existing.status !== 'OPEN') {
    return toError(409, 'CONFLICT', 'Only OPEN alerts can be acknowledged.')
  }
  const nowIso = new Date().toISOString()
  await supabase.update('alerts', `alert_id=eq.${encodeURIComponent(alertIdValue)}`, {
    status: 'ACKED',
    acknowledged_at: nowIso,
    acknowledged_by: actorUserId ?? null,
    updated_at: nowIso,
  }, { returning: 'minimal' })
  await recordAlertInternalEvent({
    supabase,
    eventType: 'ALERT_ACKNOWLEDGED',
    enterpriseId: existing.customer_id ?? null,
    resellerId: existing.reseller_id ?? resellerId ?? null,
    actorUserId: actorUserId ?? null,
    payload: {
      alertId: alertIdValue,
      alertType: existing.alert_type ?? null,
      previousStatus: existing.status ?? null,
      status: 'ACKED',
    },
  })
  await recordAlertAuditLog({
    supabase,
    action: 'ALERT_ACKNOWLEDGE',
    targetType: 'ALERT',
    targetId: alertIdValue,
    tenantId: existing.customer_id ?? existing.reseller_id ?? resellerId ?? null,
    actorUserId: actorUserId ?? null,
    actorRole: null,
    beforeData: { status: existing.status ?? null },
    afterData: { status: 'ACKED', acknowledgedAt: nowIso },
  })
  const updatedRows = await supabase.select(
    'alerts',
    `select=alert_id,alert_type,severity,status,rule_id,reseller_id,customer_id,sim_id,threshold,current_value,window_start,window_end,first_seen_at,last_seen_at,acknowledged_at,acknowledged_by,suppressed_until,created_at,updated_at,metadata,sims(iccid)&alert_id=eq.${encodeURIComponent(alertIdValue)}&limit=1`
  )
  const updated = Array.isArray(updatedRows) ? updatedRows[0] : null
  if (!updated) return toError(404, 'RESOURCE_NOT_FOUND', 'alert not found.')
  return {
    ok: true,
    value: {
      alertId: updated.alert_id ?? null,
      alertType: updated.alert_type ?? null,
      severity: updated.severity ?? null,
      status: updated.status ?? null,
      resellerId: updated.reseller_id ?? null,
      enterpriseId: updated.customer_id ?? null,
      simId: updated.sim_id ?? null,
      iccid: updated.sims?.iccid ?? null,
      threshold: toNumberOrNull(updated.threshold),
      currentValue: toNumberOrNull(updated.current_value),
      windowStart: updated.window_start ? new Date(updated.window_start).toISOString() : null,
      windowEnd: updated.window_end ? new Date(updated.window_end).toISOString() : null,
      firstSeenAt: updated.first_seen_at ? new Date(updated.first_seen_at).toISOString() : null,
      lastSeenAt: updated.last_seen_at ? new Date(updated.last_seen_at).toISOString() : null,
      acknowledgedAt: updated.acknowledged_at ? new Date(updated.acknowledged_at).toISOString() : null,
      acknowledgedBy: updated.acknowledged_by ?? null,
      suppressedUntil: updated.suppressed_until ? new Date(updated.suppressed_until).toISOString() : null,
      message: updated.metadata?.message ?? null,
      metadata: updated.metadata ?? null,
      createdAt: updated.created_at ? new Date(updated.created_at).toISOString() : null,
      updatedAt: updated.updated_at ? new Date(updated.updated_at).toISOString() : null,
    },
  }
}

export async function createAlert(input) {
  const {
    supabase,
    alertType,
    severity,
    resellerId,
    customerId,
    simId,
    threshold,
    currentValue,
    windowStart,
    windowEnd,
    ruleId,
    ruleVersion,
    metadata,
    deliveryChannels,
    suppressMinutes,
    subjectKey,
  } = input
  const normalizedType = normalizeAlertType(alertType)
  if (!normalizedType) return toError(400, 'BAD_REQUEST', 'alertType is invalid.')
  const windowStartIso = normalizeIso(windowStart)
  if (!windowStartIso) return toError(400, 'BAD_REQUEST', 'windowStart is invalid.')
  const windowEndIso = windowEnd ? normalizeIso(windowEnd) : null
  const now = new Date()
  const nowIso = now.toISOString()
  const normalizedSubjectKey = subjectKey ? String(subjectKey).trim() : null
  const alertMetadata =
    normalizedSubjectKey && metadata && typeof metadata === 'object'
      ? { ...metadata, subjectKey: normalizedSubjectKey }
      : metadata ?? (normalizedSubjectKey ? { subjectKey: normalizedSubjectKey } : null)
  const suppressWindow = Number.isFinite(suppressMinutes) ? Math.max(0, Number(suppressMinutes)) : 0
  if (suppressWindow > 0) {
    const simFilter = simId ? `sim_id=eq.${encodeURIComponent(simId)}` : 'sim_id=is.null'
    const subjectFilter = normalizedSubjectKey ? `&metadata->>subjectKey=eq.${encodeURIComponent(normalizedSubjectKey)}` : ''
    const lastRows = await supabase.select(
      'alerts',
      `select=alert_id,last_seen_at,suppressed_until&reseller_id=eq.${encodeURIComponent(resellerId)}&${simFilter}&alert_type=eq.${encodeURIComponent(normalizedType)}${subjectFilter}&order=last_seen_at.desc&limit=1`
    )
    const last = Array.isArray(lastRows) ? lastRows[0] : null
    if (last) {
      const suppressedUntil = last.suppressed_until ? new Date(last.suppressed_until).getTime() : null
      if (suppressedUntil && suppressedUntil > now.getTime()) {
        return { ok: true, value: { created: false, alertId: last.alert_id ?? null } }
      }
      const lastSeen = last.last_seen_at ? new Date(last.last_seen_at).getTime() : null
      if (lastSeen && now.getTime() - lastSeen < suppressWindow * 60 * 1000) {
        return { ok: true, value: { created: false, alertId: last.alert_id ?? null } }
      }
    }
  }
  const matchFilters = [
    `reseller_id=eq.${encodeURIComponent(resellerId)}`,
    `alert_type=eq.${encodeURIComponent(normalizedType)}`,
    `window_start=eq.${encodeURIComponent(windowStartIso)}`,
  ]
  if (simId) {
    matchFilters.push(`sim_id=eq.${encodeURIComponent(simId)}`)
  } else {
    matchFilters.push('sim_id=is.null')
  }
  if (normalizedSubjectKey) {
    matchFilters.push(`metadata->>subjectKey=eq.${encodeURIComponent(normalizedSubjectKey)}`)
  }
  const existingRows = await supabase.select(
    'alerts',
    `select=alert_id,status,current_value&${matchFilters.join('&')}&limit=1`
  )
  const existing = Array.isArray(existingRows) ? existingRows[0] : null
  if (existing) {
    const nextStatus = 'OPEN'
    const nextCurrentValue = currentValue ?? null
    const materialChange = isAlertMergeMaterialChange(existing, nextStatus, nextCurrentValue)
    await supabase.update('alerts', `alert_id=eq.${encodeURIComponent(existing.alert_id)}`, {
      severity,
      status: nextStatus,
      threshold: threshold ?? null,
      current_value: nextCurrentValue,
      window_end: windowEndIso ?? null,
      last_seen_at: nowIso,
      updated_at: nowIso,
      metadata: alertMetadata,
      delivery_channels: deliveryChannels ?? null,
    }, { returning: 'minimal' })
    if (materialChange) {
      await recordAlertInternalEvent({
        supabase,
        eventType: 'ALERT_MERGED',
        enterpriseId: customerId ?? null,
        resellerId,
        payload: {
          alertId: existing.alert_id,
          alertType: normalizedType,
          severity,
          customerId: customerId ?? null,
          simId: simId ?? null,
          threshold: threshold ?? null,
          currentValue: nextCurrentValue,
          windowStart: windowStartIso,
          windowEnd: windowEndIso ?? null,
        },
      })
      await recordAlertAuditLog({
        supabase,
        action: 'ALERT_MERGE',
        targetType: 'ALERT',
        targetId: existing.alert_id ?? null,
        tenantId: customerId ?? resellerId,
        actorRole: 'SYSTEM',
        afterData: {
          alertType: normalizedType,
          severity,
          threshold: threshold ?? null,
          currentValue: nextCurrentValue,
          windowStart: windowStartIso,
          windowEnd: windowEndIso ?? null,
        },
      })
    }
    return { ok: true, value: { created: false, alertId: existing.alert_id ?? null } }
  }
  const rows = await supabase.insert('alerts', {
    alert_type: normalizedType,
    severity,
    status: 'OPEN',
    reseller_id: resellerId,
    customer_id: customerId ?? null,
    sim_id: simId ?? null,
    threshold: threshold ?? null,
    current_value: currentValue ?? null,
    window_start: windowStartIso,
    window_end: windowEndIso ?? null,
    first_seen_at: nowIso,
    last_seen_at: nowIso,
    rule_id: ruleId ?? null,
    rule_version: ruleVersion ?? null,
    delivery_channels: deliveryChannels ?? null,
    metadata: alertMetadata,
    created_at: nowIso,
    updated_at: nowIso,
  })
  const row = Array.isArray(rows) ? rows[0] : null
  if (row?.alert_id) {
    try {
      const eventResult = await emitEvent({
        eventType: 'ALERT_TRIGGERED',
        enterpriseId: customerId ?? null,
        resellerId,
        dispatchWebhooks: shouldDispatchAlertWebhook(deliveryChannels),
        payload: {
          alertId: row.alert_id,
          alertType: normalizedType,
          severity,
          customerId: customerId ?? null,
          simId: simId ?? null,
          threshold: threshold ?? null,
          currentValue: currentValue ?? null,
          windowStart: windowStartIso,
          windowEnd: windowEndIso ?? null,
        },
      })
      await recordAlertDeliveries({
        supabase,
        alertId: row.alert_id,
        channels: deliveryChannels,
        eventId: eventResult?.eventId ?? null,
        webhookDeliveryIds: eventResult?.webhookDeliveryIds ?? [],
      })
      await recordAlertAuditLog({
        supabase,
        action: 'ALERT_CREATE',
        targetType: 'ALERT',
        targetId: row.alert_id,
        tenantId: customerId ?? resellerId,
        actorRole: 'SYSTEM',
        afterData: {
          alertType: normalizedType,
          severity,
          customerId: customerId ?? null,
          simId: simId ?? null,
          threshold: threshold ?? null,
          currentValue: currentValue ?? null,
          windowStart: windowStartIso,
          windowEnd: windowEndIso ?? null,
          deliveryChannels: deliveryChannels ?? null,
        },
      })
    } catch {
      return { ok: true, value: { created: true, alertId: row.alert_id } }
    }
  }
  return { ok: true, value: { created: true, alertId: row?.alert_id ?? null } }
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function parseDateOrNull(value) {
  if (!value) return null
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function resolveDeactivatedSince(sim) {
  return (
    parseDateOrNull(sim?.last_status_change_at) ??
    parseDateOrNull(sim?.status_updated_at) ??
    parseDateOrNull(sim?.lifecycle_updated_at) ??
    parseDateOrNull(sim?.updated_at) ??
    parseDateOrNull(sim?.activation_date) ??
    parseDateOrNull(sim?.created_at)
  )
}

function resolveResellerId(enterpriseId, enterpriseResellerMap, defaultResellerId) {
  if (!enterpriseId) return defaultResellerId
  return enterpriseResellerMap.get(enterpriseId) ?? defaultResellerId
}

function mapRuleConfigRow(row) {
  if (!row) return null
  return {
    configId: row.config_id ?? null,
    enabled: row.enabled !== false,
    severity: row.severity ? String(row.severity) : null,
    thresholdValue: Number.isFinite(Number(row.threshold_value)) ? Number(row.threshold_value) : null,
    thresholdUnit: row.threshold_unit ? String(row.threshold_unit) : null,
    windowMinutes: Number.isFinite(Number(row.window_minutes)) ? Number(row.window_minutes) : null,
    suppressMinutes: Number.isFinite(Number(row.suppress_minutes)) ? Number(row.suppress_minutes) : null,
    deliveryChannels: Array.isArray(row.delivery_channels) ? row.delivery_channels.map(String) : null,
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : null,
  }
}

function mapConfigItemRow(row) {
  if (!row) return null
  return {
    configId: row.config_item_id ?? null,
    enabled: row.enabled !== false,
    severity: row.severity ? String(row.severity) : null,
    thresholdValue: Number.isFinite(Number(row.threshold_value)) ? Number(row.threshold_value) : null,
    thresholdUnit: row.threshold_unit ? String(row.threshold_unit) : null,
    windowMinutes: Number.isFinite(Number(row.window_minutes)) ? Number(row.window_minutes) : null,
    suppressMinutes: Number.isFinite(Number(row.suppress_minutes)) ? Number(row.suppress_minutes) : null,
    deliveryChannels: Array.isArray(row.delivery_channels) ? row.delivery_channels.map(String) : null,
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : null,
  }
}

async function loadActiveAlertConfigProfile({ supabase, scopeType, resellerId, enterpriseId }) {
  const filters = [
    `scope_type=eq.${encodeURIComponent(scopeType)}`,
    'status=eq.ACTIVE',
  ]
  if (scopeType === 'PLATFORM') {
    filters.push('reseller_id=is.null', 'enterprise_id=is.null')
  } else if (scopeType === 'RESELLER') {
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`, 'enterprise_id=is.null')
  } else {
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
    filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  }
  try {
    const rows = await supabase.select(
      'alert_config_profiles',
      `select=config_profile_id&${filters.join('&')}&limit=1`,
      { suppressMissingColumns: true }
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row?.config_profile_id ? String(row.config_profile_id) : null
  } catch (err) {
    if (isMissingRelationError(err, 'alert_config_profiles')) return null
    throw err
  }
}

async function loadConfigItemRow({ supabase, profileId, alertType }) {
  if (!profileId) return null
  try {
    const rows = await supabase.select(
      'alert_config_items',
      `select=config_item_id,enabled,severity,threshold_value,threshold_unit,window_minutes,suppress_minutes,delivery_channels,version&config_profile_id=eq.${encodeURIComponent(profileId)}&alert_type=eq.${encodeURIComponent(alertType)}&limit=1`,
      { suppressMissingColumns: true }
    )
    return mapConfigItemRow(Array.isArray(rows) ? rows[0] : null)
  } catch (err) {
    if (isMissingRelationError(err, 'alert_config_items')) return null
    throw err
  }
}

async function loadAbcRuleConfigRow({ supabase, scopeType, alertType, resellerId, enterpriseId }) {
  const profileId = await loadActiveAlertConfigProfile({ supabase, scopeType, resellerId, enterpriseId })
  return loadConfigItemRow({ supabase, profileId, alertType })
}

async function loadRuleConfigRow({ supabase, scopeType, alertType, resellerId, enterpriseId }) {
  const filters = [
    `scope_type=eq.${encodeURIComponent(scopeType)}`,
    `alert_type=eq.${encodeURIComponent(alertType)}`,
  ]
  if (scopeType === 'PLATFORM') {
    filters.push('reseller_id=is.null', 'enterprise_id=is.null')
  } else if (scopeType === 'RESELLER') {
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`, 'enterprise_id=is.null')
  } else {
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
    filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  }
  try {
    const rows = await supabase.select(
      'alert_rule_configs',
      `select=config_id,enabled,severity,threshold_value,threshold_unit,window_minutes,suppress_minutes,delivery_channels,version&${filters.join('&')}&limit=1`,
      { suppressMissingColumns: true }
    )
    return mapRuleConfigRow(Array.isArray(rows) ? rows[0] : null)
  } catch (err) {
    // Legacy Phase-43 table; remote may only have ABC model. Missing table → fall through to env defaults.
    if (isMissingRelationError(err, 'alert_rule_configs')) return null
    throw err
  }
}

async function resolveEffectiveRuleForEvaluation({
  supabase,
  alertType,
  resellerId,
  enterpriseId,
  fallback,
}) {
  let row = null
  if (enterpriseId && resellerId) {
    row = await loadAbcRuleConfigRow({ supabase, scopeType: 'ENTERPRISE', alertType, resellerId, enterpriseId })
    if (row) return row.enabled ? { ...fallback, ...row } : null
    row = await loadRuleConfigRow({ supabase, scopeType: 'ENTERPRISE', alertType, resellerId, enterpriseId })
    if (row) return row.enabled ? { ...fallback, ...row } : null
  }
  if (resellerId) {
    row = await loadAbcRuleConfigRow({ supabase, scopeType: 'RESELLER', alertType, resellerId })
    if (row) return row.enabled ? { ...fallback, ...row } : null
    row = await loadRuleConfigRow({ supabase, scopeType: 'RESELLER', alertType, resellerId })
    if (row) return row.enabled ? { ...fallback, ...row } : null
  }
  row = await loadAbcRuleConfigRow({ supabase, scopeType: 'PLATFORM', alertType, resellerId: null, enterpriseId: null })
  if (row) return row.enabled ? { ...fallback, ...row } : null
  row = await loadRuleConfigRow({ supabase, scopeType: 'PLATFORM', alertType, resellerId: null, enterpriseId: null })
  if (row) return row.enabled ? { ...fallback, ...row } : null
  return fallback
}

function effectiveThreshold(rule, fallback) {
  const raw = rule?.thresholdValue
  if (raw === null || raw === undefined || raw === '') return Number(fallback)
  const n = Number(raw)
  return Number.isFinite(n) ? n : Number(fallback)
}

/** Normalize configured data-volume threshold to MB (evaluator OOP metrics are MB). */
function thresholdValueToMb(value, unit) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const u = String(unit || 'MB').trim().toUpperCase()
  if (u === 'KB') return n / 1024
  if (u === 'GB') return n * 1024
  return n
}

function usageMbFromRow(row) {
  const directMb = Number(row?.in_profile_mb ?? row?.charged_mb ?? row?.total_mb)
  if (Number.isFinite(directMb)) return Math.max(0, directMb)
  const kb = Number(row?.in_profile_kb ?? row?.charged_kb ?? row?.total_kb)
  if (Number.isFinite(kb)) return Math.max(0, kb / 1024)
  return 0
}

function metricMbFromRow(row, mbField, kbField) {
  const mb = Number(row?.[mbField])
  if (Number.isFinite(mb)) return Math.max(0, mb)
  const kb = Number(row?.[kbField])
  if (Number.isFinite(kb)) return Math.max(0, kb / 1024)
  return 0
}

function planTypeOf(plan) {
  const raw = String(plan?.type ?? plan?.price_plan_type ?? '').trim().toUpperCase()
  return raw === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : raw
}

function quotaMbForPlan(plan, activeSimCount) {
  const type = planTypeOf(plan)
  if (type === 'ONE_TIME') {
    const quota = Number(plan?.quota_mb)
    return Number.isFinite(quota) && quota > 0 ? quota : null
  }
  if (type === 'SIM_DEPENDENT_BUNDLE') {
    const perSim = Number(plan?.per_sim_quota_mb)
    return Number.isFinite(perSim) && perSim > 0 ? perSim * Math.max(1, Number(activeSimCount) || 0) : null
  }
  if (type === 'FIXED_BUNDLE') {
    const quota = Number(plan?.total_quota_mb)
    return Number.isFinite(quota) && quota > 0 ? quota : null
  }
  return null
}

function parseTierList(tiers) {
  if (Array.isArray(tiers)) return tiers
  if (typeof tiers === 'string' && tiers.trim()) {
    try {
      const parsed = JSON.parse(tiers)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function tierLimitMb(tier) {
  const candidates = [
    tier?.toMb,
    tier?.maxMb,
    tier?.upperBoundMb,
    tier?.thresholdMb,
    tier?.quotaMb,
    tier?.to,
    tier?.max,
    tier?.upperBound,
  ]
  for (const value of candidates) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

function buildPoolUsageCandidates({
  packageUsage,
  packageSimUsage,
  packagePlans,
  packageEnterprise,
  packageSimCounts,
  thresholdPercent,
}) {
  const candidates = []
  for (const [packageId, plan] of packagePlans.entries()) {
    const planType = planTypeOf(plan)
    if (!planType) continue
    const enterpriseId = packageEnterprise.get(packageId) ?? plan?.enterprise_id ?? null
    if (!enterpriseId) continue
    if (planType === 'ONE_TIME') {
      const simUsage = packageSimUsage.get(packageId) ?? new Map()
      const quotaMb = quotaMbForPlan(plan, 1)
      if (!quotaMb) continue
      for (const [simId, usedMb] of simUsage.entries()) {
        const usageRatio = quotaMb > 0 ? (Number(usedMb) / quotaMb) * 100 : 0
        if (usageRatio < thresholdPercent) continue
        candidates.push({
          enterpriseId: String(enterpriseId),
          packageId,
          pricePlanId: plan?.price_plan_id ? String(plan.price_plan_id) : null,
          pricePlanType: planType,
          simId,
          subjectKey: `package:${packageId}:sim:${simId}`,
          usedMb: Number(usedMb),
          quotaMb,
          usageRatio,
          tierIndex: null,
          tierLimitMb: null,
        })
      }
      continue
    }
    const usedMb = Number(packageUsage.get(packageId) || 0)
    if (planType === 'SIM_DEPENDENT_BUNDLE' || planType === 'FIXED_BUNDLE') {
      const quotaMb = quotaMbForPlan(plan, packageSimCounts.get(packageId) ?? 0)
      if (!quotaMb) continue
      const usageRatio = quotaMb > 0 ? (usedMb / quotaMb) * 100 : 0
      if (usageRatio < thresholdPercent) continue
      candidates.push({
        enterpriseId: String(enterpriseId),
        packageId,
        pricePlanId: plan?.price_plan_id ? String(plan.price_plan_id) : null,
        pricePlanType: planType,
        simId: null,
        subjectKey: `package:${packageId}:pool`,
        usedMb,
        quotaMb,
        usageRatio,
        tierIndex: null,
        tierLimitMb: null,
      })
      continue
    }
    if (planType === 'TIERED_VOLUME_PRICING') {
      const tiers = parseTierList(plan?.tiers)
      tiers.forEach((tier, index) => {
        const limitMb = tierLimitMb(tier)
        if (!limitMb) return
        const tierThresholdMb = limitMb * (thresholdPercent / 100)
        if (usedMb < tierThresholdMb) return
        candidates.push({
          enterpriseId: String(enterpriseId),
          packageId,
          pricePlanId: plan?.price_plan_id ? String(plan.price_plan_id) : null,
          pricePlanType: planType,
          simId: null,
          subjectKey: `package:${packageId}:tier:${index + 1}`,
          usedMb,
          quotaMb: limitMb,
          usageRatio: (usedMb / limitMb) * 100,
          tierIndex: index + 1,
          tierLimitMb: limitMb,
        })
      })
    }
  }
  return candidates
}

export async function runAlertEvaluation(input) {
  const { supabase, now, options } = input
  const currentTime = now ? new Date(now) : new Date()
  const config = await getAlertThresholdConfig({
    supabase,
    cacheTtlSeconds: Number.isFinite(options?.configCacheSeconds) ? Math.max(0, Number(options.configCacheSeconds)) : 60,
  })
  const defaultWindowMinutes = Number.isFinite(options?.windowMinutes) ? Math.max(1, Number(options.windowMinutes)) : 60
  const defaultSuppressMinutes = Number.isFinite(options?.suppressMinutes) ? Math.max(0, Number(options.suppressMinutes)) : 30
  const windowByReseller = normalizeNumberMap(options?.windowMinutesByReseller)
  const windowByEnterprise = normalizeNumberMap(options?.windowMinutesByEnterprise)
  const suppressByReseller = normalizeNumberMap(options?.suppressMinutesByReseller)
  const suppressByEnterprise = normalizeNumberMap(options?.suppressMinutesByEnterprise)
  const defaultPoolThresholdPercent = resolveDefaultValue(
    config?.thresholds?.POOL_USAGE_HIGH?.global,
    Number.isFinite(options?.poolUsageHighThresholdPercent) ? Math.max(0, Number(options.poolUsageHighThresholdPercent)) : 80
  )
  const fallbackOutProfilePercent = Number.isFinite(options?.outOfProfileSurgeThresholdPercent)
    ? Math.max(0, Number(options.outOfProfileSurgeThresholdPercent))
    : Number.isFinite(options?.outOfProfileSurgeThresholdKb) && Number(options.outOfProfileSurgeThresholdKb) <= 100
      ? Math.max(0, Number(options.outOfProfileSurgeThresholdKb))
      : 20
  const defaultOutProfileThresholdPercent = resolveDefaultValue(
    config?.thresholds?.OUT_OF_PROFILE_SURGE?.global,
    fallbackOutProfilePercent
  )
  const defaultSilentHours = resolveDefaultValue(
    config?.thresholds?.SILENT_SIM?.global,
    Number.isFinite(options?.silentSimThresholdHours) ? Math.max(1, Number(options.silentSimThresholdHours)) : 4320
  )
  const defaultCdrDelayHours = resolveDefaultValue(
    config?.thresholds?.CDR_DELAY?.global,
    Number.isFinite(options?.cdrDelayThresholdHours) ? Math.max(1, Number(options.cdrDelayThresholdHours)) : 48
  )
  const defaultUpstreamDisconnectAttempts = resolveDefaultValue(
    config?.thresholds?.UPSTREAM_DISCONNECT?.global,
    Number.isFinite(options?.upstreamDisconnectThresholdAttempts)
      ? Math.max(1, Number(options.upstreamDisconnectThresholdAttempts))
      : Number.isFinite(options?.upstreamDisconnectThresholdHours)
        ? Math.max(1, Number(options.upstreamDisconnectThresholdHours))
        : 3
  )
  const poolThresholdByReseller = mergeNumberMap(
    config?.thresholds?.POOL_USAGE_HIGH?.byReseller,
    normalizeNumberMap(options?.poolUsageHighThresholdPercentByReseller)
  )
  const poolThresholdByEnterprise = mergeNumberMap(
    config?.thresholds?.POOL_USAGE_HIGH?.byEnterprise,
    normalizeNumberMap(options?.poolUsageHighThresholdPercentByEnterprise)
  )
  const outProfileThresholdByReseller = mergeNumberMap(
    config?.thresholds?.OUT_OF_PROFILE_SURGE?.byReseller,
    normalizeNumberMap(options?.outOfProfileSurgeThresholdPercentByReseller ?? options?.outOfProfileSurgeThresholdKbByReseller)
  )
  const outProfileThresholdByEnterprise = mergeNumberMap(
    config?.thresholds?.OUT_OF_PROFILE_SURGE?.byEnterprise,
    normalizeNumberMap(options?.outOfProfileSurgeThresholdPercentByEnterprise ?? options?.outOfProfileSurgeThresholdKbByEnterprise)
  )
  const silentHoursByReseller = mergeNumberMap(
    config?.thresholds?.SILENT_SIM?.byReseller,
    normalizeNumberMap(options?.silentSimThresholdHoursByReseller)
  )
  const silentHoursByEnterprise = mergeNumberMap(
    config?.thresholds?.SILENT_SIM?.byEnterprise,
    normalizeNumberMap(options?.silentSimThresholdHoursByEnterprise)
  )
  const cdrDelayHoursByReseller = mergeNumberMap(
    config?.thresholds?.CDR_DELAY?.byReseller,
    normalizeNumberMap(options?.cdrDelayThresholdHoursByReseller)
  )
  const cdrDelayHoursByEnterprise = mergeNumberMap(
    config?.thresholds?.CDR_DELAY?.byEnterprise,
    normalizeNumberMap(options?.cdrDelayThresholdHoursByEnterprise)
  )
  const upstreamDisconnectAttemptsByReseller = mergeNumberMap(
    config?.thresholds?.UPSTREAM_DISCONNECT?.byReseller,
    normalizeNumberMap(options?.upstreamDisconnectThresholdAttemptsByReseller ?? options?.upstreamDisconnectThresholdHoursByReseller)
  )
  const upstreamDisconnectAttemptsByEnterprise = mergeNumberMap(
    config?.thresholds?.UPSTREAM_DISCONNECT?.byEnterprise,
    normalizeNumberMap(options?.upstreamDisconnectThresholdAttemptsByEnterprise ?? options?.upstreamDisconnectThresholdHoursByEnterprise)
  )
  const maxWindowMinutes = Math.max(
    defaultWindowMinutes,
    maxMapValue(windowByReseller),
    maxMapValue(windowByEnterprise)
  )
  const windowEndIso = currentTime.toISOString()
  const periodStartDay = `${currentTime.getUTCFullYear()}-${String(currentTime.getUTCMonth() + 1).padStart(2, '0')}-01`
  const startDay = toDateOnly(new Date(currentTime.getTime() - maxWindowMinutes * 60 * 1000))
  const endDay = toDateOnly(currentTime)
  const tenantRows = await supabase.select('tenants', 'select=tenant_id,parent_id,tenant_type')
  const tenants = Array.isArray(tenantRows) ? tenantRows : []
  const enterpriseResellerMap = new Map()
  const resellerIds = []
  for (const row of tenants) {
    const tenantId = row?.tenant_id ? String(row.tenant_id) : null
    if (!tenantId) continue
    const tenantType = row?.tenant_type ? String(row.tenant_type) : ''
    if (tenantType === 'RESELLER') resellerIds.push(tenantId)
    if (tenantType === 'ENTERPRISE') {
      const parentId = row?.parent_id ? String(row.parent_id) : null
      if (parentId) enterpriseResellerMap.set(tenantId, parentId)
    }
  }
  const defaultResellerId = resellerIds.length ? resellerIds[0] : null
  const simRows = await supabase.select(
    'sims',
    'select=sim_id,enterprise_id,operator_id,status,activation_date,last_status_change_at,created_at,upstream_status,upstream_status_updated_at'
  )
  const sims = Array.isArray(simRows) ? simRows : []
  const simMap = new Map()
  for (const row of sims) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    if (!simId) continue
    simMap.set(simId, row)
  }
  const usageRows = await supabase.select(
    'usage_daily_summary',
    `select=sim_id,enterprise_id,usage_day,total_mb,in_profile_mb,out_of_profile_mb,unclassified_mb,rated_at,visited_mccmnc&usage_day=gte.${encodeURIComponent(startDay)}&usage_day=lte.${encodeURIComponent(endDay)}&limit=10000`
  )
  const usage = Array.isArray(usageRows) ? usageRows : []
  const usageByEnterprise = new Map()
  const usageBySim = new Map()
  const lastUsageBySim = new Map()
  const visitedNetworksBySim = new Map()
  for (const row of usage) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    const enterpriseId = row?.enterprise_id ? String(row.enterprise_id) : null
    const totalKbRaw = Number(row?.total_kb)
    const totalMbRaw = Number(row?.total_mb)
    const totalKb = Number.isFinite(totalKbRaw) ? totalKbRaw : Number.isFinite(totalMbRaw) ? totalMbRaw * 1024 : 0
    if (enterpriseId) {
      const current = usageByEnterprise.get(enterpriseId) || 0
      usageByEnterprise.set(enterpriseId, current + totalKb)
    }
    if (simId) {
      const current = usageBySim.get(simId) || 0
      usageBySim.set(simId, current + totalKb)
      const usageDay = row?.usage_day ? new Date(String(row.usage_day)) : null
      if (usageDay && !Number.isNaN(usageDay.getTime())) {
        const prev = lastUsageBySim.get(simId)
        if (!prev || usageDay.getTime() > prev.getTime()) {
          lastUsageBySim.set(simId, usageDay)
        }
      }
      const visited = row?.visited_mccmnc ? String(row.visited_mccmnc).trim() : null
      if (visited) {
        if (!visitedNetworksBySim.has(simId)) visitedNetworksBySim.set(simId, new Set())
        visitedNetworksBySim.get(simId).add(visited)
      }
    }
  }
  const subscriptionRows = await supabase.select(
    'subscriptions',
    'select=subscription_id,sim_id,enterprise_id,package_id,subscription_kind,state&state=eq.ACTIVE&limit=10000'
  )
  const subscriptions = Array.isArray(subscriptionRows) ? subscriptionRows : []
  const activeSubscriptionsBySim = new Map()
  const packageSimCounts = new Map()
  const packageEnterprise = new Map()
  for (const row of subscriptions) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    const packageId = row?.package_id ? String(row.package_id) : null
    const enterpriseId = row?.enterprise_id ? String(row.enterprise_id) : null
    if (!simId || !packageId) continue
    const existing = activeSubscriptionsBySim.get(simId)
    const kind = String(row?.subscription_kind ?? '').toUpperCase()
    if (!existing || kind === 'MAIN') activeSubscriptionsBySim.set(simId, row)
    if (!packageSimCounts.has(packageId)) packageSimCounts.set(packageId, new Set())
    packageSimCounts.get(packageId).add(simId)
    if (enterpriseId && !packageEnterprise.has(packageId)) packageEnterprise.set(packageId, enterpriseId)
  }

  const usagePackageRows = await supabase.select(
    'usage_package_daily_summary',
    `select=reseller_id,enterprise_id,sim_id,usage_day,visited_mccmnc,subscription_id,package_id,price_plan_id,price_plan_type,in_profile_mb,out_of_profile_mb,unclassified_mb&usage_day=gte.${encodeURIComponent(periodStartDay)}&usage_day=lte.${encodeURIComponent(endDay)}&limit=10000`,
    { suppressMissingColumns: true }
  )
  const usagePackageSummary = Array.isArray(usagePackageRows) ? usagePackageRows : []
  const ratingRows = await supabase.select(
    'rating_results',
    `select=sim_id,enterprise_id,matched_package_id,matched_price_plan_id,usage_day,classification,charged_mb&classification=in.(IN_PACKAGE,OVERAGE,TIERED_VOLUME)&usage_day=gte.${encodeURIComponent(periodStartDay)}&usage_day=lte.${encodeURIComponent(endDay)}&limit=10000`
  )
  const inProfileRatings = Array.isArray(ratingRows) ? ratingRows : []
  const packageUsage = new Map()
  const packageSimUsage = new Map()
  const outProfilePackageUsage = new Map()
  const outProfilePackageSimUsage = new Map()
  const packagePricePlanHints = new Map()
  const unexpectedRoamingBySim = new Map()
  const recordUnexpectedRoaming = (row, outProfileMb, packageId = null, pricePlanId = null, pricePlanType = null) => {
    const simId = row?.sim_id ? String(row.sim_id) : null
    if (!simId || outProfileMb <= 0) return
    const existing = unexpectedRoamingBySim.get(simId) || {
      simId,
      enterpriseId: row?.enterprise_id ? String(row.enterprise_id) : null,
      outProfileMb: 0,
      packageIds: new Set(),
      pricePlanIds: new Set(),
      pricePlanTypes: new Set(),
      usageDays: new Set(),
      visitedMccMncs: new Set(),
    }
    existing.outProfileMb += outProfileMb
    if (!existing.enterpriseId && row?.enterprise_id) existing.enterpriseId = String(row.enterprise_id)
    if (packageId) existing.packageIds.add(packageId)
    if (pricePlanId) existing.pricePlanIds.add(pricePlanId)
    if (pricePlanType) existing.pricePlanTypes.add(pricePlanType)
    if (row?.usage_day) existing.usageDays.add(String(row.usage_day))
    if (row?.visited_mccmnc) existing.visitedMccMncs.add(String(row.visited_mccmnc))
    unexpectedRoamingBySim.set(simId, existing)
  }
  if (usagePackageSummary.length) {
    for (const row of usagePackageSummary) {
      const packageId = row?.package_id ? String(row.package_id) : null
      if (!packageId) continue
      const simId = row?.sim_id ? String(row.sim_id) : null
      const inProfileMb = metricMbFromRow(row, 'in_profile_mb', 'in_profile_kb')
      const outProfileMb = metricMbFromRow(row, 'out_of_profile_mb', 'out_of_profile_kb')
      if (inProfileMb > 0) {
        packageUsage.set(packageId, Number(packageUsage.get(packageId) || 0) + inProfileMb)
        if (simId) {
          if (!packageSimUsage.has(packageId)) packageSimUsage.set(packageId, new Map())
          const simUsage = packageSimUsage.get(packageId)
          simUsage.set(simId, Number(simUsage.get(simId) || 0) + inProfileMb)
        }
      }
      if (outProfileMb > 0) {
        outProfilePackageUsage.set(packageId, Number(outProfilePackageUsage.get(packageId) || 0) + outProfileMb)
        if (simId) {
          if (!outProfilePackageSimUsage.has(packageId)) outProfilePackageSimUsage.set(packageId, new Map())
          const simUsage = outProfilePackageSimUsage.get(packageId)
          simUsage.set(simId, Number(simUsage.get(simId) || 0) + outProfileMb)
        }
        recordUnexpectedRoaming(
          row,
          outProfileMb,
          packageId,
          row?.price_plan_id ? String(row.price_plan_id) : null,
          row?.price_plan_type ? String(row.price_plan_type) : null
        )
      }
      if (row?.enterprise_id && !packageEnterprise.has(packageId)) packageEnterprise.set(packageId, String(row.enterprise_id))
      if (row?.price_plan_id && !packagePricePlanHints.has(packageId)) {
        packagePricePlanHints.set(packageId, String(row.price_plan_id))
      }
    }
  } else if (inProfileRatings.length) {
    for (const row of inProfileRatings) {
      const packageId = row?.matched_package_id ? String(row.matched_package_id) : null
      if (!packageId) continue
      const simId = row?.sim_id ? String(row.sim_id) : null
      const usedMb = usageMbFromRow(row)
      packageUsage.set(packageId, Number(packageUsage.get(packageId) || 0) + usedMb)
      if (simId) {
        if (!packageSimUsage.has(packageId)) packageSimUsage.set(packageId, new Map())
        const simUsage = packageSimUsage.get(packageId)
        simUsage.set(simId, Number(simUsage.get(simId) || 0) + usedMb)
      }
      if (row?.enterprise_id && !packageEnterprise.has(packageId)) packageEnterprise.set(packageId, String(row.enterprise_id))
      if (row?.matched_price_plan_id && !packagePricePlanHints.has(packageId)) {
        packagePricePlanHints.set(packageId, String(row.matched_price_plan_id))
      }
    }
  } else {
    for (const row of usage) {
      const simId = row?.sim_id ? String(row.sim_id) : null
      if (!simId) continue
      const sub = activeSubscriptionsBySim.get(simId)
      const packageId = sub?.package_id ? String(sub.package_id) : null
      if (!packageId) continue
      const usedMb = usageMbFromRow(row)
      packageUsage.set(packageId, Number(packageUsage.get(packageId) || 0) + usedMb)
      const outProfileMb = metricMbFromRow(row, 'out_of_profile_mb', 'out_of_profile_kb')
      if (outProfileMb > 0) {
        outProfilePackageUsage.set(packageId, Number(outProfilePackageUsage.get(packageId) || 0) + outProfileMb)
        if (!outProfilePackageSimUsage.has(packageId)) outProfilePackageSimUsage.set(packageId, new Map())
        const outSimUsage = outProfilePackageSimUsage.get(packageId)
        outSimUsage.set(simId, Number(outSimUsage.get(simId) || 0) + outProfileMb)
        recordUnexpectedRoaming(row, outProfileMb, packageId, sub?.price_plan_id ? String(sub.price_plan_id) : null, null)
      }
      if (!packageSimUsage.has(packageId)) packageSimUsage.set(packageId, new Map())
      const simUsage = packageSimUsage.get(packageId)
      simUsage.set(simId, Number(simUsage.get(simId) || 0) + usedMb)
      const enterpriseId = sub?.enterprise_id ? String(sub.enterprise_id) : row?.enterprise_id ? String(row.enterprise_id) : null
      if (enterpriseId && !packageEnterprise.has(packageId)) packageEnterprise.set(packageId, enterpriseId)
    }
  }
  for (const [packageId, simSet] of packageSimCounts.entries()) {
    packageSimCounts.set(packageId, simSet.size)
  }
  const packageIds = Array.from(new Set([...packageUsage.keys(), ...outProfilePackageUsage.keys(), ...packageEnterprise.keys()]))
  const packagePricePlanIds = new Map()
  if (packageIds.length) {
    const packageRows = await supabase.select(
      'packages',
      `select=package_id,enterprise_id,price_plan_id&package_id=in.(${packageIds.map((id) => encodeURIComponent(id)).join(',')})`
    )
    const packages = Array.isArray(packageRows) ? packageRows : []
    for (const row of packages) {
      const packageId = row?.package_id ? String(row.package_id) : null
      if (!packageId) continue
      if (row?.enterprise_id && !packageEnterprise.has(packageId)) packageEnterprise.set(packageId, String(row.enterprise_id))
      const pricePlanId = row?.price_plan_id ? String(row.price_plan_id) : packagePricePlanHints.get(packageId)
      if (pricePlanId) packagePricePlanIds.set(packageId, pricePlanId)
    }
  }
  for (const [packageId, pricePlanId] of packagePricePlanHints.entries()) {
    if (!packagePricePlanIds.has(packageId)) packagePricePlanIds.set(packageId, pricePlanId)
  }
  const pricePlanIds = Array.from(new Set(packagePricePlanIds.values()))
  const pricePlanMap = new Map()
  if (pricePlanIds.length) {
    const pricePlanRows = await supabase.select(
      'price_plans_expanded',
      `select=price_plan_id,enterprise_id,type,quota_mb,per_sim_quota_mb,total_quota_mb,tiers&price_plan_id=in.(${pricePlanIds.map((id) => encodeURIComponent(id)).join(',')})`
    )
    const pricePlans = Array.isArray(pricePlanRows) ? pricePlanRows : []
    for (const row of pricePlans) {
      const pricePlanId = row?.price_plan_id ? String(row.price_plan_id) : null
      if (pricePlanId) pricePlanMap.set(pricePlanId, row)
    }
  }
  const packagePlans = new Map()
  for (const [packageId, pricePlanId] of packagePricePlanIds.entries()) {
    const plan = pricePlanMap.get(pricePlanId)
    if (plan) packagePlans.set(packageId, plan)
  }
  let createdCount = 0
  let skippedCount = 0
  let errorCount = 0
  const poolThresholdForEnterprise = (enterpriseId, resellerId) => resolveThreshold({
    enterpriseId,
    resellerId,
    defaultValue: defaultPoolThresholdPercent,
    byEnterprise: poolThresholdByEnterprise,
    byReseller: poolThresholdByReseller,
  })
  const poolCandidates = buildPoolUsageCandidates({
    packageUsage,
    packageSimUsage,
    packagePlans,
    packageEnterprise,
    packageSimCounts,
    thresholdPercent: 0,
  })
  for (const candidate of poolCandidates) {
    const enterpriseId = candidate.enterpriseId
    if (!defaultResellerId && !enterpriseResellerMap.get(enterpriseId)) continue
    const resellerId = resolveResellerId(enterpriseId, enterpriseResellerMap, defaultResellerId)
    if (!resellerId) continue
    const policy = resolvePolicy({
      enterpriseId,
      resellerId,
      defaultWindowMinutes,
      defaultSuppressMinutes,
      windowByEnterprise,
      windowByReseller,
      suppressByEnterprise,
      suppressByReseller,
    })
    const poolThresholdPercent = poolThresholdForEnterprise(enterpriseId, resellerId)
    const rule = await resolveEffectiveRuleForEvaluation({
      supabase,
      alertType: 'POOL_USAGE_HIGH',
      resellerId,
      enterpriseId,
      fallback: {
        severity: 'P2',
        thresholdValue: poolThresholdPercent,
        thresholdUnit: 'PERCENT',
        windowMinutes: policy.windowMinutes,
        suppressMinutes: policy.suppressMinutes,
        deliveryChannels: null,
      },
    })
    if (!rule) {
      skippedCount += 1
      continue
    }
    const effectivePoolThresholdPercent = effectiveThreshold(rule, poolThresholdPercent)
    if (candidate.usageRatio < effectivePoolThresholdPercent) continue
    const windowStartIso = new Date(currentTime.getTime() - Number(rule.windowMinutes ?? policy.windowMinutes) * 60 * 1000).toISOString()
    const result = await createAlert({
      supabase,
      alertType: 'POOL_USAGE_HIGH',
      severity: rule.severity ?? 'P2',
      resellerId,
      customerId: enterpriseId,
      simId: candidate.simId,
      threshold: effectivePoolThresholdPercent,
      currentValue: Number(candidate.usageRatio.toFixed(2)),
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      ruleId: rule.configId ?? null,
      ruleVersion: rule.version ?? null,
      subjectKey: candidate.subjectKey,
      metadata: {
        message: 'Package in-profile usage exceeded configured quota percentage threshold.',
        packageId: candidate.packageId,
        pricePlanId: candidate.pricePlanId,
        pricePlanType: candidate.pricePlanType,
        simId: candidate.simId,
        usedMb: Number(candidate.usedMb.toFixed(3)),
        quotaMb: candidate.quotaMb,
        usageRatio: Number(candidate.usageRatio.toFixed(2)),
        thresholdPercent: effectivePoolThresholdPercent,
        thresholdUnit: 'PERCENT',
        tierIndex: candidate.tierIndex,
        tierLimitMb: candidate.tierLimitMb,
      },
      deliveryChannels: rule.deliveryChannels ?? null,
      suppressMinutes: rule.suppressMinutes ?? policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  const outProfileCandidates = buildPoolUsageCandidates({
    packageUsage: outProfilePackageUsage,
    packageSimUsage: outProfilePackageSimUsage,
    packagePlans,
    packageEnterprise,
    packageSimCounts,
    thresholdPercent: 0,
  })
  for (const candidate of outProfileCandidates) {
    const enterpriseId = candidate.enterpriseId
    if (!defaultResellerId && !enterpriseResellerMap.get(enterpriseId)) continue
    const resellerId = resolveResellerId(enterpriseId, enterpriseResellerMap, defaultResellerId)
    if (!resellerId) continue
    const policy = resolvePolicy({
      enterpriseId,
      resellerId,
      defaultWindowMinutes,
      defaultSuppressMinutes,
      windowByEnterprise,
      windowByReseller,
      suppressByEnterprise,
      suppressByReseller,
    })
    const outProfileThresholdPercent = resolveThreshold({
      enterpriseId,
      resellerId,
      defaultValue: defaultOutProfileThresholdPercent,
      byEnterprise: outProfileThresholdByEnterprise,
      byReseller: outProfileThresholdByReseller,
    })
    const rule = await resolveEffectiveRuleForEvaluation({
      supabase,
      alertType: 'OUT_OF_PROFILE_SURGE',
      resellerId,
      enterpriseId,
      fallback: {
        severity: 'P2',
        thresholdValue: outProfileThresholdPercent,
        thresholdUnit: 'PERCENT',
        windowMinutes: policy.windowMinutes,
        suppressMinutes: policy.suppressMinutes,
        deliveryChannels: null,
      },
    })
    if (!rule) {
      skippedCount += 1
      continue
    }
    const effectiveOutProfileThresholdPercent = effectiveThreshold(rule, outProfileThresholdPercent)
    if (candidate.usageRatio < effectiveOutProfileThresholdPercent) continue
    const windowStartIso = `${periodStartDay}T00:00:00.000Z`
    const result = await createAlert({
      supabase,
      alertType: 'OUT_OF_PROFILE_SURGE',
      severity: rule.severity ?? 'P2',
      resellerId,
      customerId: enterpriseId,
      simId: candidate.simId,
      threshold: effectiveOutProfileThresholdPercent,
      currentValue: Number(candidate.usageRatio.toFixed(2)),
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      ruleId: rule.configId ?? null,
      ruleVersion: rule.version ?? null,
      subjectKey: `out:${candidate.subjectKey}`,
      metadata: {
        message: 'Package out-of-profile usage exceeded configured quota percentage threshold.',
        packageId: candidate.packageId,
        pricePlanId: candidate.pricePlanId,
        pricePlanType: candidate.pricePlanType,
        simId: candidate.simId,
        outOfProfileMb: Number(candidate.usedMb.toFixed(3)),
        quotaMb: candidate.quotaMb,
        usageRatio: Number(candidate.usageRatio.toFixed(2)),
        thresholdPercent: effectiveOutProfileThresholdPercent,
        thresholdUnit: 'PERCENT',
        tierIndex: candidate.tierIndex,
        tierLimitMb: candidate.tierLimitMb,
        periodStart: periodStartDay,
        periodEnd: endDay,
      },
      deliveryChannels: rule.deliveryChannels ?? null,
      suppressMinutes: rule.suppressMinutes ?? policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  for (const sim of sims) {
    const simId = sim?.sim_id ? String(sim.sim_id) : null
    if (!simId) continue
    if (String(sim?.status || '').toUpperCase() !== 'DEACTIVATED') continue
    const deactivatedSince = resolveDeactivatedSince(sim)
    if (!deactivatedSince) continue
    const enterpriseId = sim?.enterprise_id ? String(sim.enterprise_id) : null
    const resellerId = resolveResellerId(enterpriseId, enterpriseResellerMap, defaultResellerId)
    if (!resellerId) continue
    const policy = resolvePolicy({
      enterpriseId,
      resellerId,
      defaultWindowMinutes,
      defaultSuppressMinutes,
      windowByEnterprise,
      windowByReseller,
      suppressByEnterprise,
      suppressByReseller,
    })
    const silentHours = resolveThreshold({
      enterpriseId,
      resellerId,
      defaultValue: defaultSilentHours,
      byEnterprise: silentHoursByEnterprise,
      byReseller: silentHoursByReseller,
    })
    const rule = await resolveEffectiveRuleForEvaluation({
      supabase,
      alertType: 'SILENT_SIM',
      resellerId,
      enterpriseId,
      fallback: {
        severity: 'P3',
        thresholdValue: silentHours,
        thresholdUnit: 'HOURS',
        windowMinutes: policy.windowMinutes,
        suppressMinutes: policy.suppressMinutes,
        deliveryChannels: null,
      },
    })
    if (!rule) {
      skippedCount += 1
      continue
    }
    const effectiveSilentHours = effectiveThreshold(rule, silentHours)
    const silentCutoff = new Date(currentTime.getTime() - effectiveSilentHours * 60 * 60 * 1000)
    if (deactivatedSince.getTime() > silentCutoff.getTime()) continue
    const inactiveHours = Math.floor((currentTime.getTime() - deactivatedSince.getTime()) / (60 * 60 * 1000))
    const result = await createAlert({
      supabase,
      alertType: 'SILENT_SIM',
      severity: rule.severity ?? 'P3',
      resellerId,
      customerId: enterpriseId,
      simId,
      threshold: effectiveSilentHours,
      currentValue: inactiveHours,
      windowStart: silentCutoff.toISOString(),
      windowEnd: windowEndIso,
      ruleId: rule.configId ?? null,
      ruleVersion: rule.version ?? null,
      metadata: {
        message: 'SIM has remained DEACTIVATED beyond the configured threshold.',
        status: 'DEACTIVATED',
        deactivatedSince: deactivatedSince.toISOString(),
        inactiveHours,
        thresholdUnit: rule.thresholdUnit ?? 'HOURS',
      },
      deliveryChannels: rule.deliveryChannels ?? null,
      suppressMinutes: rule.suppressMinutes ?? policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  for (const candidate of unexpectedRoamingBySim.values()) {
    const simId = candidate.simId
    const sim = simMap.get(simId)
    const enterpriseId = candidate.enterpriseId ?? (sim?.enterprise_id ? String(sim.enterprise_id) : null)
    const resellerId = resolveResellerId(enterpriseId, enterpriseResellerMap, defaultResellerId)
    if (!resellerId) continue
    const policy = resolvePolicy({
      enterpriseId,
      resellerId,
      defaultWindowMinutes,
      defaultSuppressMinutes,
      windowByEnterprise,
      windowByReseller,
      suppressByEnterprise,
      suppressByReseller,
    })
    const rule = await resolveEffectiveRuleForEvaluation({
      supabase,
      alertType: 'UNEXPECTED_ROAMING',
      resellerId,
      enterpriseId,
      fallback: {
        severity: 'P1',
        thresholdValue: 20,
        thresholdUnit: 'MB',
        windowMinutes: policy.windowMinutes,
        suppressMinutes: policy.suppressMinutes,
        deliveryChannels: null,
      },
    })
    if (!rule) {
      skippedCount += 1
      continue
    }
    const effectiveThresholdMb = thresholdValueToMb(
      effectiveThreshold(rule, 20),
      rule.thresholdUnit ?? 'MB'
    )
    if (effectiveThresholdMb == null || candidate.outProfileMb < effectiveThresholdMb) {
      skippedCount += 1
      continue
    }
    const result = await createAlert({
      supabase,
      alertType: 'UNEXPECTED_ROAMING',
      severity: rule.severity ?? 'P1',
      resellerId,
      customerId: enterpriseId,
      simId,
      threshold: effectiveThresholdMb,
      currentValue: candidate.outProfileMb,
      windowStart: `${periodStartDay}T00:00:00.000Z`,
      windowEnd: windowEndIso,
      ruleId: rule.configId ?? null,
      ruleVersion: rule.version ?? null,
      metadata: {
        message: 'SIM has out-of-profile roaming usage in the current billing period.',
        outOfProfileMb: candidate.outProfileMb,
        thresholdMb: effectiveThresholdMb,
        packageIds: Array.from(candidate.packageIds),
        pricePlanIds: Array.from(candidate.pricePlanIds),
        pricePlanTypes: Array.from(candidate.pricePlanTypes),
        usageDays: Array.from(candidate.usageDays).sort(),
        visitedMccMncs: Array.from(new Set([
          ...candidate.visitedMccMncs,
          ...(visitedNetworksBySim.get(simId) ?? []),
        ])).sort(),
        thresholdUnit: rule.thresholdUnit ?? 'MB',
      },
      deliveryChannels: rule.deliveryChannels ?? null,
      suppressMinutes: rule.suppressMinutes ?? policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  const minCdrDelayHours = minPositiveValue(defaultCdrDelayHours, ...cdrDelayHoursByReseller.values())
  const cdrCandidateCutoff = new Date(currentTime.getTime() - minCdrDelayHours * 60 * 60 * 1000)
  let cdrRows
  try {
    cdrRows = await supabase.select(
      'cdr_files',
      `select=cdr_file_id,reseller_id,supplier_id,operator_id,received_at,ingested_at,status&received_at=lte.${encodeURIComponent(cdrCandidateCutoff.toISOString())}&ingested_at=is.null&limit=100`
    )
  } catch (err) {
    const body = String(err?.body || err?.message || '')
    if (!body.includes('reseller_id') && !body.includes('operator_id')) throw err
    cdrRows = await supabase.select(
      'cdr_files',
      `select=cdr_file_id,supplier_id,received_at,ingested_at,status&received_at=lte.${encodeURIComponent(cdrCandidateCutoff.toISOString())}&ingested_at=is.null&limit=100`
    )
  }
  const cdrFiles = Array.isArray(cdrRows) ? cdrRows : []
  const cdrFileIds = cdrFiles.map((row) => row?.cdr_file_id).filter(Boolean).map((id) => String(id))
  let cdrFileRefs = []
  if (cdrFileIds.length) {
    try {
      const inList = cdrFileIds.map((id) => encodeURIComponent(id)).join(',')
      const refRows = await supabase.select(
        'cdr_file_sim_refs',
        `select=cdr_file_id,iccid,sim_id,reseller_id,enterprise_id&cdr_file_id=in.(${inList})&limit=10000`,
        { suppressMissingColumns: true }
      )
      cdrFileRefs = Array.isArray(refRows) ? refRows : []
    } catch (err) {
      const body = String(err?.body || err?.message || '')
      if (!body.includes('cdr_file_sim_refs') && !body.includes('does not exist')) throw err
    }
  }
  const cdrRefsNeedingSimScope = cdrFileRefs.filter((ref) => !ref?.reseller_id && !ref?.enterprise_id && (ref?.iccid || ref?.sim_id))
  if (cdrRefsNeedingSimScope.length) {
    const simScopeByIccid = new Map()
    const simScopeById = new Map()
    const loadSimScopeRows = async (filter) => {
      try {
        return await supabase.select('sims', `select=sim_id,iccid,enterprise_id,reseller_id&${filter}&limit=10000`)
      } catch (err) {
        const body = String(err?.body || err?.message || '')
        if (!body.includes('reseller_id')) throw err
        return supabase.select('sims', `select=sim_id,iccid,enterprise_id&${filter}&limit=10000`)
      }
    }
    const refIccids = Array.from(new Set(cdrRefsNeedingSimScope.map((ref) => ref?.iccid).filter(Boolean).map((iccid) => String(iccid))))
    if (refIccids.length) {
      const rows = await loadSimScopeRows(`iccid=in.(${refIccids.map((iccid) => encodeURIComponent(iccid)).join(',')})`)
      for (const sim of Array.isArray(rows) ? rows : []) {
        if (sim?.iccid) simScopeByIccid.set(String(sim.iccid), sim)
      }
    }
    const refSimIds = Array.from(new Set(cdrRefsNeedingSimScope.map((ref) => ref?.sim_id).filter(Boolean).map((simId) => String(simId))))
    if (refSimIds.length) {
      const rows = await loadSimScopeRows(`sim_id=in.(${refSimIds.map((simId) => encodeURIComponent(simId)).join(',')})`)
      for (const sim of Array.isArray(rows) ? rows : []) {
        if (sim?.sim_id) simScopeById.set(String(sim.sim_id), sim)
      }
    }
    for (const ref of cdrRefsNeedingSimScope) {
      const sim = (ref?.sim_id ? simScopeById.get(String(ref.sim_id)) : null)
        ?? (ref?.iccid ? simScopeByIccid.get(String(ref.iccid)) : null)
      if (!sim) continue
      if (!ref.sim_id && sim.sim_id) ref.sim_id = sim.sim_id
      if (!ref.enterprise_id && sim.enterprise_id) ref.enterprise_id = sim.enterprise_id
      if (!ref.reseller_id && sim.reseller_id) ref.reseller_id = sim.reseller_id
    }
  }
  const cdrRefsByFile = new Map()
  for (const ref of cdrFileRefs) {
    const fileId = ref?.cdr_file_id ? String(ref.cdr_file_id) : null
    if (!fileId) continue
    if (!cdrRefsByFile.has(fileId)) cdrRefsByFile.set(fileId, [])
    cdrRefsByFile.get(fileId).push(ref)
  }
  const cdrDelayByReseller = new Map()
  const recordCdrDelay = ({ resellerId, file, refs }) => {
    if (!resellerId || !file?.cdr_file_id) return
    const receivedAt = parseDateOrNull(file.received_at)
    if (!receivedAt) return
    const delayHours = resolveThreshold({
      enterpriseId: null,
      resellerId,
      defaultValue: defaultCdrDelayHours,
      byEnterprise: cdrDelayHoursByEnterprise,
      byReseller: cdrDelayHoursByReseller,
    })
    const cutoff = new Date(currentTime.getTime() - delayHours * 60 * 60 * 1000)
    if (receivedAt.getTime() > cutoff.getTime()) return
    const entry = cdrDelayByReseller.get(resellerId) || {
      resellerId,
      delayHours,
      cutoff,
      fileIds: new Set(),
      affectedIccids: new Set(),
      supplierIds: new Set(),
      operatorIds: new Set(),
    }
    entry.fileIds.add(String(file.cdr_file_id))
    if (file.supplier_id) entry.supplierIds.add(String(file.supplier_id))
    if (file.operator_id) entry.operatorIds.add(String(file.operator_id))
    for (const ref of refs) {
      if (ref?.iccid) entry.affectedIccids.add(String(ref.iccid))
    }
    cdrDelayByReseller.set(resellerId, entry)
  }
  for (const file of cdrFiles) {
    const fileId = file?.cdr_file_id ? String(file.cdr_file_id) : null
    if (!fileId) continue
    const refs = cdrRefsByFile.get(fileId) ?? []
    if (file?.reseller_id) {
      recordCdrDelay({ resellerId: String(file.reseller_id), file, refs })
      continue
    }
    const resellerIds = new Set()
    for (const ref of refs) {
      if (ref?.reseller_id) resellerIds.add(String(ref.reseller_id))
      else if (ref?.enterprise_id) {
        const resolved = resolveResellerId(String(ref.enterprise_id), enterpriseResellerMap, null)
        if (resolved) resellerIds.add(resolved)
      }
    }
    for (const resellerId of resellerIds) {
      recordCdrDelay({ resellerId, file, refs: refs.filter((ref) => {
        if (ref?.reseller_id) return String(ref.reseller_id) === resellerId
        if (ref?.enterprise_id) return resolveResellerId(String(ref.enterprise_id), enterpriseResellerMap, null) === resellerId
        return false
      }) })
    }
  }
  for (const entry of cdrDelayByReseller.values()) {
    const policy = resolvePolicy({
      enterpriseId: null,
      resellerId: entry.resellerId,
      defaultWindowMinutes,
      defaultSuppressMinutes,
      windowByEnterprise,
      windowByReseller,
      suppressByEnterprise,
      suppressByReseller,
    })
    const cdrRule = await resolveEffectiveRuleForEvaluation({
      supabase,
      alertType: 'CDR_DELAY',
      resellerId: entry.resellerId,
      enterpriseId: null,
      fallback: {
        severity: 'P1',
        thresholdValue: entry.delayHours,
        thresholdUnit: 'HOURS',
        windowMinutes: policy.windowMinutes,
        suppressMinutes: policy.suppressMinutes,
        deliveryChannels: null,
      },
    })
    if (!cdrRule) {
      skippedCount += 1
      continue
    }
    const effectiveCdrDelayHours = effectiveThreshold(cdrRule, entry.delayHours)
    const effectiveCutoff = new Date(currentTime.getTime() - effectiveCdrDelayHours * 60 * 60 * 1000)
    const cdrFileIdsForAlert = Array.from(entry.fileIds).sort()
    const affectedIccids = Array.from(entry.affectedIccids).sort()
    const result = await createAlert({
      supabase,
      alertType: 'CDR_DELAY',
      severity: cdrRule.severity ?? 'P1',
      resellerId: entry.resellerId,
      customerId: null,
      simId: null,
      threshold: effectiveCdrDelayHours,
      currentValue: cdrFileIdsForAlert.length,
      windowStart: effectiveCutoff.toISOString(),
      windowEnd: windowEndIso,
      ruleId: cdrRule.configId ?? null,
      ruleVersion: cdrRule.version ?? null,
      metadata: {
        message: 'CDR ingestion delay detected for reseller-scoped files.',
        delayedFiles: cdrFileIdsForAlert.length,
        cdrFileIds: cdrFileIdsForAlert,
        affectedIccidCount: affectedIccids.length,
        sampleIccids: affectedIccids.slice(0, 10),
        supplierIds: Array.from(entry.supplierIds).sort(),
        operatorIds: Array.from(entry.operatorIds).sort(),
        thresholdUnit: cdrRule.thresholdUnit ?? 'HOURS',
      },
      deliveryChannels: cdrRule.deliveryChannels ?? null,
      suppressMinutes: cdrRule.suppressMinutes ?? policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  const minUpstreamDisconnectAttempts = minPositiveValue(defaultUpstreamDisconnectAttempts, ...upstreamDisconnectAttemptsByReseller.values())
  let upstreamHealthRows = []
  try {
    const rows = await supabase.select(
      'upstream_integration_health_checks',
      `select=integration_id,reseller_id,supplier_id,operator_id,probe_type,status,consecutive_failure_count,last_success_at,last_failure_at,last_error_code,last_error_message,updated_at&probe_type=eq.TOKEN&status=eq.DISCONNECTED&consecutive_failure_count=gte.${encodeURIComponent(String(minUpstreamDisconnectAttempts))}&limit=1000`,
      { suppressMissingColumns: true }
    )
    upstreamHealthRows = Array.isArray(rows) ? rows : []
  } catch (err) {
    const body = String(err?.body || err?.message || '')
    if (!body.includes('upstream_integration_health_checks') && !body.includes('does not exist')) throw err
  }
  for (const health of upstreamHealthRows) {
    const integrationId = health?.integration_id ? String(health.integration_id) : null
    const resellerId = health?.reseller_id ? String(health.reseller_id) : null
    if (!integrationId || !resellerId) continue
    const policy = resolvePolicy({
      enterpriseId: null,
      resellerId,
      defaultWindowMinutes,
      defaultSuppressMinutes,
      windowByEnterprise,
      windowByReseller,
      suppressByEnterprise,
      suppressByReseller,
    })
    const upstreamDisconnectAttempts = resolveThreshold({
      enterpriseId: null,
      resellerId,
      defaultValue: defaultUpstreamDisconnectAttempts,
      byEnterprise: upstreamDisconnectAttemptsByEnterprise,
      byReseller: upstreamDisconnectAttemptsByReseller,
    })
    const rule = await resolveEffectiveRuleForEvaluation({
      supabase,
      alertType: 'UPSTREAM_DISCONNECT',
      resellerId,
      enterpriseId: null,
      fallback: {
        severity: 'P1',
        thresholdValue: upstreamDisconnectAttempts,
        thresholdUnit: 'ATTEMPTS',
        windowMinutes: policy.windowMinutes,
        suppressMinutes: policy.suppressMinutes,
        deliveryChannels: null,
      },
    })
    if (!rule) {
      skippedCount += 1
      continue
    }
    const effectiveUpstreamDisconnectAttempts = effectiveThreshold(rule, upstreamDisconnectAttempts)
    const failureCount = Number(health?.consecutive_failure_count)
    if (!Number.isFinite(failureCount) || failureCount < effectiveUpstreamDisconnectAttempts) continue
    const failureAt = parseDateOrNull(health?.last_failure_at) ?? parseDateOrNull(health?.updated_at) ?? currentTime
    const result = await createAlert({
      supabase,
      alertType: 'UPSTREAM_DISCONNECT',
      severity: rule.severity ?? 'P1',
      resellerId,
      customerId: null,
      simId: null,
      threshold: effectiveUpstreamDisconnectAttempts,
      currentValue: failureCount,
      windowStart: failureAt.toISOString(),
      windowEnd: windowEndIso,
      ruleId: rule.configId ?? null,
      ruleVersion: rule.version ?? null,
      metadata: {
        message: 'Upstream supplier API token probe failed repeatedly.',
        integrationId,
        supplierId: health?.supplier_id ?? null,
        operatorId: health?.operator_id ?? null,
        probeApi: 'TOKEN',
        failureCount,
        lastSuccessAt: health?.last_success_at ?? null,
        lastFailureAt: health?.last_failure_at ?? null,
        lastErrorCode: health?.last_error_code ?? null,
        lastErrorMessage: health?.last_error_message ?? null,
        thresholdUnit: 'ATTEMPTS',
      },
      deliveryChannels: rule.deliveryChannels ?? null,
      suppressMinutes: rule.suppressMinutes ?? policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  return {
    ok: true,
    value: {
      created: createdCount,
      skipped: skippedCount,
      errors: errorCount,
    },
  }
}

function normalizeNumberMap(input) {
  if (!input || typeof input !== 'object') return new Map()
  const map = new Map()
  for (const [key, value] of Object.entries(input)) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) {
      map.set(String(key), n)
    }
  }
  return map
}

function mergeNumberMap(primary, fallback) {
  const map = new Map()
  if (fallback instanceof Map) {
    for (const [key, value] of fallback.entries()) {
      map.set(String(key), value)
    }
  }
  if (primary instanceof Map) {
    for (const [key, value] of primary.entries()) {
      map.set(String(key), value)
    }
  }
  return map
}

function maxMapValue(map) {
  let max = 0
  for (const value of map.values()) {
    if (value > max) max = value
  }
  return max
}

function minPositiveValue(...values) {
  const positives = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  return positives.length ? Math.min(...positives) : 1
}

function resolvePolicy({
  enterpriseId,
  resellerId,
  defaultWindowMinutes,
  defaultSuppressMinutes,
  windowByEnterprise,
  windowByReseller,
  suppressByEnterprise,
  suppressByReseller,
}) {
  const enterpriseKey = enterpriseId ? String(enterpriseId) : null
  const resellerKey = resellerId ? String(resellerId) : null
  const windowMinutes = enterpriseKey && windowByEnterprise.has(enterpriseKey)
    ? windowByEnterprise.get(enterpriseKey)
    : resellerKey && windowByReseller.has(resellerKey)
      ? windowByReseller.get(resellerKey)
      : defaultWindowMinutes
  const suppressMinutes = enterpriseKey && suppressByEnterprise.has(enterpriseKey)
    ? suppressByEnterprise.get(enterpriseKey)
    : resellerKey && suppressByReseller.has(resellerKey)
      ? suppressByReseller.get(resellerKey)
      : defaultSuppressMinutes
  return {
    windowMinutes: Number(windowMinutes ?? defaultWindowMinutes),
    suppressMinutes: Number(suppressMinutes ?? defaultSuppressMinutes),
  }
}

function resolveThreshold({ enterpriseId, resellerId, defaultValue, byEnterprise, byReseller }) {
  const enterpriseKey = enterpriseId ? String(enterpriseId) : null
  const resellerKey = resellerId ? String(resellerId) : null
  if (enterpriseKey && byEnterprise.has(enterpriseKey)) {
    return Number(byEnterprise.get(enterpriseKey))
  }
  if (resellerKey && byReseller.has(resellerKey)) {
    return Number(byReseller.get(resellerKey))
  }
  return Number(defaultValue)
}

function resolveDefaultValue(primary, fallback) {
  const n = Number(primary)
  if (Number.isFinite(n) && n > 0) return n
  return Number(fallback)
}

const ALERT_CONFIG_CACHE = {
  expiresAt: 0,
  value: null,
}

let ALERT_CONFIG_PARAMETERS_MISSING_WARNED = false

function createEmptyAlertThresholdConfig() {
  return {
    thresholds: {
      POOL_USAGE_HIGH: { global: null, byReseller: new Map(), byEnterprise: new Map() },
      OUT_OF_PROFILE_SURGE: { global: null, byReseller: new Map(), byEnterprise: new Map() },
      SILENT_SIM: { global: null, byReseller: new Map(), byEnterprise: new Map() },
      CDR_DELAY: { global: null, byReseller: new Map(), byEnterprise: new Map() },
      UPSTREAM_DISCONNECT: { global: null, byReseller: new Map(), byEnterprise: new Map() },
    },
  }
}

function isMissingConfigParametersError(err) {
  const parts = [
    err?.code,
    err?.status,
    err?.message,
    err?.body?.code,
    err?.body?.message,
    err?.body?.hint,
    err?.body ? JSON.stringify(err.body) : null,
  ]
  const text = parts.filter((part) => part !== null && part !== undefined).map(String).join(' ')
  return (
    text.includes('PGRST205') ||
    text.includes('RESOURCE_NOT_FOUND') ||
    (text.includes('config_parameters') && (text.includes('schema cache') || text.includes('does not exist')))
  )
}

async function getAlertThresholdConfig({ supabase, cacheTtlSeconds }) {
  const ttlMs = Number.isFinite(cacheTtlSeconds) ? Math.max(0, Number(cacheTtlSeconds)) * 1000 : 0
  const now = Date.now()
  if (ALERT_CONFIG_CACHE.value && ALERT_CONFIG_CACHE.expiresAt > now) {
    return ALERT_CONFIG_CACHE.value
  }
  const keys = [
    'alert.pool_usage_high.threshold_percent',
    'alert.out_of_profile_surge.threshold_percent',
    'alert.out_of_profile_surge.threshold_kb',
    'alert.silent_sim.threshold_hours',
    'alert.cdr_delay.threshold_hours',
    'alert.upstream_disconnect.threshold_attempts',
    'alert.upstream_disconnect.threshold_hours',
  ]
  const keyFilters = keys.map((key) => encodeURIComponent(key)).join(',')
  let rows
  try {
    rows = await supabase.select(
      'config_parameters',
      `select=param_key,scope_type,scope_id,value,value_type,enabled&enabled=eq.true&param_key=in.(${keyFilters})`,
      { suppressMissingColumns: true }
    )
  } catch (err) {
    if (!isMissingConfigParametersError(err)) throw err
    if (!ALERT_CONFIG_PARAMETERS_MISSING_WARNED) {
      console.warn(
        '[Alerting] config_parameters table is unavailable; using built-in/default alert thresholds.'
      )
      ALERT_CONFIG_PARAMETERS_MISSING_WARNED = true
    }
    const fallback = createEmptyAlertThresholdConfig()
    ALERT_CONFIG_CACHE.value = fallback
    ALERT_CONFIG_CACHE.expiresAt = now + ttlMs
    return fallback
  }
  const data = Array.isArray(rows) ? rows : []
  const config = createEmptyAlertThresholdConfig()
  for (const row of data) {
    const key = String(row?.param_key || '').trim()
    if (!key) continue
    const value = parseConfigNumber(row?.value, row?.value_type)
    if (!Number.isFinite(value)) continue
    const scopeType = String(row?.scope_type || '').toUpperCase()
    const scopeId = row?.scope_id ? String(row.scope_id) : null
    const entry = resolveThresholdEntry(config.thresholds, key)
    if (!entry) continue
    if (scopeType === 'RESELLER' && scopeId) {
      entry.byReseller.set(scopeId, value)
    } else if (scopeType === 'ENTERPRISE' && scopeId) {
      entry.byEnterprise.set(scopeId, value)
    } else if (scopeType === 'GLOBAL') {
      entry.global = value
    }
  }
  ALERT_CONFIG_CACHE.value = config
  ALERT_CONFIG_CACHE.expiresAt = now + ttlMs
  return config
}

function resolveThresholdEntry(thresholds, key) {
  if (key === 'alert.pool_usage_high.threshold_percent') return thresholds.POOL_USAGE_HIGH
  if (key === 'alert.out_of_profile_surge.threshold_percent') return thresholds.OUT_OF_PROFILE_SURGE
  if (key === 'alert.out_of_profile_surge.threshold_kb') return thresholds.OUT_OF_PROFILE_SURGE
  if (key === 'alert.silent_sim.threshold_hours') return thresholds.SILENT_SIM
  if (key === 'alert.cdr_delay.threshold_hours') return thresholds.CDR_DELAY
  if (key === 'alert.upstream_disconnect.threshold_attempts') return thresholds.UPSTREAM_DISCONNECT
  if (key === 'alert.upstream_disconnect.threshold_hours') return thresholds.UPSTREAM_DISCONNECT
  return null
}

function parseConfigNumber(value, valueType) {
  const raw = valueType ? String(valueType).toLowerCase() : ''
  if (raw === 'json') {
    try {
      const parsed = JSON.parse(String(value ?? ''))
      const n = Number(parsed)
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
