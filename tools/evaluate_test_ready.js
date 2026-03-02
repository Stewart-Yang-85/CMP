import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

function toStr(v) {
  return v === undefined || v === null ? null : String(v)
}

function startOfDayIso(d) {
  const x = new Date(d)
  x.setUTCHours(0, 0, 0, 0)
  return x.toISOString().slice(0, 10)
}

function getEnvTrim(name) {
  const v = process.env[name]
  if (!v) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function getTestExpiryCondition() {
  const v = getEnvTrim('TEST_EXPIRY_CONDITION')
  const s = v ? v.toUpperCase() : 'PERIOD_OR_QUOTA'
  if (s !== 'PERIOD_ONLY' && s !== 'QUOTA_ONLY' && s !== 'PERIOD_OR_QUOTA') return 'PERIOD_OR_QUOTA'
  return s
}
function getTestPeriodDays() {
  const n = Number(process.env.TEST_PERIOD_DAYS || 14)
  return Math.max(1, n)
}
function getTestQuotaKb() {
  const n = Number(process.env.TEST_QUOTA_KB || 102400)
  return Math.max(0, n)
}

async function main() {
  const iccid = toStr(process.env.EVAL_ICCID) || '893107032536638556'
  const c = createSupabaseRestClient({ useServiceRole: true })
  const rows = await c.select('sims', `select=sim_id,iccid,enterprise_id,status,last_status_change_at&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
  const sim = Array.isArray(rows) ? rows[0] : null
  if (!sim) throw new Error(`sim not found: ${iccid}`)
  if (String(sim.status) !== 'TEST_READY') {
    process.stdout.write(`SKIP: sim status=${sim.status}\n`)
    return
  }
  let startTimeIso = sim.last_status_change_at ? new Date(sim.last_status_change_at).toISOString() : null
  if (!startTimeIso) {
    const hist = await c.select('sim_state_history', `select=start_time&sim_id=eq.${encodeURIComponent(sim.sim_id)}&after_status=eq.TEST_READY&order=start_time.desc&limit=1`)
    const h = Array.isArray(hist) ? hist[0] : null
    startTimeIso = h?.start_time ? new Date(h.start_time).toISOString() : null
  }
  if (!startTimeIso) {
    process.stdout.write('SKIP: missing startTime\n')
    return
  }
  const cond = getTestExpiryCondition()
  const periodDays = getTestPeriodDays()
  const quotaKbLimit = getTestQuotaKb()
  const startDay = startOfDayIso(new Date(startTimeIso))
  let totalKb = 0
  const usageRows = await c.select('usage_daily_summary', `select=total_kb,usage_day&iccid=eq.${encodeURIComponent(sim.iccid)}${sim.enterprise_id ? `&enterprise_id=eq.${encodeURIComponent(sim.enterprise_id)}` : ''}&usage_day=gte.${encodeURIComponent(startDay)}`)
  if (Array.isArray(usageRows)) {
    for (const r of usageRows) totalKb += Number(r.total_kb ?? 0)
  }
  const expireByPeriod = Date.now() >= (new Date(new Date(startTimeIso).getTime() + periodDays * 24 * 3600 * 1000)).getTime()
  const expireByQuota = quotaKbLimit > 0 ? totalKb >= quotaKbLimit : false
  const shouldExpire = cond === 'PERIOD_ONLY' ? expireByPeriod : cond === 'QUOTA_ONLY' ? expireByQuota : (expireByPeriod || expireByQuota)
  if (!shouldExpire) {
    process.stdout.write(JSON.stringify({ processed: 1, activated: 0, remaining: 1, totalKb }) + '\n')
    return
  }
  const nowIso = new Date().toISOString()
  await c.update('sims', `sim_id=eq.${encodeURIComponent(sim.sim_id)}`, {
    status: 'ACTIVATED',
    last_status_change_at: nowIso,
  }, { returning: 'minimal' })
  await c.insert('sim_state_history', {
    sim_id: sim.sim_id,
    before_status: 'TEST_READY',
    after_status: 'ACTIVATED',
    start_time: startTimeIso,
    end_time: nowIso,
    source: 'TEST_EXPIRY_MANUAL',
    request_id: null,
  }, { returning: 'minimal' })
  await c.insert('events', {
    event_type: 'SIM_STATUS_CHANGED',
    occurred_at: nowIso,
    tenant_id: sim.enterprise_id ?? null,
    request_id: null,
    payload: {
      iccid: sim.iccid,
      beforeStatus: 'TEST_READY',
      afterStatus: 'ACTIVATED',
      reason: 'TEST_EXPIRY_MANUAL',
      totalKb,
      periodDays,
      quotaKbLimit,
      startTime: startTimeIso,
      endTime: nowIso,
    },
  }, { returning: 'minimal' })
  process.stdout.write(JSON.stringify({ processed: 1, activated: 1, remaining: 0, totalKb }) + '\n')
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  process.exit(1)
})
