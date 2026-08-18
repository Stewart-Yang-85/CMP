import { describe, expect, it } from 'vitest'
import { listApnProfiles, listRoamingProfiles } from '../src/services/networkProfile.js'

const supplierId = '11111111-1111-1111-1111-111111111111'
const operatorId = '22222222-2222-2222-2222-222222222222'

function parseQuery(queryString: string) {
  const parts = String(queryString || '').split('&').filter(Boolean)
  const filters: Array<{ field: string; op: string; value: string | string[] }> = []
  let order: string | null = null
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx)
    const value = part.slice(idx + 1)
    if (key === 'select' || key === 'limit' || key === 'offset') continue
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
      filters.push({ field: key, op, value: inner ? inner.split(',').map((v) => decodeURIComponent(v)) : [] })
      continue
    }
    filters.push({ field: key, op, value: decodeURIComponent(raw) })
  }
  return { filters, order }
}

function applyFilters(rows: Record<string, unknown>[], filters: Array<{ field: string; op: string; value: string | string[] }>) {
  return rows.filter((row) => filters.every((filter) => {
    const actual = String(row[filter.field] ?? '')
    if (filter.op === 'eq') return actual === String(filter.value)
    if (filter.op === 'in') return Array.isArray(filter.value) && filter.value.includes(actual)
    return true
  }))
}

function sortRows(rows: Record<string, unknown>[], order: string | null) {
  if (!order) return rows
  const [field, dir] = order.split('.')
  return rows.slice().sort((a, b) => {
    const av = String(a[field] ?? '')
    const bv = String(b[field] ?? '')
    return dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv)
  })
}

function createSupabase() {
  const apnProfiles = Array.from({ length: 25 }, (_, index) => ({
    apn_profile_id: `apn-${index}`,
    name: `APN ${String(index).padStart(2, '0')}`,
    apn: `iot-${index}`,
    auth_type: 'NONE',
    supplier_id: supplierId,
    operator_id: operatorId,
    status: 'DRAFT',
    created_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  }))
  const roamingProfiles = Array.from({ length: 25 }, (_, index) => ({
    roaming_profile_id: `roaming-${index}`,
    name: `Roaming ${String(index).padStart(2, '0')}`,
    mccmnc_list: [{ mcc: '460', mnc: '00', ratePerMb: 0.001 }],
    supplier_id: supplierId,
    operator_id: operatorId,
    status: 'DRAFT',
    created_at: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  }))

  return {
    async select(table: string, queryString: string) {
      if (table === 'sims') return []
      if (table === 'operators') return [{ operator_id: operatorId, business_operator_id: operatorId }]
      const rows = table === 'apn_profiles' ? apnProfiles : table === 'roaming_profiles' ? roamingProfiles : []
      const { filters, order } = parseQuery(queryString)
      return sortRows(applyFilters(rows, filters), order).map((row) => ({ ...row }))
    },
  }
}

describe('Network profile list pagination', () => {
  it('caps APN profile pageSize at 20 and applies page offset', async () => {
    const result = await listApnProfiles({ supabase: createSupabase() as any, supplierId, page: 2, pageSize: 50 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.total).toBe(25)
    expect(result.value.page).toBe(2)
    expect(result.value.pageSize).toBe(20)
    expect(result.value.items).toHaveLength(5)
    expect((result.value.items[0] as { name?: string }).name).toBe('APN 04')
  })

  it('defaults Roaming profile pagination to page 1 and pageSize 20', async () => {
    const result = await listRoamingProfiles({ supabase: createSupabase() as any, supplierId })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.total).toBe(25)
    expect(result.value.page).toBe(1)
    expect(result.value.pageSize).toBe(20)
    expect(result.value.items).toHaveLength(20)
    expect((result.value.items[0] as { name?: string }).name).toBe('Roaming 24')
  })
})
