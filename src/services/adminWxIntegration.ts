import { createSupplierAdapterFromIntegration } from '../vendors/registry.js'
import {
  loadUpstreamIntegrationRuntime,
  type UpstreamIntegrationRuntime,
} from './upstreamIntegration.js'
import type { SupplierAdapter } from '../vendors/spi.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
}

export type AdminWxIntegrationContext = {
  adapter: SupplierAdapter
  runtime: UpstreamIntegrationRuntime
  supplierId: string
  operatorId: string
  integrationId: string
}

export type AdminWxIntegrationResult =
  | { ok: true; context: AdminWxIntegrationContext }
  | { ok: false; status: number; code: string; message: string }

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

async function describeMissingIntegration(
  supabase: SupabaseClient,
  supplierId: string,
  operatorId: string
): Promise<string> {
  try {
    const rows = await supabase.select(
      'upstream_integrations',
      `select=integration_id,status,enabled&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(operatorId)}&order=updated_at.desc&limit=5`
    )
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) {
      return `No upstream_integrations row for supplierId=${supplierId} operatorId=${operatorId}. Create an ACTIVE+enabled integration.`
    }
    const summary = list
      .map((r: any) => `${r.integration_id}(status=${r.status},enabled=${r.enabled})`)
      .join('; ')
    return `No ACTIVE+enabled upstream_integrations for supplierId=${supplierId} operatorId=${operatorId}. Found: ${summary}`
  } catch {
    return `Upstream integration not configured for supplierId=${supplierId} operatorId=${operatorId}.`
  }
}

/**
 * Resolve outbound adapter from ACTIVE+enabled `upstream_integrations`
 * for `(supplierId, operatorId)`. Credentials/URL come from DB — not `.env`
 * / bare `createWxzhonggengClient()`.
 */
export async function resolveAdminWxIntegration(
  supabase: SupabaseClient,
  supplierIdRaw: unknown,
  operatorIdRaw: unknown
): Promise<AdminWxIntegrationResult> {
  const supplierId = supplierIdRaw != null ? String(supplierIdRaw).trim() : ''
  const operatorId = operatorIdRaw != null ? String(operatorIdRaw).trim() : ''
  if (!supplierId || !isValidUuid(supplierId)) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'supplierId must be a valid uuid.' }
  }
  if (!operatorId || !isValidUuid(operatorId)) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'operatorId must be a valid uuid.' }
  }

  const runtime = await loadUpstreamIntegrationRuntime(supabase as any, supplierId, operatorId)
  if (!runtime) {
    const message = await describeMissingIntegration(supabase, supplierId, operatorId)
    return {
      ok: false,
      status: 503,
      code: 'UPSTREAM_NOT_CONFIGURED',
      message,
    }
  }

  try {
    const adapter = createSupplierAdapterFromIntegration(runtime)
    return {
      ok: true,
      context: {
        adapter,
        runtime,
        supplierId,
        operatorId: runtime.operatorId,
        integrationId: runtime.integrationId,
      },
    }
  } catch (err: any) {
    return {
      ok: false,
      status: 503,
      code: 'UPSTREAM_NOT_CONFIGURED',
      message: err?.message ? String(err.message) : 'Supplier adapter not available for this integration.',
    }
  }
}

/**
 * Resolve via SIM inventory `(supplier_id, operator_id)`.
 * Optional Admin overrides (`supplierId`/`operatorId` query) pick a specific
 * integration to verify against this ICCID.
 */
export async function resolveAdminWxIntegrationForSim(
  supabase: SupabaseClient,
  sim: Record<string, unknown>,
  override?: { supplierId?: unknown; operatorId?: unknown }
): Promise<AdminWxIntegrationResult> {
  const overrideSupplier =
    override?.supplierId != null && String(override.supplierId).trim() !== ''
      ? String(override.supplierId).trim()
      : null
  const overrideOperator =
    override?.operatorId != null && String(override.operatorId).trim() !== ''
      ? String(override.operatorId).trim()
      : null

  if (overrideSupplier || overrideOperator) {
    if (!overrideSupplier || !overrideOperator) {
      return {
        ok: false,
        status: 400,
        code: 'BAD_REQUEST',
        message: 'supplierId and operatorId must both be provided when overriding integration.',
      }
    }
    return resolveAdminWxIntegration(supabase, overrideSupplier, overrideOperator)
  }

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
  return resolveAdminWxIntegration(supabase, supplierId, operatorId)
}

/** Prefer integration.config.endpoints.getUsage.path; else adapter default path. */
export function resolveWxUsageDailyPath(runtime: UpstreamIntegrationRuntime): string {
  const cfg = runtime.config && typeof runtime.config === 'object' ? (runtime.config as Record<string, unknown>) : {}
  const endpoints =
    cfg.endpoints && typeof cfg.endpoints === 'object' ? (cfg.endpoints as Record<string, unknown>) : {}
  const getUsage = endpoints.getUsage && typeof endpoints.getUsage === 'object'
    ? (endpoints.getUsage as Record<string, unknown>)
    : null
  const path = getUsage?.path != null ? String(getUsage.path).trim() : ''
  return path || '/sim-card/card/card-info/api/queryCdrFlowByDate'
}
