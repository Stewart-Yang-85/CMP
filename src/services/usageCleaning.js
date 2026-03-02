import { createSupabaseRestClient } from '../supabaseRest.js'

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function resolveTotalKb(record) {
  const total = toNumber(record?.totalKb ?? record?.total_kb)
  if (total !== null) return total
  const uplink = toNumber(record?.uplinkKb ?? record?.uplink_kb ?? 0) ?? 0
  const downlink = toNumber(record?.downlinkKb ?? record?.downlink_kb ?? 0) ?? 0
  return uplink + downlink
}

export async function cleanUsageRecords({
  records,
  source,
  batchId,
  traceId,
  enterpriseId,
  supabaseClient,
}) {
  const supabase = supabaseClient || createSupabaseRestClient({ useServiceRole: true, traceId: traceId ?? null })
  const list = Array.isArray(records) ? records : []
  const kept = []
  const dropped = []
  let negativeCount = 0
  let invalidCount = 0
  for (const record of list) {
    const total = resolveTotalKb(record)
    if (total === null) {
      invalidCount += 1
      dropped.push({ record, reason: 'INVALID_TOTAL' })
      continue
    }
    if (total < 0) {
      negativeCount += 1
      dropped.push({ record, reason: 'NEGATIVE_TOTAL' })
      continue
    }
    kept.push({
      ...record,
      totalKb: total,
    })
  }
  const report = {
    source: source ?? null,
    batchId: batchId ?? null,
    total: list.length,
    kept: kept.length,
    dropped: dropped.length,
    negativeCount,
    invalidCount,
  }
  await supabase.insert('audit_logs', {
    actor_role: 'SYSTEM',
    tenant_id: enterpriseId ?? null,
    action: 'USAGE_CLEANING_REPORT',
    target_type: 'USAGE_BATCH',
    target_id: batchId ?? source ?? null,
    request_id: traceId ?? null,
    source_ip: null,
    after_data: report,
  }, { returning: 'minimal' })
  return { kept, dropped, report }
}
