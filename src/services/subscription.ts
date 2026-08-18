import crypto from 'node:crypto'
import { actorUserIdForDb } from '../utils/actorUserId.js'
import { enqueueSubscriptionProvisionJob } from './subscriptionProvisionJob.js'

export const SUBSCRIPTION_BATCH_CREATE_JOB_TYPE = 'SUBSCRIPTION_BATCH_CREATE'
export const SUBSCRIPTION_BATCH_EXPORT_JOB_TYPE = 'SUBSCRIPTION_BATCH_EXPORT'
export const SUBSCRIPTION_SWITCH_JOB_TYPE = 'SUBSCRIPTION_SWITCH'
export const SUBSCRIPTION_CANCEL_JOB_TYPE = 'SUBSCRIPTION_CANCEL'

export const SUBSCRIPTION_BATCH_EXPORT_PAGE_SIZE_DEFAULT = 100
export const SUBSCRIPTION_BATCH_EXPORT_PAGE_SIZE_MAX = 1000

async function recordSubscriptionCancelBatchJob(
  supabase: SupabaseClient,
  idempotencyKey: string,
  enterpriseId: string,
  subscriptionId: string,
  audit: AuditContext | undefined,
  result: Record<string, unknown>
): Promise<void> {
  const finishedAt = new Date().toISOString()
  await supabase.insert(
    'jobs',
    {
      job_type: SUBSCRIPTION_CANCEL_JOB_TYPE,
      status: 'SUCCEEDED',
      progress_processed: 1,
      progress_total: 1,
      request_id: audit?.requestId ?? null,
      actor_user_id: actorUserIdForDb(audit?.actorUserId),
      actor_role: audit?.actorRole ?? null,
      enterprise_id: enterpriseId,
      idempotency_key: idempotencyKey,
      payload: {
        batchId: idempotencyKey,
        enterpriseId,
        subscriptionId,
        result,
      },
      started_at: finishedAt,
      finished_at: finishedAt,
    },
    { returning: 'minimal', suppressMissingColumns: true }
  )
}

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  delete: (table: string, matchQueryString: string) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

type AuditContext = {
  actorUserId?: string | null
  actorRole?: string | null
  resellerId?: string | null
  customerId?: string | null
  requestId?: string | null
  sourceIp?: string | null
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function isValidIccid(value: unknown) {
  const s = String(value || '').trim()
  return /^\d{18,20}$/.test(s)
}

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

async function writeAuditLog(supabase: SupabaseClient, payload: Record<string, unknown>) {
  const actorUserId =
    payload.actor_user_id != null
      ? actorUserIdForDb(String(payload.actor_user_id))
      : null
  await supabase.insert(
    'audit_logs',
    { ...payload, actor_user_id: actorUserId },
    { returning: 'minimal' }
  )
}

function toIsoDateTime(value: unknown) {
  if (!value) return null
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function normalizeCommercialTerms(obj: unknown) {
  const t = obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {}
  const v = (k: string) => (t[k] !== undefined && t[k] !== null ? t[k] : undefined)
  const n = (x: unknown) => {
    const y = Number(x)
    return Number.isFinite(y) && y >= 0 ? y : undefined
  }
  const up = (s: unknown) => (typeof s === 'string' ? s.toUpperCase() : undefined)
  const commitmentPeriodMonths =
    n(v('commitmentPeriodMonths')) ?? n(v('commitment_period_months')) ?? n(v('commitmentMonths'))
  const commitmentPeriodDays =
    n(v('commitmentPeriodDays')) ?? n(v('commitment_period_days')) ?? n(v('commitmentDays'))
  const expiryBoundaryRaw =
    up(v('expiryBoundary')) ?? up(v('expiry_boundary'))
  const expiryBoundary =
    (expiryBoundaryRaw === 'CALENDAR_DAY_END' || expiryBoundaryRaw === 'DURATION_EXCLUSIVE_END')
      ? expiryBoundaryRaw
      : undefined
  return {
    commitmentPeriodMonths,
    commitmentPeriodDays,
    expiryBoundary,
  }
}

function firstDayNextMonthUtc() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0))
}

function addDaysUtc(date: Date, days: number) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function computeCommitmentEndAt(effectiveAtIso: string, terms: ReturnType<typeof normalizeCommercialTerms>) {
  try {
    const base = new Date(effectiveAtIso)
    const months = Number(terms.commitmentPeriodMonths ?? 0)
    const days = Number(terms.commitmentPeriodDays ?? 0)
    if (Number.isFinite(months) && months > 0) {
      const y = base.getUTCFullYear()
      const m = base.getUTCMonth()
      const d = base.getUTCDate()
      return new Date(Date.UTC(m + months >= 12 ? y + Math.floor((m + months) / 12) : y, (m + months) % 12, d, base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds())).toISOString()
    }
    if (Number.isFinite(days) && days > 0) {
      return addDaysUtc(base, days).toISOString()
    }
  } catch {
    return null
  }
  return null
}

function computeOneTimeExpiry(effectiveAtIso: string, validityDays: number | null, expiryBoundary?: string) {
  const days = Number(validityDays ?? 0)
  if (!effectiveAtIso || !Number.isFinite(days) || days < 1) return null
  const base = new Date(effectiveAtIso)
  if (Number.isNaN(base.getTime())) return null
  if (expiryBoundary === 'DURATION_EXCLUSIVE_END') {
    return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
  }
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (days - 1), 23, 59, 59, 999)
  return end.toISOString()
}

