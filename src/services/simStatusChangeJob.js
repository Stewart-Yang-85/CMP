/**
 * SIM_STATUS_CHANGE job accept + execute (spec US2 [V1.1]).
 * Plain JS so src/worker.js can import without TS runtime.
 */

import { emitEvent as defaultEmitEvent } from './eventEmitter.js'

const IN_PROGRESS_SUFFIX = 'ing'

export const LIFECYCLE_ACTIONS = {
  SIM_ACTIVATE: { apiAction: 'ACTIVATE', targetStatus: 'ACTIVATED', pending: 'activating', failed: 'activation_failed' },
  SIM_DEACTIVATE: { apiAction: 'DEACTIVATE', targetStatus: 'DEACTIVATED', pending: 'deactivating', failed: 'deactivation_failed' },
  SIM_REACTIVATE: { apiAction: 'REACTIVATE', targetStatus: 'ACTIVATED', pending: 'reactivating', failed: 'reactivation_failed' },
  SIM_RETIRE: { apiAction: 'RETIRE', targetStatus: 'RETIRED', pending: 'retiring', failed: 'retire_failed' },
}

export function resolveTransition(sourceAction, targetStatus) {
  const key = String(sourceAction || '').trim().toUpperCase()
  const direct = {
    SIM_ACTIVATE: LIFECYCLE_ACTIONS.SIM_ACTIVATE,
    ACTIVATE: LIFECYCLE_ACTIONS.SIM_ACTIVATE,
    SIM_DEACTIVATE: LIFECYCLE_ACTIONS.SIM_DEACTIVATE,
    DEACTIVATE: LIFECYCLE_ACTIONS.SIM_DEACTIVATE,
    SIM_REACTIVATE: LIFECYCLE_ACTIONS.SIM_REACTIVATE,
    REACTIVATE: LIFECYCLE_ACTIONS.SIM_REACTIVATE,
    SIM_RETIRE: LIFECYCLE_ACTIONS.SIM_RETIRE,
    RETIRE: LIFECYCLE_ACTIONS.SIM_RETIRE,
  }
  if (direct[key]) {
    return { ...direct[key], sourceAction: key }
  }
  const status = String(targetStatus || '').toUpperCase()
  if (status === 'ACTIVATED') {
    return { apiAction: 'ACTIVATE', targetStatus: 'ACTIVATED', pending: 'activating', failed: 'activation_failed', sourceAction: key }
  }
  if (status === 'DEACTIVATED') {
    return { apiAction: 'DEACTIVATE', targetStatus: 'DEACTIVATED', pending: 'deactivating', failed: 'deactivation_failed', sourceAction: key }
  }
  if (status === 'RETIRED') {
    return { apiAction: 'RETIRE', targetStatus: 'RETIRED', pending: 'retiring', failed: 'retire_failed', sourceAction: key }
  }
  return null
}

export function isLifecycleInProgress(lifecycleSubStatus) {
  const s = String(lifecycleSubStatus || 'normal')
  if (s === 'normal') return false
  return s.endsWith(IN_PROGRESS_SUFFIX)
}

export function isLifecycleFailed(lifecycleSubStatus) {
  const s = String(lifecycleSubStatus || 'normal')
  return s.endsWith('_failed')
}

function mapTargetToUpstreamMethod(targetStatus, adapter) {
  const t = String(targetStatus || '').toUpperCase()
  if (t === 'ACTIVATED') return 'activateSim'
  if (t === 'DEACTIVATED' || t === 'RETIRED') return 'suspendSim'
  return null
}

/**
 * Call supplier adapter; normalize to completed | pending | failed.
 */
export async function invokeUpstreamStatusChange({ adapter, iccid, targetStatus, idempotencyKey }) {
  const method = mapTargetToUpstreamMethod(targetStatus, adapter)
  if (!method || typeof adapter[method] !== 'function') {
    return { outcome: 'failed', message: `Unsupported target status: ${targetStatus}` }
  }
  const result = await adapter[method]({
    iccid,
    idempotencyKey: idempotencyKey || `sim-status-${iccid}-${Date.now()}`,
  })
  if (!result?.ok) {
    return { outcome: 'failed', message: result?.message || 'Upstream returned failure.' }
  }
  const st = String(result.status || '').toUpperCase()
  if (st === 'ACCEPTED') {
    return { outcome: 'pending', raw: result }
  }
  return { outcome: 'completed', raw: result }
}

