import crypto from 'node:crypto'
import { createAlert } from './alerting.js'
import { lookupResellerRecordId, resolveResellerTenantIdFromContext } from './resellerTenantScope.js'

const maxResponseBodyChars = 2000
const maxAttempts = 3
const retryBaseSeconds = 2
const supportedEventTypes = new Set([
  'SIM_STATUS_CHANGED',
  'JOB_FINISHED',
  'SUBSCRIPTION_CHANGED',
  'BILL_PUBLISHED',
  'PAYMENT_CONFIRMED',
  'ALERT_TRIGGERED',
  'ENTERPRISE_STATUS_CHANGED',
])

function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function normalizePage(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function normalizePageSize(value, fallback, max = 200) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.min(max, Math.floor(num))
}

function normalizeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  return parsed.toString()
}

function normalizeEventTypes(value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  return Array.from(
    new Set(
      list
        .map((item) => String(item || '').trim().toUpperCase())
        .filter((item) => item && supportedEventTypes.has(item))
    )
  )
}

/** Scheme A: exactly one event type per subscription (`eventType` or single-element `eventTypes`). */
function resolveSingleEventType(payload) {
  const hasSingular = payload?.eventType !== undefined || payload?.event_type !== undefined
  const hasPlural = payload?.eventTypes !== undefined || payload?.event_types !== undefined

  if (hasSingular) {
    const eventType = String((payload?.eventType ?? payload?.event_type) || '')
      .trim()
      .toUpperCase()
    if (!eventType || !supportedEventTypes.has(eventType)) {
      return toError(400, 'BAD_REQUEST', 'eventType must be a supported outbound webhook event type.')
    }
    if (hasPlural) {
      const list = normalizeEventTypes(payload?.eventTypes ?? payload?.event_types)
      if (list.length !== 1 || list[0] !== eventType) {
        return toError(
          400,
          'BAD_REQUEST',
          'When both eventType and eventTypes are provided, eventTypes must be a single-element array matching eventType.'
        )
      }
    }
    return { ok: true, value: eventType }
  }

  if (hasPlural) {
    const list = normalizeEventTypes(payload?.eventTypes ?? payload?.event_types)
    if (!list.length) {
      return toError(400, 'BAD_REQUEST', 'eventTypes must include exactly one supported event type.')
    }
    if (list.length > 1) {
      return toError(
        400,
        'BAD_REQUEST',
        'Each webhook subscription binds exactly one event type (Scheme A). Use one subscription per event type / URL.'
      )
    }
    return { ok: true, value: list[0] }
  }

  return toError(400, 'BAD_REQUEST', 'eventType is required (or eventTypes with exactly one supported type).')
}

