import { listActiveUpstreamIntegrationRuntimes, type UpstreamIntegrationRuntime } from './upstreamIntegration.js'
import { createSupplierAdapterFromIntegration } from '../vendors/registry.js'

type SupabaseClient = {
  select?: (table: string, queryString: string) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert?: (table: string, rows: unknown, options?: Record<string, unknown>) => Promise<unknown>
  update?: (table: string, matchQueryString: string, patch: unknown, options?: Record<string, unknown>) => Promise<unknown>
}

export type ReadyIntegrationProbeResult = {
  integrationId: string
  resellerId?: string | null
  name: string
  supplierId: string
  operatorId: string
  adapterType: string
  reachable: boolean
  error?: string | null
}

export type ReadyProbeDetails = {
  config: {
    supabaseUrl: boolean
    supabaseAnonKey: boolean
    supabaseServiceRoleKey: boolean
  }
  upstream: {
    supabase: boolean | null
    integrations: ReadyIntegrationProbeResult[]
    integrationsProbeSkipped?: string | null
  }
}

export function evaluateReadyOk(details: ReadyProbeDetails): boolean {
  const supabaseConfigured = details.config.supabaseUrl && details.config.supabaseAnonKey
  if (supabaseConfigured && details.upstream.supabase !== true) return false
  for (const item of details.upstream.integrations) {
    if (!item.reachable) return false
  }
  return true
}

async function probeIntegrationHealth(
  runtime: UpstreamIntegrationRuntime,
): Promise<{ reachable: boolean; error?: string | null }> {
  try {
    const adapter = createSupplierAdapterFromIntegration(runtime)
    const healthCheck = (adapter as { healthCheck?: () => Promise<boolean> }).healthCheck
    if (typeof healthCheck !== 'function') {
      return { reachable: false, error: 'HEALTH_CHECK_NOT_SUPPORTED' }
    }
    const ok = await healthCheck.call(adapter)
    return ok === true ? { reachable: true } : { reachable: false, error: 'UPSTREAM_HEALTH_CHECK_FAILED' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { reachable: false, error: message.slice(0, 200) || 'HEALTH_CHECK_ERROR' }
  }
}

function normalizeErrorCode(error: string | null | undefined) {
  if (!error) return null
  return error
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'UPSTREAM_HEALTH_CHECK_ERROR'
}

export async function runUpstreamIntegrationHealthProbe(
  supabase: Parameters<typeof listActiveUpstreamIntegrationRuntimes>[0] & SupabaseClient,
): Promise<{ ok: boolean; probed: number; failed: number }> {
  const runtimes = await listActiveUpstreamIntegrationRuntimes(supabase)
  const integrationIds = runtimes.map((runtime) => runtime.integrationId).filter(Boolean)
  const existingRows = integrationIds.length && typeof supabase.select === 'function'
    ? await supabase.select(
      'upstream_integration_health_checks',
      `select=integration_id,consecutive_failure_count,last_success_at&integration_id=in.(${integrationIds.map((id) => encodeURIComponent(id)).join(',')})`,
    )
    : []
  const existingByIntegrationId = new Map(
    (Array.isArray(existingRows) ? existingRows : []).map((row) => [String((row as Record<string, unknown>).integration_id), row as Record<string, unknown>]),
  )
  let failed = 0
  const now = new Date().toISOString()
  const rows = await Promise.all(
    runtimes
      .filter((runtime) => runtime.resellerId)
      .map(async (runtime) => {
        const probe = await probeIntegrationHealth(runtime)
        if (!probe.reachable) failed += 1
        const existing = existingByIntegrationId.get(runtime.integrationId)
        const previousFailures = Number(existing?.consecutive_failure_count ?? 0)
        const failureCount = probe.reachable ? 0 : Math.max(0, Number.isFinite(previousFailures) ? previousFailures : 0) + 1
        return {
          integration_id: runtime.integrationId,
          reseller_id: runtime.resellerId,
          supplier_id: runtime.supplierId,
          operator_id: runtime.operatorId,
          probe_type: 'TOKEN',
          status: probe.reachable ? 'CONNECTED' : 'DISCONNECTED',
          consecutive_failure_count: failureCount,
          last_probe_at: now,
          last_success_at: probe.reachable ? now : existing?.last_success_at ?? null,
          last_failure_at: probe.reachable ? null : now,
          last_error_code: probe.reachable ? null : normalizeErrorCode(probe.error),
          last_error_message: probe.reachable ? null : probe.error ?? null,
          updated_at: now,
        }
      }),
  )
  if (typeof supabase.update === 'function' && typeof supabase.insert === 'function') {
    for (const row of rows) {
      const integrationId = String(row.integration_id)
      const exists = existingByIntegrationId.has(integrationId)
      if (exists) {
        await supabase.update(
          'upstream_integration_health_checks',
          `integration_id=eq.${encodeURIComponent(integrationId)}`,
          row,
          { returning: 'minimal', suppressMissingColumns: true },
        )
      } else {
        await supabase.insert('upstream_integration_health_checks', row, {
          returning: 'minimal',
          suppressMissingColumns: true,
        })
      }
    }
  }
  return { ok: failed === 0, probed: rows.length, failed }
}

type ReadyProbeSupabase = Parameters<typeof listActiveUpstreamIntegrationRuntimes>[0] & SupabaseClient

export async function buildReadyProbeResponse(
  supabase: ReadyProbeSupabase | null,
  options: { hasServiceRoleKey?: boolean } = {},
): Promise<{ ok: boolean; details: ReadyProbeDetails }> {
  const hasServiceRoleKey = options.hasServiceRoleKey === true
  const details: ReadyProbeDetails = {
    config: {
      supabaseUrl: Boolean(process.env.SUPABASE_URL),
      supabaseAnonKey: Boolean(process.env.SUPABASE_ANON_KEY),
      supabaseServiceRoleKey: hasServiceRoleKey,
    },
    upstream: {
      supabase: null,
      integrations: [],
      integrationsProbeSkipped: null,
    },
  }
  const supabaseConfigured = details.config.supabaseUrl && details.config.supabaseAnonKey
  if (!supabaseConfigured || !supabase) {
    return { ok: evaluateReadyOk(details), details }
  }

  try {
    await supabase.selectWithCount('sims', 'select=sim_id&limit=1')
    details.upstream.supabase = true
  } catch {
    details.upstream.supabase = false
    return { ok: false, details }
  }

  if (!hasServiceRoleKey) {
    details.upstream.integrationsProbeSkipped =
      'SUPABASE_SERVICE_ROLE_KEY is not configured; upstream_integrations requires service role (RLS blocks anon).'
    return { ok: evaluateReadyOk(details), details }
  }

  const runtimes = await listActiveUpstreamIntegrationRuntimes(supabase)
  details.upstream.integrations = await Promise.all(
    runtimes.map(async (runtime) => {
      const probe = await probeIntegrationHealth(runtime)
      return {
        integrationId: runtime.integrationId,
        resellerId: runtime.resellerId,
        name: runtime.name,
        supplierId: runtime.supplierId,
        operatorId: runtime.operatorId,
        adapterType: runtime.adapterType,
        reachable: probe.reachable,
        error: probe.error ?? null,
      }
    }),
  )

  return { ok: evaluateReadyOk(details), details }
}
