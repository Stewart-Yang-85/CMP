import { buildPaginationResponse, parsePagination } from '../utils/pagination.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (
    table: string,
    matchQueryString: string,
    patch: Record<string, unknown>,
    options?: { returning?: 'minimal' | 'representation' }
  ) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

type AuditContext = {
  actorUserId?: string | null
  actorRole?: string | null
  requestId?: string | null
  sourceIp?: string | null
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

async function writeAuditLog(supabase: SupabaseClient, payload: Record<string, unknown>) {
  await supabase.insert(
    'audit_logs',
    {
      ...payload,
      actor_user_id: actorUserIdForDb(payload.actor_user_id as string | null | undefined),
    },
    { returning: 'minimal' }
  )
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function toInteger(value: unknown) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Number.isInteger(num) ? num : Math.trunc(num)
}

function hasEmptyStringField(payload: any, fieldName: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  if (!Object.prototype.hasOwnProperty.call(payload, fieldName)) return false
  return typeof payload[fieldName] === 'string' && payload[fieldName].trim() === ''
}

function hasInvalidNumberField(payload: any, fieldName: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  if (!Object.prototype.hasOwnProperty.call(payload, fieldName)) return false
  const value = payload[fieldName]
  if (value === null || value === undefined) return false
  if (typeof value === 'string' && value.trim() === '') return true
  return toNumber(value) === null
}

function hasInvalidIntegerField(payload: any, fieldName: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  if (!Object.prototype.hasOwnProperty.call(payload, fieldName)) return false
  const value = payload[fieldName]
  if (value === null || value === undefined) return false
  if (typeof value === 'string' && value.trim() === '') return true
  return toInteger(value) === null
}

function toBoolean(value: unknown) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

const ISO_4217_CURRENCIES: ReadonlySet<string> | null = (() => {
  try {
    const values = (Intl as any)?.supportedValuesOf?.('currency')
    if (!Array.isArray(values) || !values.length) return null
    return new Set(values.map((value: unknown) => String(value).trim().toUpperCase()).filter(Boolean))
  } catch {
    return null
  }
})()

function isValidIso4217Currency(value: unknown) {
  const code = String(value ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) return false
  if (!ISO_4217_CURRENCIES) return true
  return ISO_4217_CURRENCIES.has(code)
}

function resolveVersionStatus(version: any) {
  if (!version) return 'DRAFT'
  const raw = String(version.status ?? '').trim().toUpperCase()
  if (raw === 'DRAFT' || raw === 'PUBLISHED' || raw === 'DEPRECATED') return raw
  if (version.deprecated_at) return 'DEPRECATED'
  if (!version.effective_from) return 'DRAFT'
  const now = Date.now()
  const effective = new Date(version.effective_from).getTime()
  if (Number.isNaN(effective)) return 'DRAFT'
  return effective <= now ? 'PUBLISHED' : 'DRAFT'
}

const PRICE_PLAN_TYPES_WITH_COVERED_NETWORK = new Set([
  'ONE_TIME',
  'SIM_DEPENDENT_BUNDLE',
  'FIXED_BUNDLE',
  'TIERED_VOLUME_PRICING',
])

/** All supported price plan types use **CoveredNetworkProfile** for in-profile (MCC,MNC) scope. */
export function pricePlanTypeUsesCoveredNetwork(type: string) {
  return PRICE_PLAN_TYPES_WITH_COVERED_NETWORK.has(String(type || '').trim())
}

/** `unset` = body omitted key; `null` = JSON null (clear / explicit null). */
function parseCoveredNetworkProfileIdInput(payload: unknown): 'unset' | null | string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'unset'
  if (!Object.prototype.hasOwnProperty.call(payload, 'coveredNetworkProfileId')) return 'unset'
  const v = (payload as Record<string, unknown>).coveredNetworkProfileId
  if (v === null || v === undefined || v === '') return null
  return String(v).trim()
}

