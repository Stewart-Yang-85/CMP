import 'dotenv/config'
import { createApp } from '../src/app.js'

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text}`)
  }
  return text ? JSON.parse(text) : null
}

function buildHeaders({ includeAuth = false, token = null, extra = {} } = {}) {
  const h = { ...extra }
  if (includeAuth && token) {
    h.Authorization = `Bearer ${token}`
  }
  return h
}

function getEnv(name) {
  const v = process.env[name]
  return v ? String(v) : null
}

function printHints() {
  const hasAuthId = !!getEnv('AUTH_CLIENT_ID')
  const hasAuthSecret = !!getEnv('AUTH_CLIENT_SECRET')
  if (!hasAuthId || !hasAuthSecret) {
    process.stdout.write('INFO: AUTH_CLIENT_ID/AUTH_CLIENT_SECRET not set, using defaults\n')
  }
  const hasAdmin = !!getEnv('ADMIN_API_KEY')
  if (!hasAdmin) {
    process.stdout.write('HINT: set ADMIN_API_KEY to enable admin queries and exports\n')
  }
  const hasSvc = !!getEnv('SUPABASE_SERVICE_ROLE_KEY')
  if (hasAdmin && !hasSvc) {
    process.stdout.write('HINT: set SUPABASE_SERVICE_ROLE_KEY to enable admin job triggers\n')
  }
  const hasCmp = !!getEnv('CMP_WEBHOOK_KEY') || !!getEnv('ADMIN_API_KEY')
  const hasSim = !!getEnv('SMOKE_SIM_ICCID')
  if (!hasCmp || !hasSim) {
    process.stdout.write('HINT: set CMP_WEBHOOK_KEY (or ADMIN_API_KEY) and SMOKE_SIM_ICCID to run CMP webhook\n')
  }
}

async function main() {
  const app = createApp()
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s))
    s.on('error', reject)
  })
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/v1`

  try {
    printHints()
    const tokenResp = await httpJson(`${base}/auth/token`, {
      method: 'POST',
      headers: buildHeaders({ extra: { 'Content-Type': 'application/json' } }),
      body: {
        clientId: getEnv('AUTH_CLIENT_ID') || 'cmp',
        clientSecret: getEnv('AUTH_CLIENT_SECRET') || 'cmp-secret',
      },
    })
    const accessToken = String(tokenResp?.accessToken || '')
    process.stdout.write(`accessToken.len=${accessToken.length}\n`)

    const sims = await httpJson(`${base}/sims?limit=1&page=1`, {
      headers: buildHeaders({ includeAuth: true, token: accessToken }),
    })
    const simsCount = Array.isArray(sims?.items) ? sims.items.length : 0
    process.stdout.write(`sims.items=${simsCount}\n`)

    const adminKey = getEnv('ADMIN_API_KEY')
    if (adminKey) {
      const audits = await httpJson(`${base}/admin/audits?limit=1&page=1`, {
        headers: buildHeaders({ extra: { 'X-API-Key': adminKey } }),
      })
      process.stdout.write(`audits.items=${Array.isArray(audits?.items) ? audits.items.length : 0}\n`)
      const csvRes = await fetch(`${base}/admin/audits:csv?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ extra: { 'X-API-Key': adminKey } }),
      })
      const csvText = await csvRes.text()
      process.stdout.write(`audits.csv.lines=${csvText.split('\n').length}\n`)

      const events = await httpJson(`${base}/admin/events?limit=1&page=1`, {
        headers: buildHeaders({ extra: { 'X-API-Key': adminKey } }),
      })
      process.stdout.write(`events.items=${Array.isArray(events?.items) ? events.items.length : 0}\n`)
      const eventsCsvRes = await fetch(`${base}/admin/events:csv?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ extra: { 'X-API-Key': adminKey } }),
      })
      const eventsCsvText = await eventsCsvRes.text()
      process.stdout.write(`events.csv.lines=${eventsCsvText.split('\n').length}\n`)
    } else {
      process.stdout.write('SKIP: admin queries (set ADMIN_API_KEY)\n')
    }

    const svcKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
    if (adminKey && svcKey) {
      const job = await httpJson(`${base}/admin/jobs:test-ready-expiry-run`, {
        method: 'POST',
        headers: buildHeaders({ extra: { 'X-API-Key': adminKey, 'Content-Type': 'application/json' } }),
        body: {},
      })
      process.stdout.write(`job.testReady.jobId=${String(job?.jobId || '')}\n`)
      const jobsCsvRes = await fetch(`${base}/admin/jobs:csv?limit=1&page=1`, {
        method: 'GET',
        headers: buildHeaders({ extra: { 'X-API-Key': adminKey } }),
      })
      const jobsCsvText = await jobsCsvRes.text()
      process.stdout.write(`jobs.csv.lines=${jobsCsvText.split('\n').length}\n`)
    } else {
      process.stdout.write('SKIP: job trigger (set ADMIN_API_KEY and SUPABASE_SERVICE_ROLE_KEY)\n')
    }

    const cmpKey = getEnv('CMP_WEBHOOK_KEY') || getEnv('ADMIN_API_KEY')
    const simIccid = getEnv('SMOKE_SIM_ICCID')
    if (cmpKey && simIccid) {
      const res = await httpJson(`${base}/cmp/webhook/sim-status-changed`, {
        method: 'POST',
        headers: buildHeaders({ extra: { 'X-API-Key': cmpKey, 'Content-Type': 'application/json' } }),
        body: { iccid: simIccid, status: 'TEST_READY' },
      })
      process.stdout.write(`cmp.webhook.success=${String(res?.success)} changed=${String(res?.changed)}\n`)
    } else {
      process.stdout.write('SKIP: cmp webhook (set CMP_WEBHOOK_KEY or ADMIN_API_KEY and SMOKE_SIM_ICCID)\n')
    }
  } finally {
    server.close()
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  process.exit(1)
})
