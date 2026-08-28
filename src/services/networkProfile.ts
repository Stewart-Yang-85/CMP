import { buildPaginationResponse, parsePagination } from '../utils/pagination.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'
import { serializeRoamingProfileRatesCsv } from './simImportCsv.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
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

function carrierModuleApnProfileId(mod: any): string {
  if (mod?.apn_profile_id != null && String(mod.apn_profile_id).trim() !== '') {
    return String(mod.apn_profile_id).trim()
  }
  return ''
}

function carrierModuleRoamingProfileId(mod: any): string {
  if (mod?.roaming_profile_id != null && String(mod.roaming_profile_id).trim() !== '') {
    return String(mod.roaming_profile_id).trim()
  }
  return ''
}

/** In-memory scan: Carrier Service rows + `packages` referencing an APN snapshot. */
async function collectApnProfileUsage(supabase: SupabaseClient, apnProfileId: string) {
  const csRows = (await supabase.select(
    'carrier_service_modules',
    'select=carrier_service_id,apn_profile_id,roaming_profile_id,status'
  )) as unknown[]
  const carrierServiceIds: string[] = []
  const csList = Array.isArray(csRows) ? csRows : []
  for (const r of csList as any[]) {
    const st = String(r?.status ?? '').toUpperCase()
    if (st === 'DEPRECATED') continue
    const id = carrierModuleApnProfileId(r)
    if (id === apnProfileId) carrierServiceIds.push(String(r.carrier_service_id))
  }
  const carrierSet = new Set(carrierServiceIds)
  const pvRows = (await supabase.select('packages', 'select=package_id,carrier_service_id')) as unknown[]
  const packageIdSet = new Set<string>()
  const pvList = Array.isArray(pvRows) ? pvRows : []
  for (const pv of pvList as any[]) {
    const pkgId = String(pv?.package_id ?? '').trim()
    if (!pkgId) continue
    const cid = String(pv?.carrier_service_id ?? '').trim()
    if (cid && carrierSet.has(cid)) packageIdSet.add(pkgId)
    if (cid) {
      const mod = csList.find((c: any) => String((c as any).carrier_service_id) === cid) as any
      if (mod) {
        const st = String(mod?.status ?? '').toUpperCase()
        if (st !== 'DEPRECATED') {
          const id2 = carrierModuleApnProfileId(mod)
          if (id2 === apnProfileId) packageIdSet.add(pkgId)
        }
      }
    }
  }
  return { carrierServiceIds, packageIds: [...packageIdSet] }
}

/**
 * In-memory scan: `carrier_service_modules` + `packages` only (Phase 30 OOP: Carrier `roamingProfileId`
 * and package snapshot / `carrier_service_id` link). Roaming deprecate does not consult `price_plans`.
 */
async function collectRoamingProfileUsage(supabase: SupabaseClient, roamingProfileId: string) {
  const csRows = (await supabase.select(
    'carrier_service_modules',
    'select=carrier_service_id,apn_profile_id,roaming_profile_id,status'
  )) as unknown[]
  const carrierServiceIds: string[] = []
  const csList = Array.isArray(csRows) ? csRows : []
  for (const r of csList as any[]) {
    const st = String(r?.status ?? '').toUpperCase()
    if (st === 'DEPRECATED') continue
    const id = carrierModuleRoamingProfileId(r)
    if (id === roamingProfileId) carrierServiceIds.push(String(r.carrier_service_id))
  }
  const carrierSet = new Set(carrierServiceIds)
  const pvRows = (await supabase.select('packages', 'select=package_id,carrier_service_id')) as unknown[]
  const packageIdSet = new Set<string>()
  const pvList = Array.isArray(pvRows) ? pvRows : []
  for (const pv of pvList as any[]) {
    const pkgId = String(pv?.package_id ?? '').trim()
    if (!pkgId) continue
    const cid = String(pv?.carrier_service_id ?? '').trim()
    if (cid && carrierSet.has(cid)) packageIdSet.add(pkgId)
    if (cid) {
      const mod = csList.find((c: any) => String((c as any).carrier_service_id) === cid) as any
      if (mod) {
        const st = String(mod?.status ?? '').toUpperCase()
        if (st !== 'DEPRECATED') {
          const id2 = carrierModuleRoamingProfileId(mod)
          if (id2 === roamingProfileId) packageIdSet.add(pkgId)
        }
      }
    }
  }
  return { carrierServiceIds, packageIds: [...packageIdSet] }
}

function firstDayNextMonthUtc() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0))
}

function normalizeMccMnc(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^\d{3}-\*$/.test(raw)) return raw
  const exact = raw.match(/^(\d{3})-?(\d{2,3})$/)
  if (!exact) return null
  return `${exact[1]}-${exact[2]}`
}

const ROAMING_ENTRY_COUNTRY_MAX_LEN = 128
const ROAMING_ENTRY_NETWORK_MAX_LEN = 256

type RoamingRateEntry = {
  mcc: string
  mnc: string
  ratePerMb: number
  country?: string
  network?: string
}

function optionalRoamingDisplayField(
  raw: unknown,
  field: 'country' | 'network',
  maxLen: number
): { ok: true; value?: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  const value = String(raw).trim()
  if (value.length > maxLen) {
    return { ok: false, message: `${field} must be at most ${maxLen} characters.` }
  }
  return { ok: true, value }
}

function normalizeRoamingEntry(raw: any) {
  if (!raw || typeof raw !== 'object') return { ok: false as const, message: 'mccmncList entry must be an object.' }
  const mcc = String(raw.mcc ?? '').trim()
  const mnc = String(raw.mnc ?? '').trim()
  const rateInput = raw.ratePerMb
  const normalized = normalizeMccMnc(`${mcc}-${mnc}`)
  if (!normalized) return { ok: false as const, message: `Invalid mcc/mnc value: ${mcc}-${mnc}` }
  if (rateInput === undefined || rateInput === null || String(rateInput).trim() === '') {
    return { ok: false as const, message: `ratePerMb is required for ${mcc}-${mnc}` }
  }
  const rateValue = Number(rateInput)
  if (!Number.isFinite(rateValue) || rateValue < 0) {
    return { ok: false as const, message: `ratePerMb must be a non-negative number for ${mcc}-${mnc}` }
  }
  const countryParsed = optionalRoamingDisplayField(raw.country, 'country', ROAMING_ENTRY_COUNTRY_MAX_LEN)
  if (!countryParsed.ok) return { ok: false as const, message: countryParsed.message }
  const networkParsed = optionalRoamingDisplayField(raw.network, 'network', ROAMING_ENTRY_NETWORK_MAX_LEN)
  if (!networkParsed.ok) return { ok: false as const, message: networkParsed.message }
  const [normalizedMcc, normalizedMnc] = normalized.split('-')
  const value: RoamingRateEntry = { mcc: normalizedMcc, mnc: normalizedMnc, ratePerMb: rateValue }
  if (countryParsed.value !== undefined) value.country = countryParsed.value
  if (networkParsed.value !== undefined) value.network = networkParsed.value
  return { ok: true as const, value }
}

function normalizeRoamingEntryList(list: unknown) {
  const entries = Array.isArray(list) ? list : []
  const normalized: RoamingRateEntry[] = []
  for (const raw of entries) {
    const parsed = normalizeRoamingEntry(raw)
    if (!parsed.ok) return parsed
    normalized.push(parsed.value)
  }
  return { ok: true as const, value: normalized }
}

type CoveredCoverageEntry = { mcc: string; mnc: string }
type CoverageMode = 'LIST' | 'NONE'

