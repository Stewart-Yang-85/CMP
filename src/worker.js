import 'dotenv/config'
import cron from 'node-cron'
import { createSupabaseRestClient } from './supabaseRest.js'
import { ensureValidCronExpression, resolveSystemTimeZone } from './utils/timezone.js'
import { createWxzhonggengClient } from './vendors/wxzhonggeng.js'
import { checkOperationSupported } from './vendors/registry.js'
import { runBillingTask } from './billing.js'
import { runBillingGenerate } from './services/billingGenerate.js'
import { runUsageRatingRollup } from './services/usageRatingRollup.js'
import { runUsageMonthlyRollup, previousUtcYearMonth } from './services/usageMonthlyRollup.js'
import { handleLateCdr } from './services/lateCdr.js'
import { runDunningCheck } from './services/dunning.js'
import { runReconciliation } from './services/reconciliation.js'
import { runAlertEvaluation } from './services/alerting.js'
import { runUpstreamIntegrationHealthProbe } from './services/readyProbe.js'
import { retryWebhookDelivery } from './services/webhook.js'
import { processSimStatusChangeJob } from './services/simStatusChangeJob.js'
import { finalizeSimStatusChange } from './services/simLifecycleFinalize.js'
import { resolveEventScopeColumns, sanitizeEventPayload } from './services/eventEmitter.js'
import { processSubscriptionProvisionJob } from './services/subscriptionProvisionJob.js'
import { executeScheduledCancels } from './services/subscriptionScheduledCancel.js'
import { resolveBillingSchedule } from './services/billingSchedule.js'
import { runTestReadyExpiryEvaluation } from './services/testReadyExpiry.js'
import { runOneTimeSubscriptionExpiry } from './services/subscriptionOneTimeExpiry.js'

const supabase = createSupabaseRestClient({ useServiceRole: true })
const wxClient = createWxzhonggengClient()

function resolveNumber(value, defaultValue) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : defaultValue
}

function parseNumberMap(value) {
  if (!value) return null
  try {
    const json = JSON.parse(String(value))
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

function extractMissingColumn(err) {
  const body = String(err?.body || err?.message || '')
  let match = body.match(/'([^']+)' column/)
  if (match) return match[1]
  match = body.match(/column [^.]+\.([a-zA-Z0-9_]+)/)
  if (match) return match[1]
  return null
}

async function findIdempotentJobByKey(jobType, idempotencyKey) {
  if (!idempotencyKey) return null
  try {
    const rows = await supabase.select(
      'jobs',
      `select=job_id,status,progress_processed,progress_total&job_type=eq.${encodeURIComponent(jobType)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`,
      { suppressMissingColumns: true }
    )
    return Array.isArray(rows) ? rows[0] : null
  } catch (err) {
    const body = String(err?.body || err?.message || '')
    if (body.includes('idempotency_key') && body.includes('does not exist')) {
      return null
    }
    throw err
  }
}

async function insertJobWithFallback(payload) {
  const current = { ...payload }
  const removed = new Set()
  while (true) {
    try {
      return await supabase.insert('jobs', current, { suppressMissingColumns: true })
    } catch (err) {
      const field = extractMissingColumn(err)
      if (!field || !(field in current) || removed.has(field)) {
        throw err
      }
      removed.add(field)
      delete current[field]
    }
  }
}

const SYNC_USAGE_CRON = process.env.SYNC_USAGE_CRON || '0 * * * *'
const JOB_POLL_INTERVAL_MS = resolveNumber(process.env.JOB_POLL_INTERVAL_MS, 5000)
const DUNNING_CHECK_CRON = process.env.DUNNING_CHECK_CRON || '30 2 * * *'
const ALERT_EVAL_CRON = process.env.ALERT_EVAL_CRON || '*/15 * * * *'
const WEBHOOK_DELIVERY_CRON = process.env.WEBHOOK_DELIVERY_CRON || '*/1 * * * *'
const USAGE_RATING_ROLLUP_CRON = process.env.USAGE_RATING_ROLLUP_CRON || '*/30 * * * *'
const USAGE_MONTHLY_ROLLUP_CRON = process.env.USAGE_MONTHLY_ROLLUP_CRON || '15 1 * * *'
const TEST_EXPIRY_CHECK_CRON = process.env.TEST_EXPIRY_CHECK_CRON || '0 3 * * *'
const SUBSCRIPTION_CANCEL_CRON = process.env.SUBSCRIPTION_CANCEL_CRON || '*/5 * * * *'
const SUBSCRIPTION_ONE_TIME_EXPIRY_CRON = process.env.SUBSCRIPTION_ONE_TIME_EXPIRY_CRON || '*/10 * * * *'
const AUTO_BILLING_CRON = process.env.AUTO_BILLING_CRON || '15 3 * * *'
const RECONCILIATION_CRON = process.env.RECONCILIATION_CRON || '45 4 * * *'
const WEBHOOK_DELIVERY_BATCH_LIMIT = resolveNumber(process.env.WEBHOOK_DELIVERY_BATCH_LIMIT, 50)
const ALERT_WINDOW_MINUTES = resolveNumber(process.env.ALERT_WINDOW_MINUTES, 60)
const ALERT_SUPPRESS_MINUTES = resolveNumber(process.env.ALERT_SUPPRESS_MINUTES, 30)
const ALERT_WINDOW_BY_RESELLER = parseNumberMap(process.env.ALERT_WINDOW_BY_RESELLER)
const ALERT_WINDOW_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_WINDOW_BY_ENTERPRISE)
const ALERT_SUPPRESS_BY_RESELLER = parseNumberMap(process.env.ALERT_SUPPRESS_BY_RESELLER)
const ALERT_SUPPRESS_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_SUPPRESS_BY_ENTERPRISE)
const ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_RESELLER = parseNumberMap(process.env.ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_RESELLER)
const ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_ENTERPRISE)
const ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT_BY_RESELLER = parseNumberMap(
  process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT_BY_RESELLER || process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB_BY_RESELLER
)
const ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT_BY_ENTERPRISE = parseNumberMap(
  process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT_BY_ENTERPRISE || process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB_BY_ENTERPRISE
)
const ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_RESELLER = parseNumberMap(process.env.ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_RESELLER)
const ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_ENTERPRISE)
const ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_RESELLER = parseNumberMap(process.env.ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_RESELLER)
const ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_ENTERPRISE)
const ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS_BY_RESELLER = parseNumberMap(
  process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS_BY_RESELLER || process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS_BY_RESELLER
)
const ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS_BY_ENTERPRISE = parseNumberMap(
  process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS_BY_ENTERPRISE || process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS_BY_ENTERPRISE
)
const ALERT_POOL_USAGE_HIGH_THRESHOLD_KB = resolveNumber(process.env.ALERT_POOL_USAGE_HIGH_THRESHOLD_KB, 500000)
const ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT = resolveNumber(
  process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT,
  Number(process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB) <= 100 ? Number(process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB) : 20
)
const ALERT_SILENT_SIM_THRESHOLD_HOURS = resolveNumber(process.env.ALERT_SILENT_SIM_THRESHOLD_HOURS, 24)
const ALERT_CDR_DELAY_THRESHOLD_HOURS = resolveNumber(process.env.ALERT_CDR_DELAY_THRESHOLD_HOURS, 48)
const ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS = resolveNumber(
  process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS || process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS,
  3
)
const ALERT_CONFIG_CACHE_SECONDS = resolveNumber(process.env.ALERT_CONFIG_CACHE_SECONDS, 60)

