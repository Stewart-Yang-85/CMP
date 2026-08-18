export const ALERT_TYPES = [
  'POOL_USAGE_HIGH',
  'OUT_OF_PROFILE_SURGE',
  'SILENT_SIM',
  'UNEXPECTED_ROAMING',
  'CDR_DELAY',
  'UPSTREAM_DISCONNECT',
  'WEBHOOK_DELIVERY_FAILED',
] as const

export const ALERT_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const
export const ALERT_SCOPE_TYPES = ['PLATFORM', 'RESELLER', 'ENTERPRISE'] as const
export const ALERT_THRESHOLD_UNITS = ['PERCENT', 'KB', 'MB', 'GB', 'HOURS', 'MINUTES', 'ATTEMPTS', 'COUNT'] as const
export const ALERT_DELIVERY_CHANNELS = ['PORTAL', 'WEBHOOK'] as const

export type AlertType = (typeof ALERT_TYPES)[number]
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]
export type AlertScopeType = (typeof ALERT_SCOPE_TYPES)[number]
export type AlertThresholdUnit = (typeof ALERT_THRESHOLD_UNITS)[number]

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  selectWithCount?: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

export type AlertRuleConfigItem = {
  configId: string | null
  scopeType: AlertScopeType
  resellerId: string | null
  enterpriseId: string | null
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

type ParsedAlertRuleConfig = {
  scopeType: AlertScopeType
  resellerId: string | null
  enterpriseId: string | null
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
}

export type BuiltInAlertRuleConfig = Partial<ParsedAlertRuleConfig> & {
  alertType: AlertType
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

function isValidUuid(value: unknown) {
  return UUID_RE.test(String(value ?? '').trim())
}

function pickEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): ServiceResult<T[number]> {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (!normalized) return toError(400, 'BAD_REQUEST', `${field} is required.`)
  if (!allowed.includes(normalized)) {
    return toError(400, 'BAD_REQUEST', `${field} must be one of: ${allowed.join(', ')}.`)
  }
  return { ok: true, value: normalized as T[number] }
}

function optionalEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): ServiceResult<T[number] | null> {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null }
  return pickEnum(value, allowed, field)
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  return ['true', '1', 'yes', 'y'].includes(normalized)
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

function parseObject(value: unknown, field: string): ServiceResult<Record<string, unknown>> {
  if (value === undefined || value === null || String(value).trim?.() === '') return { ok: true, value: {} }
  if (typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> }
  return toError(400, 'BAD_REQUEST', `${field} must be an object.`)
}

