import crypto from 'node:crypto'
import { createAlert } from './alerting.js'
import { resolveEffectiveAlertConfigProfile } from './alertConfigProfile.js'
import { lookupResellerRecordId } from './resellerTenantScope.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string> }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

type WebhookSubscriptionRow = {
  webhook_id: string
  reseller_id?: string | null
  enterprise_id?: string | null
  url: string
  secret: string
  event_types: string[]
  enabled: boolean
  status?: string | null
  description?: string | null
  deprecated_at?: string | null
  created_at: string
  updated_at: string
}

type WebhookSubscriptionApi = {
  webhookId: string
  resellerId: string | null
  enterpriseId: string | null
  url: string
  secret: string
  eventTypes: string[]
  enabled: boolean
  status: string
  description: string | null
  deprecatedAt: string | null
  createdAt: string
  updatedAt: string
}

type WebhookDeliveryRow = {
  delivery_id: number
  webhook_id: string
  event_id: string
  attempt: number
  status: string
  response_code?: number | null
  response_body?: string | null
  next_retry_at?: string | null
  created_at: string
  events?: { event_type?: string | null } | null
}

type EventRow = {
  event_id: string
  event_type: string
  occurred_at: string
  enterprise_id?: string | null
  reseller_id?: string | null
  actor_user_id?: string | null
  request_id?: string | null
  job_id?: string | null
  payload?: Record<string, unknown> | null
}

const maxResponseBodyChars = 2000
const maxAttempts = 3
const retryBaseSeconds = 2

/** Outbound webhook event types allowed in `webhook_subscriptions.event_types` (FR-039). */
const OUTBOUND_WEBHOOK_EVENT_CATALOG = [
  {
    eventType: 'SIM_STATUS_CHANGED',
    displayName: 'SIM Status Changed',
    description: 'SIM lifecycle status changed to a new steady state (after upstream confirmation when applicable).',
  },
  {
    eventType: 'JOB_FINISHED',
    displayName: 'Job Finished',
    description: 'Async job reached a terminal state (SUCCEEDED or FAILED), e.g. SIM_STATUS_CHANGE.',
  },
  {
    eventType: 'SUBSCRIPTION_CHANGED',
    displayName: 'Subscription Changed',
    description: 'Enterprise subscription create/update/cancel or related subscription state change.',
  },
  {
    eventType: 'BILL_PUBLISHED',
    displayName: 'Bill Published',
    description: 'Bill moved to a published/customer-visible billing state.',
  },
  {
    eventType: 'PAYMENT_CONFIRMED',
    displayName: 'Payment Confirmed',
    description: 'Payment or mark-paid confirmation recorded for a bill.',
  },
  {
    eventType: 'ALERT_TRIGGERED',
    displayName: 'Alert Triggered',
    description: 'Alert created and eligible for WEBHOOK delivery channel to the customer URL.',
  },
  {
    eventType: 'ENTERPRISE_STATUS_CHANGED',
    displayName: 'Enterprise Status Changed',
    description: 'Enterprise (customer) tenant status changed.',
  },
] as const

const supportedEventTypes: Set<string> = new Set(OUTBOUND_WEBHOOK_EVENT_CATALOG.map((e) => e.eventType))

export type OutboundWebhookEventCatalogItem = {
  eventType: string
  displayName: string
  description: string
}

/** Platform catalog of event types that may be subscribed for outbound (CMP → customer) webhooks. */
export function listOutboundWebhookEvents(): { items: OutboundWebhookEventCatalogItem[] } {
  return {
    items: OUTBOUND_WEBHOOK_EVENT_CATALOG.map((e) => ({
      eventType: e.eventType,
      displayName: e.displayName,
      description: e.description,
    })),
  }
}

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

function normalizePage(value: unknown, fallback: number) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function normalizePageSize(value: unknown, fallback: number, max = 200) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.min(max, Math.floor(num))
}

function normalizeUrl(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  return parsed.toString()
}