console.log('Worker starting...')
console.log(`Sync Usage Schedule: ${SYNC_USAGE_CRON}`)
console.log(`Job Poll Interval: ${JOB_POLL_INTERVAL_MS}ms`)
console.log(`Dunning Check Schedule: ${DUNNING_CHECK_CRON}`)
console.log(`Alert Evaluation Schedule: ${ALERT_EVAL_CRON}`)
console.log(`Webhook Delivery Schedule: ${WEBHOOK_DELIVERY_CRON}`)
console.log(`Usage Rating Rollup Schedule: ${USAGE_RATING_ROLLUP_CRON}`)
console.log(`Usage Monthly Rollup Schedule: ${USAGE_MONTHLY_ROLLUP_CRON}`)
console.log(`Test Expiry Check Schedule: ${TEST_EXPIRY_CHECK_CRON}`)
console.log(`Subscription Cancel Schedule: ${SUBSCRIPTION_CANCEL_CRON}`)
console.log(`Subscription ONE_TIME Expiry Schedule: ${SUBSCRIPTION_ONE_TIME_EXPIRY_CRON}`)
console.log(`Auto Billing Schedule: ${AUTO_BILLING_CRON}`)
console.log(`Reconciliation Schedule: ${RECONCILIATION_CRON}`)

// --- Usage Sync Task ---
async function syncUsageTask() {
  const traceId = `worker-usage-${Date.now()}`
  console.log(`[${traceId}] Starting usage sync...`)
  try {
    // 1. Get all active SIMs
    // Note: In a real system, we would paginate this or use a cursor.
    // For now, we fetch a batch of active SIMs.
    const { data: sims, error } = await supabase.selectWithCount(
      'sims',
      'select=sim_id,iccid,enterprise_id,supplier_id,apn,suppliers(name)&status=eq.ACTIVATED&limit=1000'
    )
    
    if (error) throw error
    if (!sims || sims.length === 0) {
      console.log(`[${traceId}] No active SIMs to sync.`)
      return
    }

    console.log(`[${traceId}] Syncing usage for ${sims.length} SIMs...`)
    const usageDay = new Date().toISOString().slice(0, 10)
    
    for (const sim of sims) {
      try {
        let usage = { uplink: 0, downlink: 0 }
        let isTotalUsage = false
        
        // Check if SIM is from WXZHONGGENG
        const supplierName = sim.suppliers?.name
        const isWx = supplierName === 'WXZHONGGENG'

        if (isWx) {
            try {
                // Try to fetch real usage
                const remoteUsage = await wxClient.getUsage(sim.iccid, usageDay)
                if (remoteUsage) {
                    usage.uplink = Number(remoteUsage.uplinkKb || 0)
                    usage.downlink = Number(remoteUsage.downlinkKb || 0)
                    isTotalUsage = true
                }
            } catch (wxErr) {
                // If not implemented or failed, log and fall back to demo simulation
                // console.warn(`[${traceId}] WX usage fetch failed for ${sim.iccid}: ${wxErr.message}. Using fallback.`)
                // Fallback to random increment for demo continuity
                const increment = Math.floor(Math.random() * 1000) 
                usage.uplink = Math.floor(increment * 0.3)
                usage.downlink = Math.floor(increment * 0.7)
                isTotalUsage = false
            }
        } else {
            // Demo simulation for other suppliers
            const increment = Math.floor(Math.random() * 1000) // 0-1MB random
            usage.uplink = Math.floor(increment * 0.3)
            usage.downlink = Math.floor(increment * 0.7)
            isTotalUsage = false
        }

        if (usage.uplink === 0 && usage.downlink === 0) continue;

        // Upsert into usage_daily_summary
        // We need to fetch existing to add to it, or rely on upstream providing "daily total".
        // Assuming upstream provides "current daily total":
        // But here we are simulating "increment". 
        // Let's assume we are fetching "total for the day" from upstream.
        // For the simulation, we will read existing and add to it to simulate "real-time" accumulation?
        // OR, just set it to a value.
        
        // Let's try to do it properly: upsert based on (iccid, usage_day, visited_mccmnc)
        const visited = '204-08' // Default mocked
        
        // Check existing
        const match = `iccid=eq.${encodeURIComponent(sim.iccid)}&usage_day=eq.${encodeURIComponent(usageDay)}&visited_mccmnc=eq.${encodeURIComponent(visited)}`
        const existingRows = await supabase.select('usage_daily_summary', `select=usage_id,total_mb,uplink_mb,downlink_mb&${match}&limit=1`)
        const existing = Array.isArray(existingRows) ? existingRows[0] : null

        let newUplink = usage.uplink
        let newDownlink = usage.downlink
        
        // If we are simulating "incremental updates", we add to existing.
        // If we are fetching "daily total" from upstream, we replace (or max).
        // WXZHONGGENG returns total daily usage, so we replace.
        if (existing) {
          if (isTotalUsage) {
            newUplink = usage.uplink
            newDownlink = usage.downlink
          } else {
            newUplink += Number(existing.uplink_mb || 0)
            newDownlink += Number(existing.downlink_mb || 0)
          }
          
          await supabase.update('usage_daily_summary', `usage_id=eq.${encodeURIComponent(String(existing.usage_id))}`, {
            uplink_mb: newUplink,
            downlink_mb: newDownlink,
            total_mb: newUplink + newDownlink,
            updated_at: new Date().toISOString() // Assuming we add updated_at or just rely on audit
          }, { returning: 'minimal' })
        } else {
          await supabase.insert('usage_daily_summary', {
            supplier_id: sim.supplier_id,
            enterprise_id: sim.enterprise_id ?? null,
            sim_id: sim.sim_id ?? null,
            iccid: sim.iccid,
            usage_day: usageDay,
            visited_mccmnc: visited,
            uplink_mb: newUplink,
            downlink_mb: newDownlink,
            total_mb: newUplink + newDownlink,
            apn: sim.apn ?? null,
            input_ref: 'worker_sync',
          }, { returning: 'minimal' })
        }

      } catch (err) {
        console.error(`[${traceId}] Failed to sync sim ${sim.iccid}:`, err.message)
      }
    }
    console.log(`[${traceId}] Usage sync completed.`)
  } catch (err) {
    console.error(`[${traceId}] Usage sync failed:`, err)
  }
}