async function loadEnterpriseParentResellerId(supabase: SupabaseClient, enterpriseId: string): Promise<string | null> {
  const rows = await supabase.select(
    'tenants',
    `select=parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) return null
  const parent = String((row as any)?.parent_id ?? '').trim()
  return parent || null
}

/** Reseller (tenants.tenant_id, RESELLER) must match the ENTERPRISE row's parent_id. */
export async function assertEnterpriseBelongsToReseller(
  supabase: SupabaseClient,
  enterpriseId: string,
  resellerId: string
): Promise<ServiceResult<null>> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  }
  if (!isValidUuid(resellerId)) {
    return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  }
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  }
  if (String((row as any).tenant_type ?? '').trim() !== 'ENTERPRISE') {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  }
  const parent = String((row as any).parent_id ?? '').trim()
  const rid = String(resellerId).trim()
  if (!parent || parent !== rid) {
    return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  }
  const rrows = await supabase.select(
    'tenants',
    `select=tenant_id,tenant_type&tenant_id=eq.${encodeURIComponent(rid)}&limit=1`
  )
  const r = Array.isArray(rrows) ? rrows[0] : null
  if (!r || String((r as any).tenant_type ?? '').trim() !== 'RESELLER') {
    return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  }
  return { ok: true, value: null }
}

async function assertResellerSupplierBinding(
  supabase: SupabaseClient,
  resellerTenantId: string,
  supplierId: string
): Promise<boolean> {
  const rows = await supabase.select(
    'reseller_suppliers',
    `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerTenantId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return Boolean((row as any)?.supplier_id)
}

/**
 * Validates CoveredNetworkProfile for a price plan row: existence, lifecycle, reseller/supplier scope vs enterprise.
 */
async function validateCoveredNetworkProfileForPricePlan(
  supabase: SupabaseClient,
  enterpriseId: string,
  coveredNetworkProfileId: string,
  options: { requirePublished: boolean }
): Promise<ServiceResult<null>> {
  if (!isValidUuid(coveredNetworkProfileId)) {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
  }
  const profileRows = await supabase.select(
    'covered_network_profiles',
    `select=covered_network_profile_id,supplier_id,reseller_id,operator_id,status&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}&limit=1`
  )
  const profile = Array.isArray(profileRows) ? profileRows[0] : null
  if (!(profile as any)?.covered_network_profile_id) {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
  }
  const status = String((profile as any).status ?? '').trim().toUpperCase()
  if (status === 'DEPRECATED') {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId references a DEPRECATED profile.')
  }
  if (options.requirePublished) {
    if (status !== 'PUBLISHED') {
      return toError(
        409,
        'INVALID_STATUS',
        'coveredNetworkProfileId is invalid.'
      )
    }
  } else if (status !== 'DRAFT' && status !== 'PUBLISHED') {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId has an invalid status.')
  }
  const supplierId = String((profile as any).supplier_id ?? '').trim()
  const profileResellerId = String((profile as any).reseller_id ?? '').trim() || null
  const enterpriseResellerId = await loadEnterpriseParentResellerId(supabase, enterpriseId)

  if (profileResellerId) {
    if (!enterpriseResellerId) {
      return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is scoped to a reseller but enterprise has no reseller parent.')
    }
    if (profileResellerId !== enterpriseResellerId) {
      return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
    }
  }

  if (enterpriseResellerId) {
    const bound = await assertResellerSupplierBinding(supabase, enterpriseResellerId, supplierId)
    if (!bound) {
      return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
    }
  }

  return { ok: true, value: null }
}

async function resolveCoveredNetworkProfileIdForWrite(
  supabase: SupabaseClient,
  enterpriseId: string,
  planType: string,
  payload: unknown,
  existingCoveredId: string | null | undefined,
  mode: 'create' | 'update',
  lifecycle: { requirePublished: boolean }
): Promise<ServiceResult<string | null>> {
  const uses = pricePlanTypeUsesCoveredNetwork(planType)
  const raw = parseCoveredNetworkProfileIdInput(payload)
  let next: string | null = null

  if (!uses) {
    if (raw !== 'unset' && raw !== null && String(raw).trim() !== '') {
      return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is not supported for this price plan type.')
    }
    return { ok: true, value: null }
  }

  if (mode === 'create') {
    if (raw === 'unset' || raw === null) {
      return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is required.')
    }
    next = String(raw).trim() || null
  } else {
    if (raw === 'unset') {
      next = existingCoveredId ? String(existingCoveredId).trim() || null : null
    } else if (raw === null) {
      return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
    } else {
      next = String(raw).trim() || null
    }
  }

  if (!next || !isValidUuid(next)) {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is required.')
  }
  const v = await validateCoveredNetworkProfileForPricePlan(supabase, enterpriseId, next, lifecycle)
  if (!v.ok) return v
  return { ok: true, value: next }
}

function parseUpstreamMessage(error: any) {
  const body = error?.body
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body)
      const message = String(parsed?.message || '').trim()
      if (message) return message
    } catch {}
  }
  const message = String(error?.message || '').trim()
  return message && message !== 'UPSTREAM_BAD_RESPONSE' ? message : ''
}

function mapUpstreamFailure(error: any): ServiceResult<never> {
  const status = Number(error?.status)
  const message = parseUpstreamMessage(error)
  if (status === 400) return toError(400, 'BAD_REQUEST', message || 'Request payload is invalid.')
  if (status === 404) return toError(404, 'NOT_FOUND', message || 'Related resource not found.')
  if (status === 409) return toError(409, 'CONFLICT', message || 'Request conflicts with current resource state.')
  if (status === 429) return toError(429, 'UPSTREAM_RATE_LIMITED', message || 'Upstream service rate limited.')
  return toError(502, 'UPSTREAM_ERROR', message || 'Upstream service error.')
}