function normalizeEventTypes(value: unknown) {
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

function normalizeDescription(value: unknown) {
  if (value === undefined) return undefined
  const text = String(value || '').trim()
  return text.length ? text : null
}

function buildSignature(secret: string, body: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function toPayloadString(payload: unknown) {
  return JSON.stringify(payload ?? {})
}

function truncateResponseBody(value: string | null | undefined) {
  if (!value) return null
  if (value.length <= maxResponseBodyChars) return value
  return value.slice(0, maxResponseBodyChars)
}

function getRetryDelaySeconds(attempt: number) {
  return retryBaseSeconds * Math.pow(2, Math.max(0, attempt - 1))
}

async function buildDeliveryPayload(supabase: SupabaseClient, event: EventRow) {
  const nestedRaw =
    event.payload && typeof event.payload === 'object' ? { ...(event.payload as Record<string, unknown>) } : {}
  delete nestedRaw.resellerId
  const resellerId = event.reseller_id ?? null
  let resellerRecordId: string | null = null
  if (resellerId) {
    resellerRecordId = await lookupResellerRecordId(supabase, resellerId)
  }
  const out: Record<string, unknown> = {
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: event.occurred_at,
    enterpriseId: event.enterprise_id ?? null,
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

const WEBHOOK_STATUSES = ['ACTIVE', 'INACTIVE', 'DEPRECATED'] as const
const LIVE_WEBHOOK_STATUSES = ['ACTIVE', 'INACTIVE'] as const

function parseListWebhookStatusFilter(value: unknown): ServiceResult<(typeof WEBHOOK_STATUSES)[number][]> {
  if (value == null || String(value).trim() === '') {
    // Default: include DEPRECATED so clients can audit soft-deleted subscriptions.
    return { ok: true, value: [...WEBHOOK_STATUSES] }
  }
  const key = String(value).trim().toUpperCase()
  if (!(WEBHOOK_STATUSES as readonly string[]).includes(key)) {
    return toError(400, 'BAD_REQUEST', `status must be one of: ${WEBHOOK_STATUSES.join(', ')}.`)
  }
  return { ok: true, value: [key as (typeof WEBHOOK_STATUSES)[number]] }
}

function normalizeWebhookStatus(value: unknown): string {
  const s = String(value || '').trim().toUpperCase()
  if (s === 'ACTIVE' || s === 'INACTIVE' || s === 'DEPRECATED') return s
  return 'ACTIVE'
}

function statusFromEnabled(enabled: boolean): 'ACTIVE' | 'INACTIVE' {
  return enabled ? 'ACTIVE' : 'INACTIVE'
}

function mapSubscriptionRow(row: WebhookSubscriptionRow): WebhookSubscriptionApi {
  const status = normalizeWebhookStatus(row.status ?? (row.enabled ? 'ACTIVE' : 'INACTIVE'))
  return {
    webhookId: row.webhook_id,
    resellerId: row.reseller_id ?? null,
    enterpriseId: row.enterprise_id ?? null,
    url: row.url,
    secret: row.secret,
    eventTypes: row.event_types ?? [],
    enabled: row.enabled === true && status === 'ACTIVE',
    status,
    description: row.description ?? null,
    deprecatedAt: row.deprecated_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const subscriptionSelect =
  'webhook_id,reseller_id,enterprise_id,url,secret,event_types,enabled,status,description,deprecated_at,created_at,updated_at'

async function findLiveWebhookConflict({
  supabase,
  resellerId,
  enterpriseId,
  excludeWebhookId,
}: {
  supabase: SupabaseClient
  resellerId?: string | null
  enterpriseId?: string | null
  excludeWebhookId?: string | null
}): Promise<string | null> {
  const liveFilter = `status=in.(${LIVE_WEBHOOK_STATUSES.map((s) => encodeURIComponent(s)).join(',')})`
  const excludeFilter = excludeWebhookId
    ? `&webhook_id=neq.${encodeURIComponent(excludeWebhookId)}`
    : ''
  if (enterpriseId) {
    const rows = await supabase.select(
      'webhook_subscriptions',
      `select=webhook_id&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&${liveFilter}${excludeFilter}&limit=1`
    )
    const row = Array.isArray(rows) ? (rows[0] as { webhook_id?: string } | undefined) : null
    return row?.webhook_id ? String(row.webhook_id) : null
  }
  if (resellerId) {
    const rows = await supabase.select(
      'webhook_subscriptions',
      `select=webhook_id&reseller_id=eq.${encodeURIComponent(resellerId)}&enterprise_id=is.null&${liveFilter}${excludeFilter}&limit=1`
    )
    const row = Array.isArray(rows) ? (rows[0] as { webhook_id?: string } | undefined) : null
    return row?.webhook_id ? String(row.webhook_id) : null
  }
  return null
}

async function loadSubscriptions({
  supabase,
  enterpriseId,
  resellerId,
}: {
  supabase: SupabaseClient
  enterpriseId?: string | null
  resellerId?: string | null
}) {
  const filters: string[] = ['enabled=eq.true']
  if (enterpriseId) {
    // Enterprise-scoped subscriptions (may also store reseller_id for tenancy).
    filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  } else if (resellerId) {
    // Reseller-level only — exclude enterprise-scoped rows that also have reseller_id filled.
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
    filters.push('enterprise_id=is.null')
  } else {
    return []
  }
  const rows = await supabase.select(
    'webhook_subscriptions',
    `select=${subscriptionSelect}&${filters.join('&')}`
  )
  return Array.isArray(rows) ? (rows as WebhookSubscriptionRow[]) : []
}

async function resolveResellerIdForSubscription({
  supabase,
  subscription,
}: {
  supabase: SupabaseClient
  subscription: WebhookSubscriptionRow
}) {
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

async function createWebhookDeliveryFailedAlert({
  supabase,
  subscription,
  delivery,
  responseCode,
  responseBody,
  attempt,
}: {
  supabase: SupabaseClient
  subscription: WebhookSubscriptionRow
  delivery: WebhookDeliveryRow
  responseCode: number | null
  responseBody: string | null
  attempt: number
}) {
  const resellerId = await resolveResellerIdForSubscription({ supabase, subscription })
  if (!resellerId) return
  const rule = await resolveEffectiveAlertConfigProfile({
    supabase,
    alertType: 'WEBHOOK_DELIVERY_FAILED',
    resellerId,
    enterpriseId: subscription.enterprise_id ?? null,
  })
  if (!rule.ok || rule.value.enabled === false) return
  const threshold = rule.value.thresholdValue ?? maxAttempts
  const nowIso = new Date().toISOString()
  await createAlert({
    supabase,
    alertType: 'WEBHOOK_DELIVERY_FAILED',
    severity: rule.value.severity ?? 'P2',
    resellerId,
    customerId: subscription.enterprise_id ?? null,
    threshold,
    currentValue: attempt,
    windowStart: nowIso,
    ruleId: rule.value.itemId ?? null,
    ruleVersion: rule.value.version ?? null,
    deliveryChannels: rule.value.deliveryChannels ?? null,
    suppressMinutes: rule.value.suppressMinutes ?? 30,
    metadata: {
      message: 'Webhook delivery failed after maximum retries.',
      webhookId: subscription.webhook_id,
      deliveryId: delivery.delivery_id,
      eventId: delivery.event_id,
      url: subscription.url,
      responseCode,
      responseBody,
      maxAttempts,
      thresholdUnit: rule.value.thresholdUnit ?? 'ATTEMPTS',
    },
  })
}

async function persistDeliveryAttempt({
  supabase,
  deliveryId,
  patch,
}: {
  supabase: SupabaseClient
  deliveryId: number
  patch: Record<string, unknown>
}) {
  await supabase.update('webhook_deliveries', `delivery_id=eq.${encodeURIComponent(String(deliveryId))}`, patch, {
    returning: 'minimal',
  })
}

async function attemptDelivery({
  supabase,
  delivery,
  subscription,
  event,
  forceImmediate,
}: {
  supabase: SupabaseClient
  delivery: WebhookDeliveryRow
  subscription: WebhookSubscriptionRow
  event: EventRow
  forceImmediate?: boolean
}) {
  const payload = await buildDeliveryPayload(supabase, event)
  const body = toPayloadString(payload)
  const signature = buildSignature(subscription.secret, body)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Webhook-Signature': `sha256=${signature}`,
    'X-Webhook-Event': event.event_type,
    'X-Webhook-Delivery-Id': String(delivery.delivery_id),
    'X-Webhook-Timestamp': String(Math.floor(Date.now() / 1000)),
  }
  let responseCode: number | null = null
  let responseBody: string | null = null
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
  } catch (error: any) {
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

export async function createWebhookSubscription({
  supabase,
  payload,
  resellerId,
  enterpriseId,
}: {
  supabase: SupabaseClient
  payload: Record<string, any>
  resellerId?: string | null
  enterpriseId?: string | null
}): Promise<ServiceResult<WebhookSubscriptionApi>> {
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
  const status = statusFromEnabled(enabled)
  const description = normalizeDescription(payload?.description)

  const conflictId = await findLiveWebhookConflict({ supabase, resellerId, enterpriseId })
  if (conflictId) {
    const scopeLabel = enterpriseId
      ? `enterpriseId ${enterpriseId}`
      : `resellerId ${resellerId} (reseller-level)`
    return toError(
      409,
      'DUPLICATE',
      `A live webhook subscription already exists for ${scopeLabel}. Delete (deprecate) it before creating another.`
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
  const row = Array.isArray(rows) ? (rows[0] as WebhookSubscriptionRow) : null
  if (!row?.webhook_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create webhook subscription.')
  return {
    ok: true,
    value: mapSubscriptionRow(row),
  }
}

export async function listWebhookSubscriptions({
  supabase,
  resellerId,
  enterpriseId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  resellerId?: string | null
  enterpriseId?: string | null
  status?: unknown
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: WebhookSubscriptionApi[]; total: number; page: number; pageSize: number }>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const statusFilter = parseListWebhookStatusFilter(status)
  if (!statusFilter.ok) return statusFilter
  const filters: string[] = []
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  const statusQs =
    statusFilter.value.length === 1
      ? `status=eq.${encodeURIComponent(statusFilter.value[0])}`
      : `status=in.(${statusFilter.value.map((s) => encodeURIComponent(s)).join(',')})`
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const p = normalizePage(page, 1)
  const ps = normalizePageSize(pageSize, 50, 100)
  const offset = (p - 1) * ps
  const { data, total } = await supabase.selectWithCount(
    'webhook_subscriptions',
    `select=${subscriptionSelect}&${statusQs}&order=created_at.desc&limit=${ps}&offset=${offset}${filterQs}`
  )
  const rows = Array.isArray(data) ? (data as WebhookSubscriptionRow[]) : []
  const items = rows.map((row) => mapSubscriptionRow(row))
  return { ok: true, value: { items, total: total ?? items.length, page: p, pageSize: ps } }
}

export async function getWebhookSubscription({
  supabase,
  webhookId,
}: {
  supabase: SupabaseClient
  webhookId: string
}): Promise<ServiceResult<WebhookSubscriptionApi>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const rows = await supabase.select(
    'webhook_subscriptions',
    `select=${subscriptionSelect}&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as WebhookSubscriptionRow) : null
  if (!row?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  return {
    ok: true,
    value: mapSubscriptionRow(row),
  }
}

export async function updateWebhookSubscription({
  supabase,
  webhookId,
  payload,
}: {
  supabase: SupabaseClient
  webhookId: string
  payload: Record<string, any>
}): Promise<ServiceResult<WebhookSubscriptionApi>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const existingRows = await supabase.select(
    'webhook_subscriptions',
    `select=${subscriptionSelect}&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`
  )
  const existing = Array.isArray(existingRows) ? (existingRows[0] as WebhookSubscriptionRow) : null
  if (!existing?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  const existingStatus = normalizeWebhookStatus(existing.status)
  if (existingStatus === 'DEPRECATED') {
    return toError(
      409,
      'INVALID_STATUS',
      'Cannot update a deprecated webhook subscription. Create a new subscription for this scope after deprecate.'
    )
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
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
  if (payload?.description !== undefined) {
    update.description = normalizeDescription(payload.description)
  }

  // Live status only via enabled (Integration-style). DEPRECATED requires :deprecate.
  if (payload?.status !== undefined) {
    return toError(
      400,
      'BAD_REQUEST',
      'status is not supported on PATCH. Use enabled (true→ACTIVE, false→INACTIVE) or POST .../{webhookId}:deprecate.'
    )
  }
  if (payload?.enabled !== undefined) {
    update.enabled = Boolean(payload.enabled)
    update.status = statusFromEnabled(Boolean(payload.enabled))
  }

  if (Object.keys(update).length === 1) {
    return toError(400, 'BAD_REQUEST', 'No valid fields to update.')
  }
  const rows = await supabase.update(
    'webhook_subscriptions',
    `webhook_id=eq.${encodeURIComponent(webhookId)}`,
    update,
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? (rows[0] as WebhookSubscriptionRow) : null
  if (!row?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  return {
    ok: true,
    value: mapSubscriptionRow(row),
  }
}

export async function deprecateWebhookSubscription({
  supabase,
  webhookId,
}: {
  supabase: SupabaseClient
  webhookId: string
}): Promise<ServiceResult<{ webhookId: string; deprecated: true; status: 'DEPRECATED'; deprecatedAt: string }>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const existingRows = await supabase.select(
    'webhook_subscriptions',
    `select=${subscriptionSelect}&webhook_id=eq.${encodeURIComponent(webhookId)}&limit=1`
  )
  const existing = Array.isArray(existingRows) ? (existingRows[0] as WebhookSubscriptionRow) : null
  if (!existing?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  if (normalizeWebhookStatus(existing.status) === 'DEPRECATED') {
    return toError(409, 'INVALID_STATUS', 'Webhook subscription is already deprecated.')
  }
  const nowIso = new Date().toISOString()
  const rows = await supabase.update(
    'webhook_subscriptions',
    `webhook_id=eq.${encodeURIComponent(webhookId)}`,
    { enabled: false, status: 'DEPRECATED', deprecated_at: nowIso, updated_at: nowIso },
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? (rows[0] as WebhookSubscriptionRow) : null
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

export async function listWebhookDeliveries({
  supabase,
  webhookId,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  webhookId: string
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: Array<Record<string, unknown>>; total: number; page: number; pageSize: number }>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!webhookId) return toError(400, 'BAD_REQUEST', 'webhookId is required.')
  const p = normalizePage(page, 1)
  const ps = normalizePageSize(pageSize, 50, 100)
  const offset = (p - 1) * ps
  const { data, total } = await supabase.selectWithCount(
    'webhook_deliveries',
    `select=delivery_id,webhook_id,event_id,attempt,status,response_code,response_body,next_retry_at,created_at,events(event_type)&webhook_id=eq.${encodeURIComponent(webhookId)}&order=created_at.desc&limit=${ps}&offset=${offset}`
  )
  const rows = Array.isArray(data) ? (data as WebhookDeliveryRow[]) : []
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

export async function retryWebhookDelivery({
  supabase,
  deliveryId,
}: {
  supabase: SupabaseClient
  deliveryId: number
}): Promise<ServiceResult<{ deliveryId: number; status: string }>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const rows = await supabase.select(
    'webhook_deliveries',
    `select=delivery_id,webhook_id,event_id,attempt,status,response_code,response_body,next_retry_at,created_at&delivery_id=eq.${encodeURIComponent(String(deliveryId))}&limit=1`
  )
  const delivery = Array.isArray(rows) ? (rows[0] as WebhookDeliveryRow) : null
  if (!delivery?.delivery_id) return toError(404, 'NOT_FOUND', 'webhook delivery not found.')
  const eventRows = await supabase.select(
    'events',
    `select=event_id,event_type,occurred_at,enterprise_id,reseller_id,actor_user_id,request_id,job_id,payload&event_id=eq.${encodeURIComponent(delivery.event_id)}&limit=1`
  )
  const event = Array.isArray(eventRows) ? (eventRows[0] as EventRow) : null
  if (!event?.event_id) return toError(404, 'NOT_FOUND', 'event not found for delivery.')
  const subRows = await supabase.select(
    'webhook_subscriptions',
    `select=${subscriptionSelect}&webhook_id=eq.${encodeURIComponent(delivery.webhook_id)}&limit=1`
  )
  const subscription = Array.isArray(subRows) ? (subRows[0] as WebhookSubscriptionRow) : null
  if (!subscription?.webhook_id) return toError(404, 'NOT_FOUND', 'webhook subscription not found.')
  const result = await attemptDelivery({
    supabase,
    delivery,
    subscription,
    event,
  })
  return { ok: true, value: { deliveryId: delivery.delivery_id, status: result.status } }
}

export async function dispatchWebhookEvent({
  supabase,
  event,
}: {
  supabase: SupabaseClient
  event: EventRow
}) {
  if (!supabase || !event?.event_id) return { ok: false, reason: 'missing_event' }
  if (!event.enterprise_id && !event.reseller_id) return { ok: true, delivered: 0, skipped: 0 }
  const enterpriseId = event.enterprise_id ?? null
  const resellerId = event.reseller_id ?? null
  const loaded = [
    ...(enterpriseId ? await loadSubscriptions({ supabase, enterpriseId }) : []),
    ...(resellerId ? await loadSubscriptions({ supabase, resellerId }) : []),
  ]
  const seen = new Set<string>()
  const subscriptions: WebhookSubscriptionRow[] = []
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
  const deliveryIds: number[] = []
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
    const delivery = Array.isArray(rows) ? (rows[0] as WebhookDeliveryRow) : null
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
