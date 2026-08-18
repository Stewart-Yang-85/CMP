type SupabaseClient = {
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

export type AlertDeliveryChannel = 'PORTAL' | 'EMAIL' | 'WEBHOOK'

export type RecordAlertDeliveriesInput = {
  supabase: SupabaseClient
  alertId: string
  channels?: string[] | null
  eventId?: string | null
  webhookDeliveryIds?: Array<string | number> | null
}

const supportedChannels = new Set(['PORTAL', 'EMAIL', 'WEBHOOK'])

function normalizeChannels(channels: string[] | null | undefined): AlertDeliveryChannel[] {
  const raw = Array.isArray(channels) && channels.length ? channels : ['PORTAL']
  const normalized = raw
    .map((channel) => String(channel || '').trim().toUpperCase())
    .filter((channel) => supportedChannels.has(channel)) as AlertDeliveryChannel[]
  return Array.from(new Set(normalized.length ? normalized : ['PORTAL']))
}

function normalizeWebhookDeliveryIds(ids: Array<string | number> | null | undefined) {
  return (Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)
}

export async function recordAlertDeliveries({
  supabase,
  alertId,
  channels,
  eventId,
  webhookDeliveryIds,
}: RecordAlertDeliveriesInput) {
  if (!supabase || !alertId) return { ok: false, inserted: 0 }
  const nowIso = new Date().toISOString()
  const rows: Record<string, unknown>[] = []
  for (const channel of normalizeChannels(channels)) {
    if (channel === 'PORTAL') {
      rows.push({
        alert_id: alertId,
        channel,
        status: 'DELIVERED',
        target: 'portal',
        event_id: eventId ?? null,
        delivered_at: nowIso,
        created_at: nowIso,
        updated_at: nowIso,
      })
      continue
    }
    if (channel === 'EMAIL') {
      rows.push({
        alert_id: alertId,
        channel,
        status: 'NOT_IMPLEMENTED',
        target: null,
        event_id: eventId ?? null,
        error_code: 'EMAIL_NOT_IMPLEMENTED',
        error_message: 'Email alert delivery is reserved but not implemented in V1.1.',
        created_at: nowIso,
        updated_at: nowIso,
      })
      continue
    }
    const ids = normalizeWebhookDeliveryIds(webhookDeliveryIds)
    if (!ids.length) {
      rows.push({
        alert_id: alertId,
        channel,
        status: 'SKIPPED',
        target: 'webhook',
        event_id: eventId ?? null,
        error_code: 'NO_WEBHOOK_DELIVERY',
        error_message: 'No matching webhook subscription produced a delivery record.',
        created_at: nowIso,
        updated_at: nowIso,
      })
      continue
    }
    for (const id of ids) {
      rows.push({
        alert_id: alertId,
        channel,
        status: 'PENDING',
        target: 'webhook',
        event_id: eventId ?? null,
        webhook_delivery_id: id,
        created_at: nowIso,
        updated_at: nowIso,
      })
    }
  }
  if (!rows.length) return { ok: true, inserted: 0 }
  await supabase.insert('alert_deliveries', rows, { returning: 'minimal' })
  return { ok: true, inserted: rows.length }
}