function validatePayload(
  payload: any,
  options: { requireCommonFields?: boolean } = {}
): ServiceResult<{
  name: string
  type: string
  serviceType: string
  currency: string
  billingCycleType: string
  firstCycleProration: string
  prorationRounding: string
  expiryBoundary: string | null
  monthlyFee: number | null
  deactivatedMonthlyFee: number | null
  oneTimeFee: number | null
  quotaMb: number | null
  validityDays: number | null
  perSimQuotaMb: number | null
  totalQuotaMb: number | null
  overageRatePerMb: number | null
  tiers: unknown[] | null
}> {
  const requireCommonFields = options.requireCommonFields !== false
  const numberFields = ['oneTimeFee', 'monthlyFee', 'deactivatedMonthlyFee', 'overageRatePerMb', 'ratePerMb'] as const
  for (const fieldName of numberFields) {
    if (hasInvalidNumberField(payload, fieldName)) return toError(400, 'BAD_REQUEST', `${fieldName} is invalid.`)
  }
  const integerFields = ['quotaMb', 'validityDays', 'totalQuotaMb', 'perSimQuotaMb'] as const
  for (const fieldName of integerFields) {
    if (hasInvalidIntegerField(payload, fieldName)) return toError(400, 'BAD_REQUEST', `${fieldName} is invalid.`)
  }
  if (payload?.commercialTerms !== undefined && payload?.commercialTerms !== null) {
    return toError(
      400,
      'BAD_REQUEST',
      'commercialTerms must not be set on a price plan; use package commercialTermsId.'
    )
  }
  if (payload?.controlPolicy !== undefined && payload?.controlPolicy !== null) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy must not be set on a price plan; use package controlPolicyId.')
  }
  if (payload?.carrierService !== undefined && payload?.carrierService !== null) {
    return toError(400, 'BAD_REQUEST', 'carrierService must not be set on a price plan; use package carrierServiceId.')
  }
  if (payload?.carrierServiceConfig !== undefined && payload?.carrierServiceConfig !== null) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig must not be set on a price plan; use package carrierServiceId.')
  }
  const paygList = payload?.paygRates
  if (Array.isArray(paygList) && paygList.length > 0) {
    return toError(400, 'BAD_REQUEST', 'paygRates are not supported on price plans.')
  }
  const name = String(payload?.name || '').trim()
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  const rawType = String(payload?.price_plan_type ?? payload?.type ?? '').trim()
  const type = rawType === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : rawType
  const allowedTypes = new Set(['ONE_TIME', 'SIM_DEPENDENT_BUNDLE', 'FIXED_BUNDLE', 'TIERED_VOLUME_PRICING'])
  if (!allowedTypes.has(type)) {
    return toError(
      400,
      'BAD_REQUEST',
      `price_plan_type is invalid. Allowed Values: ${Array.from(allowedTypes).join(', ')}.`
    )
  }
  const allowedServiceTypes = ['DATA', 'VOICE', 'SMS'] as const
  const serviceType = String(payload?.serviceType || '').trim()
  if (requireCommonFields && !serviceType) return toError(400, 'BAD_REQUEST', 'serviceType is required.')
  if (serviceType && !allowedServiceTypes.includes(serviceType as (typeof allowedServiceTypes)[number])) {
    return toError(400, 'BAD_REQUEST', `serviceType is invalid. Allowed Values: ${allowedServiceTypes.join(', ')}.`)
  }
  const currency = String(payload?.currency || '').trim().toUpperCase()
  if (requireCommonFields && !currency) return toError(400, 'BAD_REQUEST', 'currency is required.')
  if (currency && !isValidIso4217Currency(currency)) {
    return toError(400, 'BAD_REQUEST', 'currency must be ISO 4217 code.')
  }
  const allowedBillingCycleTypes = ['CALENDAR_MONTH', 'CUSTOM_RANGE'] as const
  const billingCycleType = String(payload?.billingCycleType || '').trim()
  if (requireCommonFields && !billingCycleType) return toError(400, 'BAD_REQUEST', 'billingCycleType is required.')
  if (billingCycleType && !allowedBillingCycleTypes.includes(billingCycleType as (typeof allowedBillingCycleTypes)[number])) {
    return toError(400, 'BAD_REQUEST', `billingCycleType is invalid. Allowed Values: ${allowedBillingCycleTypes.join(', ')}.`)
  }
  const allowedFirstCycleProration = ['NONE', 'DAILY_PRORATION'] as const
  const firstCycleProration = String(payload?.firstCycleProration || '').trim()
  if (requireCommonFields && !firstCycleProration) return toError(400, 'BAD_REQUEST', 'firstCycleProration is required.')
  if (firstCycleProration && !allowedFirstCycleProration.includes(firstCycleProration as (typeof allowedFirstCycleProration)[number])) {
    return toError(400, 'BAD_REQUEST', `firstCycleProration is invalid. Allowed Values: ${allowedFirstCycleProration.join(', ')}.`)
  }
  const allowedProrationRounding = ['ROUND_HALF_UP'] as const
  const prorationRounding = String(payload?.prorationRounding || '').trim()
  if (requireCommonFields && !prorationRounding) return toError(400, 'BAD_REQUEST', 'prorationRounding is required.')
  if (prorationRounding && !allowedProrationRounding.includes(prorationRounding as (typeof allowedProrationRounding)[number])) {
    return toError(400, 'BAD_REQUEST', `prorationRounding is invalid. Allowed Values: ${allowedProrationRounding.join(', ')}.`)
  }
  const monthlyFee = toNumber(payload?.monthlyFee)
  const deactivatedMonthlyFee = toNumber(payload?.deactivatedMonthlyFee)
  const oneTimeFee = toNumber(payload?.oneTimeFee)
  const quotaMb = toInteger(payload?.quotaMb)
  const validityDays = toInteger(payload?.validityDays)
  const perSimQuotaMb = toInteger(payload?.perSimQuotaMb)
  const totalQuotaMb = toInteger(payload?.totalQuotaMb)
  const overageRatePerMb = toNumber(payload?.overageRatePerMb)
  let expiryBoundary: string | null = null
  if (type === 'ONE_TIME') {
    if (oneTimeFee === null || oneTimeFee < 0) return toError(400, 'BAD_REQUEST', 'oneTimeFee is invalid.')
    if (quotaMb === null || quotaMb < 0) return toError(400, 'BAD_REQUEST', 'quotaMb is invalid.')
    if (validityDays === null || validityDays < 1) return toError(400, 'BAD_REQUEST', 'validityDays is invalid.')
    const allowedExpiryBoundaries = ['CALENDAR_DAY_END', 'DURATION_EXCLUSIVE_END'] as const
    const boundary = String(payload?.expiryBoundary || '').trim()
    if (!allowedExpiryBoundaries.includes(boundary as (typeof allowedExpiryBoundaries)[number])) {
      return toError(
        400,
        'BAD_REQUEST',
        `expiryBoundary is invalid for ONE_TIME. Allowed Values: ${allowedExpiryBoundaries.join(', ')}.`
      )
    }
    expiryBoundary = boundary
  }
  if (type !== 'ONE_TIME') {
    if (monthlyFee === null || monthlyFee < 0) return toError(400, 'BAD_REQUEST', 'monthlyFee is invalid.')
    if (deactivatedMonthlyFee === null || deactivatedMonthlyFee < 0) {
      return toError(400, 'BAD_REQUEST', 'deactivatedMonthlyFee is invalid.')
    }
    const bothFeesZero = monthlyFee === 0 && deactivatedMonthlyFee === 0
    if (monthlyFee !== null && deactivatedMonthlyFee !== null && deactivatedMonthlyFee >= monthlyFee && !bothFeesZero) {
      return toError(400, 'BAD_REQUEST', 'deactivatedMonthlyFee is invalid.')
    }
  }
  if (type === 'SIM_DEPENDENT_BUNDLE') {
    if (perSimQuotaMb === null || perSimQuotaMb < 0) {
      return toError(400, 'BAD_REQUEST', 'perSimQuotaMb is invalid.')
    }
  }
  if (type === 'FIXED_BUNDLE') {
    if (totalQuotaMb === null || totalQuotaMb < 0) {
      return toError(400, 'BAD_REQUEST', 'totalQuotaMb is invalid.')
    }
  }
  if (type === 'TIERED_VOLUME_PRICING') {
    const tiers = Array.isArray(payload?.tiers) ? payload.tiers : []
    if (!tiers.length) return toError(400, 'BAD_REQUEST', 'tiers is required.')
    let prevFromMb: number | null = null
    let prevToMb: number | null = null
    for (const tier of tiers) {
      if (hasInvalidIntegerField(tier, 'fromMb') || hasInvalidIntegerField(tier, 'toMb') || hasInvalidNumberField(tier, 'ratePerMb')) {
        return toError(400, 'BAD_REQUEST', 'tiers is invalid.')
      }
      const fromMb = toInteger((tier as { fromMb?: unknown }).fromMb)
      const toMb = toInteger((tier as { toMb?: unknown }).toMb)
      const ratePerMb = toNumber((tier as { ratePerMb?: unknown }).ratePerMb)
      if (fromMb === null || fromMb < 0 || toMb === null || toMb <= fromMb || ratePerMb === null || ratePerMb < 0) {
        return toError(400, 'BAD_REQUEST', 'tiers is invalid.')
      }
      if (prevFromMb !== null && fromMb <= prevFromMb) {
        return toError(400, 'BAD_REQUEST', 'tiers is invalid.')
      }
      if (prevToMb !== null && fromMb !== prevToMb) {
        return toError(400, 'BAD_REQUEST', 'tiers is invalid.')
      }
      prevFromMb = fromMb
      prevToMb = toMb
    }
  }
  if (overageRatePerMb !== null && overageRatePerMb < 0) {
    return toError(400, 'BAD_REQUEST', 'overageRatePerMb is invalid.')
  }
  return {
    ok: true,
    value: {
      name,
      type,
      serviceType: serviceType || 'DATA',
      currency: currency || 'USD',
      billingCycleType: billingCycleType || 'CALENDAR_MONTH',
      firstCycleProration: firstCycleProration || 'NONE',
      prorationRounding: prorationRounding || 'ROUND_HALF_UP',
      expiryBoundary,
      monthlyFee,
      deactivatedMonthlyFee,
      oneTimeFee,
      quotaMb,
      validityDays,
      perSimQuotaMb,
      totalQuotaMb,
      overageRatePerMb,
      tiers: Array.isArray(payload?.tiers) ? payload.tiers : null,
    },
  }
}