function normalizeCoverageMode(raw: unknown): CoverageMode {
  const value = String(raw ?? 'LIST').trim().toUpperCase()
  return value === 'NONE' ? 'NONE' : 'LIST'
}

function normalizeCoveredEntry(raw: any) {
  if (!raw || typeof raw !== 'object') return { ok: false as const, message: 'coverage entry is invalid.' }
  const mcc = String(raw.mcc ?? '').trim()
  const mnc = String(raw.mnc ?? '').trim()
  const normalized = normalizeMccMnc(`${mcc}-${mnc}`)
  if (!normalized) return { ok: false as const, message: `coverage entry is invalid: ${mcc}-${mnc}` }
  const [normalizedMcc, normalizedMnc] = normalized.split('-')
  return { ok: true as const, value: { mcc: normalizedMcc, mnc: normalizedMnc } }
}

function validateCoveredCoverageList(list: unknown) {
  const entries = Array.isArray(list) ? list : []
  if (!entries.length) return { ok: false as const, message: 'coverage is required.' }
  const normalized: CoveredCoverageEntry[] = []
  const seen = new Set<string>()
  const mccStarCount = new Map<string, number>()
  for (const raw of entries) {
    const parsed = normalizeCoveredEntry(raw)
    if (!parsed.ok) return parsed
    const key = `${parsed.value.mcc}\0${parsed.value.mnc}`
    if (seen.has(key)) {
      return { ok: false as const, message: `Duplicate mcc/mnc combination: ${parsed.value.mcc}-${parsed.value.mnc}` }
    }
    seen.add(key)
    if (parsed.value.mnc === '*') {
      const c = (mccStarCount.get(parsed.value.mcc) ?? 0) + 1
      mccStarCount.set(parsed.value.mcc, c)
      if (c > 1) return { ok: false as const, message: `Duplicate mcc-* wildcard for mcc ${parsed.value.mcc}` }
    }
    normalized.push(parsed.value)
  }
  return { ok: true as const, value: normalized }
}

function validateCoverageForMode(mode: CoverageMode, list: unknown) {
  const entries = Array.isArray(list) ? list : []
  if (mode === 'NONE') {
    if (entries.length) {
      return { ok: false as const, message: 'coverage must be empty when coverageMode is NONE.' }
    }
    return { ok: true as const, value: [] as CoveredCoverageEntry[] }
  }
  return validateCoveredCoverageList(list)
}

async function fetchCoveredEntriesMap(supabase: SupabaseClient, profileIds: string[]) {
  const map = new Map<string, CoveredCoverageEntry[]>()
  if (!profileIds.length) return map
  const values = profileIds.map((id) => encodeURIComponent(id)).join(',')
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

async function collectPricePlansReferencingCoveredProfile(supabase: SupabaseClient, coveredNetworkProfileId: string) {
  const rows = await supabase.select(
    'price_plans',
    `select=price_plan_id&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`
  )
  const list = Array.isArray(rows) ? rows : []
  return list.map((r: any) => String(r.price_plan_id ?? '').trim()).filter(Boolean)
}

async function resolveResellerTenantId(supabase: SupabaseClient, resellerId: string | null) {
  if (!resellerId || !isValidUuid(resellerId)) return null
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return (row as any)?.tenant_id ? String((row as any).tenant_id) : null
}

async function loadOperatorByOperatorId(supabase: SupabaseClient, operatorId: string, supplierId?: string | null) {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const rows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id,name,status,business_operator_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadOperatorByBusinessOperatorId(supabase: SupabaseClient, businessOperatorId: string, supplierId?: string | null) {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const rows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id,name,status,business_operator_id&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}${supplierFilter}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

/** All supplier-bound operator rows for a business_operator_id (same catalog id may exist under multiple suppliers). */
async function loadAllOperatorIdsByBusinessOperatorId(
  supabase: SupabaseClient,
  businessOperatorId: string,
  supplierId?: string | null
): Promise<string[]> {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const rows = await supabase.select(
    'operators',
    `select=operator_id&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}${supplierFilter}`
  )
  const list = Array.isArray(rows) ? rows : []
  return list.map((r: any) => String((r as any)?.operator_id ?? '').trim()).filter(Boolean)
}

async function loadOperator(supabase: SupabaseClient, operatorId: string, supplierId?: string | null) {
  const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId)
  if (byOperatorId) return byOperatorId
  return loadOperatorByBusinessOperatorId(supabase, operatorId, supplierId)
}

async function resolveBoundOperatorIds(supabase: SupabaseClient, operatorId: string, supplierId?: string | null) {
  const ids = new Set<string>()
  const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId)
  if ((byOperatorId as any)?.operator_id) ids.add(String((byOperatorId as any).operator_id))
  for (const id of await loadAllOperatorIdsByBusinessOperatorId(supabase, operatorId, supplierId)) {
    if (id) ids.add(id)
  }
  return Array.from(ids)
}

async function mapPublicOperatorIdByBoundOperatorIds(supabase: SupabaseClient, operatorIds: string[]) {
  const map = new Map<string, string>()
  const normalized = operatorIds.map((id) => String(id || '').trim()).filter(Boolean)
  if (!normalized.length) return map
  const uniqueIds = Array.from(new Set(normalized))
  const values = uniqueIds.map((id) => encodeURIComponent(id)).join(',')
  const rows = await supabase.select(
    'operators',
    `select=operator_id,business_operator_id&operator_id=in.(${values})`
  )
  const byOperatorId = new Map<string, any>()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String((row as any)?.operator_id ?? '').trim()
    if (!id) continue
    byOperatorId.set(id, row)
  }
  for (const id of uniqueIds) {
    const row = byOperatorId.get(id)
    const businessOperatorId = String((row as any)?.business_operator_id ?? '').trim()
    map.set(id, businessOperatorId || id)
  }
  return map
}

async function backfillApnProfilesFromSims(supabase: SupabaseClient, supplierId: string) {
  const simRows = await supabase.select(
    'sims',
    `select=apn,operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}`
  )
  const sims = Array.isArray(simRows) ? simRows : []
  const existingRows = await supabase.select(
    'apn_profiles',
    `select=apn,operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}`
  )
  const existing = new Set<string>()
  if (Array.isArray(existingRows)) {
    for (const row of existingRows as Array<Record<string, any>>) {
      const apn = String(row.apn ?? '').trim()
      const op = String(row.operator_id ?? '').trim()
      if (!apn || !op) continue
      existing.add(`${apn}::${op}`)
    }
  }
  for (const sim of sims as Array<Record<string, any>>) {
    const apn = String(sim.apn ?? '').trim()
    const operatorId = String(sim.operator_id ?? '').trim()
    if (!apn || !operatorId) continue
    const key = `${apn}::${operatorId}`
    if (existing.has(key)) continue
    const nowIso = new Date().toISOString()
    const profileRows = await supabase.insert(
      'apn_profiles',
      {
        name: `${apn}-${operatorId.slice(0, 8)}`,
        apn,
        auth_type: 'NONE',
        username: null,
        password_ref: null,
        supplier_id: supplierId,
        operator_id: operatorId,
        status: 'PUBLISHED',
        published_at: nowIso,
        effective_from: nowIso,
      },
      { returning: 'representation' }
    )
    const profile = Array.isArray(profileRows) ? profileRows[0] : null
    if ((profile as any)?.apn_profile_id) {
      // SIM-derived APN rows are treated as already-published operational snapshots.
    }
    existing.add(key)
  }
}