function parseDeliveryChannels(value: unknown): ServiceResult<string[]> {
  const raw = value === undefined || value === null ? ['PORTAL'] : Array.isArray(value) ? value : [value]
  const channels = raw.map((v) => String(v).trim().toUpperCase()).filter(Boolean)
  if (!channels.length) return toError(400, 'BAD_REQUEST', 'deliveryChannels must contain at least one channel.')
  for (const channel of channels) {
    if (!(ALERT_DELIVERY_CHANNELS as readonly string[]).includes(channel)) {
      return toError(400, 'BAD_REQUEST', `deliveryChannels must contain only: ${ALERT_DELIVERY_CHANNELS.join(', ')}.`)
    }
  }
  return { ok: true, value: Array.from(new Set(channels)) }
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

function mapRow(row: any): AlertRuleConfigItem {
  return {
    configId: row?.config_id ?? null,
    scopeType: String(row?.scope_type ?? 'PLATFORM') as AlertScopeType,
    resellerId: row?.reseller_id ?? null,
    enterpriseId: row?.enterprise_id ?? null,
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

async function validateScope(supabase: SupabaseClient, parsed: ParsedAlertRuleConfig): Promise<ServiceResult<null>> {
  if (parsed.scopeType === 'PLATFORM') {
    if (parsed.resellerId || parsed.enterpriseId) {
      return toError(400, 'BAD_REQUEST', 'PLATFORM configs must not include resellerId or enterpriseId.')
    }
    return { ok: true, value: null }
  }
  if (!parsed.resellerId || !isValidUuid(parsed.resellerId)) {
    return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
  }
  const reseller = await loadTenant(supabase, parsed.resellerId, 'RESELLER')
  if (!reseller) return toError(404, 'RESOURCE_NOT_FOUND', `reseller ${parsed.resellerId} not found.`)
  if (parsed.scopeType === 'RESELLER') {
    if (parsed.enterpriseId) return toError(400, 'BAD_REQUEST', 'RESELLER configs must not include enterpriseId.')
    return { ok: true, value: null }
  }
  if (!parsed.enterpriseId || !isValidUuid(parsed.enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const enterprise = await loadTenant(supabase, parsed.enterpriseId, 'ENTERPRISE')
  if (!enterprise) return toError(404, 'RESOURCE_NOT_FOUND', `enterprise ${parsed.enterpriseId} not found.`)
  if (String(enterprise.parent_id ?? '') !== parsed.resellerId) {
    return toError(403, 'FORBIDDEN', 'enterpriseId is out of reseller scope.')
  }
  return { ok: true, value: null }
}

function parseConfigPayload(payload: Record<string, unknown>, existing?: AlertRuleConfigItem): ServiceResult<ParsedAlertRuleConfig> {
  const scopeType = payload.scopeType === undefined && existing ? { ok: true as const, value: existing.scopeType } : pickEnum(payload.scopeType, ALERT_SCOPE_TYPES, 'scopeType')
  if (!scopeType.ok) return scopeType
  const alertType = payload.alertType === undefined && existing ? { ok: true as const, value: existing.alertType } : pickEnum(payload.alertType, ALERT_TYPES, 'alertType')
  if (!alertType.ok) return alertType
  const severity = payload.severity === undefined && existing ? { ok: true as const, value: existing.severity } : pickEnum(payload.severity, ALERT_SEVERITIES, 'severity')
  if (!severity.ok) return severity
  const thresholdUnit = payload.thresholdUnit === undefined && existing ? { ok: true as const, value: existing.thresholdUnit } : optionalEnum(payload.thresholdUnit, ALERT_THRESHOLD_UNITS, 'thresholdUnit')
  if (!thresholdUnit.ok) return thresholdUnit
  const thresholdValue = payload.thresholdValue === undefined && existing ? { ok: true as const, value: existing.thresholdValue } : parseNumberOrNull(payload.thresholdValue, 'thresholdValue')
  if (!thresholdValue.ok) return thresholdValue
  const windowMinutes = payload.windowMinutes === undefined && existing ? { ok: true as const, value: existing.windowMinutes } : parsePositiveIntegerOrNull(payload.windowMinutes, 'windowMinutes')
  if (!windowMinutes.ok) return windowMinutes
  const suppressMinutes = payload.suppressMinutes === undefined && existing ? { ok: true as const, value: existing.suppressMinutes } : parseNonNegativeInteger(payload.suppressMinutes, 30, 'suppressMinutes')
  if (!suppressMinutes.ok) return suppressMinutes
  const deliveryChannels = payload.deliveryChannels === undefined && existing ? { ok: true as const, value: existing.deliveryChannels } : parseDeliveryChannels(payload.deliveryChannels)
  if (!deliveryChannels.ok) return deliveryChannels
  const deliveryTargets = payload.deliveryTargets === undefined && existing ? { ok: true as const, value: existing.deliveryTargets } : parseObject(payload.deliveryTargets, 'deliveryTargets')
  if (!deliveryTargets.ok) return deliveryTargets
  const thresholdConfig = payload.thresholdConfig === undefined && existing ? { ok: true as const, value: existing.thresholdConfig } : parseObject(payload.thresholdConfig, 'thresholdConfig')
  if (!thresholdConfig.ok) return thresholdConfig

  return {
    ok: true,
    value: {
      scopeType: scopeType.value,
      resellerId: payload.resellerId === undefined && existing ? existing.resellerId : payload.resellerId ? String(payload.resellerId).trim() : null,
      enterpriseId: payload.enterpriseId === undefined && existing ? existing.enterpriseId : payload.enterpriseId ? String(payload.enterpriseId).trim() : null,
      alertType: alertType.value,
      enabled: payload.enabled === undefined && existing ? existing.enabled : parseBoolean(payload.enabled, true),
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

function toDbPayload(parsed: ParsedAlertRuleConfig, existingVersion?: number) {
  const nowIso = new Date().toISOString()
  return {
    scope_type: parsed.scopeType,
    reseller_id: parsed.resellerId,
    enterprise_id: parsed.enterpriseId,
    alert_type: parsed.alertType,
    enabled: parsed.enabled,
    severity: parsed.severity,
    threshold_value: parsed.thresholdValue,
    threshold_unit: parsed.thresholdUnit,
    window_minutes: parsed.windowMinutes,
    suppress_minutes: parsed.suppressMinutes,
    delivery_channels: parsed.deliveryChannels,
    delivery_targets: parsed.deliveryTargets,
    threshold_config: parsed.thresholdConfig,
    version: existingVersion ? existingVersion + 1 : 1,
    updated_at: nowIso,
  }
}

function identityQuery(parsed: ParsedAlertRuleConfig) {
  const parts = [
    `scope_type=eq.${encodeURIComponent(parsed.scopeType)}`,
    `alert_type=eq.${encodeURIComponent(parsed.alertType)}`,
  ]
  if (parsed.scopeType === 'PLATFORM') {
    parts.push('reseller_id=is.null', 'enterprise_id=is.null')
  } else if (parsed.scopeType === 'RESELLER') {
    parts.push(`reseller_id=eq.${encodeURIComponent(parsed.resellerId ?? '')}`, 'enterprise_id=is.null')
  } else {
    parts.push(`reseller_id=eq.${encodeURIComponent(parsed.resellerId ?? '')}`)
    parts.push(`enterprise_id=eq.${encodeURIComponent(parsed.enterpriseId ?? '')}`)
  }
  return parts.join('&')
}

export async function listAlertRuleConfigs({
  supabase,
  scopeType,
  resellerId,
  enterpriseId,
  alertType,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  scopeType?: unknown
  resellerId?: unknown
  enterpriseId?: unknown
  alertType?: unknown
  page?: unknown
  pageSize?: unknown
}): Promise<ServiceResult<{ items: AlertRuleConfigItem[]; total: number; page: number; pageSize: number }>> {
  const filters: string[] = []
  if (scopeType) {
    const parsed = pickEnum(scopeType, ALERT_SCOPE_TYPES, 'scopeType')
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
  if (alertType) {
    const parsed = pickEnum(alertType, ALERT_TYPES, 'alertType')
    if (!parsed.ok) return parsed
    filters.push(`alert_type=eq.${encodeURIComponent(parsed.value)}`)
  }
  const pageNum = Math.max(1, Number(page) || 1)
  const sizeNum = Math.min(200, Math.max(1, Number(pageSize) || 50))
  const offset = (pageNum - 1) * sizeNum
  const qs = [
    'select=config_id,scope_type,reseller_id,enterprise_id,alert_type,enabled,severity,threshold_value,threshold_unit,window_minutes,suppress_minutes,delivery_channels,delivery_targets,threshold_config,version,created_at,updated_at',
    'order=scope_type.asc,alert_type.asc',
    `limit=${sizeNum}`,
    `offset=${offset}`,
    ...filters,
  ].join('&')
  if (supabase.selectWithCount) {
    const { data, total } = await supabase.selectWithCount('alert_rule_configs', qs)
    const rows = Array.isArray(data) ? data : []
    return { ok: true, value: { items: rows.map(mapRow), total: typeof total === 'number' ? total : rows.length, page: pageNum, pageSize: sizeNum } }
  }
  const rows = await supabase.select('alert_rule_configs', qs)
  const items = Array.isArray(rows) ? rows.map(mapRow) : []
  return { ok: true, value: { items, total: items.length, page: pageNum, pageSize: sizeNum } }
}

export async function upsertAlertRuleConfig({
  supabase,
  payload,
}: {
  supabase: SupabaseClient
  payload: Record<string, unknown>
}): Promise<ServiceResult<AlertRuleConfigItem>> {
  const parsed = parseConfigPayload(payload)
  if (!parsed.ok) return parsed
  const scope = await validateScope(supabase, parsed.value)
  if (!scope.ok) return scope
  const existingRows = await supabase.select(
    'alert_rule_configs',
    `select=config_id,scope_type,reseller_id,enterprise_id,alert_type,enabled,severity,threshold_value,threshold_unit,window_minutes,suppress_minutes,delivery_channels,delivery_targets,threshold_config,version,created_at,updated_at&${identityQuery(parsed.value)}&limit=1`
  )
  const existing = Array.isArray(existingRows) ? existingRows[0] ? mapRow(existingRows[0]) : null : null
  if (existing?.configId) {
    const patch = toDbPayload(parsed.value, existing.version)
    await supabase.update('alert_rule_configs', `config_id=eq.${encodeURIComponent(existing.configId)}`, patch, { returning: 'minimal' })
    return getAlertRuleConfig({ supabase, configId: existing.configId })
  }
  const nowIso = new Date().toISOString()
  const rows = await supabase.insert('alert_rule_configs', {
    ...toDbPayload(parsed.value),
    created_at: nowIso,
  })
  const row = Array.isArray(rows) ? rows[0] : null
  return { ok: true, value: mapRow(row ?? { ...toDbPayload(parsed.value), config_id: null, created_at: nowIso }) }
}

export async function getAlertRuleConfig({
  supabase,
  configId,
}: {
  supabase: SupabaseClient
  configId: string
}): Promise<ServiceResult<AlertRuleConfigItem>> {
  if (!isValidUuid(configId)) return toError(400, 'BAD_REQUEST', 'configId must be a valid uuid.')
  const rows = await supabase.select(
    'alert_rule_configs',
    `select=config_id,scope_type,reseller_id,enterprise_id,alert_type,enabled,severity,threshold_value,threshold_unit,window_minutes,suppress_minutes,delivery_channels,delivery_targets,threshold_config,version,created_at,updated_at&config_id=eq.${encodeURIComponent(configId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row) return toError(404, 'RESOURCE_NOT_FOUND', 'alert rule config not found.')
  return { ok: true, value: mapRow(row) }
}

export async function patchAlertRuleConfig({
  supabase,
  configId,
  payload,
}: {
  supabase: SupabaseClient
  configId: string
  payload: Record<string, unknown>
}): Promise<ServiceResult<AlertRuleConfigItem>> {
  const existing = await getAlertRuleConfig({ supabase, configId })
  if (!existing.ok) return existing
  const parsed = parseConfigPayload(payload, existing.value)
  if (!parsed.ok) return parsed
  const scope = await validateScope(supabase, parsed.value)
  if (!scope.ok) return scope
  await supabase.update('alert_rule_configs', `config_id=eq.${encodeURIComponent(configId)}`, toDbPayload(parsed.value, existing.value.version), { returning: 'minimal' })
  return getAlertRuleConfig({ supabase, configId })
}

function builtInRule(alertType: AlertType, builtIn?: BuiltInAlertRuleConfig | null): AlertRuleConfigItem {
  const severity = builtIn?.severity ?? (alertType === 'SILENT_SIM' ? 'P3' : ['CDR_DELAY', 'UPSTREAM_DISCONNECT'].includes(alertType) ? 'P1' : 'P2')
  return {
    configId: null,
    scopeType: 'PLATFORM',
    resellerId: builtIn?.resellerId ?? null,
    enterpriseId: builtIn?.enterpriseId ?? null,
    alertType,
    enabled: builtIn?.enabled ?? true,
    severity,
    thresholdValue: builtIn?.thresholdValue ?? null,
    thresholdUnit: builtIn?.thresholdUnit ?? null,
    windowMinutes: builtIn?.windowMinutes ?? null,
    suppressMinutes: builtIn?.suppressMinutes ?? 30,
    deliveryChannels: builtIn?.deliveryChannels ?? ['PORTAL'],
    deliveryTargets: builtIn?.deliveryTargets ?? {},
    thresholdConfig: builtIn?.thresholdConfig ?? {},
    version: 0,
    createdAt: null,
    updatedAt: null,
  }
}

async function loadRuleByIdentity({
  supabase,
  alertType,
  scopeType,
  resellerId,
  enterpriseId,
}: {
  supabase: SupabaseClient
  alertType: AlertType
  scopeType: AlertScopeType
  resellerId?: string | null
  enterpriseId?: string | null
}) {
  const filters = [
    `alert_type=eq.${encodeURIComponent(alertType)}`,
    `scope_type=eq.${encodeURIComponent(scopeType)}`,
  ]
  if (scopeType === 'PLATFORM') {
    filters.push('reseller_id=is.null', 'enterprise_id=is.null')
  } else if (scopeType === 'RESELLER') {
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId ?? '')}`, 'enterprise_id=is.null')
  } else {
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId ?? '')}`)
    filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId ?? '')}`)
  }
  const rows = await supabase.select(
    'alert_rule_configs',
    `select=config_id,scope_type,reseller_id,enterprise_id,alert_type,enabled,severity,threshold_value,threshold_unit,window_minutes,suppress_minutes,delivery_channels,delivery_targets,threshold_config,version,created_at,updated_at&${filters.join('&')}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row ? mapRow(row) : null
}

export async function resolveEffectiveAlertRuleConfig({
  supabase,
  alertType,
  resellerId,
  enterpriseId,
  builtIn,
}: {
  supabase: SupabaseClient
  alertType: unknown
  resellerId?: string | null
  enterpriseId?: string | null
  builtIn?: BuiltInAlertRuleConfig | null
}): Promise<ServiceResult<AlertRuleConfigItem>> {
  const parsedType = pickEnum(alertType, ALERT_TYPES, 'alertType')
  if (!parsedType.ok) return parsedType
  if (enterpriseId && resellerId) {
    const enterpriseRule = await loadRuleByIdentity({ supabase, alertType: parsedType.value, scopeType: 'ENTERPRISE', resellerId, enterpriseId })
    if (enterpriseRule) return { ok: true, value: enterpriseRule }
  }
  if (resellerId) {
    const resellerRule = await loadRuleByIdentity({ supabase, alertType: parsedType.value, scopeType: 'RESELLER', resellerId })
    if (resellerRule) return { ok: true, value: resellerRule }
  }
  const platformRule = await loadRuleByIdentity({ supabase, alertType: parsedType.value, scopeType: 'PLATFORM' })
  if (platformRule) return { ok: true, value: platformRule }
  return { ok: true, value: builtInRule(parsedType.value, builtIn) }
}
