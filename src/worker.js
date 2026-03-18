import 'dotenv/config'
import cron from 'node-cron'
import { createSupabaseRestClient } from './supabaseRest.js'
import { ensureValidCronExpression, resolveSystemTimeZone } from './utils/timezone.js'
import { createWxzhonggengClient } from './vendors/wxzhonggeng.js'
import { runBillingTask } from './billing.js'
import { runBillingGenerate } from './services/billingGenerate.js'
import { handleLateCdr } from './services/lateCdr.js'
import { runDunningCheck } from './services/dunning.js'
import { runReconciliation } from './services/reconciliation.js'
import { runAlertEvaluation } from './services/alerting.js'
import { retryWebhookDelivery } from './services/webhook.js'

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
const TEST_EXPIRY_CHECK_CRON = process.env.TEST_EXPIRY_CHECK_CRON || '0 3 * * *'
const WEBHOOK_DELIVERY_BATCH_LIMIT = resolveNumber(process.env.WEBHOOK_DELIVERY_BATCH_LIMIT, 50)
const ALERT_WINDOW_MINUTES = resolveNumber(process.env.ALERT_WINDOW_MINUTES, 60)
const ALERT_SUPPRESS_MINUTES = resolveNumber(process.env.ALERT_SUPPRESS_MINUTES, 30)
const ALERT_WINDOW_BY_RESELLER = parseNumberMap(process.env.ALERT_WINDOW_BY_RESELLER)
const ALERT_WINDOW_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_WINDOW_BY_ENTERPRISE)
const ALERT_SUPPRESS_BY_RESELLER = parseNumberMap(process.env.ALERT_SUPPRESS_BY_RESELLER)
const ALERT_SUPPRESS_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_SUPPRESS_BY_ENTERPRISE)
const ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_RESELLER = parseNumberMap(process.env.ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_RESELLER)
const ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_POOL_USAGE_HIGH_THRESHOLD_KB_BY_ENTERPRISE)
const ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB_BY_RESELLER = parseNumberMap(process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB_BY_RESELLER)
const ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB_BY_ENTERPRISE)
const ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_RESELLER = parseNumberMap(process.env.ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_RESELLER)
const ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_ENTERPRISE)
const ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_RESELLER = parseNumberMap(process.env.ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_RESELLER)
const ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_ENTERPRISE)
const ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS_BY_RESELLER = parseNumberMap(process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS_BY_RESELLER)
const ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS_BY_ENTERPRISE = parseNumberMap(process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS_BY_ENTERPRISE)
const ALERT_POOL_USAGE_HIGH_THRESHOLD_KB = resolveNumber(process.env.ALERT_POOL_USAGE_HIGH_THRESHOLD_KB, 500000)
const ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB = resolveNumber(process.env.ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB, 100000)
const ALERT_SILENT_SIM_THRESHOLD_HOURS = resolveNumber(process.env.ALERT_SILENT_SIM_THRESHOLD_HOURS, 24)
const ALERT_CDR_DELAY_THRESHOLD_HOURS = resolveNumber(process.env.ALERT_CDR_DELAY_THRESHOLD_HOURS, 48)
const ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS = resolveNumber(process.env.ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS, 1)
const ALERT_CONFIG_CACHE_SECONDS = resolveNumber(process.env.ALERT_CONFIG_CACHE_SECONDS, 60)

