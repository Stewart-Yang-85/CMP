import { emitEvent } from './eventEmitter.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string> }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ErrorResult = {
  ok: false
  status: number
  code: string
  message: string
}

type OkResult<T> = {
  ok: true
  value: T
}

type AlertListItem = {
  alertId: string | null
  alertType: string
  severity: string | null
  status: string | null
  enterpriseId: string | null
  simId: string | null
  iccid: string | null
  threshold: number | null
  currentValue: number | null
  windowStart: string | null
  windowEnd: string | null
  firstSeenAt: string | null
  lastSeenAt: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  suppressedUntil: string | null
  message: string | null
  metadata: Record<string, unknown> | null
  createdAt: string | null
  updatedAt: string | null
}

type AlertListResult = {
  items: AlertListItem[]
  total: number
}

type ListAlertsInput = {
  supabase: SupabaseClient
  resellerId?: string | null
  enterpriseId?: string | null
  alertType?: string | null
  from?: string | null
  to?: string | null
  acknowledged?: boolean | null
  limit?: number | null
  offset?: number | null
}

type AcknowledgeAlertInput = {
  supabase: SupabaseClient
  alertId: string
  resellerId?: string | null
  actorUserId?: string | null
}

type CreateAlertInput = {
  supabase: SupabaseClient
  alertType: string
  severity: string
  resellerId: string
  customerId?: string | null
  simId?: string | null
  threshold?: number | null
  currentValue?: number | null
  windowStart: string
  windowEnd?: string | null
  ruleId?: string | null
  ruleVersion?: number | null
  metadata?: Record<string, unknown> | null
  deliveryChannels?: string[] | null
  suppressMinutes?: number | null
}

const alertTypes = new Set([
  'POOL_USAGE_HIGH',
  'OUT_OF_PROFILE_SURGE',
  'SILENT_SIM',
  'UNEXPECTED_ROAMING',
  'CDR_DELAY',
  'UPSTREAM_DISCONNECT',
  'WEBHOOK_DELIVERY_FAILED',
])

function toError(status: number, code: string, message: string): ErrorResult {
  return { ok: false, status, code, message }
}

function normalizeAlertType(value: unknown) {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return null
  return alertTypes.has(raw) ? raw : null
}

