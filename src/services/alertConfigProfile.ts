import {
  ALERT_DELIVERY_CHANNELS,
  ALERT_SCOPE_TYPES,
  ALERT_SEVERITIES,
  ALERT_THRESHOLD_UNITS,
  ALERT_TYPES,
  type AlertScopeType,
  type AlertSeverity,
  type AlertThresholdUnit,
  type AlertType,
} from './alertRuleConfig.js'
import { getAlertType, listAlertTypes, mapAlertTypeCatalogRow, type AlertTypeCatalogItem } from './alertTypeCatalog.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  selectWithCount?: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  rpc?: (functionName: string, args?: Record<string, unknown>) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

export type AlertConfigProfileItem = {
  profileId: string | null
  scopeType: AlertScopeType
  resellerId: string | null
  enterpriseId: string | null
  status: 'ACTIVE' | 'INACTIVE'
  name: string | null
  description: string | null
  version: number
  createdBy: string | null
  updatedBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type AlertConfigItem = {
  itemId: string | null
  profileId: string | null
  alertType: AlertType
  enabled: boolean
  severity: AlertSeverity
  thresholdValue: number | null
  thresholdUnit: AlertThresholdUnit | null
  windowMinutes: number | null
  suppressMinutes: number
  deliveryChannels: string[]
  deliveryTargets: Record<string, unknown>
  thresholdConfig: Record<string, unknown>
  version: number
  createdAt: string | null
  updatedAt: string | null
}

export type EffectiveAlertConfig = AlertConfigItem & {
  source: 'ENTERPRISE' | 'RESELLER' | 'PLATFORM' | 'BUILT_IN'
  scopeType: AlertScopeType
  resellerId: string | null
  enterpriseId: string | null
  profileId: string | null
}

export type AlertConfigProfileWithItems = AlertConfigProfileItem & {
  items: AlertConfigItem[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

function isValidUuid(value: unknown) {
  return UUID_RE.test(String(value ?? '').trim())
}

function normalizeEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): ServiceResult<T[number]> {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (!normalized) return toError(400, 'BAD_REQUEST', `${field} is required.`)
  if (!allowed.includes(normalized)) return toError(400, 'BAD_REQUEST', `${field} must be one of: ${allowed.join(', ')}.`)
  return { ok: true, value: normalized as T[number] }
}

function normalizeOptionalEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): ServiceResult<T[number] | null> {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null }
  return normalizeEnum(value, allowed, field)
}

function parseBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  if (typeof value === 'boolean') return value
  return ['true', '1', 'yes', 'y'].includes(String(value).trim().toLowerCase())
}

function parseNumberOrNull(value: unknown, field: string): ServiceResult<number | null> {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null }
  const n = Number(value)
  if (!Number.isFinite(n)) return toError(400, 'BAD_REQUEST', `${field} must be a number.`)
  return { ok: true, value: n }
}

function parsePositiveIntegerOrNull(value: unknown, field: string): ServiceResult<number | null> {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return toError(400, 'BAD_REQUEST', `${field} must be a positive integer.`)
  return { ok: true, value: Math.floor(n) }
}

function parseNonNegativeInteger(value: unknown, fallback: number, field: string): ServiceResult<number> {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: fallback }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return toError(400, 'BAD_REQUEST', `${field} must be a non-negative integer.`)
  return { ok: true, value: Math.floor(n) }
}

function parseStringArray<T extends readonly string[]>(value: unknown, allowed: T, field: string): ServiceResult<T[number][]> {
  const raw = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]
  const values = raw.map((v) => String(v).trim().toUpperCase()).filter(Boolean)
  if (!values.length) return toError(400, 'BAD_REQUEST', `${field} must contain at least one value.`)
  for (const item of values) {
    if (!allowed.includes(item)) return toError(400, 'BAD_REQUEST', `${field} must contain only: ${allowed.join(', ')}.`)
  }
  return { ok: true, value: Array.from(new Set(values)) as T[number][] }
}

function parseObject(value: unknown, field: string): ServiceResult<Record<string, unknown>> {
  if (value === undefined || value === null || String(value).trim?.() === '') return { ok: true, value: {} }
  if (typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> }
  return toError(400, 'BAD_REQUEST', `${field} must be an object.`)
}

