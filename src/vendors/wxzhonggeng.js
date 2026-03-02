import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

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

function normalizeCapabilities(config) {
  const cap = config?.capabilities ?? {}
  const maxBatchSize = Number(cap.maxBatchSize)
  return {
    supportsFutureDatedChange: Boolean(cap.supportsFutureDatedChange),
    supportsRealTimeUsage: cap.supportsRealTimeUsage === undefined ? true : Boolean(cap.supportsRealTimeUsage),
    supportsSftp: Boolean(cap.supportsSftp),
    supportsWebhookNotification: Boolean(cap.supportsWebhookNotification),
    maxBatchSize: Number.isFinite(maxBatchSize) && maxBatchSize > 0 ? Math.floor(maxBatchSize) : 1,
  }
}

function resolveOperation(config, action) {
  const ops = config?.operations ?? {}
  const direct = ops && typeof ops === 'object' ? ops[action] : null
  if (direct) return String(direct)
  const envKey =
    action === 'activate'
      ? 'WXZHONGGENG_ACTIVATE_OP'
      : action === 'suspend'
        ? 'WXZHONGGENG_SUSPEND_OP'
        : 'WXZHONGGENG_CHANGE_PLAN_OP'
  return getEnvTrim(envKey)
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

export function createWxzhonggengClient() {
  const config = loadWxzhonggengConfig()

  let baseUrl = getEnvTrim('WXZHONGGENG_URL')
  if (!baseUrl && config.apiBaseUrl) {
    baseUrl = config.apiBaseUrl
  }
  let tokenUrl = getEnvTrim('WXZHONGGENG_TOKEN_URL')
  const username = getEnvTrim('WXZHONGGENG_USERNAME')
  const password = getEnvTrim('WXZHONGGENG_PASSWORD')
  const apiKey = getEnvTrim('WXZHONGGENG_API_KEY')
  const apiSecret = getEnvTrim('WXZHONGGENG_API_SECRET')
  let tokenValue = null
  let tokenExpireAt = 0
  
  if (!tokenUrl && baseUrl) {
    // Use config endpoint if available, otherwise default
    const endpoint = config.auth?.tokenEndpoint || '/auth/token'
    tokenUrl = makeUrl(baseUrl, endpoint)
  }

  async function fetchToken() {
    if (!tokenUrl) throw new Error('missing_token_url')
    const useUserPass = Boolean(username && password)
    const useKeySecret = Boolean(apiKey && apiSecret)
    if (!useUserPass && !useKeySecret) throw new Error('missing_credentials')
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
    const ttl = Number(data?.expiresIn ?? 1800)
    if (!token) throw new Error('token_missing')
    tokenValue = String(token)
    tokenExpireAt = Date.now() + Math.max(60000, Math.min(86400000, ttl * 1000))
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

  async function getSimStatus(iccid) {
    const epConfig = config.endpoints?.getSimStatus
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

  return {
    ping,
    request,
    getUsage,
    getSimStatus,
    getSimInfoBatch,
    getSimInfoSync,
    getSimCardStatus,
    getSimStatusBatch,
    getSimFlow,
    getSimFlowsBatch,
    getUsageByMonth,
    updateCardStatus,
  }
}

export function createWxzhonggengAdapter() {
  const config = loadWxzhonggengConfig()
  const client = createWxzhonggengClient()
  const capabilities = normalizeCapabilities(config)

  async function activateSim({ iccid }) {
    const operation = resolveOperation(config, 'activate')
    if (!operation) {
      return buildProvisioningResult({ ok: false, status: 'FAILED', message: 'MISSING_OPERATION' })
    }
    const res = await client.updateCardStatus(iccid, operation)
    return buildProvisioningResult({ ok: true, status: 'COMPLETED', raw: res })
  }

  async function suspendSim({ iccid }) {
    const operation = resolveOperation(config, 'suspend')
    if (!operation) {
      return buildProvisioningResult({ ok: false, status: 'FAILED', message: 'MISSING_OPERATION' })
    }
    const res = await client.updateCardStatus(iccid, operation)
    return buildProvisioningResult({ ok: true, status: 'COMPLETED', raw: res })
  }

  async function changePlan({ iccid, externalProductId, effectiveAt, idempotencyKey }) {
    const epConfig = config.endpoints?.changePlan
    if (!epConfig) {
      return buildProvisioningResult({ ok: false, status: 'FAILED', message: 'NOT_SUPPORTED' })
    }
    const body = {
      iccid,
      externalProductId,
      idempotencyKey,
    }
    if (effectiveAt) body.effectiveAt = new Date(effectiveAt).toISOString()
    const res = await client.request(epConfig.method || 'POST', epConfig.path, { body })
    return buildProvisioningResult({ ok: true, status: 'ACCEPTED', raw: res })
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

  return {
    supplierKey: 'wxzhonggeng',
    capabilities,
    ...client,
    activateSim,
    suspendSim,
    changePlan,
    getDailyUsage,
    fetchCdrFiles,
    mapVendorProduct,
  }
}
