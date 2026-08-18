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

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  selectWithCount?: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

export type AlertTypeCatalogItem = {
  alertType: AlertType
  enabled: boolean
  allowedScopeTypes: AlertScopeType[]
  defaultSeverity: AlertSeverity
  defaultThresholdValue: number | null
  defaultThresholdUnit: AlertThresholdUnit | null
  defaultWindowMinutes: number | null
  defaultSuppressMinutes: number
  defaultDeliveryChannels: string[]
  defaultDeliveryTargets: Record<string, unknown>
  defaultThresholdConfig: Record<string, unknown>
  displayName: string
  description: string | null
  sortOrder: number
  createdAt: string | null
  updatedAt: string | null
}

const implementedAlertTypes = new Set<string>(ALERT_TYPES)

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
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

function parseBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  if (typeof value === 'boolean') return value
  return ['true', '1', 'yes', 'y'].includes(String(value).trim().toLowerCase())
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

export function mapAlertTypeCatalogRow(row: any): AlertTypeCatalogItem {
  return {
    alertType: String(row?.alert_type ?? 'POOL_USAGE_HIGH') as AlertType,
    enabled: row?.enabled !== false,
    allowedScopeTypes: Array.isArray(row?.allowed_scope_types) ? row.allowed_scope_types.map(String) as AlertScopeType[] : ['PLATFORM'],
    defaultSeverity: String(row?.default_severity ?? 'P2') as AlertSeverity,
    defaultThresholdValue: toNumberOrNull(row?.default_threshold_value),
    defaultThresholdUnit: row?.default_threshold_unit ? String(row.default_threshold_unit) as AlertThresholdUnit : null,
    defaultWindowMinutes: toNumberOrNull(row?.default_window_minutes),
    defaultSuppressMinutes: Number(row?.default_suppress_minutes ?? 30),
    defaultDeliveryChannels: Array.isArray(row?.default_delivery_channels) ? row.default_delivery_channels.map(String) : ['PORTAL'],
    defaultDeliveryTargets: row?.default_delivery_targets && typeof row.default_delivery_targets === 'object' ? row.default_delivery_targets : {},
    defaultThresholdConfig: row?.default_threshold_config && typeof row.default_threshold_config === 'object' ? row.default_threshold_config : {},
    displayName: String(row?.display_name ?? row?.alert_type ?? ''),
    description: row?.description ?? null,
    sortOrder: Number(row?.sort_order ?? 100),
    createdAt: toIsoOrNull(row?.created_at),
    updatedAt: toIsoOrNull(row?.updated_at),
  }
}

function parsePatchPayload(payload: Record<string, unknown>) {
  const patch: Record<string, unknown> = {}
  if (payload.enabled !== undefined) patch.enabled = parseBoolean(payload.enabled, true)
  if (payload.allowedScopeTypes !== undefined) {
    const parsed = parseStringArray(payload.allowedScopeTypes, ALERT_SCOPE_TYPES, 'allowedScopeTypes')
    if (!parsed.ok) return parsed
    patch.allowed_scope_types = parsed.value
  }
  if (payload.defaultSeverity !== undefined) {
    const parsed = normalizeEnum(payload.defaultSeverity, ALERT_SEVERITIES, 'defaultSeverity')
    if (!parsed.ok) return parsed
    patch.default_severity = parsed.value
  }
  if (payload.defaultThresholdValue !== undefined) {
    const parsed = parseNumberOrNull(payload.defaultThresholdValue, 'defaultThresholdValue')
    if (!parsed.ok) return parsed
    patch.default_threshold_value = parsed.value
  }
  if (payload.defaultThresholdUnit !== undefined) {
    const parsed = normalizeOptionalEnum(payload.defaultThresholdUnit, ALERT_THRESHOLD_UNITS, 'defaultThresholdUnit')
    if (!parsed.ok) return parsed
    patch.default_threshold_unit = parsed.value
  }
  if (payload.defaultWindowMinutes !== undefined) {
    const parsed = parsePositiveIntegerOrNull(payload.defaultWindowMinutes, 'defaultWindowMinutes')
    if (!parsed.ok) return parsed
    patch.default_window_minutes = parsed.value
  }
  if (payload.defaultSuppressMinutes !== undefined) {
    const parsed = parseNonNegativeInteger(payload.defaultSuppressMinutes, 30, 'defaultSuppressMinutes')
    if (!parsed.ok) return parsed
    patch.default_suppress_minutes = parsed.value
  }
  if (payload.defaultDeliveryChannels !== undefined) {
    const parsed = parseStringArray(payload.defaultDeliveryChannels, ALERT_DELIVERY_CHANNELS, 'defaultDeliveryChannels')
    if (!parsed.ok) return parsed
    patch.default_delivery_channels = parsed.value
  }
  if (payload.defaultDeliveryTargets !== undefined) {
    const parsed = parseObject(payload.defaultDeliveryTargets, 'defaultDeliveryTargets')
    if (!parsed.ok) return parsed
    patch.default_delivery_targets = parsed.value
  }
  if (payload.defaultThresholdConfig !== undefined) {
    const parsed = parseObject(payload.defaultThresholdConfig, 'defaultThresholdConfig')
    if (!parsed.ok) return parsed
    patch.default_threshold_config = parsed.value
  }
  if (payload.displayName !== undefined) patch.display_name = String(payload.displayName ?? '').trim()
  if (payload.description !== undefined) patch.description = payload.description === null ? null : String(payload.description)
  if (payload.sortOrder !== undefined) {
    const n = Number(payload.sortOrder)
    if (!Number.isFinite(n)) return toError(400, 'BAD_REQUEST', 'sortOrder must be a number.')
    patch.sort_order = Math.floor(n)
  }
  patch.updated_at = new Date().toISOString()
  return { ok: true as const, value: patch }
}

