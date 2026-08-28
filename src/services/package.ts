import {
  extractControlPolicyFromPayload,
  finalizeControlPolicyMerged,
  normalizeControlPolicy,
  stripLegacyControlPolicyKeys,
} from '../utils/controlPolicyJson.js'
import { buildPaginationResponse, parsePagination } from '../utils/pagination.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'
import { pricePlanTypeUsesCoveredNetwork, batchMapPricePlanSnapshotsByIds } from './pricePlan.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  selectWithCount?: (
    table: string,
    queryString: string
  ) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
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

function toInteger(value: unknown) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Number.isInteger(num) ? num : Math.trunc(num)
}

function firstDayNextMonthUtc() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0))
}

async function loadOperatorByOperatorId(
  supabase: SupabaseClient,
  operatorId: string,
  supplierId?: string | null
) {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const rows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id,business_operator_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadOperatorByBusinessOperatorId(
  supabase: SupabaseClient,
  businessOperatorId: string,
  supplierId?: string | null
) {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const rows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id,business_operator_id&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}${supplierFilter}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

/** Resolves supplier-scoped operators row: try operators.operator_id first, then business_operator_id (+ optional supplier). */
async function loadOperator(supabase: SupabaseClient, operatorId: string, supplierId?: string | null) {
  const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId)
  if (byOperatorId) return byOperatorId
  return loadOperatorByBusinessOperatorId(supabase, operatorId, supplierId)
}

/** Same as GET /apn-profiles: `operatorId` may be `operators.operator_id` or `operators.business_operator_id`. */
async function resolveBoundOperatorIds(
  supabase: SupabaseClient,
  operatorId: string,
  supplierId?: string | null
): Promise<string[]> {
  const ids = new Set<string>()
  const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId)
  if ((byOperatorId as any)?.operator_id) ids.add(String((byOperatorId as any).operator_id))
  const byBusinessOperatorId = await loadOperatorByBusinessOperatorId(supabase, operatorId, supplierId)
  if ((byBusinessOperatorId as any)?.operator_id) ids.add(String((byBusinessOperatorId as any).operator_id))
  return Array.from(ids)
}

function mccmncAllowlistStringsFromRoamingProfileList(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const mcc = String((e as any).mcc ?? '').trim()
    const mncRaw = String((e as any).mnc ?? '').trim()
    if (!mcc) continue
    if (!mncRaw || mncRaw === '*') out.push(`${mcc}-*`)
    else out.push(`${mcc}-${mncRaw}`)
  }
  return out
}

async function loadApnFromApnProfile(supabase: SupabaseClient, apnProfileId: string): Promise<ServiceResult<string>> {
  const rows = await supabase.select(
    'apn_profiles',
    `select=apn&apn_profile_id=eq.${encodeURIComponent(apnProfileId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  const apn = row && (row as any).apn != null ? String((row as any).apn).trim() : ''
  if (!apn) return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.apnProfileId is not found or apn is empty.')
  return { ok: true, value: apn }
}

async function batchApnStringsByProfileIds(supabase: SupabaseClient, profileIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(profileIds.map((x) => String(x).trim()).filter(Boolean))]
  if (!unique.length) return out
  const list = unique.map((x) => encodeURIComponent(x)).join(',')
  const rows = await supabase.select('apn_profiles', `select=apn_profile_id,apn&apn_profile_id=in.(${list})`)
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = (r as any)?.apn_profile_id != null ? String((r as any).apn_profile_id).trim() : ''
    const apn = (r as any)?.apn != null ? String((r as any).apn).trim() : ''
    if (id && apn) out.set(id, apn)
  }
  return out
}

async function buildRoamingProfileSnapshotFromProfiles(
  supabase: SupabaseClient,
  carrierServiceConfig: Record<string, unknown>
): Promise<ServiceResult<Record<string, unknown>>> {
  const rat = String((carrierServiceConfig as any).rat ?? '4G').trim()
  const roamingProfileId = String((carrierServiceConfig as any).roamingProfileId ?? '').trim()
  const apnProfileIdRaw = (carrierServiceConfig as any).apnProfileId
  const apnProfileId = apnProfileIdRaw ? String(apnProfileIdRaw).trim() : ''
  const rows = await supabase.select(
    'roaming_profiles',
    `select=mccmnc_list&roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.roamingProfileId is not found.')
  const mccmnc = mccmncAllowlistStringsFromRoamingProfileList((row as any).mccmnc_list)
  const payload: Record<string, unknown> = {
    type: 'MCCMNC_ALLOWLIST',
    mccmnc,
    rat,
    profileId: roamingProfileId,
  }
  if (apnProfileId) payload.apnProfileId = apnProfileId
  return { ok: true, value: payload }
}

function isPlainObject(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractPricePlanMeta(_version: any) {
  return {}
}

function normalizeCommercialTerms(input: unknown): ServiceResult<Record<string, unknown> | null> {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (!isPlainObject(input)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms is invalid.')
  }
  const rawObj = input as Record<string, unknown>
  const allowedKeys = new Set([
    'testPeriodDays',
    'testQuotaMb',
    'testExpiryCondition',
    'testExpiryAction',
    'commitmentPeriodMonths',
    'commitmentPeriodDays',
  ])
  for (const key of Object.keys(rawObj)) {
    if (!allowedKeys.has(key)) {
      return toError(400, 'BAD_REQUEST', `commercialTerms.${key} is not allowed.`)
    }
  }
  const parseOptionalNonNegativeInteger = (
    raw: unknown,
    fieldName: string,
    opts?: { required?: boolean }
  ): ServiceResult<number | undefined> => {
    if (raw === undefined) return { ok: true, value: undefined }
    if (raw === null) {
      return toError(400, 'BAD_REQUEST', opts?.required ? `${fieldName} is required.` : `${fieldName} is invalid.`)
    }
    if (typeof raw === 'string' && raw.trim() === '') {
      return toError(400, 'BAD_REQUEST', opts?.required ? `${fieldName} is required.` : `${fieldName} is invalid.`)
    }
    const num = Number(raw)
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
      return toError(400, 'BAD_REQUEST', `${fieldName} is invalid.`)
    }
    return { ok: true, value: num }
  }
  const src = input as any
  const testPeriodDaysParsed = parseOptionalNonNegativeInteger(src.testPeriodDays, 'commercialTerms.testPeriodDays')
  if (!testPeriodDaysParsed.ok) return testPeriodDaysParsed
  const testQuotaMbParsed = parseOptionalNonNegativeInteger(src.testQuotaMb, 'commercialTerms.testQuotaMb')
  if (!testQuotaMbParsed.ok) return testQuotaMbParsed
  const commitmentPeriodMonthsParsed = parseOptionalNonNegativeInteger(
    src.commitmentPeriodMonths,
    'commercialTerms.commitmentPeriodMonths'
  )
  if (!commitmentPeriodMonthsParsed.ok) return commitmentPeriodMonthsParsed
  const commitmentPeriodDaysParsed = parseOptionalNonNegativeInteger(
    src.commitmentPeriodDays,
    'commercialTerms.commitmentPeriodDays'
  )
  if (!commitmentPeriodDaysParsed.ok) return commitmentPeriodDaysParsed
  const testExpiryConditionRaw = src.testExpiryCondition
  const testExpiryActionRaw = src.testExpiryAction
  const testPeriodDays = testPeriodDaysParsed.value
  const testQuotaMb = testQuotaMbParsed.value
  const commitmentPeriodMonths = commitmentPeriodMonthsParsed.value
  const commitmentPeriodDays = commitmentPeriodDaysParsed.value
  const testExpiryCondition = testExpiryConditionRaw === undefined ? undefined : String(testExpiryConditionRaw).trim().toUpperCase()
  const testExpiryAction = testExpiryActionRaw === undefined ? undefined : String(testExpiryActionRaw).trim().toUpperCase()
  if (testExpiryConditionRaw === null || (typeof testExpiryConditionRaw === 'string' && testExpiryConditionRaw.trim() === '')) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testExpiryCondition is required.')
  }
  if (testExpiryActionRaw === null || (typeof testExpiryActionRaw === 'string' && testExpiryActionRaw.trim() === '')) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testExpiryAction is required.')
  }
  const allowedTestExpiryConditions = ['PERIOD_ONLY', 'QUOTA_ONLY', 'PERIOD_OR_QUOTA'] as const
  const allowedCondition = new Set<string>(allowedTestExpiryConditions)
  if (testExpiryCondition !== undefined && !allowedCondition.has(testExpiryCondition)) {
    return toError(
      400,
      'BAD_REQUEST',
      `commercialTerms.testExpiryCondition is invalid. Allowed values: ${allowedTestExpiryConditions.join(', ')}.`
    )
  }
  const allowedTestExpiryActions = ['ACTIVATED', 'DEACTIVATED'] as const
  const allowedAction = new Set<string>(allowedTestExpiryActions)
  if (testExpiryAction !== undefined && !allowedAction.has(testExpiryAction)) {
    return toError(
      400,
      'BAD_REQUEST',
      `commercialTerms.testExpiryAction is invalid. Allowed values: ${allowedTestExpiryActions.join(', ')}.`
    )
  }
  const requiredFields: Array<{ key: string; message: string }> = [
    { key: 'testPeriodDays', message: 'commercialTerms.testPeriodDays is required.' },
    { key: 'testQuotaMb', message: 'commercialTerms.testQuotaMb is required.' },
    { key: 'testExpiryCondition', message: 'commercialTerms.testExpiryCondition is required.' },
    { key: 'testExpiryAction', message: 'commercialTerms.testExpiryAction is required.' },
    { key: 'commitmentPeriodMonths', message: 'commercialTerms.commitmentPeriodMonths is required.' },
    { key: 'commitmentPeriodDays', message: 'commercialTerms.commitmentPeriodDays is required.' },
  ]
  for (const { key, message } of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(rawObj, key)) {
      return toError(400, 'BAD_REQUEST', message)
    }
  }
  return {
    ok: true,
    value: {
      ...(testPeriodDays !== undefined ? { testPeriodDays } : {}),
      ...(testQuotaMb !== undefined ? { testQuotaMb } : {}),
      ...(testExpiryCondition !== undefined ? { testExpiryCondition } : {}),
      ...(testExpiryAction !== undefined ? { testExpiryAction } : {}),
      ...(commitmentPeriodMonths !== undefined ? { commitmentPeriodMonths } : {}),
      ...(commitmentPeriodDays !== undefined ? { commitmentPeriodDays } : {}),
    },
  }
}

function normalizeCarrierServiceConfig(input: unknown): ServiceResult<Record<string, unknown>> {
  if (!isPlainObject(input)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig is invalid.')
  }
  const raw = input as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(raw, 'apn')) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.apn is no longer supported. Use apnProfileId only.')
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'roamingProfile')) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.roamingProfile is no longer supported. Use roamingProfileId only.')
  }
  const src = input as any
  const supplierId = String(src.supplierId ?? '').trim()
  if (!isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.supplierId is invalid.')
  }
  const operatorIdRaw = String(src.operatorId ?? '').trim()
  if (!isValidUuid(operatorIdRaw)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.operatorId is invalid.')
  }
  const rat = String(src.rat ?? '4G').trim().toUpperCase()
  const allowedRat = new Set(['3G', '4G', '5G', 'NB-IOT'])
  if (!allowedRat.has(rat)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.rat is invalid.')
  }
  const apnProfileVersionId = src.apnProfileVersionId ? String(src.apnProfileVersionId).trim() : null
  if (apnProfileVersionId) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.apnProfileVersionId is no longer supported. Use carrierServiceConfig.apnProfileId.')
  }
  const apnProfileId = src.apnProfileId ? String(src.apnProfileId).trim() : null
  if (!apnProfileId || !isValidUuid(apnProfileId)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.apnProfileId is invalid.')
  }
  const roamingProfileId = src.roamingProfileId ? String(src.roamingProfileId).trim() : null
  if (!roamingProfileId || !isValidUuid(roamingProfileId)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.roamingProfileId is invalid.')
  }
  return {
    ok: true,
    value: {
      supplierId,
      operatorId: operatorIdRaw,
      rat,
      apnProfileId,
      roamingProfileId,
    },
  }
}

