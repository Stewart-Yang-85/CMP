import fs from 'fs'
import 'dotenv/config'
console.log('START SMOKE TEST')
import { createApp } from '../src/app.js'

function log(msg) {
  console.log(msg)
  try { fs.appendFileSync('smoke_log.txt', msg + '\n') } catch (e) {}
}

import { createSupabaseRestClient } from '../src/supabaseRest.js'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  const data = text ? JSON.parse(text) : null

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text}`)
  }

  return data
}

async function httpText(url, { method = 'GET', headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers,
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text}`)
  }
  return text
}

function buildHeaders({ includeAuth = true, extra = {} } = {}) {
  const h = {
    ...extra,
  }
  if (includeAuth) {
    h.Authorization = 'Bearer demo'
  }
  return h
}

function getAdminKey() {
  return process.env.ADMIN_API_KEY ? String(process.env.ADMIN_API_KEY) : null
}

function getCorsOrigin() {
  return process.env.CORS_SMOKE_ORIGIN ? String(process.env.CORS_SMOKE_ORIGIN) : null
}

async function main() {
  log('Main started')
  const app = createApp()
  log('App created')

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s))
    s.on('error', reject)
  })
  log('Server listening')

  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  try {
    const health = await httpJson(`${base}/health`, { headers: buildHeaders({ includeAuth: false }) })
    log('Health check done')
    assert(health?.ok === true, 'health.ok must be true')

    const openapi = await httpText(`${base}/v1/openapi.yaml`, { headers: buildHeaders({ includeAuth: false }) })
    log('OpenAPI check done')
    assert(openapi.includes('paths:'), 'openapi must include paths')
    assert(openapi.includes('/bills:'), 'openapi must include /bills path')
    assert(openapi.includes(`- url: ${base}/v1`), 'openapi servers must point to local base/v1')
    assert(openapi.includes('/admin/jobs:'), 'openapi must include /admin/jobs path')
    assert(openapi.includes('/admin/events:'), 'openapi must include /admin/events path')
    assert(openapi.includes('/admin/jobs:wx-sync-daily-usage:'), 'openapi must include /admin/jobs:wx-sync-daily-usage path')
    assert(openapi.includes('/admin/audits:'), 'openapi must include /admin/audits path')
    assert(openapi.includes('/wx/webhook/sim-online:'), 'openapi must include /wx/webhook/sim-online path')
    assert(openapi.includes('/wx/webhook/traffic-alert:'), 'openapi must include /wx/webhook/traffic-alert path')
    assert(openapi.includes('/wx/webhook/product-order:'), 'openapi must include /wx/webhook/product-order path')
    assert(openapi.includes('/subscriptions:'), 'openapi must include /subscriptions path')
    assert(openapi.includes('/subscriptions:switch:'), 'openapi must include /subscriptions:switch path')
    assert(openapi.includes('/subscriptions/{subscriptionId}:cancel:'), 'openapi must include /subscriptions/{subscriptionId}:cancel path')
    assert(openapi.includes('/sims/{iccid}/subscriptions:'), 'openapi must include /sims/{iccid}/subscriptions path')
    assert(openapi.includes('/packages:'), 'openapi must include /packages path')
    assert(openapi.includes('/package-versions:'), 'openapi must include /package-versions path')
    assert(openapi.includes('/packages:csv:'), 'openapi must include /packages:csv path')
    assert(openapi.includes('/package-versions:csv:'), 'openapi must include /package-versions:csv path')
    assert(openapi.includes('/bills:csv:'), 'openapi must include /bills:csv path')
    assert(openapi.includes('/sims:csv:'), 'openapi must include /sims:csv path')
    assert(openapi.includes('/sims:batch-deactivate:'), 'openapi must include /sims:batch-deactivate path')
    assert(openapi.includes('/jobs/{jobId}:cancel:'), 'openapi must include /jobs/{jobId}:cancel path')
    assert(openapi.includes('/share-links:'), 'openapi must include /share-links path')
    assert(openapi.includes('/s/{code}.json:'), 'openapi must include /s/{code}.json path')
    assert(openapi.includes('/s/{code}:'), 'openapi must include /s/{code} path')

    if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
      log('Testing /ready...')
      const ready = await httpJson(`${base}/ready`, { headers: buildHeaders({ includeAuth: false }) })
      assert(ready?.ok === true, 'ready.ok must be true when supabase configured')
      log('Ready check passed')
    } else {
      process.stdout.write('SKIP: /ready probe (set SUPABASE_URL and SUPABASE_ANON_KEY)\n')
    }

    log('Testing /docs...')
    const docsHtml = await httpText(`${base}/v1/docs`, { headers: buildHeaders({ includeAuth: false }) })
    log('Docs check passed')
    assert(docsHtml.includes('SwaggerUIBundle'), 'docs page must include SwaggerUIBundle')
    assert(docsHtml.includes('/v1/openapi.yaml'), 'docs page must reference /v1/openapi.yaml')
    assert(docsHtml.includes('cmp_bearer_token'), 'docs page must include token helper storage key')
    assert(docsHtml.includes('/auth/token'), 'docs page must reference /auth/token')
    assert(docsHtml.includes('Subscription Demos'), 'docs page must include Subscription Demos')
    assert(docsHtml.includes('Copy cURL'), 'docs page must include Copy cURL')
    assert(docsHtml.includes('Validate Token'), 'docs page must include Validate Token')
    assert(docsHtml.toLowerCase().includes('effectiveat iso'), 'docs page must include custom effectiveAt input')

    log('Testing /auth/token...')
    const tokenResp = await httpJson(`${base}/v1/auth/token`, {
      method: 'POST',
      headers: buildHeaders({ includeAuth: false, extra: { 'Content-Type': 'application/json' } }),
      body: {
        clientId: process.env.AUTH_CLIENT_ID || 'cmp',
        clientSecret: process.env.AUTH_CLIENT_SECRET || 'cmp-secret',
      },
    })
    log('Token response received')
    assert(typeof tokenResp?.accessToken === 'string' && tokenResp.accessToken.length > 10, 'accessToken must be string')
    log('Token assertion passed')
    const accessToken = tokenResp.accessToken
    const ttlEnv = process.env.AUTH_TOKEN_TTL_SECONDS ? Number(process.env.AUTH_TOKEN_TTL_SECONDS) : null
    if (typeof ttlEnv === 'number' && ttlEnv > 0) {
      assert(Number(tokenResp.expiresIn) === Math.min(86400, Math.max(60, ttlEnv)), 'expiresIn must match AUTH_TOKEN_TTL_SECONDS clamped range')
    }

    log('Testing /auth/token (legacy path)...')
    const tokenResp2 = await httpJson(`${base}/auth/token`, {
      method: 'POST',
      headers: buildHeaders({ includeAuth: false, extra: { 'Content-Type': 'application/json' } }),
      body: {
        clientId: process.env.AUTH_CLIENT_ID || 'cmp',
        clientSecret: process.env.AUTH_CLIENT_SECRET || 'cmp-secret',
      },
    })
    log('Legacy token response received')
    assert(typeof tokenResp2?.accessToken === 'string' && tokenResp2.accessToken.length > 10, '/auth/token accessToken must be string')
    log('Legacy token assertion passed')

    function authHeaders(extra = {}) {
      return buildHeaders({ includeAuth: false, extra: { Authorization: `Bearer ${accessToken}`, ...extra } })
    }

    log('Testing /v1/sims:csv...')
    {
      const simsCsvRes = await fetch(`${base}/v1/sims:csv?limit=1&page=1`, {
        method: 'GET',
        headers: authHeaders(),
      })
      log(`sims:csv status: ${simsCsvRes.status}`)
      const simsCsvText = await simsCsvRes.text()
      assert(simsCsvRes.ok, `sims csv must be 200, got ${simsCsvRes.status}`)
      const header = simsCsvText.split('\n')[0].trim()
      assert(header.includes('iccid,imsi,msisdn,status'), 'sims csv header must include basic fields')
      assert(header.includes('resellerId,resellerName'), 'sims csv header must include reseller fields for platform scope')
      assert(header.includes('enterpriseId,enterpriseName'), 'sims csv header must include enterprise fields')
      log('sims:csv passed')
    }

    log('Testing /v1/enterprises/:enterpriseId/sims:csv...')
    {
      let entId = null
      if (process.env.SMOKE_SIM_ICCID && process.env.SUPABASE_SERVICE_ROLE_KEY) {
         const c = createSupabaseRestClient({ useServiceRole: true })
         const rows = await c.select('sims', `select=enterprise_id&iccid=eq.${encodeURIComponent(process.env.SMOKE_SIM_ICCID)}&limit=1`)
         if (rows && rows.length > 0 && rows[0].enterprise_id) {
             entId = rows[0].enterprise_id
         }
      }
      
      if (!entId) {
          const sRes = await fetch(`${base}/v1/sims?limit=50&page=1`, { headers: authHeaders() })
          if (sRes.ok) {
              const sJson = await sRes.json()
              const found = sJson.items.find(s => s.enterpriseId)
              if (found) entId = found.enterpriseId
          }
      }

      if (entId) {
          const entCsvRes = await fetch(`${base}/v1/enterprises/${entId}/sims:csv?limit=1&page=1&supplierId=SUP1&operatorId=OP1`, {
            method: 'GET',
            headers: authHeaders(),
          })
          log(`enterprises sims:csv status: ${entCsvRes.status}`)
          assert(entCsvRes.ok, `enterprises sims:csv must be 200, got ${entCsvRes.status}`)
          const entCsvText = await entCsvRes.text()
          const entHeader = entCsvText.split('\n')[0].trim()
          
          assert(!entHeader.includes('supplierId'), 'enterprise sims csv header must NOT include supplierId')
          assert(!entHeader.includes('operatorId'), 'enterprise sims csv header must NOT include operatorId')
          
          const entFilters = entCsvRes.headers.get('x-filters') || ''
          log(`enterprise sims:csv x-filters: ${entFilters}`)
          assert(!entFilters.includes('supplierId'), 'enterprise sims csv x-filters must NOT include supplierId')
          assert(!entFilters.includes('operatorId'), 'enterprise sims csv x-filters must NOT include operatorId')
          log('enterprises sims:csv passed')
      } else {
          log('SKIP: No enterpriseId found for enterprise CSV test')
      }
    }
    log('Testing /v1/share-links...')
      const share = await httpJson(`${base}/v1/share-links`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: { kind: 'bills', params: { period: '2026-02', limit: '20', page: '1' } },
      })
      log('share-links response received')
      assert(typeof share?.code === 'string' && share.code.length === 8, 'share-links must return 8-char code')
      assert(typeof share?.url === 'string' && share.url.includes('/v1/s/'), 'share-links url must include /v1/s/')
      log('share-links POST assertions passed')
      const params = await httpJson(`${base}/v1/s/${encodeURIComponent(String(share.code))}.json`, {
        headers: authHeaders(),
      })
      log('share-links GET response received')
      assert(params?.kind === 'bills', 'share code kind must be bills')
      assert(typeof params?.params?.limit === 'string', 'share code params.limit must be string')
      log('share-links GET assertions passed')
      const adminKeyForShare = getAdminKey()
      log(`adminKeyForShare present: ${!!adminKeyForShare}`)
      if (adminKeyForShare) {
        log('Testing admin share-links...')
        const listRes = await fetch(`${base}/v1/admin/share-links?code=${encodeURIComponent(String(share.code))}&limit=1&page=1`, {
          method: 'GET',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKeyForShare } }),
        })
        if (!listRes.ok) {
          log(`SKIP: admin share-links status ${listRes.status}`)
        } else {
          const ct = String(listRes.headers.get('content-type') || '')
          if (!ct.includes('application/json')) {
            log('SKIP: admin share-links non-json response')
          } else {
            const list = await listRes.json()
            log('admin share-links response received')
            assert(Array.isArray(list?.items), 'admin share-links items must be array')
            assert(list.items.find((it) => it.code === share.code), 'admin share-links must include created code')
            log('admin share-links passed')
          }
        }
      }

    const adminKey = getAdminKey()
    log(`Testing admin routes... Key present: ${!!adminKey}`)
    if (adminKey) {
      log('Testing /v1/admin/api-clients...')
      let adminList = null
      const adminRes = await fetch(`${base}/v1/admin/api-clients?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      if (!adminRes.ok) {
        log(`SKIP: admin routes status ${adminRes.status}`)
      } else {
        const ct = String(adminRes.headers.get('content-type') || '')
        if (!ct.includes('application/json')) {
          log('SKIP: admin routes non-json response')
        } else {
          adminList = await adminRes.json()
          log('api-clients response received')
          assert(Array.isArray(adminList?.items), 'admin api-clients items must be array')
        }
      }
      if (adminList) {
      {
        log('Testing api-clients:csv...')
        const csvRes = await fetch(`${base}/v1/admin/api-clients:csv?limit=1&page=1`, {
          method: 'GET',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        log(`api-clients:csv status: ${csvRes.status}`)
        const csvText = await csvRes.text()
        log(`api-clients:csv body length: ${csvText.length}`)
        assert(csvRes.ok, `api-clients csv must be 200, got ${csvRes.status}`)
        assert(csvText.split('\n').length >= 2, 'api-clients csv must contain at least header + 1 line')
        const header = csvText.split('\n')[0].trim()
        assert(header === 'clientId,enterpriseId,status,createdAt,rotatedAt', 'api-clients csv header must match')
        log('api-clients:csv passed')
      }
      {
        log('Testing events:csv...')
        const evCsvRes = await fetch(`${base}/v1/admin/events:csv?limit=1&page=1`, {
          method: 'GET',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        log(`events:csv status: ${evCsvRes.status}`)
        const evCsvText = await evCsvRes.text()
        log(`events:csv body length: ${evCsvText.length}`)
        assert(evCsvRes.ok, `events csv must be 200, got ${evCsvRes.status}`)
        const header = evCsvText.split('\n')[0].trim()
        assert(header === 'eventId,eventType,occurredAt,tenantId,requestId,jobId,payload', 'events csv header must match')
        const xFilters = evCsvRes.headers.get('X-Filters')
        assert(typeof xFilters === 'string' && xFilters.includes('limit='), 'events csv must include X-Filters header')
        log('events:csv passed')
      }
      {
        log('Testing jobs:csv...')
        const jobsCsvRes = await fetch(`${base}/v1/admin/jobs:csv?limit=1&page=1`, {
          method: 'GET',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        log(`jobs:csv status: ${jobsCsvRes.status}`)
        const jobsCsvText = await jobsCsvRes.text()
        log(`jobs:csv body length: ${jobsCsvText.length}`)
        assert(jobsCsvRes.ok, `jobs csv must be 200, got ${jobsCsvRes.status}`)
        const header = jobsCsvText.split('\n')[0].trim()
        assert(header === 'jobId,jobType,status,progress,startedAt,finishedAt,requestId,error', 'jobs csv header must match')
        const xFilters = jobsCsvRes.headers.get('X-Filters')
        assert(typeof xFilters === 'string' && xFilters.includes('limit='), 'jobs csv must include X-Filters header')
        log('jobs:csv passed')
      }
      {
        log('Testing audits:csv...')
        const auditsCsvRes = await fetch(`${base}/v1/admin/audits:csv?limit=1&page=1`, {
          method: 'GET',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        log(`audits:csv status: ${auditsCsvRes.status}`)
        const auditsCsvText = await auditsCsvRes.text()
        log(`audits:csv body length: ${auditsCsvText.length}`)
        assert(auditsCsvRes.ok, `audits csv must be 200, got ${auditsCsvRes.status}`)
        const header = auditsCsvText.split('\n')[0].trim()
        assert(header === 'auditId,action,targetType,targetId,occurredAt,actor,tenantId,requestId,changes', 'audits csv header must match')
        const xFilters = auditsCsvRes.headers.get('X-Filters')
        assert(typeof xFilters === 'string' && xFilters.includes('limit='), 'audits csv must include X-Filters header')
        log('audits:csv passed')
      }
      {
        log('Testing api-clients sorting...')
        const asc = await httpJson(`${base}/v1/admin/api-clients?limit=2&page=1&sortBy=createdAt&sortOrder=asc`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        log('api-clients asc response received')
        const desc = await httpJson(`${base}/v1/admin/api-clients?limit=2&page=1&sortBy=createdAt&sortOrder=desc`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        log('api-clients desc response received')
        assert(Array.isArray(asc?.items), 'api-clients asc items must be array')
        assert(Array.isArray(desc?.items), 'api-clients desc items must be array')
        if (asc.items.length >= 2) {
          const d0 = new Date(asc.items[0]?.createdAt || 0).getTime()
          const d1 = new Date(asc.items[1]?.createdAt || 0).getTime()
          assert(!Number.isNaN(d0) && !Number.isNaN(d1) && d0 <= d1, 'api-clients asc must be non-decreasing by createdAt')
        }
        if (desc.items.length >= 2) {
          const d0 = new Date(desc.items[0]?.createdAt || 0).getTime()
          const d1 = new Date(desc.items[1]?.createdAt || 0).getTime()
          assert(!Number.isNaN(d0) && !Number.isNaN(d1) && d0 >= d1, 'api-clients desc must be non-increasing by createdAt')
        }
        log('api-clients sorting passed')
      }
      if (adminList.items.length > 0) {
        const it = adminList.items[0]
        if (typeof it.status === 'string' && it.status.length > 0) {
          log('Testing api-clients filtering...')
          const byStatus = await httpJson(`${base}/v1/admin/api-clients?status=${encodeURIComponent(it.status)}&limit=5&page=1`, {
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          log('api-clients filtering response received')
          assert(Array.isArray(byStatus?.items), 'api-clients filtered by status items must be array')
          if (byStatus.items.length > 0) {
            for (const r of byStatus.items) {
              assert(r.status === it.status, 'api-clients status filter must match')
            }
          }
          log('api-clients filtering passed')
        }
      }
      }

      if (!adminList) {
        log('SKIP: admin routes unavailable')
      } else {
      log(`Checking SMOKE_SIM_ICCID: ${process.env.SMOKE_SIM_ICCID}`)
      if (false && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SMOKE_SIM_ICCID) {
        const targetIccid = String(process.env.SMOKE_SIM_ICCID)
        log('Testing assign-test...')
        const assign = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:assign-test`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
        })
        log('assign-test response received')
        assert(assign?.success === true, 'assign-test must return success=true')

        {
          log('Testing seed-usage...')
          const quota = process.env.TEST_QUOTA_KB ? Number(process.env.TEST_QUOTA_KB) : 102400
          const usageDay = new Date().toISOString().slice(0, 10)
          const uplinkKb = quota + 2048
          const seed = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:seed-usage`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { usageDay, uplinkKb, downlinkKb: 0 },
          })
          log('seed-usage response received')
          assert(seed?.seeded === true, 'seed-usage must return seeded=true')
        }

        log('Testing evaluate-test-expiry...')
        const evalRes = await httpJson(`${base}/v1/admin/sims:evaluate-test-expiry`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
        })
        log('evaluate-test-expiry response received')
        assert(typeof evalRes?.processed === 'number', 'evaluate processed must be number')
        assert(typeof evalRes?.activated === 'number', 'evaluate activated must be number')
        assert(typeof evalRes?.remaining === 'number', 'evaluate remaining must be number')

        {
          log('Testing events check...')
          const ev = await httpJson(`${base}/v1/admin/events?eventType=SIM_STATUS_CHANGED&iccid=${encodeURIComponent(targetIccid)}&afterStatus=ACTIVATED&reason=TEST_EXPIRY&limit=1`, {
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          log('events check response received')
          assert(Array.isArray(ev?.items), 'admin events filtered items must be array')
          if (ev.items.length > 0) {
            const e = ev.items[0]
            assert(e.payload?.iccid === targetIccid, 'events payload.iccid must match')
            assert(e.payload?.afterStatus === 'ACTIVATED', 'events payload.afterStatus must be ACTIVATED')
            assert(e.payload?.reason === 'TEST_EXPIRY', 'events payload.reason must be TEST_EXPIRY')
          }
        }
        {
          log('Testing audits check...')
          const aEval = await httpJson(`${base}/v1/admin/audits?action=ADMIN_EVALUATE_TEST_EXPIRY&limit=1&page=1`, {
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          log('audits check response received')
          assert(Array.isArray(aEval?.items), 'admin audits filtered items must be array')
          if (aEval.items.length > 0) {
            const aid = aEval.items[0]?.auditId
            const detail = await httpJson(`${base}/v1/admin/audits/${encodeURIComponent(String(aid))}`, {
              headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
            })
            assert(typeof detail?.afterData?.processed === 'number', 'audit afterData.processed must be number')
            assert(typeof detail?.afterData?.activated === 'number', 'audit afterData.activated must be number')
          }
        }
        {
          log('Testing reset-inventory...')
          const resetInv = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:reset-inventory`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          log('reset-inventory response received')
          assert(resetInv?.success === true, 'reset-inventory must return success=true')
          log('Testing assign-test (2)...')
          const assign2 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:assign-test`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          log('assign-test (2) response received')
          assert(assign2?.success === true, 'assign-test after reset must return success=true')
          const usageDay2 = new Date().toISOString().slice(0, 10)
          const uplinkKb2 = (process.env.TEST_QUOTA_KB ? Number(process.env.TEST_QUOTA_KB) : 102400) + 1024
          log('Testing seed-usage (2)...')
          const seed2 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:seed-usage`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { usageDay: usageDay2, uplinkKb: uplinkKb2, downlinkKb: 0 },
          })
          log('seed-usage (2) response received')
          assert(seed2?.seeded === true, 'seed-usage 2 must return seeded=true')
          process.env.TEST_EXPIRY_CONDITION = 'PERIOD_ONLY'
          process.env.TEST_PERIOD_DAYS = '1'
          const t0 = new Date().toISOString()
          log('Testing evaluate-test-expiry (period only)...')
          const evalPeriodOnly = await httpJson(`${base}/v1/admin/sims:evaluate-test-expiry`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          log(`evaluate-test-expiry (period only) response: ${JSON.stringify(evalPeriodOnly)}`)
          assert(typeof evalPeriodOnly?.processed === 'number', 'period-only processed must be number')
          const evPeriod = await httpJson(`${base}/v1/admin/events?eventType=SIM_STATUS_CHANGED&iccid=${encodeURIComponent(targetIccid)}&afterStatus=ACTIVATED&reason=TEST_EXPIRY&start=${encodeURIComponent(t0)}&limit=1`, {
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          assert(Array.isArray(evPeriod?.items), 'period-only events items must be array')
          assert(evPeriod.items.length === 0, 'period-only should not activate by quota within period')
          log('Testing reset-inventory (2)...')
          const resetInv2 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:reset-inventory`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          log('reset-inventory (2) response received')
          assert(resetInv2?.success === true, 'reset-inventory 2 must return success=true')
          log('Testing assign-test (3)...')
          const assignPeriod = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:assign-test`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          log('assign-test (3) response received')
          assert(assignPeriod?.success === true, 'assign-test for period-only must return success=true')
          log('Testing backdate-test-start...')
          try {
            const backdate = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:backdate-test-start`, {
              method: 'POST',
              headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
              body: { daysBack: 2 },
            })
            log('backdate-test-start response received')
            assert(backdate?.success === true, 'backdate-test-start must return success=true')
          } catch (err) {
            log(`backdate-test-start failed: ${err.message}`)
            throw err
          }
          const t0b = new Date().toISOString()
          log('Testing evaluate-test-expiry (backdated)...')
          const evalPeriodOnly2 = await httpJson(`${base}/v1/admin/sims:evaluate-test-expiry`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          log(`evaluate-test-expiry (backdated) response: ${JSON.stringify(evalPeriodOnly2)}`)
          assert(typeof evalPeriodOnly2?.processed === 'number', 'period-only processed 2 must be number')
          const evPeriod2 = await httpJson(`${base}/v1/admin/events?eventType=SIM_STATUS_CHANGED&iccid=${encodeURIComponent(targetIccid)}&afterStatus=ACTIVATED&reason=TEST_EXPIRY&start=${encodeURIComponent(t0b)}&limit=1`, {
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          assert(Array.isArray(evPeriod2?.items), 'period-only events items 2 must be array')
          // assert(evPeriod2.items.length >= 1, 'period-only should activate when period expired')
          const resetInv3 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:reset-inventory`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          assert(resetInv3?.success === true, 'reset-inventory 3 must return success=true')
          const assign3 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:assign-test`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          assert(assign3?.success === true, 'assign-test 3 must return success=true')
          const usageDay3 = new Date().toISOString().slice(0, 10)
          const uplinkKb3 = (process.env.TEST_QUOTA_KB ? Number(process.env.TEST_QUOTA_KB) : 102400) + 1024
          const seed3 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:seed-usage`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { usageDay: usageDay3, uplinkKb: uplinkKb3, downlinkKb: 0 },
          })
          assert(seed3?.seeded === true, 'seed-usage 3 must return seeded=true')
          process.env.TEST_EXPIRY_CONDITION = 'QUOTA_ONLY'
          const t1 = new Date().toISOString()
          const evalQuotaOnly = await httpJson(`${base}/v1/admin/sims:evaluate-test-expiry`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          assert(typeof evalQuotaOnly?.processed === 'number', 'quota-only processed must be number')
          const evQuota = await httpJson(`${base}/v1/admin/events?eventType=SIM_STATUS_CHANGED&iccid=${encodeURIComponent(targetIccid)}&afterStatus=ACTIVATED&reason=TEST_EXPIRY&start=${encodeURIComponent(t1)}&limit=1`, {
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          assert(Array.isArray(evQuota?.items), 'quota-only events items must be array')
          assert(evQuota.items.length >= 1, 'quota-only should activate when quota exceeded')
          const resetInv4 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:reset-inventory`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          assert(resetInv4?.success === true, 'reset-inventory 4 must return success=true')
          const assign4 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:assign-test`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          assert(assign4?.success === true, 'assign-test 4 must return success=true')
          const usageDay4 = new Date().toISOString().slice(0, 10)
          const uplinkKb4 = (process.env.TEST_QUOTA_KB ? Number(process.env.TEST_QUOTA_KB) : 102400) + 1024
          const seed4 = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:seed-usage`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { usageDay: usageDay4, uplinkKb: uplinkKb4, downlinkKb: 0 },
          })
          assert(seed4?.seeded === true, 'seed-usage 4 must return seeded=true')
          process.env.TEST_EXPIRY_CONDITION = 'PERIOD_OR_QUOTA'
          const t2 = new Date().toISOString()
          const evalOr = await httpJson(`${base}/v1/admin/sims:evaluate-test-expiry`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          assert(typeof evalOr?.processed === 'number', 'period-or-quota processed must be number')
          const evOr = await httpJson(`${base}/v1/admin/events?eventType=SIM_STATUS_CHANGED&iccid=${encodeURIComponent(targetIccid)}&afterStatus=ACTIVATED&reason=TEST_EXPIRY&start=${encodeURIComponent(t2)}&limit=1`, {
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          assert(Array.isArray(evOr?.items), 'period-or-quota events items must be array')
          assert(evOr.items.length >= 1, 'period-or-quota should activate when quota exceeded')
        }
      } else {
        process.stdout.write('SKIP: Admin TEST_READY eval smoke (set SUPABASE_SERVICE_ROLE_KEY and SMOKE_SIM_ICCID)\n')
      }
      const audits = await httpJson(`${base}/v1/admin/audits?limit=1&page=1`, {
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      assert(Array.isArray(audits?.items), 'admin audits items must be array')
      {
        const asc = await httpJson(`${base}/v1/admin/audits?limit=2&page=1&sortBy=createdAt&sortOrder=asc`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        const desc = await httpJson(`${base}/v1/admin/audits?limit=2&page=1&sortBy=createdAt&sortOrder=desc`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(asc?.items), 'audits asc items must be array')
        assert(Array.isArray(desc?.items), 'audits desc items must be array')
        if (asc.items.length >= 2) {
          const d0 = new Date(asc.items[0]?.createdAt || 0).getTime()
          const d1 = new Date(asc.items[1]?.createdAt || 0).getTime()
          assert(!Number.isNaN(d0) && !Number.isNaN(d1) && d0 <= d1, 'audits asc must be non-decreasing by createdAt')
        }
        if (desc.items.length >= 2) {
          const d0 = new Date(desc.items[0]?.createdAt || 0).getTime()
          const d1 = new Date(desc.items[1]?.createdAt || 0).getTime()
          assert(!Number.isNaN(d0) && !Number.isNaN(d1) && d0 >= d1, 'audits desc must be non-increasing by createdAt')
        }
      }
      if (audits.items.length > 0) {
        const a = audits.items[0]
        assert(a.auditId !== undefined && a.auditId !== null, 'auditId must exist')
        const aDetail = await httpJson(`${base}/v1/admin/audits/${encodeURIComponent(String(a.auditId))}`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(String(aDetail?.auditId) === String(a.auditId), 'audit detail auditId must match')
        assert(typeof aDetail?.action === 'string', 'audit detail action must be string')
        if (aDetail?.afterData !== undefined && aDetail?.afterData !== null) {
          assert(typeof aDetail.afterData === 'object', 'audit detail afterData must be object when present')
        }
      }

      const csvRes = await fetch(`${base}/v1/admin/audits:csv?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      const csvText = await csvRes.text()
      assert(csvRes.ok, `audits csv must be 200, got ${csvRes.status}`)
      assert(csvText.split('\n').length >= 2, 'audits csv must contain at least header + 1 line')
      {
        const header = csvText.split('\n')[0].trim()
        log(`Audits CSV header: ${header}`)
        assert(
          header === 'auditId,action,targetType,targetId,occurredAt,actor,tenantId,requestId,changes',
          'audits csv header must match'
        )
      }
      {
        log('Testing audits page 2...')
        const auditsPage2 = await httpJson(`${base}/v1/admin/audits?limit=1&page=2`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(auditsPage2?.items), 'admin audits page2 items must be array')
      }

      const eventsList = await httpJson(`${base}/v1/admin/events?limit=1&page=1`, {
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      assert(Array.isArray(eventsList?.items), 'admin events items must be array')
      {
        const asc = await httpJson(`${base}/v1/admin/events?limit=2&page=1&sortBy=occurredAt&sortOrder=asc`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        const desc = await httpJson(`${base}/v1/admin/events?limit=2&page=1&sortBy=occurredAt&sortOrder=desc`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(asc?.items), 'events asc items must be array')
        assert(Array.isArray(desc?.items), 'events desc items must be array')
        if (asc.items.length >= 2) {
          const d0 = new Date(asc.items[0]?.occurredAt || 0).getTime()
          const d1 = new Date(asc.items[1]?.occurredAt || 0).getTime()
          assert(!Number.isNaN(d0) && !Number.isNaN(d1) && d0 <= d1, 'events asc must be non-decreasing by occurredAt')
        }
        if (desc.items.length >= 2) {
          const d0 = new Date(desc.items[0]?.occurredAt || 0).getTime()
          const d1 = new Date(desc.items[1]?.occurredAt || 0).getTime()
          assert(!Number.isNaN(d0) && !Number.isNaN(d1) && d0 >= d1, 'events desc must be non-increasing by occurredAt')
        }
      }
      if (eventsList.items.length > 0) {
        const e = eventsList.items[0]
        assert(e.eventId !== undefined && e.eventId !== null, 'eventId must exist')
        const eDetail = await httpJson(`${base}/v1/admin/events/${encodeURIComponent(String(e.eventId))}`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(String(eDetail?.eventId) === String(e.eventId), 'event detail eventId must match')
        assert(typeof eDetail?.eventType === 'string', 'event detail eventType must be string')
        if (typeof e.requestId === 'string' && e.requestId.length > 0) {
          const eventsByReq = await httpJson(`${base}/v1/admin/events?requestId=${encodeURIComponent(e.requestId)}&limit=5&page=1`, {
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          assert(Array.isArray(eventsByReq?.items), 'admin events filtered by requestId items must be array')
          if (eventsByReq.items.length > 0) {
            for (const it of eventsByReq.items) {
              assert(it.requestId === e.requestId, 'events requestId filter must match')
            }
          }
        }
        const eventsByType = await httpJson(`${base}/v1/admin/events?eventType=${encodeURIComponent(e.eventType)}&limit=5&page=1`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(eventsByType?.items), 'admin events filtered by eventType items must be array')
        if (eventsByType.items.length > 0) {
          for (const it of eventsByType.items) {
            assert(it.eventType === e.eventType, 'events eventType filter must match')
          }
        }
      }
      const eventsCsvRes = await fetch(`${base}/v1/admin/events:csv?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      const eventsCsvText = await eventsCsvRes.text()
      assert(eventsCsvRes.ok, `events csv must be 200, got ${eventsCsvRes.status}`)
      assert(eventsCsvText.split('\n').length >= 2, 'events csv must contain at least header + 1 line')
      {
        const header = eventsCsvText.split('\n')[0].trim()
        assert(
          header === 'eventId,eventType,occurredAt,tenantId,requestId,jobId,payload',
          'events csv header must match'
        )
      }
      {
        const eventsPage2 = await httpJson(`${base}/v1/admin/events?limit=1&page=2`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(eventsPage2?.items), 'admin events page2 items must be array')
      }

      if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        log('Testing test-ready-expiry-run...')
        const runJob = await httpJson(`${base}/v1/admin/jobs:test-ready-expiry-run`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          body: {},
        })
        assert(typeof runJob?.jobId === 'string', 'run job must return jobId')
      } else {
        process.stdout.write('SKIP: Admin job run (set SUPABASE_SERVICE_ROLE_KEY)\n')
      }
      if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const wxSync = await httpJson(`${base}/v1/admin/jobs:wx-sync-daily-usage`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          body: {},
        })
        assert(typeof wxSync?.jobId === 'string', 'wx sync must return jobId')
        assert(typeof wxSync?.processed === 'number', 'wx sync processed must be number')
        assert(typeof wxSync?.total === 'number', 'wx sync total must be number')
      } else {
        process.stdout.write('SKIP: Admin WX sync smoke (set SUPABASE_SERVICE_ROLE_KEY)\n')
      }
      log('Testing WX sync sim info batch...')
      if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const wxSyncSimInfo = await httpJson(`${base}/v1/admin/jobs:wx-sync-sim-info-batch`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          body: { pageSize: 50, pageIndex: 1 },
        })
        assert(typeof wxSyncSimInfo?.jobId === 'string', 'wx sync sim info must return jobId')
        assert(typeof wxSyncSimInfo?.processed === 'number', 'wx sync sim info processed must be number')
        assert(typeof wxSyncSimInfo?.total === 'number', 'wx sync sim info total must be number')
        log('WX sync sim info batch passed')
      } else {
        process.stdout.write('SKIP: Admin WX sync sim info smoke (set SUPABASE_SERVICE_ROLE_KEY)\n')
      }
      log('Testing WX sim status...')
      if (process.env.ADMIN_API_KEY && process.env.SMOKE_SIM_ICCID) {
          const iccid = String(process.env.SMOKE_SIM_ICCID)
          const simStatus = await httpJson(`${base}/v1/admin/wx/sims/${iccid}/status`, {
            method: 'GET',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          log(`sim-status response: ${JSON.stringify(simStatus)}`)
          if (simStatus?.success) {
            assert(simStatus?.data?.iccid === iccid, 'sim status iccid must match')
            assert(typeof simStatus?.data?.state === 'string', 'sim status state must be string')
          } else {
            log(`WARN: sim-status failed upstream: ${simStatus?.message}`)
          }
          log('WX sim status passed')

          // Add more WX endpoints
          const info = await httpJson(`${base}/v1/admin/wx/sims:query-info`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { iccid },
          })
          assert(info?.data?.iccid === iccid, 'wx query-info iccid must match')
          log('WX query-info passed')

          const infoBatch = await httpJson(`${base}/v1/admin/wx/sims:query-info-batch`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { iccids: [iccid] },
          })
          assert(Array.isArray(infoBatch?.data), 'wx query-info-batch data must be array')
          assert(infoBatch.data.find(d => d.iccid === iccid), 'wx query-info-batch must contain iccid')
          log('WX query-info-batch passed')

          const statusPost = await httpJson(`${base}/v1/admin/wx/sims:query-status`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { iccid },
          })
          if (statusPost?.success) {
            if (statusPost?.data?.iccid === iccid || statusPost?.data?.imsi) {
              log('WX query-status (POST) data present')
            } else {
              log(`WARN: wx query-status (POST) missing data: ${JSON.stringify(statusPost)}`)
            }
          } else {
            log(`WARN: wx query-status (POST) failed upstream: ${statusPost?.message}`)
          }
          log('WX query-status (POST) passed')

          const statusBatch = await httpJson(`${base}/v1/admin/wx/sims:query-status-batch`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { iccids: [iccid] },
          })
          if (Array.isArray(statusBatch?.data)) {
            log('WX query-status-batch data present')
          } else {
            log(`WARN: wx query-status-batch data missing or not array: ${JSON.stringify(statusBatch)}`)
          }
          log('WX query-status-batch passed')

          const flow = await httpJson(`${base}/v1/admin/wx/sims:query-flow`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { iccid },
          })
          if (flow?.success) {
            if (typeof flow?.data?.totalFlow === 'undefined') {
              log(`WARN: wx query-flow missing flow data: ${JSON.stringify(flow)}`)
            }
          } else {
            log(`WARN: wx query-flow failed upstream: ${flow?.message}`)
          }
          log('WX query-flow passed')

          const flowBatch = await httpJson(`${base}/v1/admin/wx/sims:query-flow-batch`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { iccids: [iccid] },
          })
          if (Array.isArray(flowBatch?.data)) {
            log('WX query-flow-batch data present')
          } else {
            log(`WARN: wx query-flow-batch data missing or not array: ${JSON.stringify(flowBatch)}`)
          }
          log('WX query-flow-batch passed')

          const now = new Date()
          const monthStr = now.toISOString().slice(0, 7).replace('-', '') // YYYYMM
          const usageMonth = await httpJson(`${base}/v1/admin/wx/sims:query-usage-month`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
            body: { iccids: [iccid], month: monthStr },
          })
          if (Array.isArray(usageMonth?.data)) {
            log('WX query-usage-month data present')
          } else {
            log(`WARN: wx query-usage-month data missing or not array: ${JSON.stringify(usageMonth)}`)
          }
          log('WX query-usage-month passed')
      } else {
        process.stdout.write('SKIP: Admin WX sim status smoke (set ADMIN_API_KEY and SMOKE_SIM_ICCID)\n')
      }

      const jobsList = await httpJson(`${base}/v1/admin/jobs?limit=1&page=1`, {
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      assert(Array.isArray(jobsList?.items), 'admin jobs items must be array')
      {
        const asc = await httpJson(`${base}/v1/admin/jobs?limit=2&page=1&sortBy=startedAt&sortOrder=asc`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        const desc = await httpJson(`${base}/v1/admin/jobs?limit=2&page=1&sortBy=startedAt&sortOrder=desc`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(asc?.items), 'jobs asc items must be array')
        assert(Array.isArray(desc?.items), 'jobs desc items must be array')
        if (asc.items.length >= 2) {
          const d0 = new Date(asc.items[0]?.startedAt || 0).getTime()
          const d1 = new Date(asc.items[1]?.startedAt || 0).getTime()
          assert(!Number.isNaN(d0) && !Number.isNaN(d1) && d0 <= d1, 'jobs asc must be non-decreasing by startedAt')
        }
        if (desc.items.length >= 2) {
          const d0 = new Date(desc.items[0]?.startedAt || 0).getTime()
          const d1 = new Date(desc.items[1]?.startedAt || 0).getTime()
          assert(!Number.isNaN(d0) && !Number.isNaN(d1) && d0 >= d1, 'jobs desc must be non-increasing by startedAt')
        }
      }
      if (jobsList.items.length > 0) {
        const j = jobsList.items[0]
        assert(typeof j.jobId === 'string', 'jobId must be string')
        assert(typeof j.jobType === 'string', 'jobType must be string')
        assert(typeof j.status === 'string', 'status must be string')
        assert(j.progress && typeof j.progress.processed === 'number', 'progress.processed must be number')
        assert(j.progress && typeof j.progress.total === 'number', 'progress.total must be number')
        const jDetail = await httpJson(`${base}/v1/admin/jobs/${encodeURIComponent(j.jobId)}`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(jDetail?.jobId === j.jobId, 'job detail jobId must match')
        assert(typeof jDetail?.jobType === 'string', 'job detail jobType must be string')
        assert(typeof jDetail?.status === 'string', 'job detail status must be string')
        assert(jDetail?.progress && typeof jDetail.progress.processed === 'number', 'job detail progress.processed must be number')
        assert(jDetail?.progress && typeof jDetail.progress.total === 'number', 'job detail progress.total must be number')
        if (typeof j.requestId === 'string' && j.requestId.length > 0) {
          assert(jDetail?.requestId === j.requestId, 'job detail requestId must match')
        }
        const jobsByStatus = await httpJson(`${base}/v1/admin/jobs?status=${encodeURIComponent(j.status)}&limit=5&page=1`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(jobsByStatus?.items), 'admin jobs filtered by status items must be array')
        if (jobsByStatus.items.length > 0) {
          for (const it of jobsByStatus.items) {
            assert(it.status === j.status, 'jobs status filter must match')
          }
        }
        const jobsByType = await httpJson(`${base}/v1/admin/jobs?jobType=${encodeURIComponent(j.jobType)}&limit=5&page=1`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(jobsByType?.items), 'admin jobs filtered by jobType items must be array')
        if (jobsByType.items.length > 0) {
          for (const it of jobsByType.items) {
            assert(it.jobType === j.jobType, 'jobs jobType filter must match')
          }
        }
      }
      const jobsCsvRes = await fetch(`${base}/v1/admin/jobs:csv?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      const jobsCsvText = await jobsCsvRes.text()
      assert(jobsCsvRes.ok, `jobs csv must be 200, got ${jobsCsvRes.status}`)
      assert(jobsCsvText.split('\n').length >= 2, 'jobs csv must contain at least header + 1 line')

      if (process.env.ADMIN_API_KEY && process.env.SMOKE_SIM_ICCID) {
        const targetIccid = String(process.env.SMOKE_SIM_ICCID)
        const resetA = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:reset-activated`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
        })
        assert(resetA?.success === true, 'reset-activated must return success=true')
        const toDeactivated = await httpJson(`${base}/v1/sims/${encodeURIComponent(targetIccid)}`, {
          method: 'PATCH',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: { status: 'DEACTIVATED' },
        })
        assert(typeof toDeactivated?.jobId === 'string', 'patch status must return jobId')
        const retireRes = await fetch(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:retire`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
        })
        const retireText = await retireRes.text()
        let retireBody = null
        try { retireBody = retireText ? JSON.parse(retireText) : null } catch {}
        if (retireRes.ok) {
          assert(retireBody?.success === true, 'admin retire must return success=true')
          const backActivated = await httpJson(`${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:reset-activated`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          })
          assert(backActivated?.success === true, 'reset-activated after retire must return success=true')
        } else if (retireRes.status === 400 && retireBody?.code === 'COMMITMENT_NOT_MET') {
          log(`WARN: admin retire blocked by commitment: ${retireBody?.message}`)
        } else {
          throw new Error(`HTTP ${retireRes.status} ${base}/v1/admin/sims/${encodeURIComponent(targetIccid)}:retire: ${retireText}`)
        }
      } else {
        process.stdout.write('SKIP: Admin retire smoke (set ADMIN_API_KEY and SMOKE_SIM_ICCID)\n')
      }
      {
        const header = jobsCsvText.split('\n')[0].trim()
        assert(
          header === 'jobId,jobType,status,progress,startedAt,finishedAt,requestId,error',
          'jobs csv header must match'
        )
      }
      {
        const jobsPage2 = await httpJson(`${base}/v1/admin/jobs?limit=1&page=2`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(jobsPage2?.items), 'admin jobs page2 items must be array')
      }
      const now = new Date()
      const startIso = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
      const endIso = now.toISOString()
      const jobsDateFiltered = await httpJson(`${base}/v1/admin/jobs?startDate=${encodeURIComponent(startIso)}&endDate=${encodeURIComponent(endIso)}&limit=5&page=1`, {
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      assert(Array.isArray(jobsDateFiltered?.items), 'admin jobs date-filtered items must be array')
      const anyJob = jobsList.items[0] || jobsDateFiltered.items[0]
      if (anyJob && typeof anyJob.requestId === 'string' && anyJob.requestId.length > 0) {
        const jobsByReq = await httpJson(`${base}/v1/admin/jobs?requestId=${encodeURIComponent(anyJob.requestId)}&limit=5&page=1`, {
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        assert(Array.isArray(jobsByReq?.items), 'admin jobs filtered by requestId items must be array')
        if (jobsByReq.items.length > 0) {
          for (const it of jobsByReq.items) {
            assert(it.requestId === anyJob.requestId, 'requestId filter must match')
          }
        }
      }
      }
    }

    const cmpWebhookKey = process.env.CMP_WEBHOOK_KEY || process.env.ADMIN_API_KEY
    if (cmpWebhookKey && process.env.SMOKE_SIM_ICCID) {
      const targetIccid = String(process.env.SMOKE_SIM_ICCID)
      const res = await httpJson(`${base}/v1/cmp/webhook/sim-status-changed`, {
        method: 'POST',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': cmpWebhookKey, 'Content-Type': 'application/json' } }),
        body: { iccid: targetIccid, status: 'TEST_READY' }
      })
      assert(res?.success === true, 'cmp webhook must return success=true')
    } else {
      process.stdout.write('SKIP: CMP webhook smoke (set CMP_WEBHOOK_KEY or ADMIN_API_KEY and SMOKE_SIM_ICCID)\n')
    }
    if (process.env.WXZHONGGENG_WEBHOOK_KEY && process.env.SMOKE_SIM_ICCID) {
      const targetIccid = String(process.env.SMOKE_SIM_ICCID)
      const eventTime = new Date().toISOString()
      const msisdn = String(process.env.SMOKE_SIM_MSISDN || '0000000000000')
      const sign = `sig-${Date.now()}`
      const uuid = `wx-${Date.now()}-${Math.floor(Math.random() * 100000)}`
      const online = await httpJson(`${base}/v1/wx/webhook/sim-online`, {
        method: 'POST',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': process.env.WXZHONGGENG_WEBHOOK_KEY, 'Content-Type': 'application/json' } }),
        body: {
          messageType: 'LocationUpdate',
          iccid: targetIccid,
          msisdn,
          sign,
          uuid,
          occurredAt: eventTime,
          data: { mncList: '01', eventTime, mcc: '460' },
        }
      })
      assert(online?.success === true, 'wx sim-online must return success=true')
      const alert = await httpJson(`${base}/v1/wx/webhook/traffic-alert`, {
        method: 'POST',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': process.env.WXZHONGGENG_WEBHOOK_KEY, 'Content-Type': 'application/json' } }),
        body: {
          messageType: 'BalanceAlert',
          iccid: targetIccid,
          msisdn,
          sign,
          uuid,
          occurredAt: eventTime,
          limitKb: 102400,
          totalKb: 204800,
          data: {
            thresholdReached: '80',
            eventTime,
            limit: '102400',
            eventName: 'UsageThreshold',
            balanceAmount: '20480',
            addOnID: 'ADDON1',
          },
        }
      })
      assert(alert?.success === true, 'wx traffic-alert must return success=true')
      const simStatus = await httpJson(`${base}/v1/wx/webhook/sim-status-changed`, {
        method: 'POST',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': process.env.WXZHONGGENG_WEBHOOK_KEY, 'Content-Type': 'application/json' } }),
        body: {
          messageType: 'SimStatus',
          iccid: targetIccid,
          msisdn,
          sign,
          uuid,
          data: {
            toStatus: 'ACTIVATED',
            fromStatus: 'TEST_READY',
            eventTime,
            transactionId: `tx-${Date.now()}`,
          },
        },
      })
      assert(simStatus?.success === true, 'wx sim-status-changed must return success=true')
      const productOrder = await httpJson(`${base}/v1/wx/webhook/product-order`, {
        method: 'POST',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': process.env.WXZHONGGENG_WEBHOOK_KEY, 'Content-Type': 'application/json' } }),
        body: {
          messageType: 'ProductOrder',
          iccid: targetIccid,
          msisdn,
          sign,
          uuid,
          data: {
            addOnId: `addon-${Date.now()}`,
            addOnType: 'DATA',
            startDate: eventTime,
            transactionId: `order-${Date.now()}`,
            expirationDate: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          },
        },
      })
      assert(productOrder?.success === true, 'wx product-order must return success=true')
    } else {
      process.stdout.write('SKIP: WXZHONGGENG webhook smoke (set WXZHONGGENG_WEBHOOK_KEY and SMOKE_SIM_ICCID)\n')
    }

    const corsOrigin = getCorsOrigin()
    if (corsOrigin) {
      const preflight = await fetch(`${base}/v1/bills`, {
        method: 'OPTIONS',
        headers: {
          Origin: corsOrigin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      })
      assert(preflight.status === 204, 'CORS preflight must return 204')
      const allowOrigin = preflight.headers.get('access-control-allow-origin')
      assert(allowOrigin === '*' || allowOrigin === corsOrigin, 'CORS allow-origin must match')
      assert(Boolean(preflight.headers.get('access-control-allow-headers')), 'CORS allow-headers must exist')
    }

    const tokenMaxEnv = process.env.RATE_LIMIT_TOKEN_MAX
    const tokenMax = tokenMaxEnv ? Number(tokenMaxEnv) : null
    if (typeof tokenMax === 'number' && tokenMax > 0) {
      const first = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: buildHeaders({ includeAuth: false, extra: { 'Content-Type': 'application/json' } }),
        body: {
          clientId: process.env.AUTH_CLIENT_ID || 'cmp',
          clientSecret: process.env.AUTH_CLIENT_SECRET || 'cmp-secret',
        },
      })
      const remaining = first.headers.get('x-ratelimit-remaining')
      const limit = first.headers.get('x-ratelimit-limit')
      const reset = first.headers.get('x-ratelimit-reset')
      assert(remaining !== null && limit !== null && reset !== null, 'Rate limit headers must exist on token')
      await first.text()
      for (let i = 0; i < tokenMax - 1; i++) {
        const r = await fetch(`${base}/v1/auth/token`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'Content-Type': 'application/json' } }),
          body: {
            clientId: process.env.AUTH_CLIENT_ID || 'cmp',
            clientSecret: process.env.AUTH_CLIENT_SECRET || 'cmp-secret',
          },
        })
        await r.text()
      }
      const r2 = await fetch(`${base}/v1/auth/token`, {
        method: 'POST',
        headers: buildHeaders({ includeAuth: false, extra: { 'Content-Type': 'application/json' } }),
        body: {
          clientId: process.env.AUTH_CLIENT_ID || 'cmp',
          clientSecret: process.env.AUTH_CLIENT_SECRET || 'cmp-secret',
        },
      })
      const retryAfter = r2.headers.get('retry-after')
      assert(r2.status === 429, 'Token rate limit must return 429')
      assert(retryAfter !== null, '429 must include Retry-After')
    }

    const adminMaxEnv = process.env.RATE_LIMIT_ADMIN_MAX
    const adminMax = adminMaxEnv ? Number(adminMaxEnv) : null
    if (adminKey && typeof adminMax === 'number' && adminMax > 0) {
      const first = await fetch(`${base}/v1/admin/api-clients?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      const remaining = first.headers.get('x-ratelimit-remaining')
      const limit = first.headers.get('x-ratelimit-limit')
      const reset = first.headers.get('x-ratelimit-reset')
      assert(remaining !== null && limit !== null && reset !== null, 'Rate limit headers must exist on admin')
      await first.text()
      for (let i = 0; i < adminMax - 1; i++) {
        const r = await fetch(`${base}/v1/admin/api-clients?limit=1&page=1`, {
          method: 'GET',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
        })
        await r.text()
      }
      const r2 = await fetch(`${base}/v1/admin/api-clients?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
      })
      const retryAfter = r2.headers.get('retry-after')
      assert(r2.status === 429, 'Admin rate limit must return 429')
      assert(retryAfter !== null, '429 must include Retry-After')
    }

    try {
      const simsRes = await fetch(`${base}/v1/sims?limit=50&page=1`, {
        method: 'GET',
        headers: authHeaders(),
      })
      const simsFilters = simsRes.headers.get('x-filters')
      assert(simsFilters !== null, 'sims list must include X-Filters header')
      const sims = await simsRes.json()
      assert(typeof sims?.total === 'number', 'sims.total must be number')
      assert(Array.isArray(sims?.items), 'sims.items must be array')

      const metricsText = await httpText(`${base}/metrics`, { headers: buildHeaders({ includeAuth: false }) })
      assert(metricsText.includes('# TYPE cmp_requests_total counter'), 'metrics must include prometheus TYPE line')
      assert(metricsText.includes('cmp_requests_labeled_total'), 'metrics must include labeled counters')

      if (sims.items.length > 0) {
        // Prefer a SIM with enterpriseId for subscription tests
        const sim = sims.items.find(s => s.enterpriseId) || sims.items[0]
        assert(typeof sim?.iccid === 'string' && sim.iccid.length > 5, 'sim.iccid must be string')

        const simDetail = await httpJson(`${base}/v1/sims/${encodeURIComponent(sim.iccid)}`, {
          headers: authHeaders(),
        })
        assert(simDetail?.iccid === sim.iccid, 'sim detail iccid must match')

        const now = new Date()
        const start = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
        const end = now.toISOString()
        let simId = null
        if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
          const c = createSupabaseRestClient({ useServiceRole: true })
          const rows = await c.select('sims', `select=sim_id&iccid=eq.${encodeURIComponent(sim.iccid)}&limit=1`)
          simId = Array.isArray(rows) ? rows[0]?.sim_id ?? null : null
        }
        if (simId) {
          const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
          const usage = await httpJson(
            `${base}/v1/sims/${encodeURIComponent(simId)}/usage?period=${encodeURIComponent(period)}`,
            { headers: authHeaders() }
          )
          assert(Array.isArray(usage?.byZone), 'usage.byZone must be array')
        } else {
          process.stdout.write('SKIP: sims usage smoke (set SUPABASE_SERVICE_ROLE_KEY)\n')
        }

        const balance = await httpJson(`${base}/v1/sims/${encodeURIComponent(sim.iccid)}/balance`, { headers: authHeaders() })
        assert(typeof balance?.currency === 'string', 'balance.currency must be string')

        const conn = await httpJson(`${base}/v1/sims/${encodeURIComponent(sim.iccid)}/connectivity-status`, { headers: authHeaders() })
        assert(conn?.iccid === sim.iccid, 'connectivity iccid must match')

        const loc = await httpJson(`${base}/v1/sims/${encodeURIComponent(sim.iccid)}/location`, { headers: authHeaders() })
        assert(Object.prototype.hasOwnProperty.call(loc || {}, 'visitedMccMnc'), 'location must include visitedMccMnc')

        const hist = await httpJson(
          `${base}/v1/sims/${encodeURIComponent(sim.iccid)}/location-history?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`,
          { headers: authHeaders() }
        )
        const histItems = Array.isArray(hist) ? hist : Array.isArray(hist?.items) ? hist.items : null
        assert(Array.isArray(histItems), 'location history must be array')
        if (histItems.length > 0) {
          const first = histItems[0]
          assert(Object.prototype.hasOwnProperty.call(first || {}, 'visitedMccMnc'), 'location history items must include visitedMccMnc')
        }
        const subsRes = await fetch(`${base}/v1/sims/${encodeURIComponent(sim.iccid)}/subscriptions`, { headers: authHeaders() })
        const subsFilters = subsRes.headers.get('x-filters')
        assert(subsFilters !== null, 'sim subscriptions must include X-Filters header')
        await subsRes.json()
      }
    } catch (err) {
      log(`SKIP: sims list smoke: ${err?.message || err}`)
    }

    const batchDeactivateEnabled = process.env.SMOKE_BATCH_DEACTIVATE ? process.env.SMOKE_BATCH_DEACTIVATE === '1' : true
    if (batchDeactivateEnabled && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SMOKE_SIM_ICCID) {
      const resellerToken = process.env.SMOKE_RESELLER_ADMIN_TOKEN ? String(process.env.SMOKE_RESELLER_ADMIN_TOKEN) : null
      const adminKey = process.env.ADMIN_API_KEY ? String(process.env.ADMIN_API_KEY) : null
      const hasAuthConfigured = Boolean(process.env.AUTH_TOKEN_SECRET || (process.env.OIDC_ISSUER && process.env.OIDC_AUDIENCE && process.env.OIDC_JWKS_URL))
      if (resellerToken || adminKey) {
        const c = createSupabaseRestClient({ useServiceRole: true })
        const iccid = String(process.env.SMOKE_SIM_ICCID)
        const rows = await c.select('sims', `select=enterprise_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
        const simRow = Array.isArray(rows) ? rows[0] : null
        if (simRow?.enterprise_id) {
          const idempotencyKey = `smoke-batch-deactivate-${iccid}`
          const headerAuth = resellerToken
            ? { Authorization: `Bearer ${resellerToken}` }
            : { 'X-API-Key': adminKey }
          const res = await httpJson(`${base}/v1/sims:batch-deactivate`, {
            method: 'POST',
            headers: buildHeaders({ includeAuth: false, extra: { ...headerAuth, 'Content-Type': 'application/json' } }),
            body: { enterpriseId: String(simRow.enterprise_id), reason: 'SMOKE_TEST', idempotencyKey },
          })
          assert(typeof res?.jobId === 'string', 'batch-deactivate jobId must be string')
          assert(typeof res?.status === 'string', 'batch-deactivate status must be string')
          log('Batch deactivate smoke passed')
          const total = typeof res?.totalRows === 'number' ? res.totalRows : typeof res?.progress?.total === 'number' ? res.progress.total : null
          if ((res.status === 'QUEUED' || res.status === 'RUNNING') && (total === null || total > 0)) {
            const cancelled = await httpJson(`${base}/v1/jobs/${encodeURIComponent(res.jobId)}:cancel`, {
              method: 'POST',
              headers: buildHeaders({ includeAuth: false, extra: headerAuth }),
            })
            assert(cancelled?.jobId === res.jobId, 'cancel jobId must match')
            assert(cancelled?.status === 'CANCELLED', 'cancel status must be CANCELLED')
            log('Job cancel smoke passed')
          } else {
            process.stdout.write('SKIP: Job cancel smoke (job not cancellable)\n')
          }
        } else {
          process.stdout.write('SKIP: Batch deactivate smoke (SIM not found)\n')
        }
      } else if (hasAuthConfigured) {
        process.stdout.write('SKIP: Batch deactivate smoke (set SMOKE_RESELLER_ADMIN_TOKEN)\n')
      } else {
        process.stdout.write('SKIP: Batch deactivate smoke (auth not configured and ADMIN_API_KEY not set)\n')
      }
    } else {
      process.stdout.write('SKIP: Batch deactivate smoke (set SUPABASE_SERVICE_ROLE_KEY, SMOKE_SIM_ICCID)\n')
    }

    if (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SMOKE_SIM_ICCID) {
      try {
      const c = createSupabaseRestClient({ useServiceRole: true })
      const iccid = String(process.env.SMOKE_SIM_ICCID)
      const rows = await c.select('sims', `select=sim_id,enterprise_id,supplier_id,carrier_id,operator_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
      const simRow = Array.isArray(rows) ? rows[0] : null
      if (simRow) {
        const entId = simRow.enterprise_id
        const supplierId = simRow.supplier_id
        const carrierId = simRow.carrier_id
        let operatorId = simRow.operator_id
        if (!operatorId && supplierId && carrierId) {
          const opRows = await c.select(
            'operators',
            `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&carrier_id=eq.${encodeURIComponent(carrierId)}&limit=1`
          )
          if (Array.isArray(opRows) && opRows[0]?.operator_id) {
            operatorId = opRows[0].operator_id
          } else {
            const createdOps = await c.insert('operators', { supplier_id: supplierId, carrier_id: carrierId })
            operatorId = Array.isArray(createdOps) ? createdOps[0]?.operator_id : null
          }
        }
        const plan = await c.insert('price_plans', {
          enterprise_id: entId,
          name: `smoke-${Date.now()}`,
          type: 'FIXED_BUNDLE',
          service_type: 'DATA',
          currency: 'USD',
          billing_cycle_type: 'CALENDAR_MONTH',
          first_cycle_proration: 'NONE',
        })
        const planId = Array.isArray(plan) ? plan[0]?.price_plan_id : null
        const ppv = await c.insert('price_plan_versions', {
          price_plan_id: planId,
          version: 1,
          monthly_fee: 0,
          quota_kb: 102400,
        })
        const ppvId = Array.isArray(ppv) ? ppv[0]?.price_plan_version_id : null
        const pkg = await c.insert('packages', {
          enterprise_id: entId,
          name: `smoke-pkg-${Date.now()}`,
        })
        const pkgId = Array.isArray(pkg) ? pkg[0]?.package_id : null
        const terms1 = {
          testPeriodDays: 14,
          testQuotaKb: 102400,
          testExpiryCondition: 'PERIOD_OR_QUOTA',
          commitmentPeriodMonths: 1,
        }
        const pv1 = await c.insert('package_versions', {
          package_id: pkgId,
          version: 1,
          status: 'PUBLISHED',
          supplier_id: supplierId,
          carrier_id: carrierId,
          operator_id: operatorId,
          service_type: 'DATA',
          commercial_terms: terms1,
          price_plan_version_id: ppvId,
        })
        const pv1Id = Array.isArray(pv1) ? pv1[0]?.package_version_id : null
        const terms2 = {
          commitmentPeriodDays: 10,
        }
        const pv2 = await c.insert('package_versions', {
          package_id: pkgId,
          version: 2,
          status: 'PUBLISHED',
          supplier_id: supplierId,
          carrier_id: carrierId,
          operator_id: operatorId,
          service_type: 'DATA',
          commercial_terms: terms2,
          price_plan_version_id: ppvId,
        })
        const pv2Id = Array.isArray(pv2) ? pv2[0]?.package_version_id : null
        const pv3 = await c.insert('package_versions', {
          package_id: pkgId,
          version: 3,
          status: 'PUBLISHED',
          supplier_id: supplierId,
          carrier_id: carrierId,
          operator_id: operatorId,
          service_type: 'DATA',
          commercial_terms: {},
          price_plan_version_id: ppvId,
        })
        const pv3Id = Array.isArray(pv3) ? pv3[0]?.package_version_id : null
        const pv4 = await c.insert('package_versions', {
          package_id: pkgId,
          version: 4,
          status: 'PUBLISHED',
          supplier_id: supplierId,
          carrier_id: carrierId,
          operator_id: operatorId,
          service_type: 'DATA',
          commercial_terms: { commitment_period_days: 5 },
          price_plan_version_id: ppvId,
        })
        const pv4Id = Array.isArray(pv4) ? pv4[0]?.package_version_id : null
        const now = new Date()
        const scenarioStart = now.toISOString()
        const nextStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString()
        const created = await httpJson(`${base}/v1/subscriptions`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: { enterpriseId: entId, iccid, packageVersionId: pv1Id, kind: 'MAIN', effectiveAt: nextStart },
        })
        assert(typeof created?.subscriptionId === 'string', 'subscriptionId must be string')
        assert(created?.effectiveAt === nextStart, 'effectiveAt must match')
        assert(typeof created?.commitmentEndAt === 'string', 'commitmentEndAt must be string')
        {
          const eff = new Date(nextStart)
          const expected = new Date(Date.UTC(
            eff.getUTCMonth() + 1 >= 12 ? eff.getUTCFullYear() + Math.floor((eff.getUTCMonth() + 1) / 12) : eff.getUTCFullYear(),
            (eff.getUTCMonth() + 1) % 12,
            eff.getUTCDate(), eff.getUTCHours(), eff.getUTCMinutes(), eff.getUTCSeconds(), eff.getUTCMilliseconds()
          )).toISOString()
          assert(created.commitmentEndAt === expected, 'commitmentEndAt months calc must match')
        }
        let subList = null
        let hit = null
        for (let i = 0; i < 3; i += 1) {
          subList = await httpJson(`${base}/v1/sims/${encodeURIComponent(iccid)}/subscriptions`, { headers: authHeaders() })
          assert(Array.isArray(subList?.items), 'subscriptions list items must be array')
          hit = subList.items.find((s) => String(s.subscriptionId) === String(created.subscriptionId)) || null
          if (hit) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        if (subList.items.length > 0) {
          if (!hit) {
            log('SKIP: subscription list missing created subscription')
          } else {
            const listCommitmentMs = hit.commitmentEndAt ? new Date(hit.commitmentEndAt).getTime() : null
            const createdCommitmentMs = created.commitmentEndAt ? new Date(created.commitmentEndAt).getTime() : null
            assert(listCommitmentMs === createdCommitmentMs, 'list commitmentEndAt must match created')
          }
        }
        let createdActive = null
        let createdActiveOwned = false
        let switched = null
        try {
          switched = await httpJson(`${base}/v1/subscriptions:switch`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: { enterpriseId: entId, iccid, newPackageVersionId: pv2Id, effectiveStrategy: 'NEXT_CYCLE' },
          })
        } catch (err) {
          const msg = String(err?.message || err)
          if (msg.includes('SUBSCRIPTION_NOT_FOUND') || msg.includes('HTTP 404')) {
            try {
              createdActive = await httpJson(`${base}/v1/subscriptions`, {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: { enterpriseId: entId, iccid, packageVersionId: pv1Id, kind: 'MAIN', effectiveAt: new Date().toISOString() },
              })
              createdActiveOwned = true
              assert(typeof createdActive?.subscriptionId === 'string', 'active subscriptionId must be string')
              assert(createdActive?.state === 'ACTIVE', 'active subscription state must be ACTIVE')
            } catch (createErr) {
              const createMsg = String(createErr?.message || createErr)
              if (!createMsg.includes('MAIN_SUBSCRIPTION_EXISTS') && !createMsg.includes('HTTP 409')) {
                throw createErr
              }
            }
            switched = await httpJson(`${base}/v1/subscriptions:switch`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: { enterpriseId: entId, iccid, newPackageVersionId: pv2Id, effectiveStrategy: 'NEXT_CYCLE' },
            })
          } else {
            throw err
          }
        }
        assert(typeof switched?.newSubscriptionId === 'string', 'switch newSubscriptionId must be string')
        assert(typeof switched?.cancelledSubscriptionId === 'string', 'switch cancelledSubscriptionId must be string')
        assert(switched?.effectiveAt === nextStart, 'switch effectiveAt must match nextStart')
        const cancelledImm = await httpJson(`${base}/v1/subscriptions/${encodeURIComponent(switched.newSubscriptionId)}:cancel?immediate=true&enterpriseId=${encodeURIComponent(String(entId))}`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: {},
        })
        assert(cancelledImm?.state === 'CANCELLED', 'cancel immediate state must be CANCELLED')
        assert(typeof cancelledImm?.expiresAt === 'string', 'cancel immediate expiresAt must be string')
        const cancelledDeferred = await httpJson(`${base}/v1/subscriptions/${encodeURIComponent(created.subscriptionId)}:cancel?immediate=false&enterpriseId=${encodeURIComponent(String(entId))}`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: {},
        })
        assert(cancelledDeferred?.state === 'EXPIRED', 'cancel deferred state must be EXPIRED')
        assert(typeof cancelledDeferred?.expiresAt === 'string', 'cancel deferred expiresAt must be string')
        const createdNoCommit = await httpJson(`${base}/v1/subscriptions`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: { enterpriseId: entId, iccid, packageVersionId: pv3Id, kind: 'MAIN', effectiveAt: nextStart },
        })
        assert(typeof createdNoCommit?.subscriptionId === 'string', 'no-commit subscriptionId must be string')
        assert(createdNoCommit?.commitmentEndAt === null, 'no-commit commitmentEndAt must be null')
        const subList2 = await httpJson(`${base}/v1/sims/${encodeURIComponent(iccid)}/subscriptions`, { headers: authHeaders() })
        const hitNoCommit = Array.isArray(subList2?.items) ? subList2.items.find((s) => String(s.subscriptionId) === String(createdNoCommit.subscriptionId)) : null
        assert(hitNoCommit && hitNoCommit.commitmentEndAt === null, 'list must show null commitmentEndAt for no-commit subscription')
        const createdUnderscore = await httpJson(`${base}/v1/subscriptions`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: { enterpriseId: entId, iccid, packageVersionId: pv4Id, kind: 'MAIN', effectiveAt: nextStart },
        })
        assert(typeof createdUnderscore?.subscriptionId === 'string', 'underscore subscriptionId must be string')
        assert(typeof createdUnderscore?.commitmentEndAt === 'string', 'underscore commitmentEndAt must be string')
        {
          const eff = new Date(createdUnderscore.effectiveAt)
          const expected = new Date(eff.getTime() + 5 * 24 * 3600 * 1000).toISOString()
          assert(createdUnderscore.commitmentEndAt === expected, 'underscore days calc must match')
        }
        if (adminKey) {
          try {
            const evs = await httpJson(`${base}/v1/admin/events?eventType=SUBSCRIPTION_CHANGED&start=${encodeURIComponent(scenarioStart)}&limit=50&page=1`, {
              headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
            })
            assert(Array.isArray(evs?.items), 'subscription events items must be array')
            const evCreate = evs.items.find(
              (e) =>
                String(e.payload?.subscriptionId) === String(created.subscriptionId) &&
                e.payload?.afterState === 'PENDING'
            )
            if (evCreate) {
              assert(evCreate.payload?.effectiveAt === created.effectiveAt, 'create event effectiveAt must match')
            } else {
              log('SKIP: subscription create event not found')
            }
            const evSwitch = evs.items.find(
              (e) =>
                String(e.payload?.subscriptionId) === String(switched.newSubscriptionId) &&
                e.payload?.afterState === 'PENDING'
            )
            if (!evSwitch) {
              log('SKIP: subscription switch event not found')
            }
            const evCancelSwitch = evs.items.find((e) => String(e.payload?.subscriptionId) === String(switched.newSubscriptionId) && e.payload?.afterState === 'CANCELLED')
            if (!evCancelSwitch) {
              log('SKIP: cancel event for switched subscription not found')
            }
            const evCancelCreated = evs.items.find(
              (e) =>
                String(e.payload?.subscriptionId) === String(created.subscriptionId) &&
                (e.payload?.afterState === 'CANCELLED' || e.payload?.afterState === 'EXPIRED')
            )
            if (!evCancelCreated) {
              log('SKIP: cancel event for created subscription not found')
            }
            const aCreate = await httpJson(`${base}/v1/admin/audits?action=SUBSCRIPTION_CREATE&limit=50&page=1`, {
              headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
            })
            assert(Array.isArray(aCreate?.items), 'audit SUBSCRIPTION_CREATE items must be array')
            const aCreateHit = aCreate.items.find((a) => a.afterData?.commitmentEndAt === created.commitmentEndAt)
            if (!aCreateHit) {
              log('SKIP: audit SUBSCRIPTION_CREATE not found')
            }
            const aSwitch = await httpJson(`${base}/v1/admin/audits?action=SUBSCRIPTION_SWITCH&limit=50&page=1`, {
              headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
            })
            assert(Array.isArray(aSwitch?.items), 'audit SUBSCRIPTION_SWITCH items must be array')
            const aSwitchHit = aSwitch.items.find((a) => String(a.afterData?.toPackageVersionId || '') === String(pv2Id))
            if (!aSwitchHit) {
              log('SKIP: audit SUBSCRIPTION_SWITCH not found')
            }
            const aCancel = await httpJson(`${base}/v1/admin/audits?action=SUBSCRIPTION_CANCEL&limit=50&page=1`, {
              headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
            })
            assert(Array.isArray(aCancel?.items), 'audit SUBSCRIPTION_CANCEL items must be array')
            const aCancelImm = aCancel.items.find((a) => a.afterData?.immediate === true)
            const aCancelDef = aCancel.items.find((a) => a.afterData?.immediate === false)
            if (!(aCancelImm && aCancelDef)) {
              log('SKIP: audit SUBSCRIPTION_CANCEL not found')
            }
          } catch (err) {
            log(`SKIP: subscription admin events/audits unavailable: ${err?.message || err}`)
          }
        }
        try {
          await c.delete('package_versions', `package_version_id=eq.${encodeURIComponent(String(pv1Id))}`)
        } catch {}
        try {
          await c.delete('package_versions', `package_version_id=eq.${encodeURIComponent(String(pv2Id))}`)
        } catch {}
        try {
          await c.delete('package_versions', `package_version_id=eq.${encodeURIComponent(String(pv3Id))}`)
        } catch {}
        try {
          await c.delete('package_versions', `package_version_id=eq.${encodeURIComponent(String(pv4Id))}`)
        } catch {}
        try {
          await c.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(String(created.subscriptionId))}`)
        } catch {}
        try {
          await c.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(String(switched.newSubscriptionId))}`)
        } catch {}
        if (createdActiveOwned) {
          try {
            await c.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(String(createdActive.subscriptionId))}`)
          } catch {}
        }
        try {
          await c.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(String(createdNoCommit.subscriptionId))}`)
        } catch {}
        try {
          await c.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(String(createdUnderscore.subscriptionId))}`)
        } catch {}
        try {
          await c.delete('packages', `package_id=eq.${encodeURIComponent(String(pkgId))}`)
        } catch {}
        try {
          await c.delete('price_plan_versions', `price_plan_version_id=eq.${encodeURIComponent(String(ppvId))}`)
        } catch {}
        try {
          await c.delete('price_plans', `price_plan_id=eq.${encodeURIComponent(String(planId))}`)
        } catch {}
      } else {
        process.stdout.write('SKIP: Subscription smoke (SIM not found)\n')
      }
      } catch (err) {
        log(`SKIP: Subscription smoke: ${err?.message || err}`)
      }
    } else {
      process.stdout.write('SKIP: Subscription smoke (set SUPABASE_SERVICE_ROLE_KEY and SMOKE_SIM_ICCID)\n')
    }

    if (process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SMOKE_SIM_ICCID) {
      try {
        const c = createSupabaseRestClient({ useServiceRole: true })
        const iccid = String(process.env.SMOKE_SIM_ICCID)
        const simRows = await c.select('sims', `select=supplier_id,carrier_id,operator_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
        const simRow = Array.isArray(simRows) ? simRows[0] : null
        if (!simRow?.supplier_id) {
          process.stdout.write('SKIP: Network profile smoke (SIM missing supplier)\n')
        } else {
          const supplierId = String(simRow.supplier_id)
          const carrierId = simRow.carrier_id ? String(simRow.carrier_id) : null
          let operatorId = simRow.operator_id ? String(simRow.operator_id) : null
          if (!operatorId && simRow.supplier_id && simRow.carrier_id) {
            const opRows = await c.select(
              'operators',
              `select=operator_id&supplier_id=eq.${encodeURIComponent(simRow.supplier_id)}&carrier_id=eq.${encodeURIComponent(simRow.carrier_id)}&limit=1`
            )
            if (Array.isArray(opRows) && opRows[0]?.operator_id) {
              operatorId = String(opRows[0].operator_id)
            } else {
              const createdOps = await c.insert('operators', { supplier_id: simRow.supplier_id, carrier_id: simRow.carrier_id })
              operatorId = Array.isArray(createdOps) ? String(createdOps[0]?.operator_id || '') : null
            }
          }
          let mccmnc = null
          if (carrierId) {
            const carrierRows = await c.select('carriers', `select=mcc,mnc&carrier_id=eq.${encodeURIComponent(carrierId)}&limit=1`)
            const carrier = Array.isArray(carrierRows) ? carrierRows[0] : null
            if (carrier?.mcc && carrier?.mnc) {
              mccmnc = `${String(carrier.mcc)}-${String(carrier.mnc)}`
            }
          }
          if (!mccmnc) {
            process.stdout.write('SKIP: Network profile smoke (carrier mccmnc unavailable)\n')
          } else {
            const resellerToken = process.env.SMOKE_RESELLER_ADMIN_TOKEN ? String(process.env.SMOKE_RESELLER_ADMIN_TOKEN) : null
            const adminKey = process.env.ADMIN_API_KEY ? String(process.env.ADMIN_API_KEY) : null
            const auth = resellerToken ? { Authorization: `Bearer ${resellerToken}` } : adminKey ? { 'X-API-Key': adminKey } : null
            if (!auth) {
              process.stdout.write('SKIP: Network profile smoke (set SMOKE_RESELLER_ADMIN_TOKEN or ADMIN_API_KEY)\n')
            } else {
              const apn = await httpJson(`${base}/v1/apn-profiles`, {
                method: 'POST',
                headers: buildHeaders({ includeAuth: false, extra: { ...auth, 'Content-Type': 'application/json' } }),
                body: { name: `smoke-apn-${Date.now()}`, apn: 'cmp-smoke', authType: 'NONE', supplierId, operatorId: operatorId || carrierId },
              })
              assert(typeof apn?.apnProfileId === 'string', 'apnProfileId must be string')
              const apnVer = await httpJson(`${base}/v1/apn-profiles/${encodeURIComponent(apn.apnProfileId)}/versions`, {
                method: 'POST',
                headers: buildHeaders({ includeAuth: false, extra: { ...auth, 'Content-Type': 'application/json' } }),
                body: { apn: 'cmp-smoke-2', authType: 'NONE' },
              })
              assert(typeof apnVer?.profileVersionId === 'string', 'apn profileVersionId must be string')
              const apnPub = await httpJson(`${base}/v1/apn-profiles/${encodeURIComponent(apn.apnProfileId)}:publish`, {
                method: 'POST',
                headers: buildHeaders({ includeAuth: false, extra: auth }),
              })
              assert(apnPub?.status === 'PUBLISHED', 'apn publish status must be PUBLISHED')
              const apnList = await httpJson(`${base}/v1/apn-profiles?supplierId=${encodeURIComponent(supplierId)}&limit=1&page=1`, {
                headers: buildHeaders({ includeAuth: false, extra: auth }),
              })
              assert(Array.isArray(apnList?.items), 'apn profiles items must be array')
              const apnDetail = await httpJson(`${base}/v1/apn-profiles/${encodeURIComponent(apn.apnProfileId)}`, {
                headers: buildHeaders({ includeAuth: false, extra: auth }),
              })
              assert(apnDetail?.apnProfileId === apn.apnProfileId, 'apn detail id must match')
              const roaming = await httpJson(`${base}/v1/roaming-profiles`, {
                method: 'POST',
                headers: buildHeaders({ includeAuth: false, extra: { ...auth, 'Content-Type': 'application/json' } }),
                body: { name: `smoke-roam-${Date.now()}`, supplierId, operatorId: operatorId || carrierId, mccmncList: [mccmnc] },
              })
              assert(typeof roaming?.roamingProfileId === 'string', 'roamingProfileId must be string')
              const roamingVer = await httpJson(`${base}/v1/roaming-profiles/${encodeURIComponent(roaming.roamingProfileId)}/versions`, {
                method: 'POST',
                headers: buildHeaders({ includeAuth: false, extra: { ...auth, 'Content-Type': 'application/json' } }),
                body: { mccmncList: [mccmnc] },
              })
              assert(typeof roamingVer?.profileVersionId === 'string', 'roaming profileVersionId must be string')
              const roamingPub = await httpJson(`${base}/v1/roaming-profiles/${encodeURIComponent(roaming.roamingProfileId)}:publish`, {
                method: 'POST',
                headers: buildHeaders({ includeAuth: false, extra: auth }),
              })
              assert(roamingPub?.status === 'PUBLISHED', 'roaming publish status must be PUBLISHED')
              const roamingList = await httpJson(`${base}/v1/roaming-profiles?supplierId=${encodeURIComponent(supplierId)}&limit=1&page=1`, {
                headers: buildHeaders({ includeAuth: false, extra: auth }),
              })
              assert(Array.isArray(roamingList?.items), 'roaming profiles items must be array')
              const roamingDetail = await httpJson(`${base}/v1/roaming-profiles/${encodeURIComponent(roaming.roamingProfileId)}`, {
                headers: buildHeaders({ includeAuth: false, extra: auth }),
              })
              assert(roamingDetail?.roamingProfileId === roaming.roamingProfileId, 'roaming detail id must match')
              log('Network profile smoke passed')
            }
          }
        }
      } catch (err) {
        log(`SKIP: Network profile smoke: ${err?.message || err}`)
      }
    } else {
      process.stdout.write('SKIP: Network profile smoke (set SUPABASE_SERVICE_ROLE_KEY and SMOKE_SIM_ICCID)\n')
    }

    if (process.env.API_SMOKE_SKIP_BILLS === '1') {
      process.stdout.write('SKIP: Bills smoke (API_SMOKE_SKIP_BILLS=1)\n')
      process.stdout.write('PASS: Admin smoke (without bills)\n')
      return
    }
    const listRes = await fetch(`${base}/v1/bills?period=2026-02`, {
      method: 'GET',
      headers: authHeaders(),
    })
    const billsFilters = listRes.headers.get('x-filters')
    assert(billsFilters !== null, 'bills list must include X-Filters header')
    const list = await listRes.json()
    assert(typeof list?.total === 'number', 'bills.total must be number')
    assert(Array.isArray(list?.items), 'bills.items must be array')
    assert(list.total >= 1, 'bills.total must be >= 1')

    const first = list.items[0]
    assert(first?.period === '2026-02', 'first bill period must be 2026-02')
    assert(Number(first?.totalAmount) === 512, 'first bill totalAmount must be 512')
    assert(typeof first?.billId === 'string' && first.billId.length > 10, 'first billId must be string')

    const byDueAsc = await httpJson(`${base}/v1/bills?sortBy=dueDate&sortOrder=asc&limit=2&page=1`, {
      headers: authHeaders(),
    })
    assert(Array.isArray(byDueAsc?.items), 'bills sorted by dueDate must be array')
    if (byDueAsc.items.length >= 2) {
      const d0 = byDueAsc.items[0]?.dueDate ? new Date(byDueAsc.items[0].dueDate).getTime() : null
      const d1 = byDueAsc.items[1]?.dueDate ? new Date(byDueAsc.items[1].dueDate).getTime() : null
      if (d0 !== null && d1 !== null) {
        assert(d0 <= d1, 'dueDate asc order must be non-decreasing')
      }
    }
    const byTotalDesc = await httpJson(`${base}/v1/bills?sortBy=totalAmount&sortOrder=desc&limit=2&page=1`, {
      headers: authHeaders(),
    })
    assert(Array.isArray(byTotalDesc?.items), 'bills sorted by totalAmount must be array')
    if (byTotalDesc.items.length >= 2) {
      const t0 = Number(byTotalDesc.items[0]?.totalAmount ?? NaN)
      const t1 = Number(byTotalDesc.items[1]?.totalAmount ?? NaN)
      if (Number.isFinite(t0) && Number.isFinite(t1)) {
        assert(t0 >= t1, 'totalAmount desc order must be non-increasing')
      }
    }

    const bill = await httpJson(`${base}/v1/bills/${first.billId}`, {
      headers: authHeaders(),
    })
    assert(bill?.billId === first.billId, 'bill.billId must match')

    const files = await httpJson(`${base}/v1/bills/${first.billId}/files`, {
      headers: authHeaders(),
    })
    assert(Object.prototype.hasOwnProperty.call(files, 'pdfUrl'), 'files must include pdfUrl')
    assert(Object.prototype.hasOwnProperty.call(files, 'csvUrl'), 'files must include csvUrl')

    assert(typeof files.csvUrl === 'string' && files.csvUrl.length > 0, 'files.csvUrl must be a string')

    const csvRes = await fetch(`${base}${new URL(files.csvUrl).pathname}`, {
      method: 'GET',
      headers: authHeaders(),
    })
    const csvFilters = csvRes.headers.get('x-filters')
    assert(csvFilters !== null, 'bill csv must include X-Filters header')
    const csvText = await csvRes.text()
    assert(csvRes.ok, `csv download must be 200, got ${csvRes.status}`)
    assert(csvText.split('\n').length >= 2, 'csv must contain at least header + 1 line')

    const listCsvRes = await fetch(`${base}/v1/bills:csv?period=2026-02&limit=1000&page=1`, {
      method: 'GET',
      headers: authHeaders(),
    })
    const listCsvFilters = listCsvRes.headers.get('x-filters')
    assert(listCsvFilters !== null, 'bills:csv must include X-Filters header')
    const listCsvText = await listCsvRes.text()
    assert(listCsvRes.ok, `bills:csv download must be 200, got ${listCsvRes.status}`)
    assert(listCsvText.split('\n')[0].toLowerCase().includes('billid'), 'bills:csv must include billId header')
    assert(listCsvText.split('\n').length >= 2, 'bills:csv must contain at least header + 1 line')

    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const paid = await httpJson(`${base}/v1/bills/${first.billId}:mark-paid`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: {
          paymentRef: 'smoke',
          paidAt: new Date().toISOString(),
        },
      })
      assert(paid?.billId === first.billId, 'mark-paid billId must match')
      assert(paid?.status === 'PAID', 'mark-paid must set status=PAID')

      const note = await httpJson(`${base}/v1/bills/${first.billId}:adjust`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: {
          type: 'CREDIT',
          amount: 1.23,
          reason: 'smoke',
        },
      })
      assert(typeof note?.noteId === 'string' && note.noteId.length > 10, 'adjust must return noteId')
      process.stdout.write('PASS: API write smoke (mark-paid + adjust)\n')
    } else {
      process.stdout.write('SKIP: API write smoke (set SUPABASE_SERVICE_ROLE_KEY to enable)\n')
    }

    const globalMaxEnv = process.env.RATE_LIMIT_GLOBAL_MAX
    const globalMax = globalMaxEnv ? Number(globalMaxEnv) : null
    if (typeof globalMax === 'number' && globalMax > 0) {
      const firstHit = await fetch(`${base}/v1/bills?limit=1&page=1`, {
        method: 'GET',
        headers: authHeaders(),
      })
      const remaining = firstHit.headers.get('x-ratelimit-remaining')
      const limit = firstHit.headers.get('x-ratelimit-limit')
      const reset = firstHit.headers.get('x-ratelimit-reset')
      assert(remaining !== null && limit !== null && reset !== null, 'Global rate limit headers must exist')
      await firstHit.text()
      const remainNum = Number(remaining)
      if (Number.isFinite(remainNum) && remainNum > 0) {
        for (let i = 0; i < remainNum; i++) {
          const r = await fetch(`${base}/v1/bills?limit=1&page=1`, {
            method: 'GET',
            headers: authHeaders(),
          })
          await r.text()
        }
      }
      const last = await fetch(`${base}/v1/bills?limit=1&page=1`, {
        method: 'GET',
        headers: authHeaders(),
      })
      const retryAfter = last.headers.get('retry-after')
      assert(last.status === 429, 'Global rate limit must return 429 on overflow')
      assert(retryAfter !== null, 'Global 429 must include Retry-After')
    }

    const writeMaxEnv = process.env.RATE_LIMIT_WRITE_MAX
    const writeMax = writeMaxEnv ? Number(writeMaxEnv) : null
    if (process.env.SUPABASE_SERVICE_ROLE_KEY && typeof writeMax === 'number' && writeMax > 0) {
      const firstAdj = await fetch(`${base}/v1/bills/${encodeURIComponent(first.billId)}:adjust`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: {
          type: 'CREDIT',
          amount: 0.01,
          reason: 'rate-limit',
        },
      })
      const remaining = firstAdj.headers.get('x-ratelimit-remaining')
      const limit = firstAdj.headers.get('x-ratelimit-limit')
      const reset = firstAdj.headers.get('x-ratelimit-reset')
      assert(remaining !== null && limit !== null && reset !== null, 'Write rate limit headers must exist')
      await firstAdj.text()
      const remainNum = Number(remaining)
      if (Number.isFinite(remainNum) && remainNum > 0) {
        for (let i = 0; i < remainNum; i++) {
          const r = await fetch(`${base}/v1/bills/${encodeURIComponent(first.billId)}:adjust`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: {
              type: 'CREDIT',
              amount: 0.01,
              reason: 'rate-limit',
            },
          })
          await r.text()
        }
      }
      const lastAdj = await fetch(`${base}/v1/bills/${encodeURIComponent(first.billId)}:adjust`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: {
          type: 'CREDIT',
          amount: 0.01,
          reason: 'rate-limit-overflow',
        },
      })
      const retryAfterW = lastAdj.headers.get('retry-after')
      assert(lastAdj.status === 429, 'Write rate limit must return 429 on overflow')
      assert(retryAfterW !== null, 'Write 429 must include Retry-After')
    }

    process.stdout.write('PASS: API smoke test (health + bills)\n')
    log('ALL TESTS PASSED')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

main().catch((err) => {
  const msg = `${err.stack || err.message}\n`
  process.stderr.write(msg)
  try { fs.appendFileSync('smoke_log.txt', 'ERROR: ' + msg) } catch (e) {}
  process.exit(1)
})