async function loadProfile(supabase: SupabaseClient, table: string, idField: string, idValue: string) {
  const rows = await supabase.select(
    table,
    `select=*&${idField}=eq.${encodeURIComponent(idValue)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

export async function rollbackProfileVersion({
  supabase,
  profileVersionId,
  audit,
}: {
  supabase: SupabaseClient
  profileVersionId: string
  audit?: AuditContext
}): Promise<ServiceResult<{ profileId: string; profileVersionId: string; status: string }>> {
  if (!isValidUuid(profileVersionId)) {
    return toError(400, 'BAD_REQUEST', 'profileVersionId is invalid.')
  }
  const rows = await supabase.select(
    'profile_versions',
    `select=profile_version_id,profile_type,profile_id,status,effective_from,version&profile_version_id=eq.${encodeURIComponent(profileVersionId)}&limit=1`
  )
  const version = Array.isArray(rows) ? rows[0] : null
  if (!version) return toError(404, 'NOT_FOUND', 'Profile version not found.')
  if ((version as any).status !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED version can be rolled back.')
  }
  const effective = (version as any).effective_from ? new Date((version as any).effective_from).getTime() : null
  if (!effective || effective <= Date.now()) {
    return toError(409, 'INVALID_STATUS', 'Only scheduled (future) version can be rolled back.')
  }
  await supabase.update(
    'profile_versions',
    `profile_version_id=eq.${encodeURIComponent(profileVersionId)}`,
    { status: 'DRAFT', effective_from: null, effective_to: null },
    { returning: 'minimal' }
  )
  await supabase.update(
    'profile_change_requests',
    `profile_version_id=eq.${encodeURIComponent(profileVersionId)}&status=eq.SCHEDULED`,
    { status: 'CANCELLED', cancelled_at: new Date().toISOString() },
    { returning: 'minimal' }
  )
  const previousRows = await supabase.select(
    'profile_versions',
    `select=profile_version_id,effective_to&profile_type=eq.${encodeURIComponent(String((version as any).profile_type))}&profile_id=eq.${encodeURIComponent(String((version as any).profile_id))}&status=eq.PUBLISHED&version=lt.${encodeURIComponent(String((version as any).version))}&order=version.desc&limit=1`
  )
  const previous = Array.isArray(previousRows) ? previousRows[0] : null
  if ((previous as any)?.profile_version_id) {
    await supabase.update(
      'profile_versions',
      `profile_version_id=eq.${encodeURIComponent(String((previous as any).profile_version_id))}`,
      { effective_to: null },
      { returning: 'minimal' }
    )
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'PROFILE_VERSION_ROLLBACK',
    target_type: 'PROFILE_VERSION',
    target_id: profileVersionId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: {
      profileType: (version as any).profile_type,
      profileId: (version as any).profile_id,
      version: (version as any).version,
      status: (version as any).status,
      effectiveFrom: (version as any).effective_from,
    },
    after_data: { status: 'CANCELLED' },
  })
  return { ok: true, value: { profileId: String((version as any).profile_id), profileVersionId, status: 'CANCELLED' } }
}

export async function createApnProfile({
  supabase,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<{ apnProfileId: string; status: string; createdAt: string }>> {
  const name = String(payload?.name || '').trim()
  const apn = String(payload?.apn || '').trim()
  const authType = payload?.authType ? String(payload.authType) : 'NONE'
  const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null
  const operatorId = payload?.operatorId ? String(payload.operatorId).trim() : null
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!apn) return toError(400, 'BAD_REQUEST', 'apn is required.')
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId is invalid.')
  }
  if (!operatorId) {
    return toError(400, 'BAD_REQUEST', 'operatorId is required.')
  }
  if (!isValidUuid(operatorId)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is invalid.')
  }
  const operator = await loadOperator(supabase, operatorId, supplierId)
  if (!operator) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not found.')
  }
  if (String((operator as any)?.supplier_id ?? '') !== String(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.')
  }
  const resolvedOperatorId = String((operator as any)?.operator_id ?? operatorId)
  const rows = await supabase.insert(
    'apn_profiles',
    {
      name,
      apn,
      auth_type: authType,
      username: payload?.username ? String(payload.username) : null,
      password_ref: payload?.passwordRef ? String(payload.passwordRef) : null,
      supplier_id: supplierId,
      operator_id: resolvedOperatorId,
      status: 'DRAFT',
    },
    { returning: 'representation' }
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  if (!(profile as any)?.apn_profile_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create APN profile.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'APN_PROFILE_CREATED',
    target_type: 'APN_PROFILE',
    target_id: (profile as any).apn_profile_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      apnProfileId: (profile as any).apn_profile_id,
      status: 'DRAFT',
      name,
      apn,
      authType,
      supplierId,
      operatorId: resolvedOperatorId,
    },
  })
  const id = String((profile as any).apn_profile_id)
  return {
    ok: true,
    value: {
      apnProfileId: id,
      status: 'DRAFT',
      createdAt: (profile as any).created_at,
    },
  }
}

export async function createRoamingProfile({
  supabase,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<{ roamingProfileId: string; status: string; createdAt: string }>> {
  const name = String(payload?.name || '').trim()
  const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null
  let operatorId: string | null = null
  if (payload?.operatorId !== undefined && payload?.operatorId !== null) {
    operatorId = String(payload.operatorId).trim() || null
  } else if (payload?.carrierId !== undefined && payload?.carrierId !== null) {
    operatorId = String(payload.carrierId).trim() || null
  }
  const list = Array.isArray(payload?.mccmncList) ? payload.mccmncList : []
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId is invalid.')
  }
  if (!operatorId) {
    return toError(400, 'BAD_REQUEST', 'operatorId is required.')
  }
  if (!isValidUuid(operatorId)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is invalid.')
  }
  if (!list.length) return toError(400, 'BAD_REQUEST', 'mccmncList is required.')
  const normalized = normalizeRoamingEntryList(list)
  if (!normalized.ok) return toError(400, 'BAD_REQUEST', normalized.message)
  const operator = await loadOperator(supabase, operatorId, supplierId)
  if (!operator) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not found.')
  }
  if (String((operator as any)?.supplier_id ?? '') !== String(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.')
  }
  const resolvedOperatorId = String((operator as any)?.operator_id ?? operatorId)
  const normalizedList = normalized.value
  const rows = await supabase.insert(
    'roaming_profiles',
    {
      name,
      mccmnc_list: normalizedList,
      supplier_id: supplierId,
      operator_id: resolvedOperatorId,
      status: 'DRAFT',
    },
    { returning: 'representation' }
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  if (!(profile as any)?.roaming_profile_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create roaming profile.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'ROAMING_PROFILE_CREATED',
    target_type: 'ROAMING_PROFILE',
    target_id: (profile as any).roaming_profile_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      roamingProfileId: (profile as any).roaming_profile_id,
      status: 'DRAFT',
      name,
      supplierId,
      operatorId: resolvedOperatorId,
      carrierId: resolvedOperatorId,
      mccmncList: normalizedList,
    },
  })
  return {
    ok: true,
    value: {
      roamingProfileId: String((profile as any).roaming_profile_id),
      status: 'DRAFT',
      createdAt: (profile as any).created_at,
    },
  }
}

export async function listApnProfiles({
  supabase,
  supplierId,
  supplierIds,
  operatorId,
  apnProfileId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  supplierId?: string | null
  supplierIds?: string[] | null
  operatorId?: string | null
  apnProfileId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number; page: number; pageSize: number }>> {
  const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 20 })
  const filters = []
  const supplierIdValue = supplierId ? String(supplierId) : null
  const hasSupplierIdsInput = Array.isArray(supplierIds)
  const supplierIdValues = supplierIdValue
    ? []
    : Array.from(new Set((hasSupplierIdsInput ? supplierIds : []).map((id) => String(id).trim()).filter(Boolean)))
  const operatorIdValue = operatorId ? String(operatorId) : null
  const apnProfileIdValue = apnProfileId ? String(apnProfileId).trim() : null
  if (apnProfileIdValue && !isValidUuid(apnProfileIdValue)) {
    return toError(400, 'BAD_REQUEST', 'apnProfileId is invalid.')
  }
  if (supplierIdValues.some((id) => !isValidUuid(id))) {
    return toError(400, 'BAD_REQUEST', 'supplierIds contains invalid uuid.')
  }
  if (!supplierIdValue && hasSupplierIdsInput && !supplierIdValues.length) {
    return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) }
  }
  if (apnProfileIdValue) {
    filters.push(`apn_profile_id=eq.${encodeURIComponent(apnProfileIdValue)}`)
  }
  if (supplierIdValue) {
    await backfillApnProfilesFromSims(supabase, supplierIdValue)
    filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
  } else if (supplierIdValues.length) {
    for (const id of supplierIdValues) {
      await backfillApnProfilesFromSims(supabase, id)
    }
    filters.push(`supplier_id=in.(${supplierIdValues.map((id) => encodeURIComponent(id)).join(',')})`)
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
  if (status) filters.push(`status=eq.${encodeURIComponent(String(status))}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const rows = await supabase.select(
    'apn_profiles',
    `select=apn_profile_id,name,apn,auth_type,username,password_ref,supplier_id,operator_id,status,published_at,effective_from,deprecated_at,source_apn_profile_id,created_at,updated_at&order=created_at.desc${filterQs}`
  )
  const profiles = Array.isArray(rows) ? rows : []
  const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(
    supabase,
    profiles.map((p: any) => String(p.operator_id ?? '').trim()).filter(Boolean)
  )
  let items = profiles.map((p: any) => ({
    apnProfileId: p.apn_profile_id,
    name: p.name,
    apn: p.apn,
    authType: p.auth_type,
    supplierId: p.supplier_id,
    operatorId: operatorIdMap.get(String(p.operator_id ?? '').trim()) ?? p.operator_id ?? null,
    status: p.status,
    publishedAt: p.published_at ?? null,
    effectiveFrom: p.effective_from ?? null,
    deprecatedAt: p.deprecated_at ?? null,
    sourceApnProfileId: p.source_apn_profile_id ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }))
  const total = items.length
  const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize)
  return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) }
}