async function ensureProfileMatchesCarrierContext(
  supabase: SupabaseClient,
  profileId: string,
  profileType: 'APN' | 'ROAMING',
  supplierId: string,
  resolvedOperatorId: string
): Promise<ServiceResult<null>> {
  const table = profileType === 'APN' ? 'apn_profiles' : 'roaming_profiles'
  const key = profileType === 'APN' ? 'apn_profile_id' : 'roaming_profile_id'
  const field = profileType === 'APN' ? 'apnProfileId' : 'roamingProfileId'
  const rows = await supabase.select(
    table,
    `select=${key},supplier_id,operator_id,status&${key}=eq.${encodeURIComponent(profileId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || !(row as any)?.[key]) {
    return toError(400, 'BAD_REQUEST', `carrierServiceConfig.${field} is not found.`)
  }
  if (String((row as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(400, 'BAD_REQUEST', `carrierServiceConfig.${field} must reference a PUBLISHED profile snapshot.`)
  }
  if (String((row as any).supplier_id ?? '') !== supplierId) {
    return toError(400, 'BAD_REQUEST', `carrierServiceConfig.${field} is not linked to supplierId.`)
  }
  if (String((row as any).operator_id ?? '') !== resolvedOperatorId) {
    return toError(400, 'BAD_REQUEST', `carrierServiceConfig.${field} is not linked to operatorId.`)
  }
  return { ok: true, value: null }
}

type ResellerRow = { id: string; tenant_id: string }

async function loadResellerRowByRef(supabase: SupabaseClient, ref: string): Promise<ServiceResult<ResellerRow | null>> {
  const trimmed = String(ref ?? '').trim()
  if (!trimmed) return { ok: true, value: null }
  if (!isValidUuid(trimmed)) return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  const byTenantRows = await supabase.select(
    'resellers',
    `select=id,tenant_id&tenant_id=eq.${encodeURIComponent(trimmed)}&limit=1`
  )
  const byTenant = Array.isArray(byTenantRows) ? byTenantRows[0] : null
  if (byTenant && (byTenant as any).id && (byTenant as any).tenant_id) {
    return { ok: true, value: { id: String((byTenant as any).id), tenant_id: String((byTenant as any).tenant_id) } }
  }
  return toError(404, 'RESOURCE_NOT_FOUND', 'resellerId not found.')
}

/** API `resellerId` MUST be RESELLER `tenants.tenant_id`; not `resellers.id`. */
async function canonicalResellerTenantIdFromRef(supabase: SupabaseClient, ref: string): Promise<ServiceResult<string>> {
  const trimmed = String(ref || '').trim()
  if (!trimmed || !isValidUuid(trimmed)) {
    return toError(403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
  }
  const rrow = await loadResellerRowByRef(supabase, trimmed)
  if (!rrow.ok) return rrow
  if (!rrow.value?.tenant_id) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'resellerId not found.')
  }
  return { ok: true, value: String(rrow.value.tenant_id) }
}

/**
 * Resolve API `enterpriseId` to ENTERPRISE `tenants.tenant_id` for module table FKs.
 */
async function resolveEnterpriseTenantIdForRef(
  supabase: SupabaseClient,
  enterpriseRef: string
): Promise<ServiceResult<{ tenantId: string }>> {
  const ref = String(enterpriseRef || '').trim()
  if (!isValidUuid(ref)) return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  const tenantRows = await supabase.select(
    'tenants',
    `select=tenant_id&tenant_id=eq.${encodeURIComponent(ref)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const t = Array.isArray(tenantRows) ? tenantRows[0] : null
  if (t && (t as any).tenant_id) {
    return { ok: true, value: { tenantId: String((t as any).tenant_id) } }
  }
  return toError(404, 'RESOURCE_NOT_FOUND', 'enterpriseId not found.')
}

/** `resellerId` and `enterpriseId` must form a real RESELLER–ENTERPRISE parent row in `tenants`. */
export async function validateResellerOwnsEnterprise(
  supabase: SupabaseClient,
  resellerIdRef: string,
  enterpriseId: string
): Promise<ServiceResult<null>> {
  if (!isValidUuid(enterpriseId)) return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  const tRows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const t = Array.isArray(tRows) ? tRows[0] : null
  if (!t) return toError(404, 'RESOURCE_NOT_FOUND', 'enterpriseId not found.')
  const rCanon = await canonicalResellerTenantIdFromRef(supabase, resellerIdRef)
  if (!rCanon.ok) return rCanon
  if (String((t as any).parent_id || '') !== String(rCanon.value)) {
    return toError(400, 'BAD_REQUEST', 'resellerId and enterpriseId do not match.')
  }
  return { ok: true, value: null }
}

/**
 * `PUT /packages/{packageId}`: package exists, is DRAFT, and `resellerIdRef` owns the row's `enterpriseId`
 * (same RESELLER–ENTERPRISE rule as `validateResellerOwnsEnterprise`).
 */
export async function validateResellerAccessToUpdatePackage(
  supabase: SupabaseClient,
  packageId: string,
  resellerIdRef: string
): Promise<ServiceResult<{ packageEnterpriseId: string }>> {
  if (!isValidUuid(packageId)) {
    return toError(400, 'BAD_REQUEST', 'packageId is invalid.')
  }
  const row = await loadPackageRow(supabase, packageId)
  if (!row) return toError(404, 'NOT_FOUND', 'Package not found.')
  if (String((row as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT package can be updated.')
  }
  const packageEnterpriseId = String((row as any).enterprise_id || '').trim()
  if (!isValidUuid(packageEnterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'package.enterpriseId is invalid.')
  }
  const own = await validateResellerOwnsEnterprise(supabase, resellerIdRef, packageEnterpriseId)
  if (!own.ok) return own
  return { ok: true, value: { packageEnterpriseId } }
}

/**
 * `:publish` / `:deprecate`: package exists and `resellerIdRef` owns the package `enterpriseId`.
 * No `status` check — callers enforce publish/deprecate state rules.
 */
export async function validateResellerAccessToPackage(
  supabase: SupabaseClient,
  packageId: string,
  resellerIdRef: string
): Promise<ServiceResult<{ packageEnterpriseId: string }>> {
  if (!isValidUuid(packageId)) {
    return toError(400, 'BAD_REQUEST', 'packageId is invalid.')
  }
  const row = await loadPackageRow(supabase, packageId)
  if (!row) return toError(404, 'NOT_FOUND', 'Package not found.')
  const packageEnterpriseId = String((row as any).enterprise_id || '').trim()
  if (!isValidUuid(packageEnterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'package.enterpriseId is invalid.')
  }
  const own = await validateResellerOwnsEnterprise(supabase, resellerIdRef, packageEnterpriseId)
  if (!own.ok) return own
  return { ok: true, value: { packageEnterpriseId } }
}

/** Module `enterprise_id` column stores `tenants.tenant_id` (ENTERPRISE). */
function auditTenantIdFromModuleEnterpriseId(enterpriseFk: unknown): string | null {
  const tid = enterpriseFk != null ? String(enterpriseFk).trim() : ''
  if (!tid || !isValidUuid(tid)) return null
  return tid
}

/** Reseller catalog modules (commercial terms, control policy, carrier service) scope audit by `reseller_id` → RESELLER `tenants.tenant_id`. */
function auditTenantIdFromResellerModuleRow(row: { reseller_id?: unknown }): string | null {
  return auditTenantIdFromModuleEnterpriseId(row?.reseller_id)
}

async function assertResellerSupplierBinding(
  supabase: SupabaseClient,
  resellerTenantId: string,
  supplierId: string
): Promise<ServiceResult<null>> {
  const rows = await supabase.select(
    'reseller_suppliers',
    `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerTenantId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || !(row as any)?.supplier_id) {
    return toError(400, 'BAD_REQUEST', 'resellerId is not bound to carrierServiceConfig.supplierId.')
  }
  return { ok: true, value: null }
}

async function validateModuleReferences(
  supabase: SupabaseClient,
  carrierServiceConfig: Record<string, unknown>,
  controlPolicy: Record<string, unknown> | null,
  ctx?: { resellerRef?: unknown } | null
): Promise<ServiceResult<{ operatorId: string; supplierId: string }>> {
  const operatorIdInput = String((carrierServiceConfig as any).operatorId)
  const supplierId = String((carrierServiceConfig as any).supplierId)
  const operator = await loadOperator(supabase, operatorIdInput, supplierId)
  if (!operator) return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.operatorId is not found.')
  if (String((operator as any)?.supplier_id ?? '') !== supplierId) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.operatorId is not linked to supplierId.')
  }
  const resolvedOperatorId = String((operator as any).operator_id ?? '')
  if (!resolvedOperatorId) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.operatorId is not found.')
  }
  const apnProfileId = String((carrierServiceConfig as any).apnProfileId ?? '').trim()
  const apnCheck = await ensureProfileMatchesCarrierContext(supabase, apnProfileId, 'APN', supplierId, resolvedOperatorId)
  if (!apnCheck.ok) return apnCheck
  const roamingProfileId = String((carrierServiceConfig as any).roamingProfileId ?? '').trim()
  const roamingCheck = await ensureProfileMatchesCarrierContext(
    supabase,
    roamingProfileId,
    'ROAMING',
    supplierId,
    resolvedOperatorId
  )
  if (!roamingCheck.ok) return roamingCheck
  const resellerNorm = normalizeOptionalTenantId(ctx?.resellerRef, 'resellerId')
  if (!resellerNorm.ok) return resellerNorm
  if (resellerNorm.value) {
    const resellerRow = await loadResellerRowByRef(supabase, resellerNorm.value)
    if (!resellerRow.ok) return resellerRow
    if (!resellerRow.value?.tenant_id) {
      return toError(404, 'RESOURCE_NOT_FOUND', 'resellerId not found.')
    }
    const bind = await assertResellerSupplierBinding(supabase, resellerRow.value.tenant_id, supplierId)
    if (!bind.ok) return bind
  }
  return { ok: true, value: { operatorId: resolvedOperatorId, supplierId } }
}

function normalizePackageModules(payload: any, pricePlanVersion: any) {
  const meta = extractPricePlanMeta(pricePlanVersion)
  const carrierSource = payload?.carrierServiceConfig ?? (meta as any).carrierService
  const commercialSource = payload?.commercialTerms ?? (meta as any).commercialTerms
  const controlSource = payload?.controlPolicy ?? (meta as any).controlPolicy
  const carrierNormalized = normalizeCarrierServiceConfig(carrierSource)
  if (!carrierNormalized.ok) return carrierNormalized
  const commercialNormalized = normalizeCommercialTerms(commercialSource)
  if (!commercialNormalized.ok) return commercialNormalized
  if (!commercialNormalized.value) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms is required.')
  }
  const controlNormalized = normalizeControlPolicy(controlSource, 'full')
  if (!controlNormalized.ok) return controlNormalized
  if (!controlNormalized.value) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
  }
  return {
    ok: true as const,
    value: {
      carrierServiceConfig: carrierNormalized.value,
      commercialTerms: commercialNormalized.value,
      controlPolicy: controlNormalized.value,
    },
  }
}

export function validateCommercialTermsModule(payload: any): ServiceResult<{ commercialTerms: Record<string, unknown> }> {
  const commercialNormalized = normalizeCommercialTerms(payload?.commercialTerms ?? payload)
  if (!commercialNormalized.ok) return commercialNormalized
  if (!commercialNormalized.value || !Object.keys(commercialNormalized.value).length) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms is required.')
  }
  return { ok: true, value: { commercialTerms: commercialNormalized.value } }
}

export async function validateControlPolicyModule({
  supabase: _supabase,
  payload,
}: {
  supabase: SupabaseClient
  payload: any
}): Promise<ServiceResult<{ controlPolicy: Record<string, unknown> }>> {
  const raw = extractControlPolicyFromPayload(payload as Record<string, unknown>)
  const controlNormalized = normalizeControlPolicy(raw, 'full')
  if (!controlNormalized.ok) return controlNormalized
  if (!controlNormalized.value || !Object.keys(controlNormalized.value).length) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
  }
  return { ok: true, value: { controlPolicy: controlNormalized.value } }
}

export async function validateCarrierServiceModule({
  supabase,
  payload,
}: {
  supabase: SupabaseClient
  payload: any
}): Promise<ServiceResult<{ carrierServiceConfig: Record<string, unknown> }>> {
  const carrierNormalized = normalizeCarrierServiceConfig(payload?.carrierServiceConfig ?? payload)
  if (!carrierNormalized.ok) return carrierNormalized
  const references = await validateModuleReferences(supabase, carrierNormalized.value, null, {
    resellerRef: payload?.resellerId,
  })
  if (!references.ok) return references
  return {
    ok: true,
    value: {
      carrierServiceConfig: {
        ...carrierNormalized.value,
        operatorId: references.value.operatorId,
      },
    },
  }
}

function normalizeOptionalTenantId(value: unknown, fieldName: string): ServiceResult<string | null> {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null }
  const id = String(value).trim()
  if (!isValidUuid(id)) return toError(400, 'BAD_REQUEST', `${fieldName} is invalid.`)
  return { ok: true, value: id }
}

/** Non-empty display name for module/package rows (trimmed). */
function normalizeRequiredModuleName(value: unknown): ServiceResult<string> {
  if (value === undefined || value === null) {
    return toError(400, 'BAD_REQUEST', 'name is required.')
  }
  const s = String(value).trim()
  if (!s) {
    return toError(400, 'BAD_REQUEST', 'name is invalid.')
  }
  return { ok: true, value: s }
}

const MAX_PACKAGE_DESCRIPTION_LENGTH = 20000

/** Optional user-facing package description (trimmed; empty → null). */
function normalizeOptionalPackageDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const s = String(value).trim()
  if (!s) return null
  return s.length > MAX_PACKAGE_DESCRIPTION_LENGTH ? s.slice(0, MAX_PACKAGE_DESCRIPTION_LENGTH) : s
}

/** Module tables FK `reseller_id` → RESELLER `tenants.tenant_id`. API `resellerId` is that tenant id or legacy `resellers.id`. */
async function resolveResellerModuleRowId(
  supabase: SupabaseClient,
  resellerRef: string | null
): Promise<ServiceResult<string | null>> {
  if (resellerRef === null || resellerRef === undefined) return { ok: true, value: null }
  const trimmed = String(resellerRef).trim()
  if (trimmed === '') return { ok: true, value: null }
  return canonicalResellerTenantIdFromRef(supabase, trimmed)
}

function mapCommercialTermsModule(row: any) {
  return {
    commercialTermsId: row?.commercial_terms_id ?? null,
    name: row?.name != null ? String(row.name) : '',
    commercialTerms: row?.commercial_terms ?? {},
    resellerId: row?.reseller_id ?? null,
    status: row?.status ?? null,
    effectiveFrom: row?.effective_from ?? null,
    publishedAt: row?.published_at ?? null,
    deprecatedAt: row?.deprecated_at ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

/** API / OpenAPI: `resellerId` is `tenants.tenant_id` for the reseller (not `resellers.id`). */
function mapCommercialTermsModuleForPublicResponse(row: any, publicResellerTenantId: string | null) {
  const base = mapCommercialTermsModule(row)
  const rs =
    publicResellerTenantId != null && String(publicResellerTenantId).trim() !== ''
      ? String(publicResellerTenantId).trim()
      : null
  return { ...base, resellerId: rs }
}

function mapControlPolicyModule(row: any) {
  return {
    controlPolicyId: row?.control_policy_id ?? null,
    name: row?.name != null ? String(row.name) : '',
    controlPolicy: row?.control_policy ?? {},
    resellerId: row?.reseller_id ?? null,
    status: row?.status ?? null,
    effectiveFrom: row?.effective_from ?? null,
    publishedAt: row?.published_at ?? null,
    deprecatedAt: row?.deprecated_at ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

/** API / OpenAPI: `resellerId` is `tenants.tenant_id` for the reseller (not `resellers.id`). */
function mapControlPolicyModuleForPublicResponse(row: any, publicResellerTenantId: string | null) {
  const base = mapControlPolicyModule(row)
  const rs =
    publicResellerTenantId != null && String(publicResellerTenantId).trim() !== ''
      ? String(publicResellerTenantId).trim()
      : null
  return { ...base, resellerId: rs }
}

function scrubLegacyCarrierServiceConfigFields(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const { carrierId: _omit, apn: _apn, roamingProfile: _roamingProfile, ...rest } = config as Record<string, unknown>
  return { ...rest }
}

/** PostgREST `select` for `carrier_service_modules` row reads (FK columns only; API `carrierServiceConfig` assembled in memory). */
const CARRIER_SERVICE_MODULE_ROW_SELECT =
  'carrier_service_id,name,reseller_id,supplier_id,operator_id,apn_profile_id,roaming_profile_id,rat,status,published_at,deprecated_at,effective_from,created_at,updated_at'

function normalizeCarrierServiceRatFromParts(rowRat: unknown, jsonRat: unknown): string {
  const raw =
    rowRat != null && String(rowRat).trim() !== '' ? String(rowRat).trim() : String(jsonRat ?? '').trim()
  let r = raw.toUpperCase().replace(/-/g, '')
  if (r === 'NBIOT' || r === 'NB_IOT') return 'NB-IOT'
  if (r === '3G' || r === '4G' || r === '5G') return r
  return '4G'
}

/** OpenAPI `CarrierServiceConfig` shape from persisted columns only. */
function mergedCarrierServiceConfigShape(row: any): Record<string, unknown> {
  const supplierId = row?.supplier_id != null ? String(row.supplier_id).trim() : ''
  const operatorId = row?.operator_id != null ? String(row.operator_id).trim() : ''
  const apnProfileId =
    row?.apn_profile_id != null && String(row.apn_profile_id).trim() !== '' ? String(row.apn_profile_id).trim() : ''
  const roamingProfileId =
    row?.roaming_profile_id != null && String(row.roaming_profile_id).trim() !== ''
      ? String(row.roaming_profile_id).trim()
      : ''
  const rat = normalizeCarrierServiceRatFromParts(row?.rat, undefined)
  return { supplierId, operatorId, apnProfileId, roamingProfileId, rat }
}

/** Payload fragment for {@link validateCarrierServiceModule} / merge with PATCH (`operatorId` = operators row PK). */
function carrierServiceConfigInputFromDbRow(row: any): Record<string, unknown> {
  const m = mergedCarrierServiceConfigShape(row)
  return {
    supplierId: String(m.supplierId ?? '').trim(),
    operatorId: String(m.operatorId ?? '').trim(),
    rat: String(m.rat ?? '4G').trim(),
    apnProfileId: String(m.apnProfileId ?? '').trim(),
    roamingProfileId: String(m.roamingProfileId ?? '').trim(),
  }
}

function mapCarrierServiceModule(row: any) {
  return {
    carrierServiceId: row?.carrier_service_id ?? null,
    name: row?.name != null ? String(row.name) : '',
    carrierServiceConfig: scrubLegacyCarrierServiceConfigFields(mergedCarrierServiceConfigShape(row)),
    resellerId: row?.reseller_id ?? null,
    status: row?.status ?? null,
    effectiveFrom: row?.effective_from ?? null,
    publishedAt: row?.published_at ?? null,
    deprecatedAt: row?.deprecated_at ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

/** `operators.operator_id` (row PK) → API/catalog id: `operators.business_operator_id` when set, else row PK (legacy / 1:1). */
async function businessOperatorDisplayIdsByOperatorRowIds(
  supabase: SupabaseClient,
  rowIds: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(rowIds.map((id) => String(id).trim()).filter(Boolean))]
  if (!uniq.length) return out
  const idList = uniq.map((id) => encodeURIComponent(id)).join(',')
  const rows = await supabase.select(
    'operators',
    `select=operator_id,business_operator_id&operator_id=in.(${idList})`
  )
  for (const r of Array.isArray(rows) ? rows : []) {
    const pk = r?.operator_id != null ? String(r.operator_id) : ''
    if (!pk) continue
    const rawBo = r?.business_operator_id
    const bo = rawBo != null && String(rawBo).trim() !== '' ? String(rawBo).trim() : ''
    out.set(pk, bo || pk)
  }
  return out
}

function mapCarrierServiceModuleForPublicResponse(
  row: any,
  publicOperatorId: string | null,
  publicResellerTenantId: string | null
) {
  const cfg = scrubLegacyCarrierServiceConfigFields(mergedCarrierServiceConfigShape(row))
  const op =
    publicOperatorId != null && String(publicOperatorId).trim() !== ''
      ? String(publicOperatorId).trim()
      : null
  const carrierServiceConfig = op ? { ...cfg, operatorId: op } : { ...cfg }
  const rs =
    publicResellerTenantId != null && String(publicResellerTenantId).trim() !== ''
      ? String(publicResellerTenantId).trim()
      : null
  return {
    carrierServiceId: row?.carrier_service_id ?? null,
    name: row?.name != null ? String(row.name) : '',
    carrierServiceConfig,
    resellerId: rs,
    status: row?.status ?? null,
    effectiveFrom: row?.effective_from ?? null,
    publishedAt: row?.published_at ?? null,
    deprecatedAt: row?.deprecated_at ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

async function mapCarrierServiceModuleApiResponse(
  supabase: SupabaseClient,
  row: any
): Promise<Record<string, unknown>> {
  const opPk = row?.operator_id != null ? String(row.operator_id).trim() : ''
  const resellerTid = row?.reseller_id != null ? String(row.reseller_id).trim() : ''
  const opMap = opPk
    ? await businessOperatorDisplayIdsByOperatorRowIds(supabase, [opPk])
    : new Map<string, string>()
  const displayOp = opPk ? opMap.get(opPk) ?? opPk : null
  return mapCarrierServiceModuleForPublicResponse(row, displayOp, resellerTid || null) as Record<string, unknown>
}

async function mapCommercialTermsModuleApiResponse(
  supabase: SupabaseClient,
  row: any
): Promise<Record<string, unknown>> {
  const resellerTid = row?.reseller_id != null ? String(row.reseller_id).trim() : ''
  return mapCommercialTermsModuleForPublicResponse(row, resellerTid || null) as Record<string, unknown>
}

async function mapControlPolicyModuleApiResponse(
  supabase: SupabaseClient,
  row: any
): Promise<Record<string, unknown>> {
  const resellerTid = row?.reseller_id != null ? String(row.reseller_id).trim() : ''
  return mapControlPolicyModuleForPublicResponse(row, resellerTid || null) as Record<string, unknown>
}

/** Maps validated payload for HTTP responses (still use {@link validateCarrierServiceModule} output for writes). */
export async function formatCarrierServiceValidationResponseForApi(
  supabase: SupabaseClient,
  validated: { carrierServiceConfig: Record<string, unknown> }
): Promise<{ carrierServiceConfig: Record<string, unknown> }> {
  const internal = validated.carrierServiceConfig?.operatorId
  const pk = internal != null ? String(internal).trim() : ''
  if (!pk) return validated
  const m = await businessOperatorDisplayIdsByOperatorRowIds(supabase, [pk])
  const pub = m.get(pk) ?? pk
  return { carrierServiceConfig: { ...validated.carrierServiceConfig, operatorId: pub } }
}

export async function createCommercialTerms({
  supabase,
  payload,
  audit,
  auth,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
  /** When set (HTTP), platform must send body `resellerId`; reseller may omit it and use token tenant. */
  auth?: { scope: 'platform' | 'reseller'; resellerTenantId?: string | null } | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  const normalized = validateCommercialTermsModule(payload)
  if (!normalized.ok) return normalized
  const resellerIdResult = normalizeOptionalTenantId(payload?.resellerId, 'resellerId')
  if (!resellerIdResult.ok) return resellerIdResult
  let effectiveAuthTenantId: string | null = null
  if (auth?.scope === 'reseller') {
    const authCanon = await canonicalResellerTenantIdFromRef(
      supabase,
      String(auth?.resellerTenantId ?? '')
    )
    if (!authCanon.ok) return authCanon
    effectiveAuthTenantId = authCanon.value
  }
  let effectiveResellerRef: string | null = resellerIdResult.value
  const hasBodyReseller =
    effectiveResellerRef !== null &&
    effectiveResellerRef !== undefined &&
    String(effectiveResellerRef).trim() !== ''
  if (auth?.scope === 'reseller') {
    if (!hasBodyReseller) {
      effectiveResellerRef = effectiveAuthTenantId
    } else if (resellerIdResult.value) {
      const rrow = await loadResellerRowByRef(supabase, resellerIdResult.value)
      if (!rrow.ok) return rrow
      if (!rrow.value || String(rrow.value.tenant_id) !== String(effectiveAuthTenantId)) {
        return toError(403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
      }
    }
  } else if (auth?.scope === 'platform' && !hasBodyReseller) {
    return toError(400, 'BAD_REQUEST', 'resellerId is required.')
  }
  const resellerFk = await resolveResellerModuleRowId(supabase, effectiveResellerRef)
  if (!resellerFk.ok) return resellerFk
  if (auth?.scope === 'reseller' || auth?.scope === 'platform') {
    const rrow = await loadResellerRowByRef(supabase, effectiveResellerRef!)
    if (!rrow.ok) return rrow
    if (!rrow.value) return toError(404, 'RESOURCE_NOT_FOUND', 'resellerId not found.')
  }
  const ctName = normalizeRequiredModuleName(payload?.name)
  if (!ctName.ok) return ctName
  const rows = await supabase.insert(
    'commercial_terms_modules',
    {
      name: ctName.value,
      reseller_id: resellerFk.value,
      commercial_terms: normalized.value.commercialTerms,
      status: 'DRAFT',
    },
    { returning: 'representation' }
  )
  const created = Array.isArray(rows) ? rows[0] : null
  if (!(created as any)?.commercial_terms_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create commercial terms.')
  const createdApi = await mapCommercialTermsModuleApiResponse(supabase, created)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(created as any),
    action: 'COMMERCIAL_TERMS_CREATED',
    target_type: 'COMMERCIAL_TERMS',
    target_id: (created as any).commercial_terms_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: createdApi,
  })
  return { ok: true, value: createdApi }
}

export async function updateCommercialTerms({
  supabase,
  commercialTermsId,
  payload,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  commercialTermsId: string
  payload: any
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(commercialTermsId)) return toError(400, 'BAD_REQUEST', 'commercialTermsId is invalid.')
  const rows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,name,reseller_id,commercial_terms,status,published_at,deprecated_at,effective_from,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
  const scopeCt = await enforceCommercialTermsResellerScope(supabase, existing, authResellerTenantId)
  if (!scopeCt.ok) return scopeCt
  if (String((existing as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT commercial terms can be updated.')
  }
  let ctNameUpdate: string | undefined
  if (payload && typeof payload === 'object' && 'name' in payload) {
    const nn = normalizeRequiredModuleName((payload as any).name)
    if (!nn.ok) return nn
    ctNameUpdate = nn.value
  }
  const normalized = normalizeCommercialTerms(payload?.commercialTerms ?? payload)
  if (!normalized.ok) return normalized
  if (!normalized.value || !Object.keys(normalized.value).length) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms is required.')
  }
  const merged = { ...((existing as any).commercial_terms ?? {}), ...normalized.value }
  const ctPatch: Record<string, unknown> = { commercial_terms: merged, updated_at: new Date().toISOString() }
  if (ctNameUpdate !== undefined) ctPatch.name = ctNameUpdate
  await supabase.update(
    'commercial_terms_modules',
    `commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}`,
    ctPatch,
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,name,reseller_id,commercial_terms,status,published_at,deprecated_at,effective_from,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  const beforeApi = await mapCommercialTermsModuleApiResponse(supabase, existing)
  const afterApi = refreshed ? await mapCommercialTermsModuleApiResponse(supabase, refreshed) : beforeApi
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'COMMERCIAL_TERMS_UPDATED',
    target_type: 'COMMERCIAL_TERMS',
    target_id: commercialTermsId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: beforeApi,
    after_data: afterApi,
  })
  return { ok: true, value: afterApi }
}

export async function getCommercialTermsDetail({
  supabase,
  commercialTermsId,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  commercialTermsId: string
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(commercialTermsId)) return toError(400, 'BAD_REQUEST', 'commercialTermsId is invalid.')
  const rows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,name,reseller_id,commercial_terms,status,published_at,deprecated_at,effective_from,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const item = Array.isArray(rows) ? rows[0] : null
  if (!(item as any)?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
  const scopeCt = await enforceCommercialTermsResellerScope(supabase, item, authResellerTenantId)
  if (!scopeCt.ok) return scopeCt
  return { ok: true, value: await mapCommercialTermsModuleApiResponse(supabase, item) }
}

export async function createControlPolicy({
  supabase,
  payload,
  audit,
  auth,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
  /** When set (HTTP), platform must send body `resellerId`; reseller may omit it and use token tenant. */
  auth?: { scope: 'platform' | 'reseller'; resellerTenantId?: string | null } | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  const normalized = await validateControlPolicyModule({ supabase, payload })
  if (!normalized.ok) return normalized
  const resellerIdResult = normalizeOptionalTenantId(payload?.resellerId, 'resellerId')
  if (!resellerIdResult.ok) return resellerIdResult
  let effectiveAuthTenantIdCp: string | null = null
  if (auth?.scope === 'reseller') {
    const authCanonCpCreate = await canonicalResellerTenantIdFromRef(
      supabase,
      String(auth?.resellerTenantId ?? '')
    )
    if (!authCanonCpCreate.ok) return authCanonCpCreate
    effectiveAuthTenantIdCp = authCanonCpCreate.value
  }
  let effectiveResellerRef: string | null = resellerIdResult.value
  const hasBodyReseller =
    effectiveResellerRef !== null &&
    effectiveResellerRef !== undefined &&
    String(effectiveResellerRef).trim() !== ''
  if (auth?.scope === 'reseller') {
    if (!hasBodyReseller) {
      effectiveResellerRef = effectiveAuthTenantIdCp
    } else if (resellerIdResult.value) {
      const rrow = await loadResellerRowByRef(supabase, resellerIdResult.value)
      if (!rrow.ok) return rrow
      if (!rrow.value || String(rrow.value.tenant_id) !== String(effectiveAuthTenantIdCp)) {
        return toError(403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
      }
    }
  } else if (auth?.scope === 'platform' && !hasBodyReseller) {
    return toError(400, 'BAD_REQUEST', 'resellerId is required.')
  }
  const resellerFk = await resolveResellerModuleRowId(supabase, effectiveResellerRef)
  if (!resellerFk.ok) return resellerFk
  if (auth?.scope === 'reseller' || auth?.scope === 'platform') {
    const rrow = await loadResellerRowByRef(supabase, effectiveResellerRef!)
    if (!rrow.ok) return rrow
    if (!rrow.value) return toError(404, 'RESOURCE_NOT_FOUND', 'resellerId not found.')
  }
  const cpName = normalizeRequiredModuleName(payload?.name)
  if (!cpName.ok) return cpName
  const rows = await supabase.insert(
    'control_policy_modules',
    {
      name: cpName.value,
      reseller_id: resellerFk.value,
      control_policy: normalized.value.controlPolicy,
      status: 'DRAFT',
    },
    { returning: 'representation' }
  )
  const created = Array.isArray(rows) ? rows[0] : null
  if (!(created as any)?.control_policy_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create control policy.')
  const createdCpApi = await mapControlPolicyModuleApiResponse(supabase, created)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(created as any),
    action: 'CONTROL_POLICY_CREATED',
    target_type: 'CONTROL_POLICY',
    target_id: (created as any).control_policy_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: createdCpApi,
  })
  return { ok: true, value: createdCpApi }
}

export async function updateControlPolicy({
  supabase,
  controlPolicyId,
  payload,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  controlPolicyId: string
  payload: any
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(controlPolicyId)) return toError(400, 'BAD_REQUEST', 'controlPolicyId is invalid.')
  const rows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,name,reseller_id,control_policy,status,published_at,deprecated_at,effective_from,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
  const scopeCp = await enforceControlPolicyResellerScope(supabase, existing, authResellerTenantId)
  if (!scopeCp.ok) return scopeCp
  if (String((existing as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT control policies can be updated.')
  }
  let cpNameUpdate: string | undefined
  if (payload && typeof payload === 'object' && 'name' in payload) {
    const nn = normalizeRequiredModuleName((payload as any).name)
    if (!nn.ok) return nn
    cpNameUpdate = nn.value
  }
  const cpPatch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (cpNameUpdate !== undefined) cpPatch.name = cpNameUpdate
  if (payload?.controlPolicy !== undefined) {
    const normalized = normalizeControlPolicy(payload.controlPolicy, 'partial')
    if (!normalized.ok) return normalized
    if (!normalized.value || !Object.keys(normalized.value).length) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy must include at least one valid field.')
    }
    const existingRaw = stripLegacyControlPolicyKeys(((existing as any).control_policy ?? {}) as Record<string, unknown>)
    const merged = { ...existingRaw, ...normalized.value }
    const finalized = finalizeControlPolicyMerged(merged as Record<string, unknown>)
    if (!finalized.ok) return finalized
    if (!finalized.value) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
    }
    cpPatch.control_policy = finalized.value
  }
  await supabase.update(
    'control_policy_modules',
    `control_policy_id=eq.${encodeURIComponent(controlPolicyId)}`,
    cpPatch,
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,name,reseller_id,control_policy,status,published_at,deprecated_at,effective_from,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  const beforeCpApi = await mapControlPolicyModuleApiResponse(supabase, existing)
  const afterCpApi = refreshed ? await mapControlPolicyModuleApiResponse(supabase, refreshed) : beforeCpApi
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'CONTROL_POLICY_UPDATED',
    target_type: 'CONTROL_POLICY',
    target_id: controlPolicyId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: beforeCpApi,
    after_data: afterCpApi,
  })
  return { ok: true, value: afterCpApi }
}

export async function getControlPolicyDetail({
  supabase,
  controlPolicyId,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  controlPolicyId: string
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(controlPolicyId)) return toError(400, 'BAD_REQUEST', 'controlPolicyId is invalid.')
  const rows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,name,reseller_id,control_policy,status,published_at,deprecated_at,effective_from,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const item = Array.isArray(rows) ? rows[0] : null
  if (!(item as any)?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
  const scopeCp = await enforceControlPolicyResellerScope(supabase, item, authResellerTenantId)
  if (!scopeCp.ok) return scopeCp
  return { ok: true, value: await mapControlPolicyModuleApiResponse(supabase, item) }
}

export async function listCommercialTerms({
  supabase,
  status,
  page,
  pageSize,
  resellerId,
}: {
  supabase: SupabaseClient
  status?: string
  page?: string | number
  pageSize?: string | number
  resellerId?: string | null
}): Promise<ServiceResult<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }>> {
  if (resellerId && !isValidUuid(resellerId)) {
    return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  }
  let resellerRowId: string | null = null
  if (resellerId) {
    const resolved = await resolveResellerModuleRowId(supabase, String(resellerId).trim())
    if (!resolved.ok) return resolved
    resellerRowId = resolved.value
  }
  const filters = [
    'select=commercial_terms_id,name,reseller_id,commercial_terms,status,effective_from,published_at,deprecated_at,created_at,updated_at',
  ]
  if (resellerRowId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerRowId)}`)
  if (status && String(status).trim()) {
    filters.push(`status=eq.${encodeURIComponent(String(status).trim())}`)
  }
  filters.push('order=created_at.desc')
  const rows = await supabase.select('commercial_terms_modules', filters.join('&'))
  const rowList = Array.isArray(rows) ? rows : []
  let items = await Promise.all(rowList.map((r) => mapCommercialTermsModuleApiResponse(supabase, r)))
  const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 500 })
  const total = items.length
  const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize)
  return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) }
}

