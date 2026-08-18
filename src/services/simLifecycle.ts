import { actorUserIdForDb } from '../utils/actorUserId.js'
import { resolveResellerTenantIdFromContext } from './resellerTenantScope.js'
import { emitEvent, resolveEventScopeColumns, sanitizeEventPayload } from './eventEmitter.js'
import { finalizeSimStatusChange as finalizeSimStatusChangeJs } from './simLifecycleFinalize.js'
import {
  buildLifecycleAcceptResponse,
  isLifecycleFailed,
  isLifecycleInProgress,
  resolveTransition,
} from './simStatusChangeJob.js'

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

const batchErrorCodes = {
  INVALID_SIM_ID: 'INVALID_SIM_ID',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  ENTERPRISE_INACTIVE: 'ENTERPRISE_INACTIVE',
  COMMITMENT_NOT_MET: 'COMMITMENT_NOT_MET',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  WRONG_RESELLER: 'WRONG_RESELLER',
  WRONG_ENTERPRISE: 'WRONG_ENTERPRISE',
} as const

function isMissingSimResellerColumnError(err: unknown): boolean {
  const text = String((err as { body?: string })?.body ?? (err as Error)?.message ?? '').toLowerCase()
  return text.includes('column sims.reseller_id does not exist')
}

async function detectSimsHasResellerIdColumn(supabase: SupabaseClient): Promise<boolean> {
  try {
    await supabase.select('sims', 'select=reseller_id&limit=1', { suppressMissingColumns: true })
    return true
  } catch (err) {
    if (isMissingSimResellerColumnError(err)) return false
    throw err
  }
}

async function loadSimRowForInventoryAssign(
  supabase: SupabaseClient,
  field: 'sim_id' | 'iccid',
  value: string,
  includeResellerId: boolean
) {
  const baseCols = 'sim_id,iccid,status,enterprise_id,department_id'
  const cols = includeResellerId ? `${baseCols},reseller_id,supplier_id` : `${baseCols},supplier_id`
  const rows = await supabase.select('sims', `select=${cols}&${field}=eq.${encodeURIComponent(value)}&limit=1`)
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
}

async function resolveInventoryResellerOwnerIds(supabase: SupabaseClient, resellerTenantId: string): Promise<Set<string>> {
  const ids = new Set<string>([String(resellerTenantId)])
  try {
    const rows = await supabase.select(
      'resellers',
      `select=id&tenant_id=eq.${encodeURIComponent(resellerTenantId)}&limit=1`,
      { suppressMissingColumns: true }
    )
    const row = Array.isArray(rows) ? (rows[0] as { id?: string } | undefined) : undefined
    if (row?.id) ids.add(String(row.id))
  } catch {
    // resellers row optional in some test seeds
  }
  return ids
}