export async function loadPricePlan(supabase: SupabaseClient, pricePlanId: string) {
  const rows = await supabase.select(
    'price_plans',
    `select=${PRICE_PLAN_PARENT_SELECT}&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  const parent = Array.isArray(rows) ? rows[0] : null
  if (!parent) return null
  const pType = String((parent as any).type ?? '').trim()
  const child = await selectChildRowForPlan(supabase, pType, pricePlanId)
  return mergeChildIntoParentRow(parent, child, pType)
}

async function listLatestReferencingPackageIds(supabase: SupabaseClient, pricePlanId: string) {
  const rows = await supabase.select(
    'packages',
    `select=package_id&price_plan_id=eq.${encodeURIComponent(pricePlanId)}`
  )
  const list = Array.isArray(rows) ? rows : []
  return Array.from(
    new Set(list.map((row: any) => String((row as any)?.package_id ?? '').trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b))
}

const PRICE_PLAN_PARENT_SELECT =
  'price_plan_id,enterprise_id,reseller_id,name,type,service_type,currency,billing_cycle_type,first_cycle_proration,source_price_plan_id,version,status,effective_from,deprecated_at,proration_rounding,covered_network_profile_id,created_at'

function mergeChildIntoParentRow(parent: any, child: any, planType: string) {
  const out = { ...parent }
  const t = String(planType || '').trim()
  if (!child) return out
  if (t === 'FIXED_BUNDLE') {
    out.monthly_fee = child.monthly_fee
    out.deactivated_monthly_fee = child.deactivated_monthly_fee
    out.total_quota_mb = child.total_quota_mb
    out.overage_rate_per_mb = child.overage_rate_per_mb
  } else if (t === 'SIM_DEPENDENT_BUNDLE') {
    out.monthly_fee = child.monthly_fee
    out.deactivated_monthly_fee = child.deactivated_monthly_fee
    out.per_sim_quota_mb = child.per_sim_quota_mb
    out.overage_rate_per_mb = child.overage_rate_per_mb
  } else if (t === 'ONE_TIME') {
    out.one_time_fee = child.one_time_fee
    out.quota_mb = child.quota_mb
    out.validity_days = child.validity_days
    out.expiry_boundary = child.expiry_boundary
  } else if (t === 'TIERED_VOLUME_PRICING') {
    out.monthly_fee = child.monthly_fee
    out.deactivated_monthly_fee = child.deactivated_monthly_fee
    out.tiers = child.tiers
    out.overage_rate_per_mb = child.overage_rate_per_mb
  }
  return out
}

async function selectChildRowForPlan(supabase: SupabaseClient, planType: string, pricePlanId: string) {
  const t = String(planType || '').trim()
  const q = `select=*&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  if (t === 'FIXED_BUNDLE') {
    const r = await supabase.select('price_plan_fixed_bundle', q)
    return Array.isArray(r) ? r[0] : null
  }
  if (t === 'SIM_DEPENDENT_BUNDLE') {
    const r = await supabase.select('price_plan_sim_dependent_bundle', q)
    return Array.isArray(r) ? r[0] : null
  }
  if (t === 'ONE_TIME') {
    const r = await supabase.select('price_plan_one_time', q)
    return Array.isArray(r) ? r[0] : null
  }
  if (t === 'TIERED_VOLUME_PRICING') {
    const r = await supabase.select('price_plan_tiered_volume_pricing', q)
    return Array.isArray(r) ? r[0] : null
  }
  return null
}

async function fetchChildMapsForPlanIds(supabase: SupabaseClient, ids: string[]) {
  const empty = {
    fb: new Map<string, any>(),
    sdb: new Map<string, any>(),
    ot: new Map<string, any>(),
    tv: new Map<string, any>(),
  }
  if (!ids.length) return empty
  const inList = ids.map((id) => encodeURIComponent(id)).join(',')
  const q = `select=*&price_plan_id=in.(${inList})`
  const [fbRows, sdbRows, otRows, tvRows] = await Promise.all([
    supabase.select('price_plan_fixed_bundle', q),
    supabase.select('price_plan_sim_dependent_bundle', q),
    supabase.select('price_plan_one_time', q),
    supabase.select('price_plan_tiered_volume_pricing', q),
  ])
  const toMap = (rows: unknown) =>
    new Map<string, any>(
      (Array.isArray(rows) ? rows : [])
        .map((r: any) => [String(r?.price_plan_id ?? ''), r] as [string, any])
        .filter((e): e is [string, any] => Boolean(e[0]))
    )
  return { fb: toMap(fbRows), sdb: toMap(sdbRows), ot: toMap(otRows), tv: toMap(tvRows) }
}

function mergeListRow(parent: any, maps: Awaited<ReturnType<typeof fetchChildMapsForPlanIds>>) {
  const t = String(parent?.type ?? '').trim()
  const pid = String(parent?.price_plan_id ?? '')
  const child =
    t === 'FIXED_BUNDLE'
      ? maps.fb.get(pid)
      : t === 'SIM_DEPENDENT_BUNDLE'
        ? maps.sdb.get(pid)
        : t === 'ONE_TIME'
          ? maps.ot.get(pid)
          : t === 'TIERED_VOLUME_PRICING'
            ? maps.tv.get(pid)
            : null
  return mergeChildIntoParentRow(parent, child, t)
}

async function insertPricingExtensionRow(
  supabase: SupabaseClient,
  pricePlanId: string,
  planType: string,
  v: {
    monthlyFee: number | null
    deactivatedMonthlyFee: number | null
    oneTimeFee: number | null
    quotaMb: number | null
    validityDays: number | null
    perSimQuotaMb: number | null
    totalQuotaMb: number | null
    overageRatePerMb: number | null
    tiers: unknown[] | null
    expiryBoundary: string | null
  }
) {
  const t = String(planType || '').trim()
  if (t === 'FIXED_BUNDLE') {
    await supabase.insert(
      'price_plan_fixed_bundle',
      {
        price_plan_id: pricePlanId,
        monthly_fee: v.monthlyFee ?? 0,
        deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
        total_quota_mb: v.totalQuotaMb,
        overage_rate_per_mb: v.overageRatePerMb,
      },
      { returning: 'minimal' }
    )
  } else if (t === 'SIM_DEPENDENT_BUNDLE') {
    await supabase.insert(
      'price_plan_sim_dependent_bundle',
      {
        price_plan_id: pricePlanId,
        monthly_fee: v.monthlyFee ?? 0,
        deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
        per_sim_quota_mb: v.perSimQuotaMb,
        overage_rate_per_mb: v.overageRatePerMb,
      },
      { returning: 'minimal' }
    )
  } else if (t === 'ONE_TIME') {
    await supabase.insert(
      'price_plan_one_time',
      {
        price_plan_id: pricePlanId,
        one_time_fee: v.oneTimeFee ?? 0,
        quota_mb: v.quotaMb ?? 0,
        validity_days: v.validityDays ?? 1,
        expiry_boundary: v.expiryBoundary ?? 'CALENDAR_DAY_END',
      },
      { returning: 'minimal' }
    )
  } else if (t === 'TIERED_VOLUME_PRICING') {
    await supabase.insert(
      'price_plan_tiered_volume_pricing',
      {
        price_plan_id: pricePlanId,
        monthly_fee: v.monthlyFee ?? 0,
        deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
        tiers: v.tiers ?? [],
        overage_rate_per_mb: v.overageRatePerMb,
      },
      { returning: 'minimal' }
    )
  }
}

async function updatePricingExtensionRow(
  supabase: SupabaseClient,
  pricePlanId: string,
  planType: string,
  v: {
    monthlyFee: number | null
    deactivatedMonthlyFee: number | null
    oneTimeFee: number | null
    quotaMb: number | null
    validityDays: number | null
    perSimQuotaMb: number | null
    totalQuotaMb: number | null
    overageRatePerMb: number | null
    tiers: unknown[] | null
    expiryBoundary: string | null
  }
) {
  const enc = encodeURIComponent(pricePlanId)
  const t = String(planType || '').trim()
  if (t === 'FIXED_BUNDLE') {
    await supabase.update(
      'price_plan_fixed_bundle',
      `price_plan_id=eq.${enc}`,
      {
        monthly_fee: v.monthlyFee ?? 0,
        deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
        total_quota_mb: v.totalQuotaMb,
        overage_rate_per_mb: v.overageRatePerMb,
      },
      { returning: 'minimal' }
    )
  } else if (t === 'SIM_DEPENDENT_BUNDLE') {
    await supabase.update(
      'price_plan_sim_dependent_bundle',
      `price_plan_id=eq.${enc}`,
      {
        monthly_fee: v.monthlyFee ?? 0,
        deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
        per_sim_quota_mb: v.perSimQuotaMb,
        overage_rate_per_mb: v.overageRatePerMb,
      },
      { returning: 'minimal' }
    )
  } else if (t === 'ONE_TIME') {
    await supabase.update(
      'price_plan_one_time',
      `price_plan_id=eq.${enc}`,
      {
        one_time_fee: v.oneTimeFee ?? 0,
        quota_mb: v.quotaMb ?? 0,
        validity_days: v.validityDays ?? 1,
        expiry_boundary: v.expiryBoundary ?? 'CALENDAR_DAY_END',
      },
      { returning: 'minimal' }
    )
  } else if (t === 'TIERED_VOLUME_PRICING') {
    await supabase.update(
      'price_plan_tiered_volume_pricing',
      `price_plan_id=eq.${enc}`,
      {
        monthly_fee: v.monthlyFee ?? 0,
        deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
        tiers: v.tiers ?? [],
        overage_rate_per_mb: v.overageRatePerMb,
      },
      { returning: 'minimal' }
    )
  }
}

/**
 * Public snapshot — discriminated by `type` (aligned with Create request shapes).
 * `price_plan_type` mirrors API discriminator (TIERED_PRICING alias for TIERED_VOLUME_PRICING).
 */
function mapPricePlanApiRow(version: any) {
  if (!version) return null
  const status = resolveVersionStatus(version)
  const internalType = String(version.type ?? '').trim()
  const apiPlanType = internalType === 'TIERED_VOLUME_PRICING' ? 'TIERED_PRICING' : internalType
  const common: Record<string, unknown> = {
    pricePlanId: version.price_plan_id,
    enterpriseId: version.enterprise_id ?? null,
    resellerId: version.reseller_id ?? null,
    sourcePricePlanId: version.source_price_plan_id ?? null,
    name: version.name ?? null,
    type: internalType,
    price_plan_type: apiPlanType,
    serviceType: version.service_type ?? null,
    currency: version.currency ?? null,
    status,
    createdAt: version.created_at ?? null,
    effectiveFrom: version.effective_from,
    deprecatedAt: version.deprecated_at ?? null,
    billingCycleType: version.billing_cycle_type ?? null,
    firstCycleProration: version.first_cycle_proration ?? null,
    prorationRounding: version.proration_rounding ?? null,
    coveredNetworkProfileId: version.covered_network_profile_id ?? null,
  }
  if (internalType === 'ONE_TIME') {
    return {
      ...common,
      oneTimeFee: version.one_time_fee,
      quotaMb: version.quota_mb,
      validityDays: version.validity_days,
      expiryBoundary: version.expiry_boundary ?? null,
    }
  }
  if (internalType === 'SIM_DEPENDENT_BUNDLE') {
    return {
      ...common,
      monthlyFee: version.monthly_fee,
      deactivatedMonthlyFee: version.deactivated_monthly_fee,
      perSimQuotaMb: version.per_sim_quota_mb,
      overageRatePerMb: version.overage_rate_per_mb,
    }
  }
  if (internalType === 'FIXED_BUNDLE') {
    return {
      ...common,
      monthlyFee: version.monthly_fee,
      deactivatedMonthlyFee: version.deactivated_monthly_fee,
      totalQuotaMb: version.total_quota_mb,
      overageRatePerMb: version.overage_rate_per_mb,
    }
  }
  if (internalType === 'TIERED_VOLUME_PRICING') {
    return {
      ...common,
      monthlyFee: version.monthly_fee,
      deactivatedMonthlyFee: version.deactivated_monthly_fee,
      tiers: version.tiers ?? null,
      overageRatePerMb: version.overage_rate_per_mb,
    }
  }
  return {
    ...common,
    monthlyFee: version.monthly_fee,
    deactivatedMonthlyFee: version.deactivated_monthly_fee,
    oneTimeFee: version.one_time_fee,
    quotaMb: version.quota_mb,
    validityDays: version.validity_days,
    perSimQuotaMb: version.per_sim_quota_mb,
    totalQuotaMb: version.total_quota_mb,
    overageRatePerMb: version.overage_rate_per_mb,
    tiers: version.tiers ?? null,
    expiryBoundary: version.expiry_boundary ?? null,
  }
}

export async function createPricePlan({
  supabase,
  enterpriseId,
  resellerId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  resellerId: string
  payload: unknown
  audit?: AuditContext
}) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  }
  const scope = await assertEnterpriseBelongsToReseller(supabase, enterpriseId, resellerId)
  if (!scope.ok) return scope
  const validated = validatePayload(payload, { requireCommonFields: true })
  if (!validated.ok) return validated
  const {
    name,
    type,
    serviceType,
    currency,
    billingCycleType,
    firstCycleProration,
    prorationRounding,
    expiryBoundary,
    monthlyFee,
    deactivatedMonthlyFee,
    oneTimeFee,
    quotaMb,
    validityDays,
    perSimQuotaMb,
    totalQuotaMb,
    overageRatePerMb,
    tiers,
  } = validated.value
  const coveredResolved = await resolveCoveredNetworkProfileIdForWrite(
    supabase,
    enterpriseId,
    type,
    payload,
    null,
    'create',
    { requirePublished: true }
  )
  if (!coveredResolved.ok) return coveredResolved
  try {
    const created = await supabase.insert(
      'price_plans',
      {
        enterprise_id: enterpriseId,
        reseller_id: resellerId,
        name,
        type,
        service_type: serviceType,
        currency,
        billing_cycle_type: billingCycleType,
        first_cycle_proration: firstCycleProration,
        source_price_plan_id: null,
        version: 1,
        status: 'DRAFT',
        effective_from: null,
        proration_rounding: prorationRounding,
        covered_network_profile_id: coveredResolved.value,
      },
      { returning: 'representation' }
    )
    const plan = Array.isArray(created) ? created[0] : null
    if (!(plan as any)?.price_plan_id) {
      return toError(500, 'INTERNAL_ERROR', 'Failed to create price plan.')
    }
    await insertPricingExtensionRow(supabase, String((plan as any).price_plan_id), type, {
      monthlyFee,
      deactivatedMonthlyFee,
      oneTimeFee,
      quotaMb,
      validityDays,
      perSimQuotaMb,
      totalQuotaMb,
      overageRatePerMb,
      tiers,
      expiryBoundary,
    })
    if ((plan as any)?.price_plan_id) {
      await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: enterpriseId ?? null,
        action: 'PRICE_PLAN_CREATED',
        target_type: 'PRICE_PLAN',
        target_id: (plan as any).price_plan_id,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: {
          pricePlanId: (plan as any).price_plan_id,
        },
      })
    }
    return {
      ok: true,
      value: {
        pricePlanId: (plan as any).price_plan_id,
        status: 'DRAFT',
        createdAt: (plan as any).created_at,
      },
    }
  } catch (error) {
    return mapUpstreamFailure(error)
  }
}

