import { emitEvent } from './eventEmitter.js'

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

function buildAlertFilters({ resellerId, enterpriseId, alertType, from, to, acknowledged }) {
  const filters = []
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  if (enterpriseId) filters.push(`customer_id=eq.${encodeURIComponent(enterpriseId)}`)
  if (alertType) filters.push(`alert_type=eq.${encodeURIComponent(alertType)}`)
  if (from) filters.push(`window_start=gte.${encodeURIComponent(from)}`)
  if (to) filters.push(`window_start=lte.${encodeURIComponent(to)}`)
  if (acknowledged === true) filters.push(`status=eq.ACKED`)
  if (acknowledged === false) filters.push(`status=neq.ACKED`)
  return filters
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
    `select=alert_id,alert_type,severity,status,rule_id,customer_id,sim_id,threshold,current_value,window_start,window_end,first_seen_at,last_seen_at,acknowledged_at,acknowledged_by,suppressed_until,created_at,updated_at,metadata,sims(iccid)&order=window_start.desc&limit=${encodeURIComponent(String(limitValue))}&offset=${encodeURIComponent(String(offsetValue))}${filterQs}`
  )
  const rows = Array.isArray(data) ? data : []
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

export async function acknowledgeAlert(input) {
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
  } = input
  const normalizedType = normalizeAlertType(alertType)
  if (!normalizedType) return toError(400, 'BAD_REQUEST', 'alertType is invalid.')
  const windowStartIso = normalizeIso(windowStart)
  if (!windowStartIso) return toError(400, 'BAD_REQUEST', 'windowStart is invalid.')
  const windowEndIso = windowEnd ? normalizeIso(windowEnd) : null
  const now = new Date()
  const nowIso = now.toISOString()
  const suppressWindow = Number.isFinite(suppressMinutes) ? Math.max(0, Number(suppressMinutes)) : 0
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

function toDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function normalizeMccMnc(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  return digits.length ? digits : null
}

