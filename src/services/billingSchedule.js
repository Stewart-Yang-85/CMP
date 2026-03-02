function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeTPlusDays(value, fallback) {
  const n = toNumber(value)
  if (n === null) return fallback
  if (n < 0) return fallback
  return Math.floor(n)
}

async function loadBillingConfig(supabase, enterpriseId) {
  if (!enterpriseId) return null
  const rows = await supabase.select(
    'billing_config',
    `select=config_id,enterprise_id,currency,bill_day,time_zone,auto_generate,auto_publish&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

export async function resolveBillingSchedule({ supabase, enterpriseId, resellerId }) {
  if (!supabase) {
    return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  }
  const defaultTPlusDays = 3
  const customerConfig = await loadBillingConfig(supabase, enterpriseId)
  const resellerConfig = await loadBillingConfig(supabase, resellerId)
  const effective = customerConfig || resellerConfig || {}
  const tPlusDays = normalizeTPlusDays(effective.bill_day, defaultTPlusDays)
  return {
    ok: true,
    value: {
      tPlusDays,
      autoGenerate: effective.auto_generate !== false,
      autoPublish: effective.auto_publish === true,
      timeZone: effective.time_zone ?? null,
      currency: effective.currency ?? null,
      source: customerConfig ? 'CUSTOMER' : resellerConfig ? 'RESELLER' : 'SYSTEM',
    },
  }
}