export async function listControlPolicies({
  supabase,
  status,
  page,
  pageSize,
  resellerId,
}: {
  supabase: SupabaseClient
  status?: string
  page?: string | number
  pageSize?: string | number
  resellerId?: string | null
}): Promise<ServiceResult<{ items: Record<string, unknown>[]; total: number; page: number; pageSize: number }>> {
  if (resellerId && !isValidUuid(resellerId)) {
    return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  }
  let resellerRowId: string | null = null
  if (resellerId) {
    const resolved = await resolveResellerModuleRowId(supabase, String(resellerId).trim())
    if (!resolved.ok) return resolved
    resellerRowId = resolved.value
  }
  const filters = [
    'select=control_policy_id,name,reseller_id,control_policy,status,effective_from,published_at,deprecated_at,created_at,updated_at',
  ]
  if (resellerRowId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerRowId)}`)
  if (status && String(status).trim()) {
    filters.push(`status=eq.${encodeURIComponent(String(status).trim())}`)
  }
  filters.push('order=created_at.desc')
  const rows = await supabase.select('control_policy_modules', filters.join('&'))
  const cpRowList = Array.isArray(rows) ? rows : []
  let items = await Promise.all(cpRowList.map((r) => mapControlPolicyModuleApiResponse(supabase, r)))
  const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 500 })
  const total = items.length
  const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize)
  return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) }
}

export async function cloneCommercialTerms({
  supabase,
  commercialTermsId,
  payload,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  commercialTermsId: string
  payload?: any
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(commercialTermsId)) {
    return toError(400, 'BAD_REQUEST', 'commercialTermsId is invalid.')
  }
  const sourceRows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,name,reseller_id,commercial_terms,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const source = Array.isArray(sourceRows) ? sourceRows[0] as any : null
  if (!source?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Source commercial terms not found.')
  const scopeSource = await enforceCommercialTermsResellerScope(supabase, source, authResellerTenantId)
  if (!scopeSource.ok) return scopeSource
  let resellerFk: string | null = source.reseller_id ?? null
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'resellerId')) {
    const n = normalizeOptionalTenantId(payload.resellerId, 'resellerId')
    if (!n.ok) return n
    if (n.value === null) resellerFk = null
    else {
      const r = await resolveResellerModuleRowId(supabase, n.value)
      if (!r.ok) return r
      resellerFk = r.value
      if (authResellerTenantId) {
        const rrow = await loadResellerRowByRef(supabase, n.value)
        if (!rrow.ok) return rrow
        const authCanonCloneCt = await canonicalResellerTenantIdFromRef(supabase, String(authResellerTenantId))
        if (!authCanonCloneCt.ok) return authCanonCloneCt
        if (!rrow.value || String(rrow.value.tenant_id) !== authCanonCloneCt.value) {
          return toError(403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
        }
      }
    }
  }
  let cloneCtName: string
  if (payload && typeof payload === 'object' && 'name' in payload) {
    const nn = normalizeRequiredModuleName((payload as any).name)
    if (!nn.ok) return nn
    cloneCtName = nn.value
  } else {
    const base = String((source as any).name ?? '').trim()
    cloneCtName = base ? `${base} (copy)` : 'Commercial terms (copy)'
  }
  const rows = await supabase.insert(
    'commercial_terms_modules',
    {
      name: cloneCtName,
      reseller_id: resellerFk,
      commercial_terms: payload?.commercialTerms ?? source.commercial_terms,
      status: 'DRAFT',
    },
    { returning: 'representation' }
  )
  const cloned = Array.isArray(rows) ? rows[0] as any : null
  if (!cloned?.commercial_terms_id) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to clone commercial terms.')
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(cloned as any),
    action: 'COMMERCIAL_TERMS_CLONED',
    target_type: 'COMMERCIAL_TERMS',
    target_id: cloned.commercial_terms_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      commercialTermsId: cloned.commercial_terms_id,
      sourceCommercialTermsId: commercialTermsId,
    },
  })
  const clonedApi = await mapCommercialTermsModuleApiResponse(supabase, cloned)
  return {
    ok: true,
    value: {
      ...clonedApi,
      sourceCommercialTermsId: commercialTermsId,
    },
  }
}

export async function cloneControlPolicy({
  supabase,
  controlPolicyId,
  payload,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  controlPolicyId: string
  payload?: any
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(controlPolicyId)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicyId is invalid.')
  }
  const sourceRows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,name,reseller_id,control_policy,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const source = Array.isArray(sourceRows) ? sourceRows[0] as any : null
  if (!source?.control_policy_id) return toError(404, 'NOT_FOUND', 'Source control policy not found.')
  const scopeSource = await enforceControlPolicyResellerScope(supabase, source, authResellerTenantId)
  if (!scopeSource.ok) return scopeSource
  let resellerFk: string | null = source.reseller_id ?? null
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'resellerId')) {
    const n = normalizeOptionalTenantId(payload.resellerId, 'resellerId')
    if (!n.ok) return n
    if (n.value === null) resellerFk = null
    else {
      const r = await resolveResellerModuleRowId(supabase, n.value)
      if (!r.ok) return r
      resellerFk = r.value
      if (authResellerTenantId) {
        const rrow = await loadResellerRowByRef(supabase, n.value)
        if (!rrow.ok) return rrow
        const authCanonCloneCp = await canonicalResellerTenantIdFromRef(supabase, String(authResellerTenantId))
        if (!authCanonCloneCp.ok) return authCanonCloneCp
        if (!rrow.value || String(rrow.value.tenant_id) !== authCanonCloneCp.value) {
          return toError(403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
        }
      }
    }
  }
  let cloneCpName: string
  if (payload && typeof payload === 'object' && 'name' in payload) {
    const nn = normalizeRequiredModuleName((payload as any).name)
    if (!nn.ok) return nn
    cloneCpName = nn.value
  } else {
    const base = String((source as any).name ?? '').trim()
    cloneCpName = base ? `${base} (copy)` : 'Control policy (copy)'
  }
  const basePolicy = stripLegacyControlPolicyKeys(((source as any).control_policy ?? {}) as Record<string, unknown>)
  let controlPolicyToStore: Record<string, unknown>
  if (payload?.controlPolicy !== undefined) {
    const partial = normalizeControlPolicy(payload.controlPolicy, 'partial')
    if (!partial.ok) return partial
    if (!partial.value || !Object.keys(partial.value).length) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy must include at least one valid field.')
    }
    const mergedClone = { ...basePolicy, ...partial.value }
    const fin = finalizeControlPolicyMerged(mergedClone as Record<string, unknown>)
    if (!fin.ok) return fin
    if (!fin.value) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
    }
    controlPolicyToStore = fin.value
  } else {
    const fin = normalizeControlPolicy(basePolicy, 'full')
    if (!fin.ok) return fin
    if (!fin.value) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
    }
    controlPolicyToStore = fin.value
  }
  const rows = await supabase.insert(
    'control_policy_modules',
    {
      name: cloneCpName,
      reseller_id: resellerFk,
      control_policy: controlPolicyToStore,
      status: 'DRAFT',
    },
    { returning: 'representation' }
  )
  const cloned = Array.isArray(rows) ? rows[0] as any : null
  if (!cloned?.control_policy_id) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to clone control policy.')
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(cloned as any),
    action: 'CONTROL_POLICY_CLONED',
    target_type: 'CONTROL_POLICY',
    target_id: cloned.control_policy_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      controlPolicyId: cloned.control_policy_id,
      sourceControlPolicyId: controlPolicyId,
    },
  })
  const clonedCpApi = await mapControlPolicyModuleApiResponse(supabase, cloned)
  return {
    ok: true,
    value: {
      ...clonedCpApi,
      sourceControlPolicyId: controlPolicyId,
    },
  }
}

async function collectPackageIdsReferencingCommercialTerms(supabase: SupabaseClient, commercialTermsId: string) {
  const rows = await supabase.select(
    'packages',
    `select=package_id&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}`
  )
  const ids = new Set<string>()
  for (const r of Array.isArray(rows) ? rows : []) {
    const pid = String((r as any)?.package_id ?? '').trim()
    if (pid) ids.add(pid)
  }
  return [...ids]
}

async function collectPackageIdsReferencingControlPolicy(supabase: SupabaseClient, controlPolicyId: string) {
  const rows = await supabase.select(
    'packages',
    `select=package_id&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}`
  )
  const ids = new Set<string>()
  for (const r of Array.isArray(rows) ? rows : []) {
    const pid = String((r as any)?.package_id ?? '').trim()
    if (pid) ids.add(pid)
  }
  return [...ids]
}

export async function publishCommercialTerms({
  supabase,
  commercialTermsId,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  commercialTermsId: string
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(commercialTermsId)) return toError(400, 'BAD_REQUEST', 'commercialTermsId is invalid.')
  const rows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,name,reseller_id,commercial_terms,status,published_at,deprecated_at,effective_from,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
  const scopePub = await enforceCommercialTermsResellerScope(supabase, existing, authResellerTenantId)
  if (!scopePub.ok) return scopePub
  if (String((existing as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT commercial terms can be published.')
  }
  const validated = validateCommercialTermsModule({ commercialTerms: (existing as any).commercial_terms })
  if (!validated.ok) return validated
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  const publishedAt = new Date().toISOString()
  await supabase.update(
    'commercial_terms_modules',
    `commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}`,
    {
      status: 'PUBLISHED',
      effective_from: effectiveFrom,
      published_at: publishedAt,
      deprecated_at: null,
      updated_at: publishedAt,
    },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,name,reseller_id,commercial_terms,status,published_at,deprecated_at,effective_from,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  const value = refreshed ? await mapCommercialTermsModuleApiResponse(supabase, refreshed) : {}
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'COMMERCIAL_TERMS_PUBLISHED',
    target_type: 'COMMERCIAL_TERMS',
    target_id: commercialTermsId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function deprecateCommercialTerms({
  supabase,
  commercialTermsId,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  commercialTermsId: string
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(commercialTermsId)) return toError(400, 'BAD_REQUEST', 'commercialTermsId is invalid.')
  const rows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,name,reseller_id,commercial_terms,status,published_at,deprecated_at,effective_from,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
  const scopeDep = await enforceCommercialTermsResellerScope(supabase, existing, authResellerTenantId)
  if (!scopeDep.ok) return scopeDep
  if (String((existing as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED commercial terms can be deprecated.')
  }
  const pkgIds = await collectPackageIdsReferencingCommercialTerms(supabase, commercialTermsId)
  if (pkgIds.length) {
    return toError(
      409,
      'RESOURCE_IN_USE',
      `Commercial terms are still referenced by subscription packages. packageIds=${pkgIds.join(',')}`
    )
  }
  const nowIso = new Date().toISOString()
  await supabase.update(
    'commercial_terms_modules',
    `commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}`,
    {
      status: 'DEPRECATED',
      deprecated_at: nowIso,
      updated_at: nowIso,
    },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,name,reseller_id,commercial_terms,status,published_at,deprecated_at,effective_from,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  const value = refreshed ? await mapCommercialTermsModuleApiResponse(supabase, refreshed) : {}
  const beforeApi = await mapCommercialTermsModuleApiResponse(supabase, existing)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'COMMERCIAL_TERMS_DEPRECATED',
    target_type: 'COMMERCIAL_TERMS',
    target_id: commercialTermsId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: beforeApi,
    after_data: value,
  })
  return { ok: true, value }
}

export async function publishControlPolicy({
  supabase,
  controlPolicyId,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  controlPolicyId: string
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(controlPolicyId)) return toError(400, 'BAD_REQUEST', 'controlPolicyId is invalid.')
  const rows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,name,reseller_id,control_policy,status,published_at,deprecated_at,effective_from,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
  const scopePub = await enforceControlPolicyResellerScope(supabase, existing, authResellerTenantId)
  if (!scopePub.ok) return scopePub
  if (String((existing as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT control policies can be published.')
  }
  const stripped = stripLegacyControlPolicyKeys(
    (((existing as any).control_policy ?? {}) as Record<string, unknown>) ?? {}
  )
  const validated = normalizeControlPolicy(stripped, 'full')
  if (!validated.ok) return validated
  if (!validated.value) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
  }
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  const publishedAt = new Date().toISOString()
  await supabase.update(
    'control_policy_modules',
    `control_policy_id=eq.${encodeURIComponent(controlPolicyId)}`,
    {
      status: 'PUBLISHED',
      effective_from: effectiveFrom,
      published_at: publishedAt,
      deprecated_at: null,
      updated_at: publishedAt,
    },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,name,reseller_id,control_policy,status,published_at,deprecated_at,effective_from,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  const value = refreshed ? await mapControlPolicyModuleApiResponse(supabase, refreshed) : {}
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'CONTROL_POLICY_PUBLISHED',
    target_type: 'CONTROL_POLICY',
    target_id: controlPolicyId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function deprecateControlPolicy({
  supabase,
  controlPolicyId,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  controlPolicyId: string
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(controlPolicyId)) return toError(400, 'BAD_REQUEST', 'controlPolicyId is invalid.')
  const rows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,name,reseller_id,control_policy,status,published_at,deprecated_at,effective_from,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
  const scopeDep = await enforceControlPolicyResellerScope(supabase, existing, authResellerTenantId)
  if (!scopeDep.ok) return scopeDep
  if (String((existing as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED control policies can be deprecated.')
  }
  const pkgIds = await collectPackageIdsReferencingControlPolicy(supabase, controlPolicyId)
  if (pkgIds.length) {
    return toError(
      409,
      'RESOURCE_IN_USE',
      `Control policy is still referenced by subscription packages. packageIds=${pkgIds.join(',')}`
    )
  }
  const nowIso = new Date().toISOString()
  await supabase.update(
    'control_policy_modules',
    `control_policy_id=eq.${encodeURIComponent(controlPolicyId)}`,
    {
      status: 'DEPRECATED',
      deprecated_at: nowIso,
      updated_at: nowIso,
    },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,name,reseller_id,control_policy,status,published_at,deprecated_at,effective_from,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  const value = refreshed ? await mapControlPolicyModuleApiResponse(supabase, refreshed) : {}
  const beforeCpDepApi = await mapControlPolicyModuleApiResponse(supabase, existing)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'CONTROL_POLICY_DEPRECATED',
    target_type: 'CONTROL_POLICY',
    target_id: controlPolicyId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: beforeCpDepApi,
    after_data: value,
  })
  return { ok: true, value }
}

export async function createCarrierService({
  supabase,
  payload,
  audit,
  auth,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
  /** When set (HTTP), platform must send body `resellerId`; reseller may omit it and use token tenant. */
  auth?: { scope: 'platform' | 'reseller'; resellerTenantId?: string | null } | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  const resellerIdResult = normalizeOptionalTenantId(payload?.resellerId, 'resellerId')
  if (!resellerIdResult.ok) return resellerIdResult
  let effectiveResellerRef: string | null = resellerIdResult.value
  const hasBodyReseller =
    effectiveResellerRef !== null &&
    effectiveResellerRef !== undefined &&
    String(effectiveResellerRef).trim() !== ''
  if (!hasBodyReseller) {
    if (auth?.scope === 'reseller') {
      const authCanonCs = await canonicalResellerTenantIdFromRef(
        supabase,
        String(auth?.resellerTenantId ?? '')
      )
      if (!authCanonCs.ok) return authCanonCs
      effectiveResellerRef = authCanonCs.value
    } else if (auth?.scope === 'platform') {
      return toError(400, 'BAD_REQUEST', 'resellerId is required.')
    }
  }
  const payloadForValidate = {
    ...payload,
    resellerId: hasBodyReseller ? payload?.resellerId : effectiveResellerRef ?? payload?.resellerId,
  }
  const normalized = await validateCarrierServiceModule({ supabase, payload: payloadForValidate })
  if (!normalized.ok) return normalized
  const nameResult = normalizeRequiredModuleName(payload?.name)
  if (!nameResult.ok) return nameResult
  const resellerFk = await resolveResellerModuleRowId(supabase, effectiveResellerRef)
  if (!resellerFk.ok) return resellerFk
  const carrierServiceConfig = normalized.value.carrierServiceConfig
  const rows = await supabase.insert(
    'carrier_service_modules',
    {
      name: nameResult.value,
      reseller_id: resellerFk.value,
      supplier_id: (carrierServiceConfig as any).supplierId,
      operator_id: (carrierServiceConfig as any).operatorId,
      apn_profile_id: (carrierServiceConfig as any).apnProfileId,
      roaming_profile_id: (carrierServiceConfig as any).roamingProfileId,
      rat: String((carrierServiceConfig as any).rat ?? '4G'),
      status: 'DRAFT',
    },
    { returning: 'representation' }
  )
  const created = Array.isArray(rows) ? rows[0] : null
  if (!(created as any)?.carrier_service_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create carrier service.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(created as any),
    action: 'CARRIER_SERVICE_CREATED',
    target_type: 'CARRIER_SERVICE',
    target_id: (created as any).carrier_service_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: await mapCarrierServiceModuleApiResponse(supabase, created),
  })
  return { ok: true, value: await mapCarrierServiceModuleApiResponse(supabase, created) }
}

/** When `authResellerTenantId` is set, the row must belong to that reseller (`resellers.tenant_id`). */
async function enforceCarrierServiceResellerScope(
  supabase: SupabaseClient,
  item: any,
  authResellerTenantId: string | null | undefined
): Promise<ServiceResult<null>> {
  const tenantFilter = authResellerTenantId ? String(authResellerTenantId).trim() : ''
  if (!tenantFilter) return { ok: true, value: null }
  if (!isValidUuid(tenantFilter)) {
    return toError(403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
  }
  const moduleResellerTid = item?.reseller_id != null ? String(item.reseller_id).trim() : ''
  if (!moduleResellerTid) {
    return toError(403, 'FORBIDDEN', 'Carrier service is not in scope for this reseller.')
  }
  const authCanon = await canonicalResellerTenantIdFromRef(supabase, tenantFilter)
  if (!authCanon.ok) return authCanon
  if (moduleResellerTid !== authCanon.value) {
    return toError(403, 'FORBIDDEN', 'Carrier service is not in scope for this reseller.')
  }
  return { ok: true, value: null }
}

/** When `authResellerTenantId` is set, the row must belong to that reseller (`resellers.tenant_id`). */
async function enforceCommercialTermsResellerScope(
  supabase: SupabaseClient,
  item: any,
  authResellerTenantId: string | null | undefined
): Promise<ServiceResult<null>> {
  const tenantFilter = authResellerTenantId ? String(authResellerTenantId).trim() : ''
  if (!tenantFilter) return { ok: true, value: null }
  if (!isValidUuid(tenantFilter)) {
    return toError(403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
  }
  const moduleResellerTid = item?.reseller_id != null ? String(item.reseller_id).trim() : ''
  if (!moduleResellerTid) {
    return toError(403, 'FORBIDDEN', 'Commercial terms are not in scope for this reseller.')
  }
  const authCanonCt = await canonicalResellerTenantIdFromRef(supabase, tenantFilter)
  if (!authCanonCt.ok) return authCanonCt
  if (moduleResellerTid !== authCanonCt.value) {
    return toError(403, 'FORBIDDEN', 'Commercial terms are not in scope for this reseller.')
  }
  return { ok: true, value: null }
}

/** When `authResellerTenantId` is set, the row must belong to that reseller (`resellers.tenant_id`). */
async function enforceControlPolicyResellerScope(
  supabase: SupabaseClient,
  item: any,
  authResellerTenantId: string | null | undefined
): Promise<ServiceResult<null>> {
  const tenantFilter = authResellerTenantId ? String(authResellerTenantId).trim() : ''
  if (!tenantFilter) return { ok: true, value: null }
  if (!isValidUuid(tenantFilter)) {
    return toError(403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
  }
  const moduleResellerTid = item?.reseller_id != null ? String(item.reseller_id).trim() : ''
  if (!moduleResellerTid) {
    return toError(403, 'FORBIDDEN', 'Control policy is not in scope for this reseller.')
  }
  const authCanonCp = await canonicalResellerTenantIdFromRef(supabase, tenantFilter)
  if (!authCanonCp.ok) return authCanonCp
  if (moduleResellerTid !== authCanonCp.value) {
    return toError(403, 'FORBIDDEN', 'Control policy is not in scope for this reseller.')
  }
  return { ok: true, value: null }
}

export async function updateCarrierService({
  supabase,
  carrierServiceId,
  payload,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  carrierServiceId: string
  payload: any
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(carrierServiceId)) return toError(400, 'BAD_REQUEST', 'carrierServiceId is invalid.')
  const rows = await supabase.select(
    'carrier_service_modules',
    `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
  const scope = await enforceCarrierServiceResellerScope(supabase, existing, authResellerTenantId)
  if (!scope.ok) return scope
  if (String((existing as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT carrier services can be updated.')
  }
  let nameUpdate: string | undefined
  if (payload && typeof payload === 'object' && 'name' in payload) {
    const nn = normalizeRequiredModuleName((payload as any).name)
    if (!nn.ok) return nn
    nameUpdate = nn.value
  }
  const mergedInput = scrubLegacyCarrierServiceConfigFields({
    ...carrierServiceConfigInputFromDbRow(existing),
    ...(payload?.carrierServiceConfig ?? payload ?? {}),
  })
  const resellerTidExisting = (existing as any).reseller_id != null ? String((existing as any).reseller_id).trim() : ''
  const resellerRef: string | null = resellerTidExisting || null
  const normalized = await validateCarrierServiceModule({
    supabase,
    payload: { carrierServiceConfig: mergedInput, resellerId: resellerRef },
  })
  if (!normalized.ok) return normalized
  const carrierServiceConfig = normalized.value.carrierServiceConfig
  const updatePatch: Record<string, unknown> = {
    supplier_id: (carrierServiceConfig as any).supplierId,
    operator_id: (carrierServiceConfig as any).operatorId,
    apn_profile_id: (carrierServiceConfig as any).apnProfileId,
    roaming_profile_id: (carrierServiceConfig as any).roamingProfileId,
    rat: String((carrierServiceConfig as any).rat ?? '4G'),
    updated_at: new Date().toISOString(),
  }
  if (nameUpdate !== undefined) updatePatch.name = nameUpdate
  await supabase.update(
    'carrier_service_modules',
    `carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}`,
    updatePatch,
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'carrier_service_modules',
    `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'CARRIER_SERVICE_UPDATED',
    target_type: 'CARRIER_SERVICE',
    target_id: carrierServiceId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: await mapCarrierServiceModuleApiResponse(supabase, existing),
    after_data: await mapCarrierServiceModuleApiResponse(supabase, refreshed),
  })
  return { ok: true, value: await mapCarrierServiceModuleApiResponse(supabase, refreshed) }
}

export async function getCarrierServiceDetail({
  supabase,
  carrierServiceId,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  carrierServiceId: string
  /** When set (reseller JWT), the module must belong to this reseller `tenants.tenant_id`. */
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(carrierServiceId)) return toError(400, 'BAD_REQUEST', 'carrierServiceId is invalid.')
  const rows = await supabase.select(
    'carrier_service_modules',
    `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const item = Array.isArray(rows) ? rows[0] : null
  if (!(item as any)?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
  const scope = await enforceCarrierServiceResellerScope(supabase, item, authResellerTenantId)
  if (!scope.ok) return scope
  return { ok: true, value: await mapCarrierServiceModuleApiResponse(supabase, item) }
}

async function collectSubscriptionPackageIdsReferencingCarrierService(supabase: SupabaseClient, carrierServiceId: string) {
  const rows = await supabase.select(
    'packages',
    `select=package_id&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}`
  )
  const ids = new Set<string>()
  for (const r of Array.isArray(rows) ? rows : []) {
    const pid = String((r as any)?.package_id ?? '').trim()
    if (pid) ids.add(pid)
  }
  return [...ids]
}

export async function publishCarrierService({
  supabase,
  carrierServiceId,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  carrierServiceId: string
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(carrierServiceId)) return toError(400, 'BAD_REQUEST', 'carrierServiceId is invalid.')
  const rows = await supabase.select(
    'carrier_service_modules',
    `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
  const scopePub = await enforceCarrierServiceResellerScope(supabase, existing, authResellerTenantId)
  if (!scopePub.ok) return scopePub
  if (String((existing as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT carrier services can be published.')
  }
  const mergedInput = carrierServiceConfigInputFromDbRow(existing)
  const resellerTidExistingPub = (existing as any).reseller_id != null ? String((existing as any).reseller_id).trim() : ''
  const resellerRef: string | null = resellerTidExistingPub || null
  const normalized = await validateCarrierServiceModule({
    supabase,
    payload: { carrierServiceConfig: mergedInput, resellerId: resellerRef },
  })
  if (!normalized.ok) return normalized
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  const publishedAt = new Date().toISOString()
  await supabase.update(
    'carrier_service_modules',
    `carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}`,
    {
      status: 'PUBLISHED',
      effective_from: effectiveFrom,
      published_at: publishedAt,
      deprecated_at: null,
      updated_at: publishedAt,
    },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'carrier_service_modules',
    `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  const value = await mapCarrierServiceModuleApiResponse(supabase, refreshed)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'CARRIER_SERVICE_PUBLISHED',
    target_type: 'CARRIER_SERVICE',
    target_id: carrierServiceId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function deprecateCarrierService({
  supabase,
  carrierServiceId,
  audit,
  authResellerTenantId,
}: {
  supabase: SupabaseClient
  carrierServiceId: string
  audit?: AuditContext
  authResellerTenantId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(carrierServiceId)) return toError(400, 'BAD_REQUEST', 'carrierServiceId is invalid.')
  const rows = await supabase.select(
    'carrier_service_modules',
    `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!(existing as any)?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
  const scopeDep = await enforceCarrierServiceResellerScope(supabase, existing, authResellerTenantId)
  if (!scopeDep.ok) return scopeDep
  if (String((existing as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED carrier services can be deprecated.')
  }
  const pkgIds = await collectSubscriptionPackageIdsReferencingCarrierService(supabase, carrierServiceId)
  if (pkgIds.length) {
    return toError(
      409,
      'RESOURCE_IN_USE',
      `Carrier service is still referenced by subscription packages. packageIds=${pkgIds.join(',')}`
    )
  }
  const nowIso = new Date().toISOString()
  await supabase.update(
    'carrier_service_modules',
    `carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}`,
    {
      status: 'DEPRECATED',
      deprecated_at: nowIso,
      updated_at: nowIso,
    },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'carrier_service_modules',
    `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  const value = await mapCarrierServiceModuleApiResponse(supabase, refreshed)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: auditTenantIdFromResellerModuleRow(existing as any),
    action: 'CARRIER_SERVICE_DEPRECATED',
    target_type: 'CARRIER_SERVICE',
    target_id: carrierServiceId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: await mapCarrierServiceModuleApiResponse(supabase, existing),
    after_data: value,
  })
  return { ok: true, value }
}

function collectCarrierServiceConfigProfileRefs(config: any, key: 'apnProfileId' | 'roamingProfileId') {
  const refs = new Set<string>()
  if (!config || typeof config !== 'object') return refs
  if (key === 'apnProfileId') {
    const profileId = String((config as any).apnProfileId ?? (config as any).apn_profile_id ?? '').trim()
    if (profileId) refs.add(profileId)
    return refs
  }
  const profileId = String((config as any).roamingProfileId ?? (config as any).roaming_profile_id ?? '').trim()
  if (profileId) refs.add(profileId)
  return refs
}

async function resolveCompatibleProfileRefs(_supabase: SupabaseClient, profileRef: string, _profileType: 'APN' | 'ROAMING') {
  const refs = new Set<string>()
  const normalized = String(profileRef ?? '').trim()
  if (!normalized) return refs
  refs.add(normalized)
  return refs
}

export async function listCarrierServices({
  supabase,
  apnProfileId,
  roamingProfileId,
  status,
  page,
  pageSize,
  resellerId,
  supplierId,
  operatorId,
}: {
  supabase: SupabaseClient
  apnProfileId?: string | null
  roamingProfileId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
  resellerId?: string | null
  supplierId?: string | null
  operatorId?: string | null
}): Promise<ServiceResult<{ items: unknown[]; total: number; page: number; pageSize: number }>> {
  const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 500 })
  const apnProfileIdValue = apnProfileId ? String(apnProfileId).trim() : null
  const roamingProfileIdValue = roamingProfileId ? String(roamingProfileId).trim() : null
  const supplierIdValue = supplierId ? String(supplierId).trim() : null
  const operatorIdValue = operatorId ? String(operatorId).trim() : null
  if (apnProfileIdValue && !isValidUuid(apnProfileIdValue)) {
    return toError(400, 'BAD_REQUEST', 'apnProfileId is invalid.')
  }
  if (roamingProfileIdValue && !isValidUuid(roamingProfileIdValue)) {
    return toError(400, 'BAD_REQUEST', 'roamingProfileId is invalid.')
  }
  if (resellerId && !isValidUuid(resellerId)) {
    return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  }
  if (supplierIdValue && !isValidUuid(supplierIdValue)) {
    return toError(400, 'BAD_REQUEST', 'supplierId is invalid.')
  }
  if (operatorIdValue && !isValidUuid(operatorIdValue)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is invalid.')
  }
  let resellerRowId: string | null = null
  if (resellerId) {
    const resolved = await resolveResellerModuleRowId(supabase, String(resellerId).trim())
    if (!resolved.ok) return resolved
    resellerRowId = resolved.value
  }
  const filters = [`select=${CARRIER_SERVICE_MODULE_ROW_SELECT}`]
  if (resellerRowId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerRowId)}`)
  if (supplierIdValue) {
    filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
  }
  if (operatorIdValue) {
    const operatorIds = await resolveBoundOperatorIds(supabase, operatorIdValue, supplierIdValue)
    if (!operatorIds.length) {
      return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) }
    }
    if (operatorIds.length === 1) {
      filters.push(`operator_id=eq.${encodeURIComponent(String(operatorIds[0]))}`)
    } else {
      const values = operatorIds.map((id) => encodeURIComponent(id)).join(',')
      filters.push(`operator_id=in.(${values})`)
    }
  }
  if (status && String(status).trim()) {
    filters.push(`status=eq.${encodeURIComponent(String(status).trim())}`)
  }
  filters.push('order=created_at.desc')
  const [apnAcceptableRefs, roamingAcceptableRefs] = await Promise.all([
    apnProfileIdValue ? resolveCompatibleProfileRefs(supabase, apnProfileIdValue, 'APN') : Promise.resolve(new Set<string>()),
    roamingProfileIdValue
      ? resolveCompatibleProfileRefs(supabase, roamingProfileIdValue, 'ROAMING')
      : Promise.resolve(new Set<string>()),
  ])
  const rows = await supabase.select('carrier_service_modules', filters.join('&'))
  const services = Array.isArray(rows) ? rows : []
  const filteredServices = services.filter((row: any) => {
    const shape = mergedCarrierServiceConfigShape(row)
    const apnRefs = collectCarrierServiceConfigProfileRefs(shape, 'apnProfileId')
    const roamingRefs = collectCarrierServiceConfigProfileRefs(shape, 'roamingProfileId')
    if (apnProfileIdValue && !Array.from(apnRefs).some((ref) => apnAcceptableRefs.has(ref))) return false
    if (roamingProfileIdValue && !Array.from(roamingRefs).some((ref) => roamingAcceptableRefs.has(ref))) return false
    return true
  })
  const operatorRowPks = [
    ...new Set(
      filteredServices
        .map((r: any) => String((r as any)?.operator_id ?? '').trim())
        .filter(Boolean)
    ),
  ]
  const operatorDisplayByPk = await businessOperatorDisplayIdsByOperatorRowIds(supabase, operatorRowPks)
  let items = filteredServices.map((row: any) => {
    const pk = String((row as any)?.operator_id ?? '').trim()
    const display = pk ? operatorDisplayByPk.get(pk) ?? pk : null
    const rp = String((row as any)?.reseller_id ?? '').trim()
    const displayReseller = rp || null
    return mapCarrierServiceModuleForPublicResponse(row, display, displayReseller) as Record<string, unknown>
  })
  const total = items.length
  const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize)
  return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) }
}

/** Phase 34: module bodies on snapshot tables only; packages keep module FKs (no denormalized carrier/plan text). */
const PACKAGE_ROW_SELECT =
  'package_id,enterprise_id,name,description,status,effective_from,published_at,deprecated_at,updated_at,carrier_service_id,control_policy_id,commercial_terms_id,price_plan_id,created_at'

async function loadPackage(supabase: SupabaseClient, packageId: string) {
  const rows = await supabase.select(
    'packages',
    `select=package_id,enterprise_id,name,created_at&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadPackageRow(supabase: SupabaseClient, packageId: string) {
  const rows = await supabase.select(
    'packages',
    `select=${PACKAGE_ROW_SELECT}&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

function packageRoamingSnapshotFromCarrierConfig(
  carrierServiceConfig: Record<string, unknown>,
  roamingRow: any
): Record<string, unknown> | null {
  if (!roamingRow) return null
  const rid = String((carrierServiceConfig as any).roamingProfileId ?? '').trim()
  if (!rid) return null
  const mccmnc = mccmncAllowlistStringsFromRoamingProfileList((roamingRow as any).mccmnc_list)
  const rat = String((carrierServiceConfig as any).rat ?? '4G').trim()
  const apnPid = String((carrierServiceConfig as any).apnProfileId ?? '').trim()
  const payload: Record<string, unknown> = {
    type: 'MCCMNC_ALLOWLIST',
    mccmnc,
    rat,
    profileId: rid,
  }
  if (apnPid) payload.apnProfileId = apnPid
  return payload
}

async function mapPackageRowsForApiBatch(supabase: SupabaseClient, packageRows: any[]): Promise<Array<Record<string, unknown> | null>> {
  if (!packageRows.length) return []
  const carrierIds = [
    ...new Set(packageRows.map((r) => r?.carrier_service_id).filter(Boolean).map((x) => String(x).trim())),
  ]
  const ctIds = [
    ...new Set(packageRows.map((r) => r?.commercial_terms_id).filter(Boolean).map((x) => String(x).trim())),
  ]
  const cpIds = [
    ...new Set(packageRows.map((r) => r?.control_policy_id).filter(Boolean).map((x) => String(x).trim())),
  ]
  const carrierById = new Map<string, any>()
  if (carrierIds.length) {
    const list = carrierIds.map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'carrier_service_modules',
      `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.carrier_service_id != null ? String((r as any).carrier_service_id).trim() : ''
      if (id) carrierById.set(id, r)
    }
  }
  const opPks = [
    ...new Set(
      [...carrierById.values()]
        .map((r: any) => (r?.operator_id != null ? String(r.operator_id).trim() : ''))
        .filter(Boolean)
    ),
  ]
  const opDisplayByPk = await businessOperatorDisplayIdsByOperatorRowIds(supabase, opPks)

  const ctById = new Map<string, any>()
  if (ctIds.length) {
    const list = ctIds.map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'commercial_terms_modules',
      `select=commercial_terms_id,commercial_terms&commercial_terms_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.commercial_terms_id != null ? String((r as any).commercial_terms_id).trim() : ''
      if (id) ctById.set(id, r)
    }
  }
  const cpById = new Map<string, any>()
  if (cpIds.length) {
    const list = cpIds.map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'control_policy_modules',
      `select=control_policy_id,control_policy&control_policy_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.control_policy_id != null ? String((r as any).control_policy_id).trim() : ''
      if (id) cpById.set(id, r)
    }
  }
  const roamingIdsNeeded = new Set<string>()
  for (const row of packageRows) {
    const cid = row?.carrier_service_id ? String(row.carrier_service_id).trim() : ''
    const cs = cid ? carrierById.get(cid) : null
    if (cs) {
      const cfg = mergedCarrierServiceConfigShape(cs)
      const rid = String(cfg.roamingProfileId ?? '').trim()
      if (rid) roamingIdsNeeded.add(rid)
    }
  }
  const roamingById = new Map<string, any>()
  if (roamingIdsNeeded.size) {
    const list = [...roamingIdsNeeded].map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'roaming_profiles',
      `select=roaming_profile_id,mccmnc_list&roaming_profile_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.roaming_profile_id != null ? String((r as any).roaming_profile_id).trim() : ''
      if (id) roamingById.set(id, r)
    }
  }

  const planIds = [
    ...new Set(packageRows.map((r) => r?.price_plan_id).filter(Boolean).map((x) => String(x).trim())),
  ]
  const serviceTypeByPlanId = new Map<string, string>()
  if (planIds.length) {
    const list = planIds.map((x) => encodeURIComponent(x)).join(',')
    const prow = await supabase.select('price_plans', `select=price_plan_id,service_type&price_plan_id=in.(${list})`)
    for (const r of Array.isArray(prow) ? prow : []) {
      const pid = (r as any)?.price_plan_id != null ? String((r as any).price_plan_id).trim() : ''
      if (!pid) continue
      const st = (r as any)?.service_type != null ? String((r as any).service_type).trim() : ''
      serviceTypeByPlanId.set(pid, st || 'DATA')
    }
  }

  const apnProfileIdsForBatch: string[] = []
  for (const row of packageRows) {
    const cid = row?.carrier_service_id ? String(row.carrier_service_id).trim() : ''
    const cs = cid ? carrierById.get(cid) : null
    if (cs) {
      const pid = String(mergedCarrierServiceConfigShape(cs).apnProfileId ?? '').trim()
      if (pid) apnProfileIdsForBatch.push(pid)
    }
  }
  const apnByProfileId = await batchApnStringsByProfileIds(supabase, apnProfileIdsForBatch)

  return packageRows.map((row: any) => {
    const id = row?.package_id
    if (!id) return null
    let carrierServiceConfig: Record<string, unknown> = scrubLegacyCarrierServiceConfigFields({
      supplierId: null,
      operatorId: null,
      rat: '4G',
      apnProfileId: null,
      roamingProfileId: null,
    })
    let roamingProfile: unknown = null
    const planId = row?.price_plan_id ? String(row.price_plan_id).trim() : ''
    const serviceType = planId ? serviceTypeByPlanId.get(planId) ?? 'DATA' : 'DATA'
    let supplierId: unknown = null
    let operatorId: unknown = null
    let apn = ''
    const cid = row?.carrier_service_id ? String(row.carrier_service_id).trim() : ''
    if (cid) {
      const cs = carrierById.get(cid)
      if (cs) {
        const opPk = cs?.operator_id != null ? String(cs.operator_id).trim() : ''
        const displayOp = opPk ? opDisplayByPk.get(opPk) ?? opPk : null
        const resellerTid = cs?.reseller_id != null ? String(cs.reseller_id).trim() : ''
        const mapped = mapCarrierServiceModuleForPublicResponse(cs, displayOp, resellerTid || null)
        carrierServiceConfig = scrubLegacyCarrierServiceConfigFields((mapped.carrierServiceConfig ?? {}) as Record<string, unknown>)
        const apnPid = String((carrierServiceConfig as any).apnProfileId ?? '').trim()
        apn = apnPid ? apnByProfileId.get(apnPid) ?? '' : ''
        supplierId = (carrierServiceConfig as any).supplierId ?? null
        operatorId = (carrierServiceConfig as any).operatorId ?? null
        const rid = String((carrierServiceConfig as any).roamingProfileId ?? '').trim()
        const rpRow = rid ? roamingById.get(rid) : null
        roamingProfile = packageRoamingSnapshotFromCarrierConfig(carrierServiceConfig, rpRow)
      }
    }
    const ctid = row?.commercial_terms_id ? String(row.commercial_terms_id).trim() : ''
    const commercialTerms = ctid ? ((ctById.get(ctid) as any)?.commercial_terms ?? {}) : {}
    const cpid = row?.control_policy_id ? String(row.control_policy_id).trim() : ''
    const controlPolicy = cpid ? ((cpById.get(cpid) as any)?.control_policy ?? {}) : {}
    return {
      packageId: id,
      description: row.description != null ? String(row.description) : null,
      status: row.status,
      effectiveFrom: row.effective_from,
      publishedAt: row.published_at ?? null,
      deprecatedAt: row.deprecated_at ?? null,
      supplierId,
      operatorId,
      serviceType,
      apn,
      roamingProfile,
      carrierServiceConfig,
      carrierServiceId: row.carrier_service_id ?? null,
      controlPolicyId: row.control_policy_id ?? null,
      commercialTermsId: row.commercial_terms_id ?? null,
      controlPolicy,
      commercialTerms,
      pricePlanId: row.price_plan_id ?? null,
      createdAt: row.created_at,
    }
  })
}

async function mapPackageRowForApi(supabase: SupabaseClient, row: any): Promise<Record<string, unknown> | null> {
  if (!row) return null
  const [out] = await mapPackageRowsForApiBatch(supabase, [row])
  return out
}

/** Reseller scope for package module FKs: ENTERPRISE `tenants.parent_id`, optional `payload.resellerId` cross-check. */
async function resolveResellerTenantIdForPackageModules(
  supabase: SupabaseClient,
  enterpriseId: string,
  payloadResellerRef: unknown
): Promise<ServiceResult<string>> {
  const tRows = await supabase.select(
    'tenants',
    `select=parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const t = Array.isArray(tRows) ? tRows[0] : null
  if (!t) return toError(404, 'RESOURCE_NOT_FOUND', 'enterpriseId not found.')
  const parentTid = (t as any).parent_id != null ? String((t as any).parent_id).trim() : ''
  if (!parentTid) {
    return toError(400, 'BAD_REQUEST', 'Enterprise has no reseller parent; cannot validate module scope.')
  }
  const rawRef =
    payloadResellerRef !== undefined && payloadResellerRef !== null && String(payloadResellerRef).trim() !== ''
      ? String(payloadResellerRef).trim()
      : null
  if (rawRef) {
    const canon = await canonicalResellerTenantIdFromRef(supabase, rawRef)
    if (!canon.ok) return canon
    if (String(canon.value) !== String(parentTid)) {
      return toError(400, 'BAD_REQUEST', 'resellerId does not match package enterprise.')
    }
  }
  return { ok: true, value: parentTid }
}