function toNumberOrNull(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toIsoOrNull(value: unknown) {
  if (!value) return null
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function mapProfileRow(row: any): AlertConfigProfileItem {
  return {
    profileId: row?.config_profile_id ?? null,
    scopeType: String(row?.scope_type ?? 'PLATFORM') as AlertScopeType,
    resellerId: row?.reseller_id ?? null,
    enterpriseId: row?.enterprise_id ?? null,
    status: String(row?.status ?? 'ACTIVE') as 'ACTIVE' | 'INACTIVE',
    name: row?.name ?? null,
    description: row?.description ?? null,
    version: Number(row?.version ?? 1),
    createdBy: row?.created_by ?? null,
    updatedBy: row?.updated_by ?? null,
    createdAt: toIsoOrNull(row?.created_at),
    updatedAt: toIsoOrNull(row?.updated_at),
  }
}

function mapItemRow(row: any): AlertConfigItem {
  return {
    itemId: row?.config_item_id ?? null,
    profileId: row?.config_profile_id ?? null,
    alertType: String(row?.alert_type ?? 'POOL_USAGE_HIGH') as AlertType,
    enabled: row?.enabled !== false,
    severity: String(row?.severity ?? 'P2') as AlertSeverity,
    thresholdValue: toNumberOrNull(row?.threshold_value),
    thresholdUnit: row?.threshold_unit ? String(row.threshold_unit) as AlertThresholdUnit : null,
    windowMinutes: toNumberOrNull(row?.window_minutes),
    suppressMinutes: Number(row?.suppress_minutes ?? 30),
    deliveryChannels: Array.isArray(row?.delivery_channels) ? row.delivery_channels.map(String) : ['PORTAL'],
    deliveryTargets: row?.delivery_targets && typeof row.delivery_targets === 'object' ? row.delivery_targets : {},
    thresholdConfig: row?.threshold_config && typeof row.threshold_config === 'object' ? row.threshold_config : {},
    version: Number(row?.version ?? 1),
    createdAt: toIsoOrNull(row?.created_at),
    updatedAt: toIsoOrNull(row?.updated_at),
  }
}

async function loadTenant(supabase: SupabaseClient, tenantId: string, tenantType: 'RESELLER' | 'ENTERPRISE') {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(tenantId)}&tenant_type=eq.${tenantType}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] as any ?? null : null
}

async function validateProfileScope(supabase: SupabaseClient, payload: { scopeType: AlertScopeType; resellerId: string | null; enterpriseId: string | null }) {
  if (payload.scopeType === 'PLATFORM') {
    if (payload.resellerId || payload.enterpriseId) return toError(400, 'BAD_REQUEST', 'PLATFORM profiles must not include resellerId or enterpriseId.')
    return { ok: true as const, value: null }
  }
  if (!payload.resellerId || !isValidUuid(payload.resellerId)) return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
  const reseller = await loadTenant(supabase, payload.resellerId, 'RESELLER')
  if (!reseller) return toError(404, 'RESOURCE_NOT_FOUND', `reseller ${payload.resellerId} not found.`)
  if (payload.scopeType === 'RESELLER') {
    if (payload.enterpriseId) return toError(400, 'BAD_REQUEST', 'RESELLER profiles must not include enterpriseId.')
    return { ok: true as const, value: null }
  }
  if (!payload.enterpriseId || !isValidUuid(payload.enterpriseId)) return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  const enterprise = await loadTenant(supabase, payload.enterpriseId, 'ENTERPRISE')
  if (!enterprise) return toError(404, 'RESOURCE_NOT_FOUND', `enterprise ${payload.enterpriseId} not found.`)
  if (String(enterprise.parent_id ?? '') !== payload.resellerId) return toError(403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
  return { ok: true as const, value: null }
}

function profileScopeFilters(scopeType: AlertScopeType, resellerId?: string | null, enterpriseId?: string | null) {
  const filters = [`scope_type=eq.${encodeURIComponent(scopeType)}`]
  if (scopeType === 'PLATFORM') filters.push('reseller_id=is.null', 'enterprise_id=is.null')
  if (scopeType === 'RESELLER') filters.push(`reseller_id=eq.${encodeURIComponent(resellerId ?? '')}`, 'enterprise_id=is.null')
  if (scopeType === 'ENTERPRISE') {
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId ?? '')}`)
    filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId ?? '')}`)
  }
  return filters
}

function parseProfilePayload(payload: Record<string, unknown>) {
  const scopeType = normalizeEnum(payload.scopeType, ALERT_SCOPE_TYPES, 'scopeType')
  if (!scopeType.ok) return scopeType
  const status = String(payload.status ?? 'ACTIVE').trim().toUpperCase()
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return toError(400, 'BAD_REQUEST', 'status must be ACTIVE or INACTIVE.')
  return {
    ok: true as const,
    value: {
      scopeType: scopeType.value,
      resellerId: payload.resellerId ? String(payload.resellerId).trim() : null,
      enterpriseId: payload.enterpriseId ? String(payload.enterpriseId).trim() : null,
      status: status as 'ACTIVE' | 'INACTIVE',
      name: payload.name === undefined || payload.name === null ? null : String(payload.name),
      description: payload.description === undefined || payload.description === null ? null : String(payload.description),
    },
  }
}

