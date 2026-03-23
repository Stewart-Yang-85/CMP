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
  await supabase.insert('audit_logs', payload, { returning: 'minimal' })
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

type RoamingRateEntry = { mcc: string; mnc: string; ratePerMb: number }

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
  const [normalizedMcc, normalizedMnc] = normalized.split('-')
  return { ok: true as const, value: { mcc: normalizedMcc, mnc: normalizedMnc, ratePerMb: rateValue } }
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

type RoamingDraftEntry = {
  entryId: string
  mcc: string
  mnc: string
  ratePerMb: number
  isDeleted: boolean
  updatedAt: string
}

type ProfileVersionView = {
  profileVersionId: string
  profileType: string
  profileId: string
  version: number
  status: string
  effectiveFrom: string | null
  effectiveTo: string | null
  config: unknown
  createdAt: string
}

function normalizeStoredRoamingEntries(rawList: unknown) {
  const list = Array.isArray(rawList) ? rawList : []
  const now = new Date().toISOString()
  const normalized: RoamingDraftEntry[] = []
  for (const raw of list as any[]) {
    const parsed = normalizeRoamingEntry(raw)
    if (!parsed.ok) return parsed
    const entryIdRaw = String((raw as any)?.entryId ?? '').trim()
    const entryId = entryIdRaw || `${parsed.value.mcc}-${parsed.value.mnc}`
    normalized.push({
      entryId,
      mcc: parsed.value.mcc,
      mnc: parsed.value.mnc,
      ratePerMb: parsed.value.ratePerMb,
      isDeleted: Boolean((raw as any)?.isDeleted),
      updatedAt: String((raw as any)?.updatedAt ?? '').trim() || now,
    })
  }
  return { ok: true as const, value: normalized }
}

function findRoamingEntryIndex(entries: RoamingDraftEntry[], operation: any) {
  const entryId = String(operation?.entryId ?? '').trim()
  if (entryId) return entries.findIndex((entry) => entry.entryId === entryId)
  const mcc = String(operation?.mcc ?? '').trim()
  const mnc = String(operation?.mnc ?? '').trim()
  const normalized = normalizeMccMnc(`${mcc}-${mnc}`)
  if (!normalized) return -1
  const [normalizedMcc, normalizedMnc] = normalized.split('-')
  return entries.findIndex((entry) => entry.mcc === normalizedMcc && entry.mnc === normalizedMnc)
}

function validateNoDuplicateActiveEntries(entries: RoamingDraftEntry[]) {
  const unique = new Set<string>()
  for (const entry of entries) {
    if (entry.isDeleted) continue
    const key = `${entry.mcc}-${entry.mnc}`
    if (unique.has(key)) return toError(409, 'CONFLICT', `Duplicate mcc/mnc combination: ${key}`)
    unique.add(key)
  }
  return { ok: true as const, value: null }
}

async function loadRoamingProfileVersion(supabase: SupabaseClient, roamingProfileId: string, profileVersionId: string) {
  try {
    const rows = await supabase.select(
      'profile_versions',
      `select=profile_version_id,profile_type,profile_id,version,status,effective_from,effective_to,config,created_at&profile_type=eq.ROAMING&profile_id=eq.${encodeURIComponent(roamingProfileId)}&profile_version_id=eq.${encodeURIComponent(profileVersionId)}&limit=1`
    )
    return Array.isArray(rows) ? rows[0] : null
  } catch (err) {
    if (isProfileVersionsTableMissing(err)) return null
    throw err
  }
}

