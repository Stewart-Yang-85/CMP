import { createSupabaseRestClient } from '../supabaseRest.js'
import { computeMonthlyCharges } from '../billing.js'
import { cleanUsageRecords } from './usageCleaning.js'

function normalizeVisitedMccMnc(value) {
  const raw = String(value || '').trim()
  if (!raw) return raw
  const exact = raw.match(/^(\d{3})-?(\d{2,3})$/)
  if (!exact) return raw
  const mcc = exact[1]
  let mnc = exact[2]
  if (mnc.length === 2) mnc = `0${mnc}`
  return `${mcc}-${mnc}`
}

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

export async function handleLateCdr({
  records,
  source,
  batchId,
  traceId,
  supabaseClient,
}) {
  const supabase = supabaseClient || createSupabaseRestClient({ useServiceRole: true, traceId: traceId ?? null })
  const cleaned = await cleanUsageRecords({ records, source, batchId, traceId, supabaseClient: supabase })
  const lateGroups = new Map()

  for (const record of cleaned.kept) {
    const enterpriseId = record?.enterpriseId ?? record?.enterprise_id
    const iccid = String(record?.iccid || '').trim()
    const usageDay = String(record?.usageDay ?? record?.usage_day ?? '').slice(0, 10)
    if (!enterpriseId || !iccid || !usageDay) continue

    const bills = await supabase.select(
      'bills',
      `select=bill_id,total_amount,currency,period_start,period_end,status&enterprise_id=eq.${encodeURIComponent(String(enterpriseId))}&status=eq.PUBLISHED&period_start=lte.${encodeURIComponent(usageDay)}&period_end=gt.${encodeURIComponent(usageDay)}&limit=1`
    )
    const bill = Array.isArray(bills) ? bills[0] : null
    if (!bill?.bill_id) continue

    const sims = await supabase.select(
      'sims',
      `select=sim_id,enterprise_id,iccid,supplier_id,apn&iccid=eq.${encodeURIComponent(iccid)}&enterprise_id=eq.${encodeURIComponent(String(enterpriseId))}&limit=1`
    )
    const sim = Array.isArray(sims) ? sims[0] : null
    if (!sim?.sim_id) continue

    const visited = normalizeVisitedMccMnc(record?.visitedMccMnc ?? record?.visited_mccmnc ?? '000-00')
    const uplinkKb = toNumber(record?.uplinkKb ?? record?.uplink_kb) ?? 0
    const downlinkKb = toNumber(record?.downlinkKb ?? record?.downlink_kb) ?? 0
    const totalKb = toNumber(record?.totalKb ?? record?.total_kb) ?? uplinkKb + downlinkKb

    const match = `iccid=eq.${encodeURIComponent(iccid)}&usage_day=eq.${encodeURIComponent(usageDay)}&visited_mccmnc=eq.${encodeURIComponent(visited)}`
    const existing = await supabase.select(
      'usage_daily_summary',
      `select=usage_id,uplink_kb,downlink_kb,total_kb&${match}&limit=1`
    )
    const current = Array.isArray(existing) ? existing[0] : null
    if (current?.usage_id) {
      const newUplink = Math.max(0, Math.floor(Number(current.uplink_kb || 0) + uplinkKb))
      const newDownlink = Math.max(0, Math.floor(Number(current.downlink_kb || 0) + downlinkKb))
      const newTotal = Math.max(0, Math.floor(Number(current.total_kb || 0) + totalKb))
      await supabase.update(
        'usage_daily_summary',
        `usage_id=eq.${encodeURIComponent(String(current.usage_id))}`,
        {
          uplink_kb: newUplink,
          downlink_kb: newDownlink,
          total_kb: newTotal,
          input_ref: record?.inputRef ?? record?.input_ref ?? null,
        },
        { returning: 'minimal' }
      )
    } else {
      await supabase.insert('usage_daily_summary', {
        supplier_id: sim.supplier_id ?? null,
        enterprise_id: sim.enterprise_id ?? null,
        sim_id: sim.sim_id ?? null,
        iccid,
        usage_day: usageDay,
        visited_mccmnc: visited,
        uplink_kb: Math.max(0, Math.floor(uplinkKb)),
        downlink_kb: Math.max(0, Math.floor(downlinkKb)),
        total_kb: Math.max(0, Math.floor(totalKb)),
        apn: sim.apn ?? null,
        rat: null,
        input_ref: record?.inputRef ?? record?.input_ref ?? null,
      }, { returning: 'minimal' })
    }

    const periodStart = String(bill.period_start)
    const billPeriod = periodStart.slice(0, 7)
    const key = `${enterpriseId}:${billPeriod}`
    lateGroups.set(key, { enterpriseId, bill, billPeriod })
  }

  const results = []
  for (const group of lateGroups.values()) {
    const calculationId = `late-${traceId ?? Date.now()}`
    const calc = await computeMonthlyCharges({
      enterpriseId: group.enterpriseId,
      billPeriod: group.billPeriod,
      calculationId,
    }, supabase)
    const oldTotal = Number(group.bill.total_amount ?? 0)
    const newTotal = Number(calc.totalBillAmount ?? 0)
    const delta = Number((newTotal - oldTotal).toFixed(2))
    if (delta === 0) {
      results.push({ billId: group.bill.bill_id, delta: 0 })
      continue
    }
    const noteType = delta > 0 ? 'DEBIT' : 'CREDIT'
    const noteAmount = Math.abs(delta)
    const noteRows = await supabase.insert('adjustment_notes', {
      enterprise_id: group.enterpriseId,
      note_type: noteType,
      status: 'DRAFT',
      currency: group.bill.currency ?? calc.currency ?? 'USD',
      total_amount: noteAmount,
      reason: 'LATE_CDR',
      input_ref: traceId ?? null,
      calculation_id: calc.calculationId,
    }, { returning: 'representation' })
    const noteId = Array.isArray(noteRows) && noteRows[0]?.note_id ? noteRows[0].note_id : null
    if (noteId) {
      await supabase.insert('adjustment_note_items', {
        note_id: noteId,
        item_type: 'USAGE_ADJUSTMENT',
        sim_id: null,
        amount: noteAmount,
        metadata: {
          billId: group.bill.bill_id,
          periodStart: group.bill.period_start,
          periodEnd: group.bill.period_end,
          calculationId: calc.calculationId,
        },
      }, { returning: 'minimal' })
    }
    if (calc.ratingResults.length > 0) {
      const batchSize = 200
      for (let i = 0; i < calc.ratingResults.length; i += batchSize) {
        const batch = calc.ratingResults.slice(i, i + batchSize)
        await supabase.insert('rating_results', batch, { returning: 'minimal' })
      }
    }
    results.push({ billId: group.bill.bill_id, delta, noteId })
  }

  return { cleaned: cleaned.report, results }
}
