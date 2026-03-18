type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string>; suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type WxClient = {
  getSimStatus: (iccid: string) => Promise<any>
}

type ErrorResult = {
  ok: false
  status: number
  code: string
  message: string
}

type OkResult<T> = {
  ok: true
  value: T
}

type OnlineStatus = 'ONLINE' | 'OFFLINE'
type RegistrationStatus = 'REGISTERED_HOME' | 'REGISTERED_ROAMING' | 'NOT_REGISTERED' | 'DENIED'
type LocationType = 'CELL_BASED' | 'GPS'

type ConnectivityStatus = {
  iccid: string
  onlineStatus: OnlineStatus
  registrationStatus: RegistrationStatus
  lastActiveTime: string | null
  ipAddress: string | null
  ratType: string | null
  servingCellId: string | null
  servingMccMnc: string | null
  apn: string | null
  sessionUptime: number | null
}

type LocationInfo = {
  iccid: string
  locationType: LocationType
  latitude: number | null
  longitude: number | null
  accuracy: number | null
  timestamp: string | null
  visitedMccMnc: string | null
  country: string | null
  cellInfo: {
    mcc: string | null
    mnc: string | null
    lac: string | null
    cellId: string | null
  }
}

type ConnectivityInput = {
  supabase: SupabaseClient
  wxClient: WxClient | null
  iccid: string
  enterpriseId?: string | null
}

type ResetConnectionInput = {
  supabase: SupabaseClient
  iccid: string
  enterpriseId?: string | null
  resellerId?: string | null
  actorUserId?: string | null
  traceId?: string | null
  reason?: string | null
  idempotencyKey?: string | null
}

function toError(status: number, code: string, message: string): ErrorResult {
  return { ok: false, status, code, message }
}

function normalizeDate(value: unknown) {
  if (!value) return null
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function pickValue(obj: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key]
  }
  return null
}

function mapOnlineStatus(value: unknown): OnlineStatus | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'ONLINE' : 'OFFLINE'
  if (typeof value === 'number') return value > 0 ? 'ONLINE' : 'OFFLINE'
  const raw = String(value).trim().toUpperCase()
  if (!raw) return null
  if (raw.includes('ONLINE') || raw.includes('CONNECTED') || raw === 'ON' || raw === 'ACTIVE') return 'ONLINE'
  if (raw.includes('OFF') || raw.includes('DISCONNECT')) return 'OFFLINE'
  return null
}

function mapRegistrationStatus(value: unknown): RegistrationStatus | null {
  if (value === null || value === undefined) return null
  const raw = String(value).trim().toUpperCase()
  if (!raw) return null
  if (raw.includes('ROAM')) return 'REGISTERED_ROAMING'
  if (raw.includes('HOME')) return 'REGISTERED_HOME'
  if (raw.includes('DENIED')) return 'DENIED'
  if (raw.includes('NOT')) return 'NOT_REGISTERED'
  return null
}

function parseMccMnc(value: unknown) {
  if (!value) return { mcc: null, mnc: null }
  const raw = String(value).trim()
  if (!raw) return { mcc: null, mnc: null }
  const match = raw.match(/^(\d{3})-?(\d{2,3})$/)
  if (!match) return { mcc: null, mnc: null }
  const mcc = match[1]
  const mnc = match[2].length === 2 ? `0${match[2]}` : match[2]
  return { mcc, mnc }
}