async function validateAssignTargetEnterprise(
  supabase: SupabaseClient,
  resellerId: string,
  enterpriseId: string
): Promise<{ ok: true } | ErrorResult> {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,enterprise_status,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  if (!row?.tenant_id) {
    return toError(404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
  }
  if (String(row.tenant_type || '').toUpperCase() !== 'ENTERPRISE') {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be an enterprise tenant.')
  }
  if (String(row.parent_id || '') !== String(resellerId)) {
    return toError(403, 'FORBIDDEN', 'enterpriseId is not a child enterprise of resellerId.')
  }
  if (String(row.enterprise_status || '').toUpperCase() !== 'ACTIVE') {
    return toError(409, 'ENTERPRISE_INACTIVE', 'Target enterprise must be ACTIVE.')
  }
  return { ok: true as const }
}

async function validateAssignTargetEnterpriseForDepartment(
  supabase: SupabaseClient,
  enterpriseId: string
): Promise<{ ok: true } | ErrorResult> {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,enterprise_status,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  if (!row?.tenant_id) {
    return toError(404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
  }
  if (String(row.tenant_type || '').toUpperCase() !== 'ENTERPRISE') {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be an enterprise tenant.')
  }
  if (String(row.enterprise_status || '').toUpperCase() !== 'ACTIVE') {
    return toError(409, 'ENTERPRISE_INACTIVE', 'Target enterprise must be ACTIVE.')
  }
  return { ok: true as const }
}

async function validateAssignTargetDepartment(
  supabase: SupabaseClient,
  enterpriseId: string,
  departmentId: string
): Promise<{ ok: true } | ErrorResult> {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(departmentId)}&tenant_type=eq.DEPARTMENT&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  if (!row?.tenant_id) {
    return toError(404, 'RESOURCE_NOT_FOUND', `department ${departmentId} not found.`)
  }
  if (String(row.parent_id || '') !== String(enterpriseId)) {
    return toError(403, 'FORBIDDEN', 'departmentId is not a child department of enterpriseId.')
  }
  return { ok: true as const }
}


async function insertBatchEvent({
  supabase,
  eventType,
  enterpriseId,
  resellerId,
  requestId,
  payload,
}: {
  supabase: SupabaseClient
  eventType: string
  enterpriseId?: string | null
  resellerId?: string | null
  requestId?: string | null
  payload: Record<string, unknown>
}) {
  const scope = await resolveEventScopeColumns(supabase, { enterpriseId, resellerId })
  await supabase.insert(
    'events',
    {
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      enterprise_id: scope.enterpriseId,
      reseller_id: scope.resellerId,
      request_id: requestId ?? null,
      payload: sanitizeEventPayload(payload),
    },
    { returning: 'minimal' },
  )
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
    `select=sim_id,iccid,primary_imsi,msisdn,status,lifecycle_sub_status,apn,activation_date,bound_imei,form_factor,activation_code,upstream_status,upstream_status_updated_at,supplier_id,operator_id,enterprise_id,reseller_id,department_id,created_at&${idField}=eq.${encodeURIComponent(idValue)}${tenantQs}&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
}

/** Steady-state transition after upstream confirmation (spec US2). */
export async function finalizeSimStatusChange(
  input: Parameters<typeof finalizeSimStatusChangeJs>[0]
) {
  return finalizeSimStatusChangeJs(input)
}

const updateSimStatus = finalizeSimStatusChange

async function setLifecyclePending(
  supabase: SupabaseClient,
  simId: string,
  lifecycleSubStatus: string
) {
  await supabase.update(
    'sims',
    `sim_id=eq.${encodeURIComponent(simId)}`,
    { lifecycle_sub_status: lifecycleSubStatus },
    { returning: 'minimal' }
  )
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
  from,
  to,
}: {
  supabase: SupabaseClient
  simIdentifier: SimIdentifier
  tenantQs: string
  page: number
  limit: number
  from?: string | null
  to?: string | null
}) {
  const sim = await loadSim(supabase, simIdentifier.field, simIdentifier.value, tenantQs)
  if (!sim) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  }
  const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
  const dateFilters: string[] = []
  if (from) {
    dateFilters.push(`start_time=gte.${encodeURIComponent(from)}`)
  }
  if (to) {
    dateFilters.push(`start_time=lte.${encodeURIComponent(to)}`)
  }
  const dateFilterQs = dateFilters.length ? `&${dateFilters.join('&')}` : ''
  const { data, total } = await supabase.selectWithCount(
    'sim_state_history',
    `select=before_status,after_status,start_time,source,request_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}${dateFilterQs}&order=start_time.desc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
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
  // T-NEW-9: eSIM lifecycle guard — eSIM operations deferred to V1.1
  if (sim.form_factor && String(sim.form_factor).toLowerCase().includes('esim')) {
    return toError(501, 'NOT_IMPLEMENTED', 'eSIM lifecycle operations are not yet supported (planned for V1.1).')
  }
  const currentSub = String(sim.lifecycle_sub_status || 'normal')
  if (isLifecycleInProgress(currentSub)) {
    return toError(409, 'LIFECYCLE_IN_PROGRESS', `sim lifecycle operation already in progress (${currentSub}).`)
  }
  if (!allowedFrom.has(String(sim.status))) {
    return toError(409, 'INVALID_STATE', `sim status ${sim.status} cannot transition to ${newStatus}.`)
  }
  const transition = resolveTransition(action, newStatus)
  if (!transition) {
    return toError(400, 'BAD_REQUEST', 'Unknown lifecycle action.')
  }
  if (!isLifecycleFailed(currentSub) && currentSub !== 'normal') {
    return toError(409, 'INVALID_STATE', `sim lifecycle_sub_status ${currentSub} cannot start ${transition.apiAction}.`)
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
      const existingJobId = existing.job_id ? String(existing.job_id) : ''
      return toError(
        409,
        'DUPLICATE_IDEMPOTENCY_KEY',
        existingJobId
          ? `idempotencyKey already used by SIM_STATUS_CHANGE job ${existingJobId}.`
          : 'idempotencyKey already used by a prior SIM status change request.'
      )
    }
  }
  let jobRows: unknown
  try {
    jobRows = await insertJobWithFallback(supabase, {
      job_type: 'SIM_STATUS_CHANGE',
      status: 'QUEUED',
      progress_processed: 0,
      progress_total: 1,
      request_id: traceId ?? null,
      idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
      actor_user_id: actorUserIdForDb(actor?.userId),
      reseller_id: actor?.resellerId ?? null,
      enterprise_id: sim.enterprise_id ?? null,
      payload: {
        action,
        simId: sim.sim_id,
        iccid: sim.iccid,
        supplierId: sim.supplier_id ?? null,
        beforeStatus: sim.status,
        afterStatus: newStatus,
        targetStatus: newStatus,
        reason: reason ?? null,
        idempotencyKey: idempotencyKey ?? null,
      },
    })
  } catch (err: any) {
    const body = String(err?.body || err?.message || '')
    if (
      idempotencyKey &&
      (body.includes('idx_jobs_sim_status_change_idempotency_key') ||
        body.includes('duplicate key') ||
        body.includes('unique constraint'))
    ) {
      return toError(409, 'DUPLICATE_IDEMPOTENCY_KEY', 'idempotencyKey already used by a prior SIM status change request.')
    }
    throw err
  }
  const job = Array.isArray(jobRows) ? (jobRows[0] as Record<string, any>) : null
  const jobId = job?.job_id ?? null
  try {
    await setLifecyclePending(supabase, String(sim.sim_id), String(transition.pending))
  } catch {
    return toError(500, 'INTERNAL_ERROR', 'Failed to set lifecycle pending state.')
  }
  const acceptedSim = { ...sim, lifecycle_sub_status: transition.pending }
  void pushSimStatusToUpstream
  return {
    ok: true as const,
    jobId,
    ...buildLifecycleAcceptResponse({
      jobId,
      jobStatus: 'QUEUED',
      sim: acceptedSim,
      transition,
    }),
  }
}

const MARK_TEST_READY_JOB_TYPE = 'SIM_MARK_TEST_READY'

export function validateMarkTestReadyPreconditions(sim: {
  status?: string | null
  lifecycle_sub_status?: string | null
  enterprise_id?: string | null
}): ErrorResult | { ok: true } {
  const currentSub = String(sim.lifecycle_sub_status || 'normal')
  if (isLifecycleInProgress(currentSub)) {
    return toError(409, 'LIFECYCLE_IN_PROGRESS', `sim lifecycle operation already in progress (${currentSub}).`)
  }
  if (!isLifecycleFailed(currentSub) && currentSub !== 'normal') {
    return toError(409, 'INVALID_STATE', `sim lifecycle_sub_status ${currentSub} cannot mark test-ready.`)
  }
  if (String(sim.status || '').toUpperCase() !== 'INVENTORY') {
    return toError(409, 'INVALID_STATE', 'sim must be INVENTORY to mark test-ready.')
  }
  const enterpriseId = sim.enterprise_id != null && String(sim.enterprise_id).trim() !== ''
    ? String(sim.enterprise_id).trim()
    : null
  if (!enterpriseId) {
    return toError(409, 'ENTERPRISE_REQUIRED', 'sim must be assigned to an enterprise before mark-test-ready.')
  }
  return { ok: true }
}

