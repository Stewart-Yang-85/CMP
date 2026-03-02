import { createSupabaseRestClient } from '../supabaseRest.js'
import { dispatchWebhookEvent } from './webhook.js'

export type EmitEventInput = {
  eventType: string
  tenantId?: string | null
  actorUserId?: string | null
  requestId?: string | null
  jobId?: string | null
  payload?: Record<string, unknown> | null
  occurredAt?: string
}

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string> }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  rpc: (fnName: string, payload?: Record<string, unknown>) => Promise<unknown>
}

type WebhookEventRow = {
  event_id: string
  event_type: string
  occurred_at: string
  tenant_id?: string | null
  actor_user_id?: string | null
  request_id?: string | null
  job_id?: string | null
  payload?: Record<string, unknown> | null
}

const payloadLimitBytes = 8 * 1024

function payloadSizeBytes(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return 0
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

function normalizePayload(payload: Record<string, unknown> | null | undefined) {
  return payload && typeof payload === 'object' ? payload : {}
}

function normalizeValue(value: unknown) {
  if (value === undefined || value === null) return null
  return String(value)
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function normalizeActorUserId(value: unknown) {
  return isValidUuid(value) ? String(value) : null
}

function minuteBucket(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    return { startIso: iso, endIso: iso }
  }
  d.setSeconds(0, 0)
  const start = d.toISOString()
  const end = new Date(d.getTime() + 60 * 1000).toISOString()
  return { startIso: start, endIso: end }
}

async function findEvents(
  supabase: SupabaseClient,
  query: string
): Promise<Array<{ event_id: string; payload?: Record<string, unknown> | null }>> {
  const rows = await supabase.select('events', query)
  return Array.isArray(rows) ? (rows as Array<{ event_id: string; payload?: Record<string, unknown> | null }>) : []
}

async function isDuplicateEvent({
  supabase,
  eventType,
  tenantId,
  payload,
  occurredAt,
}: {
  supabase: SupabaseClient
  eventType: string
  tenantId?: string | null
  payload: Record<string, unknown>
  occurredAt: string
}) {
  if (!eventType) return false
  const normalizedTenantId = tenantId ? String(tenantId) : null
  const { startIso, endIso } = minuteBucket(occurredAt)
  const baseFilters = [
    `event_type=eq.${encodeURIComponent(eventType)}`,
    `occurred_at=gte.${encodeURIComponent(startIso)}`,
    `occurred_at=lt.${encodeURIComponent(endIso)}`,
  ]
  if (normalizedTenantId) baseFilters.push(`tenant_id=eq.${encodeURIComponent(normalizedTenantId)}`)
  const query = `select=event_id,payload&${baseFilters.join('&')}`
  const rows = await findEvents(supabase, query)
  if (!rows.length) return false
  if (eventType === 'SIM_STATUS_CHANGED') {
    const afterStatus = normalizeValue(payload.afterStatus ?? payload.after_status)
    const simId = normalizeValue(payload.simId ?? payload.iccid)
    if (!afterStatus || !simId || !normalizedTenantId) return false
    return rows.some((row) => {
      const rowPayload = normalizePayload(row.payload)
      return (
        normalizeValue(rowPayload.afterStatus ?? rowPayload.after_status) === afterStatus &&
        normalizeValue(rowPayload.simId ?? rowPayload.iccid) === simId
      )
    })
  }
  if (eventType === 'SUBSCRIPTION_CHANGED') {
    const subscriptionId = normalizeValue(payload.subscriptionId)
    const afterState = normalizeValue(payload.afterState)
    const effectiveAt = normalizeValue(payload.effectiveAt)
    if (!subscriptionId || !afterState || !effectiveAt || !normalizedTenantId) return false
    return rows.some((row) => {
      const rowPayload = normalizePayload(row.payload)
      return (
        normalizeValue(rowPayload.subscriptionId) === subscriptionId &&
        normalizeValue(rowPayload.afterState) === afterState &&
        normalizeValue(rowPayload.effectiveAt) === effectiveAt
      )
    })
  }
  if (eventType === 'BILL_PUBLISHED') {
    const billId = normalizeValue(payload.billId)
    const customerId = normalizeValue(payload.customerId ?? normalizedTenantId)
    if (!billId || !customerId) return false
    return rows.some((row) => {
      const rowPayload = normalizePayload(row.payload)
      return normalizeValue(rowPayload.billId) === billId && normalizeValue(rowPayload.customerId) === customerId
    })
  }
  if (eventType === 'PAYMENT_CONFIRMED') {
    const billId = normalizeValue(payload.billId)
    const customerId = normalizeValue(payload.customerId ?? normalizedTenantId)
    const paymentRef = normalizeValue(payload.paymentRef)
    if (!billId || !customerId || !paymentRef) return false
    return rows.some((row) => {
      const rowPayload = normalizePayload(row.payload)
      return (
        normalizeValue(rowPayload.billId) === billId &&
        normalizeValue(rowPayload.customerId) === customerId &&
        normalizeValue(rowPayload.paymentRef) === paymentRef
      )
    })
  }
  if (eventType === 'ENTERPRISE_STATUS_CHANGED') {
    const status = normalizeValue(payload.status)
    if (!status || !normalizedTenantId) return false
    return rows.some((row) => {
      const rowPayload = normalizePayload(row.payload)
      return normalizeValue(rowPayload.status) === status
    })
  }
  if (eventType === 'ALERT_TRIGGERED') {
    const alertId = normalizeValue(payload.alertId ?? payload.alert_id)
    if (!alertId || !normalizedTenantId) return false
    return rows.some((row) => {
      const rowPayload = normalizePayload(row.payload)
      return normalizeValue(rowPayload.alertId ?? rowPayload.alert_id) === alertId
    })
  }
  return false
}

export async function emitEvent(input: EmitEventInput) {
  const size = payloadSizeBytes(input.payload ?? null)
  if (size > payloadLimitBytes) {
    throw new Error('payload_too_large')
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString()
  const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: input.requestId ?? null }) as SupabaseClient
  const payload = normalizePayload(input.payload ?? null)
  const duplicate = await isDuplicateEvent({
    supabase,
    eventType: input.eventType,
    tenantId: input.tenantId ?? null,
    payload,
    occurredAt,
  })
  if (duplicate) {
    return
  }
  const rows = await supabase.insert(
    'events',
    {
      event_type: input.eventType,
      occurred_at: occurredAt,
      tenant_id: input.tenantId ?? null,
      actor_user_id: normalizeActorUserId(input.actorUserId),
      request_id: input.requestId ?? null,
      job_id: input.jobId ?? null,
      payload,
    },
    { returning: 'representation' }
  )
  const event = Array.isArray(rows) ? (rows[0] as WebhookEventRow) : null
  const notifyFn = process.env.EVENT_NOTIFY_FUNCTION
  if (notifyFn) {
    await supabase.rpc(notifyFn, {
      event_type: input.eventType,
      tenant_id: input.tenantId ?? null,
      request_id: input.requestId ?? null,
      job_id: input.jobId ?? null,
    })
  }
  if (event?.event_id) {
    try {
      await dispatchWebhookEvent({ supabase, event })
    } catch {
      return
    }
  }
}
