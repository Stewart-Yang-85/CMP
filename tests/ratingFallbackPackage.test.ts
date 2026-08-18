import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  listDefaultFallbackPackageMappings,
  setDefaultFallbackPackage,
  unsetDefaultFallbackPackage,
} from '../src/services/ratingFallbackPackage.ts'

function parseQuery(queryString: string) {
  const filters: Array<{ field: string; op: string; value: string }> = []
  for (const part of String(queryString || '').split('&').filter(Boolean)) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx)
    if (key === 'select' || key === 'order' || key === 'limit') continue
    const value = part.slice(idx + 1)
    const opIdx = value.indexOf('.')
    if (opIdx < 0) continue
    filters.push({ field: key, op: value.slice(0, opIdx), value: decodeURIComponent(value.slice(opIdx + 1)) })
  }
  return filters
}

function createFakeSupabase(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables = new Map<string, Record<string, unknown>[]>()
  for (const [name, rows] of Object.entries(seed)) tables.set(name, rows.map((r) => ({ ...r })))
  const getTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name)!
  }
  const matches = (row: Record<string, unknown>, filters: ReturnType<typeof parseQuery>) =>
    filters.every((f) => {
      if (f.op === 'eq') return String(row[f.field] ?? '') === f.value
      if (f.op === 'in') return f.value.replace(/^\(|\)$/g, '').split(',').includes(String(row[f.field] ?? ''))
      return true
    })
  return {
    getTable,
    async select(table: string, queryString: string) {
      const filters = parseQuery(queryString)
      return getTable(table).filter((r) => matches(r, filters)).map((r) => ({ ...r }))
    },
    async insert(table: string, rows: unknown, options: { returning?: 'minimal' | 'representation' } = {}) {
      const payload = Array.isArray(rows) ? rows : [rows]
      const inserted = payload.map((r) => ({
        mapping_id: table === 'default_fallback_package_mappings' ? randomUUID() : undefined,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...(r as Record<string, unknown>),
      }))
      getTable(table).push(...inserted)
      return options.returning === 'minimal' ? null : inserted.map((r) => ({ ...r }))
    },
    async update(table: string, matchQueryString: string, patch: unknown, options: { returning?: 'minimal' | 'representation' } = {}) {
      const filters = parseQuery(matchQueryString)
      const patchData = (patch ?? {}) as Record<string, unknown>
      const updated = getTable(table).filter((r) => matches(r, filters)).map((r) => Object.assign(r, patchData))
      return options.returning === 'minimal' ? null : updated.map((r) => ({ ...r }))
    },
  }
}