export async function listRoamingProfiles({
  supabase,
  supplierId,
  supplierIds,
  operatorId,
  roamingProfileId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  supplierId?: string | null
  supplierIds?: string[] | null
  operatorId?: string | null
  roamingProfileId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number; page: number; pageSize: number }>> {
  const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 20 })
  const filters = []
  const supplierIdValue = supplierId ? String(supplierId) : null
  const hasSupplierIdsInput = Array.isArray(supplierIds)
  const supplierIdValues = supplierIdValue
    ? []
    : Array.from(new Set((hasSupplierIdsInput ? supplierIds : []).map((id) => String(id).trim()).filter(Boolean)))
  const operatorIdValue = operatorId ? String(operatorId) : null
  const roamingProfileIdValue = roamingProfileId ? String(roamingProfileId).trim() : null
  if (roamingProfileIdValue && !isValidUuid(roamingProfileIdValue)) {
    return toError(400, 'BAD_REQUEST', 'roamingProfileId is invalid.')
  }
  if (supplierIdValues.some((id) => !isValidUuid(id))) {
    return toError(400, 'BAD_REQUEST', 'supplierIds contains invalid uuid.')
  }
  if (!supplierIdValue && hasSupplierIdsInput && !supplierIdValues.length) {
    return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) }
  }
  if (roamingProfileIdValue) {
    filters.push(`roaming_profile_id=eq.${encodeURIComponent(roamingProfileIdValue)}`)
  }
  if (supplierIdValue) filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
  else if (supplierIdValues.length) filters.push(`supplier_id=in.(${supplierIdValues.map((id) => encodeURIComponent(id)).join(',')})`)
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
  if (status) filters.push(`status=eq.${encodeURIComponent(String(status))}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const rows = await supabase.select(
    'roaming_profiles',
    `select=roaming_profile_id,name,mccmnc_list,supplier_id,operator_id,status,published_at,effective_from,deprecated_at,source_roaming_profile_id,created_at,updated_at&order=created_at.desc${filterQs}`
  )
  const profiles = Array.isArray(rows) ? rows : []
  const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(
    supabase,
    profiles.map((p: any) => String(p.operator_id ?? '').trim()).filter(Boolean)
  )
  let items = profiles.map((p: any) => ({
    roamingProfileId: p.roaming_profile_id,
    name: p.name,
    mccmncList: p.mccmnc_list,
    supplierId: p.supplier_id,
    operatorId: operatorIdMap.get(String(p.operator_id ?? '').trim()) ?? p.operator_id ?? null,
    carrierId: operatorIdMap.get(String(p.operator_id ?? '').trim()) ?? p.operator_id ?? null,
    status: p.status,
    publishedAt: p.published_at ?? null,
    effectiveFrom: p.effective_from ?? null,
    deprecatedAt: p.deprecated_at ?? null,
    sourceRoamingProfileId: p.source_roaming_profile_id ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }))
  const total = items.length
  const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize)
  return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) }
}

export async function getApnProfileDetail({
  supabase,
  apnProfileId,
}: {
  supabase: SupabaseClient
  apnProfileId: string
}): Promise<ServiceResult<unknown>> {
  if (!isValidUuid(apnProfileId)) return toError(400, 'BAD_REQUEST', 'apnProfileId is invalid.')
  const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'APN profile not found.')
  const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(
    supabase,
    [String((profile as any).operator_id ?? '').trim()].filter(Boolean)
  )
  const publicOperatorId = operatorIdMap.get(String((profile as any).operator_id ?? '').trim()) ?? (profile as any).operator_id ?? null
  return {
    ok: true,
    value: {
      apnProfileId: (profile as any).apn_profile_id,
      name: (profile as any).name,
      apn: (profile as any).apn,
      authType: (profile as any).auth_type,
      username: (profile as any).username,
      passwordRef: (profile as any).password_ref,
      supplierId: (profile as any).supplier_id,
      operatorId: publicOperatorId,
      status: (profile as any).status,
      publishedAt: (profile as any).published_at ?? null,
      effectiveFrom: (profile as any).effective_from ?? null,
      deprecatedAt: (profile as any).deprecated_at ?? null,
      sourceApnProfileId: (profile as any).source_apn_profile_id ?? null,
      createdAt: (profile as any).created_at,
      updatedAt: (profile as any).updated_at,
    },
  }
}

export async function getRoamingProfileDetail({
  supabase,
  roamingProfileId,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
}): Promise<ServiceResult<unknown>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId is invalid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(
    supabase,
    [String((profile as any).operator_id ?? '').trim()].filter(Boolean)
  )
  const publicOperatorId =
    operatorIdMap.get(String((profile as any).operator_id ?? '').trim()) ?? (profile as any).operator_id ?? null
  return {
    ok: true,
    value: {
      roamingProfileId: (profile as any).roaming_profile_id,
      name: (profile as any).name,
      mccmncList: (profile as any).mccmnc_list,
      supplierId: (profile as any).supplier_id,
      operatorId: publicOperatorId,
      carrierId: publicOperatorId,
      status: (profile as any).status,
      publishedAt: (profile as any).published_at ?? null,
      effectiveFrom: (profile as any).effective_from ?? null,
      deprecatedAt: (profile as any).deprecated_at ?? null,
      sourceRoamingProfileId: (profile as any).source_roaming_profile_id ?? null,
      createdAt: (profile as any).created_at,
      updatedAt: (profile as any).updated_at,
    },
  }
}

export async function publishApnProfile({
  supabase,
  apnProfileId,
  audit,
}: {
  supabase: SupabaseClient
  apnProfileId: string
  audit?: AuditContext
}): Promise<ServiceResult<{ apnProfileId: string; status: string; effectiveFrom: string; publishedAt: string }>> {
  if (!isValidUuid(apnProfileId)) return toError(400, 'BAD_REQUEST', 'apnProfileId is invalid.')
  const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'APN profile not found.')
  if (String((profile as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT APN profiles can be published.')
  }
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  const publishedAt = new Date().toISOString()
  await supabase.update(
    'apn_profiles',
    `apn_profile_id=eq.${encodeURIComponent(apnProfileId)}`,
    {
      status: 'PUBLISHED',
      effective_from: effectiveFrom,
      published_at: publishedAt,
      updated_at: publishedAt,
    },
    { returning: 'minimal' }
  )
  const value = {
    apnProfileId,
    status: 'PUBLISHED',
    effectiveFrom,
    publishedAt,
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'APN_PROFILE_PUBLISHED',
    target_type: 'APN_PROFILE',
    target_id: apnProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function deprecateApnProfile({
  supabase,
  apnProfileId,
  audit,
}: {
  supabase: SupabaseClient
  apnProfileId: string
  audit?: AuditContext
}): Promise<
  ServiceResult<{
    apnProfileId: string
    status: string
    publishedAt: string | null
    effectiveFrom: string | null
    deprecatedAt: string
  }>
> {
  if (!isValidUuid(apnProfileId)) return toError(400, 'BAD_REQUEST', 'apnProfileId is invalid.')
  const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'APN profile not found.')
  const st = String((profile as any).status ?? '').toUpperCase()
  if (st !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED APN profiles can be deprecated.')
  }
  const usage = await collectApnProfileUsage(supabase, apnProfileId)
  if (usage.carrierServiceIds.length || usage.packageIds.length) {
    return toError(
      409,
      'RESOURCE_IN_USE',
      `APN profile is still referenced by carrier services or subscription packages. carrierServiceIds=${usage.carrierServiceIds.join(',')}; packageIds=${usage.packageIds.join(',')}`
    )
  }
  const nowIso = new Date().toISOString()
  await supabase.update(
    'apn_profiles',
    `apn_profile_id=eq.${encodeURIComponent(apnProfileId)}`,
    {
      status: 'DEPRECATED',
      deprecated_at: nowIso,
      updated_at: nowIso,
    },
    { returning: 'minimal' }
  )
  const value = {
    apnProfileId,
    status: 'DEPRECATED',
    publishedAt: (profile as any).published_at ?? null,
    effectiveFrom: (profile as any).effective_from ?? null,
    deprecatedAt: nowIso,
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'APN_PROFILE_DEPRECATED',
    target_type: 'APN_PROFILE',
    target_id: apnProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function publishRoamingProfile({
  supabase,
  roamingProfileId,
  audit,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  audit?: AuditContext
}): Promise<
  ServiceResult<{ roamingProfileId: string; status: string; effectiveFrom: string; publishedAt: string }>
> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId is invalid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  if (String((profile as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT roaming profiles can be published.')
  }
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  const publishedAt = new Date().toISOString()
  await supabase.update(
    'roaming_profiles',
    `roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}`,
    {
      status: 'PUBLISHED',
      effective_from: effectiveFrom,
      published_at: publishedAt,
      updated_at: publishedAt,
    },
    { returning: 'minimal' }
  )
  const value = {
    roamingProfileId,
    status: 'PUBLISHED',
    effectiveFrom,
    publishedAt,
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'ROAMING_PROFILE_PUBLISHED',
    target_type: 'ROAMING_PROFILE',
    target_id: roamingProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function deprecateRoamingProfile({
  supabase,
  roamingProfileId,
  audit,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  audit?: AuditContext
}): Promise<
  ServiceResult<{
    roamingProfileId: string
    status: string
    publishedAt: string | null
    effectiveFrom: string | null
    deprecatedAt: string
  }>
> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId is invalid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const st = String((profile as any).status ?? '').toUpperCase()
  if (st !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED roaming profiles can be deprecated.')
  }
  const usage = await collectRoamingProfileUsage(supabase, roamingProfileId)
  if (usage.carrierServiceIds.length || usage.packageIds.length) {
    return toError(
      409,
      'RESOURCE_IN_USE',
      `Roaming profile is still referenced by carrier services or subscription packages. carrierServiceIds=${usage.carrierServiceIds.join(',')}; packageIds=${usage.packageIds.join(',')}`
    )
  }
  const nowIso = new Date().toISOString()
  await supabase.update(
    'roaming_profiles',
    `roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}`,
    {
      status: 'DEPRECATED',
      deprecated_at: nowIso,
      updated_at: nowIso,
    },
    { returning: 'minimal' }
  )
  const value = {
    roamingProfileId,
    status: 'DEPRECATED',
    publishedAt: (profile as any).published_at ?? null,
    effectiveFrom: (profile as any).effective_from ?? null,
    deprecatedAt: nowIso,
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'ROAMING_PROFILE_DEPRECATED',
    target_type: 'ROAMING_PROFILE',
    target_id: roamingProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function createCoveredNetworkProfile({
  supabase,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<{ coveredNetworkProfileId: string; status: string; createdAt: string }>> {
  const name = String(payload?.name || '').trim()
  const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null
  let operatorId: string | null = null
  if (payload?.operatorId !== undefined && payload?.operatorId !== null) {
    operatorId = String(payload.operatorId).trim() || null
  } else if (payload?.carrierId !== undefined && payload?.carrierId !== null) {
    operatorId = String(payload.carrierId).trim() || null
  }
  const rawResellerRaw = payload?.resellerId
  const rawReseller =
    rawResellerRaw === undefined || rawResellerRaw === null ? null : String(rawResellerRaw).trim() || null
  const coverageList = payload?.coverage !== undefined ? payload.coverage : payload?.mccmncList
  const coverageMode = normalizeCoverageMode(payload?.coverageMode ?? payload?.coverage_mode)
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId is invalid.')
  }
  if (!operatorId) return toError(400, 'BAD_REQUEST', 'operatorId is required.')
  if (!isValidUuid(operatorId)) return toError(400, 'BAD_REQUEST', 'operatorId is invalid.')
  if (!rawReseller) {
    return toError(400, 'BAD_REQUEST', 'resellerId is required.')
  }
  if (!isValidUuid(rawReseller)) {
    return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  }
  const normalizedCov = validateCoverageForMode(coverageMode, coverageList)
  if (!normalizedCov.ok) return toError(400, 'BAD_REQUEST', normalizedCov.message)
  const operator = await loadOperator(supabase, operatorId, supplierId)
  if (!operator) return toError(400, 'BAD_REQUEST', 'operatorId is not found.')
  if (String((operator as any)?.supplier_id ?? '') !== String(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.')
  }
  const resolvedOperatorId = String((operator as any)?.operator_id ?? operatorId)
  const resellerTenantId = await resolveResellerTenantId(supabase, rawReseller)
  if (!resellerTenantId) {
    return toError(400, 'BAD_REQUEST', 'resellerId is not a valid RESELLER tenant.')
  }
  const rows = await supabase.insert(
    'covered_network_profiles',
    {
      name,
      reseller_id: resellerTenantId,
      supplier_id: supplierId,
      operator_id: resolvedOperatorId,
      coverage_mode: coverageMode,
      status: 'DRAFT',
    },
    { returning: 'representation' }
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  const pid = (profile as any)?.covered_network_profile_id
    ? String((profile as any).covered_network_profile_id)
    : null
  if (!pid) return toError(500, 'INTERNAL_ERROR', 'Failed to create CoveredNetworkProfile.')
  const entryRows = normalizedCov.value.map((e) => ({
    covered_network_profile_id: pid,
    mcc: e.mcc,
    mnc: e.mnc,
  }))
  if (entryRows.length) {
    await supabase.insert('covered_network_profile_entries', entryRows, { returning: 'minimal' })
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'COVERED_NETWORK_PROFILE_CREATED',
    target_type: 'COVERED_NETWORK_PROFILE',
    target_id: pid,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      coveredNetworkProfileId: pid,
      status: 'DRAFT',
      name,
      resellerId: resellerTenantId,
      supplierId,
      operatorId: resolvedOperatorId,
      coverageMode,
      coverage: normalizedCov.value,
    },
  })
  return {
    ok: true,
    value: {
      coveredNetworkProfileId: pid,
      status: 'DRAFT',
      createdAt: (profile as any).created_at,
    },
  }
}

export async function listCoveredNetworkProfiles({
  supabase,
  supplierId,
  operatorId,
  resellerId,
  coveredNetworkProfileId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  supplierId?: string | null
  operatorId?: string | null
  resellerId?: string | null
  coveredNetworkProfileId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number; page: number; pageSize: number }>> {
  const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 20 })
  const filters: string[] = []
  const supplierIdValue = supplierId ? String(supplierId) : null
  const operatorIdValue = operatorId ? String(operatorId) : null
  const resellerIdValue = resellerId ? String(resellerId).trim() : null
  const profileIdValue = coveredNetworkProfileId ? String(coveredNetworkProfileId).trim() : null
  if (!supplierIdValue && !operatorIdValue && !profileIdValue) {
    return toError(400, 'BAD_REQUEST', 'supplierId, operatorId, or coveredNetworkProfileId is required.')
  }
  if (profileIdValue && !isValidUuid(profileIdValue)) {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
  }
  if (resellerIdValue && !isValidUuid(resellerIdValue)) {
    return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  }
  if (profileIdValue) {
    filters.push(`covered_network_profile_id=eq.${encodeURIComponent(profileIdValue)}`)
  }
  if (supplierIdValue) filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
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
  if (resellerIdValue) filters.push(`reseller_id=eq.${encodeURIComponent(resellerIdValue)}`)
  if (status) filters.push(`status=eq.${encodeURIComponent(String(status))}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const rows = await supabase.select(
    'covered_network_profiles',
    `select=covered_network_profile_id,name,reseller_id,supplier_id,operator_id,coverage_mode,status,published_at,effective_from,deprecated_at,source_covered_network_profile_id,created_at,updated_at&order=created_at.desc${filterQs}`
  )
  const profiles = Array.isArray(rows) ? rows : []
  const ids = profiles.map((p: any) => String(p.covered_network_profile_id ?? '').trim()).filter(Boolean)
  const entryMap = await fetchCoveredEntriesMap(supabase, ids)
  const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(
    supabase,
    profiles.map((p: any) => String(p.operator_id ?? '').trim()).filter(Boolean)
  )
  let items = profiles.map((p: any) => {
    const id = String(p.covered_network_profile_id ?? '')
    const pubOp =
      operatorIdMap.get(String(p.operator_id ?? '').trim()) ?? p.operator_id ?? null
    return {
      coveredNetworkProfileId: id,
      name: p.name,
      coverageMode: normalizeCoverageMode(p.coverage_mode),
      coverage: entryMap.get(id) ?? [],
      resellerId: p.reseller_id ?? null,
      supplierId: p.supplier_id,
      operatorId: pubOp,
      status: p.status,
      publishedAt: p.published_at ?? null,
      effectiveFrom: p.effective_from ?? null,
      deprecatedAt: p.deprecated_at ?? null,
      sourceCoveredNetworkProfileId: p.source_covered_network_profile_id ?? null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    }
  })
  const total = items.length
  const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize)
  return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) }
}

