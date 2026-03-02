import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

function toStr(v) {
  return v === undefined || v === null ? null : String(v)
}

async function main() {
  const iccid = toStr(process.env.SEED_ICCID) || '893107032536638556'
  const total = Number(process.env.SEED_TOTAL_KB || 200000)
  const uplink = Math.max(0, Math.floor(total * 0.6))
  const downlink = Math.max(0, total - uplink)
  const usageDay = (toStr(process.env.SEED_USAGE_DAY) || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const visited = toStr(process.env.SEED_VISITED) || '204-08'

  const c = createSupabaseRestClient({ useServiceRole: true })
  const rows = await c.select('sims', `select=sim_id,enterprise_id,supplier_id,apn&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
  const sim = Array.isArray(rows) ? rows[0] : null
  if (!sim) throw new Error(`sim not found: ${iccid}`)

  const match = `iccid=eq.${encodeURIComponent(iccid)}&usage_day=eq.${encodeURIComponent(usageDay)}&visited_mccmnc=eq.${encodeURIComponent(visited)}`
  const existing = await c.select('usage_daily_summary', `select=usage_id&${match}&limit=1`)
  if (Array.isArray(existing) && existing.length > 0) {
    const id = existing[0]?.usage_id
    await c.update('usage_daily_summary', `usage_id=eq.${encodeURIComponent(String(id))}`, {
      uplink_kb: uplink,
      downlink_kb: downlink,
      total_kb: uplink + downlink,
      apn: toStr(sim.apn) || null,
      rat: null,
    }, { returning: 'minimal' })
  } else {
    await c.insert('usage_daily_summary', {
      supplier_id: sim.supplier_id,
      enterprise_id: sim.enterprise_id ?? null,
      sim_id: sim.sim_id ?? null,
      iccid,
      usage_day: usageDay,
      visited_mccmnc: visited,
      uplink_kb: uplink,
      downlink_kb: downlink,
      total_kb: uplink + downlink,
      apn: toStr(sim.apn) || null,
      rat: null,
      input_ref: 'seed',
    }, { returning: 'minimal' })
  }

  process.stdout.write(JSON.stringify({
    iccid,
    usageDay,
    visited,
    uplinkKb: uplink,
    downlinkKb: downlink,
    totalKb: uplink + downlink,
  }) + '\n')
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  process.exit(1)
})