async function loadEnterpriseStatus(supabase: SupabaseClient, enterpriseId: string | null) {
  if (!enterpriseId) return null
  const rows = await supabase.select(
    'tenants',
    `select=enterprise_status&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  return row?.enterprise_status ? String(row.enterprise_status) : null
}

async function loadSimByIccid(supabase: SupabaseClient, iccid: string, tenantFilter: string) {
  const rows = await supabase.select(
    'sims',
    `select=sim_id,enterprise_id,status,iccid,supplier_id,operator_id&iccid=eq.${encodeURIComponent(iccid)}${tenantFilter}&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
}

async function loadPackageCarrierContext(supabase: SupabaseClient, packageId: string) {
  const pkgRows = await supabase.select(
    'packages',
    `select=package_id,carrier_service_id&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  const pkg = Array.isArray(pkgRows) ? (pkgRows[0] as Record<string, unknown>) : null
  const carrierServiceId = pkg?.carrier_service_id ? String(pkg.carrier_service_id).trim() : ''
  if (!carrierServiceId) return null
  const csRows = await supabase.select(
    'carrier_service_modules',
    `select=supplier_id,operator_id&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const cs = Array.isArray(csRows) ? (csRows[0] as Record<string, unknown>) : null
  if (!cs?.supplier_id) return null
  return {
    supplierId: String(cs.supplier_id),
    operatorId: cs.operator_id ? String(cs.operator_id) : null,
  }
}

async function loadVendorMappingForPackage(supabase: SupabaseClient, packageId: string) {
  const rows = await supabase.select(
    'vendor_product_mappings',
    `select=mapping_id,supplier_id,external_product_id,provisioning_parameters&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
}

async function loadSellablePackage(supabase: SupabaseClient, packageId: string) {
  const rows = await supabase.select(
    'packages',
    `select=package_id,status,commercial_terms_id,price_plan_id,effective_from&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  const pkg = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  if (!pkg) return null
  const ctid = pkg.commercial_terms_id ? String(pkg.commercial_terms_id).trim() : ''
  let commercial_terms: unknown = {}
  if (ctid) {
    const ctRows = await supabase.select(
      'commercial_terms_modules',
      `select=commercial_terms&commercial_terms_id=eq.${encodeURIComponent(ctid)}&limit=1`
    )
    const ct = Array.isArray(ctRows) ? (ctRows[0] as Record<string, unknown>) : null
    commercial_terms = ct?.commercial_terms ?? {}
  }
  return { ...pkg, commercial_terms } as Record<string, unknown>
}

function parseSubscriptionCreateKind(
  kind: unknown
): { value: 'MAIN' | 'ADD_ON' } | { error: ServiceResult<never> } {
  if (kind === undefined) {
    return { value: 'MAIN' }
  }
  if (kind === null) {
    return { error: toError(400, 'BAD_REQUEST', 'kind must be MAIN or ADD_ON.') }
  }
  const raw = String(kind).trim()
  if (raw === '') {
    return { error: toError(400, 'BAD_REQUEST', 'kind must be MAIN or ADD_ON.') }
  }
  const upper = raw.toUpperCase()
  if (upper === 'MAIN' || upper === 'ADD_ON') {
    return { value: upper }
  }
  return { error: toError(400, 'BAD_REQUEST', 'kind must be MAIN or ADD_ON.') }
}

function requirePublishedPackageForSubscribe(
  pkg: Record<string, unknown> | null,
  pkgId: string
): { error: ServiceResult<never> } | { pkg: Record<string, unknown> } {
  if (!pkg) {
    return { error: toError(404, 'PACKAGE_NOT_FOUND', `package ${pkgId} not found.`) }
  }
  const status = String(pkg.status || '').toUpperCase()
  if (status !== 'PUBLISHED') {
    return {
      error: toError(
        409,
        'INVALID_STATUS',
        `Package status is ${status}; only PUBLISHED packages can be subscribed.`
      ),
    }
  }
  return { pkg }
}

async function loadPricePlanVersion(supabase: SupabaseClient, pricePlanId: string) {
  const rows = await supabase.select(
    'price_plans_expanded',
    `select=price_plan_id,type,validity_days,expiry_boundary&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  const v = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  if (!v?.price_plan_id) return null
  return { version: v, plan: v }
}

async function loadLatestPricePlanVersionByPlanId(supabase: SupabaseClient, pricePlanId: string) {
  const rows = await supabase.select(
    'price_plans_expanded',
    `select=price_plan_id,type,validity_days,expiry_boundary&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  const v = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  if (!v?.price_plan_id) return null
  return { version: v, plan: v }
}

function resolveExpiryBoundary(
  terms: ReturnType<typeof normalizeCommercialTerms>,
  pricePlanRow: Record<string, unknown> | null | undefined
) {
  const fromPlan = pricePlanRow
    ? String((pricePlanRow as any).expiry_boundary ?? '').trim().toUpperCase()
    : ''
  if (fromPlan === 'CALENDAR_DAY_END' || fromPlan === 'DURATION_EXCLUSIVE_END') return fromPlan
  return terms.expiryBoundary
}

export async function createSubscription({
  supabase,
  enterpriseId,
  iccid,
  packageId,
  kind,
  effectiveAt,
  tenantFilter,
  audit,
  allowCoexistentActiveMain,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  iccid: unknown
  packageId?: unknown
  kind?: unknown
  effectiveAt?: unknown
  tenantFilter: string
  audit?: AuditContext
  /** Switch-only: allow PENDING future MAIN while ACTIVE MAIN remains until scheduled cancel. */
  allowCoexistentActiveMain?: boolean
}): Promise<
  ServiceResult<{
    subscriptionId: string | null
    jobId: string | null
    packageId: string | null
    state: string
    effectiveAt: string
    expiresAt: string | null
    commitmentEndAt: string | null
  }>
> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const iccidValue = String(iccid || '').trim()
  if (!isValidIccid(iccidValue)) {
    return toError(400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
  }
  const pkgId = String(packageId ?? '').trim()
  if (!isValidUuid(pkgId)) {
    return toError(400, 'BAD_REQUEST', 'packageId is required and must be a valid uuid.')
  }
  const kindParsed = parseSubscriptionCreateKind(kind)
  if ('error' in kindParsed) return kindParsed.error
  const subKind = kindParsed.value
  const sim = await loadSimByIccid(supabase, iccidValue, tenantFilter)
  if (!sim) {
    return toError(404, 'SIM_NOT_FOUND', `sim ${iccidValue} not found.`)
  }
  if (String(sim.enterprise_id) !== String(enterpriseId)) {
    return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
  }
  if (String(sim.status || '').toUpperCase() === 'RETIRED') {
    return toError(409, 'SIM_RETIRED', 'SIM is retired.')
  }
  const simSupplierId = sim.supplier_id ? String(sim.supplier_id).trim() : ''
  if (!simSupplierId || !isValidUuid(simSupplierId)) {
    return toError(409, 'MISSING_SUPPLIER', 'SIM supplier is not assigned.')
  }
  const enterpriseStatus = await loadEnterpriseStatus(supabase, enterpriseId)
  if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
    return toError(409, 'ENTERPRISE_SUSPENDED', 'Enterprise is not active.')
  }
  const pkgLoaded = await loadSellablePackage(supabase, pkgId)
  const pkgCheck = requirePublishedPackageForSubscribe(pkgLoaded, pkgId)
  if ('error' in pkgCheck) return pkgCheck.error
  const pkg = pkgCheck.pkg
  const carrierCtx = await loadPackageCarrierContext(supabase, pkgId)
  if (!carrierCtx) {
    return toError(404, 'PACKAGE_NOT_FOUND', 'Package carrier service context not found.')
  }
  if (simSupplierId !== carrierCtx.supplierId) {
    return toError(409, 'PACKAGE_SUPPLIER_MISMATCH', 'SIM supplier does not match Package carrier service supplier.')
  }
  const simOperatorId = sim.operator_id ? String(sim.operator_id).trim() : ''
  if (carrierCtx.operatorId && simOperatorId && simOperatorId !== carrierCtx.operatorId) {
    return toError(409, 'PACKAGE_OPERATOR_MISMATCH', 'SIM operator does not match Package carrier service operator.')
  }
  const mapping = await loadVendorMappingForPackage(supabase, pkgId)
  if (!mapping?.external_product_id) {
    return toError(404, 'VENDOR_PRODUCT_MAPPING_NOT_FOUND', 'Vendor product mapping not found for package.')
  }
  if (String(mapping.supplier_id ?? '') !== carrierCtx.supplierId) {
    return toError(404, 'VENDOR_PRODUCT_MAPPING_NOT_FOUND', 'Vendor product mapping supplier mismatch.')
  }
  const effectiveIso = toIsoDateTime(effectiveAt) ?? new Date().toISOString()
  if (!effectiveIso) {
    return toError(400, 'BAD_REQUEST', 'effectiveAt must be a valid date-time.')
  }
  const now = new Date()
  const isImmediate = new Date(effectiveIso).getTime() <= now.getTime()
  if (subKind === 'MAIN') {
    if (allowCoexistentActiveMain) {
      if (isImmediate) {
        return toError(
          400,
          'BAD_REQUEST',
          'allowCoexistentActiveMain requires a future effectiveAt (next-cycle switch).'
        )
      }
      const pendingMain = await supabase.select(
        'subscriptions',
        `select=subscription_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=eq.PENDING&subscription_kind=eq.MAIN&limit=1`
      )
      if (Array.isArray(pendingMain) && pendingMain.length > 0) {
        return toError(409, 'MAIN_SUBSCRIPTION_EXISTS', 'SIM already has a PENDING MAIN subscription.')
      }
    } else {
      const blocking = await supabase.select(
        'subscriptions',
        `select=subscription_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=in.(ACTIVE,PROVISIONING)&subscription_kind=eq.MAIN&limit=1`
      )
      if (Array.isArray(blocking) && blocking.length > 0) {
        return toError(409, 'MAIN_SUBSCRIPTION_EXISTS', 'SIM already has an ACTIVE or PROVISIONING MAIN subscription.')
      }
      if (isImmediate) {
        const pendingMain = await supabase.select(
          'subscriptions',
          `select=subscription_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=eq.PENDING&subscription_kind=eq.MAIN&limit=1`
        )
        if (Array.isArray(pendingMain) && pendingMain.length > 0) {
          return toError(409, 'MAIN_SUBSCRIPTION_EXISTS', 'SIM already has a PENDING MAIN subscription.')
        }
      }
    }
  }
  const terms = normalizeCommercialTerms(pkg.commercial_terms)
  const commitmentEndAt = computeCommitmentEndAt(effectiveIso, terms)
  let expiresAt: string | null = null
  const pp = pkg.price_plan_id
    ? await loadLatestPricePlanVersionByPlanId(supabase, String(pkg.price_plan_id))
    : null
  if (pp) {
    if (pp?.plan && String(pp.plan.type || '').toUpperCase() === 'ONE_TIME') {
      const expiryBoundary = resolveExpiryBoundary(terms, pp.version as Record<string, unknown>)
      const validityDays = Number(pp.version?.validity_days ?? 0)
      expiresAt = computeOneTimeExpiry(effectiveIso, Number.isFinite(validityDays) ? validityDays : null, expiryBoundary)
    }
  }
  const initialState = isImmediate ? 'PROVISIONING' : 'PENDING'
  const rows = await supabase.insert('subscriptions', {
    enterprise_id: enterpriseId,
    sim_id: sim.sim_id,
    subscription_kind: subKind,
    package_id: pkg.package_id,
    state: initialState,
    effective_at: effectiveIso,
    expires_at: expiresAt,
    commitment_end_at: commitmentEndAt,
    first_subscribed_at: effectiveIso,
  })
  const created = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  const subscriptionId = created?.subscription_id ? String(created.subscription_id) : null
  if (!subscriptionId) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to create subscription.')
  }
  const idempotencyKey = audit?.requestId
    ? `${audit.requestId}:${iccidValue}:${pkgId}`
    : `sub:${iccidValue}:${pkgId}:${Date.now()}`
  let jobId: string | null = null
  try {
    jobId = await enqueueSubscriptionProvisionJob({
      supabase,
      subscriptionId,
      enterpriseId,
      iccid: iccidValue,
      packageId: String(pkg.package_id ?? pkgId),
      externalProductId: String(mapping.external_product_id),
      effectiveAt: effectiveIso,
      beforeState: initialState,
      audit,
      idempotencyKey,
    })
  } catch {
    await supabase.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(subscriptionId)}`)
    return toError(500, 'INTERNAL_ERROR', 'Failed to enqueue subscription provision job.')
  }
  if (!jobId) {
    await supabase.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(subscriptionId)}`)
    return toError(500, 'INTERNAL_ERROR', 'Failed to enqueue subscription provision job.')
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: enterpriseId ?? null,
    action: 'SUBSCRIPTION_CREATED',
    target_type: 'SUBSCRIPTION',
    target_id: subscriptionId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      iccid: sim.iccid ?? iccidValue,
      simId: sim.sim_id,
      packageId: pkg.package_id,
      kind: subKind,
      state: initialState,
      jobId,
      effectiveAt: effectiveIso,
      expiresAt,
      commitmentEndAt,
    },
  })
  return {
    ok: true,
    value: {
      subscriptionId,
      jobId,
      packageId: String(pkg.package_id ?? ''),
      state: initialState,
      effectiveAt: effectiveIso,
      expiresAt,
      commitmentEndAt,
    },
  }
}