export async function getCoveredNetworkProfileDetail({
  supabase,
  coveredNetworkProfileId,
}: {
  supabase: SupabaseClient
  coveredNetworkProfileId: string
}): Promise<ServiceResult<unknown>> {
  if (!isValidUuid(coveredNetworkProfileId)) {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
  }
  const profile = await loadProfile(
    supabase,
    'covered_network_profiles',
    'covered_network_profile_id',
    coveredNetworkProfileId
  )
  if (!profile) return toError(404, 'NOT_FOUND', 'CoveredNetworkProfile not found.')
  const entryMap = await fetchCoveredEntriesMap(supabase, [coveredNetworkProfileId])
  const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(supabase, [
    String((profile as any).operator_id ?? '').trim(),
  ].filter(Boolean))
  const publicOperatorId =
    operatorIdMap.get(String((profile as any).operator_id ?? '').trim()) ??
    (profile as any).operator_id ??
    null
  return {
    ok: true,
    value: {
      coveredNetworkProfileId: (profile as any).covered_network_profile_id,
      name: (profile as any).name,
      coverageMode: normalizeCoverageMode((profile as any).coverage_mode),
      coverage: entryMap.get(coveredNetworkProfileId) ?? [],
      resellerId: (profile as any).reseller_id ?? null,
      supplierId: (profile as any).supplier_id,
      operatorId: publicOperatorId,
      status: (profile as any).status,
      publishedAt: (profile as any).published_at ?? null,
      effectiveFrom: (profile as any).effective_from ?? null,
      deprecatedAt: (profile as any).deprecated_at ?? null,
      sourceCoveredNetworkProfileId: (profile as any).source_covered_network_profile_id ?? null,
      createdAt: (profile as any).created_at,
      updatedAt: (profile as any).updated_at,
    },
  }
}