export async function listAlertTypes({
  supabase,
  enabled,
  scopeType,
  alertType,
}: {
  supabase: SupabaseClient
  enabled?: unknown
  scopeType?: unknown
  alertType?: unknown
}): Promise<ServiceResult<{ items: AlertTypeCatalogItem[]; total: number }>> {
  const filters = ['select=alert_type,enabled,allowed_scope_types,default_severity,default_threshold_value,default_threshold_unit,default_window_minutes,default_suppress_minutes,default_delivery_channels,default_delivery_targets,default_threshold_config,display_name,description,sort_order,created_at,updated_at', 'order=sort_order.asc,alert_type.asc']
  if (enabled !== undefined && enabled !== null && String(enabled).trim() !== '') {
    filters.push(`enabled=eq.${parseBoolean(enabled, true)}`)
  }
  if (scopeType) {
    const parsed = normalizeEnum(scopeType, ALERT_SCOPE_TYPES, 'scopeType')
    if (!parsed.ok) return parsed
    filters.push(`allowed_scope_types=cs.{${encodeURIComponent(parsed.value)}}`)
  }
  if (alertType) {
    const parsed = normalizeEnum(alertType, ALERT_TYPES, 'alertType')
    if (!parsed.ok) return parsed
    filters.push(`alert_type=eq.${encodeURIComponent(parsed.value)}`)
  }
  const rows = await supabase.select('alert_type_catalog', filters.join('&'))
  const items = Array.isArray(rows) ? rows.map(mapAlertTypeCatalogRow) : []
  return { ok: true, value: { items, total: items.length } }
}

export async function getAlertType({
  supabase,
  alertType,
}: {
  supabase: SupabaseClient
  alertType: unknown
}): Promise<ServiceResult<AlertTypeCatalogItem>> {
  const parsed = normalizeEnum(alertType, ALERT_TYPES, 'alertType')
  if (!parsed.ok) return parsed
  const rows = await supabase.select(
    'alert_type_catalog',
    `select=alert_type,enabled,allowed_scope_types,default_severity,default_threshold_value,default_threshold_unit,default_window_minutes,default_suppress_minutes,default_delivery_channels,default_delivery_targets,default_threshold_config,display_name,description,sort_order,created_at,updated_at&alert_type=eq.${encodeURIComponent(parsed.value)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) return toError(404, 'RESOURCE_NOT_FOUND', 'alert type not found.')
  return { ok: true, value: mapAlertTypeCatalogRow(row) }
}

export async function patchAlertType({
  supabase,
  alertType,
  payload,
}: {
  supabase: SupabaseClient
  alertType: unknown
  payload: Record<string, unknown>
}): Promise<ServiceResult<AlertTypeCatalogItem>> {
  const parsed = normalizeEnum(alertType, ALERT_TYPES, 'alertType')
  if (!parsed.ok) return parsed
  if (!implementedAlertTypes.has(parsed.value)) {
    return toError(400, 'BAD_REQUEST', 'alertType is not implemented by the evaluator.')
  }
  const existing = await getAlertType({ supabase, alertType: parsed.value })
  if (!existing.ok) return existing
  const patch = parsePatchPayload(payload)
  if (!patch.ok) return patch
  await supabase.update('alert_type_catalog', `alert_type=eq.${encodeURIComponent(parsed.value)}`, patch.value, { returning: 'minimal' })
  return getAlertType({ supabase, alertType: parsed.value })
}
