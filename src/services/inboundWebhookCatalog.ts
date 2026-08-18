import { businessOperatorDisplayIdByOperatorRowId } from './operatorResolve.js'
import {
  adapterSupportsInboundEvent,
  getInboundWebhookEventsForAdapter,
} from '../vendors/inboundWebhookCapabilities.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  delete: (table: string, matchQueryString: string) => Promise<unknown>
}

export type WebhookSubscriptionInput = {
  eventKey: string
  enabled: boolean
}

export type InboundWebhookEventRow = {
  eventKey: string
  displayName: string
  description: string | null
  status: string
  sortOrder: number | null
}

export type IntegrationSubscriptionRow = {
  eventKey: string
  enabled: boolean
}

function normalizeEventKey(value: unknown) {
  return String(value ?? '').trim()
}

export async function listInboundWebhookEventsFromDb(
  supabase: SupabaseClient
): Promise<InboundWebhookEventRow[]> {
  const rows = await supabase.select(
    'upstream_inbound_webhook_events',
    'select=event_key,display_name,description,status,sort_order&order=sort_order.asc.nullslast,event_key.asc'
  )
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const r = row as Record<string, unknown>
    return {
      eventKey: String(r.event_key ?? ''),
      displayName: String(r.display_name ?? ''),
      description: r.description != null ? String(r.description) : null,
      status: String(r.status ?? 'ACTIVE'),
      sortOrder: r.sort_order != null ? Number(r.sort_order) : null,
    }
  })
}

export async function listInboundWebhookEventsForApi(
  supabase: SupabaseClient,
  adapterType?: string | null
): Promise<{ items: InboundWebhookEventRow[]; adapterCapabilities?: string[] }> {
  const all = await listInboundWebhookEventsFromDb(supabase)
  const active = all.filter((e) => e.status === 'ACTIVE')
  if (adapterType) {
    const caps = [...getInboundWebhookEventsForAdapter(adapterType)]
    return {
      items: active.filter((e) => caps.includes(e.eventKey)),
      adapterCapabilities: caps,
    }
  }
  return { items: active }
}

export async function listIntegrationSubscriptions(
  supabase: SupabaseClient,
  integrationId: string
): Promise<IntegrationSubscriptionRow[]> {
  const rows = await supabase.select(
    'upstream_integration_webhook_subscriptions',
    `select=event_key,enabled&integration_id=eq.${encodeURIComponent(integrationId)}&order=event_key.asc`
  )
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const r = row as Record<string, unknown>
    return {
      eventKey: String(r.event_key ?? ''),
      enabled: r.enabled === true,
    }
  })
}