function assertModuleResellerRow(
  rowResellerId: unknown,
  expectedTenantId: string,
  fieldLabel: string
): ServiceResult<null> {
  const r = rowResellerId != null ? String(rowResellerId).trim() : ''
  if (!r) {
    return toError(400, 'BAD_REQUEST', `${fieldLabel} is not associated with a reseller.`)
  }
  if (r !== String(expectedTenantId).trim()) {
    return toError(400, 'BAD_REQUEST', `${fieldLabel} does not belong to the package reseller.`)
  }
  return { ok: true, value: null }
}

function validatePricePlanRowForPackage(
  row: any,
  enterpriseId: string,
  resellerTenantId: string
): ServiceResult<null> {
  if (!row || !(row as any).price_plan_id) {
    return toError(404, 'NOT_FOUND', 'Price plan not found.')
  }
  if (String((row as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(400, 'BAD_REQUEST', 'pricePlanId must reference a PUBLISHED price plan.')
  }
  if (String((row as any).enterprise_id ?? '') !== String(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId does not belong to this enterprise.')
  }
  if (String((row as any).reseller_id ?? '') !== String(resellerTenantId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId does not belong to the package reseller.')
  }
  return { ok: true, value: null }
}

/**
 * Package connectivity context is a single supplier+operator pair.
 * Price Plan contributes that pair via CoveredNetworkProfile; Carrier Service stores it directly.
 */
async function assertPackagePricePlanCarrierConnectivity(
  supabase: SupabaseClient,
  pricePlanRow: any,
  carrierSupplierId: string,
  carrierOperatorIdPk: string
): Promise<ServiceResult<null>> {
  const planTypeRaw = String(pricePlanRow?.type ?? '').trim()
  const planType = planTypeRaw === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : planTypeRaw
  if (!pricePlanTypeUsesCoveredNetwork(planType)) {
    return { ok: true, value: null }
  }
  const coveredId = String(pricePlanRow?.covered_network_profile_id ?? '').trim()
  if (!coveredId || !isValidUuid(coveredId)) {
    return toError(
      400,
      'BAD_REQUEST',
      'pricePlanId must reference a CoveredNetworkProfile to align supplier/operator with carrierServiceId.'
    )
  }
  const rows = await supabase.select(
    'covered_network_profiles',
    `select=covered_network_profile_id,supplier_id,operator_id,status&covered_network_profile_id=eq.${encodeURIComponent(coveredId)}&limit=1`
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  if (!(profile as any)?.covered_network_profile_id) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId coveredNetworkProfileId is not found.')
  }
  const coveredSupplier = String((profile as any).supplier_id ?? '').trim()
  const coveredOperator = String((profile as any).operator_id ?? '').trim()
  if (!coveredSupplier || !isValidUuid(coveredSupplier)) {
    return toError(400, 'BAD_REQUEST', 'pricePlan CoveredNetworkProfile has invalid supplierId.')
  }
  if (!coveredOperator || !isValidUuid(coveredOperator)) {
    return toError(400, 'BAD_REQUEST', 'pricePlan CoveredNetworkProfile has invalid operatorId.')
  }
  if (coveredSupplier !== String(carrierSupplierId || '').trim()) {
    return toError(
      400,
      'BAD_REQUEST',
      'pricePlanId and carrierServiceId must share the same supplierId (via CoveredNetworkProfile).'
    )
  }
  if (coveredOperator !== String(carrierOperatorIdPk || '').trim()) {
    return toError(
      400,
      'BAD_REQUEST',
      'pricePlanId and carrierServiceId must share the same operatorId (via CoveredNetworkProfile).'
    )
  }
  return { ok: true, value: null }
}

async function resolveModulePayloadByIds({
  supabase,
  carrierServiceId,
  controlPolicyId,
  commercialTermsId,
  resellerTenantId,
}: {
  supabase: SupabaseClient
  carrierServiceId: string | null
  controlPolicyId: string | null
  commercialTermsId: string | null
  resellerTenantId: string
}): Promise<
  ServiceResult<{
    carrierServiceConfig: Record<string, unknown> | null
    controlPolicy: Record<string, unknown> | null
    commercialTerms: Record<string, unknown> | null
  }>
> {
  let carrierServiceConfig: Record<string, unknown> | null = null
  let controlPolicy: Record<string, unknown> | null = null
  let commercialTerms: Record<string, unknown> | null = null
  if (carrierServiceId) {
    if (!isValidUuid(carrierServiceId)) return toError(400, 'BAD_REQUEST', 'carrierServiceId is invalid.')
    const rows = await supabase.select(
      'carrier_service_modules',
      `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!(row as any)?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
    if (String((row as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
      return toError(400, 'BAD_REQUEST', 'carrierServiceId must reference a PUBLISHED carrier service.')
    }
    const rs = assertModuleResellerRow((row as any).reseller_id, resellerTenantId, 'carrierServiceId')
    if (!rs.ok) return rs
    carrierServiceConfig = scrubLegacyCarrierServiceConfigFields(mergedCarrierServiceConfigShape(row))
  }
  if (controlPolicyId) {
    if (!isValidUuid(controlPolicyId)) return toError(400, 'BAD_REQUEST', 'controlPolicyId is invalid.')
    const rows = await supabase.select(
      'control_policy_modules',
      `select=control_policy_id,reseller_id,control_policy,status&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!(row as any)?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
    if (String((row as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
      return toError(400, 'BAD_REQUEST', 'controlPolicyId must reference a PUBLISHED control policy.')
    }
    const rs = assertModuleResellerRow((row as any).reseller_id, resellerTenantId, 'controlPolicyId')
    if (!rs.ok) return rs
    controlPolicy = ((row as any).control_policy ?? null) as Record<string, unknown> | null
  }
  if (commercialTermsId) {
    if (!isValidUuid(commercialTermsId)) return toError(400, 'BAD_REQUEST', 'commercialTermsId is invalid.')
    const rows = await supabase.select(
      'commercial_terms_modules',
      `select=commercial_terms_id,reseller_id,commercial_terms,status&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!(row as any)?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
    if (String((row as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
      return toError(400, 'BAD_REQUEST', 'commercialTermsId must reference PUBLISHED commercial terms.')
    }
    const rs = assertModuleResellerRow((row as any).reseller_id, resellerTenantId, 'commercialTermsId')
    if (!rs.ok) return rs
    commercialTerms = ((row as any).commercial_terms ?? null) as Record<string, unknown> | null
  }
  return { ok: true, value: { carrierServiceConfig, controlPolicy, commercialTerms } }
}

export async function createPackage({
  supabase,
  enterpriseId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  payload: any
  audit?: AuditContext
}) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  }
  const nameResult = normalizeRequiredModuleName(payload?.name)
  if (!nameResult.ok) return nameResult
  const name = nameResult.value
  const pricePlanId = String(payload?.pricePlanId || '').trim()
  if (!pricePlanId) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId is required.')
  }
  if (pricePlanId && !isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId is invalid.')
  }
  const scopeForModules = await resolveResellerTenantIdForPackageModules(supabase, enterpriseId, payload?.resellerId)
  if (!scopeForModules.ok) return scopeForModules
  const resellerTenantId = scopeForModules.value
  const pricePlanVersionRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,status,enterprise_id,reseller_id,type,covered_network_profile_id&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  const pricePlanVersion = Array.isArray(pricePlanVersionRows) ? pricePlanVersionRows[0] : null
  const planOk = validatePricePlanRowForPackage(pricePlanVersion, enterpriseId, resellerTenantId)
  if (!planOk.ok) return planOk
  const carrierServiceId = payload?.carrierServiceId ? String(payload.carrierServiceId).trim() : null
  if (!carrierServiceId) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceId is required.')
  }
  const controlPolicyId = payload?.controlPolicyId ? String(payload.controlPolicyId).trim() : null
  const commercialTermsId = payload?.commercialTermsId ? String(payload.commercialTermsId).trim() : null
  const moduleById = await resolveModulePayloadByIds({
    supabase,
    carrierServiceId,
    controlPolicyId,
    commercialTermsId,
    resellerTenantId,
  })
  if (!moduleById.ok) return moduleById
  const normalizeInput = {
    ...payload,
    ...(moduleById.value.carrierServiceConfig ? { carrierServiceConfig: moduleById.value.carrierServiceConfig } : {}),
    ...(moduleById.value.controlPolicy ? { controlPolicy: moduleById.value.controlPolicy } : {}),
    ...(moduleById.value.commercialTerms ? { commercialTerms: moduleById.value.commercialTerms } : {}),
  }
  const normalizedModules = normalizePackageModules(normalizeInput, pricePlanVersion)
  if (!normalizedModules.ok) return normalizedModules
  const modulesValidate = await validateModuleReferences(
    supabase,
    normalizedModules.value.carrierServiceConfig,
    normalizedModules.value.controlPolicy,
    { resellerRef: payload?.resellerId }
  )
  if (!modulesValidate.ok) return modulesValidate
  const connectivity = await assertPackagePricePlanCarrierConnectivity(
    supabase,
    pricePlanVersion,
    String((normalizedModules.value.carrierServiceConfig as any)?.supplierId ?? ''),
    String(modulesValidate.value.operatorId ?? '')
  )
  if (!connectivity.ok) return connectivity
  const carrierServiceConfig = {
    ...normalizedModules.value.carrierServiceConfig,
    operatorId: modulesValidate.value.operatorId,
  }
  const apnRes = await loadApnFromApnProfile(supabase, String((carrierServiceConfig as any).apnProfileId))
  if (!apnRes.ok) return apnRes
  const description = normalizeOptionalPackageDescription(payload?.description)
  const packageRows = await supabase.insert(
    'packages',
    {
      enterprise_id: enterpriseId,
      name,
      description,
      status: 'DRAFT',
      effective_from: null,
      carrier_service_id: carrierServiceId,
      control_policy_id: controlPolicyId,
      commercial_terms_id: commercialTermsId,
      price_plan_id: (pricePlanVersion as any).price_plan_id,
    },
    { returning: 'representation' }
  )
  const row = Array.isArray(packageRows) ? packageRows[0] : null
  if (!(row as any)?.package_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create package.')
  const pid = (row as any).package_id
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: enterpriseId ?? null,
    action: 'PACKAGE_CREATED',
    target_type: 'PACKAGE',
    target_id: pid,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      packageId: pid,
      status: (row as any)?.status ?? 'DRAFT',
    },
  })
  return {
    ok: true,
    value: {
      packageId: pid,
      status: (row as any)?.status ?? 'DRAFT',
      createdAt: (row as any)?.created_at,
    },
  }
}

export async function updatePackage({
  supabase,
  packageId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  packageId: string
  payload: any
  audit?: AuditContext
}) {
  if (!isValidUuid(packageId)) return toError(400, 'BAD_REQUEST', 'packageId is invalid.')
  const pkg = await loadPackage(supabase, packageId)
  if (!pkg) return toError(404, 'NOT_FOUND', 'Package not found.')
  const latestVersion = await loadPackageRow(supabase, packageId)
  if (!latestVersion) return toError(404, 'NOT_FOUND', 'Package not found.')
  if ((latestVersion as any).status !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT package can be updated.')
  }
  const packageEnterpriseId = String((latestVersion as any).enterprise_id || '').trim()
  if (!isValidUuid(packageEnterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'package.enterpriseId is invalid.')
  }
  const scopeForUpdate = await resolveResellerTenantIdForPackageModules(supabase, packageEnterpriseId, payload?.resellerId)
  if (!scopeForUpdate.ok) return scopeForUpdate
  const resellerTenantId = scopeForUpdate.value

  let effectivePricePlanId: string
  if (payload?.pricePlanId !== undefined) {
    const newPlanId = String(payload.pricePlanId || '').trim()
    if (!newPlanId) {
      return toError(400, 'BAD_REQUEST', 'pricePlanId must be a non-empty uuid when provided.')
    }
    if (!isValidUuid(newPlanId)) {
      return toError(400, 'BAD_REQUEST', 'pricePlanId is invalid.')
    }
    effectivePricePlanId = newPlanId
  } else {
    const cur =
      (latestVersion as any).price_plan_id != null ? String((latestVersion as any).price_plan_id).trim() : ''
    if (!cur) {
      return toError(400, 'BAD_REQUEST', 'Package has no price plan; set pricePlanId in the request body.')
    }
    if (!isValidUuid(cur)) {
      return toError(400, 'BAD_REQUEST', 'Package price plan id is invalid; set a valid pricePlanId in the request body.')
    }
    effectivePricePlanId = cur
  }
  const prRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,status,enterprise_id,reseller_id,type,covered_network_profile_id&price_plan_id=eq.${encodeURIComponent(effectivePricePlanId)}&limit=1`
  )
  const pr = Array.isArray(prRows) ? prRows[0] : null
  const pOk = validatePricePlanRowForPackage(pr, packageEnterpriseId, resellerTenantId)
  if (!pOk.ok) return pOk

  const metaPatch: Record<string, unknown> = {}
  if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'name')) {
    const nameResult = normalizeRequiredModuleName((payload as any).name)
    if (!nameResult.ok) return nameResult
    metaPatch.name = nameResult.value
  }
  if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'description')) {
    metaPatch.description = normalizeOptionalPackageDescription((payload as any).description)
  }
  if (Object.keys(metaPatch).length) {
    await supabase.update(
      'packages',
      `package_id=eq.${encodeURIComponent(packageId)}`,
      { ...metaPatch, updated_at: new Date().toISOString() },
      { returning: 'minimal' }
    )
  }
  const carrierServiceIdEff =
    payload?.carrierServiceId !== undefined
      ? String(payload.carrierServiceId || '').trim() || null
      : (latestVersion as any).carrier_service_id
        ? String((latestVersion as any).carrier_service_id).trim()
        : null
  const controlPolicyIdEff =
    payload?.controlPolicyId !== undefined
      ? String(payload.controlPolicyId || '').trim() || null
      : (latestVersion as any).control_policy_id
        ? String((latestVersion as any).control_policy_id).trim()
        : null
  const commercialTermsIdEff =
    payload?.commercialTermsId !== undefined
      ? String(payload.commercialTermsId || '').trim() || null
      : (latestVersion as any).commercial_terms_id
        ? String((latestVersion as any).commercial_terms_id).trim()
        : null
  const moduleById = await resolveModulePayloadByIds({
    supabase,
    carrierServiceId: carrierServiceIdEff,
    controlPolicyId: controlPolicyIdEff,
    commercialTermsId: commercialTermsIdEff,
    resellerTenantId,
  })
  if (!moduleById.ok) return moduleById
  const mergedCarrierServiceConfig = {
    supplierId:
      payload?.carrierServiceConfig?.supplierId ?? moduleById.value.carrierServiceConfig?.supplierId,
    operatorId:
      payload?.carrierServiceConfig?.operatorId ?? moduleById.value.carrierServiceConfig?.operatorId,
    rat: payload?.carrierServiceConfig?.rat ?? moduleById.value.carrierServiceConfig?.rat ?? '4G',
    apnProfileId:
      payload?.carrierServiceConfig?.apnProfileId ?? moduleById.value.carrierServiceConfig?.apnProfileId ?? null,
    roamingProfileId:
      payload?.carrierServiceConfig?.roamingProfileId ?? moduleById.value.carrierServiceConfig?.roamingProfileId ?? null,
  }
  const carrierNormalized = normalizeCarrierServiceConfig(mergedCarrierServiceConfig)
  if (!carrierNormalized.ok) return carrierNormalized
  const commercialNormalized = normalizeCommercialTerms(
    payload?.commercialTerms !== undefined
      ? payload.commercialTerms
      : moduleById.value.commercialTerms ?? {}
  )
  if (!commercialNormalized.ok) return commercialNormalized
  const controlNormalized = normalizeControlPolicy(
    payload?.controlPolicy !== undefined
      ? payload.controlPolicy
      : moduleById.value.controlPolicy ?? {},
    'full'
  )
  if (!controlNormalized.ok) return controlNormalized
  const modulesValidate = await validateModuleReferences(supabase, carrierNormalized.value, controlNormalized.value, {
    resellerRef: payload?.resellerId,
  })
  if (!modulesValidate.ok) return modulesValidate
  const connectivity = await assertPackagePricePlanCarrierConnectivity(
    supabase,
    pr,
    String((carrierNormalized.value as any)?.supplierId ?? ''),
    String(modulesValidate.value.operatorId ?? '')
  )
  if (!connectivity.ok) return connectivity
  const carrierServiceConfigResolved = {
    ...carrierNormalized.value,
    operatorId: modulesValidate.value.operatorId,
  }
  const apnResolved = await loadApnFromApnProfile(supabase, String((carrierServiceConfigResolved as any).apnProfileId))
  if (!apnResolved.ok) return apnResolved
  const patch: Record<string, unknown> = {}
  patch.carrier_service_id = carrierServiceIdEff
  patch.control_policy_id = controlPolicyIdEff
  patch.commercial_terms_id = commercialTermsIdEff
  if (payload?.pricePlanId !== undefined) {
    const pricePlanId = String(payload.pricePlanId || '').trim()
    if (!pricePlanId || !isValidUuid(pricePlanId)) {
      return toError(400, 'BAD_REQUEST', 'pricePlanId is invalid.')
    }
    patch.price_plan_id = pricePlanId
  }
  if (Object.keys(patch).length) {
    await supabase.update(
      'packages',
      `package_id=eq.${encodeURIComponent(packageId)}`,
      { ...patch, updated_at: new Date().toISOString() },
      { returning: 'minimal' }
    )
  }
  const updatedVersion = await loadPackageRow(supabase, packageId)
  const beforeApi = await mapPackageRowForApi(supabase, latestVersion)
  const afterApi = await mapPackageRowForApi(supabase, updatedVersion)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: (pkg as any)?.enterprise_id ?? null,
    action: 'PACKAGE_UPDATED',
    target_type: 'PACKAGE',
    target_id: packageId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: beforeApi,
    after_data: afterApi,
  })
  return { ok: true, value: afterApi }
}

export async function publishPackage({
  supabase,
  packageId,
  audit,
  publishInput,
}: {
  supabase: SupabaseClient
  packageId: string
  audit?: AuditContext
  publishInput?: {
    externalProductId?: unknown
    provisioningParameters?: unknown
  }
}) {
  if (!isValidUuid(packageId)) return toError(400, 'BAD_REQUEST', 'packageId is invalid.')
  const latestVersion = await loadPackageRow(supabase, packageId)
  if (!latestVersion) return toError(404, 'NOT_FOUND', 'Package not found.')
  if ((latestVersion as any).status !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT package can be published.')
  }
  const pricePlanVersionRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,type,status,covered_network_profile_id&price_plan_id=eq.${encodeURIComponent(String((latestVersion as any).price_plan_id))}&limit=1`
  )
  const pricePlanVersion = Array.isArray(pricePlanVersionRows) ? pricePlanVersionRows[0] : null
  if (!pricePlanVersion) return toError(404, 'NOT_FOUND', 'Price plan version not found.')
  const carrierModuleId = (latestVersion as any).carrier_service_id ? String((latestVersion as any).carrier_service_id).trim() : ''
  if (!carrierModuleId) {
    return toError(409, 'INVALID_STATUS', 'Package must reference a carrier service module before publish.')
  }
  let apnProfileId: string | null = null
  let roamingProfileId: string | null = null
  const csRows = await supabase.select(
    'carrier_service_modules',
    `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(carrierModuleId)}&limit=1`
  )
  const csRow = Array.isArray(csRows) ? csRows[0] : null
  if (!csRow || String((csRow as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Carrier service module must be PUBLISHED.')
  }
  const merged = mergedCarrierServiceConfigShape(csRow)
  const apnRaw = String(merged.apnProfileId ?? '').trim()
  const roamRaw = String(merged.roamingProfileId ?? '').trim()
  apnProfileId = apnRaw || null
  roamingProfileId = roamRaw || null
  if (!apnProfileId) {
    return toError(409, 'INVALID_STATUS', 'Carrier service module must include apnProfileId before publish.')
  }
  if (apnProfileId) {
    const apnProfiles = await supabase.select(
      'apn_profiles',
      `select=apn_profile_id,status&apn_profile_id=eq.${encodeURIComponent(String(apnProfileId))}&limit=1`
    )
    const apnProfile = Array.isArray(apnProfiles) ? apnProfiles[0] : null
    if (!apnProfile || (apnProfile as any).status !== 'PUBLISHED') {
      return toError(409, 'PROFILE_VERSION_INVALID', 'APN profile must be PUBLISHED.')
    }
  }
  if (roamingProfileId) {
    const roamingProfiles = await supabase.select(
      'roaming_profiles',
      `select=roaming_profile_id,status&roaming_profile_id=eq.${encodeURIComponent(String(roamingProfileId))}&limit=1`
    )
    const roamingProfile = Array.isArray(roamingProfiles) ? roamingProfiles[0] : null
    if (!roamingProfile || (roamingProfile as any).status !== 'PUBLISHED') {
      return toError(409, 'PROFILE_VERSION_INVALID', 'Roaming profile must be PUBLISHED.')
    }
  }
  const commercialModuleId = (latestVersion as any).commercial_terms_id
    ? String((latestVersion as any).commercial_terms_id).trim()
    : ''
  if (commercialModuleId) {
    const ctRows = await supabase.select(
      'commercial_terms_modules',
      `select=commercial_terms_id,status&commercial_terms_id=eq.${encodeURIComponent(commercialModuleId)}&limit=1`
    )
    const ctRow = Array.isArray(ctRows) ? ctRows[0] : null
    if (!ctRow || String((ctRow as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
      return toError(409, 'INVALID_STATUS', 'Commercial terms module must be PUBLISHED.')
    }
  }
  const controlModuleId = (latestVersion as any).control_policy_id
    ? String((latestVersion as any).control_policy_id).trim()
    : ''
  if (controlModuleId) {
    const cpRows = await supabase.select(
      'control_policy_modules',
      `select=control_policy_id,status&control_policy_id=eq.${encodeURIComponent(controlModuleId)}&limit=1`
    )
    const cpRow = Array.isArray(cpRows) ? cpRows[0] : null
    if (!cpRow || String((cpRow as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
      return toError(409, 'INVALID_STATUS', 'Control policy module must be PUBLISHED.')
    }
  }
  if (String((pricePlanVersion as any).status ?? '').trim().toUpperCase() !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Price plan must be PUBLISHED.')
  }
  const planType = String((pricePlanVersion as any).type ?? '').trim()
  if (pricePlanTypeUsesCoveredNetwork(planType === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : planType)) {
    const coveredId = String((pricePlanVersion as any).covered_network_profile_id ?? '').trim()
    if (!coveredId) {
      return toError(
        409,
        'INVALID_STATUS',
        'Price plan requires coveredNetworkProfileId before the package can be published.'
      )
    }
    const covRows = await supabase.select(
      'covered_network_profiles',
      `select=covered_network_profile_id,status,supplier_id,operator_id&covered_network_profile_id=eq.${encodeURIComponent(coveredId)}&limit=1`
    )
    const cov = Array.isArray(covRows) ? covRows[0] : null
    if (!cov || String((cov as any).status ?? '').trim().toUpperCase() !== 'PUBLISHED') {
      return toError(409, 'INVALID_STATUS', 'CoveredNetworkProfile must be PUBLISHED for this price plan.')
    }
    const publishConnectivity = await assertPackagePricePlanCarrierConnectivity(
      supabase,
      pricePlanVersion,
      String((csRow as any)?.supplier_id ?? ''),
      String((csRow as any)?.operator_id ?? '')
    )
    if (!publishConnectivity.ok) {
      return toError(409, 'INVALID_STATUS', (publishConnectivity as { message: string }).message)
    }
  }
  const externalProductId = String(publishInput?.externalProductId ?? '').trim()
  if (!externalProductId) {
    return toError(400, 'BAD_REQUEST', 'externalProductId is required.')
  }
  const carrierSupplierId = (csRow as any)?.supplier_id != null ? String((csRow as any).supplier_id).trim() : ''
  if (!carrierSupplierId || !isValidUuid(carrierSupplierId)) {
    return toError(409, 'INVALID_STATUS', 'Carrier service module must include supplier_id before publish.')
  }
  const existingMappingRows = await supabase.select(
    'vendor_product_mappings',
    `select=mapping_id,external_product_id&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  const existingMapping = Array.isArray(existingMappingRows) ? (existingMappingRows[0] as Record<string, unknown>) : null
  if (existingMapping?.mapping_id && (latestVersion as any).status === 'PUBLISHED') {
    return toError(409, 'MAPPING_ALREADY_EXISTS', 'Vendor product mapping already exists for this package.')
  }
  let mappingId: string | null = existingMapping?.mapping_id ? String(existingMapping.mapping_id) : null
  if (!mappingId) {
    const mappingRows = await supabase.insert(
      'vendor_product_mappings',
      {
        package_id: packageId,
        supplier_id: carrierSupplierId,
        external_product_id: externalProductId,
        provisioning_parameters: publishInput?.provisioningParameters ?? null,
      },
      { returning: 'representation' }
    )
    const mapping = Array.isArray(mappingRows) ? (mappingRows[0] as Record<string, unknown>) : null
    if (!mapping?.mapping_id) {
      return toError(500, 'INTERNAL_ERROR', 'Failed to create vendor product mapping.')
    }
    mappingId = String(mapping.mapping_id)
  } else {
    await supabase.update(
      'vendor_product_mappings',
      `mapping_id=eq.${encodeURIComponent(mappingId)}`,
      {
        supplier_id: carrierSupplierId,
        external_product_id: externalProductId,
        provisioning_parameters: publishInput?.provisioningParameters ?? null,
      },
      { returning: 'minimal' }
    )
  }
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  const publishedAt = new Date().toISOString()
  await supabase.update(
    'packages',
    `package_id=eq.${encodeURIComponent(packageId)}`,
    {
      status: 'PUBLISHED',
      effective_from: effectiveFrom,
      published_at: publishedAt,
      updated_at: publishedAt,
    },
    { returning: 'minimal' }
  )
  const pkg = await loadPackage(supabase, packageId)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: (pkg as any)?.enterprise_id ?? null,
    action: 'PACKAGE_PUBLISHED',
    target_type: 'PACKAGE',
    target_id: packageId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      packageId,
      status: 'PUBLISHED',
      effectiveFrom,
      publishedAt,
      mappingId,
      externalProductId,
      supplierId: carrierSupplierId,
    },
  })
  return {
    ok: true,
    value: {
      packageId,
      status: 'PUBLISHED',
      publishedAt,
      effectiveFrom,
      mappingId,
      externalProductId,
    },
  }
}

