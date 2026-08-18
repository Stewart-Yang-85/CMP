import {
  byteaToPostgresHex,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  hasIntegrationSecretKey,
} from './integrationSecretCrypto.js'
import {
  businessOperatorDisplayIdByOperatorRowId,
  loadOperator,
} from './operatorResolve.js'
import {
  applyIntegrationWebhookSubscriptions,
  enrichUpstreamIntegrationApiRow,
  type WebhookSubscriptionInput,
} from './inboundWebhookCatalog.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  selectWithCount?: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  delete: (table: string, matchQueryString: string) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

export const SUPPORTED_ADAPTER_TYPES = ['wxzhonggeng'] as const
export type AdapterType = (typeof SUPPORTED_ADAPTER_TYPES)[number]
export const SUPPORTED_AUTH_TYPES = ['api_key', 'username_password'] as const
export type AuthType = (typeof SUPPORTED_AUTH_TYPES)[number]
export const INTEGRATION_STATUSES = ['ACTIVE', 'INACTIVE', 'DEPRECATED'] as const
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number]
const ACTIVE_INTEGRATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const

function parseListStatusFilter(value: unknown): ServiceResult<IntegrationStatus[]> {
  if (value == null || String(value).trim() === '') {
    return { ok: true, value: [...ACTIVE_INTEGRATION_STATUSES] }
  }
  const key = String(value).trim().toUpperCase()
  if (!(INTEGRATION_STATUSES as readonly string[]).includes(key)) {
    return toError(400, 'BAD_REQUEST', `status must be one of: ${INTEGRATION_STATUSES.join(', ')}.`)
  }
  return { ok: true, value: [key as IntegrationStatus] }
}

export type UpstreamIntegrationRuntime = {
  integrationId: string
  resellerId: string | null
  name: string
  supplierId: string
  operatorId: string
  adapterType: AdapterType
  apiEndpoint: string | null
  apiKey: string | null
  apiSecret: string | null
  username: string | null
  password: string | null
  webhookKey: string | null
  authType: AuthType | null
  tokenUrl: string | null
  enabled: boolean
  config: Record<string, unknown>
}

type OutboundAuthFields = {
  authType: AuthType
  apiKey: string | null
  apiSecretPlain?: string
  username: string | null
  passwordPlain?: string
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

function normalizePage(value: unknown, fallback: number) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function normalizePageSize(value: unknown, fallback: number) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.min(200, Math.floor(num))
}

function parseIntegrationName(value: unknown): ServiceResult<string> {
  return parseRequiredNonEmptyString(value, 'name')
}

function parseRequiredNonEmptyString(value: unknown, field: string): ServiceResult<string> {
  if (value == null) {
    return toError(400, 'BAD_REQUEST', `${field} is required.`)
  }
  const text = String(value).trim()
  if (!text) {
    return toError(400, 'BAD_REQUEST', `${field} is required.`)
  }
  return { ok: true, value: text }
}

function parseApiEndpoint(value: unknown): ServiceResult<string> {
  const endpoint = parseRequiredNonEmptyString(value, 'apiEndpoint')
  if (!endpoint.ok) return endpoint
  try {
    const url = new URL(endpoint.value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return toError(400, 'BAD_REQUEST', 'apiEndpoint must be a valid http or https URL.')
    }
  } catch {
    return toError(400, 'BAD_REQUEST', 'apiEndpoint must be a valid http or https URL.')
  }
  return endpoint
}

function parseAuthType(value: unknown): ServiceResult<AuthType> {
  if (value == null) {
    return toError(400, 'BAD_REQUEST', 'authType is required.')
  }
  const key = String(value).trim().toLowerCase()
  if (!key) {
    return toError(400, 'BAD_REQUEST', 'authType is required.')
  }
  if (!(SUPPORTED_AUTH_TYPES as readonly string[]).includes(key)) {
    return toError(400, 'BAD_REQUEST', `authType must be one of: ${SUPPORTED_AUTH_TYPES.join(', ')}.`)
  }
  return { ok: true, value: key as AuthType }
}

function parseOptionalAuthType(value: unknown): ServiceResult<AuthType | null> {
  if (value === undefined) return { ok: true, value: null }
  return parseAuthType(value)
}

function hasNonEmptyField(value: unknown) {
  return value != null && String(value).trim().length > 0
}

type OutboundCredentialState = {
  apiKey: string | null
  apiSecret: string | null
  username: string | null
  password: string | null
}