export async function listPricePlans({
  supabase,
  enterpriseId,
  resellerId,
  type,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  resellerId: string
  type?: string | null
  status?: string | null
  page?: number | string | null
  pageSize?: number | string | null
}): Promise<ServiceResult<{ items: unknown[]; total: number; page: number; pageSize: number }>> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  }
  const listScope = await assertEnterpriseBelongsToReseller(supabase, enterpriseId, resellerId)
  if (!listScope.ok) return listScope
  const statusFilter = status ? String(status).trim().toUpperCase() : null
  if (
    statusFilter &&
    statusFilter !== 'DRAFT' &&
    statusFilter !== 'PUBLISHED' &&
    statusFilter !== 'DEPRECATED'
  ) {
    return toError(400, 'BAD_REQUEST', 'status is invalid.')
  }
  const typeFilterRaw = type ? String(type).trim().toUpperCase() : null
  const typeFilter =
    typeFilterRaw === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : typeFilterRaw
  const allowedListTypes = new Set([
    'ONE_TIME',
    'SIM_DEPENDENT_BUNDLE',
    'FIXED_BUNDLE',
    'TIERED_VOLUME_PRICING',
  ])
  if (typeFilter && !allowedListTypes.has(typeFilter)) {
    return toError(
      400,
      'BAD_REQUEST',
      'type is invalid.'
    )
  }
  const planRows = await supabase.select(
    'price_plans',
    `select=${PRICE_PLAN_PARENT_SELECT}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&reseller_id=eq.${encodeURIComponent(resellerId)}${typeFilter ? `&type=eq.${encodeURIComponent(typeFilter)}` : ''}${statusFilter ? `&status=eq.${encodeURIComponent(statusFilter)}` : ''}&order=created_at.desc`
  )
  const plans = Array.isArray(planRows) ? planRows : []
  const ids = plans.map((p: any) => String(p?.price_plan_id ?? '')).filter(Boolean)
  const maps = await fetchChildMapsForPlanIds(supabase, ids)
  let items = plans
    .map((plan: any) => mapPricePlanApiRow(mergeListRow(plan, maps)))
    .filter(Boolean) as Record<string, unknown>[]
  const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 500 })
  const total = items.length
  const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize)
  return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) }
}