export async function deprecatePackage({
  supabase,
  packageId,
  audit,
}: {
  supabase: SupabaseClient
  packageId: string
  audit?: AuditContext
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(packageId)) return toError(400, 'BAD_REQUEST', 'packageId is invalid.')
  const row = await loadPackageRow(supabase, packageId)
  if (!row) return toError(404, 'NOT_FOUND', 'Package not found.')
  if (String((row as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED package can be deprecated.')
  }
  const inUse = await supabase.select(
    'subscriptions',
    `select=subscription_id&package_id=eq.${encodeURIComponent(packageId)}&state=in.(ACTIVE,PENDING)&limit=1`
  )
  if (Array.isArray(inUse) && inUse.length) {
    return toError(409, 'RESOURCE_IN_USE', 'Package is still associated with an ACTIVE or PENDING subscription.')
  }
  const nowIso = new Date().toISOString()
  await supabase.update(
    'packages',
    `package_id=eq.${encodeURIComponent(packageId)}`,
    { status: 'DEPRECATED', deprecated_at: nowIso, updated_at: nowIso },
    { returning: 'minimal' }
  )
  const entId = (row as any).enterprise_id ?? null
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: entId,
    action: 'PACKAGE_DEPRECATED',
    target_type: 'PACKAGE',
    target_id: packageId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: { packageId, status: 'DEPRECATED', deprecatedAt: nowIso },
  })
  return {
    ok: true,
    value: {
      packageId,
      status: 'DEPRECATED' as const,
      deprecatedAt: nowIso,
    },
  }
}