const SWITCH_FROM_SELECT =
  'subscription_id,package_id,state,subscription_kind,sim_id,enterprise_id'

function switchFromStateError(state: string): ServiceResult<never> | null {
  const normalized = String(state ?? '').toUpperCase()
  if (normalized === 'PROVISIONING') {
    return toError(
      409,
      'SUBSCRIPTION_PROVISION_IN_PROGRESS',
      'Cannot switch this subscription: a SUBSCRIPTION_PROVISION task is still in progress.'
    )
  }
  if (normalized === 'CANCELLED') {
    return toError(409, 'SUBSCRIPTION_ALREADY_CANCELLED', 'Subscription is already cancelled.')
  }
  if (normalized === 'EXPIRED') {
    return toError(409, 'SUBSCRIPTION_ALREADY_EXPIRED', 'Subscription is already expired.')
  }
  return null
}

async function resolveSwitchFromMainSubscription({
  supabase,
  simId,
  enterpriseId,
  fromSubscriptionId,
}: {
  supabase: SupabaseClient
  simId: string
  enterpriseId: string
  fromSubscriptionId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  const simIdValue = String(simId)
  const enterpriseIdValue = String(enterpriseId)

  if (fromSubscriptionId) {
    const rows = await supabase.select(
      'subscriptions',
      `select=${SWITCH_FROM_SELECT}&subscription_id=eq.${encodeURIComponent(fromSubscriptionId)}&limit=1`
    )
    const sub = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
    if (!sub?.subscription_id) {
      return toError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found.')
    }
    if (String(sub.sim_id ?? '') !== simIdValue) {
      return toError(400, 'BAD_REQUEST', 'fromSubscriptionId does not belong to this SIM.')
    }
    if (String(sub.enterprise_id ?? '') !== enterpriseIdValue) {
      return toError(403, 'FORBIDDEN', 'Subscription does not belong to your enterprise.')
    }
    if (String(sub.subscription_kind ?? '').toUpperCase() !== 'MAIN') {
      return toError(400, 'BAD_REQUEST', 'Only MAIN subscription can be switched.')
    }
    const state = String(sub.state ?? '').toUpperCase()
    const stateError = switchFromStateError(state)
    if (stateError) return stateError
    if (state !== 'ACTIVE' && state !== 'PENDING') {
      return toError(404, 'SUBSCRIPTION_NOT_FOUND', 'No switchable MAIN subscription.')
    }
    return { ok: true, value: sub }
  }

  const activeRows = await supabase.select(
    'subscriptions',
    `select=${SWITCH_FROM_SELECT}&sim_id=eq.${encodeURIComponent(simIdValue)}&state=eq.ACTIVE&subscription_kind=eq.MAIN&order=effective_at.desc&limit=1`
  )
  const active = Array.isArray(activeRows) ? (activeRows[0] as Record<string, unknown>) : null
  if (active?.subscription_id) {
    return { ok: true, value: active }
  }

  const pendingRows = await supabase.select(
    'subscriptions',
    `select=${SWITCH_FROM_SELECT}&sim_id=eq.${encodeURIComponent(simIdValue)}&state=eq.PENDING&subscription_kind=eq.MAIN&order=effective_at.desc&limit=1`
  )
  const pending = Array.isArray(pendingRows) ? (pendingRows[0] as Record<string, unknown>) : null
  if (pending?.subscription_id) {
    return { ok: true, value: pending }
  }

  const provisioningRows = await supabase.select(
    'subscriptions',
    `select=subscription_id&sim_id=eq.${encodeURIComponent(simIdValue)}&state=eq.PROVISIONING&subscription_kind=eq.MAIN&limit=1`
  )
  if (Array.isArray(provisioningRows) && provisioningRows.length > 0) {
    return switchFromStateError('PROVISIONING')!
  }

  return toError(404, 'SUBSCRIPTION_NOT_FOUND', 'No switchable MAIN subscription.')
}

export async function switchSubscription({
  supabase,
  enterpriseId,
  iccid,
  fromSubscriptionId,
  toPackageId,
  effectiveStrategy,
  tenantFilter,
  audit,
  batchId,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  iccid: unknown
  fromSubscriptionId?: unknown
  toPackageId?: unknown
  effectiveStrategy?: unknown
  tenantFilter: string
  audit?: AuditContext
  /** Optional idempotency key; duplicate → 409 DUPLICATE_BATCH (recorded in jobs on success). */
  batchId?: string | null
}): Promise<
  ServiceResult<{
    cancelledSubscriptionId: string | null
    newSubscriptionId: string | null
    jobId: string | null
    effectiveAt: string
    scheduled?: boolean
    scheduledExecuteAt?: string
    message?: string
    batchId?: string
  }>
> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const idempotencyKey = batchId?.trim() ? batchId.trim() : null
  if (idempotencyKey) {
    const existingJobs = await supabase.select(
      'jobs',
      `select=job_id,created_at,status&job_type=eq.${encodeURIComponent(SUBSCRIPTION_SWITCH_JOB_TYPE)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`
    )
    const existingJob = Array.isArray(existingJobs) ? (existingJobs[0] as Record<string, unknown>) : null
    if (existingJob) {
      return toError(409, 'DUPLICATE_BATCH', 'Duplicate batch switch request.')
    }
  }
  const iccidValue = String(iccid || '').trim()
  if (!isValidIccid(iccidValue)) {
    return toError(400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
  }
  const pkgId = String(toPackageId ?? '').trim()
  if (!isValidUuid(pkgId)) {
    return toError(400, 'BAD_REQUEST', 'toPackageId is required and must be a valid uuid.')
  }
  const fromSubscriptionIdValue =
    fromSubscriptionId != null && String(fromSubscriptionId).trim() !== ''
      ? String(fromSubscriptionId).trim()
      : null
  if (fromSubscriptionIdValue && !isValidUuid(fromSubscriptionIdValue)) {
    return toError(400, 'BAD_REQUEST', 'fromSubscriptionId must be a valid uuid.')
  }
  const sim = await loadSimByIccid(supabase, iccidValue, tenantFilter)
  if (!sim) {
    return toError(404, 'SIM_NOT_FOUND', `sim ${iccidValue} not found.`)
  }
  if (String(sim.enterprise_id) !== String(enterpriseId)) {
    return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
  }
  if (String(sim.status || '').toUpperCase() === 'RETIRED') {
    return toError(409, 'SIM_RETIRED', 'SIM is retired.')
  }
  const enterpriseStatus = await loadEnterpriseStatus(supabase, enterpriseId)
  if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
    return toError(409, 'ENTERPRISE_SUSPENDED', 'Enterprise is not active.')
  }
  const fromResult = await resolveSwitchFromMainSubscription({
    supabase,
    simId: String(sim.sim_id),
    enterpriseId,
    fromSubscriptionId: fromSubscriptionIdValue,
  })
  if (!fromResult.ok) return fromResult
  const from = fromResult.value
  const fromPackageId = String(from.package_id ?? '').trim()
  if (fromPackageId && fromPackageId === pkgId) {
    return toError(
      409,
      'SAME_TARGET_PACKAGE',
      'toPackageId must differ from the current subscription package.'
    )
  }
  const fromState = String(from.state ?? '').toUpperCase()
  const strategy = String(effectiveStrategy || '').toUpperCase() === 'IMMEDIATE' ? 'IMMEDIATE' : 'NEXT_CYCLE'
  let coexistingActiveMain = fromState === 'ACTIVE'
  if (fromState === 'PENDING') {
    const activeRows = await supabase.select(
      'subscriptions',
      `select=subscription_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=eq.ACTIVE&subscription_kind=eq.MAIN&limit=1`
    )
    coexistingActiveMain = Array.isArray(activeRows) && activeRows.length > 0
    if (strategy === 'IMMEDIATE' && coexistingActiveMain) {
      return toError(
        400,
        'BAD_REQUEST',
        'Cannot switch PENDING immediately while an ACTIVE MAIN subscription exists.'
      )
    }
  }
  if (strategy === 'IMMEDIATE' && fromState === 'ACTIVE') {
    return toError(
      400,
      'BAD_REQUEST',
      'ACTIVE subscription cannot be switched immediately. Use NEXT_CYCLE.'
    )
  }
  const pkgLoaded = await loadSellablePackage(supabase, pkgId)
  const pkgCheck = requirePublishedPackageForSubscribe(pkgLoaded, pkgId)
  if ('error' in pkgCheck) return pkgCheck.error

  const nextStart = firstDayNextMonthUtc()
  const effectiveIso = strategy === 'IMMEDIATE' ? new Date().toISOString() : nextStart.toISOString()
  const cancelImmediate = strategy === 'IMMEDIATE'

  const cancelResult = await cancelSubscription({
    supabase,
    enterpriseId,
    subscriptionId: String(from.subscription_id),
    immediate: cancelImmediate,
    audit,
  })
  if (!cancelResult.ok) return cancelResult

  const createResult = await createSubscription({
    supabase,
    enterpriseId,
    iccid: iccidValue,
    packageId: pkgId,
    kind: 'MAIN',
    effectiveAt: effectiveIso,
    tenantFilter,
    audit,
    allowCoexistentActiveMain: strategy === 'NEXT_CYCLE' && coexistingActiveMain,
  })
  if (!createResult.ok) return createResult

  const value = {
    cancelledSubscriptionId: String(from.subscription_id ?? ''),
    newSubscriptionId: createResult.value.subscriptionId,
    jobId: createResult.value.jobId,
    effectiveAt: createResult.value.effectiveAt,
    ...(cancelResult.value.scheduled ? { scheduled: true } : {}),
    ...(cancelResult.value.scheduledExecuteAt
      ? { scheduledExecuteAt: cancelResult.value.scheduledExecuteAt }
      : {}),
    ...(cancelResult.value.message ? { message: cancelResult.value.message } : {}),
    ...(idempotencyKey ? { batchId: idempotencyKey } : {}),
  }

  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: enterpriseId ?? null,
    action: 'SUBSCRIPTION_SWITCHED',
    target_type: 'SIM',
    target_id: sim.iccid ?? iccidValue,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: {
      subscriptionId: String(from.subscription_id ?? ''),
      packageId: String(from.package_id ?? ''),
      state: fromState,
    },
    after_data: {
      subscriptionId: String(createResult.value.subscriptionId ?? ''),
      packageId: pkgId,
      state: createResult.value.state,
      jobId: createResult.value.jobId,
      effectiveAt: createResult.value.effectiveAt,
      effectiveStrategy: strategy,
    },
  })

  if (idempotencyKey) {
    const finishedAt = new Date().toISOString()
    await supabase.insert(
      'jobs',
      {
        job_type: SUBSCRIPTION_SWITCH_JOB_TYPE,
        status: 'SUCCEEDED',
        progress_processed: 1,
        progress_total: 1,
        request_id: audit?.requestId ?? null,
        actor_user_id: actorUserIdForDb(audit?.actorUserId),
        actor_role: audit?.actorRole ?? null,
        enterprise_id: enterpriseId,
        idempotency_key: idempotencyKey,
        payload: {
          batchId: idempotencyKey,
          enterpriseId,
          iccid: iccidValue,
          fromSubscriptionId: String(from.subscription_id ?? ''),
          toPackageId: pkgId,
          effectiveStrategy: strategy,
          result: value,
        },
        started_at: finishedAt,
        finished_at: finishedAt,
      },
      { returning: 'minimal', suppressMissingColumns: true }
    )
  }
  return { ok: true, value }
}

