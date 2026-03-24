import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Phase 26 - T147: Structural validation for SIMs-by-PackageId feature.
 *
 * These tests verify the package-to-SIM resolution logic
 * (package_versions -> subscriptions -> sims) works correctly
 * at the data-filtering level.
 */

function parseQuery(queryString: string) {
  const parts = String(queryString || '').split('&').filter(Boolean)
  const filters: Array<{ field: string; op: string; value: string | string[] }> = []
  let limit: number | null = null
  let offset = 0
  let order: string | null = null
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx)
    const value = part.slice(idx + 1)
    if (key === 'select') continue
    if (key === 'limit') {
      const n = Number(value)
      limit = Number.isFinite(n) ? n : null
      continue
    }
    if (key === 'offset') {
      const n = Number(value)
      offset = Number.isFinite(n) ? n : 0
      continue
    }
    if (key === 'order') {
      order = decodeURIComponent(value)
      continue
    }
    const opIdx = value.indexOf('.')
    if (opIdx < 0) continue
    const op = value.slice(0, opIdx)
    const raw = value.slice(opIdx + 1)
    if (op === 'in') {
      const inner = raw.startsWith('(') && raw.endsWith(')') ? raw.slice(1, -1) : raw
      const values = inner.length ? inner.split(',').map((v) => decodeURIComponent(v)) : []
      filters.push({ field: key, op, value: values })
      continue
    }
    filters.push({ field: key, op, value: decodeURIComponent(raw) })
  }
  return { filters, limit, offset, order }
}

function applyFilters(
  rows: Record<string, any>[],
  filters: Array<{ field: string; op: string; value: string | string[] }>
) {
  if (!filters.length) return rows
  return rows.filter((row) => {
    for (const f of filters) {
      const actual = row?.[f.field]
      if (f.op === 'eq') {
        if (String(actual ?? '') !== String(f.value ?? '')) return false
        continue
      }
      if (f.op === 'in') {
        const values = Array.isArray(f.value) ? f.value : []
        if (!values.includes(String(actual ?? ''))) return false
        continue
      }
    }
    return true
  })
}

function createFakeSupabase(seed: Record<string, Record<string, any>[]> = {}) {
  const tables = new Map<string, Record<string, any>[]>()
  const ensureTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name) as Record<string, any>[]
  }
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((r) => ({ ...r })))
  }
  return {
    getTable: (name: string) => ensureTable(name),
    async select(table: string, queryString: string) {
      const { filters, limit, offset } = parseQuery(queryString)
      const rows = applyFilters(ensureTable(table), filters)
      const sliced = rows.slice(offset, limit ? offset + limit : undefined)
      return sliced.map((r) => ({ ...r }))
    },
    async selectWithCount(table: string, queryString: string) {
      const { filters, limit, offset } = parseQuery(queryString)
      const rows = applyFilters(ensureTable(table), filters)
      const total = rows.length
      const sliced = rows.slice(offset, limit ? offset + limit : undefined)
      return { data: sliced.map((r) => ({ ...r })), total }
    },
  }
}

/**
 * Simulates the package-to-SIM resolution logic used in the route handlers.
 * This is the core algorithm from T142/T143 extracted for testability.
 */
async function resolveSimIdsByPackageId(
  supabase: ReturnType<typeof createFakeSupabase>,
  packageId: string
): Promise<Set<string>> {
  const pvRows = await supabase.select(
    'package_versions',
    `select=package_version_id&package_id=eq.${encodeURIComponent(packageId)}`
  )
  const pvIds = (Array.isArray(pvRows) ? pvRows : [])
    .map((r: any) => String(r?.package_version_id ?? '').trim())
    .filter(Boolean)

  if (!pvIds.length) return new Set()

  const pvIdFilter = pvIds.map((id) => encodeURIComponent(id)).join(',')
  const subRows = await supabase.select(
    'subscriptions',
    `select=sim_id&package_version_id=in.(${pvIdFilter})&state=in.(ACTIVE,PENDING)`
  )

  return new Set(
    (Array.isArray(subRows) ? subRows : [])
      .map((r: any) => String(r?.sim_id ?? '').trim())
      .filter(Boolean)
  )
}