const COMMERCIAL_TERMS_MODULE_LIST_SELECT =
  'commercial_terms_id,name,commercial_terms,reseller_id,status,effective_from,published_at,deprecated_at,created_at,updated_at'
const CONTROL_POLICY_MODULE_LIST_SELECT =
  'control_policy_id,name,control_policy,reseller_id,status,effective_from,published_at,deprecated_at,created_at,updated_at'
const APN_PROFILE_LIST_SELECT =
  'apn_profile_id,name,apn,auth_type,supplier_id,operator_id,status,published_at,effective_from,source_apn_profile_id,created_at,updated_at'
/** `GET /v1/roaming-profiles` list rows; includes `mccmncList`. */
const ROAMING_PROFILE_LIST_SELECT =
  'roaming_profile_id,name,mccmnc_list,supplier_id,operator_id,status,published_at,effective_from,source_roaming_profile_id,created_at,updated_at'
/** Package list `items[].roamingProfile` only — no MCC/MNC array (use roaming profile detail for full allowlist). */
const ROAMING_PROFILE_PACKAGE_LIST_SELECT =
  'roaming_profile_id,name,status,published_at,effective_from,created_at,updated_at'
const COVERED_PROFILE_LIST_SELECT =
  'covered_network_profile_id,name,reseller_id,supplier_id,operator_id,status,published_at,effective_from,source_covered_network_profile_id,created_at,updated_at'

