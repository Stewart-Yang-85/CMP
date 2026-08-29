/**
 * SUBSCRIPTION_PROVISION job — upstream changePlan + local subscription lifecycle (Phase 36).
 */

import { emitEvent as defaultEmitEvent } from './eventEmitter.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'
import { createSupplierAdapter, negotiateChangePlanStrategy } from '../vendors/registry.js'

export const SUBSCRIPTION_PROVISION_JOB_TYPE = 'SUBSCRIPTION_PROVISION'

function extractMissingColumn(err) {
  const body = String(err?.body || err?.message || '')
  let match = body.match(/'([^']+)' column/)
  if (match) return match[1]
  match = body.match(/column [^.]+\.([a-zA-Z0-9_]+)/)
  if (match) return match[1]
  return null
}

async function insertJobWithFallback(supabase, payload) {
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

/**
 * Queue SUBSCRIPTION_PROVISION after API accepts a subscription row.
 */
export async function enqueueSubscriptionProvisionJob({
  supabase,
  subscriptionId,
  enterpriseId,
  iccid,
  packageId,
  externalProductId,
  effectiveAt,
  beforeState,
  audit,
  idempotencyKey,
}) {
  const jobRows = await insertJobWithFallback(supabase, {
    job_type: SUBSCRIPTION_PROVISION_JOB_TYPE,
    status: 'QUEUED',
    progress_processed: 0,
    progress_total: 1,
    request_id: audit?.requestId ?? null,
    idempotency_key: idempotencyKey ?? null,
    actor_user_id: actorUserIdForDb(audit?.actorUserId),
    enterprise_id: enterpriseId ?? null,
    payload: {
      subscriptionId,
      enterpriseId,
      iccid,
      packageId,
      externalProductId,
      effectiveAt,
      beforeState,
      idempotencyKey: idempotencyKey ?? null,
    },
  })
  const job = Array.isArray(jobRows) ? jobRows[0] : null
  return job?.job_id ? String(job.job_id) : null
}

function parsePayload(job) {
  let payload = job?.payload
  if (!payload && job?.request_id && String(job.request_id).trim().startsWith('{')) {
    try {
      payload = JSON.parse(job.request_id)
    } catch {
      payload = null
    }
  }
  return payload && typeof payload === 'object' ? payload : {}
}

async function emitJobFinished({ emitEvent, job, payload, jobStatus, errorSummary, errorCode, sim, subscriptionId }) {
  const emit = emitEvent || defaultEmitEvent
  await emit({
    eventType: 'JOB_FINISHED',
    enterpriseId: payload.enterpriseId ?? sim?.enterprise_id ?? null,
    resellerId: sim?.reseller_id ?? null,
    actorUserId: job.actor_user_id ?? null,
    requestId: job.request_id ?? null,
    jobId: job.job_id,
    payload: {
      jobId: job.job_id,
      jobType: SUBSCRIPTION_PROVISION_JOB_TYPE,
      jobStatus,
      subscriptionId: subscriptionId ?? payload.subscriptionId ?? null,
      iccid: payload.iccid ?? sim?.iccid ?? null,
      packageId: payload.packageId ?? null,
      errorCode: errorCode ?? null,
      errorSummary: errorSummary ?? null,
    },
  })
}

async function emitProvisionFailed({ emitEvent, job, payload, sim, errorSummary, errorCode }) {
  const emit = emitEvent || defaultEmitEvent
  await emit({
    eventType: 'SUBSCRIPTION_PROVISION_FAILED',
    enterpriseId: payload.enterpriseId ?? sim?.enterprise_id ?? null,
    resellerId: sim?.reseller_id ?? null,
    actorUserId: job.actor_user_id ?? null,
    requestId: job.request_id ?? null,
    jobId: job.job_id,
    payload: {
      subscriptionId: payload.subscriptionId ?? null,
      iccid: payload.iccid ?? sim?.iccid ?? null,
      packageId: payload.packageId ?? null,
      externalProductId: payload.externalProductId ?? null,
      errorCode: errorCode ?? 'UPSTREAM_ERROR',
      errorSummary: errorSummary ?? 'Upstream subscription provision failed.',
    },
  })
}

async function emitSubscriptionActive({ emitEvent, job, payload, sim, subscriptionRow }) {
  const emit = emitEvent || defaultEmitEvent
  await emit({
    eventType: 'SUBSCRIPTION_CHANGED',
    enterpriseId: payload.enterpriseId ?? sim?.enterprise_id ?? null,
    resellerId: sim?.reseller_id ?? null,
    actorUserId: job.actor_user_id ?? null,
    requestId: job.request_id ?? null,
    jobId: job.job_id,
    payload: {
      subscriptionId: payload.subscriptionId ?? subscriptionRow?.subscription_id ?? null,
      iccid: payload.iccid ?? sim?.iccid ?? null,
      packageId: payload.packageId ?? null,
      beforeState: payload.beforeState ?? 'PROVISIONING',
      afterState: 'ACTIVE',
      effectiveAt: subscriptionRow?.effective_at ?? payload.effectiveAt ?? null,
    },
  })
}

/**
 * Execute SUBSCRIPTION_PROVISION job (Worker).
 * @returns {{ pending?: boolean }}
 */
export async function processSubscriptionProvisionJob({
  supabase,
  job,
  emitEvent,
}) {
  const payload = parsePayload(job)
  const subscriptionId = String(payload.subscriptionId || '').trim()
  const iccid = String(payload.iccid || '').trim()
  const effectiveAtIso = payload.effectiveAt ? String(payload.effectiveAt) : null
  const effectiveAt = effectiveAtIso ? new Date(effectiveAtIso) : null

  if (effectiveAt && Number.isFinite(effectiveAt.getTime()) && effectiveAt.getTime() > Date.now()) {
    return { pending: true }
  }

  const subRows = subscriptionId
    ? await supabase.select(
        'subscriptions',
        `select=subscription_id,state,effective_at,enterprise_id,sim_id,package_id&subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`
      )
    : []
  const subscriptionRow = Array.isArray(subRows) ? subRows[0] : null
  if (!subscriptionRow?.subscription_id) {
    const msg = 'Subscription row not found (may have been cancelled).'
    await emitJobFinished({
      emitEvent,
      job,
      payload,
      jobStatus: 'FAILED',
      errorSummary: msg,
      errorCode: 'SUBSCRIPTION_NOT_FOUND',
      sim: null,
      subscriptionId,
    })
    return { failed: true, errorSummary: msg, errorCode: 'SUBSCRIPTION_NOT_FOUND' }
  }

  const state = String(subscriptionRow.state || '').toUpperCase()
  if (state !== 'PROVISIONING' && state !== 'PENDING') {
    await emitJobFinished({
      emitEvent,
      job,
      payload,
      jobStatus: 'SUCCEEDED',
      sim: null,
      subscriptionId,
    })
    return { ok: true }
  }

  if (state === 'PENDING') {
    await supabase.update(
      'subscriptions',
      `subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
      { state: 'PROVISIONING' },
      { returning: 'minimal' }
    )
  }

  const simRows = iccid
    ? await supabase.select(
        'sims',
        `select=sim_id,iccid,enterprise_id,reseller_id,supplier_id,operator_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      )
    : subscriptionRow.sim_id
      ? await supabase.select(
          'sims',
          `select=sim_id,iccid,enterprise_id,reseller_id,supplier_id,operator_id&sim_id=eq.${encodeURIComponent(String(subscriptionRow.sim_id))}&limit=1`
        )
      : []
  const sim = Array.isArray(simRows) ? simRows[0] : null
  if (!sim?.iccid) {
    return failProvision({
      supabase,
      emitEvent,
      job,
      payload,
      sim: null,
      subscriptionId,
      errorCode: 'SIM_NOT_FOUND',
      errorSummary: 'SIM not found for subscription provision job.',
    })
  }

  const externalProductId = String(payload.externalProductId || '').trim()
  if (!externalProductId) {
    return failProvision({
      supabase,
      emitEvent,
      job,
      payload,
      sim,
      subscriptionId,
      errorCode: 'VENDOR_PRODUCT_MAPPING_NOT_FOUND',
      errorSummary: 'externalProductId missing on job payload.',
    })
  }

  let adapter
  try {
    adapter = await createSupplierAdapter({
      supabase,
      supplierId: sim.supplier_id,
      operatorId: sim.operator_id,
    })
  } catch {
    return failProvision({
      supabase,
      emitEvent,
      job,
      payload,
      sim,
      subscriptionId,
      errorCode: 'SUPPLIER_ADAPTER_NOT_FOUND',
      errorSummary: 'Supplier adapter not found.',
    })
  }

  const strategy = negotiateChangePlanStrategy({
    adapter,
    effectiveAt: effectiveAtIso,
  })

  if (strategy.mode !== 'UPSTREAM') {
    await completeProvision({
      supabase,
      emitEvent,
      job,
      payload,
      sim,
      subscriptionId,
      subscriptionRow,
      vendorRequestId: null,
    })
    return { ok: true }
  }

  let changeResult
  try {
    changeResult = await adapter.changePlan({
      iccid: sim.iccid,
      externalProductId,
      effectiveAt: effectiveAtIso,
      idempotencyKey: payload.idempotencyKey || `sub-provision:${subscriptionId}`,
    })
  } catch (err) {
    return failProvision({
      supabase,
      emitEvent,
      job,
      payload,
      sim,
      subscriptionId,
      errorCode: 'UPSTREAM_ERROR',
      errorSummary: String(err?.message || 'Upstream changePlan threw.'),
    })
  }

  if (!changeResult?.ok) {
    return failProvision({
      supabase,
      emitEvent,
      job,
      payload,
      sim,
      subscriptionId,
      errorCode: 'UPSTREAM_ERROR',
      errorSummary: changeResult?.message || 'Upstream changePlan failed.',
    })
  }

  const upstreamStatus = String(changeResult.status || '').toUpperCase()
  if (upstreamStatus === 'ACCEPTED') {
    return { pending: true }
  }

  await completeProvision({
    supabase,
    emitEvent,
    job,
    payload,
    sim,
    subscriptionId,
    subscriptionRow,
    vendorRequestId: changeResult.vendorRequestId ?? null,
  })
  return { ok: true }
}

async function completeProvision({
  supabase,
  emitEvent,
  job,
  payload,
  sim,
  subscriptionId,
  subscriptionRow,
  vendorRequestId,
}) {
  const nowIso = new Date().toISOString()
  await supabase.update(
    'subscriptions',
    `subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
    { state: 'ACTIVE' },
    { returning: 'minimal' }
  )
  const refreshed = { ...subscriptionRow, state: 'ACTIVE' }
  await emitSubscriptionActive({ emitEvent, job, payload, sim, subscriptionRow: refreshed })
  await emitJobFinished({
    emitEvent,
    job,
    payload: { ...payload, vendorRequestId, completedAt: nowIso },
    jobStatus: 'SUCCEEDED',
    sim,
    subscriptionId,
  })

  const simId = String(sim?.sim_id || subscriptionRow?.sim_id || '').trim()
  if (simId) {
    try {
      const { maybeActivateSimWhenSoleActiveSubscription } = await import('./subscriptionSimCoupling.js')
      await maybeActivateSimWhenSoleActiveSubscription({
        supabase,
        simId,
        requestId: job.request_id ?? null,
        reason: 'SUBSCRIPTION_BECAME_ACTIVE_SOLE',
      })
    } catch (err) {
      console.warn(
        `[SUBSCRIPTION_PROVISION] SIM activate coupling skipped for ${subscriptionId}:`,
        err?.message || err
      )
    }
  }
}

async function failProvision({
  supabase,
  emitEvent,
  job,
  payload,
  sim,
  subscriptionId,
  errorCode,
  errorSummary,
}) {
  if (subscriptionId) {
    try {
      await supabase.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(subscriptionId)}`)
    } catch {
      /* best effort */
    }
  }
  await supabase.insert(
    'audit_logs',
    {
      actor_user_id: job.actor_user_id ?? null,
      actor_role: null,
      tenant_id: payload.enterpriseId ?? sim?.enterprise_id ?? null,
      action: 'SUBSCRIPTION_PROVISION_FAILED',
      target_type: 'SUBSCRIPTION',
      target_id: subscriptionId,
      request_id: job.request_id ?? null,
      after_data: {
        iccid: payload.iccid ?? sim?.iccid ?? null,
        packageId: payload.packageId ?? null,
        errorCode,
        errorSummary,
      },
    },
    { returning: 'minimal' }
  )
  await emitProvisionFailed({ emitEvent, job, payload, sim, errorSummary, errorCode })
  await emitJobFinished({
    emitEvent,
    job,
    payload,
    jobStatus: 'FAILED',
    errorSummary,
    errorCode,
    sim,
    subscriptionId,
  })
  return { failed: true, errorSummary, errorCode }
}
