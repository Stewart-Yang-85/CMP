import crypto from 'node:crypto'
import { createAlert } from './alerting.js'

const maxResponseBodyChars = 2000
const maxAttempts = 3
const retryBaseSeconds = 2
const supportedEventTypes = new Set([
  'SIM_STATUS_CHANGED',
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

function normalizePageSize(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.min(200, Math.floor(num))
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

function buildDeliveryPayload(event) {
  return {
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    tenantId: event.tenant_id ?? null,
    actorUserId: event.actor_user_id ?? null,
    requestId: event.request_id ?? null,
    jobId: event.job_id ?? null,
    payload: event.payload ?? {},
  }
}

async function findTenant(supabase, tenantId) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(tenantId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadSubscriptions({ supabase, customerId, resellerId }) {
  const filters = ['enabled=eq.true']
  if (customerId) filters.push(`customer_id=eq.${encodeURIComponent(customerId)}`)
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  const rows = await supabase.select(
    'webhook_subscriptions',
    `select=webhook_id,reseller_id,customer_id,url,secret,event_types,enabled,description,created_at,updated_at&${filters.join('&')}`
  )
  return Array.isArray(rows) ? rows : []
}

async function resolveResellerIdForSubscription({ supabase, subscription }) {
  if (subscription.reseller_id) return String(subscription.reseller_id)
  if (!subscription.customer_id) return null
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(String(subscription.customer_id))}&limit=1`
  )
  const tenant = Array.isArray(rows) ? rows[0] : null
  if (tenant?.parent_id) return String(tenant.parent_id)
  return String(subscription.customer_id)
}

async function persistDeliveryAttempt({ supabase, deliveryId, patch }) {
  await supabase.update('webhook_deliveries', `delivery_id=eq.${encodeURIComponent(String(deliveryId))}`, patch, {
    returning: 'minimal',
  })
}

async function attemptDelivery({ supabase, delivery, subscription, event, forceImmediate }) {
  const payload = buildDeliveryPayload(event)
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
  if (nextAttempt > maxAttempts && !forceImmediate) {
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
    const resellerId = await resolveResellerIdForSubscription({ supabase, subscription })
    if (resellerId) {
      const nowIso = new Date().toISOString()
      await createAlert({
        supabase,
        alertType: 'WEBHOOK_DELIVERY_FAILED',
        severity: 'P2',
        resellerId,
        customerId: subscription.customer_id ?? null,
        threshold: maxAttempts,
        currentValue: nextAttempt,
        windowStart: nowIso,
        metadata: {
          message: 'Webhook delivery failed after maximum retries.',
          webhookId: subscription.webhook_id,
          deliveryId: delivery.delivery_id,
          eventId: delivery.event_id,
          url: subscription.url,
          responseCode,
          responseBody,
          maxAttempts,
        },
      })
    }
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

export async function createWebhookSubscription({ supabase, payload, resellerId, customerId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const url = normalizeUrl(payload?.url)
  if (!url) return toError(400, 'BAD_REQUEST', 'url must be a valid https URL.')
  const secret = String(payload?.secret || '').trim()
  if (!secret) return toError(400, 'BAD_REQUEST', 'secret is required.')
  const eventTypes = normalizeEventTypes(payload?.eventTypes ?? payload?.event_types)
  if (!eventTypes.length) {
    return toError(400, 'BAD_REQUEST', 'eventTypes must include at least one supported event type.')
  }
  const enabled = payload?.enabled === undefined ? true : Boolean(payload.enabled)
  const description = normalizeDescription(payload?.description)
  const rows = await supabase.insert(
    'webhook_subscriptions',
    {
      reseller_id: resellerId ?? null,
      customer_id: customerId ?? null,
      url,
      secret,
      event_types: eventTypes,
      enabled,
      description,
    },
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row?.webhook_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create webhook subscription.')
  return {
    ok: true,
    value: {
      webhookId: row.webhook_id,
      resellerId: row.reseller_id ?? null,
      customerId: row.customer_id ?? null,
      url: row.url,
      secret: row.secret,
      eventTypes: row.event_types ?? [],
      enabled: row.enabled,
      description: row.description ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}

export async function listWebhookSubscriptions({ supabase, resellerId, customerId, page, pageSize }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const filters = []
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  if (customerId) filters.push(`customer_id=eq.${encodeURIComponent(customerId)}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const p = normalizePage(page, 1)
  const ps = normalizePageSize(pageSize, 20)
  const offset = (p - 1) * ps
  const { data, total } = await supabase.selectWithCount(
    'webhook_subscriptions',
    `select=webhook_id,reseller_id,customer_id,url,secret,event_types,enabled,description,created_at,updated_at&order=created_at.desc&limit=${ps}&offset=${offset}${filterQs}`
  )
  const rows = Array.isArray(data) ? data : []
  const items = rows.map((row) => ({
    webhookId: row.webhook_id,
    resellerId: row.reseller_id ?? null,
    customerId: row.customer_id ?? null,
    url: row.url,
    secret: row.secret,
    eventTypes: row.event_types ?? [],
    enabled: row.enabled,
    description: row.description ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
  return { ok: true, value: { items, total: total ?? items.length } }
}

export async function getWebhookSubscription({ supabase, webhookId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const rows = await supabase.select(
    'webhook_subscriptions',
    `select=webhook_id,reseller_id,customer_id,url,secret,event_types,enabled,description,created_at,updated_at&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  return {
    ok: true,
    value: {
      webhookId: row.webhook_id,
      resellerId: row.reseller_id ?? null,
      customerId: row.customer_id ?? null,
      url: row.url,
      secret: row.secret,
      eventTypes: row.event_types ?? [],
      enabled: row.enabled,
      description: row.description ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}

export async function updateWebhookSubscription({ supabase, webhookId, payload }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
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
  if (payload?.eventTypes !== undefined || payload?.event_types !== undefined) {
    const eventTypes = normalizeEventTypes(payload?.eventTypes ?? payload?.event_types)
    if (!eventTypes.length) {
      return toError(400, 'BAD_REQUEST', 'eventTypes must include at least one supported event type.')
    }
    update.event_types = eventTypes
  }
  if (payload?.enabled !== undefined) {
    update.enabled = Boolean(payload.enabled)
  }
  if (payload?.description !== undefined) {
    update.description = normalizeDescription(payload.description)
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
    value: {
      webhookId: row.webhook_id,
      resellerId: row.reseller_id ?? null,
      customerId: row.customer_id ?? null,
      url: row.url,
      secret: row.secret,
      eventTypes: row.event_types ?? [],
      enabled: row.enabled,
      description: row.description ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}

export async function deleteWebhookSubscription({ supabase, webhookId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const rows = await supabase.update(
    'webhook_subscriptions',
    `webhook_id=eq.${encodeURIComponent(webhookId)}`,
    { enabled: false },
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  return { ok: true, value: { webhookId: row.webhook_id } }
}

export async function listWebhookDeliveries({ supabase, webhookId, page, pageSize }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const p = normalizePage(page, 1)
  const ps = normalizePageSize(pageSize, 20)
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
  return { ok: true, value: { items, total: total ?? items.length } }
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
    `select=webhook_id,reseller_id,customer_id,url,secret,event_types,enabled,description,created_at,updated_at&webhook_id=eq.${encodeURIComponent(delivery.webhook_id)}&limit=1`
  )
  const subscription = Array.isArray(subRows) ? subRows[0] : null
  if (!subscription?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  const result = await attemptDelivery({ supabase, delivery, subscription, event, forceImmediate: true })
  return { ok: true, value: { deliveryId: delivery.delivery_id, status: result.status } }
}

export async function dispatchWebhookEvent({ supabase, event }) {
  if (!supabase || !event?.event_id) return { ok: false, reason: 'missing_event' }
  if (!event.tenant_id) return { ok: true, delivered: 0, skipped: 0 }
  const tenant = await findTenant(supabase, event.tenant_id)
  const tenantType = tenant?.tenant_type ? String(tenant.tenant_type) : null
  let customerId = null
  let resellerId = null
  if (tenantType === 'ENTERPRISE') {
    customerId = event.tenant_id
    resellerId = tenant?.parent_id ? String(tenant.parent_id) : null
  } else if (tenantType === 'RESELLER') {
    resellerId = event.tenant_id
  } else if (tenant?.parent_id) {
    const parent = await findTenant(supabase, String(tenant.parent_id))
    if (parent?.tenant_type === 'ENTERPRISE') {
      customerId = parent.tenant_id
      resellerId = parent.parent_id ? String(parent.parent_id) : null
    }
  }
  const subscriptions = [
    ...(await loadSubscriptions({ supabase, customerId })),
    ...(await loadSubscriptions({ supabase, resellerId })),
  ]
  if (!subscriptions.length) return { ok: true, delivered: 0, skipped: 0 }
  const matched = subscriptions.filter((sub) => {
    const list = Array.isArray(sub.event_types) ? sub.event_types : []
    return list.includes(event.event_type)
  })
  if (!matched.length) return { ok: true, delivered: 0, skipped: subscriptions.length }
  let delivered = 0
  let skipped = 0
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
    const result = await attemptDelivery({ supabase, delivery, subscription, event })
    if (result.status === 'SENT') delivered += 1
  }
  return { ok: true, delivered, skipped }
}