async function loadSim(supabase: SupabaseClient, iccid: string, enterpriseId?: string | null) {
  const tenantFilter = enterpriseId ? `&enterprise_id=eq.${encodeURIComponent(String(enterpriseId))}` : ''
  const rows = await supabase.select(
    'sims',
    `select=sim_id,iccid,enterprise_id,apn,supplier_id,operators(name,business_operator_id,business_operators(name,mcc,mnc)),suppliers(name)&iccid=eq.${encodeURIComponent(iccid)}${tenantFilter}&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
}

async function loadLatestUsage(supabase: SupabaseClient, iccid: string, enterpriseId?: string | null) {
  const tenantFilter = enterpriseId ? `&enterprise_id=eq.${encodeURIComponent(String(enterpriseId))}` : ''
  const rows = await supabase.select(
    'usage_daily_summary',
    `select=created_at,visited_mccmnc,apn,rat&iccid=eq.${encodeURIComponent(iccid)}${tenantFilter}&order=usage_day.desc&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
}

function extractUpstreamData(response: any) {
  if (!response) return null
  let data = response?.data ?? response?.result ?? response?.payload ?? response
  if (Array.isArray(data)) {
    data = data[0]
  }
  if (!data || typeof data !== 'object') return null
  return data as Record<string, any>
}

function buildStatusFromUpstream(data: Record<string, any>) {
  const onlineStatus = mapOnlineStatus(pickValue(data, ['onlineStatus', 'online_status', 'online', 'status', 'state', 'linkStatus', 'link_status']))
  const registrationStatus = mapRegistrationStatus(
    pickValue(data, ['registrationStatus', 'regStatus', 'registration_status', 'networkStatus', 'network_status', 'roamingStatus', 'roaming_status'])
  )
  const ipAddress = pickValue(data, ['ipAddress', 'ip', 'ip_address', 'ipAddr'])
  const ratType = pickValue(data, ['ratType', 'rat', 'rat_type', 'accessType'])
  const servingCellId = pickValue(data, ['servingCellId', 'cellId', 'cell_id', 'eci'])
  const servingMccMnc = pickValue(data, ['servingMccMnc', 'mccmnc', 'plmn', 'visitedMccMnc', 'visited_mccmnc'])
  const apn = pickValue(data, ['apn'])
  const sessionUptime = pickValue(data, ['sessionUptime', 'session_uptime', 'uptime'])
  const lastActiveTime = normalizeDate(
    pickValue(data, ['lastActiveTime', 'last_active_time', 'activeTime', 'lastOnlineTime', 'last_online_time'])
  )
  return {
    onlineStatus,
    registrationStatus,
    ipAddress: ipAddress !== null && ipAddress !== undefined ? String(ipAddress) : null,
    ratType: ratType !== null && ratType !== undefined ? String(ratType) : null,
    servingCellId: servingCellId !== null && servingCellId !== undefined ? String(servingCellId) : null,
    servingMccMnc: servingMccMnc !== null && servingMccMnc !== undefined ? String(servingMccMnc) : null,
    apn: apn !== null && apn !== undefined ? String(apn) : null,
    sessionUptime: sessionUptime !== null && sessionUptime !== undefined ? Number(sessionUptime) : null,
    lastActiveTime,
  }
}

function buildLocationFromUpstream(data: Record<string, any>) {
  const latitude = pickValue(data, ['latitude', 'lat'])
  const longitude = pickValue(data, ['longitude', 'lng', 'lon'])
  const accuracy = pickValue(data, ['accuracy'])
  const locationTypeRaw = pickValue(data, ['locationType', 'location_type', 'locationSource', 'location_source'])
  const locationType: LocationType = String(locationTypeRaw || '').toUpperCase() === 'GPS' ? 'GPS' : 'CELL_BASED'
  const timestamp = normalizeDate(pickValue(data, ['timestamp', 'time', 'locationTime', 'location_time']))
  const servingMccMnc = pickValue(data, ['servingMccMnc', 'mccmnc', 'plmn', 'visitedMccMnc', 'visited_mccmnc'])
  const cellId = pickValue(data, ['servingCellId', 'cellId', 'cell_id', 'eci'])
  const lac = pickValue(data, ['lac', 'lac_id'])
  const parsed = parseMccMnc(servingMccMnc)
  return {
    latitude: latitude !== null && latitude !== undefined ? Number(latitude) : null,
    longitude: longitude !== null && longitude !== undefined ? Number(longitude) : null,
    accuracy: accuracy !== null && accuracy !== undefined ? Number(accuracy) : null,
    locationType,
    timestamp,
    cellInfo: {
      mcc: parsed.mcc,
      mnc: parsed.mnc,
      lac: lac !== null && lac !== undefined ? String(lac) : null,
      cellId: cellId !== null && cellId !== undefined ? String(cellId) : null,
    },
  }
}

async function fetchUpstreamStatus(wxClient: WxClient | null, iccid: string) {
  if (!wxClient) return null
  const res = await wxClient.getSimStatus(iccid)
  return extractUpstreamData(res)
}

function resolveRegistrationStatus(visitedMccMnc: string | null, carrierMcc: string | null, carrierMnc: string | null) {
  if (!visitedMccMnc) return 'NOT_REGISTERED' as const
  const parsed = parseMccMnc(visitedMccMnc)
  if (parsed.mcc && parsed.mnc && carrierMcc && carrierMnc) {
    if (parsed.mcc === carrierMcc && parsed.mnc === carrierMnc) return 'REGISTERED_HOME' as const
    return 'REGISTERED_ROAMING' as const
  }
  return 'REGISTERED_ROAMING' as const
}

function resolveOnlineStatus(lastActiveTime: string | null) {
  if (!lastActiveTime) return 'OFFLINE' as const
  const last = new Date(lastActiveTime).getTime()
  if (Number.isNaN(last)) return 'OFFLINE' as const
  return Date.now() - last < 7 * 24 * 3600 * 1000 ? 'ONLINE' : 'OFFLINE'
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

export async function getConnectivityStatus(input: ConnectivityInput): Promise<OkResult<ConnectivityStatus> | ErrorResult> {
  const { supabase, wxClient, iccid, enterpriseId } = input
  const sim = await loadSim(supabase, iccid, enterpriseId)
  if (!sim) return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  const usage = await loadLatestUsage(supabase, iccid, enterpriseId)
  const upstreamData = await fetchUpstreamStatus(wxClient, iccid)
  const upstreamStatus = upstreamData ? buildStatusFromUpstream(upstreamData) : null
  const lastActiveTime = upstreamStatus?.lastActiveTime ?? normalizeDate(usage?.created_at)
  const servingMccMnc = upstreamStatus?.servingMccMnc ?? (usage?.visited_mccmnc ? String(usage.visited_mccmnc) : null)
  const businessOperator = sim?.operators?.business_operators ?? null
  const registrationStatus = upstreamStatus?.registrationStatus ?? resolveRegistrationStatus(servingMccMnc, businessOperator?.mcc ?? null, businessOperator?.mnc ?? null)
  const onlineStatus = upstreamStatus?.onlineStatus ?? resolveOnlineStatus(lastActiveTime)
  return {
    ok: true,
    value: {
      iccid: String(sim.iccid),
      onlineStatus,
      registrationStatus,
      lastActiveTime,
      ipAddress: upstreamStatus?.ipAddress ?? null,
      ratType: upstreamStatus?.ratType ?? (usage?.rat ? String(usage.rat) : null),
      servingCellId: upstreamStatus?.servingCellId ?? null,
      servingMccMnc,
      apn: upstreamStatus?.apn ?? (usage?.apn ? String(usage.apn) : sim.apn ? String(sim.apn) : null),
      sessionUptime: upstreamStatus?.sessionUptime ?? null,
    },
  }
}

export async function getLocation(input: ConnectivityInput): Promise<OkResult<LocationInfo> | ErrorResult> {
  const { supabase, wxClient, iccid, enterpriseId } = input
  const sim = await loadSim(supabase, iccid, enterpriseId)
  if (!sim) return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  const usage = await loadLatestUsage(supabase, iccid, enterpriseId)
  const upstreamData = await fetchUpstreamStatus(wxClient, iccid)
  const upstreamLocation = upstreamData ? buildLocationFromUpstream(upstreamData) : null
  const servingMccMnc = upstreamLocation?.cellInfo?.mcc && upstreamLocation?.cellInfo?.mnc
    ? `${upstreamLocation.cellInfo.mcc}-${upstreamLocation.cellInfo.mnc}`
    : usage?.visited_mccmnc
  const visitedMccMnc = servingMccMnc ? String(servingMccMnc) : null
  const parsed = parseMccMnc(servingMccMnc)
  const timestamp = upstreamLocation?.timestamp ?? normalizeDate(usage?.created_at)
  return {
    ok: true,
    value: {
      iccid: String(sim.iccid),
      locationType: upstreamLocation?.locationType ?? 'CELL_BASED',
      latitude: upstreamLocation?.latitude ?? null,
      longitude: upstreamLocation?.longitude ?? null,
      accuracy: upstreamLocation?.accuracy ?? null,
      timestamp,
      visitedMccMnc,
      country: null,
      cellInfo: {
        mcc: parsed.mcc,
        mnc: parsed.mnc,
        lac: upstreamLocation?.cellInfo?.lac ?? null,
        cellId: upstreamLocation?.cellInfo?.cellId ?? null,
      },
    },
  }
}

export async function getLocationHistory(input: ConnectivityInput & { from?: string | null; to?: string | null; limit?: number | null; offset?: number | null }) {
  const { supabase, iccid, enterpriseId, from, to, limit, offset } = input
  const sim = await loadSim(supabase, iccid, enterpriseId)
  if (!sim) return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  const filters: string[] = [`iccid=eq.${encodeURIComponent(iccid)}`]
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(String(enterpriseId))}`)
  if (from) filters.push(`usage_day=gte.${encodeURIComponent(String(from).slice(0, 10))}`)
  if (to) filters.push(`usage_day=lte.${encodeURIComponent(String(to).slice(0, 10))}`)
  const limitValue = Number.isFinite(limit as number) ? Math.max(1, Number(limit)) : 50
  const offsetValue = Number.isFinite(offset as number) ? Math.max(0, Number(offset)) : 0
  const { data, total } = await supabase.selectWithCount(
    'usage_daily_summary',
    `select=usage_day,created_at,visited_mccmnc&${filters.join('&')}&order=usage_day.desc&limit=${encodeURIComponent(String(limitValue))}&offset=${encodeURIComponent(String(offsetValue))}`
  )
  const rows = Array.isArray(data) ? data : []
  const items = rows.map((r: any) => {
    const parsed = parseMccMnc(r.visited_mccmnc)
    const visited = r.visited_mccmnc ? String(r.visited_mccmnc) : null
    return {
      iccid: String(sim.iccid),
      locationType: 'CELL_BASED' as const,
      latitude: null,
      longitude: null,
      accuracy: null,
      timestamp: normalizeDate(r.created_at) ?? (r.usage_day ? new Date(`${r.usage_day}T00:00:00.000Z`).toISOString() : null),
      visitedMccMnc: visited,
      country: null,
      cellInfo: {
        mcc: parsed.mcc,
        mnc: parsed.mnc,
        lac: null,
        cellId: null,
      },
    }
  })
  return { ok: true, value: { items, total: typeof total === 'number' ? total : items.length } }
}

export async function requestResetConnection(input: ResetConnectionInput): Promise<OkResult<{ jobId: string | null; simId: string | null }> | ErrorResult> {
  const { supabase, iccid, enterpriseId, resellerId, actorUserId, traceId, reason, idempotencyKey } = input
  if (!iccid) return toError(400, 'BAD_REQUEST', 'iccid is required.')
  const sim = await loadSim(supabase, iccid, enterpriseId)
  if (!sim) return toError(404, 'RESOURCE_NOT_FOUND', 'sim not found.')
  const existing = await findIdempotentJobByKey(supabase, 'SIM_RESET_CONNECTION', idempotencyKey ?? null)
  if (existing) {
    return { ok: true, value: { jobId: existing.job_id ?? null, simId: sim.sim_id ?? null } }
  }
  const nowIso = new Date().toISOString()
  const jobRows = await insertJobWithFallback(supabase, {
    job_type: 'SIM_RESET_CONNECTION',
    status: 'QUEUED',
    progress_processed: 0,
    progress_total: 1,
    request_id: traceId ? String(traceId) : null,
    actor_user_id: actorUserId ?? null,
    reseller_id: resellerId ?? null,
    customer_id: enterpriseId ?? null,
    idempotency_key: idempotencyKey ?? null,
    payload: {
      iccid,
      simId: sim.sim_id ?? null,
      reason: reason ?? null,
      requestedAt: nowIso,
    },
  })
  const job = Array.isArray(jobRows) ? (jobRows[0] as Record<string, any>) : null
  return { ok: true, value: { jobId: job?.job_id ?? null, simId: sim.sim_id ?? null } }
}
