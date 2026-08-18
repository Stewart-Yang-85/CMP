const supportedChannels = new Set(['PORTAL', 'EMAIL', 'WEBHOOK'])

function normalizeChannels(channels) {
  const raw = Array.isArray(channels) && channels.length ? channels : ['PORTAL']
  const normalized = raw
    .map((channel) => String(channel || '').trim().toUpperCase())
    .filter((channel) => supportedChannels.has(channel))
  return Array.from(new Set(normalized.length ? normalized : ['PORTAL']))
}

function normalizeWebhookDeliveryIds(ids) {
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
}) {
  if (!supabase || !alertId) return { ok: false, inserted: 0 }
  const nowIso = new Date().toISOString()
  const rows = []
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