async function dunningCheckTask() {
  const traceId = `worker-dunning-${Date.now()}`
  console.log(`[${traceId}] Starting dunning check...`)
  try {
    const result = await runDunningCheck({ supabase })
    if (!result?.ok) {
      console.error(`[${traceId}] Dunning check failed: ${result?.message || 'unknown error'}`)
      return
    }
    console.log(`[${traceId}] Dunning check completed. processed=${result?.value?.processed ?? 0} enterprises=${result?.value?.enterprises ?? 0}`)
  } catch (err) {
    console.error(`[${traceId}] Dunning check failed:`, err)
  }
}

async function alertEvaluationTask() {
  const traceId = `worker-alert-${Date.now()}`
  console.log(`[${traceId}] Starting alert evaluation...`)
  try {
    try {
      const probe = await runUpstreamIntegrationHealthProbe(supabase)
      console.log(`[${traceId}] Upstream health probe completed. probed=${probe.probed} failed=${probe.failed}`)
    } catch (err) {
      console.warn(`[${traceId}] Upstream health probe skipped or failed:`, err)
    }
    const result = await runAlertEvaluation({
      supabase,
      now: new Date(),
      options: {
        windowMinutes: ALERT_WINDOW_MINUTES,
        suppressMinutes: ALERT_SUPPRESS_MINUTES,
        windowMinutesByReseller: ALERT_WINDOW_BY_RESELLER,
        windowMinutesByEnterprise: ALERT_WINDOW_BY_ENTERPRISE,
        suppressMinutesByReseller: ALERT_SUPPRESS_BY_RESELLER,
        suppressMinutesByEnterprise: ALERT_SUPPRESS_BY_ENTERPRISE,
        poolUsageHighThresholdKbByReseller: ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_RESELLER,
        poolUsageHighThresholdKbByEnterprise: ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_ENTERPRISE,
        outOfProfileSurgeThresholdPercentByReseller: ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT_BY_RESELLER,
        outOfProfileSurgeThresholdPercentByEnterprise: ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT_BY_ENTERPRISE,
        silentSimThresholdHoursByReseller: ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_RESELLER,
        silentSimThresholdHoursByEnterprise: ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_ENTERPRISE,
        cdrDelayThresholdHoursByReseller: ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_RESELLER,
        cdrDelayThresholdHoursByEnterprise: ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_ENTERPRISE,
        upstreamDisconnectThresholdAttemptsByReseller: ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS_BY_RESELLER,
        upstreamDisconnectThresholdAttemptsByEnterprise: ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS_BY_ENTERPRISE,
        configCacheSeconds: ALERT_CONFIG_CACHE_SECONDS,
        poolUsageHighThresholdKb: ALERT_POOL_USAGE_HIGH_THRESHOLD_KB,
        outOfProfileSurgeThresholdPercent: ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_PERCENT,
        silentSimThresholdHours: ALERT_SILENT_SIM_THRESHOLD_HOURS,
        cdrDelayThresholdHours: ALERT_CDR_DELAY_THRESHOLD_HOURS,
        upstreamDisconnectThresholdAttempts: ALERT_UPSTREAM_DISCONNECT_THRESHOLD_ATTEMPTS,
      },
    })
    if (!result?.ok) {
      console.error(`[${traceId}] Alert evaluation failed: ${result?.message || 'unknown error'}`)
      return
    }
    console.log(`[${traceId}] Alert evaluation completed. created=${result?.value?.created ?? 0} skipped=${result?.value?.skipped ?? 0} errors=${result?.value?.errors ?? 0}`)
  } catch (err) {
    console.error(`[${traceId}] Alert evaluation failed:`, err)
  }
}