async function loadAllowedCatalogForScope(supabase: SupabaseClient, scopeType: AlertScopeType) {
  const result = await listAlertTypes({ supabase, enabled: true, scopeType })
  if (!result.ok) return result
  const items = result.value.items
    .filter((item) => item.enabled && item.allowedScopeTypes.includes(scopeType))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.alertType.localeCompare(b.alertType))
  return { ok: true as const, value: items }
}

function parseFullProfileItems({
  payloadItems,
  catalogItems,
}: {
  payloadItems: unknown
  catalogItems: AlertTypeCatalogItem[]
}): ServiceResult<Array<AlertConfigItem & { itemId: null; profileId: null; version: 1; createdAt: null; updatedAt: null }>> {
  if (!Array.isArray(payloadItems)) return toError(400, 'BAD_REQUEST', 'items must be an array.')
  if (!catalogItems.length) return toError(400, 'BAD_REQUEST', 'no alert types are configurable for this profile scope.')
  if (!payloadItems.length) return toError(400, 'BAD_REQUEST', 'items must contain all allowed alert types for this scope.')
  const catalogByType = new Map(catalogItems.map((item) => [item.alertType, item]))
  const seen = new Set<AlertType>()
  const parsedItems: Array<AlertConfigItem & { itemId: null; profileId: null; version: 1; createdAt: null; updatedAt: null }> = []
  for (const rawItem of payloadItems) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      return toError(400, 'BAD_REQUEST', 'items entries must be objects.')
    }
    const itemPayload = rawItem as Record<string, unknown>
    const alertType = normalizeEnum(itemPayload.alertType, ALERT_TYPES, 'items.alertType')
    if (!alertType.ok) return alertType
    const catalog = catalogByType.get(alertType.value)
    if (!catalog) return toError(400, 'BAD_REQUEST', `alertType ${alertType.value} is not allowed for this profile scope.`)
    if (seen.has(alertType.value)) return toError(400, 'BAD_REQUEST', `duplicate alertType ${alertType.value} in items.`)
    seen.add(alertType.value)
    const parsed = itemPayloadFromCatalog(catalog, itemPayload)
    if (!parsed.ok) return parsed
    parsedItems.push({
      itemId: null,
      profileId: null,
      alertType: alertType.value,
      enabled: parsed.value.enabled,
      severity: parsed.value.severity,
      thresholdValue: parsed.value.thresholdValue,
      thresholdUnit: parsed.value.thresholdUnit,
      windowMinutes: parsed.value.windowMinutes,
      suppressMinutes: parsed.value.suppressMinutes,
      deliveryChannels: parsed.value.deliveryChannels,
      deliveryTargets: parsed.value.deliveryTargets,
      thresholdConfig: parsed.value.thresholdConfig,
      version: 1,
      createdAt: null,
      updatedAt: null,
    })
  }
  const missing = catalogItems.map((item) => item.alertType).filter((alertType) => !seen.has(alertType))
  if (missing.length) return toError(400, 'BAD_REQUEST', `items must include all allowed alert types for this scope. Missing: ${missing.join(', ')}.`)
  return { ok: true, value: parsedItems }
}

function itemForRpc(item: AlertConfigItem) {
  return {
    alertType: item.alertType,
    enabled: item.enabled,
    severity: item.severity,
    thresholdValue: item.thresholdValue,
    thresholdUnit: item.thresholdUnit,
    windowMinutes: item.windowMinutes,
    suppressMinutes: item.suppressMinutes,
    deliveryChannels: item.deliveryChannels,
    deliveryTargets: item.deliveryTargets,
    thresholdConfig: item.thresholdConfig,
  }
}

function rpcProfileId(result: unknown): string | null {
  const value = Array.isArray(result) ? result[0] : result
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  return obj.profileId ? String(obj.profileId) : obj.profile_id ? String(obj.profile_id) : null
}

