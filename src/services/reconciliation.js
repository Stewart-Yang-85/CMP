function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function normalizeScope(value) {
  const v = String(value || '').trim().toUpperCase()
  return v === 'FULL' ? 'FULL' : 'INCREMENTAL'
}

function normalizeDate(value) {
  const v = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const dt = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(dt.getTime())) return null
  return v
}

function buildMismatchMetrics(items) {
  const byField = {}
  const byResolution = {}
  const byLocalStatus = {}
  const byUpstreamStatus = {}
  const byStatusPair = {}
  const byEnterpriseId = {}
  const bySupplierId = {}
  const byCarrierId = {}
  for (const item of items) {
    const field = String(item.field ?? '').trim()
    const resolution = String(item.resolution ?? '').trim()
    const localStatus = String(item.localValue ?? '').trim()
    const upstreamStatus = String(item.upstreamValue ?? '').trim()
    const enterpriseId = String(item.enterpriseId ?? '').trim()
    const supplierId = String(item.supplierId ?? '').trim()
    const carrierId = String(item.carrierId ?? '').trim()
    if (field) byField[field] = (byField[field] ?? 0) + 1
    if (resolution) byResolution[resolution] = (byResolution[resolution] ?? 0) + 1
    if (localStatus) byLocalStatus[localStatus] = (byLocalStatus[localStatus] ?? 0) + 1
    if (upstreamStatus) byUpstreamStatus[upstreamStatus] = (byUpstreamStatus[upstreamStatus] ?? 0) + 1
    if (localStatus && upstreamStatus) {
      const pair = `${localStatus}->${upstreamStatus}`
      byStatusPair[pair] = (byStatusPair[pair] ?? 0) + 1
    }
    if (enterpriseId) byEnterpriseId[enterpriseId] = (byEnterpriseId[enterpriseId] ?? 0) + 1
    if (supplierId) bySupplierId[supplierId] = (bySupplierId[supplierId] ?? 0) + 1
    if (carrierId) byCarrierId[carrierId] = (byCarrierId[carrierId] ?? 0) + 1
  }
  return {
    total: items.length,
    byField,
    byResolution,
    byLocalStatus,
    byUpstreamStatus,
    byStatusPair,
    byEnterpriseId,
    bySupplierId,
    byCarrierId,
  }
}

function buildDateRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

