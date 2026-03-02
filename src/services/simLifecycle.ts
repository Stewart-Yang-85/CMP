type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string>; suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }) => Promise<unknown>
}

type ErrorResult = {
  ok: false
  status: number
  code: string
  message: string
}

type SimIdentifier = {
  field: 'sim_id' | 'iccid'
  value: string
}

type SimIdentifierResult =
  | { ok: true; field: 'sim_id' | 'iccid'; value: string }
  | ErrorResult

type ChangeSimStatusInput = {
  supabase: SupabaseClient
  simIdentifier: SimIdentifier
  tenantQs: string
  action: string
  newStatus: string
  allowedFrom: Set<string>
  reason?: string | null
  idempotencyKey?: string | null
  actor?: {
    userId?: string | null
    resellerId?: string | null
    role?: string | null
    roleScope?: string | null
  }
  traceId?: string | null
  sourceIp?: string | null
  pushSimStatusToUpstream?: (input: { iccid: string; status: string; traceId?: string | null; supplierId?: string | null }) => Promise<unknown>
  commitmentExempt?: boolean
}

type BatchDeactivateInput = {
  supabase: SupabaseClient
  enterpriseId: string | null
  reason?: string | null
  idempotencyKey?: string | null
  actor?: {
    userId?: string | null
    resellerId?: string | null
    role?: string | null
    roleScope?: string | null
  }
  traceId?: string | null
  sourceIp?: string | null
  pushSimStatusToUpstream?: (input: { iccid: string; status: string; traceId?: string | null; supplierId?: string | null }) => Promise<unknown>
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function normalizeIccid(value: unknown) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function isValidIccid(value: unknown) {
  const s = normalizeIccid(value)
  return /^\d{18,20}$/.test(s)
}

function toError(status: number, code: string, message: string): ErrorResult {
  return { ok: false, status, code, message }
}

export function parseSimIdentifier(value: unknown): SimIdentifierResult {
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

export async function loadSim(
  supabase: SupabaseClient,
  idField: 'sim_id' | 'iccid',
  idValue: string,
  tenantQs: string
) {
  const rows = await supabase.select(
    'sims',
    `select=sim_id,iccid,primary_imsi,msisdn,status,apn,activation_date,bound_imei,form_factor,activation_code,upstream_status,upstream_status_updated_at,supplier_id,carrier_id,enterprise_id,department_id,created_at&${idField}=eq.${encodeURIComponent(idValue)}${tenantQs}&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
}

async function updateSimStatus({
  supabase,
  sim,
  newStatus,
  source,
  requestId,
  reason,
  actorRole,
  sourceIp,
}: {
  supabase: SupabaseClient
  sim: Record<string, any>
  newStatus: string
  source: string
  requestId?: string | null
  reason?: string | null
  actorRole?: string | null
  sourceIp?: string | null
}) {
  const nowIso = new Date().toISOString()
  const update: Record<string, unknown> = {
    status: newStatus,
    last_status_change_at: nowIso,
  }
  if (newStatus === 'ACTIVATED' && !sim.activation_date) {
    update.activation_date = nowIso
  }
  await supabase.update('sims', `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`, update, { returning: 'minimal' })
  await supabase.insert(
    'sim_state_history',
    {
      sim_id: sim.sim_id,
      before_status: sim.status,
      after_status: newStatus,
      start_time: nowIso,
      source,
      request_id: requestId,
    },
    { returning: 'minimal' }
  )
  await supabase.insert(
    'events',
    {
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
    },
    { returning: 'minimal' }
  )
  await supabase.insert(
    'audit_logs',
    {
      actor_role: actorRole ?? null,
      tenant_id: sim.enterprise_id ?? null,
      action: source,
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: requestId,
      source_ip: sourceIp ?? null,
      after_data: { beforeStatus: sim.status, afterStatus: newStatus, reason },
    },
    { returning: 'minimal' }
  )
  return nowIso
}

async function findIdempotentJobByKey(supabase: SupabaseClient, jobType: string, idempotencyKey: string | null) {
  if (!idempotencyKey) return null
  try {
    const rows = await supabase.select(
      'jobs',
      `select=job_id,status,progress_processed,progress_total&job_type=eq.${encodeURIComponent(jobType)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`,
      { suppressMissingColumns: true }
    )
    return Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  } catch (err: any) {
    const body = String(err?.body || err?.message || '')
    if (body.includes('idempotency_key') && body.includes('does not exist')) {
      return null
    }
    throw err
  }
}

function extractMissingColumn(err: any) {
  const body = String(err?.body || err?.message || '')
  let match = body.match(/'([^']+)' column/)
  if (match) return match[1]
  match = body.match(/column [^.]+\.([a-zA-Z0-9_]+)/)
  if (match) return match[1]
  return null
}

async function insertJobWithFallback(supabase: SupabaseClient, payload: Record<string, any>) {
  const current = { ...payload }
  const removed = new Set<string>()
  while (true) {
    try {
      return await supabase.insert('jobs', current, { suppressMissingColumns: true })
    } catch (err: any) {
      const field = extractMissingColumn(err)
      if (!field || !(field in current) || removed.has(field)) {
        throw err
      }
      removed.add(field)
      delete current[field]
    }
  }
}

async function findCommitmentBlockUntil(supabase: SupabaseClient, simId: string) {
  const subs = await supabase.select(
    'subscriptions',
    `select=commitment_end_at&sim_id=eq.${encodeURIComponent(simId)}`
  )
  let thresholdIso: string | null = null
  if (Array.isArray(subs)) {
    for (const s of subs) {
      const c = s && (s as { commitment_end_at?: string | null }).commitment_end_at ? new Date((s as { commitment_end_at?: string | null }).commitment_end_at as string).toISOString() : null
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

async function loadEnterpriseStatus(supabase: SupabaseClient, enterpriseId: string | null) {
  if (!enterpriseId) return null
  const rows = await supabase.select(
    'tenants',
    `select=enterprise_status&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  return row?.enterprise_status ? String(row.enterprise_status) : null
}

export async function fetchSimStateHistory({
  supabase,
  simIdentifier,
  tenantQs,
  page,
  limit,
}: {
  supabase: SupabaseClient
  simIdentifier: SimIdentifier
  tenantQs: string
  page: number
  limit: number
}) {
  const sim = await loadSim(supabase, simIdentifier.field, simIdentifier.value, tenantQs)
  if (!sim) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  }
  const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
  const { data, total } = await supabase.selectWithCount(
    'sim_state_history',
    `select=before_status,after_status,start_time,source,request_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&order=start_time.desc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
  )
  const rows = Array.isArray(data) ? data : []
  return {
    ok: true as const,
    sim,
    page,
    pageSize: limit,
    total: Number(total ?? rows.length),
    items: rows.map((r: any) => ({
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
}: ChangeSimStatusInput) {
  const sim = await loadSim(supabase, simIdentifier.field, simIdentifier.value, tenantQs)
  if (!sim) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  }
  if (!allowedFrom.has(String(sim.status))) {
    return toError(409, 'INVALID_STATE', `sim status ${sim.status} cannot transition to ${newStatus}.`)
  }
  if (newStatus === 'ACTIVATED') {
    const enterpriseStatus = await loadEnterpriseStatus(supabase, sim.enterprise_id ? String(sim.enterprise_id) : null)
    if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
      return toError(409, 'ENTERPRISE_INACTIVE', 'Enterprise must be ACTIVE before activating SIM.')
    }
  }
  if (newStatus === 'RETIRED' && !commitmentExempt) {
    const blockedUntil = await findCommitmentBlockUntil(supabase, String(sim.sim_id))
    if (blockedUntil) {
      return toError(400, 'COMMITMENT_NOT_MET', `Retire blocked until ${blockedUntil}.`)
    }
  }
  if (idempotencyKey) {
    const existing = await findIdempotentJobByKey(supabase, 'SIM_STATUS_CHANGE', String(idempotencyKey))
    if (existing) {
      return {
        ok: true as const,
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
  const job = Array.isArray(jobRows) ? (jobRows[0] as Record<string, any>) : null
  const jobId = job?.job_id ?? null
  let succeeded = true
  try {
    await updateSimStatus({
      supabase,
      sim: sim as Record<string, any>,
      newStatus,
      source: action,
      requestId: traceId ?? null,
      reason: reason ?? null,
      actorRole: actor?.role ?? actor?.roleScope ?? null,
      sourceIp: sourceIp ?? null,
    })
    if (pushSimStatusToUpstream) {
      await pushSimStatusToUpstream({
        iccid: String(sim.iccid),
        status: newStatus,
        traceId,
        supplierId: sim.supplier_id ? String(sim.supplier_id) : null,
      })
    }
  } catch {
    succeeded = false
  }
  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(String(jobId))}`,
      {
        status: succeeded ? 'SUCCEEDED' : 'FAILED',
        progress_processed: 1,
        progress_total: 1,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error_summary: succeeded ? null : 'SIM status change failed.',
      },
      { returning: 'minimal' }
    )
  }
  if (!succeeded) {
    return toError(500, 'INTERNAL_ERROR', 'SIM status change failed.')
  }
  return { ok: true as const, jobId, status: 'QUEUED' }
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
}: BatchDeactivateInput) {
  if (!enterpriseId || !isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  if (idempotencyKey) {
    const existing = await findIdempotentJobByKey(supabase, 'SIM_BATCH_DEACTIVATE', String(idempotencyKey))
    if (existing) {
      return {
        ok: true as const,
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
    `select=sim_id,iccid,status,activation_date,enterprise_id,supplier_id&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&status=eq.ACTIVATED`
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
  const job = Array.isArray(jobRows) ? (jobRows[0] as Record<string, any>) : null
  const jobId = job?.job_id ?? null
  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(String(jobId))}`,
      {
        status: 'RUNNING',
        started_at: new Date().toISOString(),
      },
      { returning: 'minimal' }
    )
  }
  let processed = 0
  let succeeded = 0
  let failed = 0
  for (const sim of sims as any[]) {
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
        sourceIp: sourceIp ?? null,
      })
      if (pushSimStatusToUpstream) {
        await pushSimStatusToUpstream({
          iccid: String(sim.iccid),
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
      await supabase.update(
        'jobs',
        `job_id=eq.${encodeURIComponent(String(jobId))}`,
        {
          progress_processed: processed,
          progress_total: totalRows,
        },
        { returning: 'minimal' }
      )
    }
  }
  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(String(jobId))}`,
      {
        status: succeeded === 0 && failed > 0 ? 'FAILED' : 'SUCCEEDED',
        progress_processed: processed,
        progress_total: totalRows,
        error_summary: failed ? `${failed} sims failed to deactivate.` : null,
        finished_at: new Date().toISOString(),
      },
      { returning: 'minimal' }
    )
    await supabase.insert(
      'audit_logs',
      {
        actor_user_id: actor?.userId ?? null,
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        tenant_id: enterpriseId ?? null,
        action: 'SIM_BATCH_DEACTIVATE',
        target_type: 'SIM_BATCH',
        target_id: enterpriseId,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        after_data: { enterpriseId, total: totalRows, succeeded, failed, reason: reason ?? null },
      },
      { returning: 'minimal' }
    )
  }
  return {
    ok: true as const,
    jobId,
    status: 'QUEUED',
    totalRows,
  }
}