async function loadActiveProfile(supabase: SupabaseClient, scopeType: AlertScopeType, resellerId?: string | null, enterpriseId?: string | null) {
  const rows = await supabase.select(
    'alert_config_profiles',
    `select=config_profile_id,scope_type,reseller_id,enterprise_id,status,name,description,version,created_by,updated_by,created_at,updated_at&status=eq.ACTIVE&${profileScopeFilters(scopeType, resellerId, enterpriseId).join('&')}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row ? mapProfileRow(row) : null
}

export async function listAlertConfigProfiles({
  supabase,
  scopeType,
  resellerId,
  enterpriseId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  scopeType?: unknown
  resellerId?: unknown
  enterpriseId?: unknown
  status?: unknown
  page?: unknown
  pageSize?: unknown
}): Promise<ServiceResult<{ items: AlertConfigProfileItem[]; total: number; page: number; pageSize: number }>> {
  const filters: string[] = []
  if (scopeType) {
    const parsed = normalizeEnum(scopeType, ALERT_SCOPE_TYPES, 'scopeType')
    if (!parsed.ok) return parsed
    filters.push(`scope_type=eq.${encodeURIComponent(parsed.value)}`)
  }
  if (resellerId) {
    if (!isValidUuid(resellerId)) return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    filters.push(`reseller_id=eq.${encodeURIComponent(String(resellerId))}`)
  }
  if (enterpriseId) {
    if (!isValidUuid(enterpriseId)) return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    filters.push(`enterprise_id=eq.${encodeURIComponent(String(enterpriseId))}`)
  }
  if (status) {
    const normalizedStatus = String(status).trim().toUpperCase()
    if (!['ACTIVE', 'INACTIVE'].includes(normalizedStatus)) return toError(400, 'BAD_REQUEST', 'status must be ACTIVE or INACTIVE.')
    filters.push(`status=eq.${normalizedStatus}`)
  }
  const pageNum = Math.max(1, Number(page) || 1)
  const sizeNum = Math.min(20, Math.max(1, Number(pageSize) || 20))
  const offset = (pageNum - 1) * sizeNum
  const qs = [
    'select=config_profile_id,scope_type,reseller_id,enterprise_id,status,name,description,version,created_by,updated_by,created_at,updated_at',
    'order=scope_type.asc,created_at.desc',
    `limit=${sizeNum}`,
    `offset=${offset}`,
    ...filters,
  ].join('&')
  if (supabase.selectWithCount) {
    const { data, total } = await supabase.selectWithCount('alert_config_profiles', qs)
    const rows = Array.isArray(data) ? data : []
    return { ok: true, value: { items: rows.map(mapProfileRow), total: typeof total === 'number' ? total : rows.length, page: pageNum, pageSize: sizeNum } }
  }
  const rows = await supabase.select('alert_config_profiles', qs)
  const items = Array.isArray(rows) ? rows.map(mapProfileRow) : []
  return { ok: true, value: { items, total: items.length, page: pageNum, pageSize: sizeNum } }
}

export async function getAlertConfigProfile({ supabase, profileId }: { supabase: SupabaseClient; profileId: unknown }): Promise<ServiceResult<AlertConfigProfileItem>> {
  const id = String(profileId ?? '').trim()
  if (!isValidUuid(id)) return toError(400, 'BAD_REQUEST', 'profileId must be a valid uuid.')
  const rows = await supabase.select(
    'alert_config_profiles',
    `select=config_profile_id,scope_type,reseller_id,enterprise_id,status,name,description,version,created_by,updated_by,created_at,updated_at&config_profile_id=eq.${encodeURIComponent(id)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) return toError(404, 'RESOURCE_NOT_FOUND', 'alert config profile not found.')
  return { ok: true, value: mapProfileRow(row) }
}

export async function getAlertConfigProfileWithItems({
  supabase,
  profileId,
}: {
  supabase: SupabaseClient
  profileId: unknown
}): Promise<ServiceResult<AlertConfigProfileWithItems>> {
  const profile = await getAlertConfigProfile({ supabase, profileId })
  if (!profile.ok) return profile
  const items = await listAlertConfigItems({ supabase, profileId: profile.value.profileId })
  if (!items.ok) return items
  return { ok: true, value: { ...profile.value, items: items.value.items } }
}

async function writeAlertConfigProfileWithItems({
  supabase,
  profileId,
  payload,
  actorUserId,
}: {
  supabase: SupabaseClient
  profileId?: string | null
  payload: Record<string, unknown>
  actorUserId?: string | null
}): Promise<ServiceResult<AlertConfigProfileWithItems>> {
  if (!supabase.rpc) return toError(500, 'SERVER_ERROR', 'Supabase RPC support is required for atomic alert config profile writes.')
  const parsedProfile = parseProfilePayload(payload)
  if (!parsedProfile.ok) return parsedProfile
  const scope = await validateProfileScope(supabase, parsedProfile.value)
  if (!scope.ok) return scope
  const catalog = await loadAllowedCatalogForScope(supabase, parsedProfile.value.scopeType)
  if (!catalog.ok) return catalog
  const parsedItems = parseFullProfileItems({ payloadItems: payload.items, catalogItems: catalog.value })
  if (!parsedItems.ok) return parsedItems
  if (profileId) {
    const existing = await getAlertConfigProfile({ supabase, profileId })
    if (!existing.ok) return existing
    if (
      existing.value.scopeType !== parsedProfile.value.scopeType ||
      String(existing.value.resellerId ?? '') !== String(parsedProfile.value.resellerId ?? '') ||
      String(existing.value.enterpriseId ?? '') !== String(parsedProfile.value.enterpriseId ?? '')
    ) {
      return toError(400, 'BAD_REQUEST', 'scopeType, resellerId, and enterpriseId must match the existing profile when replacing it.')
    }
    if (parsedProfile.value.status === 'ACTIVE' && existing.value.status !== 'ACTIVE') {
      const active = await loadActiveProfile(supabase, existing.value.scopeType, existing.value.resellerId, existing.value.enterpriseId)
      if (active && active.profileId !== existing.value.profileId) return toError(409, 'CONFLICT', 'active alert config profile already exists for this scope.')
    }
  } else if (parsedProfile.value.status === 'ACTIVE') {
    const active = await loadActiveProfile(supabase, parsedProfile.value.scopeType, parsedProfile.value.resellerId, parsedProfile.value.enterpriseId)
    if (active) return toError(409, 'CONFLICT', 'active alert config profile already exists for this scope.')
  }
  const rpcResult = await supabase.rpc('replace_alert_config_profile_with_items', {
    p_profile_id: profileId ?? null,
    p_scope_type: parsedProfile.value.scopeType,
    p_reseller_id: parsedProfile.value.resellerId,
    p_enterprise_id: parsedProfile.value.enterpriseId,
    p_status: parsedProfile.value.status,
    p_name: parsedProfile.value.name,
    p_description: parsedProfile.value.description,
    p_items: parsedItems.value.map(itemForRpc),
    p_actor_user_id: actorUserId ?? null,
  })
  const savedProfileId = rpcProfileId(rpcResult) ?? profileId
  if (!savedProfileId) return toError(500, 'SERVER_ERROR', 'alert config profile write did not return a profile id.')
  return getAlertConfigProfileWithItems({ supabase, profileId: savedProfileId })
}

export async function createAlertConfigProfileWithItems({
  supabase,
  payload,
  actorUserId,
}: {
  supabase: SupabaseClient
  payload: Record<string, unknown>
  actorUserId?: string | null
}): Promise<ServiceResult<AlertConfigProfileWithItems>> {
  return writeAlertConfigProfileWithItems({ supabase, payload, actorUserId })
}

export async function replaceAlertConfigProfileWithItems({
  supabase,
  profileId,
  payload,
  actorUserId,
}: {
  supabase: SupabaseClient
  profileId: unknown
  payload: Record<string, unknown>
  actorUserId?: string | null
}): Promise<ServiceResult<AlertConfigProfileWithItems>> {
  const id = String(profileId ?? '').trim()
  if (!isValidUuid(id)) return toError(400, 'BAD_REQUEST', 'profileId must be a valid uuid.')
  return writeAlertConfigProfileWithItems({ supabase, profileId: id, payload, actorUserId })
}

export async function createAlertConfigProfile({
  supabase,
  payload,
  actorUserId,
}: {
  supabase: SupabaseClient
  payload: Record<string, unknown>
  actorUserId?: string | null
}): Promise<ServiceResult<AlertConfigProfileItem>> {
  const scopeType = normalizeEnum(payload.scopeType, ALERT_SCOPE_TYPES, 'scopeType')
  if (!scopeType.ok) return scopeType
  const parsed = {
    scopeType: scopeType.value,
    resellerId: payload.resellerId ? String(payload.resellerId).trim() : null,
    enterpriseId: payload.enterpriseId ? String(payload.enterpriseId).trim() : null,
  }
  const scope = await validateProfileScope(supabase, parsed)
  if (!scope.ok) return scope
  const existing = await loadActiveProfile(supabase, parsed.scopeType, parsed.resellerId, parsed.enterpriseId)
  const status = String(payload.status ?? 'ACTIVE').trim().toUpperCase()
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return toError(400, 'BAD_REQUEST', 'status must be ACTIVE or INACTIVE.')
  if (status === 'ACTIVE' && existing) return toError(409, 'CONFLICT', 'active alert config profile already exists for this scope.')
  const nowIso = new Date().toISOString()
  const rows = await supabase.insert('alert_config_profiles', {
    scope_type: parsed.scopeType,
    reseller_id: parsed.resellerId,
    enterprise_id: parsed.enterpriseId,
    status,
    name: payload.name ? String(payload.name) : null,
    description: payload.description ? String(payload.description) : null,
    version: 1,
    created_by: actorUserId ?? null,
    updated_by: actorUserId ?? null,
    created_at: nowIso,
    updated_at: nowIso,
  }, { returning: 'representation' })
  const row = Array.isArray(rows) ? rows[0] : null
  return { ok: true, value: mapProfileRow(row) }
}

export async function patchAlertConfigProfile({
  supabase,
  profileId,
  payload,
  actorUserId,
}: {
  supabase: SupabaseClient
  profileId: unknown
  payload: Record<string, unknown>
  actorUserId?: string | null
}): Promise<ServiceResult<AlertConfigProfileItem>> {
  const existing = await getAlertConfigProfile({ supabase, profileId })
  if (!existing.ok) return existing
  const patch: Record<string, unknown> = {}
  if (payload.status !== undefined) {
    const status = String(payload.status).trim().toUpperCase()
    if (!['ACTIVE', 'INACTIVE'].includes(status)) return toError(400, 'BAD_REQUEST', 'status must be ACTIVE or INACTIVE.')
    if (status === 'ACTIVE' && existing.value.status !== 'ACTIVE') {
      const active = await loadActiveProfile(supabase, existing.value.scopeType, existing.value.resellerId, existing.value.enterpriseId)
      if (active && active.profileId !== existing.value.profileId) return toError(409, 'CONFLICT', 'active alert config profile already exists for this scope.')
    }
    patch.status = status
  }
  if (payload.name !== undefined) patch.name = payload.name === null ? null : String(payload.name)
  if (payload.description !== undefined) patch.description = payload.description === null ? null : String(payload.description)
  patch.version = existing.value.version + 1
  patch.updated_by = actorUserId ?? null
  patch.updated_at = new Date().toISOString()
  await supabase.update('alert_config_profiles', `config_profile_id=eq.${encodeURIComponent(String(existing.value.profileId))}`, patch, { returning: 'minimal' })
  return getAlertConfigProfile({ supabase, profileId: existing.value.profileId })
}

export async function listAlertConfigItems({ supabase, profileId }: { supabase: SupabaseClient; profileId: unknown }): Promise<ServiceResult<{ items: AlertConfigItem[]; total: number }>> {
  const profile = await getAlertConfigProfile({ supabase, profileId })
  if (!profile.ok) return profile
  const rows = await supabase.select(
    'alert_config_items',
    `select=config_item_id,config_profile_id,alert_type,enabled,severity,threshold_value,threshold_unit,window_minutes,suppress_minutes,delivery_channels,delivery_targets,threshold_config,version,created_at,updated_at&config_profile_id=eq.${encodeURIComponent(String(profile.value.profileId))}&order=alert_type.asc`
  )
  const items = Array.isArray(rows) ? rows.map(mapItemRow) : []
  return { ok: true, value: { items, total: items.length } }
}

function itemPayloadFromCatalog(catalog: AlertTypeCatalogItem, payload: Record<string, unknown>, existing?: AlertConfigItem) {
  const severity = payload.severity === undefined && existing ? { ok: true as const, value: existing.severity } : payload.severity === undefined ? { ok: true as const, value: catalog.defaultSeverity } : normalizeEnum(payload.severity, ALERT_SEVERITIES, 'severity')
  if (!severity.ok) return severity
  const thresholdUnit = payload.thresholdUnit === undefined && existing ? { ok: true as const, value: existing.thresholdUnit } : payload.thresholdUnit === undefined ? { ok: true as const, value: catalog.defaultThresholdUnit } : normalizeOptionalEnum(payload.thresholdUnit, ALERT_THRESHOLD_UNITS, 'thresholdUnit')
  if (!thresholdUnit.ok) return thresholdUnit
  const thresholdValue = payload.thresholdValue === undefined && existing ? { ok: true as const, value: existing.thresholdValue } : payload.thresholdValue === undefined ? { ok: true as const, value: catalog.defaultThresholdValue } : parseNumberOrNull(payload.thresholdValue, 'thresholdValue')
  if (!thresholdValue.ok) return thresholdValue
  const windowMinutes = payload.windowMinutes === undefined && existing ? { ok: true as const, value: existing.windowMinutes } : payload.windowMinutes === undefined ? { ok: true as const, value: catalog.defaultWindowMinutes } : parsePositiveIntegerOrNull(payload.windowMinutes, 'windowMinutes')
  if (!windowMinutes.ok) return windowMinutes
  const suppressMinutes = payload.suppressMinutes === undefined && existing ? { ok: true as const, value: existing.suppressMinutes } : payload.suppressMinutes === undefined ? { ok: true as const, value: catalog.defaultSuppressMinutes } : parseNonNegativeInteger(payload.suppressMinutes, 30, 'suppressMinutes')
  if (!suppressMinutes.ok) return suppressMinutes
  const deliveryChannels = payload.deliveryChannels === undefined && existing ? { ok: true as const, value: existing.deliveryChannels } : payload.deliveryChannels === undefined ? { ok: true as const, value: catalog.defaultDeliveryChannels } : parseStringArray(payload.deliveryChannels, ALERT_DELIVERY_CHANNELS, 'deliveryChannels')
  if (!deliveryChannels.ok) return deliveryChannels
  const deliveryTargets = payload.deliveryTargets === undefined && existing ? { ok: true as const, value: existing.deliveryTargets } : payload.deliveryTargets === undefined ? { ok: true as const, value: catalog.defaultDeliveryTargets } : parseObject(payload.deliveryTargets, 'deliveryTargets')
  if (!deliveryTargets.ok) return deliveryTargets
  const thresholdConfig = payload.thresholdConfig === undefined && existing ? { ok: true as const, value: existing.thresholdConfig } : payload.thresholdConfig === undefined ? { ok: true as const, value: catalog.defaultThresholdConfig } : parseObject(payload.thresholdConfig, 'thresholdConfig')
  if (!thresholdConfig.ok) return thresholdConfig
  return {
    ok: true as const,
    value: {
      enabled: payload.enabled === undefined && existing ? existing.enabled : payload.enabled === undefined ? true : parseBoolean(payload.enabled, true),
      severity: severity.value,
      thresholdValue: thresholdValue.value,
      thresholdUnit: thresholdUnit.value,
      windowMinutes: windowMinutes.value,
      suppressMinutes: suppressMinutes.value,
      deliveryChannels: deliveryChannels.value,
      deliveryTargets: deliveryTargets.value,
      thresholdConfig: thresholdConfig.value,
    },
  }
}

async function loadConfigItem(supabase: SupabaseClient, profileId: string, alertType: AlertType) {
  const rows = await supabase.select(
    'alert_config_items',
    `select=config_item_id,config_profile_id,alert_type,enabled,severity,threshold_value,threshold_unit,window_minutes,suppress_minutes,delivery_channels,delivery_targets,threshold_config,version,created_at,updated_at&config_profile_id=eq.${encodeURIComponent(profileId)}&alert_type=eq.${encodeURIComponent(alertType)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row ? mapItemRow(row) : null
}

export async function putAlertConfigItem({
  supabase,
  profileId,
  alertType,
  payload,
}: {
  supabase: SupabaseClient
  profileId: unknown
  alertType: unknown
  payload: Record<string, unknown>
}): Promise<ServiceResult<AlertConfigItem>> {
  const profile = await getAlertConfigProfile({ supabase, profileId })
  if (!profile.ok) return profile
  const catalog = await getAlertType({ supabase, alertType })
  if (!catalog.ok) return catalog
  if (!catalog.value.allowedScopeTypes.includes(profile.value.scopeType)) {
    return toError(400, 'BAD_REQUEST', `alertType ${catalog.value.alertType} cannot be configured at ${profile.value.scopeType} scope.`)
  }
  const existing = await loadConfigItem(supabase, String(profile.value.profileId), catalog.value.alertType)
  const parsed = itemPayloadFromCatalog(catalog.value, payload, existing ?? undefined)
  if (!parsed.ok) return parsed
  const nowIso = new Date().toISOString()
  const dbPayload = {
    config_profile_id: profile.value.profileId,
    alert_type: catalog.value.alertType,
    enabled: parsed.value.enabled,
    severity: parsed.value.severity,
    threshold_value: parsed.value.thresholdValue,
    threshold_unit: parsed.value.thresholdUnit,
    window_minutes: parsed.value.windowMinutes,
    suppress_minutes: parsed.value.suppressMinutes,
    delivery_channels: parsed.value.deliveryChannels,
    delivery_targets: parsed.value.deliveryTargets,
    threshold_config: parsed.value.thresholdConfig,
    version: existing ? existing.version + 1 : 1,
    updated_at: nowIso,
  }
  if (existing?.itemId) {
    await supabase.update('alert_config_items', `config_item_id=eq.${encodeURIComponent(existing.itemId)}`, dbPayload, { returning: 'minimal' })
  } else {
    await supabase.insert('alert_config_items', { ...dbPayload, created_at: nowIso }, { returning: 'minimal' })
  }
  const saved = await loadConfigItem(supabase, String(profile.value.profileId), catalog.value.alertType)
  return { ok: true, value: saved ?? mapItemRow({ ...dbPayload, config_item_id: existing?.itemId ?? null }) }
}

export async function patchAlertConfigItem(input: Parameters<typeof putAlertConfigItem>[0]): Promise<ServiceResult<AlertConfigItem>> {
  return putAlertConfigItem(input)
}

function builtInItem(alertType: AlertType, catalog?: AlertTypeCatalogItem | null): EffectiveAlertConfig {
  return {
    source: 'BUILT_IN',
    scopeType: 'PLATFORM',
    resellerId: null,
    enterpriseId: null,
    profileId: null,
    itemId: null,
    alertType,
    enabled: catalog?.enabled ?? true,
    severity: catalog?.defaultSeverity ?? (alertType === 'SILENT_SIM' ? 'P3' : ['CDR_DELAY', 'UPSTREAM_DISCONNECT'].includes(alertType) ? 'P1' : 'P2'),
    thresholdValue: catalog?.defaultThresholdValue ?? null,
    thresholdUnit: catalog?.defaultThresholdUnit ?? null,
    windowMinutes: catalog?.defaultWindowMinutes ?? null,
    suppressMinutes: catalog?.defaultSuppressMinutes ?? 30,
    deliveryChannels: catalog?.defaultDeliveryChannels ?? ['PORTAL'],
    deliveryTargets: catalog?.defaultDeliveryTargets ?? {},
    thresholdConfig: catalog?.defaultThresholdConfig ?? {},
    version: 0,
    createdAt: null,
    updatedAt: null,
  }
}

async function effectiveFromProfile(supabase: SupabaseClient, profile: AlertConfigProfileItem | null, alertType: AlertType) {
  if (!profile?.profileId) return null
  const item = await loadConfigItem(supabase, profile.profileId, alertType)
  if (!item) return null
  return {
    ...item,
    source: profile.scopeType,
    scopeType: profile.scopeType,
    resellerId: profile.resellerId,
    enterpriseId: profile.enterpriseId,
    profileId: profile.profileId,
  } as EffectiveAlertConfig
}

export async function resolveEffectiveAlertConfigProfile({
  supabase,
  alertType,
  resellerId,
  enterpriseId,
}: {
  supabase: SupabaseClient
  alertType: unknown
  resellerId?: string | null
  enterpriseId?: string | null
}): Promise<ServiceResult<EffectiveAlertConfig>> {
  const type = normalizeEnum(alertType, ALERT_TYPES, 'alertType')
  if (!type.ok) return type
  const catalogRows = await supabase.select(
    'alert_type_catalog',
    `select=alert_type,enabled,allowed_scope_types,default_severity,default_threshold_value,default_threshold_unit,default_window_minutes,default_suppress_minutes,default_delivery_channels,default_delivery_targets,default_threshold_config,display_name,description,sort_order,created_at,updated_at&alert_type=eq.${encodeURIComponent(type.value)}&limit=1`
  )
  const catalogRow = Array.isArray(catalogRows) ? catalogRows[0] : null
  const catalog = catalogRow ? mapAlertTypeCatalogRow(catalogRow) : null
  if (catalog && !catalog.enabled) return { ok: true, value: { ...builtInItem(type.value, catalog), enabled: false } }
  if (enterpriseId && resellerId) {
    const profile = await loadActiveProfile(supabase, 'ENTERPRISE', resellerId, enterpriseId)
    const resolved = await effectiveFromProfile(supabase, profile, type.value)
    if (resolved) return { ok: true, value: resolved }
  }
  if (resellerId) {
    const profile = await loadActiveProfile(supabase, 'RESELLER', resellerId)
    const resolved = await effectiveFromProfile(supabase, profile, type.value)
    if (resolved) return { ok: true, value: resolved }
  }
  const profile = await loadActiveProfile(supabase, 'PLATFORM')
  const resolved = await effectiveFromProfile(supabase, profile, type.value)
  if (resolved) return { ok: true, value: resolved }
  return { ok: true, value: builtInItem(type.value, catalog) }
}