export async function getPricePlanDetail({ supabase, pricePlanId }: { supabase: SupabaseClient; pricePlanId: string }) {
  if (!isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId is invalid.')
  }
  const plan = await loadPricePlan(supabase, pricePlanId)
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  return {
    ok: true,
    value: mapPricePlanApiRow(plan),
  }
}

/**
 * Batch-resolve {@link mapPricePlanApiRow} snapshots for many `price_plan_id` (parent + 1:1 child rows).
 * Used by package list to embed `PricePlanSnapshot` without N+1 round-trips.
 */
export async function batchMapPricePlanSnapshotsByIds(
  supabase: SupabaseClient,
  pricePlanIds: string[]
): Promise<Map<string, Record<string, unknown> | null>> {
  const out = new Map<string, Record<string, unknown> | null>()
  const unique = [...new Set(pricePlanIds.map((x) => String(x).trim()).filter(Boolean))]
  for (const id of unique) out.set(id, null)
  if (!unique.length) return out
  const inList = unique.map((id) => encodeURIComponent(id)).join(',')
  const planRows = await supabase.select(
    'price_plans',
    `select=${PRICE_PLAN_PARENT_SELECT}&price_plan_id=in.(${inList})`
  )
  const plans = Array.isArray(planRows) ? planRows : []
  const maps = await fetchChildMapsForPlanIds(supabase, unique)
  for (const p of plans) {
    const pid = p?.price_plan_id != null ? String((p as any).price_plan_id).trim() : ''
    if (!pid) continue
    const merged = mergeListRow(p, maps)
    out.set(pid, mapPricePlanApiRow(merged))
  }
  return out
}

