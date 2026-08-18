/**
 * Emit one synthetic outbound event per FR-039 catalog type and dispatch webhooks.
 *
 * Usage:
 *   npm run build
 *   node tools/emit_test_webhook_events.mjs
 *   node tools/emit_test_webhook_events.mjs --enterpriseId 43326e05-5704-4e0d-8175-547d6b555132
 *   node tools/emit_test_webhook_events.mjs --types SIM_STATUS_CHANGED,JOB_FINISHED
 *
 * Prerequisites:
 * - ACTIVE webhook_subscriptions for the enterprise (or matching reseller-level)
 * - eventTypes on the subscription must include the types you emit
 * - url should be https (e.g. webhook.site)
 */
import 'dotenv/config'
import crypto from 'node:crypto'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { emitEvent } from '../dist/services/eventEmitter.js'

const DEFAULT_ENTERPRISE_ID = '43326e05-5704-4e0d-8175-547d6b555132'

const ALL_EVENT_TYPES = [
  'SIM_STATUS_CHANGED',
  'JOB_FINISHED',
  'SUBSCRIPTION_CHANGED',
  'BILL_PUBLISHED',
  'PAYMENT_CONFIRMED',
  'ALERT_TRIGGERED',
  'ENTERPRISE_STATUS_CHANGED',
]

function arg(name) {
  const flag = `--${name}`
  const idx = process.argv.indexOf(flag)
  if (idx < 0) return null
  const value = process.argv[idx + 1]
  return value && !value.startsWith('--') ? value : ''
}

function uuid() {
  return crypto.randomUUID()
}

function buildPayload(eventType, enterpriseId, runId) {
  const simId = uuid()
  const jobId = uuid()
  const billId = uuid()
  const subscriptionId = uuid()
  const now = new Date().toISOString()
  switch (eventType) {
    case 'SIM_STATUS_CHANGED':
      return {
        simId,
        iccid: `8986TEST${runId.slice(0, 12)}`,
        beforeStatus: 'ACTIVATED',
        afterStatus: 'DEACTIVATED',
        supplierId: uuid(),
        lifecycleSubStatus: 'normal',
        reason: `emit_test_webhook_events:${runId}`,
      }
    case 'JOB_FINISHED':
      return {
        jobId,
        jobType: 'SIM_STATUS_CHANGE',
        jobStatus: 'SUCCEEDED',
        action: 'DEACTIVATE',
        simId,
        iccid: `8986TEST${runId.slice(0, 12)}`,
        beforeStatus: 'ACTIVATED',
        targetStatus: 'DEACTIVATED',
        resultStatus: 'DEACTIVATED',
        lifecycleSubStatus: 'normal',
        errorCode: null,
        errorSummary: null,
      }
    case 'SUBSCRIPTION_CHANGED':
      return {
        subscriptionId,
        simId,
        packageId: uuid(),
        beforeState: 'ACTIVE',
        afterState: 'CANCELLED',
        effectiveAt: now,
      }
    case 'BILL_PUBLISHED':
      return {
        billId,
        customerId: enterpriseId,
        period: '2026-08',
        totalAmount: 12.34,
        dueDate: '2026-09-15',
      }
    case 'PAYMENT_CONFIRMED':
      return {
        billId,
        customerId: enterpriseId,
        paidAmount: 12.34,
        paidAt: now,
        paymentRef: `pay-test-${runId}`,
      }
    case 'ALERT_TRIGGERED':
      return {
        alertType: 'SILENT_SIM',
        customerId: enterpriseId,
        simId,
        threshold: 1,
        currentValue: 1,
        windowStart: now,
      }
    case 'ENTERPRISE_STATUS_CHANGED':
      return {
        enterpriseId,
        beforeStatus: 'ACTIVE',
        afterStatus: 'SUSPENDED',
        reason: `emit_test_webhook_events:${runId}`,
      }
    default:
      return { runId, note: 'unknown event type for local test' }
  }
}