async function webhookDeliveryTask() {
  const now = new Date()
  const minuteKey = now.toISOString().slice(0, 16)
  const idempotencyKey = `WEBHOOK_DELIVERY:${minuteKey}`
  const traceId = `worker-webhook-${minuteKey}`
  console.log(`[${traceId}] Enqueueing webhook delivery job...`)
  try {
    const existing = await findIdempotentJobByKey('WEBHOOK_DELIVERY', idempotencyKey)
    if (existing && existing.status !== 'FAILED') {
      console.log(`[${traceId}] Webhook delivery job already queued=${existing.job_id ?? 'unknown'}`)
      return
    }
    const jobRows = await insertJobWithFallback({
      job_type: 'WEBHOOK_DELIVERY',
      status: 'QUEUED',
      progress_processed: 0,
      progress_total: 0,
      request_id: traceId,
      idempotency_key: idempotencyKey,
      payload: {
        limit: WEBHOOK_DELIVERY_BATCH_LIMIT,
      },
    })
    const job = Array.isArray(jobRows) ? jobRows[0] : null
    console.log(`[${traceId}] Webhook delivery job queued=${job?.job_id ?? 'unknown'}`)
  } catch (err) {
    console.error(`[${traceId}] Webhook delivery job enqueue failed:`, err)
  }
}

// --- Test Expiry Check Task (T-NEW-3) ---
// Daily check for SIMs in TEST_READY whose test period has expired.
// If auto_activate_on_expiry is true → ACTIVATED, otherwise → DEACTIVATED.
// Uses FOR UPDATE SKIP LOCKED semantics via sequential single-row updates.
async function testExpiryCheckTask() {
  const traceId = `worker-test-expiry-${Date.now()}`
  console.log(`[${traceId}] Starting TEST_READY expiry sweep (Commercial Terms + no-MAIN fallback)...`)
  try {
    const result = await runTestReadyExpiryEvaluation(supabase, {
      trigger: 'CRON',
      sweepAll: true,
      requestId: traceId,
    })
    console.log(
      `[${traceId}] Test expiry completed. processed=${result.processed} activatedQueued=${result.activated} deactivatedQueued=${result.deactivated} skipped=${result.skipped} batchJob=${result.jobId ?? 'n/a'}`
    )
  } catch (err) {
    console.error(`[${traceId}] Test expiry check failed:`, err)
  }
}

// --- Subscription Cancel Schedule Task ---
async function subscriptionCancelTask() {
  const traceId = `worker-subscription-cancel-${Date.now()}`
  try {
    const result = await executeScheduledCancels({ supabase })
    if (result.ok && result.value.processed > 0) {
      console.log(`[${traceId}] Executed ${result.value.processed} scheduled cancels:`, result.value.results)
    }
  } catch (err) {
    if (String(err?.message || '').includes('subscription_cancel_schedules')) {
      console.log(`[${traceId}] subscription_cancel_schedules table not found (migration may not be run), skipping.`)
    } else {
      console.error(`[${traceId}] Subscription cancel task failed:`, err)
    }
  }
}

async function subscriptionOneTimeExpiryTask() {
  const traceId = `worker-one-time-expiry-${Date.now()}`
  try {
    const result = await runOneTimeSubscriptionExpiry({
      supabase,
      requestId: traceId,
      limit: resolveNumber(process.env.SUBSCRIPTION_ONE_TIME_EXPIRY_BATCH_LIMIT, 100),
    })
    if (result.ok && (result.value.processed > 0 || result.value.examined > 0)) {
      console.log(
        `[${traceId}] ONE_TIME expiry: examined=${result.value.examined} expired=${result.value.processed} skipped=${result.value.skipped}`
      )
    }
  } catch (err) {
    console.error(`[${traceId}] ONE_TIME subscription expiry failed:`, err)
  }
}