export async function cancelSubscription({
  supabase,
  enterpriseId,
  subscriptionId,
  immediate,
  audit,
  batchId,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  subscriptionId: unknown
  immediate?: unknown
  audit?: AuditContext
  /** Optional idempotency key; duplicate → 409 DUPLICATE_BATCH (recorded in jobs on success). */
  batchId?: string | null
}): Promise<
  ServiceResult<{
    subscriptionId: string
    state: string
    expiresAt: string
    scheduled?: boolean
    scheduledExecuteAt?: string
    message?: string
    batchId?: string
  }>
> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const id = String(subscriptionId || '').trim()
  if (!isValidUuid(id)) {
    return toError(400, 'BAD_REQUEST', 'subscriptionId must be a valid uuid.')
  }
  const idempotencyKey = batchId?.trim() ? batchId.trim() : null
  if (idempotencyKey) {
    const existingJobs = await supabase.select(
      'jobs',
      `select=job_id,created_at,status&job_type=eq.${encodeURIComponent(SUBSCRIPTION_CANCEL_JOB_TYPE)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`
    )
    const existingJob = Array.isArray(existingJobs) ? (existingJobs[0] as Record<string, unknown>) : null
    if (existingJob) {
      return toError(409, 'DUPLICATE_BATCH', 'Duplicate batch cancel request.')
    }
  }
  const completeCancel = async (value: {
    subscriptionId: string
    state: string
    expiresAt: string
    scheduled?: boolean
    scheduledExecuteAt?: string
    message?: string
  }) => {
    if (idempotencyKey) {
      await recordSubscriptionCancelBatchJob(supabase, idempotencyKey, enterpriseId, id, audit, value)
      return { ok: true as const, value: { ...value, batchId: idempotencyKey } }
    }
    return { ok: true as const, value }
  }
  const rows = await supabase.select(
    'subscriptions',
    `select=subscription_id,enterprise_id,state,subscription_kind,effective_at,expires_at&subscription_id=eq.${encodeURIComponent(id)}&limit=1`
  )
  const sub = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  if (!sub) {
    return toError(404, 'SUBSCRIPTION_NOT_FOUND', `subscription ${id} not found.`)
  }
  if (String(sub.enterprise_id) !== String(enterpriseId)) {
    return toError(403, 'FORBIDDEN', 'Subscription does not belong to your enterprise.')
  }
  const nowIso = new Date().toISOString()
  const shouldImmediate = String(immediate || '').toLowerCase() === 'true'
  const state = String(sub.state ?? '').toUpperCase()
  const endOfPeriodIso = new Date(firstDayNextMonthUtc().getTime() - 1000).toISOString()

  if (state === 'PROVISIONING') {
    return toError(
      409,
      'SUBSCRIPTION_PROVISION_IN_PROGRESS',
      'Cannot cancel this subscription: a SUBSCRIPTION_PROVISION task is still in progress. Wait for provisioning to complete or fail, then retry.'
    )
  }

  if (state === 'CANCELLED') {
    return toError(409, 'SUBSCRIPTION_ALREADY_CANCELLED', 'Subscription is already cancelled.')
  }

  if (state === 'EXPIRED') {
    return toError(409, 'SUBSCRIPTION_ALREADY_EXPIRED', 'Subscription is already expired.')
  }

  // PENDING subscriptions are not yet effective; cancellation should close them directly
  // without forcing expires_at earlier than effective_at (DB constraint).
  if (state === 'PENDING') {
    const expiresAt = sub.expires_at != null && String(sub.expires_at).trim() !== ''
      ? String(sub.expires_at)
      : nowIso
    await supabase.update(
      'subscriptions',
      `subscription_id=eq.${encodeURIComponent(id)}`,
      { state: 'CANCELLED', cancelled_at: nowIso }
    )
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: enterpriseId ?? null,
      action: 'SUBSCRIPTION_CANCELLED',
      target_type: 'SUBSCRIPTION',
      target_id: id,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      before_data: { state },
      after_data: { state: 'CANCELLED', expiresAt, immediate: true },
    })
    return completeCancel({ subscriptionId: id, state: 'CANCELLED', expiresAt })
  }

  if (state === 'ACTIVE') {
    if (shouldImmediate) {
      return toError(
        400,
        'BAD_REQUEST',
        'ACTIVE subscription cannot be cancelled immediately. Use immediate=false.'
      )
    }
    const kind = String(sub.subscription_kind ?? 'MAIN').toUpperCase()
    const subExpires = sub.expires_at ? new Date(String(sub.expires_at)) : null
    const scheduledExecuteAt =
      kind === 'ADD_ON' && subExpires && !Number.isNaN(subExpires.getTime())
        ? subExpires.toISOString()
        : firstDayNextMonthUtc().toISOString()
    const expiresAt =
      sub.expires_at != null && String(sub.expires_at).trim() !== ''
        ? String(sub.expires_at)
        : endOfPeriodIso
    try {
      const existing = await supabase.select(
        'subscription_cancel_schedules',
        `select=schedule_id&subscription_id=eq.${encodeURIComponent(id)}&status=eq.PENDING&limit=1`
      )
      if (Array.isArray(existing) && existing.length > 0) {
        return toError(409, 'CANCEL_ALREADY_SCHEDULED', 'Cancel is already scheduled for this subscription.')
      }
      await supabase.insert(
        'subscription_cancel_schedules',
        {
          subscription_id: id,
          scheduled_execute_at: scheduledExecuteAt,
          status: 'PENDING',
        },
        { returning: 'minimal' }
      )
    } catch (err: unknown) {
      const body = String((err as { body?: string; message?: string })?.body || (err as Error)?.message || '')
      if (
        body.includes('subscription_cancel_schedules') ||
        body.includes('PGRST205') ||
        body.includes('does not exist')
      ) {
        return toError(
          503,
          'MIGRATION_REQUIRED',
          'subscription_cancel_schedules table is not available. Run database migrations.'
        )
      }
      throw err
    }
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: enterpriseId ?? null,
      action: 'SUBSCRIPTION_CANCEL_SCHEDULED',
      target_type: 'SUBSCRIPTION',
      target_id: id,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      before_data: { state },
      after_data: { scheduled: true, scheduledExecuteAt, expiresAt },
    })
    return completeCancel({
      subscriptionId: id,
      state: 'ACTIVE',
      scheduled: true,
      scheduledExecuteAt,
      expiresAt,
      message: 'Cancel scheduled at end of billing period.',
    })
  }

  const expiresAt = shouldImmediate ? nowIso : endOfPeriodIso
  const nextState = shouldImmediate ? 'CANCELLED' : 'EXPIRED'
  await supabase.update(
    'subscriptions',
    `subscription_id=eq.${encodeURIComponent(id)}`,
    { state: nextState, cancelled_at: shouldImmediate ? nowIso : null, expires_at: expiresAt }
  )
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: enterpriseId ?? null,
    action: 'SUBSCRIPTION_CANCELLED',
    target_type: 'SUBSCRIPTION',
    target_id: id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: { state },
    after_data: { state: nextState, expiresAt, immediate: shouldImmediate },
  })
  return completeCancel({ subscriptionId: id, state: nextState, expiresAt })
}