async function isRoamingProfileVersionReferencedByPackage(supabase: SupabaseClient, profileVersionId: string) {
  const rows = await supabase.select(
    'package_versions',
    'select=package_version_id,status,roaming_profile,carrier_service_config'
  )
  for (const row of Array.isArray(rows) ? rows : []) {
    const roamingProfileVersionIdFromRoaming = String((row as any)?.roaming_profile?.profileVersionId ?? '').trim()
    const roamingProfileVersionIdFromCarrier = String((row as any)?.carrier_service_config?.roamingProfileVersionId ?? '').trim()
    if (roamingProfileVersionIdFromRoaming === profileVersionId || roamingProfileVersionIdFromCarrier === profileVersionId) {
      return true
    }
  }
  return false
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

async function loadOperator(supabase: SupabaseClient, operatorId: string, supplierId?: string | null) {
  const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId)
  if (byOperatorId) return byOperatorId
  return loadOperatorByBusinessOperatorId(supabase, operatorId, supplierId)
}

async function resolveBoundOperatorIds(supabase: SupabaseClient, operatorId: string, supplierId?: string | null) {
  const ids = new Set<string>()
  const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId)
  if ((byOperatorId as any)?.operator_id) ids.add(String((byOperatorId as any).operator_id))
  const byBusinessOperatorId = await loadOperatorByBusinessOperatorId(supabase, operatorId, supplierId)
  if ((byBusinessOperatorId as any)?.operator_id) ids.add(String((byBusinessOperatorId as any).operator_id))
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
        status: 'ACTIVE',
      },
      { returning: 'representation' }
    )
    const profile = Array.isArray(profileRows) ? profileRows[0] : null
    if ((profile as any)?.apn_profile_id) {
      await insertProfileVersionWithFallback(
        supabase,
        {
          profile_type: 'APN',
          profile_id: (profile as any).apn_profile_id,
          version: 1,
          status: 'DRAFT',
          config: {
            apn,
            authType: 'NONE',
            username: null,
            passwordRef: null,
          },
        },
        'minimal'
      )
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

async function loadLatestProfileVersion(supabase: SupabaseClient, profileType: string, profileId: string) {
  try {
    const rows = await supabase.select(
      'profile_versions',
      `select=profile_version_id,profile_type,profile_id,version,status,effective_from,effective_to,config,created_at&profile_type=eq.${encodeURIComponent(profileType)}&profile_id=eq.${encodeURIComponent(profileId)}&order=version.desc&limit=1`
    )
    return Array.isArray(rows) ? rows[0] : null
  } catch (err) {
    if (isProfileVersionsTableMissing(err)) return null
    throw err
  }
}

async function loadProfileVersions(supabase: SupabaseClient, profileType: string, profileId: string) {
  try {
    const rows = await supabase.select(
      'profile_versions',
      `select=profile_version_id,profile_type,profile_id,version,status,effective_from,effective_to,config,created_at&profile_type=eq.${encodeURIComponent(profileType)}&profile_id=eq.${encodeURIComponent(profileId)}&order=version.desc`
    )
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    if (isProfileVersionsTableMissing(err)) return []
    throw err
  }
}

function isProfileVersionsTableMissing(err: unknown) {
  const code = String((err as any)?.body?.code ?? '').trim()
  const message = String((err as any)?.body?.message ?? (err as any)?.message ?? '').toLowerCase()
  return code === 'PGRST205' && message.includes('profile_versions')
}

async function insertProfileVersionWithFallback(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  returning: 'minimal' | 'representation' = 'representation'
) {
  try {
    return await supabase.insert('profile_versions', payload, { returning })
  } catch (err) {
    if (isProfileVersionsTableMissing(err)) return null
    throw err
  }
}

async function loadProfileVersionsByIds(supabase: SupabaseClient, profileType: 'APN' | 'ROAMING', profileIds: string[]) {
  if (!profileIds.length) return []
  const idFilter = profileIds.map((id) => encodeURIComponent(id)).join(',')
  try {
    const rows = await supabase.select(
      'profile_versions',
      `select=profile_version_id,profile_id,version,status,effective_from,effective_to,config,created_at&profile_type=eq.${profileType}&profile_id=in.(${idFilter})&order=version.desc`
    )
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    if (isProfileVersionsTableMissing(err)) return []
    throw err
  }
}

function mapProfileVersion(version: any): ProfileVersionView | null {
  if (!version) return null
  return {
    profileVersionId: version.profile_version_id,
    profileType: version.profile_type,
    profileId: version.profile_id,
    version: version.version,
    status: version.status,
    effectiveFrom: version.effective_from,
    effectiveTo: version.effective_to,
    config: version.config ?? null,
    createdAt: version.created_at,
  }
}

async function publishProfileVersion({
  supabase,
  profileType,
  profileId,
}: {
  supabase: SupabaseClient
  profileType: string
  profileId: string
}): Promise<ServiceResult<{ profileId: string; profileVersionId: string; status: string; effectiveFrom: string }>> {
  const latest = await loadLatestProfileVersion(supabase, profileType, profileId)
  if (!latest) return toError(404, 'NOT_FOUND', 'Profile version not found.')
  if ((latest as any).status !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT version can be published.')
  }
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  await supabase.update(
    'profile_versions',
    `profile_version_id=eq.${encodeURIComponent(String((latest as any).profile_version_id))}`,
    { status: 'PUBLISHED', effective_from: effectiveFrom },
    { returning: 'minimal' }
  )
  const previousRows = await supabase.select(
    'profile_versions',
    `select=profile_version_id,effective_to&profile_type=eq.${encodeURIComponent(profileType)}&profile_id=eq.${encodeURIComponent(profileId)}&status=eq.PUBLISHED&profile_version_id=neq.${encodeURIComponent(String((latest as any).profile_version_id))}&order=version.desc&limit=1`
  )
  const previous = Array.isArray(previousRows) ? previousRows[0] : null
  if ((previous as any)?.profile_version_id) {
    await supabase.update(
      'profile_versions',
      `profile_version_id=eq.${encodeURIComponent(String((previous as any).profile_version_id))}`,
      { effective_to: effectiveFrom },
      { returning: 'minimal' }
    )
  }
  await supabase.insert(
    'profile_change_requests',
    { profile_version_id: (latest as any).profile_version_id, status: 'SCHEDULED', scheduled_at: effectiveFrom },
    { returning: 'minimal' }
  )
  return {
    ok: true,
    value: {
      profileId: String(profileId),
      profileVersionId: String((latest as any).profile_version_id),
      status: 'PUBLISHED',
      effectiveFrom,
    },
  }
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
    return toError(400, 'BAD_REQUEST', 'profileVersionId must be a valid uuid.')
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
}): Promise<ServiceResult<{ profileId: string; apnProfileId: string; profileVersionId: string | null; version: number; status: string; createdAt: string }>> {
  const name = String(payload?.name || '').trim()
  const apn = String(payload?.apn || '').trim()
  const authType = payload?.authType ? String(payload.authType) : 'NONE'
  const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null
  const operatorId = payload?.operatorId ? String(payload.operatorId).trim() : null
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!apn) return toError(400, 'BAD_REQUEST', 'apn is required.')
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
  }
  if (!operatorId) {
    return toError(400, 'BAD_REQUEST', 'operatorId is required.')
  }
  if (!isValidUuid(operatorId)) {
    return toError(400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
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
      status: 'ACTIVE',
    },
    { returning: 'representation' }
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  if (!(profile as any)?.apn_profile_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create APN profile.')
  const versionRows = await insertProfileVersionWithFallback(
    supabase,
    {
      profile_type: 'APN',
      profile_id: (profile as any).apn_profile_id,
      version: 1,
      status: 'DRAFT',
      config: {
        apn,
        authType,
        username: payload?.username ? String(payload.username) : null,
        passwordRef: payload?.passwordRef ? String(payload.passwordRef) : null,
      },
    },
    'representation'
  )
  const version = Array.isArray(versionRows) ? versionRows[0] : null
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
      profileVersionId: (version as any)?.profile_version_id ?? null,
      version: (version as any)?.version ?? 1,
      status: (version as any)?.status ?? 'DRAFT',
      name,
      apn,
      authType,
      supplierId,
      operatorId: resolvedOperatorId,
    },
  })
  return {
    ok: true,
    value: {
      profileId: String((profile as any).apn_profile_id),
      apnProfileId: String((profile as any).apn_profile_id),
      profileVersionId: (version as any)?.profile_version_id ?? null,
      version: (version as any)?.version ?? 1,
      status: (version as any)?.status ?? 'DRAFT',
      createdAt: (version as any)?.created_at ?? (profile as any).created_at,
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
}): Promise<ServiceResult<{ profileId: string; roamingProfileId: string; profileVersionId: string | null; version: number; status: string; createdAt: string }>> {
  const name = String(payload?.name || '').trim()
  const resellerId = payload?.resellerId ? String(payload.resellerId).trim() : null
  const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null
  const operatorId = payload?.operatorId ? String(payload.operatorId).trim() : payload?.carrierId ? String(payload.carrierId).trim() : null
  const list = Array.isArray(payload?.mccmncList) ? payload.mccmncList : []
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!resellerId || !isValidUuid(resellerId)) {
    return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
  }
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
  }
  if (operatorId && !isValidUuid(operatorId)) {
    return toError(400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
  }
  if (!list.length) return toError(400, 'BAD_REQUEST', 'mccmncList is required.')
  const normalized = normalizeRoamingEntryList(list)
  if (!normalized.ok) return toError(400, 'BAD_REQUEST', normalized.message)
  const operator = operatorId ? await loadOperator(supabase, operatorId, supplierId) : null
  if (operatorId && !operator) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not found.')
  }
  if (operatorId && String((operator as any)?.supplier_id ?? '') !== String(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.')
  }
  const resolvedOperatorId = operatorId ? String((operator as any)?.operator_id ?? operatorId) : null
  const normalizedList = normalized.value
  const rows = await supabase.insert(
    'roaming_profiles',
    {
      name,
      mccmnc_list: normalizedList,
      supplier_id: supplierId,
      operator_id: resolvedOperatorId,
      status: 'ACTIVE',
    },
    { returning: 'representation' }
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  if (!(profile as any)?.roaming_profile_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create roaming profile.')
  const versionRows = await insertProfileVersionWithFallback(
    supabase,
    {
      profile_type: 'ROAMING',
      profile_id: (profile as any).roaming_profile_id,
      version: 1,
      status: 'DRAFT',
      config: {
        mccmncList: normalizedList,
      },
    },
    'representation'
  )
  const version = Array.isArray(versionRows) ? versionRows[0] : null
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
      profileVersionId: (version as any)?.profile_version_id ?? null,
      version: (version as any)?.version ?? 1,
      status: (version as any)?.status ?? 'DRAFT',
      name,
      resellerId,
      supplierId,
      operatorId: resolvedOperatorId,
      carrierId: resolvedOperatorId,
      mccmncList: normalizedList,
    },
  })
  return {
    ok: true,
    value: {
      profileId: String((profile as any).roaming_profile_id),
      roamingProfileId: String((profile as any).roaming_profile_id),
      profileVersionId: (version as any)?.profile_version_id ?? null,
      version: (version as any)?.version ?? 1,
      status: (version as any)?.status ?? 'DRAFT',
      createdAt: (version as any)?.created_at ?? (profile as any).created_at,
    },
  }
}