export async function patchCoveredNetworkProfile({
  supabase,
  coveredNetworkProfileId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  coveredNetworkProfileId: string
  payload?: any
  audit?: AuditContext
}): Promise<ServiceResult<unknown>> {
  if (!isValidUuid(coveredNetworkProfileId)) {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
  }
  const profile = (await loadProfile(
    supabase,
    'covered_network_profiles',
    'covered_network_profile_id',
    coveredNetworkProfileId
  )) as any
  if (!profile) return toError(404, 'NOT_FOUND', 'CoveredNetworkProfile not found.')
  if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT CoveredNetworkProfile can be patched.')
  }
  const updates: Record<string, unknown> = {}
  if (payload?.name !== undefined) updates.name = String(payload.name).trim()
  const nextCoverageMode =
    payload?.coverageMode !== undefined || payload?.coverage_mode !== undefined
      ? normalizeCoverageMode(payload?.coverageMode ?? payload?.coverage_mode)
      : normalizeCoverageMode(profile.coverage_mode)
  if (payload?.coverageMode !== undefined || payload?.coverage_mode !== undefined) {
    updates.coverage_mode = nextCoverageMode
  }
  let newCoverage: CoveredCoverageEntry[] | null = null
  if (payload?.coverage !== undefined) {
    const normalized = validateCoverageForMode(nextCoverageMode, payload.coverage)
    if (!normalized.ok) return toError(400, 'BAD_REQUEST', normalized.message)
    newCoverage = normalized.value
  } else if ((payload?.coverageMode !== undefined || payload?.coverage_mode !== undefined) && nextCoverageMode === 'NONE') {
    newCoverage = []
  }
  if (!Object.keys(updates).length && newCoverage === null) {
    return toError(400, 'BAD_REQUEST', 'name or coverage is required.')
  }
  const nowIso = new Date().toISOString()
  if (Object.keys(updates).length) {
    updates.updated_at = nowIso
    await supabase.update(
      'covered_network_profiles',
      `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`,
      updates,
      { returning: 'minimal' }
    )
  }
  if (newCoverage !== null) {
    const del = (supabase as unknown as { delete?: (t: string, q: string) => Promise<unknown> }).delete
    if (typeof del !== 'function') {
      return toError(500, 'INTERNAL_ERROR', 'Storage client does not support delete.')
    }
    await del(
      'covered_network_profile_entries',
      `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`
    )
    const entryRows = newCoverage.map((e) => ({
      covered_network_profile_id: coveredNetworkProfileId,
      mcc: e.mcc,
      mnc: e.mnc,
    }))
    if (entryRows.length) {
      await supabase.insert('covered_network_profile_entries', entryRows, { returning: 'minimal' })
    }
    await supabase.update(
      'covered_network_profiles',
      `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`,
      { updated_at: nowIso },
      { returning: 'minimal' }
    )
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'COVERED_NETWORK_PROFILE_UPDATED',
    target_type: 'COVERED_NETWORK_PROFILE',
    target_id: coveredNetworkProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: { name: updates.name, coverageMode: updates.coverage_mode, coverageReplaced: newCoverage !== null },
  })
  return getCoveredNetworkProfileDetail({ supabase, coveredNetworkProfileId })
}

