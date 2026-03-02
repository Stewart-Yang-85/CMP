import { createWxzhonggengAdapter } from './wxzhonggeng.js'
import type { SupplierAdapter, SupplierCapabilities } from './spi.js'

type ChangePlanStrategy = {
  mode: 'UPSTREAM' | 'VIRTUAL'
}

function getEnvTrim(name: string) {
  const v = process.env[name]
  if (!v) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function normalizeKey(value: unknown) {
  return String(value ?? '').trim()
}

function loadSupplierAdapterMap() {
  const raw = getEnvTrim('SUPPLIER_ADAPTERS') || getEnvTrim('SUPPLIER_ADAPTERS_JSON')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const key = normalizeKey(k)
      const val = normalizeKey(v)
      if (key && val) map[key] = val
    }
    return map
  } catch {
    return {}
  }
}

function resolveSupplierKey(supplierId?: string | null) {
  const id = normalizeKey(supplierId)
  const map = loadSupplierAdapterMap()
  if (id && map[id]) return map[id]
  const wxId = getEnvTrim('WXZHONGGENG_SUPPLIER_ID')
  if (id && wxId && id === wxId) return 'wxzhonggeng'
  if (!id && wxId) return 'wxzhonggeng'
  const fallback = getEnvTrim('SUPPLIER_DEFAULT_ADAPTER')
  if (fallback) return fallback
  return null
}

export function createSupplierAdapter({ supplierId }: { supplierId?: string | null }): SupplierAdapter {
  const key = resolveSupplierKey(supplierId)
  if (key === 'wxzhonggeng') return createWxzhonggengAdapter()
  throw new Error('supplier_adapter_not_found')
}

export function getSupplierCapabilities({ supplierId }: { supplierId?: string | null }): SupplierCapabilities {
  const adapter = createSupplierAdapter({ supplierId })
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