export async function updatePricePlan({
  supabase,
  pricePlanId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  pricePlanId: string
  payload: unknown
  audit?: AuditContext
}) {
  if (!isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId is invalid.')
  }
  const plan = await loadPricePlan(supabase, pricePlanId)
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  if (resolveVersionStatus(plan as any) !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT price plans can be updated.')
  }
  const payloadTypeRaw = String((payload as any)?.price_plan_type ?? (payload as any)?.type ?? '').trim()
  if (payloadTypeRaw) {
    const payloadType = payloadTypeRaw === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : payloadTypeRaw
    const planType = String((plan as any).type ?? '').trim()
    if (payloadType !== planType) {
      return toError(
        400,
        'BAD_REQUEST',
        `price_plan_type must match the existing price plan type. Allowed Values: ${planType}.`
      )
    }
  }
  if ((payload as any)?.currency !== undefined) {
    const payloadCurrency = String((payload as any)?.currency ?? '').trim().toUpperCase()
    if (!isValidIso4217Currency(payloadCurrency)) {
      return toError(400, 'BAD_REQUEST', 'currency must be ISO 4217 code.')
    }
  }
  const validated = validatePayload(
    {
      ...(payload as any),
      name: String((payload as any)?.name ?? '').trim() || (plan as any).name,
      type: (plan as any).type,
      serviceType: (plan as any).service_type,
      currency: (plan as any).currency,
      billingCycleType: (plan as any).billing_cycle_type,
      firstCycleProration: (plan as any).first_cycle_proration,
      prorationRounding:
        (payload as any)?.prorationRounding ?? (plan as any).proration_rounding ?? 'ROUND_HALF_UP',
      expiryBoundary: (payload as any)?.expiryBoundary ?? (plan as any).expiry_boundary,
    },
    { requireCommonFields: false }
  )
  if (!validated.ok) return validated
  const {
    name: nextName,
    monthlyFee,
    deactivatedMonthlyFee,
    oneTimeFee,
    quotaMb,
    validityDays,
    perSimQuotaMb,
    totalQuotaMb,
    overageRatePerMb,
    tiers,
    prorationRounding: nextProrationRounding,
    expiryBoundary: nextExpiryBoundary,
  } = validated.value
  const coveredResolved = await resolveCoveredNetworkProfileIdForWrite(
    supabase,
    String((plan as any).enterprise_id ?? ''),
    String((plan as any).type ?? ''),
    payload,
    (plan as any).covered_network_profile_id ?? null,
    'update',
    { requirePublished: true }
  )
  if (!coveredResolved.ok) return coveredResolved
  try {
    const rows = await supabase.update(
      'price_plans',
      `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`,
      {
        name: nextName,
        proration_rounding: nextProrationRounding,
        covered_network_profile_id: coveredResolved.value,
      },
      { returning: 'representation' }
    )
    const version = Array.isArray(rows) ? rows[0] : null
    if (!(version as any)?.price_plan_id) {
      return toError(500, 'INTERNAL_ERROR', 'Failed to update price plan.')
    }
    await updatePricingExtensionRow(supabase, pricePlanId, String((plan as any).type ?? ''), {
      monthlyFee,
      deactivatedMonthlyFee,
      oneTimeFee,
      quotaMb,
      validityDays,
      perSimQuotaMb,
      totalQuotaMb,
      overageRatePerMb,
      tiers,
      expiryBoundary: nextExpiryBoundary,
    })
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: (plan as any).enterprise_id ?? null,
      action: 'PRICE_PLAN_UPDATED',
      target_type: 'PRICE_PLAN',
      target_id: pricePlanId,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: { pricePlanId },
    })
    const merged = await loadPricePlan(supabase, pricePlanId)
    if (!merged) return toError(500, 'INTERNAL_ERROR', 'Failed to load price plan after update.')
    return { ok: true, value: mapPricePlanApiRow(merged) }
  } catch (error) {
    return mapUpstreamFailure(error)
  }
}

