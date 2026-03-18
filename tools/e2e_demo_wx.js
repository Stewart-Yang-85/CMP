import 'dotenv/config'
import { createApp } from '../src/app.js'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

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

function buildHeaders(extra = {}) {
  return { ...extra }
}

function getEnv(name) {
  const v = process.env[name]
  return v ? String(v) : null
}

function nowIso() {
  return new Date().toISOString()
}

function randomId(prefix = 'ORD') {
  const s = Math.random().toString(36).slice(2, 10)
  return `${prefix}-${s}`
}

function printHints() {
  const hasWx = !!getEnv('WXZHONGGENG_WEBHOOK_KEY')
  const hasSim = !!getEnv('SMOKE_SIM_ICCID') || !!getEnv('DEMO_SIM_ICCID')
  const hasMsisdn = !!getEnv('SMOKE_SIM_MSISDN') || !!getEnv('DEMO_SIM_MSISDN') || !!getEnv('SUPABASE_SERVICE_ROLE_KEY')
  if (!hasWx || !hasSim || !hasMsisdn) {
    process.stdout.write('HINT: set WXZHONGGENG_WEBHOOK_KEY and SMOKE_SIM_ICCID (or DEMO_SIM_ICCID) plus SMOKE_SIM_MSISDN (or DEMO_SIM_MSISDN), or set SUPABASE_SERVICE_ROLE_KEY to auto-resolve msisdn\n')
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
    const wxKey = getEnv('WXZHONGGENG_WEBHOOK_KEY')
    const iccid = getEnv('SMOKE_SIM_ICCID') || getEnv('DEMO_SIM_ICCID')
    let msisdn = getEnv('SMOKE_SIM_MSISDN') || getEnv('DEMO_SIM_MSISDN')
    if (!wxKey || !iccid) {
      process.stdout.write('SKIP: wx webhook demo (set WXZHONGGENG_WEBHOOK_KEY and SMOKE_SIM_ICCID or DEMO_SIM_ICCID)\n')
      return
    }
    if (!msisdn && getEnv('SUPABASE_SERVICE_ROLE_KEY')) {
      const c = createSupabaseRestClient({ useServiceRole: true })
      const rows = await c.select('sims', `select=msisdn&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
      const sim = Array.isArray(rows) ? rows[0] : null
      if (sim?.msisdn) msisdn = String(sim.msisdn)
    }
    if (!msisdn) {
      process.stdout.write('SKIP: wx webhook demo (set SMOKE_SIM_MSISDN or DEMO_SIM_MSISDN, or SUPABASE_SERVICE_ROLE_KEY)\n')
      return
    }

    const online = await httpJson(`${base}/wx/webhook/sim-online`, {
      method: 'POST',
      headers: buildHeaders({ 'X-API-Key': wxKey, 'Content-Type': 'application/json' }),
      body: {
        iccid,
        messageType: 'LocationUpdate',
        msisdn,
        sign: randomId('SIGN'),
        uuid: randomId('WX'),
        data: { mncList: '01', eventTime: nowIso(), mcc: '310' },
      },
    })
    process.stdout.write(`wx.sim-online.success=${String(online?.success)}\n`)

    const statusChanged = await httpJson(`${base}/wx/webhook/sim-status-changed`, {
      method: 'POST',
      headers: buildHeaders({ 'X-API-Key': wxKey, 'Content-Type': 'application/json' }),
      body: {
        iccid,
        messageType: 'StatusChange',
        msisdn,
        sign: randomId('SIGN'),
        uuid: randomId('WX'),
        data: {
          toStatus: 'ACTIVATED',
          fromStatus: 'INVENTORY',
          eventTime: nowIso(),
          transactionId: randomId('TX'),
        },
      },
    })
    process.stdout.write(`wx.sim-status-changed.success=${String(statusChanged?.success)}\n`)

    const traffic = await httpJson(`${base}/wx/webhook/traffic-alert`, {
      method: 'POST',
      headers: buildHeaders({ 'X-API-Key': wxKey, 'Content-Type': 'application/json' }),
      body: {
        iccid,
        messageType: 'TrafficAlert',
        msisdn,
        sign: randomId('SIGN'),
        uuid: randomId('WX'),
        data: {
          thresholdReached: '80',
          eventTime: nowIso(),
          limit: '102400',
          eventName: 'UsageThreshold',
          balanceAmount: '20480',
          addOnID: 'ADDON1',
        },
      },
    })
    process.stdout.write(`wx.traffic-alert.success=${String(traffic?.success)}\n`)

    const product = await httpJson(`${base}/wx/webhook/product-order`, {
      method: 'POST',
      headers: buildHeaders({ 'X-API-Key': wxKey, 'Content-Type': 'application/json' }),
      body: {
        iccid,
        messageType: 'ProductOrder',
        msisdn,
        sign: randomId('SIGN'),
        uuid: randomId('WX'),
        data: {
          addOnId: 'TESTPKG',
          addOnType: 'DATA',
          startDate: nowIso(),
          transactionId: randomId('TX'),
          expirationDate: nowIso(),
        },
      },
    })
    process.stdout.write(`wx.product-order.success=${String(product?.success)}\n`)

    const adminKey = getEnv('ADMIN_API_KEY')
    const svcKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
    const authId = getEnv('AUTH_CLIENT_ID')
    const authSecret = getEnv('AUTH_CLIENT_SECRET')
    if (adminKey && svcKey && authId && authSecret && iccid) {
      const tokenResp = await httpJson(`${base}/auth/token`, {
        method: 'POST',
        headers: buildHeaders({ 'Content-Type': 'application/json' }),
        body: { clientId: authId, clientSecret: authSecret },
      })
      const accessToken = String(tokenResp?.accessToken || '')
      const c = createSupabaseRestClient({ useServiceRole: true })
      const simRows = await c.select('sims', `select=sim_id,enterprise_id,supplier_id,carrier_id,operator_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
      const sim = Array.isArray(simRows) ? simRows[0] : null
      if (sim) {
        const entId = sim.enterprise_id || getEnv('AUTH_ENTERPRISE_ID')
        let operatorId = sim.operator_id
        if (!operatorId && sim.supplier_id && sim.carrier_id) {
          const opRows = await c.select(
            'operators',
            `select=operator_id&supplier_id=eq.${encodeURIComponent(sim.supplier_id)}&carrier_id=eq.${encodeURIComponent(sim.carrier_id)}&limit=1`
          )
          if (Array.isArray(opRows) && opRows[0]?.operator_id) {
            operatorId = opRows[0].operator_id
          } else {
            const createdOps = await c.insert('operators', { supplier_id: sim.supplier_id, carrier_id: sim.carrier_id })
            operatorId = Array.isArray(createdOps) ? createdOps[0]?.operator_id : null
          }
        }
        const planRows = await c.insert('price_plans', {
          enterprise_id: entId,
          name: `wx-${Date.now()}`,
          type: 'FIXED_BUNDLE',
          service_type: 'DATA',
          currency: 'USD',
          billing_cycle_type: 'CALENDAR_MONTH',
          first_cycle_proration: 'NONE',
        })
        const planId = Array.isArray(planRows) ? planRows[0]?.price_plan_id : null
        const ppvRows = await c.insert('price_plan_versions', {
          price_plan_id: planId,
          version: 1,
          monthly_fee: 0,
          quota_kb: 102400,
        })
        const ppvId = Array.isArray(ppvRows) ? ppvRows[0]?.price_plan_version_id : null
        const pkgRows = await c.insert('packages', {
          enterprise_id: entId,
          name: `wx-pkg-${Date.now()}`,
        })
        const pkgId = Array.isArray(pkgRows) ? pkgRows[0]?.package_id : null
        const terms1 = { testPeriodDays: 14, testQuotaKb: 102400, testExpiryCondition: 'PERIOD_OR_QUOTA', commitmentPeriodMonths: 1 }
        const pv1Rows = await c.insert('package_versions', {
          package_id: pkgId,
          version: 1,
          status: 'PUBLISHED',
          supplier_id: sim.supplier_id,
          carrier_id: sim.carrier_id,
          operator_id: operatorId,
          service_type: 'DATA',
          commercial_terms: terms1,
          price_plan_version_id: ppvId,
        })
        const pv1Id = Array.isArray(pv1Rows) ? pv1Rows[0]?.package_version_id : null
        const terms2 = { commitmentPeriodDays: 10 }
        const pv2Rows = await c.insert('package_versions', {
          package_id: pkgId,
          version: 2,
          status: 'PUBLISHED',
          supplier_id: sim.supplier_id,
          carrier_id: sim.carrier_id,
          operator_id: operatorId,
          service_type: 'DATA',
          commercial_terms: terms2,
          price_plan_version_id: ppvId,
        })
        const pv2Id = Array.isArray(pv2Rows) ? pv2Rows[0]?.package_version_id : null
        const now = new Date()
        const scenarioStart = nowIso()
        const eff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString()
        const created = await httpJson(`${base}/subscriptions`, {
          method: 'POST',
          headers: buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }),
          body: { iccid, packageVersionId: pv1Id, kind: 'MAIN', effectiveAt: eff },
        })
        process.stdout.write(`sub.create.id=${String(created?.subscriptionId || '')} ce=${String(created?.commitmentEndAt || '')}\n`)
        let switched = null
        try {
          switched = await httpJson(`${base}/subscriptions:switch`, {
            method: 'POST',
            headers: buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }),
            body: { iccid, fromSubscriptionId: created.subscriptionId, newPackageVersionId: pv2Id },
          })
        } catch (err) {
          const msg = String(err?.message || err)
          if (msg.includes('SUBSCRIPTION_NOT_FOUND') || msg.includes('HTTP 404')) {
            await httpJson(`${base}/subscriptions`, {
              method: 'POST',
              headers: buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }),
              body: { iccid, packageVersionId: pv1Id, kind: 'MAIN', effectiveAt: new Date().toISOString() },
            })
            switched = await httpJson(`${base}/subscriptions:switch`, {
              method: 'POST',
              headers: buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }),
              body: { iccid, fromSubscriptionId: created.subscriptionId, newPackageVersionId: pv2Id },
            })
          } else {
            throw err
          }
        }
        const switchedNewId = switched?.newSubscriptionId ? String(switched.newSubscriptionId) : switched?.subscriptionId ? String(switched.subscriptionId) : ''
        process.stdout.write(`sub.switch.id=${switchedNewId} eff=${String(switched?.effectiveAt || '')}\n`)
        if (!switchedNewId) {
          throw new Error(`SUBSCRIPTION_SWITCH_EMPTY_ID: ${JSON.stringify(switched || {})}`)
        }
        const cancelImm = await httpJson(`${base}/subscriptions/${encodeURIComponent(switchedNewId)}:cancel?immediate=true`, {
          method: 'POST',
          headers: buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }),
          body: { immediate: true },
        })
        process.stdout.write(`sub.cancel.immediate=${String(cancelImm?.state || '')}\n`)
        const cancelDef = await httpJson(`${base}/subscriptions/${encodeURIComponent(created.subscriptionId)}:cancel?immediate=false`, {
          method: 'POST',
          headers: buildHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }),
          body: { immediate: false },
        })
        process.stdout.write(`sub.cancel.deferred=${String(cancelDef?.state || '')}\n`)
        const evs = await httpJson(`${base}/admin/events?eventType=SUBSCRIPTION_CHANGED&start=${encodeURIComponent(scenarioStart)}&limit=50&page=1`, {
          headers: buildHeaders({ 'X-API-Key': adminKey }),
        })
        const aCreate = await httpJson(`${base}/admin/audits?action=SUBSCRIPTION_CREATE&limit=50&page=1`, {
          headers: buildHeaders({ 'X-API-Key': adminKey }),
        })
        const aSwitch = await httpJson(`${base}/admin/audits?action=SUBSCRIPTION_SWITCH&limit=50&page=1`, {
          headers: buildHeaders({ 'X-API-Key': adminKey }),
        })
        const aCancel = await httpJson(`${base}/admin/audits?action=SUBSCRIPTION_CANCEL&limit=50&page=1`, {
          headers: buildHeaders({ 'X-API-Key': adminKey }),
        })
        process.stdout.write(`events.subscription.count=${Array.isArray(evs?.items) ? evs.items.length : 0}\n`)
        process.stdout.write(`audits.create.count=${Array.isArray(aCreate?.items) ? aCreate.items.length : 0}\n`)
        process.stdout.write(`audits.switch.count=${Array.isArray(aSwitch?.items) ? aSwitch.items.length : 0}\n`)
        process.stdout.write(`audits.cancel.count=${Array.isArray(aCancel?.items) ? aCancel.items.length : 0}\n`)
        const keep = !!getEnv('E2E_WX_KEEP')
        if (!keep) {
          try {
            await c.delete('package_versions', `package_version_id=eq.${encodeURIComponent(String(pv1Id))}`)
          } catch {}
          try {
            await c.delete('package_versions', `package_version_id=eq.${encodeURIComponent(String(pv2Id))}`)
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
        }
      } else {
        process.stdout.write('SKIP: subscription demo (SIM not found)\n')
      }
    } else {
      process.stdout.write('SKIP: subscription demo (set ADMIN_API_KEY, SUPABASE_SERVICE_ROLE_KEY, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET)\n')
    }
  } finally {
    server.close()
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  if (err && err.body) {
    process.stderr.write(`${String(err.body)}\n`)
  }
  process.exit(1)
})