async function findLiveWebhookConflict({ supabase, resellerId, enterpriseId, eventType, excludeWebhookId }) {
  const liveFilter = 'status=in.(ACTIVE,INACTIVE)'
  const eventFilter = `event_types=eq.{${encodeURIComponent(eventType)}}`
  const excludeFilter = excludeWebhookId
    ? `&webhook_id=neq.${encodeURIComponent(excludeWebhookId)}`
    : ''
  if (enterpriseId) {
    const rows = await supabase.select(
      'webhook_subscriptions',
      `select=webhook_id&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&${eventFilter}&${liveFilter}${excludeFilter}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row?.webhook_id ? String(row.webhook_id) : null
  }
  if (resellerId) {
    const rows = await supabase.select(
      'webhook_subscriptions',
      `select=webhook_id&reseller_id=eq.${encodeURIComponent(resellerId)}&enterprise_id=is.null&${eventFilter}&${liveFilter}${excludeFilter}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row?.webhook_id ? String(row.webhook_id) : null
  }
  return null
}

function mapSubscriptionRow(row) {
  const status = String(row.status || (row.enabled ? 'ACTIVE' : 'INACTIVE')).toUpperCase()
  const types = Array.isArray(row.event_types) ? row.event_types : []
  const eventType = String(types[0] || '').trim().toUpperCase()
  return {
    webhookId: row.webhook_id,
    resellerId: row.reseller_id ?? null,
    enterpriseId: row.enterprise_id ?? null,
    url: row.url,
    secret: row.secret,
    eventType,
    eventTypes: eventType ? [eventType] : [],
    enabled: row.enabled === true && status === 'ACTIVE',
    status,
    description: row.description ?? null,
    deprecatedAt: row.deprecated_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeDescription(value) {
  if (value === undefined) return undefined
  const text = String(value || '').trim()
  return text.length ? text : null
}

function buildSignature(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function toPayloadString(payload) {
  return JSON.stringify(payload ?? {})
}

function truncateResponseBody(value) {
  if (!value) return null
  if (value.length <= maxResponseBodyChars) return value
  return value.slice(0, maxResponseBodyChars)
}

function getRetryDelaySeconds(attempt) {
  return retryBaseSeconds * Math.pow(2, Math.max(0, attempt - 1))
}

async function buildDeliveryPayload(supabase, event) {
  const nestedRaw = event.payload && typeof event.payload === 'object' ? { ...event.payload } : {}
  let resellerId = null
  let resellerRecordId = null
  if (event.tenant_id) {
    resellerId = await resolveResellerTenantIdFromContext(supabase, event.tenant_id)
    if (resellerId) {
      resellerRecordId = await lookupResellerRecordId(supabase, resellerId)
    }
  }
  if (resellerId) {
    nestedRaw.resellerId = resellerId
  } else {
    delete nestedRaw.resellerId
  }
  const out = {
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    tenantId: event.tenant_id ?? null,
    actorUserId: event.actor_user_id ?? null,
    requestId: event.request_id ?? null,
    jobId: event.job_id ?? null,
    payload: nestedRaw,
  }
  if (resellerId) {
    out.resellerId = resellerId
    if (resellerRecordId) out.resellerRecordId = resellerRecordId
  }
  return out
}

async function findTenant(supabase, tenantId) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(tenantId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadSubscriptions({ supabase, enterpriseId, resellerId }) {
  const filters = ['enabled=eq.true']
  if (enterpriseId) {
    filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  } else if (resellerId) {
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
    filters.push('enterprise_id=is.null')
  } else {
    return []
  }
  const rows = await supabase.select(
    'webhook_subscriptions',
    `select=webhook_id,reseller_id,enterprise_id,url,secret,event_types,enabled,description,created_at,updated_at&${filters.join('&')}`
  )
  return Array.isArray(rows) ? rows : []
}

async function resolveResellerIdForSubscription({ supabase, subscription }) {
  if (subscription.reseller_id) return String(subscription.reseller_id)
  if (!subscription.enterprise_id) return null
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(String(subscription.enterprise_id))}&limit=1`
  )
  const tenant = Array.isArray(rows) ? rows[0] : null
  if (tenant?.parent_id) return String(tenant.parent_id)
  return String(subscription.enterprise_id)
}

function mapAlertRuleConfigRow(row) {
  if (!row) return null
  return {
    configId: row.config_id ?? null,
    enabled: row.enabled !== false,
    severity: row.severity ? String(row.severity) : 'P2',
    thresholdValue: Number.isFinite(Number(row.threshold_value)) ? Number(row.threshold_value) : maxAttempts,
    thresholdUnit: row.threshold_unit ? String(row.threshold_unit) : 'ATTEMPTS',
    suppressMinutes: Number.isFinite(Number(row.suppress_minutes)) ? Number(row.suppress_minutes) : 30,
    deliveryChannels: Array.isArray(row.delivery_channels) ? row.delivery_channels.map(String) : ['PORTAL'],
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : null,
  }
}

function mapAlertConfigItemRow(row) {
  if (!row) return null
  return {
    configId: row.config_item_id ?? null,
    enabled: row.enabled !== false,
    severity: row.severity ? String(row.severity) : 'P2',
    thresholdValue: Number.isFinite(Number(row.threshold_value)) ? Number(row.threshold_value) : maxAttempts,
    thresholdUnit: row.threshold_unit ? String(row.threshold_unit) : 'ATTEMPTS',
    suppressMinutes: Number.isFinite(Number(row.suppress_minutes)) ? Number(row.suppress_minutes) : 30,
    deliveryChannels: Array.isArray(row.delivery_channels) ? row.delivery_channels.map(String) : ['PORTAL'],
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : null,
  }
}

async function loadActiveWebhookFailureProfile({ supabase, scopeType, resellerId, enterpriseId }) {
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
    const body = String(err?.body || err?.message || '')
    if (body.includes('alert_config_profiles') || body.includes('does not exist')) return null
    throw err
  }
}

async function loadWebhookFailureAbcRule({ supabase, scopeType, resellerId, enterpriseId }) {
  const profileId = await loadActiveWebhookFailureProfile({ supabase, scopeType, resellerId, enterpriseId })
  if (!profileId) return null
  try {
    const rows = await supabase.select(
      'alert_config_items',
      `select=config_item_id,enabled,severity,threshold_value,threshold_unit,suppress_minutes,delivery_channels,version&config_profile_id=eq.${encodeURIComponent(profileId)}&alert_type=eq.WEBHOOK_DELIVERY_FAILED&limit=1`,
      { suppressMissingColumns: true }
    )
    return mapAlertConfigItemRow(Array.isArray(rows) ? rows[0] : null)
  } catch (err) {
    const body = String(err?.body || err?.message || '')
    if (body.includes('alert_config_items') || body.includes('does not exist')) return null
    throw err
  }
}

async function loadWebhookFailureRule({ supabase, scopeType, resellerId, enterpriseId }) {
  const filters = [
    'alert_type=eq.WEBHOOK_DELIVERY_FAILED',
    `scope_type=eq.${encodeURIComponent(scopeType)}`,
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
      `select=config_id,enabled,severity,threshold_value,threshold_unit,suppress_minutes,delivery_channels,version&${filters.join('&')}&limit=1`,
      { suppressMissingColumns: true }
    )
    return mapAlertRuleConfigRow(Array.isArray(rows) ? rows[0] : null)
  } catch (err) {
    const body = String(err?.body || err?.message || '')
    if (body.includes('alert_rule_configs') || body.includes('does not exist')) return null
    throw err
  }
}

async function resolveWebhookFailureRule({ supabase, resellerId, enterpriseId }) {
  let rule = null
  if (resellerId && enterpriseId) {
    rule = await loadWebhookFailureAbcRule({ supabase, scopeType: 'ENTERPRISE', resellerId, enterpriseId })
    if (rule) return rule.enabled ? rule : null
    rule = await loadWebhookFailureRule({ supabase, scopeType: 'ENTERPRISE', resellerId, enterpriseId })
    if (rule) return rule.enabled ? rule : null
  }
  if (resellerId) {
    rule = await loadWebhookFailureAbcRule({ supabase, scopeType: 'RESELLER', resellerId, enterpriseId: null })
    if (rule) return rule.enabled ? rule : null
    rule = await loadWebhookFailureRule({ supabase, scopeType: 'RESELLER', resellerId, enterpriseId: null })
    if (rule) return rule.enabled ? rule : null
  }
  rule = await loadWebhookFailureAbcRule({ supabase, scopeType: 'PLATFORM', resellerId: null, enterpriseId: null })
  if (rule) return rule.enabled ? rule : null
  rule = await loadWebhookFailureRule({ supabase, scopeType: 'PLATFORM', resellerId: null, enterpriseId: null })
  if (rule) return rule.enabled ? rule : null
  return {
    configId: null,
    enabled: true,
    severity: 'P2',
    thresholdValue: maxAttempts,
    thresholdUnit: 'ATTEMPTS',
    suppressMinutes: 30,
    deliveryChannels: ['PORTAL'],
    version: null,
  }
}

async function createWebhookDeliveryFailedAlert({ supabase, subscription, delivery, responseCode, responseBody, attempt }) {
  const resellerId = await resolveResellerIdForSubscription({ supabase, subscription })
  if (!resellerId) return
  const rule = await resolveWebhookFailureRule({ supabase, resellerId, enterpriseId: subscription.enterprise_id ?? null })
  if (!rule) return
  const nowIso = new Date().toISOString()
  await createAlert({
    supabase,
    alertType: 'WEBHOOK_DELIVERY_FAILED',
    severity: rule.severity ?? 'P2',
    resellerId,
    customerId: subscription.enterprise_id ?? null,
    threshold: rule.thresholdValue ?? maxAttempts,
    currentValue: attempt,
    windowStart: nowIso,
    ruleId: rule.configId ?? null,
    ruleVersion: rule.version ?? null,
    deliveryChannels: rule.deliveryChannels ?? null,
    suppressMinutes: rule.suppressMinutes ?? 30,
    metadata: {
      message: 'Webhook delivery failed after maximum retries.',
      webhookId: subscription.webhook_id,
      deliveryId: delivery.delivery_id,
      eventId: delivery.event_id,
      url: subscription.url,
      responseCode,
      responseBody,
      maxAttempts,
      thresholdUnit: rule.thresholdUnit ?? 'ATTEMPTS',
    },
  })
}

async function persistDeliveryAttempt({ supabase, deliveryId, patch }) {
  await supabase.update('webhook_deliveries', `delivery_id=eq.${encodeURIComponent(String(deliveryId))}`, patch, {
    returning: 'minimal',
  })
}

async function attemptDelivery({ supabase, delivery, subscription, event, forceImmediate }) {
  const payload = await buildDeliveryPayload(supabase, event)
  const body = toPayloadString(payload)
  const signature = buildSignature(subscription.secret, body)
  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': `sha256=${signature}`,
    'X-Webhook-Event': event.event_type,
    'X-Webhook-Delivery-Id': String(delivery.delivery_id),
    'X-Webhook-Timestamp': String(Math.floor(Date.now() / 1000)),
  }
  let responseCode = null
  let responseBody = null
  let ok = false
  try {
    const res = await fetch(subscription.url, {
      method: 'POST',
      headers,
      body,
    })
    responseCode = res.status
    const text = await res.text()
    responseBody = truncateResponseBody(text)
    ok = res.ok
  } catch (error) {
    responseBody = truncateResponseBody(error?.message ? String(error.message) : 'WEBHOOK_REQUEST_FAILED')
  }
  if (ok) {
    await persistDeliveryAttempt({
      supabase,
      deliveryId: delivery.delivery_id,
      patch: {
        status: 'SENT',
        response_code: responseCode,
        response_body: responseBody,
        next_retry_at: null,
      },
    })
    return { status: 'SENT', responseCode, responseBody }
  }
  const nextAttempt = delivery.attempt + 1
  if (nextAttempt > maxAttempts) {
    await persistDeliveryAttempt({
      supabase,
      deliveryId: delivery.delivery_id,
      patch: {
        status: 'FAILED',
        response_code: responseCode,
        response_body: responseBody,
        next_retry_at: null,
      },
    })
    await createWebhookDeliveryFailedAlert({ supabase, subscription, delivery, responseCode, responseBody, attempt: nextAttempt })
    return { status: 'FAILED', responseCode, responseBody }
  }
  const delaySeconds = getRetryDelaySeconds(delivery.attempt)
  const nextRetryAt = new Date(Date.now() + delaySeconds * 1000).toISOString()
  await persistDeliveryAttempt({
    supabase,
    deliveryId: delivery.delivery_id,
    patch: {
      status: 'PENDING',
      attempt: nextAttempt,
      response_code: responseCode,
      response_body: responseBody,
      next_retry_at: nextRetryAt,
    },
  })
  return { status: 'RETRY_SCHEDULED', responseCode, responseBody, nextRetryAt }
}

export async function createWebhookSubscription({ supabase, payload, resellerId, enterpriseId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const url = normalizeUrl(payload?.url)
  if (!url) return toError(400, 'BAD_REQUEST', 'url must be a valid https URL.')
  const secret = String(payload?.secret || '').trim()
  if (!secret) return toError(400, 'BAD_REQUEST', 'secret is required.')
  const eventTypeResult = resolveSingleEventType(payload)
  if (!eventTypeResult.ok) return eventTypeResult
  const eventType = eventTypeResult.value
  const eventTypes = [eventType]
  const enabled = payload?.enabled === undefined ? true : Boolean(payload.enabled)
  const status = enabled ? 'ACTIVE' : 'INACTIVE'
  const description = normalizeDescription(payload?.description)

  const conflictId = await findLiveWebhookConflict({ supabase, resellerId, enterpriseId, eventType })
  if (conflictId) {
    const scopeLabel = enterpriseId
      ? `enterpriseId ${enterpriseId}`
      : `resellerId ${resellerId} (reseller-level)`
    return toError(
      409,
      'DUPLICATE',
      `A live webhook subscription already exists for ${scopeLabel} and eventType ${eventType}. Deprecate it before creating another for this event type.`
    )
  }

  const rows = await supabase.insert(
    'webhook_subscriptions',
    {
      reseller_id: resellerId ?? null,
      enterprise_id: enterpriseId ?? null,
      url,
      secret,
      event_types: eventTypes,
      enabled,
      status,
      description,
    },
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row?.webhook_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create webhook subscription.')
  return {
    ok: true,
    value: mapSubscriptionRow(row),
  }
}

export async function listWebhookSubscriptions({ supabase, resellerId, enterpriseId, status, page, pageSize }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const allowed = ['ACTIVE', 'INACTIVE', 'DEPRECATED']
  let statuses = allowed
  if (status != null && String(status).trim() !== '') {
    const key = String(status).trim().toUpperCase()
    if (!allowed.includes(key)) {
      return toError(400, 'BAD_REQUEST', `status must be one of: ${allowed.join(', ')}.`)
    }
    statuses = [key]
  }
  const filters = []
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  const statusQs =
    statuses.length === 1
      ? `status=eq.${encodeURIComponent(statuses[0])}`
      : `status=in.(${statuses.map((s) => encodeURIComponent(s)).join(',')})`
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const p = normalizePage(page, 1)
  const ps = normalizePageSize(pageSize, 50, 100)
  const offset = (p - 1) * ps
  const { data, total } = await supabase.selectWithCount(
    'webhook_subscriptions',
    `select=webhook_id,reseller_id,enterprise_id,url,secret,event_types,enabled,status,description,deprecated_at,created_at,updated_at&${statusQs}&order=created_at.desc&limit=${ps}&offset=${offset}${filterQs}`
  )
  const rows = Array.isArray(data) ? data : []
  const items = rows.map((row) => mapSubscriptionRow(row))
  return { ok: true, value: { items, total: total ?? items.length, page: p, pageSize: ps } }
}

export async function getWebhookSubscription({ supabase, webhookId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const rows = await supabase.select(
    'webhook_subscriptions',
    `select=webhook_id,reseller_id,enterprise_id,url,secret,event_types,enabled,description,created_at,updated_at&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  return {
    ok: true,
    value: mapSubscriptionRow(row),
  }
}

export async function updateWebhookSubscription({ supabase, webhookId, payload }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const existingRows = await supabase.select(
    'webhook_subscriptions',
    `select=webhook_id,reseller_id,enterprise_id,event_types,status&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`
  )
  const existing = Array.isArray(existingRows) ? existingRows[0] : null
  if (!existing?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  if (String(existing.status || '').toUpperCase() === 'DEPRECATED') {
    return toError(
      409,
      'INVALID_STATUS',
      'Cannot update a deprecated webhook subscription. Create a new subscription for this scope after deprecate.'
    )
  }
  const update = { updated_at: new Date().toISOString() }
  if (payload?.url !== undefined) {
    const url = normalizeUrl(payload.url)
    if (!url) return toError(400, 'BAD_REQUEST', 'url must be a valid https URL.')
    update.url = url
  }
  if (payload?.secret !== undefined) {
    const secret = String(payload.secret || '').trim()
    if (!secret) return toError(400, 'BAD_REQUEST', 'secret cannot be empty.')
    update.secret = secret
  }
  let nextEventType = null
  if (
    payload?.eventType !== undefined ||
    payload?.event_type !== undefined ||
    payload?.eventTypes !== undefined ||
    payload?.event_types !== undefined
  ) {
    const eventTypeResult = resolveSingleEventType(payload)
    if (!eventTypeResult.ok) return eventTypeResult
    nextEventType = eventTypeResult.value
    update.event_types = [nextEventType]
  }
  if (payload?.status !== undefined) {
    return toError(
      400,
      'BAD_REQUEST',
      'status is not supported on PATCH. Use enabled (true→ACTIVE, false→INACTIVE) or POST .../{webhookId}:deprecate.'
    )
  }
  if (payload?.enabled !== undefined) {
    update.enabled = Boolean(payload.enabled)
    update.status = payload.enabled ? 'ACTIVE' : 'INACTIVE'
  }
  if (payload?.description !== undefined) {
    update.description = normalizeDescription(payload.description)
  }
  if (nextEventType) {
    const conflictId = await findLiveWebhookConflict({
      supabase,
      resellerId: existing.reseller_id ?? null,
      enterpriseId: existing.enterprise_id ?? null,
      eventType: nextEventType,
      excludeWebhookId: webhookId,
    })
    if (conflictId) {
      const scopeLabel = existing.enterprise_id
        ? `enterpriseId ${existing.enterprise_id}`
        : `resellerId ${existing.reseller_id} (reseller-level)`
      return toError(
        409,
        'DUPLICATE',
        `A live webhook subscription already exists for ${scopeLabel} and eventType ${nextEventType}. Deprecate it before changing this subscription.`
      )
    }
  }
  if (Object.keys(update).length === 1) {
    return toError(400, 'BAD_REQUEST', 'No valid fields to update.')
  }
  const rows = await supabase.update('webhook_subscriptions', `webhook_id=eq.${encodeURIComponent(webhookId)}`, update, {
    returning: 'representation',
  })
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  return {
    ok: true,
    value: mapSubscriptionRow(row),
  }
}

export async function deprecateWebhookSubscription({ supabase, webhookId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const existingRows = await supabase.select(
    'webhook_subscriptions',
    `select=webhook_id,status&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`
  )
  const existing = Array.isArray(existingRows) ? existingRows[0] : null
  if (!existing?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  if (String(existing.status || '').toUpperCase() === 'DEPRECATED') {
    return toError(409, 'INVALID_STATUS', 'Webhook subscription is already deprecated.')
  }
  const nowIso = new Date().toISOString()
  const rows = await supabase.update(
    'webhook_subscriptions',
    `webhook_id=eq.${encodeURIComponent(webhookId)}`,
    { enabled: false, status: 'DEPRECATED', deprecated_at: nowIso, updated_at: nowIso },
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  return {
    ok: true,
    value: {
      webhookId: row.webhook_id,
      deprecated: true,
      status: 'DEPRECATED',
      deprecatedAt: row.deprecated_at ?? nowIso,
    },
  }
}

/** @deprecated Use deprecateWebhookSubscription */
export async function deleteWebhookSubscription(args) {
  return deprecateWebhookSubscription(args)
}

export async function listWebhookDeliveries({ supabase, webhookId, page, pageSize }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const p = normalizePage(page, 1)
  const ps = normalizePageSize(pageSize, 50, 100)
  const offset = (p - 1) * ps
  const { data, total } = await supabase.selectWithCount(
    'webhook_deliveries',
    `select=delivery_id,webhook_id,event_id,attempt,status,response_code,response_body,next_retry_at,created_at,events(event_type)&webhook_id=eq.${encodeURIComponent(webhookId)}&order=created_at.desc&limit=${ps}&offset=${offset}`
  )
  const rows = Array.isArray(data) ? data : []
  const items = rows.map((row) => ({
    deliveryId: row.delivery_id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.events?.event_type ?? null,
    attempt: row.attempt,
    status: row.status,
    responseCode: row.response_code ?? null,
    responseBody: row.response_body ?? null,
    nextRetryAt: row.next_retry_at ?? null,
    createdAt: row.created_at,
  }))
  return { ok: true, value: { items, total: total ?? items.length, page: p, pageSize: ps } }
}

export async function retryWebhookDelivery({ supabase, deliveryId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const rows = await supabase.select(
    'webhook_deliveries',
    `select=delivery_id,webhook_id,event_id,attempt,status,response_code,response_body,next_retry_at,created_at&delivery_id=eq.${encodeURIComponent(String(deliveryId))}&limit=1`
  )
  const delivery = Array.isArray(rows) ? rows[0] : null
  if (!delivery?.delivery_id) return toError(404, 'NOT_FOUND', 'webhook delivery not found.')
  const eventRows = await supabase.select(
    'events',
    `select=event_id,event_type,occurred_at,tenant_id,actor_user_id,request_id,job_id,payload&event_id=eq.${encodeURIComponent(delivery.event_id)}&limit=1`
  )
  const event = Array.isArray(eventRows) ? eventRows[0] : null
  if (!event?.event_id) return toError(404, 'NOT_FOUND', 'event not found for delivery.')
  const subRows = await supabase.select(
    'webhook_subscriptions',
    `select=webhook_id,reseller_id,enterprise_id,url,secret,event_types,enabled,description,created_at,updated_at&webhook_id=eq.${encodeURIComponent(delivery.webhook_id)}&limit=1`
  )
  const subscription = Array.isArray(subRows) ? subRows[0] : null
  if (!subscription?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  const result = await attemptDelivery({ supabase, delivery, subscription, event })
  return { ok: true, value: { deliveryId: delivery.delivery_id, status: result.status } }
}

export async function dispatchWebhookEvent({ supabase, event }) {
  if (!supabase || !event?.event_id) return { ok: false, reason: 'missing_event' }
  if (!event.tenant_id) return { ok: true, delivered: 0, skipped: 0 }
  const tenant = await findTenant(supabase, event.tenant_id)
  const tenantType = tenant?.tenant_type ? String(tenant.tenant_type) : null
  let enterpriseId = null
  let resellerId = null
  if (tenantType === 'ENTERPRISE') {
    enterpriseId = event.tenant_id
    resellerId = tenant?.parent_id ? String(tenant.parent_id) : null
  } else if (tenantType === 'RESELLER') {
    resellerId = event.tenant_id
  } else if (tenant?.parent_id) {
    const parent = await findTenant(supabase, String(tenant.parent_id))
    if (parent?.tenant_type === 'ENTERPRISE') {
      enterpriseId = parent.tenant_id
      resellerId = parent.parent_id ? String(parent.parent_id) : null
    }
  }
  const loaded = [
    ...(await loadSubscriptions({ supabase, enterpriseId })),
    ...(await loadSubscriptions({ supabase, resellerId })),
  ]
  const seen = new Set()
  const subscriptions = []
  for (const sub of loaded) {
    const id = String(sub.webhook_id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    subscriptions.push(sub)
  }
  if (!subscriptions.length) return { ok: true, delivered: 0, skipped: 0 }
  const matched = subscriptions.filter((sub) => {
    const list = Array.isArray(sub.event_types) ? sub.event_types : []
    return list.includes(event.event_type)
  })
  if (!matched.length) return { ok: true, delivered: 0, skipped: subscriptions.length }
  let delivered = 0
  let skipped = 0
  const deliveryIds = []
  for (const subscription of matched) {
    const rows = await supabase.insert(
      'webhook_deliveries',
      {
        webhook_id: subscription.webhook_id,
        event_id: event.event_id,
        attempt: 1,
        status: 'PENDING',
      },
      { returning: 'representation' }
    )
    const delivery = Array.isArray(rows) ? rows[0] : null
    if (!delivery?.delivery_id) {
      skipped += 1
      continue
    }
    deliveryIds.push(Number(delivery.delivery_id))
    const result = await attemptDelivery({ supabase, delivery, subscription, event })
    if (result.status === 'SENT') delivered += 1
  }
  return { ok: true, delivered, skipped, deliveryIds }
}