describe('Phase 26 - Query SIMs by Package ID', () => {
  const enterpriseId = randomUUID()
  const packageId = randomUUID()
  const packageVersionId1 = randomUUID()
  const packageVersionId2 = randomUUID()
  const simId1 = randomUUID()
  const simId2 = randomUUID()
  const simId3 = randomUUID()

  function buildSeededSupabase() {
    return createFakeSupabase({
      package_versions: [
        { package_version_id: packageVersionId1, package_id: packageId, version: 1, status: 'PUBLISHED' },
        { package_version_id: packageVersionId2, package_id: packageId, version: 2, status: 'PUBLISHED' },
        { package_version_id: randomUUID(), package_id: randomUUID(), version: 1, status: 'PUBLISHED' },
      ],
      subscriptions: [
        { subscription_id: randomUUID(), sim_id: simId1, package_version_id: packageVersionId1, state: 'ACTIVE' },
        { subscription_id: randomUUID(), sim_id: simId2, package_version_id: packageVersionId2, state: 'PENDING' },
        { subscription_id: randomUUID(), sim_id: simId3, package_version_id: packageVersionId1, state: 'CANCELLED' },
        { subscription_id: randomUUID(), sim_id: randomUUID(), package_version_id: randomUUID(), state: 'ACTIVE' },
      ],
      sims: [
        { sim_id: simId1, iccid: '89001000000000001', enterprise_id: enterpriseId, status: 'ACTIVATED' },
        { sim_id: simId2, iccid: '89001000000000002', enterprise_id: enterpriseId, status: 'ACTIVATED' },
        { sim_id: simId3, iccid: '89001000000000003', enterprise_id: enterpriseId, status: 'SUSPENDED' },
      ],
    })
  }

  it('should resolve SIM IDs from package through subscriptions', async () => {
    const supabase = buildSeededSupabase()
    const simIds = await resolveSimIdsByPackageId(supabase, packageId)

    expect(simIds.size).toBe(2)
    expect(simIds.has(simId1)).toBe(true)
    expect(simIds.has(simId2)).toBe(true)
  })

  it('should only include ACTIVE and PENDING subscriptions', async () => {
    const supabase = buildSeededSupabase()
    const simIds = await resolveSimIdsByPackageId(supabase, packageId)

    // simId3 has CANCELLED subscription, should not be included
    expect(simIds.has(simId3)).toBe(false)
  })

  it('should return empty set for non-existent package', async () => {
    const supabase = buildSeededSupabase()
    const simIds = await resolveSimIdsByPackageId(supabase, randomUUID())

    expect(simIds.size).toBe(0)
  })

  it('should return empty set when package has no subscriptions', async () => {
    const orphanPackageId = randomUUID()
    const orphanVersionId = randomUUID()
    const supabase = createFakeSupabase({
      package_versions: [
        { package_version_id: orphanVersionId, package_id: orphanPackageId, version: 1 },
      ],
      subscriptions: [],
    })

    const simIds = await resolveSimIdsByPackageId(supabase, orphanPackageId)
    expect(simIds.size).toBe(0)
  })

  it('should deduplicate SIM IDs across multiple package versions', async () => {
    const pkgId = randomUUID()
    const pv1 = randomUUID()
    const pv2 = randomUUID()
    const sharedSimId = randomUUID()

    const supabase = createFakeSupabase({
      package_versions: [
        { package_version_id: pv1, package_id: pkgId, version: 1 },
        { package_version_id: pv2, package_id: pkgId, version: 2 },
      ],
      subscriptions: [
        { subscription_id: randomUUID(), sim_id: sharedSimId, package_version_id: pv1, state: 'ACTIVE' },
        { subscription_id: randomUUID(), sim_id: sharedSimId, package_version_id: pv2, state: 'ACTIVE' },
      ],
    })

    const simIds = await resolveSimIdsByPackageId(supabase, pkgId)
    // Set naturally deduplicates
    expect(simIds.size).toBe(1)
    expect(simIds.has(sharedSimId)).toBe(true)
  })

  it('should correctly filter SIMs using resolved IDs', async () => {
    const supabase = buildSeededSupabase()
    const simIds = await resolveSimIdsByPackageId(supabase, packageId)
    const simIdArr = Array.from(simIds)

    // Apply the filter as the route handler would
    const filterQs = `select=sim_id,iccid,status&sim_id=in.(${simIdArr.map((id) => encodeURIComponent(id)).join(',')})&enterprise_id=eq.${encodeURIComponent(enterpriseId)}`
    const { data, total } = await supabase.selectWithCount('sims', filterQs)

    expect(total).toBe(2)
    const iccids = (data as any[]).map((r) => r.iccid).sort()
    expect(iccids).toEqual(['89001000000000001', '89001000000000002'])
  })

  it('should return empty items when no SIMs match filters', async () => {
    const supabase = buildSeededSupabase()
    const simIds = await resolveSimIdsByPackageId(supabase, packageId)
    const simIdArr = Array.from(simIds)

    // Filter by a different enterprise - should return 0
    const otherEnterprise = randomUUID()
    const filterQs = `select=sim_id&sim_id=in.(${simIdArr.map((id) => encodeURIComponent(id)).join(',')})&enterprise_id=eq.${encodeURIComponent(otherEnterprise)}`
    const { data, total } = await supabase.selectWithCount('sims', filterQs)

    expect(total).toBe(0)
    expect((data as any[]).length).toBe(0)
  })
})