export async function markSimTestReady({
  supabase,
  simIdentifier,
  tenantQs,
  reason,
  idempotencyKey,
  actor,
  traceId,
  sourceIp,
}: {
  supabase: SupabaseClient
  simIdentifier: SimIdentifier
  tenantQs: string
  reason?: string | null
  idempotencyKey?: string | null
  actor?: {
    userId?: string | null
    resellerId?: string | null
    role?: string | null
    roleScope?: string | null
  } | null
  traceId?: string | null
  sourceIp?: string | null
}) {
  if (!reason || !String(reason).trim()) {
    return toError(400, 'BAD_REQUEST', 'reason is required.')
  }
  const sim = await loadSim(supabase, simIdentifier.field, simIdentifier.value, tenantQs)
  if (!sim) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  }
  if (sim.form_factor && String(sim.form_factor).toLowerCase().includes('esim')) {
    return toError(501, 'NOT_IMPLEMENTED', 'eSIM lifecycle operations are not yet supported (planned for V1.1).')
  }
  const pre = validateMarkTestReadyPreconditions(sim)
  if (!pre.ok) {
    return pre
  }
  if (idempotencyKey) {
    const existing = await findIdempotentJobByKey(supabase, MARK_TEST_READY_JOB_TYPE, String(idempotencyKey))
    if (existing) {
      const existingJobId = existing.job_id ? String(existing.job_id) : ''
      return toError(
        409,
        'DUPLICATE_IDEMPOTENCY_KEY',
        existingJobId
          ? `idempotencyKey already used by SIM_MARK_TEST_READY job ${existingJobId}.`
          : 'idempotencyKey already used by a prior mark-test-ready request.'
      )
    }
  }
  const nowIso = await finalizeSimStatusChangeJs({
    supabase,
    sim,
    newStatus: 'TEST_READY',
    source: MARK_TEST_READY_JOB_TYPE,
    requestId: traceId ?? null,
    reason: String(reason).trim(),
    actorRole: actor?.role ?? actor?.roleScope ?? null,
    sourceIp: sourceIp ?? null,
    lifecycleSubStatus: 'normal',
    emitStatusEvent: true,
  })
  let jobId: string | null = null
  if (idempotencyKey) {
    try {
      const jobRows = await insertJobWithFallback(supabase, {
        job_type: MARK_TEST_READY_JOB_TYPE,
        status: 'SUCCEEDED',
        progress_processed: 1,
        progress_total: 1,
        finished_at: nowIso,
        request_id: traceId ?? null,
        idempotency_key: String(idempotencyKey),
        actor_user_id: actorUserIdForDb(actor?.userId),
        reseller_id: actor?.resellerId ?? null,
        enterprise_id: sim.enterprise_id ?? null,
        payload: {
          simId: sim.sim_id,
          iccid: sim.iccid,
          beforeStatus: 'INVENTORY',
          afterStatus: 'TEST_READY',
          reason: String(reason).trim(),
          idempotencyKey: String(idempotencyKey),
        },
      })
      const job = Array.isArray(jobRows) ? (jobRows[0] as Record<string, any>) : null
      jobId = job?.job_id ? String(job.job_id) : null
    } catch (err: any) {
      const body = String(err?.body || err?.message || '')
      if (
        body.includes('idx_jobs_sim_mark_test_ready_idempotency_key') ||
        body.includes('duplicate key') ||
        body.includes('unique constraint')
      ) {
        return toError(409, 'DUPLICATE_IDEMPOTENCY_KEY', 'idempotencyKey already used by a prior mark-test-ready request.')
      }
    }
  }
  return {
    ok: true as const,
    jobId,
    sim: {
      simId: sim.sim_id,
      iccid: sim.iccid,
      status: 'TEST_READY',
      lifecycleSubStatus: 'normal',
      beforeStatus: 'INVENTORY',
      afterStatus: 'TEST_READY',
    },
    message: 'SIM marked test-ready (local transition; no upstream call).',
  }
}

export { processSimStatusChangeJob } from './simStatusChangeJob.js'

const SIM_BATCH_STATUS_CHANGE_JOB_TYPE = 'SIM_BATCH_STATUS_CHANGE'

function resolveBatchStatusChangeIdempotencyKey(
  batchId: string | null | undefined,
  fileHash: string | null | undefined,
  action: string,
): string | null {
  const base = batchId?.trim() || fileHash?.trim() || null
  if (!base) return null
  return `${base}:${String(action || '').trim().toUpperCase()}`
}