export async function publishCoveredNetworkProfile({
  supabase,
  coveredNetworkProfileId,
  audit,
}: {
  supabase: SupabaseClient
  coveredNetworkProfileId: string
  audit?: AuditContext
}): Promise<
  ServiceResult<{
    coveredNetworkProfileId: string
    status: string
    effectiveFrom: string
    publishedAt: string
  }>
> {
  if (!isValidUuid(coveredNetworkProfileId)) {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
  }
  const profile = await loadProfile(
    supabase,
    'covered_network_profiles',
    'covered_network_profile_id',
    coveredNetworkProfileId
  )
  if (!profile) return toError(404, 'NOT_FOUND', 'CoveredNetworkProfile not found.')
  if (String((profile as any).status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT CoveredNetworkProfile can be published.')
  }
  const coverageMode = normalizeCoverageMode((profile as any).coverage_mode)
  if (coverageMode === 'LIST') {
    const entryCheck = await supabase.select(
      'covered_network_profile_entries',
      `select=entry_id&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}&limit=1`
    )
    if (!Array.isArray(entryCheck) || !entryCheck.length) {
      return toError(400, 'BAD_REQUEST', 'CoveredNetworkProfile must have at least one coverage entry before publish.')
    }
  }
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  const publishedAt = new Date().toISOString()
  await supabase.update(
    'covered_network_profiles',
    `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`,
    {
      status: 'PUBLISHED',
      effective_from: effectiveFrom,
      published_at: publishedAt,
      updated_at: publishedAt,
    },
    { returning: 'minimal' }
  )
  const value = {
    coveredNetworkProfileId,
    status: 'PUBLISHED',
    effectiveFrom,
    publishedAt,
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'COVERED_NETWORK_PROFILE_PUBLISHED',
    target_type: 'COVERED_NETWORK_PROFILE',
    target_id: coveredNetworkProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function deprecateCoveredNetworkProfile({
  supabase,
  coveredNetworkProfileId,
  audit,
}: {
  supabase: SupabaseClient
  coveredNetworkProfileId: string
  audit?: AuditContext
}): Promise<
  ServiceResult<{
    coveredNetworkProfileId: string
    status: string
    publishedAt: string | null
    effectiveFrom: string | null
    deprecatedAt: string
  }>
> {
  if (!isValidUuid(coveredNetworkProfileId)) {
    return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is invalid.')
  }
  const profile = await loadProfile(
    supabase,
    'covered_network_profiles',
    'covered_network_profile_id',
    coveredNetworkProfileId
  )
  if (!profile) return toError(404, 'NOT_FOUND', 'CoveredNetworkProfile not found.')
  const st = String((profile as any).status ?? '').toUpperCase()
  if (st !== 'PUBLISHED') {
    return toError(409, 'INVALID_STATUS', 'Only PUBLISHED CoveredNetworkProfile can be deprecated.')
  }
  const refs = await collectPricePlansReferencingCoveredProfile(supabase, coveredNetworkProfileId)
  if (refs.length) {
    return toError(409, 'REFERENCES_BLOCKED', `Still referenced by price plans: ${refs.join(',')}`)
  }
  const nowIso = new Date().toISOString()
  await supabase.update(
    'covered_network_profiles',
    `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`,
    {
      status: 'DEPRECATED',
      deprecated_at: nowIso,
      updated_at: nowIso,
    },
    { returning: 'minimal' }
  )
  const value = {
    coveredNetworkProfileId,
    status: 'DEPRECATED',
    publishedAt: (profile as any).published_at ?? null,
    effectiveFrom: (profile as any).effective_from ?? null,
    deprecatedAt: nowIso,
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'COVERED_NETWORK_PROFILE_DEPRECATED',
    target_type: 'COVERED_NETWORK_PROFILE',
    target_id: coveredNetworkProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: value,
  })
  return { ok: true, value }
}

export async function exportRoamingProfileRatesCsv({
  supabase,
  roamingProfileId,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
}): Promise<ServiceResult<{ csv: string; filename: string; rowCount: number }>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId is invalid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const list = Array.isArray((profile as any).mccmnc_list) ? (profile as any).mccmnc_list : []
  if (!list.length) return toError(400, 'BAD_REQUEST', 'Roaming profile has no mccmncList entries to export.')
  const entries = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const mcc = String((raw as any).mcc ?? '').trim()
    const mnc = String((raw as any).mnc ?? '').trim()
    const ratePerMb = Number((raw as any).ratePerMb)
    if (!mcc || !mnc || !Number.isFinite(ratePerMb)) continue
    const entry: {
      mcc: string
      mnc: string
      ratePerMb: number
      country?: string
      network?: string
    } = { mcc, mnc, ratePerMb }
    if ((raw as any).country != null && String((raw as any).country).trim()) {
      entry.country = String((raw as any).country).trim()
    }
    if ((raw as any).network != null && String((raw as any).network).trim()) {
      entry.network = String((raw as any).network).trim()
    }
    entries.push(entry)
  }
  if (!entries.length) {
    return toError(400, 'BAD_REQUEST', 'Roaming profile has no exportable mccmncList entries.')
  }
  const csv = serializeRoamingProfileRatesCsv(entries)
  const shortId = roamingProfileId.slice(0, 8)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    ok: true,
    value: {
      csv,
      filename: `roaming-profile-${shortId}-${stamp}.csv`,
      rowCount: entries.length,
    },
  }
}