type CoveredEntry = { mcc: string; mnc: string }

async function batchFetchCoveredEntriesMap(supabase: SupabaseClient, profileIds: string[]) {
  const map = new Map<string, CoveredEntry[]>()
  const uniq = [...new Set(profileIds.map((x) => String(x).trim()).filter(Boolean))]
  if (!uniq.length) return map
  const values = uniq.map((id) => encodeURIComponent(id)).join(',')
  const rows = await supabase.select(
    'covered_network_profile_entries',
    `select=covered_network_profile_id,mcc,mnc&covered_network_profile_id=in.(${values})&order=mcc.asc,mnc.asc`
  )
  for (const row of Array.isArray(rows) ? rows : []) {
    const pid = String((row as any).covered_network_profile_id ?? '').trim()
    if (!pid) continue
    if (!map.has(pid)) map.set(pid, [])
    map.get(pid)!.push({
      mcc: String((row as any).mcc ?? '').trim(),
      mnc: String((row as any).mnc ?? '').trim(),
    })
  }
  return map
}

function mapApnProfileListItem(
  p: any,
  publicOperatorId: string | null
): Record<string, unknown> {
  return {
    apnProfileId: p.apn_profile_id,
    name: p.name,
    apn: p.apn,
    authType: p.auth_type,
    supplierId: p.supplier_id,
    operatorId: publicOperatorId ?? p.operator_id ?? null,
    status: p.status,
    publishedAt: p.published_at ?? null,
    effectiveFrom: p.effective_from ?? null,
    sourceApnProfileId: p.source_apn_profile_id ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }
}

function mapRoamingProfilePackageListSummary(p: any): Record<string, unknown> {
  return {
    roamingProfileId: p.roaming_profile_id,
    name: p.name,
    status: p.status,
    publishedAt: p.published_at ?? null,
    effectiveFrom: p.effective_from ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }
}

function mapCoveredNetworkProfileListItem(
  p: any,
  coverage: CoveredEntry[],
  publicOperatorId: string | null
): Record<string, unknown> {
  return {
    coveredNetworkProfileId: p.covered_network_profile_id,
    name: p.name,
    coverage,
    resellerId: p.reseller_id ?? null,
    supplierId: p.supplier_id,
    operatorId: publicOperatorId ?? p.operator_id ?? null,
    status: p.status,
    publishedAt: p.published_at ?? null,
    effectiveFrom: p.effective_from ?? null,
    sourceCoveredNetworkProfileId: p.source_covered_network_profile_id ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }
}