export async function batchChangeSimStatus({
  supabase,
  iccids,
  tenantQs,
  enterpriseId,
  action,
  reason,
  actor,
  traceId,
  sourceIp,
  pushSimStatusToUpstream,
  commitmentExempt,
  batchId,
  fileHash,
}: {
  supabase: SupabaseClient
  iccids: string[]
  tenantQs: string
  enterpriseId: string | null
  action: string
  reason?: string | null
  actor?: {
    userId?: string | null
    resellerId?: string | null
    role?: string | null
    roleScope?: string | null
  } | null
  traceId?: string | null
  sourceIp?: string | null
  pushSimStatusToUpstream?: (input: { iccid: string; status: string; traceId?: string | null; supplierId?: string | null }) => Promise<unknown>
  commitmentExempt?: boolean
  /** Optional; duplicate completed batch with same key + action → 409 DUPLICATE_BATCH. */
  batchId?: string | null
  /** CSV SHA-256; used when batchId omitted (multipart CSV upload). */
  fileHash?: string | null
}) {
  const actionValue = String(action || '').trim().toUpperCase()
  const actionMap = {
    ACTIVATE: {
      targetStatus: 'ACTIVATED',
      allowedFrom: new Set(['INVENTORY', 'TEST_READY', 'DEACTIVATED']),
      requireReason: false,
      jobAction: 'SIM_ACTIVATE',
    },
    DEACTIVATE: {
      targetStatus: 'DEACTIVATED',
      allowedFrom: new Set(['ACTIVATED', 'TEST_READY']),
      requireReason: true,
      jobAction: 'SIM_DEACTIVATE',
    },
    REACTIVATE: {
      targetStatus: 'ACTIVATED',
      allowedFrom: new Set(['DEACTIVATED']),
      requireReason: false,
      jobAction: 'SIM_REACTIVATE',
    },
    RETIRE: {
      targetStatus: 'RETIRED',
      allowedFrom: new Set(['DEACTIVATED']),
      requireReason: true,
      jobAction: 'SIM_RETIRE',
    },
    MARK_TEST_READY: {
      targetStatus: 'TEST_READY',
      allowedFrom: new Set(['INVENTORY']),
      requireReason: true,
      syncMarkTestReady: true,
    },
  }
  const policy = actionMap[actionValue as keyof typeof actionMap]
  if (!policy) {
    return toError(
      400,
      'BAD_REQUEST',
      'action must be one of ACTIVATE, DEACTIVATE, REACTIVATE, RETIRE, MARK_TEST_READY.',
    )
  }
  if (policy.requireReason && !reason) {
    return toError(400, 'BAD_REQUEST', 'reason is required.')
  }
  if (!Array.isArray(iccids) || iccids.length === 0) {
    return toError(400, 'BAD_REQUEST', 'iccids must be a non-empty array.')
  }
  if (iccids.length > 100) {
    return toError(400, 'BAD_REQUEST', 'iccids must not exceed 100 items.')
  }

  const idempotencyKey = resolveBatchStatusChangeIdempotencyKey(batchId, fileHash, actionValue)
  if (idempotencyKey) {
    const existing = await findIdempotentJobByKey(supabase, SIM_BATCH_STATUS_CHANGE_JOB_TYPE, idempotencyKey)
    if (existing) {
      return toError(409, 'DUPLICATE_BATCH', 'Duplicate batch status change request.')
    }
  }

  const results: Array<Record<string, any>> = []
  let succeeded = 0
  let failed = 0
  let idempotentCount = 0
  for (const raw of iccids) {
    const simValue = String(raw || '').trim()
    const simIdentifier = parseSimIdentifier(simValue)
    if (!simIdentifier.ok) {
      const errorCode =
        simIdentifier.code === 'BAD_REQUEST' ? batchErrorCodes.INVALID_SIM_ID : simIdentifier.code
      results.push({
        input: simValue,
        ok: false,
        errorCode,
        errorMessage: simIdentifier.message,
      })
      failed += 1
      await supabase.insert(
        'audit_logs',
        {
          actor_user_id: actorUserIdForDb(actor?.userId),
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
        },
        { returning: 'minimal' }
      )
      await insertBatchEvent({
        supabase,
        eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        enterpriseId: null,
        resellerId: null,
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
      await supabase.insert(
        'audit_logs',
        {
          actor_user_id: actorUserIdForDb(actor?.userId),
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
        },
        { returning: 'minimal' }
      )
      await insertBatchEvent({
        supabase,
        eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        enterpriseId: null,
        resellerId: null,
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
        targetStatus: policy.targetStatus,
        lifecycleSubStatus: sim.lifecycle_sub_status || 'normal',
      })
      succeeded += 1
      idempotentCount += 1
      await supabase.insert(
        'audit_logs',
        {
          actor_user_id: actorUserIdForDb(actor?.userId),
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
        },
        { returning: 'minimal' }
      )
      await insertBatchEvent({
        supabase,
        eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        enterpriseId: sim.enterprise_id ? String(sim.enterprise_id) : null,
        resellerId: sim.reseller_id ? String(sim.reseller_id) : null,
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
      await supabase.insert(
        'audit_logs',
        {
          actor_user_id: actorUserIdForDb(actor?.userId),
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
        },
        { returning: 'minimal' }
      )
      await insertBatchEvent({
        supabase,
        eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
        enterpriseId: sim.enterprise_id ? String(sim.enterprise_id) : null,
        resellerId: sim.reseller_id ? String(sim.reseller_id) : null,
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
      const enterpriseStatus = await loadEnterpriseStatus(supabase, sim.enterprise_id ? String(sim.enterprise_id) : null)
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
        await supabase.insert(
          'audit_logs',
          {
            actor_user_id: actorUserIdForDb(actor?.userId),
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
          },
          { returning: 'minimal' }
        )
        await insertBatchEvent({
          supabase,
          eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
          enterpriseId: sim.enterprise_id ? String(sim.enterprise_id) : null,
        resellerId: sim.reseller_id ? String(sim.reseller_id) : null,
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
      const blockedUntil = await findCommitmentBlockUntil(supabase, String(sim.sim_id))
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
        await supabase.insert(
          'audit_logs',
          {
            actor_user_id: actorUserIdForDb(actor?.userId),
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
          },
          { returning: 'minimal' }
        )
        await insertBatchEvent({
          supabase,
          eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
          enterpriseId: sim.enterprise_id ? String(sim.enterprise_id) : null,
        resellerId: sim.reseller_id ? String(sim.reseller_id) : null,
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
    let changeResult: Awaited<ReturnType<typeof changeSimStatus>>
    if ('syncMarkTestReady' in policy && policy.syncMarkTestReady) {
      changeResult = await markSimTestReady({
        supabase,
        simIdentifier,
        tenantQs,
        reason: reason ?? null,
        idempotencyKey: null,
        actor: actor ?? undefined,
        traceId: traceId ?? null,
        sourceIp: sourceIp ?? null,
      })
    } else if ('jobAction' in policy) {
      changeResult = await changeSimStatus({
        supabase,
        simIdentifier,
        tenantQs,
        action: policy.jobAction,
        newStatus: policy.targetStatus,
        allowedFrom: policy.allowedFrom,
        reason: reason ?? null,
        idempotencyKey: null,
        actor: actor ?? undefined,
        traceId: traceId ?? null,
        sourceIp: sourceIp ?? null,
        pushSimStatusToUpstream,
        commitmentExempt,
      })
    } else {
      changeResult = toError(400, 'BAD_REQUEST', 'unsupported batch action.')
    }
    if (!changeResult.ok) {
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: false,
        errorCode: changeResult.code,
        errorMessage: changeResult.message,
        beforeStatus: sim.status,
        targetStatus: policy.targetStatus,
      })
      failed += 1
    } else {
      const acceptedSim = (changeResult as {
        sim?: { lifecycleSubStatus?: string | null; status?: string; targetStatus?: string }
      }).sim
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: true,
        jobId: 'jobId' in changeResult ? changeResult.jobId : null,
        beforeStatus: sim.status,
        targetStatus: acceptedSim?.targetStatus ?? policy.targetStatus,
        lifecycleSubStatus:
          'syncMarkTestReady' in policy && policy.syncMarkTestReady
            ? 'normal'
            : (acceptedSim?.lifecycleSubStatus ?? null),
      })
      succeeded += 1
    }
    const ok = changeResult.ok
    let rowResellerId: string | null = null
    if (sim.enterprise_id) {
      rowResellerId = await resolveResellerTenantIdFromContext(supabase, sim.enterprise_id)
    }
    await supabase.insert(
      'audit_logs',
      {
        actor_user_id: actorUserIdForDb(actor?.userId),
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
          ...(rowResellerId ? { resellerId: rowResellerId } : {}),
        },
      },
      { returning: 'minimal' }
    )
    await insertBatchEvent({
      supabase,
      eventType: 'SIM_BATCH_STATUS_CHANGE_RESULT',
      enterpriseId: sim.enterprise_id ? String(sim.enterprise_id) : null,
      resellerId: sim.reseller_id ? String(sim.reseller_id) : rowResellerId ?? null,
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
          ...(rowResellerId ? { resellerId: rowResellerId } : {}),
        },
      },
    })
  }
  const batchSummaryResellerId = enterpriseId
    ? await resolveResellerTenantIdFromContext(supabase, enterpriseId)
    : null
  await supabase.insert(
    'audit_logs',
    {
      actor_user_id: actorUserIdForDb(actor?.userId),
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
          total: iccids.length,
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
        ...(batchSummaryResellerId ? { resellerId: batchSummaryResellerId } : {}),
      },
    },
    { returning: 'minimal' }
  )
  await insertBatchEvent({
    supabase,
    eventType: 'SIM_BATCH_STATUS_CHANGE',
    enterpriseId: enterpriseId ?? null,
    resellerId: batchSummaryResellerId ?? null,
    requestId: traceId ?? null,
    payload: {
      beforeData: {
        action: actionValue,
        targetStatus: policy.targetStatus,
        enterpriseId,
        requested: {
          total: iccids.length,
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
        ...(batchSummaryResellerId ? { resellerId: batchSummaryResellerId } : {}),
      },
    },
  })

  const finishedAt = new Date().toISOString()
  if (idempotencyKey) {
    await supabase.insert(
      'jobs',
      {
        job_type: SIM_BATCH_STATUS_CHANGE_JOB_TYPE,
        status: 'SUCCEEDED',
        progress_processed: results.length,
        progress_total: iccids.length,
        request_id: traceId ?? null,
        actor_user_id: actorUserIdForDb(actor?.userId),
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        reseller_id: actor?.resellerId ?? null,
        enterprise_id: enterpriseId ?? null,
        idempotency_key: idempotencyKey,
        file_hash: fileHash?.trim() ? fileHash.trim() : null,
        payload: {
          batchId: batchId?.trim() || null,
          fileHash: fileHash?.trim() || null,
          action: actionValue,
          targetStatus: policy.targetStatus,
          total: results.length,
          succeeded,
          failed,
          idempotent: idempotentCount,
        },
        started_at: finishedAt,
        finished_at: finishedAt,
      },
      { returning: 'minimal' }
    )
  }

  return {
    ok: true as const,
    action: actionValue,
    targetStatus: policy.targetStatus,
    total: results.length,
    succeeded,
    failed,
    idempotent: idempotentCount,
    items: results,
  }
}

export async function assignInventorySimsToEnterprise({
  supabase,
  resellerId,
  enterpriseId,
  simIds,
  actor,
  traceId,
  sourceIp,
  batchId,
  fileHash,
}: {
  supabase: SupabaseClient
  resellerId: string
  enterpriseId: string
  simIds: string[]
  actor?: {
    userId?: string | null
    resellerId?: string | null
    role?: string | null
    roleScope?: string | null
  } | null
  traceId?: string | null
  sourceIp?: string | null
  /** Same semantics as POST /sims/import-jobs: optional idempotency key; duplicate → 409 DUPLICATE_BATCH. */
  batchId?: string | null
  /** SHA-256 hex of uploaded CSV bytes; used as idempotency key when batchId is omitted (same as import-jobs). */
  fileHash?: string | null
}) {
  const tid = String(resellerId || '').trim()
  const eid = String(enterpriseId || '').trim()
  if (!tid || !isValidUuid(tid)) {
    return toError(400, 'BAD_REQUEST', 'resellerId is required and must be a valid uuid.')
  }
  if (!eid || !isValidUuid(eid)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const enterpriseOk = await validateAssignTargetEnterprise(supabase, tid, eid)
  if (!enterpriseOk.ok) {
    return enterpriseOk
  }
  if (!Array.isArray(simIds) || simIds.length === 0) {
    return toError(400, 'BAD_REQUEST', 'simIds must be a non-empty array.')
  }
  if (simIds.length > 100) {
    return toError(400, 'BAD_REQUEST', 'simIds must not exceed 100 items.')
  }

  const idempotencyKey = batchId?.trim() ? batchId.trim() : fileHash?.trim() ? fileHash.trim() : null
  if (idempotencyKey) {
    const existingJobs = await supabase.select(
      'jobs',
      `select=job_id,created_at,status&job_type=eq.SIM_ASSIGN_INVENTORY&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`
    )
    const existingJob = Array.isArray(existingJobs) ? existingJobs[0] : null
    if (existingJob) {
      return toError(409, 'DUPLICATE_BATCH', 'Duplicate batch import.')
    }
  }

  const startedAt = new Date().toISOString()
  const jobRows = await insertJobWithFallback(supabase, {
    job_type: 'SIM_ASSIGN_INVENTORY',
    status: 'RUNNING',
    progress_processed: 0,
    progress_total: simIds.length,
    request_id: traceId ?? null,
    actor_user_id: actorUserIdForDb(actor?.userId),
    actor_role: actor?.role ?? actor?.roleScope ?? null,
    reseller_id: tid,
    enterprise_id: eid,
    idempotency_key: idempotencyKey,
    file_hash: fileHash?.trim() ? fileHash.trim() : null,
    payload: {
      batchId: batchId?.trim() || null,
      fileHash: fileHash?.trim() || null,
      resellerId: tid,
      enterpriseId: eid,
      totalRows: simIds.length,
    },
    started_at: startedAt,
  })
  let job = Array.isArray(jobRows) ? (jobRows[0] as Record<string, any>) : null
  let jobId = job?.job_id ? String(job.job_id) : null
  // Prefer return=representation can be empty on some PostgREST setups — recover by idempotency lookup.
  if (!jobId && idempotencyKey) {
    const recovered = await supabase.select(
      'jobs',
      `select=job_id&job_type=eq.SIM_ASSIGN_INVENTORY&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&order=created_at.desc&limit=1`
    )
    const row = Array.isArray(recovered) ? (recovered[0] as { job_id?: string } | undefined) : null
    jobId = row?.job_id ? String(row.job_id) : null
  }

  const hasResellerCol = await detectSimsHasResellerIdColumn(supabase)
  const ownerIds = await resolveInventoryResellerOwnerIds(supabase, tid)
  const results: Array<Record<string, unknown>> = []
  let succeeded = 0
  let failed = 0
  let skippedCount = 0
  let processed = 0

  const bumpJobProgress = async () => {
    if (!jobId) return
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(jobId)}`,
      {
        progress_processed: processed,
        progress_total: simIds.length,
      },
      { returning: 'minimal' }
    )
  }

  const pushItemAudit = async (
    simValue: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    tenantForAudit: string | null
  ) => {
    await supabase.insert(
      'audit_logs',
      {
        actor_user_id: actorUserIdForDb(actor?.userId),
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        tenant_id: tenantForAudit,
        action: 'SIM_ASSIGN_INVENTORY_RESULT',
        target_type: 'SIM',
        target_id: simValue,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        before_data: before,
        after_data: after,
      },
      { returning: 'minimal' }
    )
    await insertBatchEvent({
      supabase,
      eventType: 'SIM_ASSIGN_INVENTORY_RESULT',
      enterpriseId: tenantForAudit,
      requestId: traceId ?? null,
      payload: { beforeData: before, afterData: after },
    })
  }

  for (const raw of simIds) {
    try {
    const simValue = String(raw || '').trim()
    const simIdentifier = parseSimIdentifier(simValue)
    if (!simIdentifier.ok) {
      const errorCode =
        simIdentifier.code === 'BAD_REQUEST' ? batchErrorCodes.INVALID_SIM_ID : simIdentifier.code
      results.push({
        input: simValue,
        ok: false,
        errorCode,
        errorMessage: simIdentifier.message,
      })
      failed += 1
      await pushItemAudit(
        simValue,
        {
          input: simValue,
          resellerId: tid,
          enterpriseId: eid,
        },
        {
          result: 'FAILED',
          errorCode,
          errorMessage: simIdentifier.message,
        },
        null
      )
      continue
    }
    const sim = await loadSimRowForInventoryAssign(supabase, simIdentifier.field, simIdentifier.value, hasResellerCol)
    if (!sim) {
      results.push({
        input: simValue,
        ok: false,
        errorCode: batchErrorCodes.RESOURCE_NOT_FOUND,
        errorMessage: 'sim not found.',
      })
      failed += 1
      await pushItemAudit(
        simValue,
        { input: simValue, resellerId: tid, enterpriseId: eid },
        { result: 'FAILED', errorCode: batchErrorCodes.RESOURCE_NOT_FOUND, errorMessage: 'sim not found.' },
        null
      )
      continue
    }
    const curEnterprise = sim.enterprise_id != null && sim.enterprise_id !== '' ? String(sim.enterprise_id) : ''
    if (curEnterprise) {
      const onOtherEnterprise = curEnterprise !== eid
      const skipMessage = onOtherEnterprise
        ? 'SIM already assigned to an enterprise. Transfer to another enterprise under the same reseller is not supported yet.'
        : 'SIM already assigned to an enterprise; no duplicate assignment performed.'
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: true,
        skipped: true,
        currentEnterpriseId: curEnterprise,
        targetEnterpriseId: eid,
        transferNotSupported: onOtherEnterprise,
        message: skipMessage,
      })
      skippedCount += 1
      await pushItemAudit(
        simValue,
        {
          input: simValue,
          simId: sim.sim_id,
          iccid: sim.iccid,
          resellerId: tid,
          enterpriseId: eid,
          currentEnterpriseId: curEnterprise,
        },
        {
          result: 'SKIPPED',
          reason: 'ALREADY_ASSIGNED',
          transferNotSupported: onOtherEnterprise,
          message: skipMessage,
        },
        curEnterprise
      )
      continue
    }
    if (String(sim.status || '').toUpperCase() !== 'INVENTORY') {
      const msg = 'sim must be INVENTORY to assign from reseller pool.'
      results.push({
        input: simValue,
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: false,
        errorCode: batchErrorCodes.INVALID_STATE,
        errorMessage: msg,
      })
      failed += 1
      await pushItemAudit(
        simValue,
        { input: simValue, simId: sim.sim_id, iccid: sim.iccid, resellerId: tid, enterpriseId: eid },
        { result: 'FAILED', errorCode: batchErrorCodes.INVALID_STATE, errorMessage: msg },
        null
      )
      continue
    }
    if (hasResellerCol) {
      const rid = sim.reseller_id != null && sim.reseller_id !== '' ? String(sim.reseller_id) : ''
      if (rid && !ownerIds.has(rid)) {
        const msg = 'sim does not belong to this reseller inventory.'
        results.push({
          input: simValue,
          simId: sim.sim_id,
          iccid: sim.iccid,
          ok: false,
          errorCode: batchErrorCodes.WRONG_RESELLER,
          errorMessage: msg,
        })
        failed += 1
        await pushItemAudit(
          simValue,
          { input: simValue, simId: sim.sim_id, iccid: sim.iccid, resellerId: tid, enterpriseId: eid },
          { result: 'FAILED', errorCode: batchErrorCodes.WRONG_RESELLER, errorMessage: msg },
          null
        )
        continue
      }
    }
    await supabase.update(
      'sims',
      `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
      { enterprise_id: eid },
      { returning: 'minimal' }
    )
    results.push({
      simId: sim.sim_id,
      iccid: sim.iccid,
      ok: true,
      enterpriseId: eid,
    })
    succeeded += 1
    await pushItemAudit(
      simValue,
      {
        input: simValue,
        simId: sim.sim_id,
        iccid: sim.iccid,
        resellerId: tid,
        enterpriseId: eid,
        beforeEnterpriseId: curEnterprise || null,
      },
      { result: 'SUCCEEDED', enterpriseId: eid },
      eid
    )
    } finally {
      processed += 1
      if (processed % 20 === 0 || processed === simIds.length) await bumpJobProgress()
    }
  }

  await supabase.insert(
    'audit_logs',
    {
      actor_user_id: actorUserIdForDb(actor?.userId),
      actor_role: actor?.role ?? actor?.roleScope ?? null,
      tenant_id: eid,
      action: 'SIM_ASSIGN_INVENTORY',
      target_type: 'SIM_BATCH',
      target_id: null,
      request_id: traceId ?? null,
      source_ip: sourceIp ?? null,
      before_data: {
        resellerId: tid,
        enterpriseId: eid,
        requested: { total: simIds.length },
      },
      after_data: {
        resellerId: tid,
        enterpriseId: eid,
        total: simIds.length,
        succeeded,
        failed,
        skipped: skippedCount,
        jobId,
      },
    },
    { returning: 'minimal' }
  )
  await insertBatchEvent({
    supabase,
    eventType: 'SIM_ASSIGN_INVENTORY',
    enterpriseId: eid,
    requestId: traceId ?? null,
    payload: {
      beforeData: { resellerId: tid, enterpriseId: eid, requested: { total: simIds.length } },
      afterData: {
        resellerId: tid,
        enterpriseId: eid,
        total: simIds.length,
        succeeded,
        failed,
        skipped: skippedCount,
        jobId,
      },
    },
  })

  const finishedAt = new Date().toISOString()
  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(jobId)}`,
      {
        status: failed > 0 && succeeded === 0 ? 'FAILED' : 'SUCCEEDED',
        progress_processed: processed,
        progress_total: simIds.length,
        finished_at: finishedAt,
        payload: {
          batchId: batchId?.trim() || null,
          fileHash: fileHash?.trim() || null,
          resellerId: tid,
          enterpriseId: eid,
          totalRows: simIds.length,
          succeeded,
          failed,
          skipped: skippedCount,
        },
        ...(failed > 0 && succeeded === 0
          ? { error_summary: `All ${failed} items failed.` }
          : {}),
      },
      { returning: 'minimal' }
    )
  }

  return {
    ok: true as const,
    jobId,
    resellerId: tid,
    enterpriseId: eid,
    total: simIds.length,
    succeeded,
    failed,
    skipped: skippedCount,
    items: results,
  }
}

export async function assignEnterpriseSimsToDepartment({
  supabase,
  enterpriseId,
  departmentId,
  iccids,
  actor,
  traceId,
  sourceIp,
  batchId,
  fileHash,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  departmentId: string
  iccids: string[]
  actor?: {
    userId?: string | null
    resellerId?: string | null
    role?: string | null
    roleScope?: string | null
  } | null
  traceId?: string | null
  sourceIp?: string | null
  batchId?: string | null
  fileHash?: string | null
}) {
  const eid = String(enterpriseId || '').trim()
  const did = String(departmentId || '').trim()
  if (!eid || !isValidUuid(eid)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  if (!did || !isValidUuid(did)) {
    return toError(400, 'BAD_REQUEST', 'departmentId is required and must be a valid uuid.')
  }
  const enterpriseOk = await validateAssignTargetEnterpriseForDepartment(supabase, eid)
  if (!enterpriseOk.ok) {
    return enterpriseOk
  }
  const departmentOk = await validateAssignTargetDepartment(supabase, eid, did)
  if (!departmentOk.ok) {
    return departmentOk
  }
  if (!Array.isArray(iccids) || iccids.length === 0) {
    return toError(400, 'BAD_REQUEST', 'iccids must be a non-empty array.')
  }
  if (iccids.length > 100) {
    return toError(400, 'BAD_REQUEST', 'iccids must not exceed 100 items.')
  }

  const idempotencyKey = batchId?.trim() ? batchId.trim() : fileHash?.trim() ? fileHash.trim() : null
  if (idempotencyKey) {
    const existingJobs = await supabase.select(
      'jobs',
      `select=job_id,created_at,status&job_type=eq.SIM_ASSIGN_DEPARTMENT&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`
    )
    const existingJob = Array.isArray(existingJobs) ? existingJobs[0] : null
    if (existingJob) {
      return toError(409, 'DUPLICATE_BATCH', 'Duplicate batch import.')
    }
  }

  const results: Array<Record<string, unknown>> = []
  let succeeded = 0
  let failed = 0
  let skippedCount = 0

  const pushItemAudit = async (
    simValue: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    tenantForAudit: string | null
  ) => {
    await supabase.insert(
      'audit_logs',
      {
        actor_user_id: actorUserIdForDb(actor?.userId),
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        tenant_id: tenantForAudit,
        action: 'SIM_ASSIGN_DEPARTMENT_RESULT',
        target_type: 'SIM',
        target_id: simValue,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        before_data: before,
        after_data: after,
      },
      { returning: 'minimal' }
    )
    await insertBatchEvent({
      supabase,
      eventType: 'SIM_ASSIGN_DEPARTMENT_RESULT',
      enterpriseId: tenantForAudit,
      requestId: traceId ?? null,
      payload: { beforeData: before, afterData: after },
    })
  }

  for (const raw of iccids) {
    const iccidInput = String(raw || '').trim()
    const simIdentifier = parseSimIdentifier(iccidInput)
    if (!simIdentifier.ok) {
      const errorCode =
        simIdentifier.code === 'BAD_REQUEST' ? batchErrorCodes.INVALID_SIM_ID : simIdentifier.code
      results.push({
        simId: null,
        iccid: iccidInput,
        ok: false,
        enterpriseId: eid,
        departmentId: did,
        errorCode,
        errorMessage: simIdentifier.message,
      })
      failed += 1
      await pushItemAudit(
        iccidInput,
        { input: iccidInput, enterpriseId: eid, departmentId: did },
        { result: 'FAILED', errorCode, errorMessage: simIdentifier.message },
        eid
      )
      continue
    }
    const sim = await loadSimRowForInventoryAssign(supabase, simIdentifier.field, simIdentifier.value, false)
    if (!sim) {
      results.push({
        simId: null,
        iccid: simIdentifier.field === 'iccid' ? simIdentifier.value : iccidInput,
        ok: false,
        enterpriseId: eid,
        departmentId: did,
        errorCode: batchErrorCodes.RESOURCE_NOT_FOUND,
        errorMessage: 'sim not found.',
      })
      failed += 1
      await pushItemAudit(
        iccidInput,
        { input: iccidInput, enterpriseId: eid, departmentId: did },
        { result: 'FAILED', errorCode: batchErrorCodes.RESOURCE_NOT_FOUND, errorMessage: 'sim not found.' },
        eid
      )
      continue
    }
    const curEnterprise = sim.enterprise_id != null && sim.enterprise_id !== '' ? String(sim.enterprise_id) : ''
    if (!curEnterprise || curEnterprise !== eid) {
      const msg = curEnterprise
        ? 'sim is not assigned to this enterprise.'
        : 'sim is not assigned to an enterprise yet.'
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: false,
        enterpriseId: eid,
        departmentId: did,
        errorCode: batchErrorCodes.WRONG_ENTERPRISE,
        errorMessage: msg,
      })
      failed += 1
      await pushItemAudit(
        iccidInput,
        {
          input: iccidInput,
          simId: sim.sim_id,
          iccid: sim.iccid,
          enterpriseId: eid,
          departmentId: did,
          currentEnterpriseId: curEnterprise || null,
        },
        { result: 'FAILED', errorCode: batchErrorCodes.WRONG_ENTERPRISE, errorMessage: msg },
        eid
      )
      continue
    }
    const curDepartment =
      sim.department_id != null && sim.department_id !== '' ? String(sim.department_id) : ''
    if (curDepartment === did) {
      results.push({
        simId: sim.sim_id,
        iccid: sim.iccid,
        ok: true,
        skipped: true,
        enterpriseId: eid,
        departmentId: did,
        message: 'SIM already assigned to this department; no update performed.',
      })
      skippedCount += 1
      await pushItemAudit(
        iccidInput,
        {
          input: iccidInput,
          simId: sim.sim_id,
          iccid: sim.iccid,
          enterpriseId: eid,
          departmentId: did,
          currentDepartmentId: curDepartment,
        },
        { result: 'SKIPPED', reason: 'ALREADY_ASSIGNED', message: 'SIM already assigned to this department.' },
        eid
      )
      continue
    }
    await supabase.update(
      'sims',
      `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`,
      { department_id: did },
      { returning: 'minimal' }
    )
    results.push({
      simId: sim.sim_id,
      iccid: sim.iccid,
      ok: true,
      enterpriseId: eid,
      departmentId: did,
    })
    succeeded += 1
    await pushItemAudit(
      iccidInput,
      {
        input: iccidInput,
        simId: sim.sim_id,
        iccid: sim.iccid,
        enterpriseId: eid,
        departmentId: did,
        beforeDepartmentId: curDepartment || null,
      },
      { result: 'SUCCEEDED', enterpriseId: eid, departmentId: did },
      eid
    )
  }

  await supabase.insert(
    'audit_logs',
    {
      actor_user_id: actorUserIdForDb(actor?.userId),
      actor_role: actor?.role ?? actor?.roleScope ?? null,
      tenant_id: eid,
      action: 'SIM_ASSIGN_DEPARTMENT',
      target_type: 'SIM_BATCH',
      target_id: null,
      request_id: traceId ?? null,
      source_ip: sourceIp ?? null,
      before_data: {
        enterpriseId: eid,
        departmentId: did,
        requested: { total: iccids.length },
      },
      after_data: {
        enterpriseId: eid,
        departmentId: did,
        total: iccids.length,
        succeeded,
        failed,
        skipped: skippedCount,
      },
    },
    { returning: 'minimal' }
  )
  await insertBatchEvent({
    supabase,
    eventType: 'SIM_ASSIGN_DEPARTMENT',
    enterpriseId: eid,
    requestId: traceId ?? null,
    payload: {
      beforeData: { enterpriseId: eid, departmentId: did, requested: { total: iccids.length } },
      afterData: {
        enterpriseId: eid,
        departmentId: did,
        total: iccids.length,
        succeeded,
        failed,
        skipped: skippedCount,
      },
    },
  })

  const finishedAt = new Date().toISOString()
  if (idempotencyKey) {
    await supabase.insert(
      'jobs',
      {
        job_type: 'SIM_ASSIGN_DEPARTMENT',
        status: 'SUCCEEDED',
        progress_processed: results.length,
        progress_total: iccids.length,
        request_id: traceId ?? null,
        actor_user_id: actorUserIdForDb(actor?.userId),
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        enterprise_id: eid,
        idempotency_key: idempotencyKey,
        file_hash: fileHash?.trim() ? fileHash.trim() : null,
        payload: {
          batchId: batchId?.trim() || null,
          fileHash: fileHash?.trim() || null,
          enterpriseId: eid,
          departmentId: did,
          totalRows: iccids.length,
          succeeded,
          failed,
          skipped: skippedCount,
        },
        started_at: finishedAt,
        finished_at: finishedAt,
      },
      { returning: 'minimal' }
    )
  }

  return {
    ok: true as const,
    enterpriseId: eid,
    departmentId: did,
    total: iccids.length,
    succeeded,
    failed,
    skipped: skippedCount,
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
}: BatchDeactivateInput) {
  if (!enterpriseId || !isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const reasonText = String(reason ?? '').trim()
  if (!reasonText) {
    return toError(400, 'BAD_REQUEST', 'reason is required.')
  }
  const enterpriseRows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,enterprise_status&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const enterprise = Array.isArray(enterpriseRows)
    ? (enterpriseRows[0] as { tenant_id?: string; parent_id?: string | null; enterprise_status?: string | null; status?: string | null })
    : null
  if (!enterprise?.tenant_id) {
    return toError(404, 'RESOURCE_NOT_FOUND', `enterprise ${enterpriseId} not found.`)
  }
  if (actor?.roleScope === 'reseller' && actor.resellerId && String(enterprise.parent_id ?? '') !== String(actor.resellerId)) {
    return toError(403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
  }
  const enterpriseStatus = String(enterprise.enterprise_status ?? enterprise.status ?? '').trim().toUpperCase()
  if (enterpriseStatus !== 'SUSPENDED') {
    return toError(409, 'INVALID_ENTERPRISE_STATUS', 'Batch deactivate is only allowed for SUSPENDED enterprises.')
  }
  if (idempotencyKey) {
    const existing = await findIdempotentJobByKey(supabase, 'SIM_BATCH_DEACTIVATE', String(idempotencyKey))
    if (existing) {
      return toError(409, 'IDEMPOTENCY_CONFLICT', 'idempotencyKey has already been used.')
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
    actor_user_id: actorUserIdForDb(actor?.userId),
    reseller_id: actor?.resellerId ?? null,
    enterprise_id: enterpriseId ?? null,
    payload: {
      action: 'SIM_BATCH_DEACTIVATE',
      enterpriseId,
      reason: reasonText,
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
        reason: reasonText,
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
        actor_user_id: actorUserIdForDb(actor?.userId),
        actor_role: actor?.role ?? actor?.roleScope ?? null,
        tenant_id: enterpriseId ?? null,
        action: 'SIM_BATCH_DEACTIVATE',
        target_type: 'SIM_BATCH',
        target_id: enterpriseId,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        after_data: { enterpriseId, total: totalRows, succeeded, failed, reason: reasonText },
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