export async function listSimSubscriptions({
  supabase,
  enterpriseId,
  simIdentifier,
  tenantFilter,
  state,
  kind,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  simIdentifier: { field: 'sim_id' | 'iccid'; value: string }
  tenantFilter: string
  state?: unknown
  kind?: unknown
  page?: unknown
  pageSize?: unknown
}): Promise<ServiceResult<{ items: Array<Record<string, unknown>>; total: number; page: number; pageSize: number }>> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  let simId = simIdentifier.field === 'sim_id' ? simIdentifier.value : ''
  if (!simId) {
    const sim = await loadSimByIccid(supabase, simIdentifier.value, tenantFilter)
    if (!sim) {
      return toError(404, 'SIM_NOT_FOUND', `sim ${simIdentifier.value} not found.`)
    }
    if (String(sim.enterprise_id) !== String(enterpriseId)) {
      return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
    }
    simId = String(sim.sim_id)
  }
  const pageNum = Math.max(1, Number(page ?? 1) || 1)
  const sizeNum = Math.min(200, Math.max(1, Number(pageSize ?? 20) || 20))
  const offset = (pageNum - 1) * sizeNum
  const filters = [
    `sim_id=eq.${encodeURIComponent(simId)}`,
  ]
  const stateValue = String(state || '').toUpperCase()
  if (
    stateValue === 'PENDING' ||
    stateValue === 'PROVISIONING' ||
    stateValue === 'ACTIVE' ||
    stateValue === 'CANCELLED' ||
    stateValue === 'EXPIRED'
  ) {
    filters.push(`state=eq.${encodeURIComponent(stateValue)}`)
  }
  const kindValue = String(kind || '').toUpperCase()
  if (kindValue === 'MAIN' || kindValue === 'ADD_ON') {
    filters.push(`subscription_kind=eq.${encodeURIComponent(kindValue)}`)
  }
  const query = `select=subscription_id,package_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&${filters.join('&')}&order=effective_at.desc&limit=${sizeNum}&offset=${offset}`
  const { data, total } = await supabase.selectWithCount('subscriptions', query)
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
  const packageIds = rows.map((r) => String(r.package_id || '')).filter(Boolean)
  const packageMap = new Map<string, Record<string, unknown>>()
  if (packageIds.length) {
    const unique = Array.from(new Set(packageIds))
    const packages = await supabase.select(
      'packages',
      `select=package_id,name&package_id=in.(${unique.map((v) => encodeURIComponent(v)).join(',')})`
    )
    if (Array.isArray(packages)) {
      for (const p of packages) {
        const row = p as Record<string, unknown>
        if (row.package_id) packageMap.set(String(row.package_id), row)
      }
    }
  }
  const items = rows.map((row) => {
    const pid = String(row.package_id || '')
    const pkg = pid ? packageMap.get(pid) : null
    return {
      subscriptionId: String(row.subscription_id || ''),
      packageId: pid,
      packageName: pkg?.name ?? null,
      kind: String(row.subscription_kind || ''),
      state: String(row.state || ''),
      effectiveAt: row.effective_at ?? null,
      expiresAt: row.expires_at ?? null,
      cancelledAt: row.cancelled_at ?? null,
      firstSubscribedAt: row.first_subscribed_at ?? null,
      commitmentEndAt: row.commitment_end_at ?? null,
    }
  })
  return {
    ok: true,
    value: {
      items,
      total: Number(total ?? items.length),
      page: pageNum,
      pageSize: sizeNum,
    },
  }
}

type SubscriptionApiItem = {
  subscriptionId: string
  enterpriseId: string
  simId: string
  iccid: string | null
  packageId: string
  packageName: string | null
  kind: string
  state: string
  effectiveAt: unknown
  expiresAt: unknown
  cancelledAt: unknown
  firstSubscribedAt: unknown
  commitmentEndAt: unknown
}

type EnterpriseSubscriptionApiItem = Omit<SubscriptionApiItem, 'enterpriseId' | 'simId'>

function mapSubscriptionRowsToItems(
  rows: Record<string, unknown>[],
  packageMap: Map<string, Record<string, unknown>>,
  simMap: Map<string, Record<string, unknown>>
): SubscriptionApiItem[] {
  return rows.map((row) => {
    const pid = String(row.package_id || '')
    const pkg = pid ? packageMap.get(pid) : null
    const sid = String(row.sim_id || '')
    const sim = sid ? simMap.get(sid) : null
    return {
      subscriptionId: String(row.subscription_id || ''),
      enterpriseId: String(row.enterprise_id || ''),
      simId: sid,
      iccid: sim?.iccid != null ? String(sim.iccid) : null,
      packageId: pid,
      packageName: pkg?.name != null ? String(pkg.name) : null,
      kind: String(row.subscription_kind || ''),
      state: String(row.state || ''),
      effectiveAt: row.effective_at ?? null,
      expiresAt: row.expires_at ?? null,
      cancelledAt: row.cancelled_at ?? null,
      firstSubscribedAt: row.first_subscribed_at ?? null,
      commitmentEndAt: row.commitment_end_at ?? null,
    }
  })
}

function toEnterpriseSubscriptionItem(item: SubscriptionApiItem): EnterpriseSubscriptionApiItem {
  return {
    subscriptionId: item.subscriptionId,
    iccid: item.iccid,
    packageId: item.packageId,
    packageName: item.packageName,
    kind: item.kind,
    state: item.state,
    effectiveAt: item.effectiveAt,
    expiresAt: item.expiresAt,
    cancelledAt: item.cancelledAt,
    firstSubscribedAt: item.firstSubscribedAt,
    commitmentEndAt: item.commitmentEndAt,
  }
}

async function resolveOperatorIds(
  supabase: SupabaseClient,
  operatorId: string,
  supplierId: string | null
): Promise<string[]> {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const rows = await supabase.select(
    'operators',
    `select=operator_id&or=(operator_id.eq.${encodeURIComponent(operatorId)},business_operator_id.eq.${encodeURIComponent(operatorId)})${supplierFilter}&limit=200`
  )
  if (!Array.isArray(rows)) return []
  return Array.from(
    new Set(
      rows
        .map((r) => {
          const row = r as Record<string, unknown>
          return row.operator_id ? String(row.operator_id).trim() : ''
        })
        .filter(Boolean)
    )
  )
}

async function hasSimsForScope(
  supabase: SupabaseClient,
  tenantFilter: string,
  filters: string[]
): Promise<boolean> {
  const rows = await supabase.select('sims', `select=sim_id&${filters.join('&')}${tenantFilter}&limit=1`)
  return Array.isArray(rows) && rows.length > 0
}

