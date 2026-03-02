import { createSupabaseRestClient } from '../supabaseRest.js'

function resolveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function toCutoffIso(days, now) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

async function loadSuspendedEnterpriseIds({ supabase, cutoffIso, limit, offset }) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id&tenant_type=eq.ENTERPRISE&enterprise_status=eq.SUSPENDED&updated_at=lte.${encodeURIComponent(cutoffIso)}&order=tenant_id.asc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
  )
  return Array.isArray(rows) ? rows.map((row) => String(row?.tenant_id || '')).filter(Boolean) : []
}

async function anonymizeSuspendedEnterprises({ supabase, cutoffIso, batchSize, nowIso }) {
  let offset = 0
  let processed = 0
  while (true) {
    const ids = await loadSuspendedEnterpriseIds({ supabase, cutoffIso, limit: batchSize, offset })
    if (!ids.length) break
    const encoded = ids.map((id) => encodeURIComponent(id)).join(',')
    await supabase.update(
      'users',
      `tenant_id=in.(${encoded})`,
      { email: null, display_name: null },
      { returning: 'minimal' }
    )
    for (const id of ids) {
      const maskedName = `SUSPENDED-${id.slice(0, 8)}`
      await supabase.update(
        'tenants',
        `tenant_id=eq.${encodeURIComponent(id)}`,
        { name: maskedName, updated_at: nowIso },
        { returning: 'minimal' }
      )
    }
    processed += ids.length
    offset += ids.length
  }
  return processed
}

export async function runGdprRetention(input = {}) {
  const now = input.now ?? new Date()
  const auditRetentionDays = resolveNumber(input.auditRetentionDays ?? process.env.GDPR_AUDIT_RETENTION_DAYS, 730)
  const suspendedRetentionDays = resolveNumber(
    input.suspendedRetentionDays ?? process.env.GDPR_SUSPENDED_RETENTION_DAYS,
    730
  )
  const batchSize = resolveNumber(input.batchSize ?? process.env.GDPR_REDACT_BATCH_SIZE, 200)
  const supabase =
    input.supabaseClient ?? createSupabaseRestClient({ useServiceRole: true, traceId: input.traceId ?? null })
  const auditCutoff = toCutoffIso(auditRetentionDays, now)
  const suspendedCutoff = toCutoffIso(suspendedRetentionDays, now)
  const nowIso = now.toISOString()

  await supabase.update(
    'audit_logs',
    `created_at=lte.${encodeURIComponent(auditCutoff)}`,
    { actor_user_id: null, source_ip: null, before_data: null, after_data: null },
    { returning: 'minimal' }
  )
  await supabase.update(
    'events',
    `occurred_at=lte.${encodeURIComponent(auditCutoff)}`,
    { actor_user_id: null, payload: {} },
    { returning: 'minimal' }
  )
  const processedTenants = await anonymizeSuspendedEnterprises({
    supabase,
    cutoffIso: suspendedCutoff,
    batchSize,
    nowIso,
  })

  return {
    ok: true,
    value: {
      auditRetentionDays,
      suspendedRetentionDays,
      auditCutoff,
      suspendedCutoff,
      processedTenants,
    },
  }
}
