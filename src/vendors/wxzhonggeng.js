import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WXZHONGGENG_DIAGNOSTICS_CAPABILITIES } from './diagnosticsCapabilities.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function getEnvTrim(name) {
  const v = process.env[name]
  if (!v) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function makeUrl(base, path) {
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

function getNested(obj, path) {
  return path.split('.').reduce((o, k) => (o || {})[k], obj)
}

function loadWxzhonggengConfig() {
  let config = {}
  try {
    const configPath = path.join(__dirname, 'wxzhonggeng_config.json')
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } else {
      console.error('Config file not found at:', configPath)
    }
  } catch (e) {
    console.error('Failed to load WXZHONGGENG config:', e)
  }
  return config
}

const DEFAULT_SUPPORTED_OPERATIONS = Object.freeze([
  'ACTIVATE',
  'SUSPEND',
  'RESUME',
  'DEACTIVATE',
  'CHANGE_PLAN',
  'GET_USAGE',
  'SIM_STATUS_CHANGE',
])

function normalizeSupportedOperations(config) {
  const raw = config?.capabilities?.supportedOperations
  if (Array.isArray(raw) && raw.length > 0) {
    return Object.freeze(raw.map((op) => String(op).trim().toUpperCase()).filter(Boolean))
  }
  return DEFAULT_SUPPORTED_OPERATIONS
}

function normalizeCapabilities(config) {
  const cap = config?.capabilities ?? {}
  const maxBatchSize = Number(cap.maxBatchSize)
  return {
    supportsFutureDatedChange: Boolean(cap.supportsFutureDatedChange),
    supportsRealTimeUsage: cap.supportsRealTimeUsage === undefined ? true : Boolean(cap.supportsRealTimeUsage),
    supportsSftp: Boolean(cap.supportsSftp),
    supportsWebhookNotification: Boolean(cap.supportsWebhookNotification),
    maxBatchSize: Number.isFinite(maxBatchSize) && maxBatchSize > 0 ? Math.floor(maxBatchSize) : 1,
    supportedOperations: normalizeSupportedOperations(config),
  }
}

function resolveOperation(config, action, integrationConfig) {
  const ops = {
    ...(config?.operations || {}),
    ...(integrationConfig?.operations || {}),
    ...(integrationConfig?.config?.operations || {}),
  }
  const direct = ops[action]
  if (direct) return String(direct)
  const envKey =
    action === 'activate'
      ? 'WXZHONGGENG_ACTIVATE_OP'
      : action === 'suspend'
        ? 'WXZHONGGENG_SUSPEND_OP'
        : action === 'resume'
          ? 'WXZHONGGENG_RESUME_OP'
          : 'WXZHONGGENG_CHANGE_PLAN_OP'
  return getEnvTrim(envKey)
}

function mergeEndpointConfig(fileConfig, integrationConfig) {
  const base = fileConfig && typeof fileConfig === 'object' ? fileConfig : {}
  const extra = integrationConfig?.endpoints && typeof integrationConfig.endpoints === 'object'
    ? integrationConfig.endpoints
    : integrationConfig?.config?.endpoints && typeof integrationConfig.config.endpoints === 'object'
      ? integrationConfig.config.endpoints
      : {}
  return {
    ...base,
    endpoints: { ...(base.endpoints || {}), ...extra },
    auth: { ...(base.auth || {}), ...(integrationConfig?.auth || {}), ...(integrationConfig?.config?.auth || {}) },
    operations: {
      ...(base.operations || {}),
      ...(integrationConfig?.operations || {}),
      ...(integrationConfig?.config?.operations || {}),
    },
  }
}

function buildProvisioningResult({ ok, status, raw, message }) {
  const vendorRequestId = raw?.requestId ?? raw?.data?.requestId ?? null
  return {
    ok: Boolean(ok),
    status,
    vendorRequestId,
    message: message ?? null,
    raw: raw ?? null,
  }
}

function isWxUpstreamHealthResponseOk(res) {
  return isWxApiSuccess(res)
}

/** @param {unknown} res */
export function isWxApiSuccess(res) {
  if (res == null || typeof res !== 'object') return false
  if (res.success === false) return false
  const code = res.code != null ? String(res.code).trim() : ''
  if (code && code !== '00000' && code !== '0') return false
  return true
}