export async function listSubscriptions({
  supabase,
  enterpriseId,
  iccid,
  state,
  kind,
  page,
  pageSize,
  tenantFilter,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  iccid?: unknown
  state?: unknown
  kind?: unknown
  page?: unknown
  pageSize?: unknown
  tenantFilter: string
}): Promise<ServiceResult<{ items: SubscriptionApiItem[]; total: number; page: number; pageSize: number }>> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const filters = [`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`]
  const iccidValue = String(iccid || '').trim()
  if (iccidValue) {
    if (!isValidIccid(iccidValue)) {
      return toError(400, 'BAD_REQUEST', 'iccid must be 18-20 digits.')
    }
    const sim = await loadSimByIccid(supabase, iccidValue, tenantFilter)
    if (!sim) {
      return toError(404, 'SIM_NOT_FOUND', `sim ${iccidValue} not found.`)
    }
    if (String(sim.enterprise_id) !== String(enterpriseId)) {
      return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
    }
    filters.push(`sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`)
  }
  const pageNum = Math.max(1, Number(page ?? 1) || 1)
  const sizeNum = Math.min(200, Math.max(1, Number(pageSize ?? 20) || 20))
  const offset = (pageNum - 1) * sizeNum
  const stateValue = String(state || '').toUpperCase()
  if (
    stateValue === 'PENDING' ||
    stateValue === 'PROVISIONING' ||
    stateValue === 'ACTIVE' ||
    stateValue === 'CANCELLED' ||
    stateValue === 'EXPIRED'
  ) {
    filters.push(`state=eq.${encodeURIComponent(stateValue)}`)
  }
  const kindValue = String(kind || '').toUpperCase()
  if (kindValue === 'MAIN' || kindValue === 'ADD_ON') {
    filters.push(`subscription_kind=eq.${encodeURIComponent(kindValue)}`)
  }
  const query = `select=subscription_id,sim_id,enterprise_id,package_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&${filters.join('&')}&order=effective_at.desc&limit=${sizeNum}&offset=${offset}`
  const { data, total } = await supabase.selectWithCount('subscriptions', query)
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
  const packageIds = rows.map((r) => String(r.package_id || '')).filter(Boolean)
  const packageMap = new Map<string, Record<string, unknown>>()
  if (packageIds.length) {
    const unique = Array.from(new Set(packageIds))
    const packages = await supabase.select(
      'packages',
      `select=package_id,name&package_id=in.(${unique.map((v) => encodeURIComponent(v)).join(',')})`
    )
    if (Array.isArray(packages)) {
      for (const p of packages) {
        const row = p as Record<string, unknown>
        if (row.package_id) packageMap.set(String(row.package_id), row)
      }
    }
  }
  const simIds = rows.map((r) => String(r.sim_id || '')).filter(Boolean)
  const simMap = new Map<string, Record<string, unknown>>()
  if (simIds.length) {
    const uniqueSims = Array.from(new Set(simIds))
    const sims = await supabase.select(
      'sims',
      `select=sim_id,iccid&sim_id=in.(${uniqueSims.map((v) => encodeURIComponent(v)).join(',')})`
    )
    if (Array.isArray(sims)) {
      for (const s of sims) {
        const row = s as Record<string, unknown>
        if (row.sim_id) simMap.set(String(row.sim_id), row)
      }
    }
  }
  const items = mapSubscriptionRowsToItems(rows, packageMap, simMap)
  return {
    ok: true,
    value: {
      items,
      total: Number(total ?? items.length),
      page: pageNum,
      pageSize: sizeNum,
    },
  }
}

export async function listSubscriptionsSearch({
  supabase,
  enterpriseId,
  departmentId,
  resellerId,
  iccid,
  imsi,
  state,
  kind,
  supplierId,
  operatorId,
  packageId,
  page,
  pageSize,
  pageSizeDefault = 20,
  pageSizeMax = 100,
  tenantFilter,
}: {
  supabase: SupabaseClient
  enterpriseId?: string | null
  departmentId?: unknown
  resellerId?: unknown
  iccid?: unknown
  imsi?: unknown
  state?: unknown
  kind?: unknown
  supplierId?: unknown
  operatorId?: unknown
  packageId?: unknown
  page?: unknown
  pageSize?: unknown
  pageSizeDefault?: number
  pageSizeMax?: number
  tenantFilter: string
}): Promise<ServiceResult<{ items: SubscriptionApiItem[]; total: number; page: number; pageSize: number }>> {
  const pageNum = Math.max(1, Number(page ?? 1) || 1)
  const defaultSize = Math.max(1, Number(pageSizeDefault) || 20)
  const maxSize = Math.max(defaultSize, Number(pageSizeMax) || 100)
  const sizeNum = Math.min(maxSize, Math.max(1, Number(pageSize ?? defaultSize) || defaultSize))
  const filters: string[] = []
  if (enterpriseId) {
    if (!isValidUuid(enterpriseId)) return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  }
  const packageIdValue = String(packageId ?? '').trim()
  if (packageIdValue) {
    if (!isValidUuid(packageIdValue)) return toError(400, 'BAD_REQUEST', 'packageId must be a valid uuid.')
    filters.push(`package_id=eq.${encodeURIComponent(packageIdValue)}`)
  }
  const stateValue = String(state || '').toUpperCase()
  if (stateValue) {
    if (!['PENDING', 'PROVISIONING', 'ACTIVE', 'CANCELLED', 'EXPIRED'].includes(stateValue)) {
      return toError(400, 'BAD_REQUEST', 'state must be one of PENDING, PROVISIONING, ACTIVE, CANCELLED, EXPIRED.')
    }
    filters.push(`state=eq.${encodeURIComponent(stateValue)}`)
  }
  const kindValue = String(kind || '').toUpperCase()
  if (kindValue) {
    if (kindValue !== 'MAIN' && kindValue !== 'ADD_ON') return toError(400, 'BAD_REQUEST', 'kind must be MAIN or ADD_ON.')
    filters.push(`subscription_kind=eq.${encodeURIComponent(kindValue)}`)
  }

  const simFilters: string[] = []
  const departmentIdValue = String(departmentId ?? '').trim()
  if (departmentIdValue) {
    if (!enterpriseId) return toError(400, 'BAD_REQUEST', 'departmentId requires enterpriseId.')
    if (!isValidUuid(departmentIdValue)) return toError(400, 'BAD_REQUEST', 'departmentId must be a valid uuid.')
    const deptRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(
        departmentIdValue
      )}&tenant_type=eq.DEPARTMENT&limit=1`
    )
    const dept = Array.isArray(deptRows) ? (deptRows[0] as Record<string, unknown>) : null
    if (!dept?.tenant_id) {
      return toError(404, 'RESOURCE_NOT_FOUND', 'departmentId Not found.')
    }
    if (String(dept.parent_id || '') !== String(enterpriseId)) {
      return toError(403, 'FORBIDDEN', 'departmentId is out of enterprise scope.')
    }
    simFilters.push(`department_id=eq.${encodeURIComponent(departmentIdValue)}`)
  }
  const resellerIdValue = String(resellerId ?? '').trim()
  if (resellerIdValue) {
    if (!isValidUuid(resellerIdValue)) return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    simFilters.push(`reseller_id=eq.${encodeURIComponent(resellerIdValue)}`)
  }
  const supplierIdValue = String(supplierId ?? '').trim()
  if (supplierIdValue) {
    if (!isValidUuid(supplierIdValue)) return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    const supplierRows = await supabase.select(
      'suppliers',
      `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierIdValue)}&limit=1`
    )
    const supplier = Array.isArray(supplierRows) ? (supplierRows[0] as Record<string, unknown>) : null
    if (!supplier?.supplier_id) {
      return toError(404, 'RESOURCE_NOT_FOUND', 'supplierId Not found.')
    }
    if (enterpriseId || resellerIdValue) {
      const supplierScopeFilters = [`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`]
      if (enterpriseId) supplierScopeFilters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      if (resellerIdValue) supplierScopeFilters.push(`reseller_id=eq.${encodeURIComponent(resellerIdValue)}`)
      const inScope = await hasSimsForScope(supabase, tenantFilter, supplierScopeFilters)
      if (!inScope) {
        return toError(403, 'FORBIDDEN', 'supplierId is out of enterprise/reseller scope.')
      }
    }
    simFilters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
  }
  const operatorIdValue = String(operatorId ?? '').trim()
  if (operatorIdValue) {
    if (!isValidUuid(operatorIdValue)) return toError(400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    const operatorExistsRows = await supabase.select(
      'operators',
      `select=operator_id,business_operator_id&or=(operator_id.eq.${encodeURIComponent(
        operatorIdValue
      )},business_operator_id.eq.${encodeURIComponent(operatorIdValue)})&limit=1`
    )
    if (!Array.isArray(operatorExistsRows) || operatorExistsRows.length === 0) {
      return toError(404, 'RESOURCE_NOT_FOUND', 'operatorId Not found.')
    }
    const operatorIds = await resolveOperatorIds(supabase, operatorIdValue, supplierIdValue || null)
    if (operatorIds.length === 0) {
      return toError(403, 'FORBIDDEN', 'operatorId is out of supplier scope.')
    }
    if (enterpriseId || resellerIdValue) {
      const operatorScopeFilters = [
        operatorIds.length === 1
          ? `operator_id=eq.${encodeURIComponent(operatorIds[0])}`
          : `operator_id=in.(${operatorIds.map((v) => encodeURIComponent(v)).join(',')})`,
      ]
      if (enterpriseId) operatorScopeFilters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
      if (resellerIdValue) operatorScopeFilters.push(`reseller_id=eq.${encodeURIComponent(resellerIdValue)}`)
      const inScope = await hasSimsForScope(supabase, tenantFilter, operatorScopeFilters)
      if (!inScope) {
        return toError(403, 'FORBIDDEN', 'operatorId is out of enterprise/reseller scope.')
      }
    }
    simFilters.push(
      operatorIds.length === 1
        ? `operator_id=eq.${encodeURIComponent(operatorIds[0])}`
        : `operator_id=in.(${operatorIds.map((v) => encodeURIComponent(v)).join(',')})`
    )
  }
  const iccidValue = String(iccid ?? '').trim()
  if (iccidValue) {
    if (!/^\d{1,20}$/.test(iccidValue)) return toError(400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
    simFilters.push(
      iccidValue.length < 20
        ? `iccid=ilike.${encodeURIComponent(`${iccidValue}%`)}`
        : `iccid=eq.${encodeURIComponent(iccidValue)}`
    )
  }
  const imsiValue = String(imsi ?? '').trim()
  if (imsiValue) simFilters.push(`primary_imsi=eq.${encodeURIComponent(imsiValue)}`)
  if (enterpriseId) simFilters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)

  if (simFilters.length > 0) {
    const sims = await supabase.select(
      'sims',
      `select=sim_id&${simFilters.join('&')}${tenantFilter}&limit=10000`
    )
    const simIds = Array.isArray(sims)
      ? Array.from(new Set(sims.map((r) => String((r as Record<string, unknown>).sim_id || '')).filter(Boolean)))
      : []
    if (simIds.length === 0) {
      return { ok: true, value: { items: [], total: 0, page: pageNum, pageSize: sizeNum } }
    }
    filters.push(`sim_id=in.(${simIds.map((v) => encodeURIComponent(v)).join(',')})`)
  }

  const offset = (pageNum - 1) * sizeNum
  const query = `select=subscription_id,sim_id,enterprise_id,package_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&${filters.join('&')}&order=effective_at.desc&limit=${sizeNum}&offset=${offset}`
  const { data, total } = await supabase.selectWithCount('subscriptions', query)
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
  const packageIds = rows.map((r) => String(r.package_id || '')).filter(Boolean)
  const packageMap = new Map<string, Record<string, unknown>>()
  if (packageIds.length) {
    const unique = Array.from(new Set(packageIds))
    const packages = await supabase.select(
      'packages',
      `select=package_id,name&package_id=in.(${unique.map((v) => encodeURIComponent(v)).join(',')})`
    )
    if (Array.isArray(packages)) {
      for (const p of packages) {
        const row = p as Record<string, unknown>
        if (row.package_id) packageMap.set(String(row.package_id), row)
      }
    }
  }
  const simIds = rows.map((r) => String(r.sim_id || '')).filter(Boolean)
  const simMap = new Map<string, Record<string, unknown>>()
  if (simIds.length) {
    const uniqueSims = Array.from(new Set(simIds))
    const simRows = await supabase.select(
      'sims',
      `select=sim_id,iccid&sim_id=in.(${uniqueSims.map((v) => encodeURIComponent(v)).join(',')})`
    )
    if (Array.isArray(simRows)) {
      for (const s of simRows) {
        const row = s as Record<string, unknown>
        if (row.sim_id) simMap.set(String(row.sim_id), row)
      }
    }
  }
  const items = mapSubscriptionRowsToItems(rows, packageMap, simMap)
  return { ok: true, value: { items, total: Number(total ?? items.length), page: pageNum, pageSize: sizeNum } }
}

export async function listEnterpriseSubscriptionsSanitized({
  supabase,
  enterpriseId,
  departmentId,
  iccid,
  imsi,
  state,
  kind,
  packageId,
  page,
  pageSize,
  tenantFilter,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  departmentId?: unknown
  iccid?: unknown
  imsi?: unknown
  state?: unknown
  kind?: unknown
  packageId?: unknown
  page?: unknown
  pageSize?: unknown
  tenantFilter: string
}): Promise<ServiceResult<{ items: EnterpriseSubscriptionApiItem[]; total: number; page: number; pageSize: number }>> {
  const result = await listSubscriptionsSearch({
    supabase,
    enterpriseId,
    departmentId,
    iccid,
    imsi,
    state,
    kind,
    packageId,
    page,
    pageSize,
    tenantFilter,
  })
  if (!result.ok) return result
  return {
    ok: true,
    value: {
      items: result.value.items.map(toEnterpriseSubscriptionItem),
      total: result.value.total,
      page: result.value.page,
      pageSize: result.value.pageSize,
    },
  }
}

export async function getSubscription({
  supabase,
  subscriptionId,
}: {
  supabase: SupabaseClient
  subscriptionId: unknown
}): Promise<ServiceResult<SubscriptionApiItem>> {
  const id = String(subscriptionId || '').trim()
  if (!isValidUuid(id)) {
    return toError(400, 'BAD_REQUEST', 'subscriptionId must be a valid uuid.')
  }
  const rows = await supabase.select(
    'subscriptions',
    `select=subscription_id,sim_id,enterprise_id,package_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&subscription_id=eq.${encodeURIComponent(id)}&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : null
  if (!row) {
    return toError(404, 'SUBSCRIPTION_NOT_FOUND', `subscription ${id} not found.`)
  }
  const packageMap = new Map<string, Record<string, unknown>>()
  const pid = String(row.package_id || '')
  if (pid) {
    const pkgs = await supabase.select(
      'packages',
      `select=package_id,name&package_id=eq.${encodeURIComponent(pid)}&limit=1`
    )
    const p = Array.isArray(pkgs) ? (pkgs[0] as Record<string, unknown>) : null
    if (p?.package_id) packageMap.set(String(p.package_id), p)
  }
  const simMap = new Map<string, Record<string, unknown>>()
  const sid = String(row.sim_id || '')
  if (sid) {
    const simRows = await supabase.select(
      'sims',
      `select=sim_id,iccid&sim_id=eq.${encodeURIComponent(sid)}&limit=1`
    )
    const s = Array.isArray(simRows) ? (simRows[0] as Record<string, unknown>) : null
    if (s?.sim_id) simMap.set(String(s.sim_id), s)
  }
  const [item] = mapSubscriptionRowsToItems([row], packageMap, simMap)
  return { ok: true, value: item }
}

