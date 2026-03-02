type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

function toError(status: number, code: string, message: string): ServiceResult<never> {
  return { ok: false, status, code, message }
}

function toNumber(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeTPlusDays(value: unknown, fallback: number) {
  const n = toNumber(value)
  if (n === null) return fallback
  if (n < 0) return fallback
  return Math.floor(n)
}

async function loadBillingConfig(supabase: SupabaseClient, enterpriseId: string | null | undefined) {
  if (!enterpriseId) return null
  const rows = await supabase.select(
    'billing_config',
    `select=config_id,enterprise_id,currency,bill_day,time_zone,auto_generate,auto_publish&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
}

export async function resolveBillingSchedule({
  supabase,
  enterpriseId,
  resellerId,
}: {
  supabase: SupabaseClient
  enterpriseId?: string | null
  resellerId?: string | null
}): Promise<ServiceResult<{
  tPlusDays: number
  autoGenerate: boolean
  autoPublish: boolean
  timeZone: string | null
  currency: string | null
  source: 'CUSTOMER' | 'RESELLER' | 'SYSTEM'
}>> {
  if (!supabase) {
    return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  }
  const defaultTPlusDays = 3
  const customerConfig = await loadBillingConfig(supabase, enterpriseId ?? null)
  const resellerConfig = await loadBillingConfig(supabase, resellerId ?? null)
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
