import { createWxzhonggengAdapter } from './wxzhonggeng.js'
import type { SupplierAdapter, SupplierCapabilities, SpiOperation } from './spi.js'
import type { UpstreamIntegrationRuntime } from '../services/upstreamIntegration.js'
import { loadUpstreamIntegrationRuntime } from '../services/upstreamIntegration.js'

const createWxAdapter = createWxzhonggengAdapter as (integration?: Record<string, unknown>) => SupplierAdapter

type ChangePlanStrategy = {
  mode: 'UPSTREAM' | 'VIRTUAL'
}

type SupabaseLike = {
  select: (table: string, queryString: string) => Promise<unknown>
}

function normalizeKey(value: unknown) {
  return String(value ?? '').trim()
}

function integrationToWxConfig(integration: UpstreamIntegrationRuntime) {
  return {
    apiEndpoint: integration.apiEndpoint,
    apiKey: integration.apiKey,
    apiSecret: integration.apiSecret,
    username: integration.username,
    password: integration.password,
    tokenUrl: integration.tokenUrl,
    authType: integration.authType,
    config: integration.config,
  }
}

export function createSupplierAdapterFromIntegration(integration: UpstreamIntegrationRuntime): SupplierAdapter {
  const adapterType = normalizeKey(integration.adapterType).toLowerCase()
  if (adapterType === 'wxzhonggeng') {
    return createWxAdapter(integrationToWxConfig(integration))
  }
  throw new Error('supplier_adapter_not_found')
}

export async function createSupplierAdapter({
  supabase,
  supplierId,
  operatorId,
  integration,
}: {
  supabase?: SupabaseLike | null
  supplierId?: string | null
  operatorId?: string | null
  integration?: UpstreamIntegrationRuntime | null
}): Promise<SupplierAdapter> {
  if (integration) {
    return createSupplierAdapterFromIntegration(integration)
  }
  const sid = normalizeKey(supplierId)
  const oid = normalizeKey(operatorId)
  if (supabase && sid && oid) {
    const row = await loadUpstreamIntegrationRuntime(supabase as any, sid, oid)
    if (row) return createSupplierAdapterFromIntegration(row)
  }
  throw new Error('supplier_adapter_not_found')
}

export async function getSupplierCapabilities({
  supabase,
  supplierId,
  operatorId,
}: {
  supabase?: SupabaseLike | null
  supplierId?: string | null
  operatorId?: string | null
}): Promise<SupplierCapabilities> {
  const adapter = await createSupplierAdapter({ supabase, supplierId, operatorId })
  return adapter.capabilities
}

export function negotiateChangePlanStrategy({
  adapter,
  effectiveAt,
}: {
  adapter: SupplierAdapter
  effectiveAt?: Date | string | null
}): ChangePlanStrategy {
  const when = effectiveAt ? new Date(effectiveAt) : null
  const isFuture = when && Number.isFinite(when.getTime()) && when.getTime() > Date.now()
  if (isFuture && !adapter.capabilities.supportsFutureDatedChange) {
    return { mode: 'VIRTUAL' }
  }
  return { mode: 'UPSTREAM' }
}

export async function resolveAdapterForSupplier({
  supabase,
  supplierId,
  operatorId,
}: {
  supabase?: SupabaseLike | null
  supplierId?: string | null
  operatorId?: string | null
}): Promise<SupplierAdapter | null> {
  try {
    return await createSupplierAdapter({ supabase, supplierId, operatorId })
  } catch {
    return null
  }
}

export async function checkOperationSupported({
  supabase,
  supplierId,
  operatorId,
  operation,
}: {
  supabase?: SupabaseLike | null
  supplierId?: string | null
  operatorId?: string | null
  operation: SpiOperation
}): Promise<{ supported: boolean; adapter: SupplierAdapter | null; reason?: string }> {
  const adapter = await resolveAdapterForSupplier({ supabase, supplierId, operatorId })
  if (!adapter) {
    return { supported: false, adapter: null, reason: 'ADAPTER_NOT_FOUND' }
  }
  if (!adapter.supportsOperation(operation)) {
    return { supported: false, adapter, reason: 'UPSTREAM_NOT_SUPPORTED' }
  }
  return { supported: true, adapter }
}