export async function publishPricePlan({
  supabase,
  pricePlanId,
  audit,
}: {
  supabase: SupabaseClient
  pricePlanId: string
  audit?: AuditContext
}) {
  if (!isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId is invalid.')
  }
  const plan = await loadPricePlan(supabase, pricePlanId)
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  if (resolveVersionStatus(plan as any) !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT price plans can be published.')
  }
  const planType = String((plan as any).type ?? '').trim()
  const enterpriseId = String((plan as any).enterprise_id ?? '').trim()
  const coveredId = String((plan as any).covered_network_profile_id ?? '').trim() || null
  if (pricePlanTypeUsesCoveredNetwork(planType)) {
    if (!coveredId) {
      return toError(409, 'INVALID_STATUS', 'coveredNetworkProfileId must be set before publishing the price plan.')
    }
    const coveredCheck = await validateCoveredNetworkProfileForPricePlan(
      supabase,
      enterpriseId,
      coveredId,
      { requirePublished: true }
    )
    if (!coveredCheck.ok) return coveredCheck
  }
  const nowIso = new Date().toISOString()
  try {
    const rows = await supabase.update(
      'price_plans',
      `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`,
      { effective_from: nowIso, status: 'PUBLISHED' },
      { returning: 'representation' }
    )
    const version = Array.isArray(rows) ? rows[0] : null
    if (!(version as any)?.price_plan_id) {
      return toError(500, 'INTERNAL_ERROR', 'Failed to publish price plan.')
    }
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: (plan as any).enterprise_id ?? null,
      action: 'PRICE_PLAN_PUBLISHED',
      target_type: 'PRICE_PLAN',
      target_id: pricePlanId,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: { pricePlanId, effectiveFrom: nowIso },
    })
    const merged = await loadPricePlan(supabase, pricePlanId)
    if (!merged) return toError(500, 'INTERNAL_ERROR', 'Failed to load price plan after publish.')
    return { ok: true, value: mapPricePlanApiRow(merged) }
  } catch (error) {
    return mapUpstreamFailure(error)
  }
}

export async function deprecatePricePlan({
  supabase,
  pricePlanId,
  audit,
}: {
  supabase: SupabaseClient
  pricePlanId: string
  audit?: AuditContext
}) {
  if (!isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId is invalid.')
  }
  const plan = await loadPricePlan(supabase, pricePlanId)
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  if (resolveVersionStatus(plan as any) !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED price plans can be deprecated.')
  }
  const referencingPackageIds = await listLatestReferencingPackageIds(supabase, pricePlanId)
  if (referencingPackageIds.length) {
    return toError(
      409,
      'RESOURCE_IN_USE',
      `Price plan is referenced by packageId(s): ${referencingPackageIds.join(', ')}.`
    )
  }
  const nowIso = new Date().toISOString()
  try {
    const rows = await supabase.update(
      'price_plans',
      `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`,
      { deprecated_at: nowIso, status: 'DEPRECATED' },
      { returning: 'representation' }
    )
    const version = Array.isArray(rows) ? rows[0] : null
    if (!(version as any)?.price_plan_id) {
      return toError(500, 'INTERNAL_ERROR', 'Failed to deprecate price plan.')
    }
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: (plan as any).enterprise_id ?? null,
      action: 'PRICE_PLAN_DEPRECATED',
      target_type: 'PRICE_PLAN',
      target_id: pricePlanId,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: { pricePlanId, deprecatedAt: nowIso },
    })
    const merged = await loadPricePlan(supabase, pricePlanId)
    if (!merged) return toError(500, 'INTERNAL_ERROR', 'Failed to load price plan after deprecate.')
    return { ok: true, value: mapPricePlanApiRow(merged) }
  } catch (error) {
    return mapUpstreamFailure(error)
  }
}