function resolveResellerId(enterpriseId, enterpriseResellerMap, defaultResellerId) {
  if (!enterpriseId) return defaultResellerId
  return enterpriseResellerMap.get(enterpriseId) ?? defaultResellerId
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
  const defaultPoolThresholdKb = resolveDefaultValue(
    config?.thresholds?.POOL_USAGE_HIGH?.global,
    Number.isFinite(options?.poolUsageHighThresholdKb) ? Math.max(0, Number(options.poolUsageHighThresholdKb)) : 500000
  )
  const defaultOutProfileThresholdKb = resolveDefaultValue(
    config?.thresholds?.OUT_OF_PROFILE_SURGE?.global,
    Number.isFinite(options?.outOfProfileSurgeThresholdKb) ? Math.max(0, Number(options.outOfProfileSurgeThresholdKb)) : 100000
  )
  const defaultSilentHours = resolveDefaultValue(
    config?.thresholds?.SILENT_SIM?.global,
    Number.isFinite(options?.silentSimThresholdHours) ? Math.max(1, Number(options.silentSimThresholdHours)) : 24
  )
  const defaultCdrDelayHours = resolveDefaultValue(
    config?.thresholds?.CDR_DELAY?.global,
    Number.isFinite(options?.cdrDelayThresholdHours) ? Math.max(1, Number(options.cdrDelayThresholdHours)) : 48
  )
  const defaultUpstreamDisconnectHours = resolveDefaultValue(
    config?.thresholds?.UPSTREAM_DISCONNECT?.global,
    Number.isFinite(options?.upstreamDisconnectThresholdHours) ? Math.max(1, Number(options.upstreamDisconnectThresholdHours)) : 1
  )
  const poolThresholdByReseller = mergeNumberMap(
    config?.thresholds?.POOL_USAGE_HIGH?.byReseller,
    normalizeNumberMap(options?.poolUsageHighThresholdKbByReseller)
  )
  const poolThresholdByEnterprise = mergeNumberMap(
    config?.thresholds?.POOL_USAGE_HIGH?.byEnterprise,
    normalizeNumberMap(options?.poolUsageHighThresholdKbByEnterprise)
  )
  const outProfileThresholdByReseller = mergeNumberMap(
    config?.thresholds?.OUT_OF_PROFILE_SURGE?.byReseller,
    normalizeNumberMap(options?.outOfProfileSurgeThresholdKbByReseller)
  )
  const outProfileThresholdByEnterprise = mergeNumberMap(
    config?.thresholds?.OUT_OF_PROFILE_SURGE?.byEnterprise,
    normalizeNumberMap(options?.outOfProfileSurgeThresholdKbByEnterprise)
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
  const upstreamDisconnectHoursByReseller = mergeNumberMap(
    config?.thresholds?.UPSTREAM_DISCONNECT?.byReseller,
    normalizeNumberMap(options?.upstreamDisconnectThresholdHoursByReseller)
  )
  const upstreamDisconnectHoursByEnterprise = mergeNumberMap(
    config?.thresholds?.UPSTREAM_DISCONNECT?.byEnterprise,
    normalizeNumberMap(options?.upstreamDisconnectThresholdHoursByEnterprise)
  )
  const maxWindowMinutes = Math.max(
    defaultWindowMinutes,
    maxMapValue(windowByReseller),
    maxMapValue(windowByEnterprise)
  )
  const windowEndIso = currentTime.toISOString()
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
    'select=sim_id,enterprise_id,operator_id,status,activation_date,upstream_status,upstream_status_updated_at'
  )
  const sims = Array.isArray(simRows) ? simRows : []
  const operatorIds = Array.from(new Set(sims.map((row) => row?.operator_id).filter(Boolean).map((id) => String(id))))
  const operatorMap = new Map()
  if (operatorIds.length) {
    const inList = operatorIds.map((id) => encodeURIComponent(id)).join(',')
    const operatorRows = await supabase.select(
      'operators',
      `select=operator_id,business_operators(mcc,mnc)&operator_id=in.(${inList})`
    )
    const operators = Array.isArray(operatorRows) ? operatorRows : []
    for (const row of operators) {
      const operatorId = row?.operator_id ? String(row.operator_id) : null
      if (!operatorId) continue
      const business = row?.business_operators ?? null
      const mcc = business?.mcc ? String(business.mcc).trim() : null
      const mnc = business?.mnc ? String(business.mnc).trim() : null
      if (!mcc || !mnc) continue
      operatorMap.set(operatorId, normalizeMccMnc(`${mcc}${mnc}`))
    }
  }
  const simMap = new Map()
  for (const row of sims) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    if (!simId) continue
    simMap.set(simId, row)
  }
  const usageRows = await supabase.select(
    'usage_daily_summary',
    `select=sim_id,enterprise_id,usage_day,total_kb,visited_mccmnc&usage_day=gte.${encodeURIComponent(startDay)}&usage_day=lte.${encodeURIComponent(endDay)}&limit=10000`
  )
  const usage = Array.isArray(usageRows) ? usageRows : []
  const usageByEnterprise = new Map()
  const usageBySim = new Map()
  const lastUsageBySim = new Map()
  const roamingBySim = new Map()
  for (const row of usage) {
    const simId = row?.sim_id ? String(row.sim_id) : null
    const enterpriseId = row?.enterprise_id ? String(row.enterprise_id) : null
    const totalKb = Number(row?.total_kb ?? 0)
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
      const sim = simMap.get(simId)
      const operatorId = sim?.operator_id ? String(sim.operator_id) : null
      const home = operatorId ? operatorMap.get(operatorId) : null
      const visited = normalizeMccMnc(row?.visited_mccmnc)
      if (home && visited && home !== visited) {
        roamingBySim.set(simId, row?.visited_mccmnc ? String(row.visited_mccmnc) : visited)
      }
    }
  }
  let createdCount = 0
  let skippedCount = 0
  let errorCount = 0
  for (const [enterpriseId, totalKb] of usageByEnterprise.entries()) {
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
    const poolThresholdKb = resolveThreshold({
      enterpriseId,
      resellerId,
      defaultValue: defaultPoolThresholdKb,
      byEnterprise: poolThresholdByEnterprise,
      byReseller: poolThresholdByReseller,
    })
    if (totalKb < poolThresholdKb) continue
    const windowStartIso = new Date(currentTime.getTime() - policy.windowMinutes * 60 * 1000).toISOString()
    const result = await createAlert({
      supabase,
      alertType: 'POOL_USAGE_HIGH',
      severity: 'P2',
      resellerId,
      customerId: enterpriseId,
      simId: null,
      threshold: poolThresholdKb,
      currentValue: totalKb,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      metadata: { message: 'Pool usage exceeded threshold.', totalKb },
      suppressMinutes: policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  for (const [simId, totalKb] of usageBySim.entries()) {
    const sim = simMap.get(simId)
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
    const outProfileThresholdKb = resolveThreshold({
      enterpriseId,
      resellerId,
      defaultValue: defaultOutProfileThresholdKb,
      byEnterprise: outProfileThresholdByEnterprise,
      byReseller: outProfileThresholdByReseller,
    })
    if (totalKb < outProfileThresholdKb) continue
    const windowStartIso = new Date(currentTime.getTime() - policy.windowMinutes * 60 * 1000).toISOString()
    const result = await createAlert({
      supabase,
      alertType: 'OUT_OF_PROFILE_SURGE',
      severity: 'P2',
      resellerId,
      customerId: enterpriseId,
      simId,
      threshold: outProfileThresholdKb,
      currentValue: totalKb,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      metadata: { message: 'SIM usage exceeded surge threshold.', totalKb },
      suppressMinutes: policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  for (const sim of sims) {
    const simId = sim?.sim_id ? String(sim.sim_id) : null
    if (!simId) continue
    if (String(sim?.status || '') !== 'ACTIVATED') continue
    const lastUsage = lastUsageBySim.get(simId)
    const activationDate = sim?.activation_date ? new Date(String(sim.activation_date)) : null
    const effectiveLast = lastUsage ?? (activationDate && !Number.isNaN(activationDate.getTime()) ? activationDate : null)
    if (!effectiveLast) continue
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
    const silentCutoff = new Date(currentTime.getTime() - silentHours * 60 * 60 * 1000)
    if (effectiveLast.getTime() > silentCutoff.getTime()) continue
    const result = await createAlert({
      supabase,
      alertType: 'SILENT_SIM',
      severity: 'P3',
      resellerId,
      customerId: enterpriseId,
      simId,
      threshold: silentHours,
      currentValue: silentHours,
      windowStart: silentCutoff.toISOString(),
      windowEnd: windowEndIso,
      metadata: { message: 'SIM has no recent usage.', lastActiveAt: effectiveLast.toISOString() },
      suppressMinutes: policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  for (const [simId, visited] of roamingBySim.entries()) {
    const sim = simMap.get(simId)
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
    const windowStartIso = new Date(currentTime.getTime() - policy.windowMinutes * 60 * 1000).toISOString()
    const result = await createAlert({
      supabase,
      alertType: 'UNEXPECTED_ROAMING',
      severity: 'P2',
      resellerId,
      customerId: enterpriseId,
      simId,
      threshold: null,
      currentValue: null,
      windowStart: windowStartIso,
      windowEnd: windowEndIso,
      metadata: { message: 'SIM detected in unexpected roaming zone.', visitedMccMnc: visited },
      suppressMinutes: policy.suppressMinutes,
    })
    if (!result?.ok) errorCount += 1
    else if (result.value?.created) createdCount += 1
    else skippedCount += 1
  }
  if (defaultResellerId) {
    const cdrDelayHours = resolveThreshold({
      enterpriseId: null,
      resellerId: defaultResellerId,
      defaultValue: defaultCdrDelayHours,
      byEnterprise: cdrDelayHoursByEnterprise,
      byReseller: cdrDelayHoursByReseller,
    })
    const cdrCutoff = new Date(currentTime.getTime() - cdrDelayHours * 60 * 60 * 1000)
    const cdrRows = await supabase.select(
      'cdr_files',
      `select=cdr_file_id,received_at,ingested_at,status&received_at=lte.${encodeURIComponent(cdrCutoff.toISOString())}&ingested_at=is.null&limit=100`
    )
    const cdrFiles = Array.isArray(cdrRows) ? cdrRows : []
    if (cdrFiles.length) {
      const policy = resolvePolicy({
        enterpriseId: null,
        resellerId: defaultResellerId,
        defaultWindowMinutes,
        defaultSuppressMinutes,
        windowByEnterprise,
        windowByReseller,
        suppressByEnterprise,
        suppressByReseller,
      })
      const result = await createAlert({
        supabase,
        alertType: 'CDR_DELAY',
        severity: 'P1',
        resellerId: defaultResellerId,
        customerId: null,
        simId: null,
        threshold: cdrDelayHours,
        currentValue: cdrFiles.length,
        windowStart: cdrCutoff.toISOString(),
        windowEnd: windowEndIso,
        metadata: { message: 'CDR ingestion delay detected.', delayedFiles: cdrFiles.length },
        suppressMinutes: policy.suppressMinutes,
      })
      if (!result?.ok) errorCount += 1
      else if (result.value?.created) createdCount += 1
      else skippedCount += 1
    }
  }
  for (const sim of sims) {
    const simId = sim?.sim_id ? String(sim.sim_id) : null
    if (!simId) continue
    if (String(sim?.status || '') !== 'ACTIVATED') continue
    const upstreamStatus = sim?.upstream_status ? String(sim.upstream_status).toUpperCase() : null
    if (!upstreamStatus) continue
    if (!['DISCONNECTED', 'OFFLINE'].includes(upstreamStatus)) continue
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
    const upstreamDisconnectHours = resolveThreshold({
      enterpriseId,
      resellerId,
      defaultValue: defaultUpstreamDisconnectHours,
      byEnterprise: upstreamDisconnectHoursByEnterprise,
      byReseller: upstreamDisconnectHoursByReseller,
    })
    const disconnectCutoff = new Date(currentTime.getTime() - upstreamDisconnectHours * 60 * 60 * 1000)
    const updatedAt = sim?.upstream_status_updated_at ? new Date(String(sim.upstream_status_updated_at)) : null
    if (updatedAt && !Number.isNaN(updatedAt.getTime()) && updatedAt.getTime() > disconnectCutoff.getTime()) {
      continue
    }
    const result = await createAlert({
      supabase,
      alertType: 'UPSTREAM_DISCONNECT',
      severity: 'P1',
      resellerId,
      customerId: enterpriseId,
      simId,
      threshold: upstreamDisconnectHours,
      currentValue: null,
      windowStart: disconnectCutoff.toISOString(),
      windowEnd: windowEndIso,
      metadata: { message: 'SIM upstream status indicates disconnect.', upstreamStatus },
      suppressMinutes: policy.suppressMinutes,
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

async function getAlertThresholdConfig({ supabase, cacheTtlSeconds }) {
  const ttlMs = Number.isFinite(cacheTtlSeconds) ? Math.max(0, Number(cacheTtlSeconds)) * 1000 : 0
  const now = Date.now()
  if (ALERT_CONFIG_CACHE.value && ALERT_CONFIG_CACHE.expiresAt > now) {
    return ALERT_CONFIG_CACHE.value
  }
  const keys = [
    'alert.pool_usage_high.threshold_kb',
    'alert.out_of_profile_surge.threshold_kb',
    'alert.silent_sim.threshold_hours',
    'alert.cdr_delay.threshold_hours',
    'alert.upstream_disconnect.threshold_hours',
  ]
  const keyFilters = keys.map((key) => encodeURIComponent(key)).join(',')
  const rows = await supabase.select(
    'config_parameters',
    `select=param_key,scope_type,scope_id,value,value_type,enabled&enabled=eq.true&param_key=in.(${keyFilters})`
  )
  const data = Array.isArray(rows) ? rows : []
  const config = {
    thresholds: {
      POOL_USAGE_HIGH: { global: null, byReseller: new Map(), byEnterprise: new Map() },
      OUT_OF_PROFILE_SURGE: { global: null, byReseller: new Map(), byEnterprise: new Map() },
      SILENT_SIM: { global: null, byReseller: new Map(), byEnterprise: new Map() },
      CDR_DELAY: { global: null, byReseller: new Map(), byEnterprise: new Map() },
      UPSTREAM_DISCONNECT: { global: null, byReseller: new Map(), byEnterprise: new Map() },
    },
  }
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
  if (key === 'alert.pool_usage_high.threshold_kb') return thresholds.POOL_USAGE_HIGH
  if (key === 'alert.out_of_profile_surge.threshold_kb') return thresholds.OUT_OF_PROFILE_SURGE
  if (key === 'alert.silent_sim.threshold_hours') return thresholds.SILENT_SIM
  if (key === 'alert.cdr_delay.threshold_hours') return thresholds.CDR_DELAY
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
