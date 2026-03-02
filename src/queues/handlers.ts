import { createRequire } from 'node:module'
import { createSupabaseRestClient } from '../supabaseRest.js'

type QueueMessage = {
  type?: string
  payload?: Record<string, unknown> | null
  traceId?: string | null
}

async function pushSimStatusToUpstream({
  iccid,
  status,
  traceId,
  supplierId,
}: {
  iccid: string
  status: string
  traceId?: string | null
  supplierId?: string | null
}) {
  const url = process.env.CMP_SYNC_URL
  const key = process.env.CMP_SYNC_KEY
  if (!url || !key) return { ok: false }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
      ...(traceId ? { 'X-Request-Id': traceId } : {}),
    },
    body: JSON.stringify({ iccid, status }),
  })
  return { ok: res.ok, status: res.status }
}

export async function handleQueueMessage(message: unknown) {
  const require = createRequire(import.meta.url)
  const { runSimImport } = require('../services/simImport.js') as { runSimImport: (input: Record<string, unknown>) => Promise<Record<string, unknown>> }
  const { runBillingGenerate } = require('../services/billingGenerate.js') as {
    runBillingGenerate: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
  const { runDunningCheck } = require('../services/dunning.js') as {
    runDunningCheck: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
  const { changeSimStatus, parseSimIdentifier } = require('../services/simLifecycle.js') as {
    changeSimStatus: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
    parseSimIdentifier: (value: unknown) => { ok: boolean; status?: number; code?: string; message?: string; field?: string; value?: string }
  }
  const { retryWebhookDelivery } = require('../services/webhook.js') as {
    retryWebhookDelivery: (input: { supabase: any; deliveryId: number }) => Promise<Record<string, unknown>>
  }
  const msg = (message ?? {}) as QueueMessage
  const type = String(msg.type || '')
  const payload = msg.payload ?? {}
  const traceId = msg.traceId ?? null
  if (!type) {
    return { ok: false, error: 'Missing message type.' }
  }
  const supabase = createSupabaseRestClient({ useServiceRole: true, traceId })
  if (type === 'SIM_IMPORT') {
    const result = await runSimImport({
      supabase,
      csvText: payload.csvText,
      supplierId: payload.supplierId,
      enterpriseId: payload.enterpriseId,
      batchId: payload.batchId,
      traceId,
      actorUserId: payload.actorUserId,
      actorRole: payload.actorRole,
      resellerId: payload.resellerId,
      sourceIp: payload.sourceIp,
    })
    return { ok: result.ok, result }
  }
  if (type === 'SIM_STATE_CHANGE') {
    const simIdInput = payload.simId ?? payload.iccid
    const simIdentifier = parseSimIdentifier(simIdInput)
    if (!simIdentifier.ok) {
      return { ok: false, error: simIdentifier.message }
    }
    const allowed = Array.isArray(payload.allowedFrom) ? new Set(payload.allowedFrom.map((v) => String(v))) : new Set()
    const result = await changeSimStatus({
      supabase,
      simIdentifier,
      tenantQs: payload.tenantQs ? String(payload.tenantQs) : '',
      action: payload.action ? String(payload.action) : 'SIM_STATE_CHANGE',
      newStatus: payload.newStatus ? String(payload.newStatus) : '',
      allowedFrom: allowed.size ? allowed : new Set(['INVENTORY', 'TEST_READY', 'ACTIVATED', 'DEACTIVATED']),
      reason: payload.reason ? String(payload.reason) : null,
      idempotencyKey: payload.idempotencyKey ? String(payload.idempotencyKey) : null,
      actor: payload.actor ?? null,
      traceId,
      sourceIp: payload.sourceIp ? String(payload.sourceIp) : null,
      pushSimStatusToUpstream,
      commitmentExempt: Boolean(payload.commitmentExempt),
    })
    return { ok: result.ok, result }
  }
  if (type === 'BILLING_GENERATE') {
    const result = await runBillingGenerate({
      supabase,
      period: payload.period,
      enterpriseId: payload.enterpriseId ?? null,
      resellerId: payload.resellerId ?? null,
      autoPublish: payload.autoPublish ?? null,
      actorUserId: payload.actorUserId ?? null,
      requestId: payload.requestId ?? traceId ?? null,
      jobId: payload.jobId ?? null,
    })
    return { ok: result.ok, result }
  }
  if (type === 'DUNNING_CHECK') {
    const result = await runDunningCheck({
      supabase,
      enterpriseId: payload.enterpriseId ?? null,
      asOfDate: payload.asOfDate ?? null,
    })
    return { ok: result.ok, result }
  }
  if (type === 'WEBHOOK_DELIVERY') {
    const deliveryId = Number(payload.deliveryId ?? 0)
    if (Number.isFinite(deliveryId) && deliveryId > 0) {
      const result = await retryWebhookDelivery({ supabase, deliveryId })
      return { ok: result.ok, result }
    }
    const limitInput = Number(payload.limit ?? 50)
    const limit = Number.isFinite(limitInput) && limitInput > 0 ? Math.min(200, Math.floor(limitInput)) : 50
    const nowIso = new Date().toISOString()
    const rows = await supabase.select(
      'webhook_deliveries',
      `select=delivery_id&status=eq.PENDING&next_retry_at=lte.${encodeURIComponent(nowIso)}&order=next_retry_at.asc&limit=${limit}`
    )
    const deliveries = Array.isArray(rows) ? rows : []
    let processed = 0
    for (const row of deliveries) {
      const id = Number((row as any).delivery_id ?? 0)
      if (!Number.isFinite(id) || id <= 0) continue
      const result = await retryWebhookDelivery({ supabase, deliveryId: id })
      if (result.ok) processed += 1
    }
    return { ok: true, processed, total: deliveries.length }
  }
  return { ok: false, error: `Unsupported message type: ${type}` }
}