function hasApiKeyPair(creds: OutboundCredentialState) {
  return hasNonEmptyField(creds.apiKey) && hasNonEmptyField(creds.apiSecret)
}

function hasUsernamePasswordPair(creds: OutboundCredentialState) {
  return hasNonEmptyField(creds.username) && hasNonEmptyField(creds.password)
}

/** Runtime priority: api_key pair first, else username_password pair, else error. */
export function resolveEffectiveAuthType(creds: OutboundCredentialState): ServiceResult<AuthType> {
  if (hasApiKeyPair(creds)) return { ok: true, value: 'api_key' }
  if (hasUsernamePasswordPair(creds)) return { ok: true, value: 'username_password' }
  return toError(
    400,
    'BAD_REQUEST',
    'At least one outbound credential set is required: apiKey + apiSecret, or username + password.'
  )
}

function parseOptionalCredentialPair(
  payload: Record<string, unknown>,
  keyField: 'apiKey' | 'username',
  secretField: 'apiSecret' | 'password',
  secretLabel: string
): ServiceResult<{ key: string | null; secret: string | null }> {
  const hasKey = hasNonEmptyField(payload[keyField])
  const hasSecret = hasNonEmptyField(payload[secretField])
  if (!hasKey && !hasSecret) {
    return { ok: true, value: { key: null, secret: null } }
  }
  if (hasKey !== hasSecret) {
    return toError(400, 'BAD_REQUEST', `${keyField} and ${secretLabel} must be provided together.`)
  }
  const keyResult = parseRequiredNonEmptyString(payload[keyField], keyField)
  if (!keyResult.ok) return keyResult
  const secretResult = parseRequiredNonEmptyString(payload[secretField], secretLabel)
  if (!secretResult.ok) return secretResult
  return { ok: true, value: { key: keyResult.value, secret: secretResult.value } }
}

function outboundStateFromRow(row: Record<string, unknown>): OutboundCredentialState {
  return {
    apiKey: row.api_key != null ? String(row.api_key).trim() || null : null,
    apiSecret: decryptIntegrationSecret(row.api_secret_encrypted),
    username: row.username != null ? String(row.username).trim() || null : null,
    password: decryptIntegrationSecret(row.password_encrypted),
  }
}

function parseCreateOutboundAuth(payload: Record<string, unknown>): ServiceResult<OutboundAuthFields> {
  const authTypeHint = parseOptionalAuthType(payload.authType)
  if (!authTypeHint.ok) return authTypeHint

  const apiPair = parseOptionalCredentialPair(payload, 'apiKey', 'apiSecret', 'apiSecret')
  if (!apiPair.ok) return apiPair
  const userPair = parseOptionalCredentialPair(payload, 'username', 'password', 'password')
  if (!userPair.ok) return userPair

  const creds: OutboundCredentialState = {
    apiKey: apiPair.value.key,
    apiSecret: apiPair.value.secret,
    username: userPair.value.key,
    password: userPair.value.secret,
  }
  const effective = resolveEffectiveAuthType(creds)
  if (!effective.ok) return effective
  if (authTypeHint.value && authTypeHint.value !== effective.value) {
    return toError(
      400,
      'BAD_REQUEST',
      `authType ${authTypeHint.value} does not match configured credentials; effective mode is ${effective.value}.`
    )
  }

  return {
    ok: true,
    value: {
      authType: effective.value,
      apiKey: creds.apiKey,
      apiSecretPlain: creds.apiSecret ?? undefined,
      username: creds.username,
      passwordPlain: creds.password ?? undefined,
    },
  }
}