async function listMatchingSubscriptions(supabase, enterpriseId) {
  const rows = await supabase.select(
    'webhook_subscriptions',
    `select=webhook_id,url,enabled,status,event_types,enterprise_id,reseller_id&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&status=in.(ACTIVE,INACTIVE)&order=created_at.desc`
  )
  return Array.isArray(rows) ? rows : []
}

async function main() {
  const enterpriseId = (arg('enterpriseId') || DEFAULT_ENTERPRISE_ID).trim()
  const typesArg = arg('types')
  const eventTypes = typesArg
    ? typesArg.split(',').map((s) => s.trim()).filter(Boolean)
    : [...ALL_EVENT_TYPES]

  for (const t of eventTypes) {
    if (!ALL_EVENT_TYPES.includes(t)) {
      console.error(`Unknown event type: ${t}`)
      console.error(`Allowed: ${ALL_EVENT_TYPES.join(', ')}`)
      process.exit(1)
    }
  }

  const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: `emit-test-${uuid()}` })
  const runId = uuid().replace(/-/g, '').slice(0, 16)
  const requestId = `req_emit_test_${runId}`

  console.log(`Enterprise: ${enterpriseId}`)
  console.log(`Run id:     ${runId}`)
  console.log(`Types:      ${eventTypes.join(', ')}`)
  console.log('')

  const subs = await listMatchingSubscriptions(supabase, enterpriseId)
  const activeSubs = subs.filter((s) => s.enabled === true && String(s.status || '').toUpperCase() === 'ACTIVE')
  if (!activeSubs.length) {
    console.warn('WARNING: no ACTIVE+enabled webhook_subscriptions for this enterpriseId.')
    console.warn('Events will still be written, but webhook_deliveries may stay empty.')
  } else {
    console.log(`Found ${activeSubs.length} ACTIVE subscription(s):`)
    for (const s of activeSubs) {
      const types = Array.isArray(s.event_types) ? s.event_types.join(',') : String(s.event_types || '')
      console.log(`  - ${s.webhook_id}  ${s.url}`)
      console.log(`    eventTypes: ${types}`)
    }
  }
  console.log('')

  const results = []
  for (const eventType of eventTypes) {
    const payload = buildPayload(eventType, enterpriseId, runId)
    const jobId = eventType === 'JOB_FINISHED' || eventType === 'SIM_STATUS_CHANGED' ? payload.jobId ?? uuid() : null
    try {
      const result = await emitEvent({
        eventType,
        enterpriseId,
        requestId,
        jobId,
        payload,
        // Unique occurredAt per type avoids 1-minute dedupe collisions within a run.
        occurredAt: new Date(Date.now() + results.length * 1000).toISOString(),
        dispatchWebhooks: true,
      })
      results.push({ eventType, ...result })
      const delivery = Array.isArray(result.webhookDeliveryIds) && result.webhookDeliveryIds.length
        ? result.webhookDeliveryIds.join(',')
        : '(none)'
      if (result.duplicate) {
        console.log(`[DUPLICATE] ${eventType}  (skipped — try again in ~1 min or change payload keys)`)
      } else {
        console.log(`[OK] ${eventType}`)
        console.log(`     eventId=${result.eventId ?? 'null'}  deliveryIds=${delivery}`)
      }
    } catch (err) {
      console.error(`[FAIL] ${eventType}:`, err?.message || err)
      results.push({ eventType, ok: false, error: String(err?.message || err) })
    }
  }

  const delivered = results.filter((r) => Array.isArray(r.webhookDeliveryIds) && r.webhookDeliveryIds.length > 0)
  console.log('')
  console.log(`Done. ${delivered.length}/${eventTypes.length} event type(s) produced delivery row(s).`)
  console.log('Check webhook.site and GET /v1/webhook-subscriptions/{webhookId}/deliveries')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
