function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function normalizeIccid(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isValidIccid(value) {
  const s = normalizeIccid(value)
  return /^\d{18,20}$/.test(s)
}

function toError(status, code, message) {
  return { ok: false, status, code, message }
}

const batchErrorCodes = {
  INVALID_SIM_ID: 'INVALID_SIM_ID',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  ENTERPRISE_INACTIVE: 'ENTERPRISE_INACTIVE',
  COMMITMENT_NOT_MET: 'COMMITMENT_NOT_MET',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
}

async function insertBatchEvent({ supabase, eventType, tenantId, requestId, payload }) {
  await supabase.insert('events', {
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    tenant_id: tenantId ?? null,
    request_id: requestId ?? null,
    payload,
  }, { returning: 'minimal' })
}

export function parseSimIdentifier(value) {
  const s = String(value || '').trim()
  if (!s) {
    return toError(400, 'BAD_REQUEST', 'simId is required.')
  }
  if (isValidUuid(s)) return { ok: true, field: 'sim_id', value: s }
  const iccid = normalizeIccid(s)
  if (!iccid || !isValidIccid(iccid)) {
    return toError(400, 'BAD_REQUEST', 'simId must be a valid uuid or 18-20 digit iccid.')
  }
  return { ok: true, field: 'iccid', value: iccid }
}

export async function loadSim(supabase, idField, idValue, tenantQs) {
  const rows = await supabase.select(
    'sims',
    `select=sim_id,iccid,primary_imsi,msisdn,status,apn,activation_date,bound_imei,form_factor,activation_code,upstream_status,upstream_status_updated_at,supplier_id,operator_id,enterprise_id,department_id,created_at&${idField}=eq.${encodeURIComponent(idValue)}${tenantQs}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function updateSimStatus({ supabase, sim, newStatus, source, requestId, reason, actorRole, sourceIp, emitEvent = true }) {
  const nowIso = new Date().toISOString()
  const update = {
    status: newStatus,
    last_status_change_at: nowIso,
  }
  if (newStatus === 'ACTIVATED' && !sim.activation_date) {
    update.activation_date = nowIso
  }
  await supabase.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, update, { returning: 'minimal' })
  await supabase.insert('sim_state_history', {
    sim_id: sim.sim_id,
    before_status: sim.status,
    after_status: newStatus,
    start_time: nowIso,
    source,
    request_id: requestId,
  }, { returning: 'minimal' })
  if (emitEvent) {
    await supabase.insert('events', {
      event_type: 'SIM_STATUS_CHANGED',
      occurred_at: nowIso,
      tenant_id: sim.enterprise_id ?? null,
      request_id: requestId,
      payload: {
        iccid: sim.iccid,
        beforeStatus: sim.status,
        afterStatus: newStatus,
        reason,
      },
    }, { returning: 'minimal' })
  }
  await supabase.insert('audit_logs', {
    actor_role: actorRole,
    tenant_id: sim.enterprise_id ?? null,
    action: source,
    target_type: 'SIM',
    target_id: sim.iccid,
    request_id: requestId,
    source_ip: sourceIp,
    after_data: { beforeStatus: sim.status, afterStatus: newStatus, reason },
  }, { returning: 'minimal' })
  return nowIso
}

async function findIdempotentJobByKey(supabase, jobType, idempotencyKey) {
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

async function findCommitmentBlockUntil(supabase, simId) {
  const subs = await supabase.select(
    'subscriptions',
    `select=commitment_end_at&sim_id=eq.${encodeURIComponent(simId)}`
  )
  let thresholdIso = null
  if (Array.isArray(subs)) {
    for (const s of subs) {
      const c = s?.commitment_end_at ? new Date(s.commitment_end_at).toISOString() : null
      if (c && (!thresholdIso || new Date(c).getTime() > new Date(thresholdIso).getTime())) {
        thresholdIso = c
      }
    }
  }
  if (!thresholdIso) return null
  if (Date.now() <= new Date(thresholdIso).getTime()) {
    return thresholdIso
  }
  return null
}

async function loadEnterpriseStatus(supabase, enterpriseId) {
  if (!enterpriseId) return null
  const rows = await supabase.select(
    'tenants',
    `select=enterprise_status&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row?.enterprise_status ? String(row.enterprise_status) : null
}

export async function fetchSimStateHistory({ supabase, simIdentifier, tenantQs, page, limit }) {
  const sim = await loadSim(supabase, simIdentifier.field, simIdentifier.value, tenantQs)
  if (!sim) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  }
  const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
  const { data, total } = await supabase.selectWithCount(
    'sim_state_history',
    `select=before_status,after_status,start_time,source,request_id&sim_id=eq.${encodeURIComponent(sim.sim_id)}&order=start_time.desc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
  )
  const rows = Array.isArray(data) ? data : []
  return {
    ok: true,
    sim,
    page,
    pageSize: limit,
    total: Number(total ?? rows.length),
    items: rows.map((r) => ({
      beforeStatus: r.before_status,
      afterStatus: r.after_status,
      startTime: r.start_time ? new Date(r.start_time).toISOString() : null,
      source: r.source,
      requestId: r.request_id ?? null,
    })),
  }
}

export async function changeSimStatus({
  supabase,
  simIdentifier,
  tenantQs,
  action,
  newStatus,
  allowedFrom,
  reason,
  idempotencyKey,
  actor,
  traceId,
  sourceIp,
  pushSimStatusToUpstream,
  commitmentExempt,
}) {
  const sim = await loadSim(supabase, simIdentifier.field, simIdentifier.value, tenantQs)
  if (!sim) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  }
  if (!allowedFrom.has(sim.status)) {
    return toError(409, 'INVALID_STATE', `sim status ${sim.status} cannot transition to ${newStatus}.`)
  }
  if (newStatus === 'ACTIVATED') {
    const enterpriseStatus = await loadEnterpriseStatus(supabase, sim.enterprise_id)
    if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
      return toError(409, 'ENTERPRISE_INACTIVE', 'Enterprise must be ACTIVE before activating SIM.')
    }
  }
  if (newStatus === 'RETIRED' && !commitmentExempt) {
    const blockedUntil = await findCommitmentBlockUntil(supabase, sim.sim_id)
    if (blockedUntil) {
      return toError(400, 'COMMITMENT_NOT_MET', `Retire blocked until ${blockedUntil}.`)
    }
  }
  if (idempotencyKey) {
    const existing = await findIdempotentJobByKey(supabase, 'SIM_STATUS_CHANGE', String(idempotencyKey))
    if (existing) {
      return {
        ok: true,
        idempotent: true,
        jobId: existing.job_id,
        status: existing.status,
        progress: {
          processed: existing.progress_processed ?? 0,
          total: existing.progress_total ?? 1,
        },
      }
    }
  }
  const jobRows = await insertJobWithFallback(supabase, {
    job_type: 'SIM_STATUS_CHANGE',
    status: 'QUEUED',
    progress_processed: 0,
    progress_total: 1,
    request_id: traceId ?? null,
    idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
    actor_user_id: actor?.userId ?? null,
    reseller_id: actor?.resellerId ?? null,
    customer_id: sim.enterprise_id ?? null,
    payload: {
      action,
      simId: sim.sim_id,
      iccid: sim.iccid,
      beforeStatus: sim.status,
      afterStatus: newStatus,
      reason: reason ?? null,
    },
  })
  const job = Array.isArray(jobRows) ? jobRows[0] : null
  const jobId = job?.job_id ?? null
  let succeeded = true
  try {
    await updateSimStatus({
      supabase,
      sim,
      newStatus,
      source: action,
      requestId: traceId ?? null,
      reason: reason ?? null,
      actorRole: actor?.role ?? actor?.roleScope ?? null,
      sourceIp,
    })
    if (pushSimStatusToUpstream) {
      await pushSimStatusToUpstream({
        iccid: sim.iccid,
        status: newStatus,
        traceId,
        supplierId: sim.supplier_id ? String(sim.supplier_id) : null,
      })
    }
  } catch {
    succeeded = false
  }
  if (jobId) {
    await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
      status: succeeded ? 'SUCCEEDED' : 'FAILED',
      progress_processed: 1,
      progress_total: 1,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error_summary: succeeded ? null : 'SIM status change failed.',
    }, { returning: 'minimal' })
  }
  if (!succeeded) {
    return toError(500, 'INTERNAL_ERROR', 'SIM status change failed.')
  }
  return { ok: true, jobId, status: 'QUEUED' }
}

export async function batchChangeSimStatus({
  supabase,
  simIds,
  tenantQs,
  enterpriseId,
  action,
  reason,
  actor,
  traceId,
  sourceIp,
  pushSimStatusToUpstream,
  commitmentExempt,
}) {
  const actionValue = String(action || '').trim().toUpperCase()
  const actionMap = {
    ACTIVATE: { targetStatus: 'ACTIVATED', allowedFrom: new Set(['INVENTORY', 'TEST_READY', 'DEACTIVATED']), requireReason: false },
    DEACTIVATE: { targetStatus: 'DEACTIVATED', allowedFrom: new Set(['ACTIVATED', 'TEST_READY']), requireReason: true },
    REACTIVATE: { targetStatus: 'ACTIVATED', allowedFrom: new Set(['DEACTIVATED']), requireReason: false },
    RETIRE: { targetStatus: 'RETIRED', allowedFrom: new Set(['DEACTIVATED']), requireReason: true },
  }
  const policy = actionMap[actionValue]
  if (!policy) {
    return toError(400, 'BAD_REQUEST', 'action must be one of ACTIVATE, DEACTIVATE, REACTIVATE, RETIRE.')
  }
  if (policy.requireReason && !reason) {
    return toError(400, 'BAD_REQUEST', 'reason is required.')
  }
  if (!Array.isArray(simIds) || simIds.length === 0) {
    return toError(400, 'BAD_REQUEST', 'simIds must be a non-empty array.')
  }
  if (simIds.length > 100) {
    return toError(400, 'BAD_REQUEST', 'simIds must not exceed 100 items.')
  }
  const results = []
  let succeeded = 0
  let failed = 0
  let idempotentCount = 0
  for (const raw of simIds) {
    const simValue = String(raw || '').trim()
    const simIdentifier = parseSimIdentifier(simValue)
    if (!simIdentifier.ok) {
      const errorCode = simIdentifier.code === 'BAD_REQUEST' ? batchErrorCodes.INVALID_SIM_ID : simIdentifier.code
      results.push({
        input: simValue,
        ok: false,
        errorCode,
        errorMessage: simIdentifier.message,
      })
      failed += 1
      await supabase.insert('audit_logs', {
        actor_user_id: actor?.userId ?? null,
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        tenant_id: null,
        action: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        target_type: 'SIM',
        target_id: simValue,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        before_data: {
          input: simValue,
          action: actionValue,
          targetStatus: policy.targetStatus,
          reason: reason ?? null,
          commitmentExempt: commitmentExempt ?? false,
        },
        after_data: {
          action: actionValue,
          targetStatus: policy.targetStatus,
          result: 'FAILED',
          errorCode,
          errorMessage: simIdentifier.message,
        },
      }, { returning: 'minimal' })
      await insertBatchEvent({
        supabase,
        eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        tenantId: null,
        requestId: traceId ?? null,
        payload: {
          beforeData: {
            input: simValue,
            action: actionValue,
            targetStatus: policy.targetStatus,
            reason: reason ?? null,
            commitmentExempt: commitmentExempt ?? false,
          },
          afterData: {
            action: actionValue,
            targetStatus: policy.targetStatus,
            result: 'FAILED',
            errorCode,
            errorMessage: simIdentifier.message,
          },
        },
      })
      continue
    }
    const sim = await loadSim(supabase, simIdentifier.field, simIdentifier.value, tenantQs)
    if (!sim) {
      results.push({
        input: simValue,
        ok: false,
        errorCode: batchErrorCodes.RESOURCE_NOT_FOUND,
        errorMessage: 'sim not found.',
      })
      failed += 1
      await supabase.insert('audit_logs', {
        actor_user_id: actor?.userId ?? null,
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        tenant_id: null,
        action: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        target_type: 'SIM',
        target_id: simValue,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        before_data: {
          input: simValue,
          action: actionValue,
          targetStatus: policy.targetStatus,
          reason: reason ?? null,
          commitmentExempt: commitmentExempt ?? false,
        },
        after_data: {
          action: actionValue,
          targetStatus: policy.targetStatus,
          result: 'FAILED',
          errorCode: batchErrorCodes.RESOURCE_NOT_FOUND,
          errorMessage: 'sim not found.',
        },
      }, { returning: 'minimal' })
      await insertBatchEvent({
        supabase,
        eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        tenantId: null,
        requestId: traceId ?? null,
        payload: {
          beforeData: {
            input: simValue,
            action: actionValue,
            targetStatus: policy.targetStatus,
            reason: reason ?? null,
            commitmentExempt: commitmentExempt ?? false,
          },
          afterData: {
            action: actionValue,
            targetStatus: policy.targetStatus,
            result: 'FAILED',
            errorCode: batchErrorCodes.RESOURCE_NOT_FOUND,
            errorMessage: 'sim not found.',
          },
        },
      })
      continue
    }
    if (String(sim.status) === policy.targetStatus) {
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: true,
        idempotent: true,
        beforeStatus: sim.status,
        afterStatus: policy.targetStatus,
      })
      succeeded += 1
      idempotentCount += 1
      await supabase.insert('audit_logs', {
        actor_user_id: actor?.userId ?? null,
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        tenant_id: sim.enterprise_id ?? null,
        action: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        target_type: 'SIM',
        target_id: sim.iccid,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        before_data: {
          input: simValue,
          simId: sim.sim_id,
          iccid: sim.iccid,
          beforeStatus: sim.status,
          action: actionValue,
          targetStatus: policy.targetStatus,
          reason: reason ?? null,
          commitmentExempt: commitmentExempt ?? false,
        },
        after_data: {
          action: actionValue,
          targetStatus: policy.targetStatus,
          result: 'SUCCEEDED',
          idempotent: true,
          beforeStatus: sim.status,
          afterStatus: policy.targetStatus,
        },
      }, { returning: 'minimal' })
      await insertBatchEvent({
        supabase,
        eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        tenantId: sim.enterprise_id ?? null,
        requestId: traceId ?? null,
        payload: {
          beforeData: {
            input: simValue,
            simId: sim.sim_id,
            iccid: sim.iccid,
            beforeStatus: sim.status,
            action: actionValue,
            targetStatus: policy.targetStatus,
            reason: reason ?? null,
            commitmentExempt: commitmentExempt ?? false,
          },
          afterData: {
            action: actionValue,
            targetStatus: policy.targetStatus,
            result: 'SUCCEEDED',
            idempotent: true,
            beforeStatus: sim.status,
            afterStatus: policy.targetStatus,
          },
        },
      })
      continue
    }
    if (!policy.allowedFrom.has(String(sim.status))) {
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: false,
        errorCode: batchErrorCodes.INVALID_STATE,
        errorMessage: `sim status ${sim.status} cannot transition to ${policy.targetStatus}.`,
        beforeStatus: sim.status,
        afterStatus: policy.targetStatus,
      })
      failed += 1
      await supabase.insert('audit_logs', {
        actor_user_id: actor?.userId ?? null,
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        tenant_id: sim.enterprise_id ?? null,
        action: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        target_type: 'SIM',
        target_id: sim.iccid,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        before_data: {
          input: simValue,
          simId: sim.sim_id,
          iccid: sim.iccid,
          beforeStatus: sim.status,
          action: actionValue,
          targetStatus: policy.targetStatus,
          reason: reason ?? null,
          commitmentExempt: commitmentExempt ?? false,
        },
        after_data: {
          action: actionValue,
          targetStatus: policy.targetStatus,
          result: 'FAILED',
          errorCode: batchErrorCodes.INVALID_STATE,
          errorMessage: `sim status ${sim.status} cannot transition to ${policy.targetStatus}.`,
          beforeStatus: sim.status,
          afterStatus: policy.targetStatus,
        },
      }, { returning: 'minimal' })
      await insertBatchEvent({
        supabase,
        eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        tenantId: sim.enterprise_id ?? null,
        requestId: traceId ?? null,
        payload: {
          beforeData: {
            input: simValue,
            simId: sim.sim_id,
            iccid: sim.iccid,
            beforeStatus: sim.status,
            action: actionValue,
            targetStatus: policy.targetStatus,
            reason: reason ?? null,
            commitmentExempt: commitmentExempt ?? false,
          },
          afterData: {
            action: actionValue,
            targetStatus: policy.targetStatus,
            result: 'FAILED',
            errorCode: batchErrorCodes.INVALID_STATE,
            errorMessage: `sim status ${sim.status} cannot transition to ${policy.targetStatus}.`,
            beforeStatus: sim.status,
            afterStatus: policy.targetStatus,
          },
        },
      })
      continue
    }
    if (policy.targetStatus === 'ACTIVATED') {
      const enterpriseStatus = await loadEnterpriseStatus(supabase, sim.enterprise_id)
      if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
        results.push({
          simId: sim.sim_id,
          iccid: sim.iccid,
          ok: false,
          errorCode: batchErrorCodes.ENTERPRISE_INACTIVE,
          errorMessage: 'Enterprise must be ACTIVE before activating SIM.',
          beforeStatus: sim.status,
          afterStatus: policy.targetStatus,
        })
        failed += 1
        await supabase.insert('audit_logs', {
          actor_user_id: actor?.userId ?? null,
          actor_role: actor?.role ?? actor?.roleScope ?? null,
          tenant_id: sim.enterprise_id ?? null,
          action: 'SIM_BATCH_STATUS_CHANGE_RESULT',
          target_type: 'SIM',
          target_id: sim.iccid,
          request_id: traceId ?? null,
          source_ip: sourceIp ?? null,
          before_data: {
            input: simValue,
            simId: sim.sim_id,
            iccid: sim.iccid,
            beforeStatus: sim.status,
            action: actionValue,
            targetStatus: policy.targetStatus,
            reason: reason ?? null,
            commitmentExempt: commitmentExempt ?? false,
          },
          after_data: {
            action: actionValue,
            targetStatus: policy.targetStatus,
            result: 'FAILED',
            errorCode: batchErrorCodes.ENTERPRISE_INACTIVE,
            errorMessage: 'Enterprise must be ACTIVE before activating SIM.',
            beforeStatus: sim.status,
            afterStatus: policy.targetStatus,
          },
        }, { returning: 'minimal' })
        await insertBatchEvent({
          supabase,
          eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
          tenantId: sim.enterprise_id ?? null,
          requestId: traceId ?? null,
          payload: {
            beforeData: {
              input: simValue,
              simId: sim.sim_id,
              iccid: sim.iccid,
              beforeStatus: sim.status,
              action: actionValue,
              targetStatus: policy.targetStatus,
              reason: reason ?? null,
              commitmentExempt: commitmentExempt ?? false,
            },
            afterData: {
              action: actionValue,
              targetStatus: policy.targetStatus,
              result: 'FAILED',
              errorCode: batchErrorCodes.ENTERPRISE_INACTIVE,
              errorMessage: 'Enterprise must be ACTIVE before activating SIM.',
              beforeStatus: sim.status,
              afterStatus: policy.targetStatus,
            },
          },
        })
        continue
      }
    }
    if (policy.targetStatus === 'RETIRED' && !commitmentExempt) {
      const blockedUntil = await findCommitmentBlockUntil(supabase, sim.sim_id)
      if (blockedUntil) {
        results.push({
          simId: sim.sim_id,
          iccid: sim.iccid,
          ok: false,
          errorCode: batchErrorCodes.COMMITMENT_NOT_MET,
          errorMessage: `Retire blocked until ${blockedUntil}.`,
          beforeStatus: sim.status,
          afterStatus: policy.targetStatus,
        })
        failed += 1
        await supabase.insert('audit_logs', {
          actor_user_id: actor?.userId ?? null,
          actor_role: actor?.role ?? actor?.roleScope ?? null,
          tenant_id: sim.enterprise_id ?? null,
          action: 'SIM_BATCH_STATUS_CHANGE_RESULT',
          target_type: 'SIM',
          target_id: sim.iccid,
          request_id: traceId ?? null,
          source_ip: sourceIp ?? null,
          before_data: {
            input: simValue,
            simId: sim.sim_id,
            iccid: sim.iccid,
            beforeStatus: sim.status,
            action: actionValue,
            targetStatus: policy.targetStatus,
            reason: reason ?? null,
            commitmentExempt: commitmentExempt ?? false,
          },
          after_data: {
            action: actionValue,
            targetStatus: policy.targetStatus,
            result: 'FAILED',
            errorCode: batchErrorCodes.COMMITMENT_NOT_MET,
            errorMessage: `Retire blocked until ${blockedUntil}.`,
            beforeStatus: sim.status,
            afterStatus: policy.targetStatus,
          },
        }, { returning: 'minimal' })
        await insertBatchEvent({
          supabase,
          eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
          tenantId: sim.enterprise_id ?? null,
          requestId: traceId ?? null,
          payload: {
            beforeData: {
              input: simValue,
              simId: sim.sim_id,
              iccid: sim.iccid,
              beforeStatus: sim.status,
              action: actionValue,
              targetStatus: policy.targetStatus,
              reason: reason ?? null,
              commitmentExempt: commitmentExempt ?? false,
            },
            afterData: {
              action: actionValue,
              targetStatus: policy.targetStatus,
              result: 'FAILED',
              errorCode: batchErrorCodes.COMMITMENT_NOT_MET,
              errorMessage: `Retire blocked until ${blockedUntil}.`,
              beforeStatus: sim.status,
              afterStatus: policy.targetStatus,
            },
          },
        })
        continue
      }
    }
    let ok = true
    try {
      await updateSimStatus({
        supabase,
        sim,
        newStatus: policy.targetStatus,
        source: `SIM_BATCH_${actionValue}`,
        requestId: traceId ?? null,
        reason: reason ?? null,
        actorRole: actor?.role ?? actor?.roleScope ?? null,
        sourceIp,
        emitEvent: false,
      })
      if (pushSimStatusToUpstream) {
        await pushSimStatusToUpstream({
          iccid: sim.iccid,
          status: policy.targetStatus,
          traceId,
          supplierId: sim.supplier_id ? String(sim.supplier_id) : null,
        })
      }
    } catch {
      ok = false
    }
    if (ok) {
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: true,
        beforeStatus: sim.status,
        afterStatus: policy.targetStatus,
      })
      succeeded += 1
    } else {
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: false,
        errorCode: batchErrorCodes.INTERNAL_ERROR,
        errorMessage: 'SIM status change failed.',
        beforeStatus: sim.status,
        afterStatus: policy.targetStatus,
      })
      failed += 1
    }
    await supabase.insert('audit_logs', {
      actor_user_id: actor?.userId ?? null,
      actor_role: actor?.role ?? actor?.roleScope ?? null,
      tenant_id: sim.enterprise_id ?? null,
      action: 'SIM_BATCH_STATUS_CHANGE_RESULT',
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: traceId ?? null,
      source_ip: sourceIp ?? null,
      before_data: {
        input: simValue,
        simId: sim.sim_id,
        iccid: sim.iccid,
        beforeStatus: sim.status,
        action: actionValue,
        targetStatus: policy.targetStatus,
        reason: reason ?? null,
        commitmentExempt: commitmentExempt ?? false,
      },
      after_data: {
        action: actionValue,
        targetStatus: policy.targetStatus,
        result: ok ? 'SUCCEEDED' : 'FAILED',
        errorCode: ok ? null : batchErrorCodes.INTERNAL_ERROR,
        errorMessage: ok ? null : 'SIM status change failed.',
        beforeStatus: sim.status,
        afterStatus: policy.targetStatus,
      },
    }, { returning: 'minimal' })
    await insertBatchEvent({
      supabase,
      eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
      tenantId: sim.enterprise_id ?? null,
      requestId: traceId ?? null,
      payload: {
        beforeData: {
          input: simValue,
          simId: sim.sim_id,
          iccid: sim.iccid,
          beforeStatus: sim.status,
          action: actionValue,
          targetStatus: policy.targetStatus,
          reason: reason ?? null,
          commitmentExempt: commitmentExempt ?? false,
        },
        afterData: {
          action: actionValue,
          targetStatus: policy.targetStatus,
          result: ok ? 'SUCCEEDED' : 'FAILED',
          errorCode: ok ? null : batchErrorCodes.INTERNAL_ERROR,
          errorMessage: ok ? null : 'SIM status change failed.',
          beforeStatus: sim.status,
          afterStatus: policy.targetStatus,
        },
      },
    })
  }
  await supabase.insert('audit_logs', {
    actor_user_id: actor?.userId ?? null,
    actor_role: actor?.role ?? actor?.roleScope ?? null,
    tenant_id: enterpriseId ?? null,
    action: 'SIM_BATCH_STATUS_CHANGE',
    target_type: 'SIM_BATCH',
    target_id: null,
    request_id: traceId ?? null,
    source_ip: sourceIp ?? null,
    before_data: {
      action: actionValue,
      targetStatus: policy.targetStatus,
      enterpriseId,
      requested: {
        total: simIds.length,
        reason: reason ?? null,
        commitmentExempt: commitmentExempt ?? false,
      },
    },
    after_data: {
      action: actionValue,
      targetStatus: policy.targetStatus,
      total: results.length,
      succeeded,
      failed,
      idempotent: idempotentCount,
    },
  }, { returning: 'minimal' })
  await insertBatchEvent({
    supabase,
    eventType: 'SIM_BATCH_STATUS_CHANGE',
    tenantId: enterpriseId ?? null,
    requestId: traceId ?? null,
    payload: {
      beforeData: {
        action: actionValue,
        targetStatus: policy.targetStatus,
        enterpriseId,
        requested: {
          total: simIds.length,
          reason: reason ?? null,
          commitmentExempt: commitmentExempt ?? false,
        },
      },
      afterData: {
        action: actionValue,
        targetStatus: policy.targetStatus,
        total: results.length,
        succeeded,
        failed,
        idempotent: idempotentCount,
      },
    },
  })
  return {
    ok: true,
    action: actionValue,
    targetStatus: policy.targetStatus,
    total: results.length,
    succeeded,
    failed,
    idempotent: idempotentCount,
    items: results,
  }
}

export async function batchDeactivateSims({
  supabase,
  enterpriseId,
  reason,
  idempotencyKey,
  actor,
  traceId,
  sourceIp,
  pushSimStatusToUpstream,
}) {
  if (!enterpriseId || !isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const enterpriseRows = await supabase.select(
    'tenants',
    `select=tenant_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const enterprise = Array.isArray(enterpriseRows) ? enterpriseRows[0] : null
  if (!enterprise?.tenant_id) {
    return toError(404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
  }
  if (idempotencyKey) {
    const existing = await findIdempotentJobByKey(supabase, 'SIM_BATCH_DEACTIVATE', String(idempotencyKey))
    if (existing) {
      return {
        ok: true,
        idempotent: true,
        jobId: existing.job_id,
        status: existing.status,
        progress: {
          processed: existing.progress_processed ?? 0,
          total: existing.progress_total ?? 0,
        },
      }
    }
  }
  const { data, total } = await supabase.selectWithCount(
    'sims',
    `select=sim_id,iccid,status,activation_date,enterprise_id,supplier_id&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&status=in.(ACTIVATED,TEST_READY)`
  )
  const sims = Array.isArray(data) ? data : []
  const totalRows = Number(total ?? sims.length)
  const jobRows = await insertJobWithFallback(supabase, {
    job_type: 'SIM_BATCH_DEACTIVATE',
    status: 'QUEUED',
    progress_processed: 0,
    progress_total: totalRows,
    request_id: traceId ?? null,
    idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
    actor_user_id: actor?.userId ?? null,
    reseller_id: actor?.resellerId ?? null,
    customer_id: enterpriseId ?? null,
    payload: {
      action: 'SIM_BATCH_DEACTIVATE',
      enterpriseId,
      reason: reason ?? null,
    },
  })
  const job = Array.isArray(jobRows) ? jobRows[0] : null
  const jobId = job?.job_id ?? null
  if (jobId) {
    await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
      status: 'RUNNING',
      started_at: new Date().toISOString(),
    }, { returning: 'minimal' })
  }
  let processed = 0
  let succeeded = 0
  let failed = 0
  for (const sim of sims) {
    processed += 1
    let ok = true
    try {
      await updateSimStatus({
        supabase,
        sim,
        newStatus: 'DEACTIVATED',
        source: 'SIM_BATCH_DEACTIVATE',
        requestId: traceId ?? null,
        reason: reason ?? null,
        actorRole: actor?.role ?? actor?.roleScope ?? null,
        sourceIp,
      })
      if (pushSimStatusToUpstream) {
        await pushSimStatusToUpstream({
          iccid: sim.iccid,
          status: 'DEACTIVATED',
          traceId,
          supplierId: sim.supplier_id ? String(sim.supplier_id) : null,
        })
      }
    } catch {
      ok = false
    }
    if (ok) {
      succeeded += 1
    } else {
      failed += 1
    }
    if (jobId && processed % 100 === 0) {
      await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
        progress_processed: processed,
        progress_total: totalRows,
      }, { returning: 'minimal' })
    }
  }
  if (jobId) {
    await supabase.update('jobs', `job_id=eq.${encodeURIComponent(jobId)}`, {
      status: succeeded === 0 && failed > 0 ? 'FAILED' : 'SUCCEEDED',
      progress_processed: processed,
      progress_total: totalRows,
      error_summary: failed ? `${failed} sims failed to deactivate.` : null,
      finished_at: new Date().toISOString(),
    }, { returning: 'minimal' })
    await supabase.insert('audit_logs', {
      actor_user_id: actor?.userId ?? null,
      actor_role: actor?.role ?? actor?.roleScope ?? null,
      tenant_id: enterpriseId ?? null,
      action: 'SIM_BATCH_DEACTIVATE',
      target_type: 'SIM_BATCH',
      target_id: enterpriseId,
      request_id: traceId ?? null,
      source_ip: sourceIp ?? null,
      after_data: { enterpriseId, total: totalRows, succeeded, failed, reason: reason ?? null },
    }, { returning: 'minimal' })
  }
  return {
    ok: true,
    jobId,
    status: 'QUEUED',
    totalRows,
  }
}