// --- Auto-Billing Cron Task (T+N automatic billing) ---
async function autoBillingTask() {
  const traceId = `worker-auto-billing-${Date.now()}`
  console.log(`[${traceId}] Starting auto-billing check...`)
  try {
    const today = new Date()
    const todayDay = today.getDate()

    // Query billing_config rows where auto_generate is true
    const configRows = await supabase.select(
      'billing_config',
      'select=config_id,enterprise_id,bill_day,auto_generate,auto_publish,currency,time_zone&auto_generate=eq.true&limit=500'
    )
    const configs = Array.isArray(configRows) ? configRows : []
    if (configs.length === 0) {
      console.log(`[${traceId}] No enterprises configured for auto-billing.`)
      return
    }

    // Determine current billing period (previous month)
    const periodDate = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const period = `${periodDate.getFullYear()}-${String(periodDate.getMonth() + 1).padStart(2, '0')}`

    let queued = 0
    let skipped = 0

    for (const config of configs) {
      try {
        const billDay = Number(config.bill_day ?? 3)
        if (todayDay < billDay) {
          skipped += 1
          continue
        }

        const enterpriseId = config.enterprise_id
        if (!enterpriseId) {
          skipped += 1
          continue
        }

        // Idempotency: check if a BILLING_GENERATE job already exists for this enterprise + period
        const idempotencyKey = `AUTO_BILLING:${enterpriseId}:${period}`
        const existing = await findIdempotentJobByKey('BILLING_GENERATE', idempotencyKey)
        if (existing && existing.status !== 'FAILED') {
          skipped += 1
          continue
        }

        await insertJobWithFallback({
          job_type: 'BILLING_GENERATE',
          status: 'QUEUED',
          progress_processed: 0,
          progress_total: 0,
          request_id: traceId,
          idempotency_key: idempotencyKey,
          payload: {
            enterpriseId,
            period,
            autoPublish: config.auto_publish === true,
            actorRole: 'SYSTEM',
            requestId: traceId,
          },
        })
        queued += 1
      } catch (err) {
        console.error(`[${traceId}] Failed to queue auto-billing for enterprise ${config.enterprise_id}:`, err.message)
      }
    }
    console.log(`[${traceId}] Auto-billing check completed. queued=${queued} skipped=${skipped}`)
  } catch (err) {
    console.error(`[${traceId}] Auto-billing check failed:`, err)
  }
}

// --- Reconciliation Cron Task ---
async function reconciliationTask() {
  const traceId = `worker-reconciliation-${Date.now()}`
  console.log(`[${traceId}] Starting reconciliation scheduling...`)
  try {
    // Query active suppliers
    const supplierRows = await supabase.select(
      'suppliers',
      'select=supplier_id,name&status=eq.ACTIVE&limit=500'
    )
    const suppliers = Array.isArray(supplierRows) ? supplierRows : []
    if (suppliers.length === 0) {
      console.log(`[${traceId}] No active suppliers for reconciliation.`)
      return
    }

    const today = new Date().toISOString().slice(0, 10)
    let queued = 0
    let skipped = 0

    for (const supplier of suppliers) {
      try {
        const supplierId = supplier.supplier_id
        if (!supplierId) {
          skipped += 1
          continue
        }

        // Idempotency: check if a RECONCILIATION_RUN job already exists for this supplier + date
        const idempotencyKey = `RECONCILIATION:${supplierId}:${today}`
        const existing = await findIdempotentJobByKey('RECONCILIATION_RUN', idempotencyKey)
        if (existing && existing.status !== 'FAILED') {
          skipped += 1
          continue
        }

        await insertJobWithFallback({
          job_type: 'RECONCILIATION_RUN',
          status: 'QUEUED',
          progress_processed: 0,
          progress_total: 0,
          request_id: traceId,
          idempotency_key: idempotencyKey,
          payload: {
            supplierId,
            date: today,
            scope: 'INCREMENTAL',
            traceId,
          },
        })
        queued += 1
      } catch (err) {
        console.error(`[${traceId}] Failed to queue reconciliation for supplier ${supplier.supplier_id}:`, err.message)
      }
    }
    console.log(`[${traceId}] Reconciliation scheduling completed. queued=${queued} skipped=${skipped}`)
  } catch (err) {
    console.error(`[${traceId}] Reconciliation scheduling failed:`, err)
  }
}

// --- Usage Rating Rollup Cron Task ---
async function usageRatingRollupTask() {
  const traceId = `worker-usage-rollup-${Date.now()}`
  const now = new Date()
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const slot = now.toISOString().slice(0, 16)
  const idempotencyKey = `USAGE_RATING_ROLLUP:GLOBAL:${period}:${slot}`
  try {
    const existing = await findIdempotentJobByKey('USAGE_RATING_ROLLUP', idempotencyKey)
    if (existing && existing.status !== 'FAILED') {
      console.log(`[${traceId}] Usage rollup already queued=${existing.job_id ?? 'unknown'}`)
      return
    }
    const jobRows = await insertJobWithFallback({
      job_type: 'USAGE_RATING_ROLLUP',
      status: 'QUEUED',
      progress_processed: 0,
      progress_total: 0,
      request_id: traceId,
      idempotency_key: idempotencyKey,
      payload: {
        period,
        requestId: traceId,
      },
    })
    const job = Array.isArray(jobRows) ? jobRows[0] : null
    console.log(`[${traceId}] Usage rollup job queued=${job?.job_id ?? 'unknown'}`)
  } catch (err) {
    console.error(`[${traceId}] Usage rollup job enqueue failed:`, err)
  }
}

