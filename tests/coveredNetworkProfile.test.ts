/**
 * Phase 30 T226: CoveredNetworkProfile service tests (mock Supabase).
 * Billing in-profile vs OOP: see billing.integration.test.ts ("Phase 30 (T222) billing waterfall").
 */

import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createCoveredNetworkProfile,
  deprecateCoveredNetworkProfile,
  getCoveredNetworkProfileDetail,
  listCoveredNetworkProfiles,
  patchCoveredNetworkProfile,
  publishCoveredNetworkProfile,
  createRoamingProfile,
} from '../src/services/networkProfile.js'

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

function applyFilters(rows: Record<string, unknown>[], filters: Array<{ field: string; op: string; value: string | string[] }>) {
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

function sortRows(rows: Record<string, unknown>[], order: string | null) {
  if (!order) return rows
  const parts = order.split('.')
  const field = parts[0]
  const dir = parts[1]?.toLowerCase() === 'desc' ? -1 : 1
  return rows.slice().sort((a, b) => {
    const av = a?.[field as keyof typeof a]
    const bv = b?.[field as keyof typeof b]
    if (av === bv) return 0
    if (av === undefined || av === null) return 1
    if (bv === undefined || bv === null) return -1
    return av < bv ? -1 * dir : 1 * dir
  })
}

function createFakeSupabase(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables = new Map<string, Record<string, unknown>[]>()
  const ensureTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name) as Record<string, unknown>[]
  }
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((r) => ({ ...r })))
  }
  const getTable = (name: string) => ensureTable(name)
  const insertRow = (table: string, row: Record<string, unknown>) => {
    const nowIso = new Date().toISOString()
    if (table === 'covered_network_profiles') {
      if (!row.covered_network_profile_id) row.covered_network_profile_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
      if (row.status === undefined || row.status === null) row.status = 'DRAFT'
      if (row.coverage_mode === undefined || row.coverage_mode === null) row.coverage_mode = 'LIST'
    }
    if (table === 'covered_network_profile_entries') {
      if (!row.entry_id) row.entry_id = randomUUID()
    }
    if (table === 'roaming_profiles') {
      if (!row.roaming_profile_id) row.roaming_profile_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
      if (row.status === undefined || row.status === null) row.status = 'DRAFT'
    }
    if (table === 'audit_logs') {
      if (!row.audit_id) row.audit_id = randomUUID()
    }
    return row
  }
  return {
    getTable,
    async select(table: string, queryString: string) {
      const { filters, limit, offset, order } = parseQuery(queryString)
      const rows = applyFilters(getTable(table), filters)
      const sorted = sortRows(rows, order)
      const sliced = sorted.slice(offset, limit != null ? offset + limit : undefined)
      return sliced.map((r) => ({ ...r }))
    },
    async insert(table: string, rows: unknown, options: { returning?: 'minimal' | 'representation' } = {}) {
      const payload = Array.isArray(rows) ? rows : [rows]
      const inserted = payload.map((r) => insertRow(table, { ...(r as Record<string, unknown>) }))
      getTable(table).push(...inserted)
      if (options.returning === 'minimal') return null
      return inserted.map((r) => ({ ...r }))
    },
    async update(table: string, matchQueryString: string, patch: unknown, options: { returning?: 'minimal' | 'representation' } = {}) {
      const { filters } = parseQuery(matchQueryString)
      const rows = applyFilters(getTable(table), filters)
      const patchData = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
      const updated = rows.map((row) => Object.assign(row, { ...patchData }))
      if (options.returning === 'minimal') return null
      return updated.map((r) => ({ ...r }))
    },
    async delete(table: string, matchQueryString: string) {
      const { filters } = parseQuery(matchQueryString)
      const tableRows = getTable(table)
      const next = tableRows.filter((row) => applyFilters([row], filters).length === 0)
      tableRows.splice(0, tableRows.length, ...next)
    },
  }
}

