import fs from 'fs'
import 'dotenv/config'
console.log('START WX SMOKE TEST')
import { createApp } from '../src/app.js'

function log(msg) {
  console.log(msg)
  try { fs.appendFileSync('smoke_log_wx.txt', msg + '\n') } catch (e) {}
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch (e) {
    throw new Error(`Failed to parse JSON: ${text}`)
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text}`)
  }

  return data
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
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
    const adminKey = getAdminKey()
    if (!adminKey) throw new Error('ADMIN_API_KEY required')

    log('Testing WX sync daily usage...')
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const wxSync = await httpJson(`${base}/v1/admin/jobs:wx-sync-daily-usage`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          body: {},
        })
        log('wx-sync-daily-usage response: ' + JSON.stringify(wxSync))
        assert(typeof wxSync?.jobId === 'string', 'wx sync must return jobId')
        assert(typeof wxSync?.processed === 'number', 'wx sync processed must be number')
        assert(typeof wxSync?.total === 'number', 'wx sync total must be number')
        log('WX sync daily usage passed')
    } else {
        log('SKIP: WX sync daily usage (no SUPABASE_SERVICE_ROLE_KEY)')
    }

    log('Testing WX sync sim info batch...')
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const wxSyncSimInfo = await httpJson(`${base}/v1/admin/jobs:wx-sync-sim-info-batch`, {
          method: 'POST',
          headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
          body: { pageSize: 50, pageIndex: 1 },
        })
        log('wx-sync-sim-info-batch response: ' + JSON.stringify(wxSyncSimInfo))
        assert(typeof wxSyncSimInfo?.jobId === 'string', 'wx sync sim info must return jobId')
        assert(typeof wxSyncSimInfo?.processed === 'number', 'wx sync sim info processed must be number')
        assert(typeof wxSyncSimInfo?.total === 'number', 'wx sync sim info total must be number')
        log('WX sync sim info batch passed')
    } else {
        log('SKIP: WX sync sim info batch (no SUPABASE_SERVICE_ROLE_KEY)')
    }

    log('Testing WX sim status...')
      if (process.env.SMOKE_SIM_ICCID) {
          const iccid = String(process.env.SMOKE_SIM_ICCID)
          const simStatus = await httpJson(`${base}/v1/admin/wx/sims/${iccid}/status`, {
            method: 'GET',
            headers: buildHeaders({ includeAuth: false, extra: { 'X-API-Key': adminKey } }),
          })
          log('sim-status response: ' + JSON.stringify(simStatus))
          assert(simStatus?.data?.iccid === iccid, 'sim status iccid must match')
          assert(typeof simStatus?.data?.state === 'string', 'sim status state must be string')
          log('WX sim status passed')
      } else {
        log('SKIP: WX sim status (no SMOKE_SIM_ICCID)')
      }

  } catch (err) {
    log('SMOKE TEST FAILED: ' + err.stack)
    process.exit(1)
  } finally {
    server.close()
  }
}

main()