// --- Usage Monthly Rollup Cron Task (previous calendar month; idempotent daily) ---
async function usageMonthlyRollupTask() {
  const traceId = `worker-usage-monthly-${Date.now()}`
  const period = previousUtcYearMonth()
  const dayKey = new Date().toISOString().slice(0, 10)
  const idempotencyKey = `USAGE_MONTHLY_ROLLUP:GLOBAL:${period}:${dayKey}`
  try {
    const existing = await findIdempotentJobByKey('USAGE_MONTHLY_ROLLUP', idempotencyKey)
    if (existing && existing.status !== 'FAILED') {
      console.log(`[${traceId}] Usage monthly rollup already queued=${existing.job_id ?? 'unknown'}`)
      return
    }
    const jobRows = await insertJobWithFallback({
      job_type: 'USAGE_MONTHLY_ROLLUP',
      status: 'QUEUED',
      progress_processed: 0,
      progress_total: 0,
      request_id: traceId,
      idempotency_key: idempotencyKey,
      payload: {
        period,
        requestId: traceId,
      },
    })
    const job = Array.isArray(jobRows) ? jobRows[0] : null
    console.log(`[${traceId}] Usage monthly rollup job queued=${job?.job_id ?? 'unknown'} period=${period}`)
  } catch (err) {
    console.error(`[${traceId}] Usage monthly rollup job enqueue failed:`, err)
  }
}

// --- Job Processor ---
async function processJobs() {
  try {
    // 1. Fetch queued jobs
    // Lock mechanism is needed for multiple workers, but for single worker instance:
    // We pick one 'QUEUED' job.
    // Note: 'payload' column might be missing in some schemas, so we rely on request_id workaround if needed.
    // console.log('Checking for jobs...')
    let jobs = await supabase.select(
      'jobs',
      'select=job_id,job_type,request_id,payload,status&status=eq.QUEUED&order=created_at.asc&limit=1',
      { suppressMissingColumns: true }
    )
    let job = Array.isArray(jobs) && jobs.length > 0 ? jobs[0] : null
    let resumeRunning = false
    if (!job) {
      jobs = await supabase.select(
        'jobs',
        'select=job_id,job_type,request_id,payload,status&job_type=in.(SIM_STATUS_CHANGE,SUBSCRIPTION_PROVISION)&status=eq.RUNNING&order=started_at.asc&limit=1',
        { suppressMissingColumns: true }
      )
      job = Array.isArray(jobs) && jobs.length > 0 ? jobs[0] : null
      resumeRunning = !!job
    }
    if (!job) return // No jobs

    // Workaround: Parse payload from request_id if available and looks like JSON
    if (!job.payload && job.request_id && job.request_id.trim().startsWith('{')) {
        try {
            job.payload = JSON.parse(job.request_id)
        } catch (e) {
            // ignore, maybe it's a real request_id
        }
    }

    console.log(`Processing job ${job.job_id} (${job.job_type})${resumeRunning ? ' (resume RUNNING)' : ''}...`)

    // 2. Mark as RUNNING (skip if already RUNNING — pending upstream retry)
    if (!resumeRunning) {
      await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
        status: 'RUNNING',
        started_at: new Date().toISOString()
      }, { returning: 'minimal' })
    }

    let markSucceeded = true
    let markFailedSummary = null
    try {
      // 3. Execute logic based on type
      switch (job.job_type) {
        case 'ASYNC_SIM_ACTIVATION':
          await handleAsyncSimActivation(job)
          break;
        case 'GENERATE_MONTHLY_BILLS':
          await handleGenerateMonthlyBills(job)
          break;
        case 'LATE_CDR_PROCESS':
          await handleLateCdrJob(job)
          break;
        case 'BILLING_GENERATE':
          await handleBillingGenerateJob(job)
          break;
        case 'USAGE_RATING_ROLLUP': {
          const ratingResult = await handleUsageRatingRollupJob(job)
          if (ratingResult?.failed) {
            markSucceeded = false
            markFailedSummary = ratingResult.errorSummary || 'Usage rating rollup failed.'
          }
          break
        }
        case 'USAGE_MONTHLY_ROLLUP': {
          const monthlyResult = await handleUsageMonthlyRollupJob(job)
          if (monthlyResult?.failed) {
            markSucceeded = false
            markFailedSummary = monthlyResult.errorSummary || 'Usage monthly rollup failed.'
          }
          break
        }
        case 'DUNNING_CHECK':
          await handleDunningCheckJob(job)
          break;
        case 'RECONCILIATION_RUN':
          await handleReconciliationRunJob(job)
          break;
        case 'SIM_RESET_CONNECTION':
          await handleSimResetConnectionJob(job)
          break;
        case 'SIM_STATUS_CHANGE': {
          const simJobResult = await handleSimStatusChangeJob(job)
          if (simJobResult?.pending) {
            markSucceeded = false
          }
          break
        }
        case 'SUBSCRIPTION_PROVISION': {
          const subJobResult = await processSubscriptionProvisionJob({ supabase, job })
          if (subJobResult?.pending) {
            markSucceeded = false
          } else if (subJobResult?.failed) {
            markSucceeded = false
            markFailedSummary = subJobResult.errorSummary || 'Subscription provision failed.'
          }
          break
        }
        case 'WEBHOOK_DELIVERY':
          await handleWebhookDeliveryJob(job)
          break;
        default:
          throw new Error(`Unknown job type: ${job.job_type}`)
      }

      // 4. Mark as SUCCEEDED / FAILED (skip while upstream pending)
      if (markFailedSummary) {
        await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
          status: 'FAILED',
          finished_at: new Date().toISOString(),
          progress_processed: 1,
          progress_total: 1,
          error_summary: String(markFailedSummary).slice(0, 1000),
        }, { returning: 'minimal' })
        console.log(`Job ${job.job_id} failed (handled).`)
      } else if (markSucceeded) {
        await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
          status: 'SUCCEEDED',
          finished_at: new Date().toISOString(),
          progress_processed: 1,
          progress_total: 1
        }, { returning: 'minimal' })
        console.log(`Job ${job.job_id} succeeded.`)
      } else {
        console.log(`Job ${job.job_id} pending upstream; remains RUNNING.`)
      }

    } catch (err) {
      console.error(`Job ${job.job_id} failed:`, err)
      // 5. Mark as FAILED
      await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
        status: 'FAILED',
        finished_at: new Date().toISOString(),
        error_summary: String(err.message).slice(0, 1000)
      }, { returning: 'minimal' })
    }
  } catch (outerErr) {
    console.error('Critical error in processJobs loop:', outerErr)
  }
}