async function loadRunRow(supabase, runId) {
  const rows = await supabase.select(
    'reconciliation_runs',
    `select=run_id,supplier_id,run_date,scope,status&run_id=eq.${encodeURIComponent(runId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

function normalizeUpstreamSimStatus(value) {
  const raw = String(value || '').trim().toUpperCase()
  if (!raw) return null
  if (raw.includes('NOACTIV') || raw.includes('INACTIV') || raw.includes('DEACT') || raw.includes('STOP') || raw.includes('SUSPEND')) {
    return 'DEACTIVATED'
  }
  if (raw.includes('RETIRED')) return 'RETIRED'
  if (raw.includes('TEST')) return 'TEST_READY'
  if (raw.includes('INVENTORY')) return 'INVENTORY'
  if (raw.includes('ACTIV')) return 'ACTIVATED'
  return null
}

async function updateSimFromUpstream({ supabase, sim, upstreamStatus, traceId, runId }) {
  const nowIso = new Date().toISOString()
  const normalizedStatus = normalizeUpstreamSimStatus(upstreamStatus) ?? String(sim.status || '')
  const update = {
    upstream_status: upstreamStatus,
    upstream_status_updated_at: nowIso,
  }
  const statusChanged = normalizedStatus && String(sim.status || '') !== normalizedStatus
  if (statusChanged) {
    update.status = normalizedStatus
    update.last_status_change_at = nowIso
    if (normalizedStatus === 'ACTIVATED' && !sim.activation_date) {
      update.activation_date = nowIso
    }
  }
  await supabase.update('sims', `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`, update, { returning: 'minimal' })
  if (!statusChanged) {
    return nowIso
  }
  await supabase.insert(
    'sim_state_history',
    {
      sim_id: sim.sim_id,
      before_status: sim.status,
      after_status: normalizedStatus,
      start_time: nowIso,
      source: 'RECONCILIATION_UPSTREAM_WINS',
      request_id: runId ?? traceId ?? null,
    },
    { returning: 'minimal' }
  )
  await supabase.insert(
    'events',
    {
      event_type: 'SIM_STATUS_CHANGED',
      occurred_at: nowIso,
      tenant_id: sim.enterprise_id ?? null,
      request_id: runId ?? traceId ?? null,
      payload: {
        iccid: sim.iccid,
        beforeStatus: sim.status,
        afterStatus: normalizedStatus,
        reason: 'UPSTREAM_WINS',
      },
    },
    { returning: 'minimal' }
  )
  await supabase.insert(
    'audit_logs',
    {
      actor_role: 'SYSTEM',
      tenant_id: sim.enterprise_id ?? null,
      action: 'RECONCILIATION_UPSTREAM_WINS',
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: runId ?? traceId ?? null,
      after_data: { beforeStatus: sim.status, afterStatus: normalizedStatus, reason: 'UPSTREAM_WINS' },
    },
    { returning: 'minimal' }
  )
  return nowIso
}

export async function createReconciliationRun({ supabase, supplierId, date, scope, traceId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const supplier = String(supplierId || '').trim()
  if (!isValidUuid(supplier)) {
    return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
  }
  const runDate = normalizeDate(date)
  if (!runDate) {
    return toError(400, 'BAD_REQUEST', 'date must be in YYYY-MM-DD format.')
  }
  const scopeValue = normalizeScope(scope)
  const nowIso = new Date().toISOString()
  const rows = await supabase.insert(
    'reconciliation_runs',
    {
      supplier_id: supplier,
      run_date: runDate,
      scope: scopeValue,
      status: 'RUNNING',
      started_at: nowIso,
    },
    { returning: 'representation' }
  )
  const run = Array.isArray(rows) ? rows[0] : null
  if (!run?.run_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create reconciliation run.')
  return {
    ok: true,
    value: {
      runId: String(run.run_id),
      supplierId: String(run.supplier_id),
      status: String(run.status || 'RUNNING'),
      date: run.run_date,
      scope: run.scope,
      traceId: traceId ?? null,
    },
  }
}

export async function runReconciliation({ supabase, runId, supplierId, date, scope, traceId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const scopeValue = normalizeScope(scope)
  let resolvedRunId = runId ? String(runId).trim() : ''
  let resolvedSupplierId = supplierId ? String(supplierId).trim() : ''
  let resolvedDate = date ? String(date).trim() : ''
  if (resolvedRunId && !isValidUuid(resolvedRunId)) {
    return toError(400, 'BAD_REQUEST', 'runId must be a valid uuid.')
  }
  if (resolvedRunId) {
    const existing = await loadRunRow(supabase, resolvedRunId)
    if (!existing) return toError(404, 'NOT_FOUND', 'reconciliation run not found.')
    if (!resolvedSupplierId) resolvedSupplierId = String(existing.supplier_id || '')
    if (!resolvedDate) resolvedDate = String(existing.run_date || '')
  }
  if (!resolvedSupplierId || !isValidUuid(resolvedSupplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
  }
  const runDate = normalizeDate(resolvedDate)
  if (!runDate) return toError(400, 'BAD_REQUEST', 'date must be in YYYY-MM-DD format.')
  const nowIso = new Date().toISOString()
  if (!resolvedRunId) {
    const rows = await supabase.insert(
      'reconciliation_runs',
      {
        supplier_id: resolvedSupplierId,
        run_date: runDate,
        scope: scopeValue,
        status: 'RUNNING',
        started_at: nowIso,
      },
      { returning: 'representation' }
    )
    const run = Array.isArray(rows) ? rows[0] : null
    if (!run?.run_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create reconciliation run.')
    resolvedRunId = String(run.run_id)
  } else {
    await supabase.update(
      'reconciliation_runs',
      `run_id=eq.${encodeURIComponent(resolvedRunId)}`,
      { status: 'RUNNING', started_at: nowIso },
      { returning: 'minimal' }
    )
  }
  let totalChecked = 0
  let matched = 0
  let mismatches = 0
  let localOnly = 0
  let upstreamOnly = 0
  const mismatchDetails = []
  const filters = [`supplier_id=eq.${encodeURIComponent(resolvedSupplierId)}`]
  if (scopeValue === 'INCREMENTAL') {
    const range = buildDateRange(runDate)
    if (range) {
      filters.push(`upstream_status_updated_at=gte.${encodeURIComponent(range.startIso)}`)
      filters.push(`upstream_status_updated_at=lt.${encodeURIComponent(range.endIso)}`)
    }
  }
  const qs = `select=sim_id,iccid,status,activation_date,upstream_status,upstream_status_updated_at,enterprise_id,supplier_id,operator_id&${filters.join('&')}&limit=100000`
  const sims = await supabase.select('sims', qs)
  const list = Array.isArray(sims) ? sims : []
  totalChecked = list.length
  for (const sim of list) {
    const localStatus = sim?.status ? String(sim.status) : ''
    const upstreamStatus = sim?.upstream_status ? String(sim.upstream_status) : ''
    if (!upstreamStatus) {
      localOnly += 1
      continue
    }
    if (localStatus === upstreamStatus) {
      matched += 1
      continue
    }
    mismatches += 1
    let resolvedAt = null
    try {
      resolvedAt = await updateSimFromUpstream({
        supabase,
        sim,
        upstreamStatus,
        traceId,
        runId: resolvedRunId,
      })
    } catch {
      resolvedAt = null
    }
    mismatchDetails.push({
      iccid: sim.iccid,
      simId: sim.sim_id ?? null,
      enterpriseId: sim.enterprise_id ?? null,
      supplierId: sim.supplier_id ?? null,
      operatorId: sim.operator_id ?? null,
      carrierId: sim.operator_id ?? null,
      field: 'status',
      localValue: localStatus,
      upstreamValue: upstreamStatus,
      upstreamStatusUpdatedAt: sim.upstream_status_updated_at ?? null,
      resolution: 'UPSTREAM_WINS',
      resolvedAt,
    })
  }
  await supabase.update(
    'reconciliation_runs',
    `run_id=eq.${encodeURIComponent(resolvedRunId)}`,
    {
      total_checked: totalChecked,
      matched,
      mismatches,
      local_only: localOnly,
      upstream_only: upstreamOnly,
      mismatch_details: mismatchDetails,
      status: 'COMPLETED',
      finished_at: new Date().toISOString(),
    },
    { returning: 'minimal' }
  )
  return {
    ok: true,
    value: {
      runId: resolvedRunId,
      supplierId: resolvedSupplierId,
      date: runDate,
      status: 'COMPLETED',
      summary: {
        totalSimsChecked: totalChecked,
        matched,
        mismatched: mismatches,
        localOnly,
        upstreamOnly,
      },
      mismatches: mismatchDetails,
      metrics: buildMismatchMetrics(mismatchDetails),
    },
  }
}

export async function getReconciliationRun({ supabase, runId }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!runId || !isValidUuid(runId)) {
    return toError(400, 'BAD_REQUEST', 'runId must be a valid uuid.')
  }
  const rows = await supabase.select(
    'reconciliation_runs',
    `select=run_id,supplier_id,run_date,scope,total_checked,matched,mismatches,local_only,upstream_only,mismatch_details,status,finished_at&run_id=eq.${encodeURIComponent(runId)}&limit=1`
  )
  const run = Array.isArray(rows) ? rows[0] : null
  if (!run?.run_id) return toError(404, 'NOT_FOUND', 'reconciliation run not found.')
  const mismatches = Array.isArray(run.mismatch_details) ? run.mismatch_details : []
  return {
    ok: true,
    value: {
      runId: String(run.run_id),
      supplierId: String(run.supplier_id),
      date: run.run_date,
      status: String(run.status || 'RUNNING'),
      summary: {
        totalSimsChecked: Number(run.total_checked ?? 0),
        matched: Number(run.matched ?? 0),
        mismatched: Number(run.mismatches ?? 0),
        localOnly: Number(run.local_only ?? 0),
        upstreamOnly: Number(run.upstream_only ?? 0),
      },
      mismatches,
      completedAt: run.finished_at ?? null,
      metrics: buildMismatchMetrics(mismatches),
    },
  }
}

export async function listReconciliationMismatches({
  supabase,
  runId,
  field,
  resolution,
  iccid,
  enterpriseId,
  page,
  pageSize,
}) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!runId || !isValidUuid(runId)) {
    return toError(400, 'BAD_REQUEST', 'runId must be a valid uuid.')
  }
  const rows = await supabase.select(
    'reconciliation_runs',
    `select=run_id,mismatch_details&run_id=eq.${encodeURIComponent(runId)}&limit=1`
  )
  const run = Array.isArray(rows) ? rows[0] : null
  if (!run?.run_id) return toError(404, 'NOT_FOUND', 'reconciliation run not found.')
  let items = Array.isArray(run.mismatch_details) ? run.mismatch_details : []
  const fieldValue = field ? String(field).trim() : ''
  const resolutionValue = resolution ? String(resolution).trim() : ''
  const iccidValue = iccid ? String(iccid).trim() : ''
  const enterpriseValue = enterpriseId ? String(enterpriseId).trim() : ''
  if (fieldValue) {
    items = items.filter((it) => String((it || {}).field || '') === fieldValue)
  }
  if (resolutionValue) {
    items = items.filter((it) => String((it || {}).resolution || '') === resolutionValue)
  }
  if (iccidValue) {
    items = items.filter((it) => String((it || {}).iccid || '') === iccidValue)
  }
  if (enterpriseValue) {
    items = items.filter((it) => String((it || {}).enterpriseId || '') === enterpriseValue)
  }
  const pageNum = Math.max(1, Number(page ?? 1) || 1)
  const sizeNum = Math.min(200, Math.max(1, Number(pageSize ?? 20) || 20))
  const offset = (pageNum - 1) * sizeNum
  const total = items.length
  items = items.slice(offset, offset + sizeNum)
  return { ok: true, value: { items, total, page: pageNum, pageSize: sizeNum, metrics: buildMismatchMetrics(items) } }
}

export async function getReconciliationMismatchTrace({ supabase, runId, iccid }) {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!runId || !isValidUuid(runId)) {
    return toError(400, 'BAD_REQUEST', 'runId must be a valid uuid.')
  }
  const iccidValue = String(iccid || '').trim()
  if (!/^\d{18,20}$/.test(iccidValue)) {
    return toError(400, 'BAD_REQUEST', 'iccid must be 18-20 digits.')
  }
  const runRows = await supabase.select(
    'reconciliation_runs',
    `select=run_id,run_date,scope,status,started_at,finished_at,mismatch_details&run_id=eq.${encodeURIComponent(runId)}&limit=1`
  )
  const run = Array.isArray(runRows) ? runRows[0] : null
  if (!run?.run_id) return toError(404, 'NOT_FOUND', 'reconciliation run not found.')
  const mismatchDetails = Array.isArray(run.mismatch_details) ? run.mismatch_details : []
  const mismatch = mismatchDetails.find((it) => String((it || {}).iccid || '') === iccidValue) ?? null
  const simRows = await supabase.select(
    'sims',
    `select=sim_id,iccid,status,upstream_status,upstream_status_updated_at,enterprise_id,department_id,supplier_id,operator_id&iccid=eq.${encodeURIComponent(iccidValue)}&limit=1`
  )
  const sim = Array.isArray(simRows) ? simRows[0] : null
  const simId = sim?.sim_id ? String(sim.sim_id) : null
  let simStateHistory = []
  if (simId) {
    const historyRows = await supabase.select(
      'sim_state_history',
      `select=before_status,after_status,start_time,source,request_id&sim_id=eq.${encodeURIComponent(simId)}&request_id=eq.${encodeURIComponent(runId)}&order=start_time.desc&limit=50`
    )
    simStateHistory = Array.isArray(historyRows)
      ? historyRows.map((r) => ({
          beforeStatus: r.before_status,
          afterStatus: r.after_status,
          startTime: r.start_time ? new Date(r.start_time).toISOString() : null,
          source: r.source,
          requestId: r.request_id ?? null,
        }))
      : []
  }
  const eventRows = await supabase.select(
    'events',
    `select=event_id,event_type,occurred_at,tenant_id,actor_user_id,request_id,payload&request_id=eq.${encodeURIComponent(runId)}&payload->>iccid=eq.${encodeURIComponent(iccidValue)}&order=occurred_at.desc&limit=50`
  )
  const events = Array.isArray(eventRows)
    ? eventRows.map((r) => ({
        eventId: r.event_id,
        eventType: r.event_type,
        occurredAt: r.occurred_at ?? null,
        tenantId: r.tenant_id ?? null,
        actorUserId: r.actor_user_id ?? null,
        requestId: r.request_id ?? null,
        payload: r.payload ?? {},
      }))
    : []
  const auditRows = await supabase.select(
    'audit_logs',
    `select=audit_id,actor_user_id,actor_role,tenant_id,action,target_type,target_id,request_id,created_at,source_ip,before_data,after_data&request_id=eq.${encodeURIComponent(runId)}&target_id=eq.${encodeURIComponent(iccidValue)}&order=created_at.desc&limit=50`
  )
  const audits = Array.isArray(auditRows)
    ? auditRows.map((r) => ({
        auditId: r.audit_id,
        actorUserId: r.actor_user_id ?? null,
        actorRole: r.actor_role ?? null,
        tenantId: r.tenant_id ?? null,
        action: r.action,
        targetType: r.target_type ?? null,
        targetId: r.target_id ?? null,
        requestId: r.request_id ?? null,
        createdAt: r.created_at ?? null,
        sourceIp: r.source_ip ?? null,
        beforeData: r.before_data ?? null,
        afterData: r.after_data ?? null,
      }))
    : []
  return {
    ok: true,
    value: {
      run: {
        runId: String(run.run_id),
        date: run.run_date,
        scope: run.scope,
        status: run.status,
        startedAt: run.started_at ?? null,
        completedAt: run.finished_at ?? null,
      },
      mismatch,
      sim: sim
        ? {
            simId: sim.sim_id,
            iccid: sim.iccid,
            status: sim.status,
            upstreamStatus: sim.upstream_status ?? null,
            upstreamStatusUpdatedAt: sim.upstream_status_updated_at ?? null,
            enterpriseId: sim.enterprise_id ?? null,
            departmentId: sim.department_id ?? null,
            supplierId: sim.supplier_id ?? null,
            operatorId: sim.operator_id ?? null,
            carrierId: sim.operator_id ?? null,
          }
        : null,
      simStateHistory,
      events,
      audits,
    },
  }
}