export async function createApnProfileVersion({
  supabase,
  apnProfileId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  apnProfileId: string
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<unknown>> {
  if (!isValidUuid(apnProfileId)) return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'APN profile not found.')
  const latest = await loadLatestProfileVersion(supabase, 'APN', apnProfileId)
  const nextVersion = ((latest as any)?.version ?? 0) + 1
  const apn = payload?.apn ? String(payload.apn).trim() : (profile as any).apn
  const authType = payload?.authType ? String(payload.authType) : (profile as any).auth_type
  const username = payload?.username ? String(payload.username) : (profile as any).username ?? null
  const passwordRef = payload?.passwordRef ? String(payload.passwordRef) : (profile as any).password_ref ?? null
  const rows = await insertProfileVersionWithFallback(
    supabase,
    {
      profile_type: 'APN',
      profile_id: apnProfileId,
      version: nextVersion,
      status: 'DRAFT',
      config: { apn, authType, username, passwordRef },
    },
    'representation'
  )
  if (rows === null) {
    return toError(503, 'VERSIONING_UNAVAILABLE', 'Profile version storage is unavailable.')
  }
  const version = Array.isArray(rows) ? rows[0] : null
  if ((version as any)?.profile_version_id) {
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: null,
      action: 'APN_PROFILE_VERSION_CREATED',
      target_type: 'APN_PROFILE',
      target_id: apnProfileId,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: {
        profileVersionId: (version as any).profile_version_id,
        version: (version as any).version ?? nextVersion,
      },
    })
  }
  return { ok: true, value: mapProfileVersion(version) }
}