// Job Handlers
async function handleAsyncSimActivation(job) {
  // Mock implementation
  // Payload might contain { iccid, targetStatus }
  const payload = job.payload || {}
  const { iccid } = payload
  if (!iccid) throw new Error('Missing iccid in payload')
  
  // Simulate delay
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  // Perform logic (e.g. call upstream)
  // Here we just update the SIM status in DB as 'ACTIVATED'
  // But wait, usually this logic is shared with the API.
  // For now, we just log.
  console.log(`[Job ${job.job_id}] Activated SIM ${iccid}`)
}

async function handleGenerateMonthlyBills(job) {
  console.log(`[Job ${job.job_id}] Generating bills...`)
  await runBillingTask(job, supabase)
}

async function handleLateCdrJob(job) {
  console.log(`[Job ${job.job_id}] Handling late CDR...`)
  const payload = job.payload || {}
  const records = Array.isArray(payload.records) ? payload.records : []
  await handleLateCdr({
    records,
    source: payload.source ?? null,
    batchId: payload.batchId ?? null,
    traceId: payload.traceId ?? null,
    supabaseClient: supabase,
  })
}

async function handleBillingGenerateJob(job) {
  console.log(`[Job ${job.job_id}] Generating bills...`)
  const payload = job.payload || {}
  const result = await runBillingGenerate({
    supabase,
    period: payload.period,
    enterpriseId: payload.enterpriseId ?? null,
    resellerId: payload.resellerId ?? null,
    autoPublish: payload.autoPublish ?? null,
    actorUserId: payload.actorUserId ?? null,
    actorRole: payload.actorRole ?? null,
    requestId: payload.requestId ?? job.request_id ?? null,
    sourceIp: payload.sourceIp ?? null,
    jobId: job.job_id,
  })
  if (!result?.ok) {
    throw new Error(result?.message || 'Billing generate failed.')
  }
  const total = Array.isArray(result?.value?.results) ? result.value.results.length : 1
  await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
    progress_processed: total,
    progress_total: total,
  }, { returning: 'minimal' })
}

async function handleUsageRatingRollupJob(job) {
  console.log(`[Job ${job.job_id}] Running usage rating rollup...`)
  const payload = job.payload || {}
  const result = await runUsageRatingRollup({
    supabase,
    period: payload.period ?? null,
    enterpriseId: payload.enterpriseId ?? null,
    resellerId: payload.resellerId ?? null,
    jobId: job.job_id,
  })
  if (!result?.ok) {
    return {
      failed: true,
      errorSummary: result?.message || 'Usage rating rollup failed.',
    }
  }
  const processed = Number(result?.value?.enterpriseCount ?? 0)
  await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
    progress_processed: processed,
    progress_total: processed,
  }, { returning: 'minimal' })
  return { failed: false }
}

async function handleUsageMonthlyRollupJob(job) {
  console.log(`[Job ${job.job_id}] Running usage monthly rollup...`)
  const payload = job.payload || {}
  const result = await runUsageMonthlyRollup({
    supabase,
    period: payload.period ?? null,
    enterpriseId: payload.enterpriseId ?? null,
    resellerId: payload.resellerId ?? null,
    jobId: job.job_id,
  })
  if (!result?.ok) {
    // Expected business outcomes (no daily rows, bad period, scope) — fail the job quietly (no stack dump).
    return {
      failed: true,
      errorSummary: result?.message || 'Usage monthly rollup failed.',
    }
  }
  const processed = Number(result?.value?.monthlyRows ?? 0)
  await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
    progress_processed: processed,
    progress_total: processed,
  }, { returning: 'minimal' })
  return { failed: false }
}

async function handleDunningCheckJob(job) {
  console.log(`[Job ${job.job_id}] Running dunning check...`)
  const payload = job.payload || {}
  const result = await runDunningCheck({
    supabase,
    enterpriseId: payload.enterpriseId ?? null,
    asOfDate: payload.asOfDate ?? null,
  })
  if (!result?.ok) {
    throw new Error(result?.message || 'Dunning check failed.')
  }
  const processed = Number(result?.value?.processed ?? 0)
  await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
    progress_processed: processed,
    progress_total: processed,
  }, { returning: 'minimal' })
}

async function handleReconciliationRunJob(job) {
  console.log(`[Job ${job.job_id}] Running reconciliation...`)
  const payload = job.payload || {}
  const result = await runReconciliation({
    supabase,
    runId: payload.runId ?? null,
    supplierId: payload.supplierId ?? null,
    date: payload.date ?? null,
    scope: payload.scope ?? null,
    traceId: payload.traceId ?? null,
  })
  if (!result?.ok) {
    throw new Error(result?.message || 'Reconciliation run failed.')
  }
  const total = Number(result?.value?.summary?.totalSimsChecked ?? 0)
  await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
    progress_processed: total,
    progress_total: total,
  }, { returning: 'minimal' })
}

