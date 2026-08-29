import { changeSimStatus } from './simLifecycle.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  update: (
    table: string,
    matchQueryString: string,
    patch: unknown,
    options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
  ) => Promise<unknown>
  insert: (
    table: string,
    rows: unknown,
    options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
  ) => Promise<unknown>
}

/** Business "active subscription" for SIM traffic / coupling — ACTIVE only. */
export async function countActiveSubscriptionsForSim(
  supabase: SupabaseClient,
  simId: string
): Promise<number> {
  const rows = await supabase.select(
    'subscriptions',
    `select=subscription_id&sim_id=eq.${encodeURIComponent(simId)}&state=eq.ACTIVE&limit=500`
  )
  return Array.isArray(rows) ? rows.length : 0
}

async function loadSimById(supabase: SupabaseClient, simId: string) {
  const rows = await supabase.select(
    'sims',
    `select=sim_id,iccid,status,lifecycle_sub_status,enterprise_id,reseller_id,supplier_id&sim_id=eq.${encodeURIComponent(simId)}&limit=1`
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
}

/**
 * After losing ACTIVE subscriptions (e.g. ONE_TIME expired): if none remain ACTIVE,
 * enqueue SIM_DEACTIVATE for ACTIVATED or TEST_READY (upstream suspend).
 */
export async function maybeDeactivateSimWhenNoActiveSubscription({
  supabase,
  simId,
  requestId = null,
  reason = 'NO_ACTIVE_SUBSCRIPTION',
}: {
  supabase: SupabaseClient
  simId: string
  requestId?: string | null
  reason?: string
}): Promise<{ action: 'SKIPPED' | 'QUEUED'; detail?: string; jobId?: string | null }> {
  if (!simId) return { action: 'SKIPPED', detail: 'MISSING_SIM_ID' }
  const activeCount = await countActiveSubscriptionsForSim(supabase, simId)
  if (activeCount > 0) {
    return { action: 'SKIPPED', detail: `STILL_HAS_ACTIVE:${activeCount}` }
  }
  const sim = await loadSimById(supabase, simId)
  if (!sim?.sim_id) return { action: 'SKIPPED', detail: 'SIM_NOT_FOUND' }
  const status = String(sim.status || '').toUpperCase()
  if (status !== 'ACTIVATED' && status !== 'TEST_READY') {
    return { action: 'SKIPPED', detail: `SIM_STATUS_${status || 'UNKNOWN'}` }
  }
  const result = await changeSimStatus({
    supabase,
    simIdentifier: { field: 'sim_id', value: String(sim.sim_id) },
    tenantQs: '',
    action: 'SIM_DEACTIVATE',
    newStatus: 'DEACTIVATED',
    allowedFrom: new Set(['ACTIVATED', 'TEST_READY']),
    reason,
    idempotencyKey: null,
    actor: {
      userId: null,
      resellerId: sim.reseller_id != null ? String(sim.reseller_id) : null,
      role: 'SYSTEM',
      roleScope: 'platform',
    },
    traceId: requestId,
    sourceIp: null,
  })
  if (!result.ok) {
    return { action: 'SKIPPED', detail: `${result.code}:${result.message}` }
  }
  return { action: 'QUEUED', jobId: (result as { jobId?: string | null }).jobId ?? null }
}

/**
 * After a subscription becomes ACTIVE: if SIM is DEACTIVATED and this is the sole ACTIVE
 * subscription on the SIM, enqueue SIM_ACTIVATE (upstream). TEST_READY / INVENTORY / RETIRED → no-op.
 */
export async function maybeActivateSimWhenSoleActiveSubscription({
  supabase,
  simId,
  requestId = null,
  reason = 'SOLE_ACTIVE_SUBSCRIPTION',
}: {
  supabase: SupabaseClient
  simId: string
  requestId?: string | null
  reason?: string
}): Promise<{ action: 'SKIPPED' | 'QUEUED'; detail?: string; jobId?: string | null }> {
  if (!simId) return { action: 'SKIPPED', detail: 'MISSING_SIM_ID' }
  const activeCount = await countActiveSubscriptionsForSim(supabase, simId)
  if (activeCount !== 1) {
    return { action: 'SKIPPED', detail: `ACTIVE_COUNT:${activeCount}` }
  }
  const sim = await loadSimById(supabase, simId)
  if (!sim?.sim_id) return { action: 'SKIPPED', detail: 'SIM_NOT_FOUND' }
  const status = String(sim.status || '').toUpperCase()
  if (status !== 'DEACTIVATED') {
    return { action: 'SKIPPED', detail: `SIM_STATUS_${status || 'UNKNOWN'}` }
  }
  const result = await changeSimStatus({
    supabase,
    simIdentifier: { field: 'sim_id', value: String(sim.sim_id) },
    tenantQs: '',
    action: 'SIM_ACTIVATE',
    newStatus: 'ACTIVATED',
    allowedFrom: new Set(['DEACTIVATED']),
    reason,
    idempotencyKey: null,
    actor: {
      userId: null,
      resellerId: sim.reseller_id != null ? String(sim.reseller_id) : null,
      role: 'SYSTEM',
      roleScope: 'platform',
    },
    traceId: requestId,
    sourceIp: null,
  })
  if (!result.ok) {
    return { action: 'SKIPPED', detail: `${result.code}:${result.message}` }
  }
  return { action: 'QUEUED', jobId: (result as { jobId?: string | null }).jobId ?? null }
}