export async function createRoamingProfileVersion({
  supabase,
  roamingProfileId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<ProfileVersionView | null>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const list = Array.isArray(payload?.mccmncList) ? payload.mccmncList : (profile as any).mccmnc_list
  const normalized = normalizeRoamingEntryList(list)
  if (!normalized.ok) return toError(400, 'BAD_REQUEST', normalized.message)
  const normalizedList = normalized.value
  const latest = await loadLatestProfileVersion(supabase, 'ROAMING', roamingProfileId)
  const nextVersion = ((latest as any)?.version ?? 0) + 1
  const rows = await supabase.insert(
    'profile_versions',
    {
      profile_type: 'ROAMING',
      profile_id: roamingProfileId,
      version: nextVersion,
      status: 'DRAFT',
      config: { mccmncList: normalizedList },
    },
    { returning: 'representation' }
  )
  const version = Array.isArray(rows) ? rows[0] : null
  if ((version as any)?.profile_version_id) {
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: null,
      action: 'ROAMING_PROFILE_VERSION_CREATED',
      target_type: 'ROAMING_PROFILE',
      target_id: roamingProfileId,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: {
        profileVersionId: (version as any).profile_version_id,
        version: (version as any).version ?? nextVersion,
      },
    })
  }
  return { ok: true, value: mapProfileVersion(version) }
}