function normalizeIso(value: unknown) {
  if (!value) return null
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function toNumberOrNull(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function buildAlertFilters({
  resellerId,
  enterpriseId,
  alertType,
  from,
  to,
  acknowledged,
}: {
  resellerId?: string | null
  enterpriseId?: string | null
  alertType?: string | null
  from?: string | null
  to?: string | null
  acknowledged?: boolean | null
}) {
  const filters: string[] = []
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  if (enterpriseId) filters.push(`customer_id=eq.${encodeURIComponent(enterpriseId)}`)
  if (alertType) filters.push(`alert_type=eq.${encodeURIComponent(alertType)}`)
  if (from) filters.push(`window_start=gte.${encodeURIComponent(from)}`)
  if (to) filters.push(`window_start=lte.${encodeURIComponent(to)}`)
  if (acknowledged === true) filters.push(`status=eq.ACKED`)
  if (acknowledged === false) filters.push(`status=neq.ACKED`)
  return filters
}

export async function listAlerts(input: ListAlertsInput): Promise<OkResult<AlertListResult> | ErrorResult> {
  const {
    supabase,
    resellerId,
    enterpriseId,
    alertType,
    from,
    to,
    acknowledged,
    limit,
    offset,
  } = input
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
  const limitValue = Number.isFinite(limit as number) ? Math.max(1, Number(limit)) : 50
  const offsetValue = Number.isFinite(offset as number) ? Math.max(0, Number(offset)) : 0
  const { data, total } = await supabase.selectWithCount(
    'alerts',
    `select=alert_id,alert_type,severity,status,rule_id,customer_id,sim_id,threshold,current_value,window_start,window_end,first_seen_at,last_seen_at,acknowledged_at,acknowledged_by,suppressed_until,created_at,updated_at,metadata,sims(iccid)&order=window_start.desc&limit=${encodeURIComponent(String(limitValue))}&offset=${encodeURIComponent(String(offsetValue))}${filterQs}`
  )
  const rows = Array.isArray(data) ? data as any[] : []
  const items = rows.map((r) => ({
    alertId: r.alert_id ?? null,
    alertType: r.alert_type ?? null,
    severity: r.severity ?? null,
    status: r.status ?? null,
    enterpriseId: r.customer_id ?? null,
    simId: r.sim_id ?? null,
    iccid: r.sims?.iccid ?? null,
    threshold: toNumberOrNull(r.threshold),
    currentValue: toNumberOrNull(r.current_value),
    windowStart: r.window_start ? new Date(r.window_start).toISOString() : null,
    windowEnd: r.window_end ? new Date(r.window_end).toISOString() : null,
    firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null,
    lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at).toISOString() : null,
    acknowledgedBy: r.acknowledged_by ?? null,
    suppressedUntil: r.suppressed_until ? new Date(r.suppressed_until).toISOString() : null,
    message: r.metadata?.message ?? null,
    metadata: r.metadata ?? null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }))
  return {
    ok: true,
    value: {
      items,
      total: typeof total === 'number' ? total : items.length,
    },
  }
}

export async function acknowledgeAlert(input: AcknowledgeAlertInput): Promise<OkResult<AlertListItem> | ErrorResult> {
  const { supabase, alertId, resellerId, actorUserId } = input
  const alertIdValue = String(alertId || '').trim()
  if (!alertIdValue) return toError(400, 'BAD_REQUEST', 'alertId is required.')
  const filters = [`alert_id=eq.${encodeURIComponent(alertIdValue)}`]
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  const rows = await supabase.select('alerts', `select=alert_id&${filters.join('&')}&limit=1`)
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!existing) return toError(404, 'RESOURCE_NOT_FOUND', 'alert not found.')
  const nowIso = new Date().toISOString()
  await supabase.update('alerts', `alert_id=eq.${encodeURIComponent(alertIdValue)}`, {
    status: 'ACKED',
    acknowledged_at: nowIso,
    acknowledged_by: actorUserId ?? null,
    updated_at: nowIso,
  }, { returning: 'minimal' })
  const updatedRows = await supabase.select(
    'alerts',
    `select=alert_id,alert_type,severity,status,rule_id,customer_id,sim_id,threshold,current_value,window_start,window_end,first_seen_at,last_seen_at,acknowledged_at,acknowledged_by,suppressed_until,created_at,updated_at,metadata,sims(iccid)&alert_id=eq.${encodeURIComponent(alertIdValue)}&limit=1`
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

export async function createAlert(input: CreateAlertInput): Promise<OkResult<{ created: boolean; alertId: string | null }> | ErrorResult> {
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
  } = input
  const normalizedType = normalizeAlertType(alertType)
  if (!normalizedType) return toError(400, 'BAD_REQUEST', 'alertType is invalid.')
  const windowStartIso = normalizeIso(windowStart)
  if (!windowStartIso) return toError(400, 'BAD_REQUEST', 'windowStart is invalid.')
  const windowEndIso = windowEnd ? normalizeIso(windowEnd) : null
  const now = new Date()
  const nowIso = now.toISOString()
  const suppressWindow = Number.isFinite(suppressMinutes as number) ? Math.max(0, Number(suppressMinutes)) : 0
  if (suppressWindow > 0 && simId) {
    const lastRows = await supabase.select(
      'alerts',
      `select=alert_id,last_seen_at,suppressed_until&reseller_id=eq.${encodeURIComponent(resellerId)}&sim_id=eq.${encodeURIComponent(simId)}&alert_type=eq.${encodeURIComponent(normalizedType)}&order=last_seen_at.desc&limit=1`
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
  const existingRows = await supabase.select(
    'alerts',
    `select=alert_id&${matchFilters.join('&')}&limit=1`
  )
  const existing = Array.isArray(existingRows) ? existingRows[0] : null
  if (existing) {
    await supabase.update('alerts', `alert_id=eq.${encodeURIComponent(existing.alert_id)}`, {
      severity,
      status: 'OPEN',
      threshold: threshold ?? null,
      current_value: currentValue ?? null,
      window_end: windowEndIso ?? null,
      last_seen_at: nowIso,
      updated_at: nowIso,
      metadata: metadata ?? null,
      delivery_channels: deliveryChannels ?? null,
    }, { returning: 'minimal' })
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
    metadata: metadata ?? null,
    created_at: nowIso,
    updated_at: nowIso,
  })
  const row = Array.isArray(rows) ? rows[0] : null
  if (row?.alert_id) {
    try {
      await emitEvent({
        eventType: 'ALERT_TRIGGERED',
        tenantId: resellerId,
        payload: {
          alertId: row.alert_id,
          alertType: normalizedType,
          severity,
          resellerId,
          customerId: customerId ?? null,
          simId: simId ?? null,
          threshold: threshold ?? null,
          currentValue: currentValue ?? null,
          windowStart: windowStartIso,
          windowEnd: windowEndIso ?? null,
        },
      })
    } catch {
      return { ok: true, value: { created: true, alertId: row.alert_id } }
    }
  }
  return { ok: true, value: { created: true, alertId: row?.alert_id ?? null } }
}