function clampIntEnv(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** Max non-empty lines in ICCID upload files for subscription batch APIs. */
export const SUBSCRIPTION_BATCH_MAX_ICCID_LINES = clampIntEnv(
  'SUBSCRIPTION_BATCH_MAX_ICCID_LINES',
  5000,
  1,
  100_000
)

/** Max multipart body size (bytes) for subscription batch upload. */
export const SUBSCRIPTION_BATCH_MAX_BYTES = clampIntEnv(
  'SUBSCRIPTION_BATCH_MAX_BYTES',
  10 * 1024 * 1024,
  4096,
  50 * 1024 * 1024
)

function stripLeadingBom(text: string) {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1)
  return text
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"'
        i += 1
        continue
      }
      inQuotes = !inQuotes
      continue
    }
    if (ch === ',' && !inQuotes) {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell)
  return cells
}

/** Non-empty trimmed lines from an ICCID list file (UTF-8; strips BOM). */
export function splitIccidFileLines(fileText: string): string[] {
  const t = stripLeadingBom(String(fileText ?? ''))
  const lines = t.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const s = line.trim()
    if (s) out.push(s)
  }
  return out
}

export function extractBatchCreateIccidsFromCsv(
  fileText: string
): { ok: true; lines: string[] } | { ok: false; code: string; message: string } {
  const t = stripLeadingBom(String(fileText ?? ''))
  const rawLines = t
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (rawLines.length === 0) {
    return { ok: true, lines: [] }
  }
  const header = parseCsvLine(rawLines[0]).map((c) => c.trim().toLowerCase())
  const iccidIndex = header.findIndex((c) => c === 'iccid')
  if (iccidIndex < 0) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      message: 'CSV file must contain iccid column.',
    }
  }
  const lines: string[] = []
  for (let i = 1; i < rawLines.length; i += 1) {
    const cols = parseCsvLine(rawLines[i])
    const iccid = String(cols[iccidIndex] ?? '').trim()
    if (iccid) lines.push(iccid)
  }
  return { ok: true, lines }
}

export type SubscriptionBatchResultItem = {
  iccid: string
  ok: boolean
  subscriptionId?: string
  jobId?: string
  packageId?: string
  state?: string
  effectiveAt?: string
  expiresAt?: string | null
  commitmentEndAt?: string | null
  code?: string
  message?: string
}

export async function batchCreateSubscriptions({
  supabase,
  enterpriseId,
  packageId,
  kind,
  effectiveAt,
  fileText,
  tenantFilter,
  audit,
  batchId,
  fileHash,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  packageId: unknown
  kind?: unknown
  effectiveAt?: unknown
  fileText: string
  tenantFilter: string
  audit?: AuditContext
  /** Optional idempotency key; duplicate completed batch → 409 DUPLICATE_BATCH (same as import-jobs). */
  batchId?: string | null
  /** SHA-256 hex of uploaded CSV bytes; used as idempotency key when batchId is omitted. */
  fileHash?: string | null
}): Promise<
  ServiceResult<{
    batchId: string
    summary: { total: number; succeeded: number; failed: number }
    results: SubscriptionBatchResultItem[]
  }>
> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const pkgId = String(packageId ?? '').trim()
  if (!isValidUuid(pkgId)) {
    return toError(400, 'BAD_REQUEST', 'packageId is required and must be a valid uuid.')
  }
  const resolvedFileHash =
    fileHash?.trim() ||
    crypto.createHash('sha256').update(Buffer.from(String(fileText ?? ''), 'utf8')).digest('hex')
  const idempotencyKey = batchId?.trim() ? batchId.trim() : resolvedFileHash
  if (idempotencyKey) {
    const existingJobs = await supabase.select(
      'jobs',
      `select=job_id,created_at,status&job_type=eq.${encodeURIComponent(SUBSCRIPTION_BATCH_CREATE_JOB_TYPE)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`
    )
    const existingJob = Array.isArray(existingJobs) ? (existingJobs[0] as Record<string, unknown>) : null
    if (existingJob) {
      return toError(409, 'DUPLICATE_BATCH', 'Duplicate batch import.')
    }
  }
  const parsed = extractBatchCreateIccidsFromCsv(fileText)
  if (!parsed.ok) {
    return toError(400, parsed.code, parsed.message)
  }
  const lines = parsed.lines
  if (lines.length > SUBSCRIPTION_BATCH_MAX_ICCID_LINES) {
    return toError(400, 'BAD_REQUEST', `At most ${SUBSCRIPTION_BATCH_MAX_ICCID_LINES} ICCID lines allowed.`)
  }
  const validPatternLines = lines.filter((l) => isValidIccid(l))
  if (validPatternLines.length === 0) {
    return toError(400, 'BAD_REQUEST', 'No valid ICCID lines in file.')
  }

  const results: SubscriptionBatchResultItem[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!isValidIccid(line)) {
      results.push({
        iccid: line,
        ok: false,
        code: 'INVALID_ICCID',
        message: 'iccid must be 18-20 digits.',
      })
      continue
    }
    if (seen.has(line)) {
      results.push({
        iccid: line,
        ok: false,
        code: 'DUPLICATE_IN_FILE',
        message: 'Duplicate ICCID in file.',
      })
      continue
    }
    seen.add(line)
    const sub = await createSubscription({
      supabase,
      enterpriseId,
      iccid: line,
      packageId: pkgId,
      kind,
      effectiveAt,
      tenantFilter,
      audit,
    })
    if (!sub.ok) {
      results.push({ iccid: line, ok: false, code: sub.code, message: sub.message })
    } else {
      results.push({
        iccid: line,
        ok: true,
        subscriptionId: sub.value.subscriptionId ?? undefined,
        jobId: sub.value.jobId ?? undefined,
        packageId: sub.value.packageId ?? undefined,
        state: sub.value.state,
        effectiveAt: sub.value.effectiveAt,
        expiresAt: sub.value.expiresAt,
        commitmentEndAt: sub.value.commitmentEndAt,
      })
    }
  }
  const succeeded = results.filter((r) => r.ok).length
  const summary = { total: results.length, succeeded, failed: results.length - succeeded }
  const finishedAt = new Date().toISOString()
  if (idempotencyKey) {
    await supabase.insert(
      'jobs',
      {
        job_type: SUBSCRIPTION_BATCH_CREATE_JOB_TYPE,
        status: 'SUCCEEDED',
        progress_processed: results.length,
        progress_total: results.length,
        request_id: audit?.requestId ?? null,
        actor_user_id: actorUserIdForDb(audit?.actorUserId),
        actor_role: audit?.actorRole ?? null,
        enterprise_id: enterpriseId,
        idempotency_key: idempotencyKey,
        file_hash: resolvedFileHash,
        payload: {
          batchId: batchId?.trim() || null,
          fileHash: resolvedFileHash,
          enterpriseId,
          packageId: pkgId,
          kind: kind ?? 'MAIN',
          effectiveAt: effectiveAt ?? null,
          summary,
        },
        started_at: finishedAt,
        finished_at: finishedAt,
      },
      { returning: 'minimal', suppressMissingColumns: true }
    )
  }
  return {
    ok: true,
    value: {
      batchId: idempotencyKey,
      summary,
      results,
    },
  }
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

async function loadPackageNamesMap(supabase: SupabaseClient, packageIds: string[]) {
  const packageMap = new Map<string, Record<string, unknown>>()
  const unique = Array.from(new Set(packageIds.filter(Boolean)))
  if (!unique.length) return packageMap
  const packages = await supabase.select(
    'packages',
    `select=package_id,name&package_id=in.(${unique.map((v) => encodeURIComponent(v)).join(',')})`
  )
  if (Array.isArray(packages)) {
    for (const p of packages) {
      const row = p as Record<string, unknown>
      if (row.package_id) packageMap.set(String(row.package_id), row)
    }
  }
  return packageMap
}

export async function batchExportSubscriptions({
  supabase,
  enterpriseId,
  departmentId,
  resellerId,
  iccid,
  imsi,
  state,
  kind,
  supplierId,
  operatorId,
  packageId,
  page,
  pageSize,
  batchId,
  tenantFilter,
  audit,
}: {
  supabase: SupabaseClient
  enterpriseId?: string | null
  departmentId?: unknown
  resellerId?: unknown
  iccid?: unknown
  imsi?: unknown
  state?: unknown
  kind?: unknown
  supplierId?: unknown
  operatorId?: unknown
  packageId?: unknown
  page?: unknown
  pageSize?: unknown
  /** Required idempotency key; duplicate → 409 DUPLICATE_BATCH. */
  batchId?: string | null
  tenantFilter: string
  audit?: AuditContext
}): Promise<ServiceResult<{ csvText: string; filename: string; batchId: string }>> {
  const idempotencyKey = batchId?.trim() ? batchId.trim() : null
  if (!idempotencyKey) {
    return toError(400, 'BAD_REQUEST', 'batchId is required.')
  }
  const existingJobs = await supabase.select(
    'jobs',
    `select=job_id,created_at,status&job_type=eq.${encodeURIComponent(SUBSCRIPTION_BATCH_EXPORT_JOB_TYPE)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&limit=1`
  )
  const existingJob = Array.isArray(existingJobs) ? (existingJobs[0] as Record<string, unknown>) : null
  if (existingJob) {
    return toError(409, 'DUPLICATE_BATCH', 'Duplicate batch export request.')
  }

  const searchResult = await listSubscriptionsSearch({
    supabase,
    enterpriseId: enterpriseId ?? null,
    departmentId,
    resellerId,
    iccid,
    imsi,
    state,
    kind,
    supplierId,
    operatorId,
    packageId,
    page,
    pageSize,
    pageSizeDefault: SUBSCRIPTION_BATCH_EXPORT_PAGE_SIZE_DEFAULT,
    pageSizeMax: SUBSCRIPTION_BATCH_EXPORT_PAGE_SIZE_MAX,
    tenantFilter,
  })
  if (!searchResult.ok) return searchResult
  const header = [
    'subscriptionId',
    'enterpriseId',
    'simId',
    'iccid',
    'kind',
    'packageId',
    'packageName',
    'state',
    'effectiveAt',
    'expiresAt',
    'cancelledAt',
    'firstSubscribedAt',
    'commitmentEndAt',
  ]
  const csvRows: string[][] = [header]
  for (const item of searchResult.value.items) {
    csvRows.push([
      item.subscriptionId,
      item.enterpriseId,
      item.simId,
      item.iccid ?? '',
      item.kind,
      item.packageId,
      item.packageName ?? '',
      item.state,
      item.effectiveAt != null ? String(item.effectiveAt) : '',
      item.expiresAt != null ? String(item.expiresAt) : '',
      item.cancelledAt != null ? String(item.cancelledAt) : '',
      item.firstSubscribedAt != null ? String(item.firstSubscribedAt) : '',
      item.commitmentEndAt != null ? String(item.commitmentEndAt) : '',
    ])
  }
  const csvBody = csvRows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n')
  const csvText = `\uFEFF${csvBody}`
  const filename = `subscriptions-export-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
  const finishedAt = new Date().toISOString()
  await supabase.insert(
    'jobs',
    {
      job_type: SUBSCRIPTION_BATCH_EXPORT_JOB_TYPE,
      status: 'SUCCEEDED',
      progress_processed: searchResult.value.items.length,
      progress_total: searchResult.value.total,
      request_id: audit?.requestId ?? null,
      actor_user_id: actorUserIdForDb(audit?.actorUserId),
      actor_role: audit?.actorRole ?? null,
      enterprise_id: enterpriseId ?? null,
      idempotency_key: idempotencyKey,
      payload: {
        batchId: idempotencyKey,
        enterpriseId: enterpriseId ?? null,
        departmentId: departmentId ?? null,
        resellerId: resellerId ?? null,
        iccid: iccid ?? null,
        imsi: imsi ?? null,
        state: state ?? null,
        kind: kind ?? null,
        supplierId: supplierId ?? null,
        operatorId: operatorId ?? null,
        packageId: packageId ?? null,
        page: searchResult.value.page,
        pageSize: searchResult.value.pageSize,
        total: searchResult.value.total,
        exportedRows: searchResult.value.items.length,
        filename,
      },
      started_at: finishedAt,
      finished_at: finishedAt,
    },
    { returning: 'minimal', suppressMissingColumns: true }
  )
  return { ok: true, value: { csvText, filename, batchId: idempotencyKey } }
}