export async function deriveRoamingProfileVersion({
  supabase,
  roamingProfileId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<ProfileVersionView | null>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
  const baseVersionId = String(payload?.baseVersionId ?? '').trim()
  if (!isValidUuid(baseVersionId)) return toError(400, 'BAD_REQUEST', 'baseVersionId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const baseVersion = await loadRoamingProfileVersion(supabase, roamingProfileId, baseVersionId)
  if (!baseVersion) return toError(404, 'NOT_FOUND', 'Base roaming profile version not found.')
  const versions = await loadProfileVersions(supabase, 'ROAMING', roamingProfileId)
  const maxVersion = versions.reduce((max, row) => {
    const value = Number((row as any)?.version ?? 0)
    return Number.isFinite(value) ? Math.max(max, value) : max
  }, 0)
  const baseVersionNumber = Number((baseVersion as any)?.version ?? 0)
  if (!Number.isFinite(baseVersionNumber) || baseVersionNumber < maxVersion) {
    return toError(409, 'BASE_VERSION_NOT_LATEST', 'Only latest version can be used as baseVersionId.')
  }
  const sourceList = Array.isArray((baseVersion as any)?.config?.mccmncList)
    ? (baseVersion as any).config.mccmncList
    : (profile as any).mccmnc_list
  const normalized = normalizeStoredRoamingEntries(sourceList)
  if (!normalized.ok) return toError(400, 'BAD_REQUEST', normalized.message)
  const nextVersion = maxVersion + 1
  const rows = await supabase.insert(
    'profile_versions',
    {
      profile_type: 'ROAMING',
      profile_id: roamingProfileId,
      version: nextVersion,
      status: 'DRAFT',
      config: { mccmncList: normalized.value },
    },
    { returning: 'representation' }
  )
  const version = Array.isArray(rows) ? rows[0] : null
  if ((version as any)?.profile_version_id) {
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: null,
      action: 'ROAMING_PROFILE_VERSION_DERIVED',
      target_type: 'ROAMING_PROFILE',
      target_id: roamingProfileId,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: {
        profileVersionId: (version as any).profile_version_id,
        version: (version as any).version ?? nextVersion,
        baseVersionId,
      },
    })
  }
  return { ok: true, value: mapProfileVersion(version) }
}