function parseUpdateOutboundAuth(
  payload: Record<string, unknown>,
  existingRow: Record<string, unknown>
): ServiceResult<Partial<OutboundAuthFields>> {
  const touchesApiKey = payload.apiKey !== undefined || payload.apiSecret !== undefined
  const touchesUserPass = payload.username !== undefined || payload.password !== undefined
  if (payload.authType === undefined && !touchesApiKey && !touchesUserPass) {
    return { ok: true, value: {} }
  }

  const authTypeHint = parseOptionalAuthType(payload.authType)
  if (!authTypeHint.ok) return authTypeHint

  const patch: Partial<OutboundAuthFields> = {}
  const existing = outboundStateFromRow(existingRow)

  if (payload.apiKey !== undefined) {
    const apiKeyResult = parseRequiredNonEmptyString(payload.apiKey, 'apiKey')
    if (!apiKeyResult.ok) return apiKeyResult
    patch.apiKey = apiKeyResult.value
  }
  if (payload.apiSecret !== undefined) {
    const apiSecretResult = parseRequiredNonEmptyString(payload.apiSecret, 'apiSecret')
    if (!apiSecretResult.ok) return apiSecretResult
    patch.apiSecretPlain = apiSecretResult.value
  }
  if (payload.username !== undefined) {
    const usernameResult = parseRequiredNonEmptyString(payload.username, 'username')
    if (!usernameResult.ok) return usernameResult
    patch.username = usernameResult.value
  }
  if (payload.password !== undefined) {
    const passwordResult = parseRequiredNonEmptyString(payload.password, 'password')
    if (!passwordResult.ok) return passwordResult
    patch.passwordPlain = passwordResult.value
  }

  const merged: OutboundCredentialState = {
    apiKey: patch.apiKey !== undefined ? patch.apiKey : existing.apiKey,
    apiSecret: patch.apiSecretPlain !== undefined ? patch.apiSecretPlain : existing.apiSecret,
    username: patch.username !== undefined ? patch.username : existing.username,
    password: patch.passwordPlain !== undefined ? patch.passwordPlain : existing.password,
  }

  if (payload.apiKey !== undefined && payload.apiSecret === undefined && !hasNonEmptyField(merged.apiSecret)) {
    return toError(400, 'BAD_REQUEST', 'apiSecret is required when apiKey is updated.')
  }
  if (payload.apiSecret !== undefined && payload.apiKey === undefined && !hasNonEmptyField(merged.apiKey)) {
    return toError(400, 'BAD_REQUEST', 'apiKey is required when apiSecret is updated.')
  }
  if (payload.username !== undefined && payload.password === undefined && !hasNonEmptyField(merged.password)) {
    return toError(400, 'BAD_REQUEST', 'password is required when username is updated.')
  }
  if (payload.password !== undefined && payload.username === undefined && !hasNonEmptyField(merged.username)) {
    return toError(400, 'BAD_REQUEST', 'username is required when password is updated.')
  }

  const effective = resolveEffectiveAuthType(merged)
  if (!effective.ok) return effective
  if (authTypeHint.value && authTypeHint.value !== effective.value) {
    return toError(
      400,
      'BAD_REQUEST',
      `authType ${authTypeHint.value} does not match configured credentials; effective mode is ${effective.value}.`
    )
  }

  patch.authType = effective.value
  return { ok: true, value: patch }
}

const UPSTREAM_INTEGRATION_SELECT_COLUMNS =
  'integration_id,reseller_id,supplier_id,operator_id,name,adapter_type,api_endpoint,api_key,api_secret_encrypted,username,password_encrypted,webhook_key_encrypted,auth_type,token_url,enabled,status,config,deprecated_at,deprecated_by,deprecation_reason,created_at,updated_at'

function normalizeAdapterType(value: unknown): ServiceResult<AdapterType> {
  const key = String(value ?? '').trim().toLowerCase()
  if (!key) return toError(400, 'BAD_REQUEST', 'adapterType is required.')
  if (!(SUPPORTED_ADAPTER_TYPES as readonly string[]).includes(key)) {
    return toError(400, 'BAD_REQUEST', `adapterType must be one of: ${SUPPORTED_ADAPTER_TYPES.join(', ')}.`)
  }
  return { ok: true, value: key as AdapterType }
}

function rowToRuntime(row: Record<string, unknown>): UpstreamIntegrationRuntime {
  const config = row.config && typeof row.config === 'object' && !Array.isArray(row.config)
    ? (row.config as Record<string, unknown>)
    : {}
  const creds = outboundStateFromRow(row)
  const effective = resolveEffectiveAuthType(creds)
  return {
    integrationId: String(row.integration_id ?? ''),
    resellerId: row.reseller_id ? String(row.reseller_id) : null,
    name: row.name != null ? String(row.name).trim() : '',
    supplierId: String(row.supplier_id ?? ''),
    operatorId: String(row.operator_id ?? ''),
    adapterType: String(row.adapter_type ?? '').trim().toLowerCase() as AdapterType,
    apiEndpoint: row.api_endpoint != null ? String(row.api_endpoint).trim() || null : null,
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    username: creds.username,
    password: creds.password,
    webhookKey: decryptIntegrationSecret(row.webhook_key_encrypted),
    authType: effective.ok ? effective.value : null,
    tokenUrl: row.token_url != null ? String(row.token_url).trim() || null : null,
    enabled: row.enabled === true && String(row.status ?? '').toUpperCase() === 'ACTIVE',
    config,
  }
}