function parseWxExpireAtMs(data, config) {
  const field = config.auth?.expireTimeField || 'data.expireTime'
  const raw = getNested(data, field) ?? data?.data?.expireTime ?? data?.expireTime
  if (raw != null && String(raw).trim() !== '') {
    const normalized = String(raw).trim().replace(' ', 'T')
    const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`
    const parsed = Date.parse(withZone)
    if (!Number.isNaN(parsed)) return parsed
  }
  const ttlSec = Number(config.auth?.tokenExpirySeconds ?? 7200)
  return Date.now() + Math.max(60, ttlSec) * 1000
}

function formatWxEffectTime(value) {
  if (value == null || String(value).trim() === '') return ''
  const d = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(d.getTime())) return ''
  const iso = d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  return iso
}

function provisioningOkFromResponse(res) {
  if (!isWxApiSuccess(res)) return false
  const data = res?.data
  if (data && typeof data === 'object' && 'success' in data) {
    return data.success !== false
  }
  return true
}

export function createWxzhonggengClient(integration = {}) {
  const fileConfig = loadWxzhonggengConfig()
  const config = mergeEndpointConfig(fileConfig, integration)

  let baseUrl = integration.apiEndpoint ? String(integration.apiEndpoint).trim() : null
  if (!baseUrl) baseUrl = getEnvTrim('WXZHONGGENG_URL')
  if (!baseUrl && config.apiBaseUrl) {
    baseUrl = config.apiBaseUrl
  }
  let tokenUrl = integration.tokenUrl ? String(integration.tokenUrl).trim() : null
  if (!tokenUrl) tokenUrl = getEnvTrim('WXZHONGGENG_TOKEN_URL')
  const fromIntegrationRecord = Boolean(integration.apiEndpoint || integration.authType)
  const username = integration.username
    ? String(integration.username).trim()
    : fromIntegrationRecord
      ? null
      : getEnvTrim('WXZHONGGENG_USERNAME')
  const password = integration.password
    ? String(integration.password)
    : fromIntegrationRecord
      ? null
      : getEnvTrim('WXZHONGGENG_PASSWORD')
  const apiKey = integration.apiKey
    ? String(integration.apiKey).trim()
    : fromIntegrationRecord
      ? null
      : getEnvTrim('WXZHONGGENG_API_KEY')
  const apiSecret = integration.apiSecret
    ? String(integration.apiSecret)
    : fromIntegrationRecord
      ? null
      : getEnvTrim('WXZHONGGENG_API_SECRET')
  let tokenValue = null
  let tokenExpireAt = 0
  
  if (!tokenUrl && baseUrl) {
    // Use config endpoint if available, otherwise default
    const endpoint = config.auth?.tokenEndpoint || '/auth/token'
    tokenUrl = makeUrl(baseUrl, endpoint)
  }

  function resolveOutboundAuthMode() {
    if (apiKey && apiSecret) return 'api_key'
    if (username && password) return 'username_password'
    return null
  }

  async function fetchToken() {
    if (!tokenUrl) throw new Error('missing_token_url')
    const mode = resolveOutboundAuthMode()
    const useUserPass = mode === 'username_password'
    if (!mode) throw new Error('missing_credentials')
    if (useUserPass) {
      if (!username || !password) throw new Error('missing_credentials')
    } else if (!apiKey || !apiSecret) {
      throw new Error('missing_credentials')
    }
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        useUserPass
          ? { username, password }
          : { apiKey, apiSecret }
      )
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`token_http_${res.status}`)
    const data = text ? JSON.parse(text) : null
    
    // Use config to find token field
    let token = null
    if (config.auth?.tokenField) {
      token = getNested(data, config.auth.tokenField)
    }
    // Fallback
    if (!token) {
      token = data?.token || data?.accessToken || null
    }
    if (!token) throw new Error('token_missing')
    tokenValue = String(token)
    tokenExpireAt = parseWxExpireAtMs(data, config)
    return tokenValue
  }

  async function getToken() {
    if (tokenValue && Date.now() < tokenExpireAt - 10000) return tokenValue
    return fetchToken()
  }

  async function request(method, path, { body, headers = {} } = {}) {
    if (!baseUrl) throw new Error('missing_base_url')
    const token = await getToken()
    const url = makeUrl(baseUrl, path)
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        token: token,
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (res.status === 401) {
      await fetchToken()
      const token2 = tokenValue
      const res2 = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          token: token2,
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const t2 = await res2.text()
      if (!res2.ok) throw new Error(`http_${res2.status}:${t2}`)
      return t2 ? JSON.parse(t2) : null
    }
    if (!res.ok) throw new Error(`http_${res.status}:${text}`)
    return text ? JSON.parse(text) : null
  }

  async function ping() {
    if (!tokenUrl) return false
    try {
      await getToken()
      return true
    } catch {
      return false
    }
  }

  async function healthCheck() {
    if (!baseUrl) return false
    const epConfig = config.endpoints?.healthCheck
    if (!epConfig?.path) {
      return ping()
    }
    try {
      const body =
        epConfig.requestBody && typeof epConfig.requestBody === 'object' && !Array.isArray(epConfig.requestBody)
          ? epConfig.requestBody
          : { pageSize: 1, pageIndex: 1 }
      const res = await request(epConfig.method || 'POST', epConfig.path, { body })
      return isWxUpstreamHealthResponseOk(res)
    } catch {
      return false
    }
  }

  async function getUsage(iccid, date) {
     const epConfig = config.endpoints?.getUsage
     if (!epConfig) {
       throw new Error('WXZHONGGENG API "getUsage" not configured in wxzhonggeng_config.json')
     }
 
     const body = {
       iccids: [iccid],
       date: date
     }
 
     try {
       const res = await request(epConfig.method || 'POST', epConfig.path, {
         body
       })
       
       if (res && res.data && Array.isArray(res.data)) {
        const item = res.data.find(d => d.iccid === iccid)
        if (item) {
          // The API returns 'usedFlow' which is the total usage.
          // We assign it to downlinkKb as a default since we don't have split data.
          const totalFlow = Number(item.usedFlow || 0)
          return {
            uplinkKb: 0,
            downlinkKb: totalFlow
          }
        }
      }
       return null 
     } catch (err) {
       console.error(`WXZHONGGENG getUsage failed for ${iccid}:`, err.message)
       throw err
     }
   }

  async function getSimInfo(iccid) {
    const epConfig = config.endpoints?.getSimInfo
    if (!epConfig) throw new Error('WXZHONGGENG API "getSimInfo" not configured in wxzhonggeng_config.json')
    try {
      return await request(epConfig.method || 'POST', epConfig.path, { body: { iccid } })
    } catch (err) {
      console.error(`WXZHONGGENG getSimInfo failed for ${iccid}:`, err.message)
      throw err
    }
  }

  async function getSimStatus(iccid) {
    const epConfig = config.endpoints?.getSimStatus ?? config.endpoints?.getSimCardStatus
    if (!epConfig) throw new Error('WXZHONGGENG API "getSimStatus" not configured')
    
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body: { iccid }
      })
      return res
    } catch (err) {
      console.error(`WXZHONGGENG getSimStatus failed for ${iccid}:`, err.message)
      throw err
    }
  }

  async function getSimInfoBatch(iccids) {
    const epConfig = config.endpoints?.getSimInfoBatch
    if (!epConfig) throw new Error('WXZHONGGENG API "getSimInfoBatch" not configured in wxzhonggeng_config.json')
    const list = Array.isArray(iccids) ? iccids.map((v) => String(v)).filter((v) => v.length > 0) : []
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body: { iccids: list }
      })
      return res
    } catch (err) {
      console.error('WXZHONGGENG getSimInfoBatch failed:', err.message)
      throw err
    }
  }

  async function getSimInfoSync(pageSize, pageIndex, status) {
    const epConfig = config.endpoints?.getSimInfoSync
    if (!epConfig) throw new Error('WXZHONGGENG API "getSimInfoSync" not configured in wxzhonggeng_config.json')
    const body = {
      pageSize: Number(pageSize),
      pageIndex: Number(pageIndex)
    }
    if (status !== undefined && status !== null && String(status).length > 0) {
      body.status = String(status)
    }
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body
      })
      return res
    } catch (err) {
      console.error('WXZHONGGENG getSimInfoSync failed:', err.message)
      throw err
    }
  }

  async function getSimCardStatus(iccid) {
    const epConfig = config.endpoints?.getSimCardStatus
    if (!epConfig) throw new Error('WXZHONGGENG API "getSimCardStatus" not configured in wxzhonggeng_config.json')
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body: { iccid }
      })
      return res
    } catch (err) {
      console.error(`WXZHONGGENG getSimCardStatus failed for ${iccid}:`, err.message)
      throw err
    }
  }

  async function getSimStatusBatch(iccids) {
    const epConfig = config.endpoints?.getSimStatusBatch
    if (!epConfig) throw new Error('WXZHONGGENG API "getSimStatusBatch" not configured in wxzhonggeng_config.json')
    const list = Array.isArray(iccids) ? iccids.map((v) => String(v)).filter((v) => v.length > 0) : []
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body: { iccids: list }
      })
      return res
    } catch (err) {
      console.error('WXZHONGGENG getSimStatusBatch failed:', err.message)
      throw err
    }
  }

  async function getSimFlow(iccid) {
    const epConfig = config.endpoints?.getSimFlow
    if (!epConfig) throw new Error('WXZHONGGENG API "getSimFlow" not configured in wxzhonggeng_config.json')
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body: { iccid }
      })
      return res
    } catch (err) {
      console.error(`WXZHONGGENG getSimFlow failed for ${iccid}:`, err.message)
      throw err
    }
  }

  async function getSimFlowsBatch(iccids) {
    const epConfig = config.endpoints?.getSimFlowsBatch
    if (!epConfig) throw new Error('WXZHONGGENG API "getSimFlowsBatch" not configured in wxzhonggeng_config.json')
    const list = Array.isArray(iccids) ? iccids.map((v) => String(v)).filter((v) => v.length > 0) : []
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body: { iccids: list }
      })
      return res
    } catch (err) {
      console.error('WXZHONGGENG getSimFlowsBatch failed:', err.message)
      throw err
    }
  }

  async function getUsageByMonth(month, iccids) {
    const epConfig = config.endpoints?.getUsageByMonth
    if (!epConfig) throw new Error('WXZHONGGENG API "getUsageByMonth" not configured in wxzhonggeng_config.json')
    const list = Array.isArray(iccids) ? iccids.map((v) => String(v)).filter((v) => v.length > 0) : []
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body: { month: String(month), iccids: list }
      })
      return res
    } catch (err) {
      console.error(`WXZHONGGENG getUsageByMonth failed for ${month}:`, err.message)
      throw err
    }
  }

  async function updateCardStatus(iccid, operation) {
    const epConfig = config.endpoints?.updateCardStatus
    if (!epConfig) throw new Error('WXZHONGGENG API "updateCardStatus" not configured in wxzhonggeng_config.json')
    try {
      const res = await request(epConfig.method || 'POST', epConfig.path, {
        body: { iccid, operation }
      })
      return res
    } catch (err) {
      console.error(`WXZHONGGENG updateCardStatus failed for ${iccid}:`, err.message)
      throw err
    }
  }

  async function updateCardStatusBatch(iccids, operation) {
    const epConfig = config.endpoints?.updateCardStatusBatch
    if (!epConfig) throw new Error('WXZHONGGENG API "updateCardStatusBatch" not configured in wxzhonggeng_config.json')
    const list = Array.isArray(iccids) ? iccids.map((v) => String(v)).filter((v) => v.length > 0) : []
    try {
      return await request(epConfig.method || 'POST', epConfig.path, {
        body: { iccids: list, operation: String(operation) },
      })
    } catch (err) {
      console.error('WXZHONGGENG updateCardStatusBatch failed:', err.message)
      throw err
    }
  }

  async function queryPackageInfo() {
    const epConfig = config.endpoints?.queryPackageInfo ?? config.endpoints?.healthCheck
    if (!epConfig) throw new Error('WXZHONGGENG API "queryPackageInfo" not configured in wxzhonggeng_config.json')
    const body =
      epConfig.requestBody && typeof epConfig.requestBody === 'object' && !Array.isArray(epConfig.requestBody)
        ? epConfig.requestBody
        : {}
    try {
      return await request(epConfig.method || 'POST', epConfig.path, { body })
    } catch (err) {
      console.error('WXZHONGGENG queryPackageInfo failed:', err.message)
      throw err
    }
  }

  async function changePlan({ iccid, productCode, effectTime }) {
    const epConfig = config.endpoints?.changePlan
    if (!epConfig) throw new Error('WXZHONGGENG API "changePlan" not configured in wxzhonggeng_config.json')
    const body = {
      iccid: String(iccid),
      productCode: String(productCode),
      effectTime: effectTime != null ? String(effectTime) : '',
    }
    try {
      return await request(epConfig.method || 'POST', epConfig.path, { body })
    } catch (err) {
      console.error(`WXZHONGGENG changePlan failed for ${iccid}:`, err.message)
      throw err
    }
  }

  return {
    ping,
    healthCheck,
    request,
    getUsage,
    getSimInfo,
    getSimStatus,
    getSimInfoBatch,
    getSimInfoSync,
    getSimCardStatus,
    getSimStatusBatch,
    getSimFlow,
    getSimFlowsBatch,
    getUsageByMonth,
    updateCardStatus,
    updateCardStatusBatch,
    queryPackageInfo,
    changePlan,
  }
}

export function createWxzhonggengAdapter(integration = {}) {
  const fileConfig = loadWxzhonggengConfig()
  const config = mergeEndpointConfig(fileConfig, integration)
  const client = createWxzhonggengClient(integration)
  const capabilities = normalizeCapabilities(config)

  async function activateSim({ iccid }) {
    const operation = resolveOperation(config, 'activate', integration)
    if (!operation) {
      return buildProvisioningResult({ ok: false, status: 'FAILED', message: 'MISSING_OPERATION' })
    }
    const res = await client.updateCardStatus(iccid, operation)
    const ok = provisioningOkFromResponse(res)
    return buildProvisioningResult({
      ok,
      status: ok ? 'COMPLETED' : 'FAILED',
      raw: res,
      message: ok ? null : String(res?.message || res?.code || 'UPSTREAM_FAILED'),
    })
  }

  async function suspendSim({ iccid }) {
    const operation = resolveOperation(config, 'suspend', integration)
    if (!operation) {
      return buildProvisioningResult({ ok: false, status: 'FAILED', message: 'MISSING_OPERATION' })
    }
    const res = await client.updateCardStatus(iccid, operation)
    const ok = provisioningOkFromResponse(res)
    return buildProvisioningResult({
      ok,
      status: ok ? 'COMPLETED' : 'FAILED',
      raw: res,
      message: ok ? null : String(res?.message || res?.code || 'UPSTREAM_FAILED'),
    })
  }

  async function resumeSim({ iccid }) {
    const operation = resolveOperation(config, 'resume', integration) || resolveOperation(config, 'activate', integration)
    if (!operation) {
      return buildProvisioningResult({ ok: false, status: 'FAILED', message: 'MISSING_OPERATION' })
    }
    const res = await client.updateCardStatus(iccid, operation)
    const ok = provisioningOkFromResponse(res)
    return buildProvisioningResult({
      ok,
      status: ok ? 'COMPLETED' : 'FAILED',
      raw: res,
      message: ok ? null : String(res?.message || res?.code || 'UPSTREAM_FAILED'),
    })
  }

  async function changePlan({ iccid, externalProductId, effectiveAt, idempotencyKey: _idempotencyKey }) {
    const epConfig = config.endpoints?.changePlan
    if (!epConfig) {
      return buildProvisioningResult({ ok: false, status: 'FAILED', message: 'NOT_SUPPORTED' })
    }
    const effectTime = formatWxEffectTime(effectiveAt)
    const res = await client.changePlan({
      iccid,
      productCode: externalProductId,
      effectTime,
    })
    const ok = isWxApiSuccess(res)
    return buildProvisioningResult({
      ok,
      status: ok ? 'ACCEPTED' : 'FAILED',
      raw: res,
      message: ok ? null : String(res?.message || res?.code || 'UPSTREAM_FAILED'),
    })
  }

  async function getDailyUsage({ iccid, date }) {
    const usage = await client.getUsage(iccid, date)
    if (!usage) return []
    const uplink = Number(usage.uplinkKb ?? 0)
    const downlink = Number(usage.downlinkKb ?? 0)
    return [{
      iccid,
      date,
      uplinkKb: uplink,
      downlinkKb: downlink,
      totalKb: uplink + downlink,
      source: 'wxzhonggeng',
    }]
  }

  async function fetchCdrFiles({ protocol }) {
    return { ok: false, protocol, files: [], raw: { error: 'NOT_SUPPORTED' } }
  }

  async function mapVendorProduct({ supplierId, externalProductId }) {
    return {
      supplierId,
      externalProductId,
      packageVersionId: null,
      provisioningParameters: null,
    }
  }

  function getCapabilities() {
    return capabilities
  }

  function supportsOperation(operation) {
    const op = String(operation ?? '').trim().toUpperCase()
    return capabilities.supportedOperations.includes(op)
  }

  return {
    supplierKey: 'wxzhonggeng',
    capabilities,
    diagnosticsCapabilities: WXZHONGGENG_DIAGNOSTICS_CAPABILITIES,
    ...client,
    activateSim,
    suspendSim,
    resumeSim,
    changePlan,
    getDailyUsage,
    fetchCdrFiles,
    mapVendorProduct,
    getCapabilities,
    supportsOperation,
  }
}
