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
  const mnc = exact[2].length === 2 ? `0${exact[2]}` : exact[2]
  return `${exact[1]}-${mnc}`
}

async function validateCarrierSupplierLink(supabase: SupabaseClient, supplierId: string | null, carrierId: string | null) {
  if (!supplierId || !carrierId) return true
  const rows = await supabase.select(
    'supplier_carriers',
    `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&carrier_id=eq.${encodeURIComponent(carrierId)}&limit=1`
  )
  return Array.isArray(rows) && rows.length > 0
}

async function validateRoamingMccMnc(
  supabase: SupabaseClient,
  supplierId: string,
  carrierId: string | null,
  list: unknown
) {
  const entries = Array.isArray(list) ? list : []
  for (const raw of entries) {
    const normalized = normalizeMccMnc(raw)
    if (!normalized) return { ok: false as const, message: `Invalid mccmnc value: ${raw}` }
    if (normalized.endsWith('-*')) continue
    const [mcc, mnc] = normalized.split('-')
    const carriers = await supabase.select(
      'carriers',
      `select=carrier_id&mcc=eq.${encodeURIComponent(mcc)}&mnc=eq.${encodeURIComponent(mnc)}&limit=1`
    )
    const carrier = Array.isArray(carriers) ? carriers[0] : null
    if (!(carrier as any)?.carrier_id) return { ok: false as const, message: `Unknown carrier for mccmnc ${normalized}` }
    if (carrierId && String((carrier as any).carrier_id) !== String(carrierId)) {
      return { ok: false as const, message: `mccmnc ${normalized} not in carrier scope` }
    }
    const ok = await validateCarrierSupplierLink(supabase, supplierId, String((carrier as any).carrier_id))
    if (!ok) return { ok: false as const, message: `mccmnc ${normalized} not linked to supplier` }
  }
  return { ok: true as const }
}

async function loadProfile(supabase: SupabaseClient, table: string, idField: string, idValue: string) {
  const rows = await supabase.select(
    table,
    `select=*&${idField}=eq.${encodeURIComponent(idValue)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadLatestProfileVersion(supabase: SupabaseClient, profileType: string, profileId: string) {
  const rows = await supabase.select(
    'profile_versions',
    `select=profile_version_id,profile_type,profile_id,version,status,effective_from,effective_to,config,created_at&profile_type=eq.${encodeURIComponent(profileType)}&profile_id=eq.${encodeURIComponent(profileId)}&order=version.desc&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadProfileVersions(supabase: SupabaseClient, profileType: string, profileId: string) {
  const rows = await supabase.select(
    'profile_versions',
    `select=profile_version_id,profile_type,profile_id,version,status,effective_from,effective_to,config,created_at&profile_type=eq.${encodeURIComponent(profileType)}&profile_id=eq.${encodeURIComponent(profileId)}&order=version.desc`
  )
  return Array.isArray(rows) ? rows : []
}

function mapProfileVersion(version: any) {
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
}): Promise<ServiceResult<{ profileVersionId: string; status: string; effectiveFrom: string }>> {
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
}): Promise<ServiceResult<{ profileVersionId: string; status: string }>> {
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
  return { ok: true, value: { profileVersionId, status: 'CANCELLED' } }
}

export async function createApnProfile({
  supabase,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<{ apnProfileId: string; profileVersionId: string | null; version: number; status: string; createdAt: string }>> {
  const name = String(payload?.name || '').trim()
  const apn = String(payload?.apn || '').trim()
  const authType = payload?.authType ? String(payload.authType) : 'NONE'
  const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null
  const carrierId = payload?.carrierId ? String(payload.carrierId).trim() : null
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!apn) return toError(400, 'BAD_REQUEST', 'apn is required.')
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
  }
  if (carrierId && !isValidUuid(carrierId)) {
    return toError(400, 'BAD_REQUEST', 'carrierId must be a valid uuid.')
  }
  if (carrierId) {
    const linked = await validateCarrierSupplierLink(supabase, supplierId, carrierId)
    if (!linked) return toError(400, 'BAD_REQUEST', 'carrierId is not linked to supplierId.')
  }
  const rows = await supabase.insert(
    'apn_profiles',
    {
      name,
      apn,
      auth_type: authType,
      username: payload?.username ? String(payload.username) : null,
      password_ref: payload?.passwordRef ? String(payload.passwordRef) : null,
      supplier_id: supplierId,
      carrier_id: carrierId,
      status: 'ACTIVE',
    },
    { returning: 'representation' }
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  if (!(profile as any)?.apn_profile_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create APN profile.')
  const versionRows = await supabase.insert(
    'profile_versions',
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
    { returning: 'representation' }
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
      carrierId,
    },
  })
  return {
    ok: true,
    value: {
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
}): Promise<ServiceResult<{ roamingProfileId: string; profileVersionId: string | null; version: number; status: string; createdAt: string }>> {
  const name = String(payload?.name || '').trim()
  const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null
  const carrierId = payload?.carrierId ? String(payload.carrierId).trim() : null
  const list = Array.isArray(payload?.mccmncList) ? payload.mccmncList : []
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
  }
  if (carrierId && !isValidUuid(carrierId)) {
    return toError(400, 'BAD_REQUEST', 'carrierId must be a valid uuid.')
  }
  if (!list.length) return toError(400, 'BAD_REQUEST', 'mccmncList is required.')
  const linked = carrierId ? await validateCarrierSupplierLink(supabase, supplierId, carrierId) : true
  if (!linked) return toError(400, 'BAD_REQUEST', 'carrierId is not linked to supplierId.')
  const validate = await validateRoamingMccMnc(supabase, supplierId, carrierId, list)
  if (!validate.ok) return toError(400, 'BAD_REQUEST', validate.message)
  const normalizedList = list.map(normalizeMccMnc).filter(Boolean)
  const rows = await supabase.insert(
    'roaming_profiles',
    {
      name,
      mccmnc_list: normalizedList,
      supplier_id: supplierId,
      carrier_id: carrierId,
      status: 'ACTIVE',
    },
    { returning: 'representation' }
  )
  const profile = Array.isArray(rows) ? rows[0] : null
  if (!(profile as any)?.roaming_profile_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create roaming profile.')
  const versionRows = await supabase.insert(
    'profile_versions',
    {
      profile_type: 'ROAMING',
      profile_id: (profile as any).roaming_profile_id,
      version: 1,
      status: 'DRAFT',
      config: {
        mccmncList: normalizedList,
      },
    },
    { returning: 'representation' }
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
      supplierId,
      carrierId,
      mccmncList: normalizedList,
    },
  })
  return {
    ok: true,
    value: {
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
  const rows = await supabase.insert(
    'profile_versions',
    {
      profile_type: 'APN',
      profile_id: apnProfileId,
      version: nextVersion,
      status: 'DRAFT',
      config: { apn, authType, username, passwordRef },
    },
    { returning: 'representation' }
  )
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
}): Promise<ServiceResult<unknown>> {
  if (!isValidUuid(roamingProfileId)) return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
  const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId)
  if (!profile) return toError(404, 'NOT_FOUND', 'Roaming profile not found.')
  const list = Array.isArray(payload?.mccmncList) ? payload.mccmncList : (profile as any).mccmnc_list
  const supplierId = String((profile as any).supplier_id)
  const carrierId = (profile as any).carrier_id ? String((profile as any).carrier_id) : null
  const validate = await validateRoamingMccMnc(supabase, supplierId, carrierId, list)
  if (!validate.ok) return toError(400, 'BAD_REQUEST', validate.message)
  const normalizedList = (Array.isArray(list) ? list : []).map(normalizeMccMnc).filter(Boolean)
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