export async function isInboundWebhookSubscribed(
  supabase: SupabaseClient,
  integrationId: string,
  eventKey: string
): Promise<boolean> {
  const key = normalizeEventKey(eventKey)
  const rows = await supabase.select(
    'upstream_integration_webhook_subscriptions',
    `select=enabled&integration_id=eq.${encodeURIComponent(integrationId)}&event_key=eq.${encodeURIComponent(key)}&enabled=eq.true&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return Boolean((row as Record<string, unknown>)?.enabled === true)
}

export async function isInboundEventKeyActive(
  supabase: SupabaseClient,
  eventKey: string
): Promise<boolean> {
  const key = normalizeEventKey(eventKey)
  const rows = await supabase.select(
    'upstream_inbound_webhook_events',
    `select=status&event_key=eq.${encodeURIComponent(key)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return String((row as Record<string, unknown>)?.status ?? '') === 'ACTIVE'
}

export async function applyIntegrationWebhookSubscriptions({
  supabase,
  integrationId,
  adapterType,
  subscriptions,
}: {
  supabase: SupabaseClient
  integrationId: string
  adapterType: string
  subscriptions: WebhookSubscriptionInput[]
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const catalog = await listInboundWebhookEventsFromDb(supabase)
  const activeKeys = new Set(catalog.filter((e) => e.status === 'ACTIVE').map((e) => e.eventKey))

  for (const sub of subscriptions) {
    const eventKey = normalizeEventKey(sub.eventKey)
    if (!eventKey) return { ok: false, message: 'subscriptions[].eventKey is required.' }
    if (!activeKeys.has(eventKey)) {
      return { ok: false, message: `Unknown or inactive event_key: ${eventKey}.` }
    }
    if (!adapterSupportsInboundEvent(adapterType, eventKey)) {
      return { ok: false, message: `adapterType does not support event_key: ${eventKey}.` }
    }
  }

  for (const sub of subscriptions) {
    const eventKey = normalizeEventKey(sub.eventKey)
    const enabled = sub.enabled === true
    const existing = await supabase.select(
      'upstream_integration_webhook_subscriptions',
      `select=integration_id&integration_id=eq.${encodeURIComponent(integrationId)}&event_key=eq.${encodeURIComponent(eventKey)}&limit=1`
    )
    const hasRow = Array.isArray(existing) && existing.length > 0
    if (hasRow) {
      await supabase.update(
        'upstream_integration_webhook_subscriptions',
        `integration_id=eq.${encodeURIComponent(integrationId)}&event_key=eq.${encodeURIComponent(eventKey)}`,
        { enabled, updated_at: new Date().toISOString() }
      )
    } else if (enabled) {
      await supabase.insert('upstream_integration_webhook_subscriptions', {
        integration_id: integrationId,
        event_key: eventKey,
        enabled: true,
      })
    }
  }

  return { ok: true }
}

export function buildInboundWebhookUrl(
  baseUrl: string,
  supplierId: string,
  operatorIdForUrl: string,
  adapterType: string,
  eventKey: string
) {
  const base = String(baseUrl ?? '').replace(/\/$/, '')
  return `${base}/v1/suppliers/${supplierId}/operators/${operatorIdForUrl}/webhooks/${adapterType}/${eventKey}`
}

export async function buildWebhookEndpointsForIntegration({
  supabase,
  baseUrl,
  integrationRow,
}: {
  supabase: SupabaseClient
  baseUrl: string
  integrationRow: Record<string, unknown>
}): Promise<
  Array<{
    eventKey: string
    method: string
    url: string
    headers: Array<{ name: string; description: string }>
  }>
> {
  const integrationId = String(integrationRow.integration_id ?? '')
  const supplierId = String(integrationRow.supplier_id ?? '')
  const operatorRowId = String(integrationRow.operator_id ?? '')
  const adapterType = String(integrationRow.adapter_type ?? '').trim().toLowerCase()
  if (!integrationId || !supplierId || !operatorRowId || !adapterType) return []

  const displayOperatorId =
    (await businessOperatorDisplayIdByOperatorRowId(supabase, operatorRowId)) ?? operatorRowId
  const subs = await listIntegrationSubscriptions(supabase, integrationId)
  const enabledKeys = subs.filter((s) => s.enabled).map((s) => s.eventKey)
  const adapterEvents = new Set(getInboundWebhookEventsForAdapter(adapterType))

  return enabledKeys
    .filter((eventKey) => adapterEvents.has(eventKey))
    .sort()
    .map((eventKey) => ({
      eventKey,
      method: 'POST',
      url: buildInboundWebhookUrl(baseUrl, supplierId, displayOperatorId, adapterType, eventKey),
      headers: [{ name: 'webhookKey', description: 'HTTP header webhookKey = integration webhookKey (decrypted)' }],
    }))
}

export async function enrichUpstreamIntegrationApiRow(
  supabase: SupabaseClient,
  baseUrl: string,
  apiRow: Record<string, unknown>,
  integrationRow: Record<string, unknown>
) {
  const integrationId = String(integrationRow.integration_id ?? apiRow.integrationId ?? '')
  const subscriptions = integrationId ? await listIntegrationSubscriptions(supabase, integrationId) : []
  const webhookEndpoints = await buildWebhookEndpointsForIntegration({
    supabase,
    baseUrl,
    integrationRow,
  })
  return {
    ...apiRow,
    subscriptions,
    webhookEndpoints,
  }
}