export async function listRoamingProfileEntries({
  supabase,
  roamingProfileId,
  profileVersionId,
  includeDeleted,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  profileVersionId: string
  includeDeleted?: boolean | string | number | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: RoamingDraftEntry[]; total: number; page: number; pageSize: number }>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
  if (!isValidUuid(profileVersionId)) return toError(400, 'BAD_REQUEST', 'profileVersionId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const version = await loadRoamingProfileVersion(supabase, roamingProfileId, profileVersionId)
  if (!version) return toError(404, 'NOT_FOUND', 'Roaming profile version not found.')
  const sourceList = Array.isArray((version as any)?.config?.mccmncList)
    ? (version as any).config.mccmncList
    : (profile as any).mccmnc_list
  const normalized = normalizeStoredRoamingEntries(sourceList)
  if (!normalized.ok) return toError(400, 'BAD_REQUEST', normalized.message)
  const includeDeletedValue =
    includeDeleted === true || String(includeDeleted ?? '').trim().toLowerCase() === 'true' || String(includeDeleted ?? '').trim() === '1'
  const filtered = includeDeletedValue ? normalized.value : normalized.value.filter((entry) => !entry.isDeleted)
  const pageNumber = Math.max(1, Number(page) || 1)
  const pageSizeNumber = Math.max(1, Number(pageSize) || 50)
  const start = (pageNumber - 1) * pageSizeNumber
  const items = filtered.slice(start, start + pageSizeNumber)
  return { ok: true, value: { items, total: filtered.length, page: pageNumber, pageSize: pageSizeNumber } }
}

export async function patchRoamingProfileEntries({
  supabase,
  roamingProfileId,
  profileVersionId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  profileVersionId: string
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<{ profileId: string; profileVersionId: string; applied: number; version: number; status: string }>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
  if (!isValidUuid(profileVersionId)) return toError(400, 'BAD_REQUEST', 'profileVersionId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const version = await loadRoamingProfileVersion(supabase, roamingProfileId, profileVersionId)
  if (!version) return toError(404, 'NOT_FOUND', 'Roaming profile version not found.')
  if (String((version as any)?.status ?? '') !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT version can be patched.')
  }
  const locked = await isRoamingProfileVersionReferencedByPackage(supabase, profileVersionId)
  if (locked) {
    return toError(409, 'RESOURCE_LOCKED', 'Profile version is locked because it is referenced by a package.')
  }
  const operations = Array.isArray(payload?.operations) ? payload.operations : []
  if (!operations.length) return toError(400, 'BAD_REQUEST', 'operations is required.')
  const sourceList = Array.isArray((version as any)?.config?.mccmncList)
    ? (version as any).config.mccmncList
    : (profile as any).mccmnc_list
  const normalized = normalizeStoredRoamingEntries(sourceList)
  if (!normalized.ok) return toError(400, 'BAD_REQUEST', normalized.message)
  const entries = normalized.value
  let applied = 0
  for (const operation of operations as any[]) {
    const op = String(operation?.op ?? '').trim().toUpperCase()
    if (op !== 'UPSERT' && op !== 'DELETE') {
      return toError(400, 'BAD_REQUEST', `Unsupported operation: ${String(operation?.op ?? '')}`)
    }
    const now = new Date().toISOString()
    const index = findRoamingEntryIndex(entries, operation)
    if (op === 'UPSERT') {
      if (index >= 0) {
        const current = entries[index]
        const patch = normalizeRoamingEntry({
          mcc: operation?.mcc ?? current.mcc,
          mnc: operation?.mnc ?? current.mnc,
          ratePerMb: operation?.ratePerMb ?? current.ratePerMb,
        })
        if (!patch.ok) return toError(400, 'BAD_REQUEST', patch.message)
        entries[index] = {
          ...current,
          mcc: patch.value.mcc,
          mnc: patch.value.mnc,
          ratePerMb: patch.value.ratePerMb,
          isDeleted: false,
          updatedAt: now,
        }
      } else {
        const patch = normalizeRoamingEntry(operation)
        if (!patch.ok) return toError(400, 'BAD_REQUEST', patch.message)
        entries.push({
          entryId: String(operation?.entryId ?? '').trim() || `${patch.value.mcc}-${patch.value.mnc}`,
          mcc: patch.value.mcc,
          mnc: patch.value.mnc,
          ratePerMb: patch.value.ratePerMb,
          isDeleted: false,
          updatedAt: now,
        })
      }
      applied += 1
      continue
    }
    if (index < 0) {
      return toError(400, 'BAD_REQUEST', 'Entry not found for DELETE operation.')
    }
    entries[index] = { ...entries[index], isDeleted: true, updatedAt: now }
    applied += 1
  }
  const duplicateCheck = validateNoDuplicateActiveEntries(entries)
  if (!duplicateCheck.ok) return duplicateCheck
  const config = (version as any)?.config && typeof (version as any).config === 'object' ? { ...(version as any).config } : {}
  config.mccmncList = entries
  await supabase.update(
    'profile_versions',
    `profile_version_id=eq.${encodeURIComponent(profileVersionId)}`,
    { config },
    { returning: 'minimal' }
  )
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'ROAMING_PROFILE_ENTRIES_PATCHED',
    target_type: 'ROAMING_PROFILE',
    target_id: roamingProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      profileVersionId,
      applied,
      operations,
    },
  })
  return {
    ok: true,
    value: {
      profileId: roamingProfileId,
      profileVersionId,
      applied,
      version: Number((version as any)?.version ?? 1),
      status: String((version as any)?.status ?? 'DRAFT'),
    },
  }
}