async function emitJobFinished({ supabase, emitEvent, job, sim, transition, jobStatus, errorSummary, errorCode }) {
  const emit = emitEvent || defaultEmitEvent
  const beforeStatus = job.payload?.beforeStatus ?? sim.status
  await emit({
    eventType: 'JOB_FINISHED',
    enterpriseId: sim.enterprise_id ?? null,
    resellerId: sim.reseller_id ?? null,
    actorUserId: job.actor_user_id ?? null,
    requestId: job.request_id ?? null,
    jobId: job.job_id,
    payload: {
      jobId: job.job_id,
      jobType: 'SIM_STATUS_CHANGE',
      jobStatus,
      action: transition.apiAction,
      simId: sim.sim_id,
      iccid: sim.iccid,
      beforeStatus,
      targetStatus: transition.targetStatus,
      resultStatus: sim.status,
      lifecycleSubStatus: sim.lifecycle_sub_status || 'normal',
      errorCode: errorCode ?? null,
      errorSummary: errorSummary ?? null,
    },
  })
}

/**
 * Execute SIM_STATUS_CHANGE after accept (Worker).
 */
export async function processSimStatusChangeJob({
  supabase,
  job,
  adapter,
  emitEvent,
  finalizeSimStatusChange,
}) {
  const payload = job.payload || {}
  const simId = payload.simId ? String(payload.simId) : null
  const iccid = payload.iccid ? String(payload.iccid) : null
  const targetStatus = String(payload.afterStatus || payload.targetStatus || '').toUpperCase()
  const sourceAction = payload.action ? String(payload.action) : ''
  const transition = resolveTransition(sourceAction, targetStatus)
  if (!transition) {
    throw new Error('Unknown lifecycle action in job payload.')
  }

  const simRows = await supabase.select(
    'sims',
    `select=sim_id,iccid,status,lifecycle_sub_status,enterprise_id,reseller_id,supplier_id,activation_date&${
      simId ? `sim_id=eq.${encodeURIComponent(simId)}` : `iccid=eq.${encodeURIComponent(iccid)}`
    }&limit=1`
  )
  const sim = Array.isArray(simRows) ? simRows[0] : null
  if (!sim) {
    throw new Error('SIM not found for job.')
  }

  const idempotencyKey = payload.idempotencyKey ?? job.idempotency_key ?? null
  let upstream
  if (adapter) {
    upstream = await invokeUpstreamStatusChange({
      adapter,
      iccid: String(sim.iccid),
      targetStatus: transition.targetStatus,
      idempotencyKey,
    })
  } else {
    upstream = { outcome: 'completed' }
  }

  if (upstream.outcome === 'pending') {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(String(job.job_id))}`,
      {
        status: 'RUNNING',
        progress_processed: 0,
        progress_total: 1,
        error_summary: null,
      },
      { returning: 'minimal' }
    )
    return { ok: true, pending: true }
  }

  if (upstream.outcome === 'failed') {
    await supabase.update(
      'sims',
      `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
      { lifecycle_sub_status: transition.failed },
      { returning: 'minimal' }
    )
    const failedSim = { ...sim, lifecycle_sub_status: transition.failed }
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(String(job.job_id))}`,
      {
        status: 'FAILED',
        finished_at: new Date().toISOString(),
        progress_processed: 1,
        progress_total: 1,
        error_summary: String(upstream.message || 'Upstream failed.').slice(0, 1000),
      },
      { returning: 'minimal' }
    )
    await emitJobFinished({
      supabase,
      emitEvent,
      job,
      sim: failedSim,
      transition,
      jobStatus: 'FAILED',
      errorSummary: upstream.message,
      errorCode: 'UPSTREAM_FAILED',
    })
    return { ok: false, failed: true }
  }

  await finalizeSimStatusChange({
    supabase,
    sim,
    newStatus: transition.targetStatus,
    source: transition.sourceAction,
    requestId: job.request_id ?? null,
    reason: payload.reason ?? null,
    lifecycleSubStatus: 'normal',
    emitEvent,
    jobId: job.job_id,
  })

  await supabase.update(
    'jobs',
    `job_id=eq.${encodeURIComponent(String(job.job_id))}`,
    {
      status: 'SUCCEEDED',
      finished_at: new Date().toISOString(),
      progress_processed: 1,
      progress_total: 1,
      error_summary: null,
    },
    { returning: 'minimal' }
  )

  const completedSim = { ...sim, status: transition.targetStatus, lifecycle_sub_status: 'normal' }
  await emitJobFinished({
    supabase,
    emitEvent,
    job,
    sim: completedSim,
    transition,
    jobStatus: 'SUCCEEDED',
  })

  return { ok: true, succeeded: true }
}

export function buildLifecycleAcceptResponse({ jobId, jobStatus, sim, transition }) {
  return {
    jobId,
    job: {
      type: 'SIM_STATUS_CHANGE',
      status: jobStatus || 'QUEUED',
      progress: { processed: 0, total: 1 },
    },
    sim: {
      simId: sim.sim_id,
      iccid: sim.iccid,
      status: sim.status,
      lifecycleSubStatus: transition.pending,
      targetStatus: transition.targetStatus,
      action: transition.apiAction,
    },
    message: 'Lifecycle change accepted; awaiting upstream confirmation.',
  }
}