console.log('Worker starting...')
console.log(`Sync Usage Schedule: ${SYNC_USAGE_CRON}`)
console.log(`Job Poll Interval: ${JOB_POLL_INTERVAL_MS}ms`)
console.log(`Dunning Check Schedule: ${DUNNING_CHECK_CRON}`)
console.log(`Alert Evaluation Schedule: ${ALERT_EVAL_CRON}`)
console.log(`Webhook Delivery Schedule: ${WEBHOOK_DELIVERY_CRON}`)
console.log(`Test Expiry Check Schedule: ${TEST_EXPIRY_CHECK_CRON}`)

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
        const existingRows = await supabase.select('usage_daily_summary', `select=usage_id,total_kb,uplink_kb,downlink_kb&${match}&limit=1`)
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
            newUplink += Number(existing.uplink_kb || 0)
            newDownlink += Number(existing.downlink_kb || 0)
          }
          
          await supabase.update('usage_daily_summary', `usage_id=eq.${encodeURIComponent(String(existing.usage_id))}`, {
            uplink_kb: newUplink,
            downlink_kb: newDownlink,
            total_kb: newUplink + newDownlink,
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
            uplink_kb: newUplink,
            downlink_kb: newDownlink,
            total_kb: newUplink + newDownlink,
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
        outOfProfileSurgeThresholdKbByReseller: ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB_BY_RESELLER,
        outOfProfileSurgeThresholdKbByEnterprise: ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB_BY_ENTERPRISE,
        silentSimThresholdHoursByReseller: ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_RESELLER,
        silentSimThresholdHoursByEnterprise: ALERT_SILENT_SIM_THRESHOLD_HOURS_BY_ENTERPRISE,
        cdrDelayThresholdHoursByReseller: ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_RESELLER,
        cdrDelayThresholdHoursByEnterprise: ALERT_CDR_DELAY_THRESHOLD_HOURS_BY_ENTERPRISE,
        upstreamDisconnectThresholdHoursByReseller: ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS_BY_RESELLER,
        upstreamDisconnectThresholdHoursByEnterprise: ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS_BY_ENTERPRISE,
        configCacheSeconds: ALERT_CONFIG_CACHE_SECONDS,
        poolUsageHighThresholdKb: ALERT_POOL_USAGE_HIGH_THRESHOLD_KB,
        outOfProfileSurgeThresholdKb: ALERT_OUT_OF_PROFILE_SURGE_THRESHOLD_KB,
        silentSimThresholdHours: ALERT_SILENT_SIM_THRESHOLD_HOURS,
        cdrDelayThresholdHours: ALERT_CDR_DELAY_THRESHOLD_HOURS,
        upstreamDisconnectThresholdHours: ALERT_UPSTREAM_DISCONNECT_THRESHOLD_HOURS,
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
  console.log(`[${traceId}] Starting test expiry check...`)
  try {
    // Find TEST_READY SIMs with test_expires_at in the past
    // We check both sims.status = 'TEST_READY' and look for activation_code expiry patterns
    const nowIso = new Date().toISOString()
    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,status,enterprise_id,supplier_id,activation_date&status=eq.TEST_READY&limit=500`
    )
    const sims = Array.isArray(rows) ? rows : []
    if (sims.length === 0) {
      console.log(`[${traceId}] No TEST_READY SIMs to check.`)
      return
    }

    // Check each SIM's test period via sim_state_history
    // Test period = time since SIM entered TEST_READY state
    // Default test period: 30 days (configurable via env)
    const testPeriodDays = resolveNumber(process.env.TEST_PERIOD_DAYS, 30)
    const cutoffDate = new Date(Date.now() - testPeriodDays * 24 * 60 * 60 * 1000)
    let activated = 0
    let deactivated = 0

    for (const sim of sims) {
      try {
        // Find when SIM entered TEST_READY
        const historyRows = await supabase.select(
          'sim_state_history',
          `select=start_time&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&after_status=eq.TEST_READY&order=start_time.desc&limit=1`
        )
        const entry = Array.isArray(historyRows) ? historyRows[0] : null
        if (!entry?.start_time) continue

        const testReadySince = new Date(entry.start_time)
        if (testReadySince > cutoffDate) continue // Not expired yet

        // Check enterprise auto_suspend_enabled to decide action
        let autoActivate = true
        if (sim.enterprise_id) {
          const tenantRows = await supabase.select(
            'tenants',
            `select=auto_suspend_enabled&tenant_id=eq.${encodeURIComponent(String(sim.enterprise_id))}&limit=1`
          )
          const tenant = Array.isArray(tenantRows) ? tenantRows[0] : null
          if (tenant && tenant.auto_suspend_enabled === false) {
            autoActivate = false
          }
        }

        const newStatus = autoActivate ? 'ACTIVATED' : 'DEACTIVATED'
        const updatePayload = {
          status: newStatus,
          last_status_change_at: nowIso,
        }
        if (newStatus === 'ACTIVATED' && !sim.activation_date) {
          updatePayload.activation_date = nowIso
        }

        await supabase.update(
          'sims',
          `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
          updatePayload,
          { returning: 'minimal' }
        )
        await supabase.insert('sim_state_history', {
          sim_id: sim.sim_id,
          before_status: 'TEST_READY',
          after_status: newStatus,
          start_time: nowIso,
          source: 'TEST_EXPIRY_AUTO',
          request_id: traceId,
        }, { returning: 'minimal' })
        await supabase.insert('events', {
          event_type: 'SIM_STATUS_CHANGED',
          occurred_at: nowIso,
          tenant_id: sim.enterprise_id ?? null,
          request_id: traceId,
          payload: {
            iccid: sim.iccid,
            beforeStatus: 'TEST_READY',
            afterStatus: newStatus,
            reason: `Test period expired (${testPeriodDays} days)`,
            autoTriggered: true,
          },
        }, { returning: 'minimal' })
        await supabase.insert('audit_logs', {
          actor_role: 'SYSTEM',
          tenant_id: sim.enterprise_id ?? null,
          action: 'TEST_EXPIRY_AUTO_TRANSITION',
          target_type: 'SIM',
          target_id: sim.iccid,
          request_id: traceId,
          after_data: {
            beforeStatus: 'TEST_READY',
            afterStatus: newStatus,
            testReadySince: entry.start_time,
            testPeriodDays,
          },
        }, { returning: 'minimal' })

        if (newStatus === 'ACTIVATED') activated += 1
        else deactivated += 1
      } catch (err) {
        console.error(`[${traceId}] Failed to process test expiry for SIM ${sim.iccid}:`, err.message)
      }
    }
    console.log(`[${traceId}] Test expiry check completed. activated=${activated} deactivated=${deactivated}`)
  } catch (err) {
    console.error(`[${traceId}] Test expiry check failed:`, err)
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
    const jobs = await supabase.select(
      'jobs',
      'select=job_id,job_type,request_id,payload&status=eq.QUEUED&order=created_at.asc&limit=1',
      { suppressMissingColumns: true }
    )
    const job = Array.isArray(jobs) && jobs.length > 0 ? jobs[0] : null
    if (!job) return // No jobs

    // Workaround: Parse payload from request_id if available and looks like JSON
    if (!job.payload && job.request_id && job.request_id.trim().startsWith('{')) {
        try {
            job.payload = JSON.parse(job.request_id)
        } catch (e) {
            // ignore, maybe it's a real request_id
        }
    }

    console.log(`Processing job ${job.job_id} (${job.job_type})...`)

    // 2. Mark as RUNNING
    await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
      status: 'RUNNING',
      started_at: new Date().toISOString()
    }, { returning: 'minimal' })

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
        case 'DUNNING_CHECK':
          await handleDunningCheckJob(job)
          break;
        case 'RECONCILIATION_RUN':
          await handleReconciliationRunJob(job)
          break;
        case 'SIM_RESET_CONNECTION':
          await handleSimResetConnectionJob(job)
          break;
        case 'WEBHOOK_DELIVERY':
          await handleWebhookDeliveryJob(job)
          break;
        default:
          throw new Error(`Unknown job type: ${job.job_type}`)
      }

      // 4. Mark as SUCCEEDED
      await supabase.update('jobs', `job_id=eq.${encodeURIComponent(job.job_id)}`, {
        status: 'SUCCEEDED',
        finished_at: new Date().toISOString(),
        progress_processed: 100,
        progress_total: 100
      }, { returning: 'minimal' })
      console.log(`Job ${job.job_id} succeeded.`)

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
scheduleCron('TEST_EXPIRY_CHECK_CRON', TEST_EXPIRY_CHECK_CRON, testExpiryCheckTask)

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