describe('Default Fallback Package mappings', () => {
  const resellerId = '11111111-1111-1111-1111-111111111111'
  const enterpriseId = '22222222-2222-2222-2222-222222222222'
  const supplierId = '33333333-3333-3333-3333-333333333333'
  const operatorId = '44444444-4444-4444-4444-444444444444'
  const businessOperatorId = '44444444-4444-4444-4444-444444444446'
  const unboundSupplierId = '33333333-3333-3333-3333-333333333334'
  const unboundOperatorId = '44444444-4444-4444-4444-444444444445'
  const packageId = '55555555-5555-5555-5555-555555555555'
  const packageId2 = '66666666-6666-6666-6666-666666666666'
  const pricePlanId = '77777777-7777-7777-7777-777777777777'
  const pricePlanId2 = '88888888-8888-8888-8888-888888888888'
  const carrierServiceId = '99999999-9999-9999-9999-999999999999'
  const coveredNetworkProfileId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  let supabase: ReturnType<typeof createFakeSupabase>

  beforeEach(() => {
    supabase = createFakeSupabase({
      tenants: [
        { tenant_id: resellerId, tenant_type: 'RESELLER' },
        { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId },
      ],
      suppliers: [{ supplier_id: supplierId }, { supplier_id: unboundSupplierId }],
      reseller_suppliers: [{ reseller_id: resellerId, supplier_id: supplierId }],
      operators: [
        { operator_id: operatorId, supplier_id: supplierId, business_operator_id: businessOperatorId },
        { operator_id: unboundOperatorId, supplier_id: unboundSupplierId },
      ],
      packages: [
        { package_id: packageId, enterprise_id: enterpriseId, status: 'PUBLISHED', carrier_service_id: carrierServiceId, price_plan_id: pricePlanId },
        { package_id: packageId2, enterprise_id: enterpriseId, status: 'PUBLISHED', carrier_service_id: carrierServiceId, price_plan_id: pricePlanId2 },
      ],
      carrier_service_modules: [
        { carrier_service_id: carrierServiceId, supplier_id: supplierId, operator_id: operatorId, roaming_profile_id: randomUUID(), status: 'PUBLISHED' },
      ],
      price_plans: [
        { price_plan_id: pricePlanId, type: 'FIXED_BUNDLE', covered_network_profile_id: coveredNetworkProfileId },
        { price_plan_id: pricePlanId2, type: 'FIXED_BUNDLE', covered_network_profile_id: coveredNetworkProfileId },
      ],
      price_plan_fixed_bundle: [
        { price_plan_id: pricePlanId, monthly_fee: 0, deactivated_monthly_fee: 0, total_quota_mb: 0 },
        { price_plan_id: pricePlanId2, monthly_fee: 0, deactivated_monthly_fee: 0, total_quota_mb: 0 },
      ],
      covered_network_profiles: [
        { covered_network_profile_id: coveredNetworkProfileId, coverage_mode: 'NONE', status: 'PUBLISHED' },
      ],
    })
  })

  it('sets, rejects duplicate active mapping, lists, and unsets fallback package mapping', async () => {
    const first = await setDefaultFallbackPackage({ supabase, payload: { enterpriseId, resellerId, supplierId, operatorId, packageId } })
    expect(first.ok).toBe(true)
    const second = await setDefaultFallbackPackage({ supabase, payload: { enterpriseId, resellerId, supplierId, operatorId, packageId: packageId2 } })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.status).toBe(409)
      expect(second.code).toBe('ACTIVE_FALLBACK_PACKAGE_EXISTS')
      expect(second.message).toContain(String((first.value as any).mappingId))
      expect(second.message).toContain(packageId)
    }

    const mappings = supabase.getTable('default_fallback_package_mappings')
    expect(mappings.filter((m) => m.status === 'ACTIVE')).toHaveLength(1)
    expect(mappings.find((m) => m.status === 'ACTIVE')?.enterprise_id).toBe(enterpriseId)
    expect(mappings.find((m) => m.status === 'ACTIVE')?.package_id).toBe(packageId)

    const listed = await listDefaultFallbackPackageMappings({ supabase, enterpriseId, resellerId, status: 'ACTIVE' })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.items).toHaveLength(1)
    expect(listed.value.items[0].enterpriseId).toBe(enterpriseId)

    const unset = await unsetDefaultFallbackPackage({ supabase, payload: { enterpriseId, resellerId, supplierId, operatorId } })
    expect(unset.ok).toBe(true)
    expect(supabase.getTable('default_fallback_package_mappings').filter((m) => m.status === 'ACTIVE')).toHaveLength(0)

    const repeatedUnset = await unsetDefaultFallbackPackage({ supabase, payload: { enterpriseId, resellerId, supplierId, operatorId } })
    expect(repeatedUnset.ok).toBe(false)
    if (!repeatedUnset.ok) {
      expect(repeatedUnset.status).toBe(404)
      expect(repeatedUnset.code).toBe('ACTIVE_FALLBACK_PACKAGE_NOT_FOUND')
    }
  })

  it('rejects non-zero fixed bundle fallback packages', async () => {
    supabase.getTable('price_plan_fixed_bundle')[0].total_quota_mb = 1024
    const result = await setDefaultFallbackPackage({ supabase, payload: { enterpriseId, resellerId, supplierId, operatorId, packageId } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('must be 0')
  })

  it('rejects packages outside the requested enterprise scope', async () => {
    const otherEnterpriseId = randomUUID()
    supabase.getTable('tenants').push({ tenant_id: otherEnterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId })
    const result = await setDefaultFallbackPackage({
      supabase,
      payload: { enterpriseId: otherEnterpriseId, resellerId, supplierId, operatorId, packageId },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe('packageId is outside enterprise scope.')
  })

  it('validates reseller and enterprise scope when listing fallback mappings', async () => {
    const missingResellerResult = await listDefaultFallbackPackageMappings({ supabase, resellerId: randomUUID() })
    expect(missingResellerResult.ok).toBe(false)
    if (!missingResellerResult.ok) expect(missingResellerResult.message).toBe('resellerId is not a valid RESELLER tenant.')

    const missingEnterpriseResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, enterpriseId: randomUUID() })
    expect(missingEnterpriseResult.ok).toBe(false)
    if (!missingEnterpriseResult.ok) expect(missingEnterpriseResult.message).toBe('enterpriseId is not a valid ENTERPRISE tenant.')

    const otherResellerId = randomUUID()
    const otherEnterpriseId = randomUUID()
    supabase.getTable('tenants').push(
      { tenant_id: otherResellerId, tenant_type: 'RESELLER' },
      { tenant_id: otherEnterpriseId, tenant_type: 'ENTERPRISE', parent_id: otherResellerId }
    )
    const outsideScopeResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, enterpriseId: otherEnterpriseId })
    expect(outsideScopeResult.ok).toBe(false)
    if (!outsideScopeResult.ok) {
      expect(outsideScopeResult.status).toBe(403)
      expect(outsideScopeResult.message).toBe('enterpriseId is outside reseller scope.')
    }
  })

  it('validates supplier and operator scope when listing fallback mappings', async () => {
    const missingSupplierResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, supplierId: randomUUID() })
    expect(missingSupplierResult.ok).toBe(false)
    if (!missingSupplierResult.ok) expect(missingSupplierResult.message).toBe('supplierId is not found.')

    const unboundSupplierResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, supplierId: unboundSupplierId })
    expect(unboundSupplierResult.ok).toBe(false)
    if (!unboundSupplierResult.ok) {
      expect(unboundSupplierResult.status).toBe(403)
      expect(unboundSupplierResult.message).toBe('supplierId is outside reseller scope.')
    }

    const missingOperatorResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, operatorId: randomUUID() })
    expect(missingOperatorResult.ok).toBe(false)
    if (!missingOperatorResult.ok) expect(missingOperatorResult.message).toBe('operatorId is not found.')

    const unboundOperatorResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, operatorId: unboundOperatorId })
    expect(unboundOperatorResult.ok).toBe(false)
    if (!unboundOperatorResult.ok) {
      expect(unboundOperatorResult.status).toBe(403)
      expect(unboundOperatorResult.message).toBe('operatorId is outside reseller scope.')
    }

    const mismatchResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, supplierId, operatorId: unboundOperatorId })
    expect(mismatchResult.ok).toBe(false)
    if (!mismatchResult.ok) expect(mismatchResult.message).toBe('operatorId is not linked to supplierId.')

    const validResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, supplierId, operatorId })
    expect(validResult.ok).toBe(true)

    const businessOperatorResult = await listDefaultFallbackPackageMappings({ supabase, resellerId, supplierId, operatorId: businessOperatorId })
    expect(businessOperatorResult.ok).toBe(true)
  })

  it('paginates fallback mappings with default and max page size 20', async () => {
    const rows = Array.from({ length: 25 }, (_, idx) => ({
      mapping_id: randomUUID(),
      enterprise_id: enterpriseId,
      reseller_id: resellerId,
      supplier_id: supplierId,
      operator_id: operatorId,
      package_id: idx % 2 === 0 ? packageId : packageId2,
      status: 'ACTIVE',
      created_at: new Date(2026, 0, idx + 1).toISOString(),
      updated_at: new Date(2026, 0, idx + 1).toISOString(),
    }))
    supabase.getTable('default_fallback_package_mappings').push(...rows)

    const defaultPage = await listDefaultFallbackPackageMappings({ supabase, resellerId })
    expect(defaultPage.ok).toBe(true)
    if (!defaultPage.ok) return
    expect(defaultPage.value.total).toBe(25)
    expect(defaultPage.value.page).toBe(1)
    expect(defaultPage.value.pageSize).toBe(20)
    expect(defaultPage.value.items).toHaveLength(20)

    const secondPage = await listDefaultFallbackPackageMappings({ supabase, resellerId, page: 2, pageSize: 20 })
    expect(secondPage.ok).toBe(true)
    if (!secondPage.ok) return
    expect(secondPage.value.items).toHaveLength(5)
    expect(secondPage.value.page).toBe(2)
    expect(secondPage.value.pageSize).toBe(20)
    expect(secondPage.value.items[0].mappingId).toBe(rows[20].mapping_id)

    const capped = await listDefaultFallbackPackageMappings({ supabase, resellerId, pageSize: 100 })
    expect(capped.ok).toBe(true)
    if (!capped.ok) return
    expect(capped.value.pageSize).toBe(20)
    expect(capped.value.items).toHaveLength(20)
  })
})