/** List response: expanded module snapshots + `moduleRef` (per pricing-api §6.3.1 / OpenAPI names); no nested legacy `package` object. */
async function mapPackageListRowsToItems(supabase: SupabaseClient, packageRows: any[]) {
  if (!packageRows.length) return []
  const eids = [...new Set(packageRows.map((p) => String(p?.enterprise_id || '')).filter((x) => x && isValidUuid(x)))]
  const parentMap = new Map<string, string | null>()
  if (eids.length) {
    const inList = eids.map((e) => encodeURIComponent(e)).join(',')
    const trows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&tenant_id=in.(${inList})&tenant_type=eq.ENTERPRISE`
    )
    for (const t of Array.isArray(trows) ? trows : []) {
      const tid = (t as any).tenant_id != null ? String((t as any).tenant_id) : ''
      if (!tid) continue
      const pid = (t as any).parent_id != null ? String((t as any).parent_id) : null
      parentMap.set(tid, pid)
    }
  }

  const carrierIds = [
    ...new Set(packageRows.map((r) => r?.carrier_service_id).filter(Boolean).map((x) => String(x).trim())),
  ]
  const ctIds = [
    ...new Set(packageRows.map((r) => r?.commercial_terms_id).filter(Boolean).map((x) => String(x).trim())),
  ]
  const cpIds = [
    ...new Set(packageRows.map((r) => r?.control_policy_id).filter(Boolean).map((x) => String(x).trim())),
  ]
  const planIds = [
    ...new Set(packageRows.map((r) => r?.price_plan_id).filter(Boolean).map((x) => String(x).trim())),
  ]

  const carrierById = new Map<string, any>()
  if (carrierIds.length) {
    const list = carrierIds.map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'carrier_service_modules',
      `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.carrier_service_id != null ? String((r as any).carrier_service_id).trim() : ''
      if (id) carrierById.set(id, r)
    }
  }

  const opPksCarrier = [
    ...new Set(
      [...carrierById.values()]
        .map((r: any) => (r?.operator_id != null ? String(r.operator_id).trim() : ''))
        .filter(Boolean)
    ),
  ]

  const ctById = new Map<string, any>()
  if (ctIds.length) {
    const list = ctIds.map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'commercial_terms_modules',
      `select=${COMMERCIAL_TERMS_MODULE_LIST_SELECT}&commercial_terms_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.commercial_terms_id != null ? String((r as any).commercial_terms_id).trim() : ''
      if (id) ctById.set(id, r)
    }
  }
  const cpById = new Map<string, any>()
  if (cpIds.length) {
    const list = cpIds.map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'control_policy_modules',
      `select=${CONTROL_POLICY_MODULE_LIST_SELECT}&control_policy_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.control_policy_id != null ? String((r as any).control_policy_id).trim() : ''
      if (id) cpById.set(id, r)
    }
  }

  const apnProfileIds: string[] = []
  const roamingProfileIds: string[] = []
  for (const row of packageRows) {
    const cid = row?.carrier_service_id ? String(row.carrier_service_id).trim() : ''
    const cs = cid ? carrierById.get(cid) : null
    if (cs) {
      const cfg = mergedCarrierServiceConfigShape(cs) as { apnProfileId?: string; roamingProfileId?: string }
      const ap = String(cfg.apnProfileId ?? '').trim()
      const rp = String(cfg.roamingProfileId ?? '').trim()
      if (ap) apnProfileIds.push(ap)
      if (rp) roamingProfileIds.push(rp)
    }
  }
  const apnById = new Map<string, any>()
  if (apnProfileIds.length) {
    const list = [...new Set(apnProfileIds)].map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select('apn_profiles', `select=${APN_PROFILE_LIST_SELECT}&apn_profile_id=in.(${list})`)
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.apn_profile_id != null ? String((r as any).apn_profile_id).trim() : ''
      if (id) apnById.set(id, r)
    }
  }
  const roamingById = new Map<string, any>()
  if (roamingProfileIds.length) {
    const list = [...new Set(roamingProfileIds)].map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'roaming_profiles',
      `select=${ROAMING_PROFILE_PACKAGE_LIST_SELECT}&roaming_profile_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.roaming_profile_id != null ? String((r as any).roaming_profile_id).trim() : ''
      if (id) roamingById.set(id, r)
    }
  }

  const pricePlanById = await batchMapPricePlanSnapshotsByIds(supabase, planIds)
  const coveredNetworkIds = new Set<string>()
  for (const pid of planIds) {
    const snap = pricePlanById.get(pid) as Record<string, unknown> | null | undefined
    const c = snap && snap.coveredNetworkProfileId != null ? String(snap.coveredNetworkProfileId).trim() : ''
    if (c) coveredNetworkIds.add(c)
  }
  const coveredById = new Map<string, any>()
  if (coveredNetworkIds.size) {
    const list = [...coveredNetworkIds].map((x) => encodeURIComponent(x)).join(',')
    const rows = await supabase.select(
      'covered_network_profiles',
      `select=${COVERED_PROFILE_LIST_SELECT}&covered_network_profile_id=in.(${list})`
    )
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = (r as any)?.covered_network_profile_id != null ? String((r as any).covered_network_profile_id).trim() : ''
      if (id) coveredById.set(id, r)
    }
  }

  const opPksApn = [...new Set([...apnById.values()].map((r: any) => String(r?.operator_id ?? '').trim()).filter(Boolean))]
  const opPksCv = [...new Set([...coveredById.values()].map((r: any) => String(r?.operator_id ?? '').trim()).filter(Boolean))]
  const opAll = [...new Set([...opPksCarrier, ...opPksApn, ...opPksCv])]
  const opDisplayByPk = opAll.length
    ? await businessOperatorDisplayIdsByOperatorRowIds(supabase, opAll)
    : new Map<string, string>()

  const entryMap = await batchFetchCoveredEntriesMap(supabase, [...coveredNetworkIds])

  return packageRows.map((pkg: any) => {
    const eid = String(pkg.enterprise_id || '')
    const carrierServiceId = pkg.carrier_service_id != null ? String(pkg.carrier_service_id).trim() : null
    const pricePlanId = pkg.price_plan_id != null ? String(pkg.price_plan_id).trim() : null
    const controlPolicyId = pkg.control_policy_id != null ? String(pkg.control_policy_id).trim() : null
    const commercialTermsId = pkg.commercial_terms_id != null ? String(pkg.commercial_terms_id).trim() : null

    const cs = carrierServiceId ? carrierById.get(carrierServiceId) : null
    const opPk = cs?.operator_id != null ? String(cs.operator_id).trim() : ''
    const displayOp = opPk ? opDisplayByPk.get(opPk) ?? opPk : null
    const resellerTid = cs?.reseller_id != null ? String(cs.reseller_id).trim() : ''
    const carrierService = cs
      ? (mapCarrierServiceModuleForPublicResponse(cs, displayOp, resellerTid || null) as Record<string, unknown>)
      : null

    const cfg = cs ? mergedCarrierServiceConfigShape(cs) : null
    const apnProfileId = cfg && String(cfg.apnProfileId ?? '').trim() ? String(cfg.apnProfileId).trim() : null
    const roamingProfileId = cfg && String(cfg.roamingProfileId ?? '').trim() ? String(cfg.roamingProfileId).trim() : null
    const apnRow = apnProfileId ? apnById.get(apnProfileId) : null
    const apnOpPk = apnRow?.operator_id != null ? String(apnRow.operator_id).trim() : ''
    const apnPub = apnOpPk ? opDisplayByPk.get(apnOpPk) ?? apnOpPk : null
    const apnProfile = apnRow ? mapApnProfileListItem(apnRow, apnPub) : null
    const rmRow = roamingProfileId ? roamingById.get(roamingProfileId) : null
    const roamingProfile = rmRow ? mapRoamingProfilePackageListSummary(rmRow) : null

    const ctRow = commercialTermsId ? ctById.get(commercialTermsId) : null
    const ctResellerTid = ctRow?.reseller_id != null ? String(ctRow.reseller_id).trim() : ''
    const commercialTerms = ctRow
      ? (mapCommercialTermsModuleForPublicResponse(ctRow, ctResellerTid || null) as Record<string, unknown>)
      : null

    const cpRow = controlPolicyId ? cpById.get(controlPolicyId) : null
    const cpResellerTid = cpRow?.reseller_id != null ? String(cpRow.reseller_id).trim() : ''
    const controlPolicy = cpRow
      ? (mapControlPolicyModuleForPublicResponse(cpRow, cpResellerTid || null) as Record<string, unknown>)
      : null

    const pricePlan = (pricePlanId && pricePlanById.get(pricePlanId)) || null
    const coveredId =
      pricePlan && (pricePlan as any).coveredNetworkProfileId != null
        ? String((pricePlan as any).coveredNetworkProfileId).trim()
        : ''
    const cRow = coveredId ? coveredById.get(coveredId) : null
    const cOpPk = cRow?.operator_id != null ? String(cRow.operator_id).trim() : ''
    const cPub = cOpPk ? opDisplayByPk.get(cOpPk) ?? cOpPk : null
    const coveredNetworkProfile = cRow
      ? mapCoveredNetworkProfileListItem(cRow, entryMap.get(coveredId) ?? [], cPub)
      : null

    // Key order is stable (JSON object insertion order) for client readability.
    const moduleRef = {
      carrierServiceId,
      apnProfileId,
      roamingProfileId,
      controlPolicyId,
      commercialTermsId,
      pricePlanId,
      coveredNetworkProfileId: coveredId || null,
    }

    return {
      packageId: pkg.package_id,
      enterpriseId: eid || null,
      resellerId: eid ? parentMap.get(eid) ?? null : null,
      name: pkg.name,
      description: pkg.description != null ? String(pkg.description) : null,
      status: pkg.status ?? 'DRAFT',
      effectiveFrom: pkg.effective_from ?? null,
      publishedAt: pkg.published_at ?? null,
      deprecatedAt: pkg.deprecated_at ?? null,
      createdAt: pkg.created_at,
      updatedAt: pkg.updated_at ?? null,
      moduleRef,
      carrierService,
      apnProfile,
      roamingProfile,
      commercialTerms,
      controlPolicy,
      pricePlan,
      coveredNetworkProfile,
    }
  })
}

/**
 * @param mode.all — all rows (platform only)
 * @param mode.enterpriseId — filter by one enterprise
 * @param mode.resellerTenantId — packages for enterprises with tenants.parent_id = reseller RESELLER id
 */
export async function listPackagesByScope({
  supabase,
  mode,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  mode: { type: 'all' } | { type: 'enterprise'; enterpriseId: string } | { type: 'resellerTree'; resellerTenantId: string }
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number; page: number; pageSize: number }>> {
  const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 200 })
  const filters: string[] = []
  if (status) {
    const st = String(status).toUpperCase()
    if (!['DRAFT', 'PUBLISHED', 'DEPRECATED'].includes(st)) {
      return toError(400, 'BAD_REQUEST', 'status must be DRAFT, PUBLISHED, or DEPRECATED.')
    }
    filters.push(`status=eq.${encodeURIComponent(st)}`)
  }
  if (mode.type === 'enterprise') {
    if (!isValidUuid(mode.enterpriseId)) {
      return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
    }
    filters.push(`enterprise_id=eq.${encodeURIComponent(mode.enterpriseId)}`)
  } else if (mode.type === 'resellerTree') {
    const r = String(mode.resellerTenantId || '').trim()
    if (!isValidUuid(r)) return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
    const children = await supabase.select(
      'tenants',
      `select=tenant_id&parent_id=eq.${encodeURIComponent(r)}&tenant_type=eq.ENTERPRISE`
    )
    const eids = (Array.isArray(children) ? children : [])
      .map((x: any) => (x.tenant_id ? String(x.tenant_id) : ''))
      .filter((x) => isValidUuid(x))
    if (!eids.length) {
      return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) }
    }
    const inE = eids.map((e) => encodeURIComponent(e)).join(',')
    filters.push(`enterprise_id=in.(${inE})`)
  } else {
    // all
  }
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  if (!supabase.selectWithCount) {
    return toError(500, 'INTERNAL_ERROR', 'selectWithCount is not available on Supabase client.')
  }
  const { data, total: t } = await supabase.selectWithCount(
    'packages',
    `select=${PACKAGE_ROW_SELECT}&order=created_at.desc&limit=${encodeURIComponent(String(pagination.pageSize))}&offset=${encodeURIComponent(String(pagination.offset))}${filterQs}`
  )
  const rows = Array.isArray(data) ? data : []
  const total = typeof t === 'number' ? t : rows.length
  const items = await mapPackageListRowsToItems(supabase, rows)
  return { ok: true, value: buildPaginationResponse(items, total, pagination.page, pagination.pageSize) }
}

export async function listPackages({
  supabase,
  enterpriseId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number; page: number; pageSize: number }>> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  }
  return listPackagesByScope({
    supabase,
    mode: { type: 'enterprise', enterpriseId },
    status,
    page,
    pageSize,
  })
}

/**
 * For `GET /packages`: each provided id must exist and match `enterpriseId` and its reseller parent (status may be DRAFT
 * so reverse lookup can resolve packages that still point at unpublished module rows).
 */
async function validatePackageListModuleRefQuery(
  supabase: SupabaseClient,
  enterpriseId: string,
  refs: {
    pricePlanId: string | null
    carrierServiceId: string | null
    commercialTermsId: string | null
    controlPolicyId: string | null
  }
): Promise<ServiceResult<null>> {
  const scope = await resolveResellerTenantIdForPackageModules(supabase, enterpriseId, null)
  if (!scope.ok) return scope
  const resellerTenantId = scope.value
  if (refs.pricePlanId) {
    const prRows = await supabase.select(
      'price_plans',
      `select=price_plan_id,enterprise_id,reseller_id&price_plan_id=eq.${encodeURIComponent(refs.pricePlanId)}&limit=1`
    )
    const pr = Array.isArray(prRows) ? prRows[0] : null
    if (!pr || !(pr as any).price_plan_id) {
      return toError(404, 'NOT_FOUND', 'Price plan not found.')
    }
    if (String((pr as any).enterprise_id ?? '') !== String(enterpriseId)) {
      return toError(400, 'BAD_REQUEST', 'pricePlanId does not belong to this enterprise.')
    }
    if (String((pr as any).reseller_id ?? '') !== String(resellerTenantId)) {
      return toError(400, 'BAD_REQUEST', 'pricePlanId does not belong to the package reseller.')
    }
  }
  if (refs.carrierServiceId) {
    const rows = await supabase.select(
      'carrier_service_modules',
      `select=${CARRIER_SERVICE_MODULE_ROW_SELECT}&carrier_service_id=eq.${encodeURIComponent(refs.carrierServiceId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!(row as any)?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
    const rs = assertModuleResellerRow((row as any).reseller_id, resellerTenantId, 'carrierServiceId')
    if (!rs.ok) return rs
  }
  if (refs.controlPolicyId) {
    const rows = await supabase.select(
      'control_policy_modules',
      `select=control_policy_id,reseller_id,control_policy,status&control_policy_id=eq.${encodeURIComponent(refs.controlPolicyId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!(row as any)?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
    const rs = assertModuleResellerRow((row as any).reseller_id, resellerTenantId, 'controlPolicyId')
    if (!rs.ok) return rs
  }
  if (refs.commercialTermsId) {
    const rows = await supabase.select(
      'commercial_terms_modules',
      `select=commercial_terms_id,reseller_id,commercial_terms,status&commercial_terms_id=eq.${encodeURIComponent(refs.commercialTermsId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!(row as any)?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
    const rs = assertModuleResellerRow((row as any).reseller_id, resellerTenantId, 'commercialTermsId')
    if (!rs.ok) return rs
  }
  return { ok: true, value: null }
}

export async function listPackagesByModuleRefs({
  supabase,
  pricePlanId,
  carrierServiceId,
  commercialTermsId,
  controlPolicyId,
  enterpriseId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  pricePlanId?: string | null
  carrierServiceId?: string | null
  commercialTermsId?: string | null
  controlPolicyId?: string | null
  enterpriseId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number }>> {
  const pricePlanIdValue = pricePlanId ? String(pricePlanId).trim() : null
  const carrierServiceIdValue = carrierServiceId ? String(carrierServiceId).trim() : null
  const commercialTermsIdValue = commercialTermsId ? String(commercialTermsId).trim() : null
  const controlPolicyIdValue = controlPolicyId ? String(controlPolicyId).trim() : null
  if (!pricePlanIdValue && !carrierServiceIdValue && !commercialTermsIdValue && !controlPolicyIdValue) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId, carrierServiceId, commercialTermsId, or controlPolicyId is required.')
  }
  if (pricePlanIdValue && !isValidUuid(pricePlanIdValue)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId is invalid.')
  }
  if (carrierServiceIdValue && !isValidUuid(carrierServiceIdValue)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceId is invalid.')
  }
  if (commercialTermsIdValue && !isValidUuid(commercialTermsIdValue)) {
    return toError(400, 'BAD_REQUEST', 'commercialTermsId is invalid.')
  }
  if (controlPolicyIdValue && !isValidUuid(controlPolicyIdValue)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicyId is invalid.')
  }
  if (enterpriseId && !isValidUuid(String(enterpriseId).trim())) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  }
  const hasAnyRef = !!(
    pricePlanIdValue ||
    carrierServiceIdValue ||
    commercialTermsIdValue ||
    controlPolicyIdValue
  )
  const enterpriseIdNorm = enterpriseId && String(enterpriseId).trim() ? String(enterpriseId).trim() : null
  if (hasAnyRef && !enterpriseIdNorm) {
    return toError(
      400,
      'BAD_REQUEST',
      'enterpriseId is required when filtering by pricePlanId, carrierServiceId, commercialTermsId, or controlPolicyId.'
    )
  }
  if (hasAnyRef && enterpriseIdNorm) {
    const v = await validatePackageListModuleRefQuery(supabase, enterpriseIdNorm, {
      pricePlanId: pricePlanIdValue,
      carrierServiceId: carrierServiceIdValue,
      commercialTermsId: commercialTermsIdValue,
      controlPolicyId: controlPolicyIdValue,
    })
    if (!v.ok) return v
  }
  const packageFilters = [`select=${PACKAGE_ROW_SELECT}`]
  if (enterpriseIdNorm) packageFilters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseIdNorm)}`)
  if (pricePlanIdValue) packageFilters.push(`price_plan_id=eq.${encodeURIComponent(pricePlanIdValue)}`)
  if (carrierServiceIdValue) packageFilters.push(`carrier_service_id=eq.${encodeURIComponent(carrierServiceIdValue)}`)
  if (commercialTermsIdValue) packageFilters.push(`commercial_terms_id=eq.${encodeURIComponent(commercialTermsIdValue)}`)
  if (controlPolicyIdValue) packageFilters.push(`control_policy_id=eq.${encodeURIComponent(controlPolicyIdValue)}`)
  packageFilters.push('order=created_at.desc')
  const packageRows = await supabase.select('packages', packageFilters.join('&'))
  const packages = Array.isArray(packageRows) ? packageRows : []
  const mapped = await mapPackageListRowsToItems(supabase, packages)
  let items: unknown[] = mapped
  if (status) items = items.filter((item: any) => String((item as any)?.status ?? '') === String(status))
  const p = Number(page) || 1
  const ps = Number(pageSize) || 20
  const start = (p - 1) * ps
  const total = items.length
  items = items.slice(start, start + ps)
  return { ok: true, value: { items, total } }
}

export async function getPackageDetail({ supabase, packageId }: { supabase: SupabaseClient; packageId: string }) {
  if (!isValidUuid(packageId)) {
    return toError(400, 'BAD_REQUEST', 'packageId is invalid.')
  }
  const pkg = await loadPackageRow(supabase, packageId)
  if (!pkg) return toError(404, 'NOT_FOUND', 'Package not found.')
  const [value] = await mapPackageListRowsToItems(supabase, [pkg])
  if (!value) return toError(404, 'NOT_FOUND', 'Package not found.')
  return { ok: true, value }
}