async function mapRowForApi(supabase: SupabaseClient, row: Record<string, unknown>) {
  const operatorRowId = row.operator_id != null ? String(row.operator_id) : ''
  const displayOperatorId = operatorRowId
    ? await businessOperatorDisplayIdByOperatorRowId(supabase, operatorRowId)
    : null
  return {
    integrationId: row.integration_id ?? null,
    resellerId: row.reseller_id ?? null,
    supplierId: row.supplier_id ?? null,
    operatorId: displayOperatorId,
    name: row.name ?? null,
    adapterType: row.adapter_type ?? null,
    apiEndpoint: row.api_endpoint ?? null,
    apiKey: row.api_key ?? null,
    hasApiSecret: Boolean(row.api_secret_encrypted),
    username: row.username ?? null,
    hasPassword: Boolean(row.password_encrypted),
    hasWebhookKey: Boolean(row.webhook_key_encrypted),
    authType: (() => {
      const effective = resolveEffectiveAuthType(outboundStateFromRow(row))
      return effective.ok ? effective.value : row.auth_type ?? null
    })(),
    tokenUrl: row.token_url ?? null,
    enabled: row.enabled !== false,
    status: row.status ?? null,
    config: row.config ?? {},
    deprecatedAt: row.deprecated_at ?? null,
    deprecatedBy: row.deprecated_by ?? null,
    deprecationReason: row.deprecation_reason ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

async function assertSupplierExists(
  supabase: SupabaseClient,
  supplierId: string
): Promise<ServiceResult<null>> {
  const rows = await supabase.select(
    'suppliers',
    `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || !(row as Record<string, unknown>).supplier_id) {
    return toError(404, 'SUPPLIER_NOT_FOUND', 'Supplier not found.')
  }
  return { ok: true, value: null }
}

export async function resolveOperatorForIntegration(
  supabase: SupabaseClient,
  supplierId: string,
  operatorIdInput: string
): Promise<ServiceResult<{ operatorRowId: string }>> {
  const operator = await loadOperator(supabase, operatorIdInput, supplierId)
  if (!operator?.operator_id) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not found or not linked to supplierId.')
  }
  if (String(operator.supplier_id ?? '') !== supplierId) {
    return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.')
  }
  return { ok: true, value: { operatorRowId: String(operator.operator_id) } }
}

export async function loadUpstreamIntegrationRuntime(
  supabase: SupabaseClient,
  supplierId: string,
  operatorIdInput: string
): Promise<UpstreamIntegrationRuntime | null> {
  const resolved = await resolveOperatorForIntegration(supabase, supplierId, operatorIdInput)
  if (!resolved.ok) return null
  const operatorRowId = resolved.value.operatorRowId
  const rows = await supabase.select(
    'upstream_integrations',
    `select=integration_id,reseller_id,supplier_id,operator_id,adapter_type,api_endpoint,api_key,api_secret_encrypted,username,password_encrypted,webhook_key_encrypted,auth_type,token_url,enabled,status,config&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(operatorRowId)}&status=eq.ACTIVE&enabled=eq.true&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || !(row as Record<string, unknown>).integration_id) return null
  const runtime = rowToRuntime(row as Record<string, unknown>)
  if (!runtime.enabled || !runtime.adapterType) return null
  return runtime
}

/** Active + enabled integrations for readiness probes (service role). */
export async function listActiveUpstreamIntegrationRuntimes(
  supabase: SupabaseClient,
): Promise<UpstreamIntegrationRuntime[]> {
  const rows = await supabase.select(
    'upstream_integrations',
    `select=${UPSTREAM_INTEGRATION_SELECT_COLUMNS}&status=eq.ACTIVE&enabled=eq.true&order=created_at.asc&limit=200`,
  )
  const list = Array.isArray(rows) ? rows : []
  return list
    .map((row) => rowToRuntime(row as Record<string, unknown>))
    .filter((runtime) => runtime.integrationId && runtime.adapterType)
}

export async function listUpstreamIntegrations({
  supabase,
  resellerId,
  supplierId,
  operatorId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  resellerId?: string | null
  supplierId?: string | null
  operatorId?: string | null
  status?: unknown
  page?: unknown
  pageSize?: unknown
}): Promise<ServiceResult<{ items: unknown[]; total: number; page: number; pageSize: number }>> {
  const p = normalizePage(page, 1)
  const ps = normalizePageSize(pageSize, 20)
  const offset = (p - 1) * ps
  const statusFilter = parseListStatusFilter(status)
  if (!statusFilter.ok) return statusFilter
  const filters: string[] = []
  if (resellerId) {
    if (!isValidUuid(resellerId)) return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  }
  if (supplierId) {
    if (!isValidUuid(supplierId)) return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    const supplierCheck = await assertSupplierExists(supabase, supplierId)
    if (!supplierCheck.ok) return supplierCheck
    filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
  }
  // When resellerId + supplierId are both provided, they MUST be bound (same rule as create).
  if (resellerId && supplierId) {
    const bindRows = await supabase.select(
      'reseller_suppliers',
      `select=reseller_id&supplier_id=eq.${encodeURIComponent(supplierId)}&reseller_id=eq.${encodeURIComponent(resellerId)}&limit=1`
    )
    if (!Array.isArray(bindRows) || bindRows.length === 0) {
      return toError(
        400,
        'SUPPLIER_NOT_BOUND',
        'supplierId is not bound to resellerId.'
      )
    }
  }
  if (operatorId) {
    if (!isValidUuid(operatorId)) return toError(400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    if (!supplierId) return toError(400, 'BAD_REQUEST', 'supplierId is required when filtering by operatorId.')
    const resolved = await resolveOperatorForIntegration(supabase, supplierId, operatorId)
    if (!resolved.ok) return resolved
    filters.push(`operator_id=eq.${encodeURIComponent(resolved.value.operatorRowId)}`)
  }
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const statusQs =
    statusFilter.value.length === 1
      ? `status=eq.${encodeURIComponent(statusFilter.value[0])}`
      : `status=in.(${statusFilter.value.map((s) => encodeURIComponent(s)).join(',')})`
  const qs = `select=${UPSTREAM_INTEGRATION_SELECT_COLUMNS}&${statusQs}&order=created_at.desc&limit=${ps}&offset=${offset}${filterQs}`
  let data: unknown[] = []
  let total = 0
  if (supabase.selectWithCount) {
    const result = await supabase.selectWithCount('upstream_integrations', qs)
    data = Array.isArray(result.data) ? result.data : []
    total = typeof result.total === 'number' ? result.total : data.length
  } else {
    const rows = await supabase.select('upstream_integrations', qs)
    data = Array.isArray(rows) ? rows : []
    total = data.length
  }
  const items = await Promise.all(
    (data as Record<string, unknown>[]).map((row) => mapRowForApi(supabase, row))
  )
  return { ok: true, value: { items, total, page: p, pageSize: ps } }
}

async function fetchIntegrationRow(supabase: SupabaseClient, integrationId: string) {
  const rows = await supabase.select(
    'upstream_integrations',
    `select=${UPSTREAM_INTEGRATION_SELECT_COLUMNS}&integration_id=eq.${encodeURIComponent(integrationId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row && (row as Record<string, unknown>).integration_id
    ? (row as Record<string, unknown>)
    : null
}

function parseSubscriptionsInput(payload: Record<string, unknown>): WebhookSubscriptionInput[] | null {
  if (payload.subscriptions === undefined) return null
  if (!Array.isArray(payload.subscriptions)) return []
  return payload.subscriptions.map((item) => {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    return {
      eventKey: String(row.eventKey ?? row.event_key ?? ''),
      enabled: row.enabled === true,
    }
  })
}

export async function getUpstreamIntegration({
  supabase,
  integrationId,
  baseUrl,
}: {
  supabase: SupabaseClient
  integrationId: string
  baseUrl?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!isValidUuid(integrationId)) return toError(400, 'BAD_REQUEST', 'integrationId must be a valid uuid.')
  const row = await fetchIntegrationRow(supabase, integrationId)
  if (!row) {
    return toError(404, 'NOT_FOUND', 'Upstream integration not found.')
  }
  let api: Record<string, unknown> = await mapRowForApi(supabase, row)
  if (baseUrl) {
    api = await enrichUpstreamIntegrationApiRow(supabase, baseUrl, api, row)
  }
  return { ok: true, value: api }
}

export async function createUpstreamIntegration({
  supabase,
  payload,
  baseUrl,
}: {
  supabase: SupabaseClient
  payload: Record<string, unknown>
  baseUrl?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  const supplierId = payload.supplierId ? String(payload.supplierId).trim() : ''
  const operatorIdInput = payload.operatorId ? String(payload.operatorId).trim() : ''
  const nameResult = parseIntegrationName(payload.name)
  if (!nameResult.ok) return nameResult
  const name = nameResult.value
  const apiEndpointResult = parseApiEndpoint(payload.apiEndpoint)
  if (!apiEndpointResult.ok) return apiEndpointResult
  const webhookKeyResult = parseRequiredNonEmptyString(payload.webhookKey, 'webhookKey')
  if (!webhookKeyResult.ok) return webhookKeyResult
  const outboundAuthResult = parseCreateOutboundAuth(payload)
  if (!outboundAuthResult.ok) return outboundAuthResult
  const apiEndpoint = apiEndpointResult.value
  const webhookKeyRaw = webhookKeyResult.value
  const { authType, apiKey, apiSecretPlain, username, passwordPlain } = outboundAuthResult.value
  const tokenUrl = payload.tokenUrl ? String(payload.tokenUrl).trim() : null
  const enabled = payload.enabled !== undefined ? Boolean(payload.enabled) : true
  const config = payload.config && typeof payload.config === 'object' ? payload.config : {}
  const resellerId = payload.resellerId ? String(payload.resellerId).trim() : ''

  if (!resellerId || !isValidUuid(resellerId)) {
    return toError(400, 'BAD_REQUEST', 'resellerId is required and must be a valid uuid.')
  }
  if (!supplierId || !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
  }
  if (!operatorIdInput || !isValidUuid(operatorIdInput)) {
    return toError(400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
  }
  // FR-042a: supplier must be exclusively bound to this reseller before creating integration.
  const bindRows = await supabase.select(
    'reseller_suppliers',
    `select=reseller_id&supplier_id=eq.${encodeURIComponent(supplierId)}&reseller_id=eq.${encodeURIComponent(resellerId)}&limit=1`
  )
  if (!Array.isArray(bindRows) || bindRows.length === 0) {
    return toError(
      400,
      'SUPPLIER_NOT_BOUND',
      'supplierId must be bound to resellerId via POST /resellers/{resellerId}/suppliers before creating an integration.'
    )
  }
  const adapterNorm = normalizeAdapterType(payload.adapterType)
  if (!adapterNorm.ok) return adapterNorm
  const resolved = await resolveOperatorForIntegration(supabase, supplierId, operatorIdInput)
  if (!resolved.ok) return resolved
  const operatorRowId = resolved.value.operatorRowId
  const activeStatusFilter = ACTIVE_INTEGRATION_STATUSES.map((s) => encodeURIComponent(s)).join(',')
  const existingActive = await supabase.select(
    'upstream_integrations',
    `select=integration_id&reseller_id=eq.${encodeURIComponent(resellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(operatorRowId)}&status=in.(${activeStatusFilter})&limit=1`
  )
  if (Array.isArray(existingActive) && existingActive.length > 0) {
    return toError(409, 'DUPLICATE', 'resellerId + supplierId + operatorId integration already exists.')
  }

  const insertPayload: Record<string, unknown> = {
    reseller_id: resellerId,
    supplier_id: supplierId,
    operator_id: operatorRowId,
    name,
    type: 'API',
    adapter_type: adapterNorm.value,
    api_endpoint: apiEndpoint,
    auth_type: authType,
    token_url: tokenUrl,
    enabled,
    status: enabled ? 'ACTIVE' : 'INACTIVE',
    config,
    deprecated_at: null,
    deprecated_by: null,
    deprecation_reason: null,
  }
  if (apiKey) insertPayload.api_key = apiKey
  if (username) insertPayload.username = username
  if (!hasIntegrationSecretKey()) {
    return toError(500, 'INTERNAL_ERROR', 'INTEGRATION_SECRET_KEY is not configured.')
  }
  if (apiSecretPlain) {
    insertPayload.api_secret_encrypted = byteaToPostgresHex(encryptIntegrationSecret(apiSecretPlain))
  }
  if (passwordPlain) {
    insertPayload.password_encrypted = byteaToPostgresHex(encryptIntegrationSecret(passwordPlain))
  }
  insertPayload.webhook_key_encrypted = byteaToPostgresHex(encryptIntegrationSecret(webhookKeyRaw))

  const rows = await supabase.insert('upstream_integrations', insertPayload, { returning: 'representation' })
  const row = Array.isArray(rows) ? rows[0] : null
  if (!(row as Record<string, unknown>)?.integration_id) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to create upstream integration.')
  }
  const integrationId = String((row as Record<string, unknown>).integration_id)
  const subsInput = parseSubscriptionsInput(payload)
  if (subsInput && subsInput.length > 0) {
    const applied = await applyIntegrationWebhookSubscriptions({
      supabase,
      integrationId,
      adapterType: adapterNorm.value,
      subscriptions: subsInput,
    })
    if (!applied.ok) return toError(400, 'BAD_REQUEST', applied.message)
  }
  let api: Record<string, unknown> = await mapRowForApi(supabase, row as Record<string, unknown>)
  if (baseUrl) {
    api = await enrichUpstreamIntegrationApiRow(supabase, baseUrl, api, row as Record<string, unknown>)
  }
  return { ok: true, value: api }
}

export async function updateUpstreamIntegration({
  supabase,
  integrationId,
  payload,
  baseUrl,
}: {
  supabase: SupabaseClient
  integrationId: string
  payload: Record<string, unknown>
  baseUrl?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  const existingRow = await fetchIntegrationRow(supabase, integrationId)
  if (!existingRow) return toError(404, 'NOT_FOUND', 'Upstream integration not found.')
  if (String(existingRow.status ?? '').toUpperCase() === 'DEPRECATED') {
    return toError(
      409,
      'INVALID_STATUS',
      'Cannot update a deprecated upstream integration. Create a new integration for this supplierId and operatorId.'
    )
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (payload.name !== undefined) {
    const nameResult = parseIntegrationName(payload.name)
    if (!nameResult.ok) return nameResult
    patch.name = nameResult.value
  }
  if (payload.apiEndpoint !== undefined) {
    const apiEndpointResult = parseApiEndpoint(payload.apiEndpoint)
    if (!apiEndpointResult.ok) return apiEndpointResult
    patch.api_endpoint = apiEndpointResult.value
  }
  const outboundAuthPatch = parseUpdateOutboundAuth(payload, existingRow)
  if (!outboundAuthPatch.ok) return outboundAuthPatch
  const outboundPatch = outboundAuthPatch.value
  if (outboundPatch.authType !== undefined) patch.auth_type = outboundPatch.authType
  if (outboundPatch.apiKey !== undefined) {
    if (outboundPatch.apiKey) patch.api_key = outboundPatch.apiKey
    else patch.api_key = null
  }
  if (outboundPatch.username !== undefined) {
    if (outboundPatch.username) patch.username = outboundPatch.username
    else patch.username = null
  }
  if (payload.tokenUrl != null) patch.token_url = String(payload.tokenUrl).trim() || null
  if (payload.enabled !== undefined) {
    patch.enabled = Boolean(payload.enabled)
    patch.status = patch.enabled ? 'ACTIVE' : 'INACTIVE'
  }
  if (payload.config && typeof payload.config === 'object') patch.config = payload.config
  if (payload.adapterType != null) {
    const adapterNorm = normalizeAdapterType(payload.adapterType)
    if (!adapterNorm.ok) return adapterNorm
    patch.adapter_type = adapterNorm.value
  }
  if (outboundPatch.apiSecretPlain !== undefined) {
    if (!hasIntegrationSecretKey()) {
      return toError(500, 'INTERNAL_ERROR', 'INTEGRATION_SECRET_KEY is not configured.')
    }
    patch.api_secret_encrypted = byteaToPostgresHex(encryptIntegrationSecret(outboundPatch.apiSecretPlain))
  }
  if (outboundPatch.passwordPlain !== undefined) {
    if (!hasIntegrationSecretKey()) {
      return toError(500, 'INTERNAL_ERROR', 'INTEGRATION_SECRET_KEY is not configured.')
    }
    patch.password_encrypted = byteaToPostgresHex(encryptIntegrationSecret(outboundPatch.passwordPlain))
  }
  if (payload.webhookKey !== undefined) {
    const webhookKeyResult = parseRequiredNonEmptyString(payload.webhookKey, 'webhookKey')
    if (!webhookKeyResult.ok) return webhookKeyResult
    if (!hasIntegrationSecretKey()) {
      return toError(500, 'INTERNAL_ERROR', 'INTEGRATION_SECRET_KEY is not configured.')
    }
    patch.webhook_key_encrypted = byteaToPostgresHex(encryptIntegrationSecret(webhookKeyResult.value))
  }

  const rows = await supabase.update(
    'upstream_integrations',
    `integration_id=eq.${encodeURIComponent(integrationId)}`,
    patch,
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!(row as Record<string, unknown>)?.integration_id) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to update upstream integration.')
  }
  const subsInput = parseSubscriptionsInput(payload)
  const adapterType = String(
    (row as Record<string, unknown>).adapter_type ?? existingRow.adapter_type ?? ''
  ).trim().toLowerCase()
  if (subsInput) {
    const applied = await applyIntegrationWebhookSubscriptions({
      supabase,
      integrationId,
      adapterType,
      subscriptions: subsInput,
    })
    if (!applied.ok) return toError(400, 'BAD_REQUEST', applied.message)
  }
  let api: Record<string, unknown> = await mapRowForApi(supabase, row as Record<string, unknown>)
  if (baseUrl) {
    api = await enrichUpstreamIntegrationApiRow(supabase, baseUrl, api, row as Record<string, unknown>)
  }
  return { ok: true, value: api }
}

function parseDeprecationAuditFields(
  payload: Record<string, unknown>,
  actorId?: string | null
): ServiceResult<{ deprecatedBy: string | null; deprecationReason: string | null }> {
  const byInput = payload.deprecatedBy ?? payload.deprecated_by
  const reasonInput = payload.deprecationReason ?? payload.deprecation_reason

  let deprecatedBy: string | null = null
  if (byInput != null) {
    const trimmed = String(byInput).trim()
    if (!trimmed) {
      return toError(400, 'BAD_REQUEST', 'deprecatedBy cannot be empty when provided.')
    }
    deprecatedBy = trimmed
  } else if (actorId && String(actorId).trim()) {
    deprecatedBy = String(actorId).trim()
  }

  let deprecationReason: string | null = null
  if (reasonInput !== undefined && reasonInput !== null) {
    const trimmed = String(reasonInput).trim()
    if (!trimmed) {
      return toError(400, 'BAD_REQUEST', 'deprecationReason cannot be empty when provided.')
    }
    deprecationReason = trimmed
  }

  return { ok: true, value: { deprecatedBy, deprecationReason } }
}

export async function deleteUpstreamIntegration({
  supabase,
  integrationId,
  payload = {},
  actorId,
}: {
  supabase: SupabaseClient
  integrationId: string
  payload?: Record<string, unknown>
  actorId?: string | null
}): Promise<
  ServiceResult<{
    integrationId: string
    deleted: true
    deprecatedAt: string
    deprecatedBy: string | null
    deprecationReason: string | null
  }>
> {
  if (!isValidUuid(integrationId)) return toError(400, 'BAD_REQUEST', 'integrationId must be a valid uuid.')
  const existingRow = await fetchIntegrationRow(supabase, integrationId)
  if (!existingRow) return toError(404, 'NOT_FOUND', 'Upstream integration not found.')
  if (String(existingRow.status ?? '').toUpperCase() === 'DEPRECATED') {
    return toError(409, 'INVALID_STATUS', 'Upstream integration is already deprecated.')
  }

  const audit = parseDeprecationAuditFields(payload, actorId)
  if (!audit.ok) return audit
  const deprecatedAt = new Date().toISOString()

  await supabase.update(
    'upstream_integrations',
    `integration_id=eq.${encodeURIComponent(integrationId)}`,
    {
      enabled: false,
      status: 'DEPRECATED',
      deprecated_at: deprecatedAt,
      deprecated_by: audit.value.deprecatedBy,
      deprecation_reason: audit.value.deprecationReason,
      updated_at: deprecatedAt,
    },
    { returning: 'minimal' }
  )
  await supabase.update(
    'upstream_integration_webhook_subscriptions',
    `integration_id=eq.${encodeURIComponent(integrationId)}`,
    { enabled: false, updated_at: deprecatedAt },
    { returning: 'minimal' }
  )
  return {
    ok: true,
    value: {
      integrationId,
      deleted: true,
      deprecatedAt,
      deprecatedBy: audit.value.deprecatedBy,
      deprecationReason: audit.value.deprecationReason,
    },
  }
}