export async function cloneApnProfile({
  supabase,
  apnProfileId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  apnProfileId: string
  payload?: any
  audit?: AuditContext
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(apnProfileId)) return toError(400, 'BAD_REQUEST', 'apnProfileId is invalid.')
  const source = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId)
  if (!source) return toError(404, 'NOT_FOUND', 'Source APN profile not found.')
  const name = payload?.name ? String(payload.name).trim() : `${(source as any).name} (Copy)`
  const rows = await supabase.insert(
    'apn_profiles',
    {
      name,
      apn: (source as any).apn,
      auth_type: (source as any).auth_type,
      username: (source as any).username ?? null,
      password_ref: (source as any).password_ref ?? null,
      supplier_id: (source as any).supplier_id,
      operator_id: (source as any).operator_id,
      status: 'DRAFT',
      source_apn_profile_id: apnProfileId,
    },
    { returning: 'representation' }
  )
  const cloned = Array.isArray(rows) ? rows[0] as any : null
  if (!cloned?.apn_profile_id) return toError(500, 'INTERNAL_ERROR', 'Failed to clone APN profile.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'APN_PROFILE_CLONED',
    target_type: 'APN_PROFILE',
    target_id: cloned.apn_profile_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      apnProfileId: cloned.apn_profile_id,
      sourceApnProfileId: apnProfileId,
    },
  })
  return {
    ok: true,
    value: {
      apnProfileId: cloned.apn_profile_id,
      sourceApnProfileId: apnProfileId,
      status: 'DRAFT',
      createdAt: cloned.created_at,
    },
  }
}

export async function cloneRoamingProfile({
  supabase,
  roamingProfileId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  payload?: any
  audit?: AuditContext
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId is invalid.')
  const source = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!source) return toError(404, 'NOT_FOUND', 'Source roaming profile not found.')
  const name = payload?.name ? String(payload.name).trim() : `${(source as any).name} (Copy)`
  const rows = await supabase.insert(
    'roaming_profiles',
    {
      name,
      mccmnc_list: (source as any).mccmnc_list,
      supplier_id: (source as any).supplier_id,
      operator_id: (source as any).operator_id,
      status: 'DRAFT',
      source_roaming_profile_id: roamingProfileId,
    },
    { returning: 'representation' }
  )
  const cloned = Array.isArray(rows) ? (rows[0] as any) : null
  if (!cloned?.roaming_profile_id) return toError(500, 'INTERNAL_ERROR', 'Failed to clone roaming profile.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'ROAMING_PROFILE_CLONED',
    target_type: 'ROAMING_PROFILE',
    target_id: cloned.roaming_profile_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      roamingProfileId: cloned.roaming_profile_id,
      sourceRoamingProfileId: roamingProfileId,
    },
  })
  return {
    ok: true,
    value: {
      roamingProfileId: cloned.roaming_profile_id,
      sourceRoamingProfileId: roamingProfileId,
      status: 'DRAFT',
      createdAt: cloned.created_at,
    },
  }
}

export async function updateApnProfile({
  supabase,
  apnProfileId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  apnProfileId: string
  payload?: any
  audit?: AuditContext
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(apnProfileId)) return toError(400, 'BAD_REQUEST', 'apnProfileId is invalid.')
  const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId) as any
  if (!profile) return toError(404, 'NOT_FOUND', 'APN profile not found.')
  if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT APN profiles can be updated. Clone to a new draft snapshot first.')
  }
  const updates: Record<string, unknown> = {}
  if (payload?.name !== undefined) updates.name = String(payload.name).trim()
  if (payload?.apn !== undefined) updates.apn = String(payload.apn).trim()
  if (payload?.authType !== undefined) updates.auth_type = String(payload.authType)
  if (payload?.username !== undefined) updates.username = payload.username ? String(payload.username) : null
  if (payload?.passwordRef !== undefined) updates.password_ref = payload.passwordRef ? String(payload.passwordRef) : null
  if (!Object.keys(updates).length) {
    return toError(400, 'BAD_REQUEST', 'update payload is required.')
  }
  updates.updated_at = new Date().toISOString()
  await supabase.update(
    'apn_profiles',
    `apn_profile_id=eq.${encodeURIComponent(apnProfileId)}`,
    updates,
    { returning: 'minimal' }
  )
  const refreshed = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId) as any
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'APN_PROFILE_UPDATED',
    target_type: 'APN_PROFILE',
    target_id: apnProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: {
      name: profile.name,
      apn: profile.apn,
      authType: profile.auth_type,
    },
    after_data: {
      name: refreshed?.name,
      apn: refreshed?.apn,
      authType: refreshed?.auth_type,
    },
  })
  return {
    ok: true,
    value: {
      apnProfileId: refreshed.apn_profile_id,
      name: refreshed.name,
      apn: refreshed.apn,
      authType: refreshed.auth_type,
      username: refreshed.username,
      passwordRef: refreshed.password_ref,
      supplierId: refreshed.supplier_id,
      operatorId: refreshed.operator_id,
      status: refreshed.status,
      publishedAt: refreshed.published_at ?? null,
      effectiveFrom: refreshed.effective_from ?? null,
      deprecatedAt: refreshed.deprecated_at ?? null,
      sourceApnProfileId: refreshed.source_apn_profile_id ?? null,
      createdAt: refreshed.created_at,
      updatedAt: refreshed.updated_at,
    },
  }
}

export async function updateRoamingProfile({
  supabase,
  roamingProfileId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  payload?: any
  audit?: AuditContext
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId is invalid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId) as any
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
    return toError(
      409,
      'INVALID_STATUS',
      'Only DRAFT roaming profiles can be updated. Export CSV from an existing profile and import as a new profile instead.'
    )
  }
  const updates: Record<string, unknown> = {}
  if (payload?.name !== undefined) updates.name = String(payload.name).trim()
  let normalizedList: unknown[] | null = null
  if (payload?.mccmncList !== undefined) {
    const list = Array.isArray(payload.mccmncList) ? payload.mccmncList : []
    if (!list.length) return toError(400, 'BAD_REQUEST', 'mccmncList is required.')
    const normalized = normalizeRoamingEntryList(list)
    if (!normalized.ok) return toError(400, 'BAD_REQUEST', (normalized as any).message)
    normalizedList = (normalized as any).value
    updates.mccmnc_list = normalizedList
  }
  if (!Object.keys(updates).length) {
    return toError(400, 'BAD_REQUEST', 'update payload is required.')
  }
  updates.updated_at = new Date().toISOString()
  await supabase.update(
    'roaming_profiles',
    `roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}`,
    updates,
    { returning: 'minimal' }
  )
  const refreshed = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId) as any
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'ROAMING_PROFILE_UPDATED',
    target_type: 'ROAMING_PROFILE',
    target_id: roamingProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: {
      name: profile.name,
      mccmncList: profile.mccmnc_list,
    },
    after_data: {
      name: refreshed?.name,
      mccmncList: refreshed?.mccmnc_list,
    },
  })
  const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(
    supabase,
    [String(refreshed.operator_id ?? '').trim()].filter(Boolean)
  )
  const publicOperatorId = operatorIdMap.get(String(refreshed.operator_id ?? '').trim()) ?? refreshed.operator_id ?? null
  return {
    ok: true,
    value: {
      roamingProfileId: refreshed.roaming_profile_id,
      name: refreshed.name,
      mccmncList: refreshed.mccmnc_list,
      supplierId: refreshed.supplier_id,
      operatorId: publicOperatorId,
      carrierId: publicOperatorId,
      status: refreshed.status,
      publishedAt: refreshed.published_at ?? null,
      effectiveFrom: refreshed.effective_from ?? null,
      deprecatedAt: refreshed.deprecated_at ?? null,
      sourceRoamingProfileId: refreshed.source_roaming_profile_id ?? null,
      createdAt: refreshed.created_at,
      updatedAt: refreshed.updated_at,
    },
  }
}