export async function listApnProfiles({
  supabase,
  supplierId,
  operatorId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  supplierId?: string | null
  operatorId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number }>> {
  const filters = []
  const supplierIdValue = supplierId ? String(supplierId) : null
  const operatorIdValue = operatorId ? String(operatorId) : null
  if (!supplierIdValue && !operatorIdValue) {
    return toError(400, 'BAD_REQUEST', 'supplierId or operatorId is required.')
  }
  if (supplierIdValue) {
    await backfillApnProfilesFromSims(supabase, supplierIdValue)
    filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
  }
  if (operatorIdValue) {
    const operatorIds = await resolveBoundOperatorIds(supabase, operatorIdValue, supplierIdValue)
    if (!operatorIds.length) return { ok: true, value: { items: [], total: 0 } }
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
    `select=apn_profile_id,name,apn,auth_type,username,password_ref,supplier_id,operator_id,status,created_at,updated_at&order=created_at.desc${filterQs}`
  )
  const profiles = Array.isArray(rows) ? rows : []
  const ids = profiles.map((p: any) => p.apn_profile_id).filter(Boolean)
  const versions = await loadProfileVersionsByIds(supabase, 'APN', ids)
  const latestByProfile = new Map<string, any>()
  for (const v of versions) {
    if (!latestByProfile.has(v.profile_id)) latestByProfile.set(v.profile_id, v)
  }
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
    latestVersion: mapProfileVersion(latestByProfile.get(p.apn_profile_id) || null),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }))
  const p = Number(page) || 1
  const ps = Number(pageSize) || 20
  const start = (p - 1) * ps
  const total = items.length
  items = items.slice(start, start + ps)
  return { ok: true, value: { items, total } }
}