export async function listApnProfiles({
  supabase,
  supplierId,
  carrierId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  supplierId?: string | null
  carrierId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number }>> {
  const filters = []
  if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(String(supplierId))}`)
  if (carrierId) filters.push(`carrier_id=eq.${encodeURIComponent(String(carrierId))}`)
  if (status) filters.push(`status=eq.${encodeURIComponent(String(status))}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const rows = await supabase.select(
    'apn_profiles',
    `select=apn_profile_id,name,apn,auth_type,username,password_ref,supplier_id,carrier_id,status,created_at,updated_at&order=created_at.desc${filterQs}`
  )
  const profiles = Array.isArray(rows) ? rows : []
  const ids = profiles.map((p: any) => p.apn_profile_id).filter(Boolean)
  let versions: any[] = []
  if (ids.length) {
    const idFilter = ids.map((id) => encodeURIComponent(id)).join(',')
    const vRows = await supabase.select(
      'profile_versions',
      `select=profile_version_id,profile_id,version,status,effective_from,effective_to,config,created_at&profile_type=eq.APN&profile_id=in.(${idFilter})&order=version.desc`
    )
    versions = Array.isArray(vRows) ? vRows : []
  }
  const latestByProfile = new Map<string, any>()
  for (const v of versions) {
    if (!latestByProfile.has(v.profile_id)) latestByProfile.set(v.profile_id, v)
  }
  let items = profiles.map((p: any) => ({
    apnProfileId: p.apn_profile_id,
    name: p.name,
    apn: p.apn,
    authType: p.auth_type,
    supplierId: p.supplier_id,
    carrierId: p.carrier_id,
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
  carrierId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  supplierId?: string | null
  carrierId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: unknown[]; total: number }>> {
  const filters = []
  if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(String(supplierId))}`)
  if (carrierId) filters.push(`carrier_id=eq.${encodeURIComponent(String(carrierId))}`)
  if (status) filters.push(`status=eq.${encodeURIComponent(String(status))}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const rows = await supabase.select(
    'roaming_profiles',
    `select=roaming_profile_id,name,mccmnc_list,supplier_id,carrier_id,status,created_at,updated_at&order=created_at.desc${filterQs}`
  )
  const profiles = Array.isArray(rows) ? rows : []
  const ids = profiles.map((p: any) => p.roaming_profile_id).filter(Boolean)
  let versions: any[] = []
  if (ids.length) {
    const idFilter = ids.map((id) => encodeURIComponent(id)).join(',')
    const vRows = await supabase.select(
      'profile_versions',
      `select=profile_version_id,profile_id,version,status,effective_from,effective_to,config,created_at&profile_type=eq.ROAMING&profile_id=in.(${idFilter})&order=version.desc`
    )
    versions = Array.isArray(vRows) ? vRows : []
  }
  const latestByProfile = new Map<string, any>()
  for (const v of versions) {
    if (!latestByProfile.has(v.profile_id)) latestByProfile.set(v.profile_id, v)
  }
  let items = profiles.map((p: any) => ({
    roamingProfileId: p.roaming_profile_id,
    name: p.name,
    mccmncList: p.mccmnc_list,
    supplierId: p.supplier_id,
    carrierId: p.carrier_id,
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
      carrierId: (profile as any).carrier_id,
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
      carrierId: (profile as any).carrier_id,
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
}): Promise<ServiceResult<{ profileVersionId: string; status: string; effectiveFrom: string }>> {
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
}): Promise<ServiceResult<{ profileVersionId: string; status: string; effectiveFrom: string }>> {
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