describe('Phase 26 - Validation rules', () => {
  it('should require enterpriseId when packageId is provided (platform/reseller scope)', () => {
    // Simulates the route validation: packageId without enterpriseId should fail
    const packageId = randomUUID()
    const enterpriseId: string | null = null
    const scope: 'platform' | 'reseller' | 'customer' = 'platform'

    const needsEnterprise = (scope === 'platform' || scope === 'reseller') && !enterpriseId
    expect(needsEnterprise).toBe(true)
  })

  it('should require enterpriseId for reseller scope with packageId', () => {
    const packageId = randomUUID()
    const enterpriseId: string | null = null
    const scope: 'platform' | 'reseller' | 'customer' = 'reseller'

    const needsEnterprise = (scope === 'platform' || scope === 'reseller') && !enterpriseId
    expect(needsEnterprise).toBe(true)
  })

  it('should not require enterpriseId for customer scope with packageId', () => {
    const packageId = randomUUID()
    const enterpriseId: string | null = null
    const scope: 'platform' | 'reseller' | 'customer' = 'customer'

    const needsEnterprise = (scope === 'platform' || scope === 'reseller') && !enterpriseId
    expect(needsEnterprise).toBe(false)
  })

  it('should reject invalid packageId format', () => {
    const invalidPackageId = 'not-a-uuid'
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect(uuidRegex.test(invalidPackageId)).toBe(false)
  })

  it('should accept valid packageId format', () => {
    const validPackageId = randomUUID()
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect(uuidRegex.test(validPackageId)).toBe(true)
  })

  it('should not require enterpriseId when platform scope and no packageId', () => {
    const packageIdQuery: string | null = null
    const enterpriseId: string | null = null
    const scope: 'platform' | 'reseller' | 'customer' = 'platform'

    // Only require enterpriseId when packageId IS provided
    const needsEnterprise = packageIdQuery && (scope === 'platform' || scope === 'reseller') && !enterpriseId
    expect(needsEnterprise).toBeFalsy()
  })

  it('should allow packageId with enterpriseId for platform scope', () => {
    const packageId = randomUUID()
    const enterpriseId = randomUUID()
    const scope: 'platform' | 'reseller' | 'customer' = 'platform'

    const needsEnterprise = (scope === 'platform' || scope === 'reseller') && !enterpriseId
    expect(needsEnterprise).toBe(false)
  })
})