export async function listRoamingProfiles({
  supabase,
  supplierId,
  operatorId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  supplierId?: string | null
  operatorId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number }>> {
  const filters = []
  const supplierIdValue = supplierId ? String(supplierId) : null
  const operatorIdValue = operatorId ? String(operatorId) : null
  if (!supplierIdValue && !operatorIdValue) {
    return toError(400, 'BAD_REQUEST', 'supplierId or operatorId is required.')
  }
  if (supplierIdValue) filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`)
  if (operatorIdValue) {
    const operatorIds = await resolveBoundOperatorIds(supabase, operatorIdValue, supplierIdValue)
    if (!operatorIds.length) return { ok: true, value: { items: [], total: 0 } }
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
    `select=roaming_profile_id,name,mccmnc_list,supplier_id,operator_id,status,created_at,updated_at&order=created_at.desc${filterQs}`
  )
  const profiles = Array.isArray(rows) ? rows : []
  const ids = profiles.map((p: any) => p.roaming_profile_id).filter(Boolean)
  const versions = await loadProfileVersionsByIds(supabase, 'ROAMING', ids)
  const latestByProfile = new Map<string, any>()
  for (const v of versions) {
    if (!latestByProfile.has(v.profile_id)) latestByProfile.set(v.profile_id, v)
  }
  let items = profiles.map((p: any) => ({
    roamingProfileId: p.roaming_profile_id,
    name: p.name,
    mccmncList: p.mccmnc_list,
    supplierId: p.supplier_id,
    operatorId: p.operator_id ?? null,
    carrierId: p.operator_id ?? null,
    status: p.status,
    latestVersion: mapProfileVersion(latestByProfile.get(p.roaming_profile_id) || null),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }))
  const p = Number(page) || 1
  const ps = Number(pageSize) || 20
  const start = (p - 1) * ps
  const total = items.length
  items = items.slice(start, start + ps)
  return { ok: true, value: { items, total } }
}

export async function getApnProfileDetail({
  supabase,
  apnProfileId,
}: {
  supabase: SupabaseClient
  apnProfileId: string
}): Promise<ServiceResult<unknown>> {
  if (!isValidUuid(apnProfileId)) return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'APN profile not found.')
  const versions = await loadProfileVersions(supabase, 'APN', apnProfileId)
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
      createdAt: (profile as any).created_at,
      updatedAt: (profile as any).updated_at,
      currentVersion: mapProfileVersion(versions[0] ?? null),
      versions: versions.map(mapProfileVersion),
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
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const versions = await loadProfileVersions(supabase, 'ROAMING', roamingProfileId)
  return {
    ok: true,
    value: {
      roamingProfileId: (profile as any).roaming_profile_id,
      name: (profile as any).name,
      mccmncList: (profile as any).mccmnc_list,
      supplierId: (profile as any).supplier_id,
      operatorId: (profile as any).operator_id ?? null,
      carrierId: (profile as any).operator_id ?? null,
      status: (profile as any).status,
      createdAt: (profile as any).created_at,
      updatedAt: (profile as any).updated_at,
      currentVersion: mapProfileVersion(versions[0] ?? null),
      versions: versions.map(mapProfileVersion),
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
}): Promise<ServiceResult<{ profileId: string; profileVersionId: string; status: string; effectiveFrom: string }>> {
  if (!isValidUuid(apnProfileId)) return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'APN profile not found.')
  const result = await publishProfileVersion({ supabase, profileType: 'APN', profileId: apnProfileId })
  if (!result.ok) return result
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'APN_PROFILE_PUBLISHED',
    target_type: 'APN_PROFILE',
    target_id: apnProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: result.value,
  })
  return result
}

export async function publishRoamingProfile({
  supabase,
  roamingProfileId,
  audit,
}: {
  supabase: SupabaseClient
  roamingProfileId: string
  audit?: AuditContext
}): Promise<ServiceResult<{ profileId: string; profileVersionId: string; status: string; effectiveFrom: string }>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const result = await publishProfileVersion({ supabase, profileType: 'ROAMING', profileId: roamingProfileId })
  if (!result.ok) return result
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'ROAMING_PROFILE_PUBLISHED',
    target_type: 'ROAMING_PROFILE',
    target_id: roamingProfileId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: result.value,
  })
  return result
}