describe('Phase 30 T226: CoveredNetworkProfile', () => {
  const supplierId = '11111111-1111-1111-1111-111111111111'
  const operatorId = '22222222-2222-2222-2222-222222222222'
  const carrierId = '99999999-9999-9999-9999-999999999999'
  const resellerTenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const resellerTenantB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  let supabase: ReturnType<typeof createFakeSupabase>

  beforeEach(() => {
    supabase = createFakeSupabase({
      suppliers: [{ supplier_id: supplierId }],
      operators: [{ operator_id: operatorId, supplier_id: supplierId, carrier_id: carrierId }],
      business_operators: [{ operator_id: operatorId, mcc: '001', mnc: '01', name: 'Op' }],
      tenants: [
        { tenant_id: resellerTenantA, tenant_type: 'RESELLER', parent_id: null },
        { tenant_id: resellerTenantB, tenant_type: 'RESELLER', parent_id: null },
      ],
    })
  })

  it('rejects create without resellerId', async () => {
    const result = await createCoveredNetworkProfile({
      supabase,
      payload: {
        name: 'No reseller',
        supplierId,
        operatorId,
        coverage: [{ mcc: '001', mnc: '01' }],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('resellerId is required.')
    }
  })

  it('rejects create when resellerId is not a RESELLER tenant', async () => {
    const enterpriseTenant = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    supabase.getTable('tenants').push({ tenant_id: enterpriseTenant, tenant_type: 'ENTERPRISE', parent_id: null })
    const result = await createCoveredNetworkProfile({
      supabase,
      payload: {
        name: 'Bad tenant type',
        supplierId,
        operatorId,
        resellerId: enterpriseTenant,
        coverage: [{ mcc: '001', mnc: '01' }],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('resellerId is not a valid RESELLER tenant.')
    }
  })

  it('CRUD: create → read → list → patch → publish → deprecate', async () => {
    const created = await createCoveredNetworkProfile({
      supabase,
      payload: {
        name: 'Cov A',
        supplierId,
        operatorId,
        resellerId: resellerTenantA,
        coverage: [{ mcc: '234', mnc: '15' }],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.coveredNetworkProfileId
    expect((created.value as any).profileId).toBeUndefined()

    const detail = await getCoveredNetworkProfileDetail({ supabase, coveredNetworkProfileId: id })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect((detail.value as { name?: string }).name).toBe('Cov A')
    expect((detail.value as { coverage?: unknown[] }).coverage?.length).toBe(1)

    const listed = await listCoveredNetworkProfiles({
      supabase,
      supplierId,
      resellerId: resellerTenantA,
      coveredNetworkProfileId: null,
      operatorId: null,
      status: null,
      page: 1,
      pageSize: 20,
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.items.length).toBe(1)

    const patched = await patchCoveredNetworkProfile({
      supabase,
      coveredNetworkProfileId: id,
      payload: { name: 'Cov A2' },
    })
    expect(patched.ok).toBe(true)
    if (!patched.ok) return
    expect((patched.value as { name?: string }).name).toBe('Cov A2')

    const pub = await publishCoveredNetworkProfile({ supabase, coveredNetworkProfileId: id })
    expect(pub.ok).toBe(true)

    const dep = await deprecateCoveredNetworkProfile({ supabase, coveredNetworkProfileId: id })
    expect(dep.ok).toBe(true)
    if (!dep.ok) return
    expect(dep.value.status).toBe('DEPRECATED')
  })

  it('supports coverageMode NONE without coverage entries', async () => {
    const created = await createCoveredNetworkProfile({
      supabase,
      payload: {
        name: 'Fallback no coverage',
        supplierId,
        operatorId,
        resellerId: resellerTenantA,
        coverageMode: 'NONE',
        coverage: [],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.coveredNetworkProfileId
    expect((created.value as any).profileId).toBeUndefined()
    expect(supabase.getTable('covered_network_profile_entries')).toHaveLength(0)

    const detail = await getCoveredNetworkProfileDetail({ supabase, coveredNetworkProfileId: id })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    expect((detail.value as { coverageMode?: string }).coverageMode).toBe('NONE')
    expect((detail.value as { coverage?: unknown[] }).coverage).toEqual([])

    const pub = await publishCoveredNetworkProfile({ supabase, coveredNetworkProfileId: id })
    expect(pub.ok).toBe(true)
  })

  it('rejects coverage entries when coverageMode is NONE', async () => {
    const result = await createCoveredNetworkProfile({
      supabase,
      payload: {
        name: 'Invalid none coverage',
        supplierId,
        operatorId,
        resellerId: resellerTenantA,
        coverageMode: 'NONE',
        coverage: [{ mcc: '001', mnc: '01' }],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toBe('coverage must be empty when coverageMode is NONE.')
    }
  })

  it('deprecate returns 409 REFERENCES_BLOCKED when a price_plan references the profile', async () => {
    const created = await createCoveredNetworkProfile({
      supabase,
      payload: {
        name: 'Cov blocked',
        supplierId,
        operatorId,
        resellerId: resellerTenantA,
        coverage: [{ mcc: '001', mnc: '01' }],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.coveredNetworkProfileId
    const pub = await publishCoveredNetworkProfile({ supabase, coveredNetworkProfileId: id })
    expect(pub.ok).toBe(true)

    supabase.getTable('price_plans').push({
      price_plan_id: randomUUID(),
      enterprise_id: randomUUID(),
      covered_network_profile_id: id,
      status: 'PUBLISHED',
    })

    const dep = await deprecateCoveredNetworkProfile({ supabase, coveredNetworkProfileId: id })
    expect(dep.ok).toBe(false)
    if (dep.ok) return
    expect(dep.status).toBe(409)
    expect(dep.code).toBe('REFERENCES_BLOCKED')
  })

  it('list with resellerId excludes profiles owned by another reseller tenant (no cross-tenant leakage)', async () => {
    const created = await createCoveredNetworkProfile({
      supabase,
      payload: {
        name: 'Reseller A only',
        supplierId,
        operatorId,
        resellerId: resellerTenantA,
        coverage: [{ mcc: '310', mnc: '260' }],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.coveredNetworkProfileId

    const wrong = await listCoveredNetworkProfiles({
      supabase,
      supplierId,
      resellerId: resellerTenantB,
      operatorId: null,
      coveredNetworkProfileId: null,
      status: null,
      page: 1,
      pageSize: 20,
    })
    expect(wrong.ok).toBe(true)
    if (!wrong.ok) return
    expect(wrong.value.items.some((it: unknown) => (it as { coveredNetworkProfileId?: string }).coveredNetworkProfileId === id)).toBe(
      false
    )

    const right = await listCoveredNetworkProfiles({
      supabase,
      supplierId,
      resellerId: resellerTenantA,
      operatorId: null,
      coveredNetworkProfileId: null,
      status: null,
      page: 1,
      pageSize: 20,
    })
    expect(right.ok).toBe(true)
    if (!right.ok) return
    expect(right.value.items.length).toBeGreaterThanOrEqual(1)
  })

  it('list defaults pageSize to 20, caps pageSize at 20, and paginates by page', async () => {
    for (let i = 0; i < 25; i += 1) {
      supabase.getTable('covered_network_profiles').push({
        covered_network_profile_id: randomUUID(),
        name: `Cov ${String(i).padStart(2, '0')}`,
        reseller_id: resellerTenantA,
        supplier_id: supplierId,
        operator_id: operatorId,
        coverage_mode: 'NONE',
        status: 'DRAFT',
        created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        updated_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
    }

    const firstPage = await listCoveredNetworkProfiles({
      supabase,
      supplierId,
      resellerId: resellerTenantA,
      operatorId: null,
      coveredNetworkProfileId: null,
      status: null,
      page: undefined,
      pageSize: undefined,
    })
    expect(firstPage.ok).toBe(true)
    if (!firstPage.ok) return
    expect(firstPage.value.total).toBe(25)
    expect(firstPage.value.page).toBe(1)
    expect(firstPage.value.pageSize).toBe(20)
    expect(firstPage.value.items).toHaveLength(20)
    expect((firstPage.value.items[0] as { name?: string }).name).toBe('Cov 24')

    const secondPage = await listCoveredNetworkProfiles({
      supabase,
      supplierId,
      resellerId: resellerTenantA,
      operatorId: null,
      coveredNetworkProfileId: null,
      status: null,
      page: 2,
      pageSize: 50,
    })
    expect(secondPage.ok).toBe(true)
    if (!secondPage.ok) return
    expect(secondPage.value.total).toBe(25)
    expect(secondPage.value.page).toBe(2)
    expect(secondPage.value.pageSize).toBe(20)
    expect(secondPage.value.items).toHaveLength(5)
    expect((secondPage.value.items[0] as { name?: string }).name).toBe('Cov 04')
  })

  it('list by operatorId (business_operator_id) without supplierId matches all supplier-bound rows', async () => {
    const businessOperId = 'a8e8175e-f3ac-444f-a836-04471ebde672'
    const supplierA = 'aaaaaaaa-1111-1111-1111-111111111111'
    const supplierB = 'bbbbbbbb-2222-2222-2222-222222222222'
    const opA = 'cccccccc-3333-3333-3333-cccccccccccc'
    const opB = 'dddddddd-4444-4444-4444-dddddddddddd'
    const sb = createFakeSupabase({
      suppliers: [{ supplier_id: supplierA }, { supplier_id: supplierB }],
      operators: [
        { operator_id: opA, supplier_id: supplierA, business_operator_id: businessOperId },
        { operator_id: opB, supplier_id: supplierB, business_operator_id: businessOperId },
      ],
      business_operators: [{ operator_id: businessOperId, mcc: '001', mnc: '01', name: 'Cat' }],
      tenants: [{ tenant_id: resellerTenantA, tenant_type: 'RESELLER', parent_id: null }],
    })
    const created = await createCoveredNetworkProfile({
      supabase: sb,
      payload: {
        name: 'Cov multi-supplier BO',
        supplierId: supplierB,
        operatorId: businessOperId,
        resellerId: resellerTenantA,
        coverage: [{ mcc: '310', mnc: '260' }],
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.coveredNetworkProfileId

    const listed = await listCoveredNetworkProfiles({
      supabase: sb,
      supplierId: undefined,
      operatorId: businessOperId,
      resellerId: null,
      coveredNetworkProfileId: null,
      status: 'DRAFT',
      page: 1,
      pageSize: 20,
    })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(
      listed.value.items.some(
        (it: unknown) => (it as { coveredNetworkProfileId?: string }).coveredNetworkProfileId === id
      )
    ).toBe(true)
  })
})

describe('NetworkProfile audit actor (platform M2M)', () => {
  const supplierId = '11111111-1111-1111-1111-111111111111'
  const operatorId = '22222222-2222-2222-2222-222222222222'
  const carrierId = '99999999-9999-9999-9999-999999999999'
  const resellerTenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

  it('stores null actor_user_id when platform token sub is cmp-admin', async () => {
    const supabase = createFakeSupabase({
      suppliers: [{ supplier_id: supplierId }],
      operators: [{ operator_id: operatorId, supplier_id: supplierId, carrier_id: carrierId }],
      business_operators: [{ operator_id: operatorId, mcc: '001', mnc: '01', name: 'Op' }],
    })
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name: 'Admin CSV import',
        resellerId: resellerTenantA,
        supplierId,
        operatorId,
        mccmncList: [{ mcc: '520', mnc: '*', ratePerMb: 0.001 }],
      },
      audit: { actorUserId: 'cmp-admin', actorRole: 'platform_admin' },
    })
    expect(result.ok).toBe(true)
    const audits = supabase.getTable('audit_logs')
    expect(audits.length).toBe(1)
    expect(audits[0].actor_user_id).toBeNull()
    expect(audits[0].action).toBe('ROAMING_PROFILE_CREATED')
  })
})