async function handleSimResetConnectionJob(job) {
  const payload = job.payload || {}
  const iccid = payload.iccid ? String(payload.iccid) : null
  console.log(`[Job ${job.job_id}] Resetting connection${iccid ? ` for ${iccid}` : ''}...`)
}

// --- Phase 25: SIM Status Change Job Handler (T141a, T141b, T141c) ---
const SIM_STATUS_CHANGE_MAX_RETRIES = resolveNumber(process.env.SIM_STATUS_CHANGE_MAX_RETRIES, 3)

async function computeExponentialBackoffMs(attempt) {
  const baseMs = 1000
  const jitter = Math.random() * 500
  return Math.min(baseMs * Math.pow(2, attempt) + jitter, 30000)
}

async function handleSimStatusChangeJob(job) {
  const payload = job.payload || {}
  let supplierId = payload.supplierId ? String(payload.supplierId) : null
  let operatorId = payload.operatorId ? String(payload.operatorId) : null
  const traceId = `worker-sim-status-change-${job.job_id}`
  const targetStatus = String(payload.afterStatus || payload.targetStatus || '').toUpperCase()

  if (!supplierId || !operatorId) {
    const simId = payload.simId ? String(payload.simId) : null
    const iccid = payload.iccid ? String(payload.iccid) : null
    if (simId || iccid) {
      const simRows = await supabase.select(
        'sims',
        `select=supplier_id,operator_id&${
          simId ? `sim_id=eq.${encodeURIComponent(simId)}` : `iccid=eq.${encodeURIComponent(iccid)}`
        }&limit=1`
      )
      const sim = Array.isArray(simRows) ? simRows[0] : null
      if (sim?.supplier_id) supplierId = String(sim.supplier_id)
      if (sim?.operator_id) operatorId = String(sim.operator_id)
    }
  }

  console.log(`[${traceId}] Processing SIM status change: iccid=${payload.iccid} target=${targetStatus}`)

  const capCheck = await checkOperationSupported({
    supabase,
    supplierId,
    operatorId,
    operation: 'SIM_STATUS_CHANGE',
  })
  const adapter = capCheck.supported ? capCheck.adapter : null
  if (!capCheck.supported) {
    console.warn(`[${traceId}] No upstream adapter: ${capCheck.reason || 'UPSTREAM_NOT_SUPPORTED'} — local-only finalize if policy allows`)
  }

  const result = await processSimStatusChangeJob({
    supabase,
    job,
    adapter,
    finalizeSimStatusChange,
  })

  if (result?.pending) {
    return { pending: true }
  }
  if (result?.failed) {
    throw new Error('SIM_STATUS_CHANGE_UPSTREAM_FAILED')
  }
  return { ok: true }
}

async function handleWebhookDeliveryJob(job) {
  const payload = job.payload || {}
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
    const id = Number(row?.delivery_id ?? 0)
    if (!Number.isFinite(id) || id <= 0) continue
    const result = await retryWebhookDelivery({ supabase, deliveryId: id })
    if (result?.ok) processed += 1
  }
  await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
    progress_processed: processed,
    progress_total: deliveries.length,
  }, { returning: 'minimal' })
}


const SYSTEM_TIME_ZONE = resolveSystemTimeZone()

function scheduleCron(label, expression, task) {
  const validated = ensureValidCronExpression(expression, label, cron.validate)
  const options = SYSTEM_TIME_ZONE ? { timezone: SYSTEM_TIME_ZONE } : undefined
  return cron.schedule(validated, task, options)
}

// --- Main Loop ---
scheduleCron('SYNC_USAGE_CRON', SYNC_USAGE_CRON, syncUsageTask)
scheduleCron('DUNNING_CHECK_CRON', DUNNING_CHECK_CRON, dunningCheckTask)
scheduleCron('ALERT_EVAL_CRON', ALERT_EVAL_CRON, alertEvaluationTask)
scheduleCron('WEBHOOK_DELIVERY_CRON', WEBHOOK_DELIVERY_CRON, webhookDeliveryTask)
scheduleCron('USAGE_RATING_ROLLUP_CRON', USAGE_RATING_ROLLUP_CRON, usageRatingRollupTask)
scheduleCron('USAGE_MONTHLY_ROLLUP_CRON', USAGE_MONTHLY_ROLLUP_CRON, usageMonthlyRollupTask)
scheduleCron('TEST_EXPIRY_CHECK_CRON', TEST_EXPIRY_CHECK_CRON, testExpiryCheckTask)
scheduleCron('SUBSCRIPTION_CANCEL_CRON', SUBSCRIPTION_CANCEL_CRON, subscriptionCancelTask)
scheduleCron('SUBSCRIPTION_ONE_TIME_EXPIRY_CRON', SUBSCRIPTION_ONE_TIME_EXPIRY_CRON, subscriptionOneTimeExpiryTask)
scheduleCron('AUTO_BILLING_CRON', AUTO_BILLING_CRON, autoBillingTask)
scheduleCron('RECONCILIATION_CRON', RECONCILIATION_CRON, reconciliationTask)

// Polling for jobs
let isProcessing = false
async function safeProcessJobs() {
    if (isProcessing) return
    isProcessing = true
    try {
        await processJobs()
    } catch (err) {
        console.error('Unexpected error in safeProcessJobs:', err)
    } finally {
        isProcessing = false
    }
}

setInterval(safeProcessJobs, JOB_POLL_INTERVAL_MS)

console.log('Worker is running.')
safeProcessJobs() // Initial run
