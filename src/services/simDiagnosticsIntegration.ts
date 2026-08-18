import { createSupplierAdapterFromIntegration } from '../vendors/registry.js'
import {
  getDiagnosticsCapabilities,
  type DiagnosticsCapabilities,
} from '../vendors/diagnosticsCapabilities.js'
import { loadUpstreamIntegrationRuntime } from './upstreamIntegration.js'
import type { SupplierAdapter } from '../vendors/spi.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
}

export type DiagnosticsIntegrationContext = {
  adapter: SupplierAdapter
  capabilities: DiagnosticsCapabilities
  integrationId: string
}

export type DiagnosticsIntegrationResult =
  | { ok: true; context: DiagnosticsIntegrationContext }
  | { ok: false; status: number; code: string; message: string }

export async function resolveDiagnosticsIntegration(
  supabase: SupabaseClient,
  sim: Record<string, unknown>,
): Promise<DiagnosticsIntegrationResult> {
  const supplierId = sim.supplier_id != null ? String(sim.supplier_id).trim() : ''
  const operatorId = sim.operator_id != null ? String(sim.operator_id).trim() : ''
  if (!supplierId || !operatorId) {
    return {
      ok: false,
      status: 503,
      code: 'UPSTREAM_NOT_CONFIGURED',
      message: 'SIM is not linked to a supplier and operator for upstream integration.',
    }
  }

  const runtime = await loadUpstreamIntegrationRuntime(supabase as any, supplierId, operatorId)
  if (!runtime) {
    return {
      ok: false,
      status: 503,
      code: 'UPSTREAM_NOT_CONFIGURED',
      message: 'Upstream integration not configured for this SIM.',
    }
  }

  const adapter = createSupplierAdapterFromIntegration(runtime)
  return {
    ok: true,
    context: {
      adapter,
      capabilities: getDiagnosticsCapabilities(adapter),
      integrationId: runtime.integrationId,
    },
  }
}
