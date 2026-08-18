import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  listPublicInfos,
  createPublicInfo,
  updatePublicInfo,
  deletePublicInfo,
} from '../src/services/publicInfo.js'

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
      if (f.op === 'neq') {
        if (String(actual ?? '') === String(f.value ?? '')) return false
        continue
      }
      if (f.op === 'ilike') {
        const target = String(actual ?? '').toLowerCase()
        const pattern = String(f.value ?? '').toLowerCase()
        const token = pattern.replace(/%/g, '')
        if (!target.includes(token)) return false
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

function sortRows(rows: Record<string, any>[], order: string | null) {
  if (!order) return rows
  const parts = order.split('.')
  const field = parts[0]
  const dir = parts[1]?.toLowerCase() === 'desc' ? -1 : 1
  return rows.slice().sort((a, b) => {
    const av = a?.[field]
    const bv = b?.[field]
    if (av === bv) return 0
    if (av === undefined || av === null) return 1
    if (bv === undefined || bv === null) return -1
    return av < bv ? -1 * dir : 1 * dir
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
  const getTable = (name: string) => ensureTable(name)
  return {
    getTable,
    async select(table: string, queryString: string) {
      const { filters, limit, offset, order } = parseQuery(queryString)
      const rows = applyFilters(getTable(table), filters)
      const sorted = sortRows(rows, order)
      const sliced = sorted.slice(offset, limit ? offset + limit : undefined)
      return sliced.map((r) => ({ ...r }))
    },
    async selectWithCount(table: string, queryString: string) {
      const { filters, limit, offset, order } = parseQuery(queryString)
      const rows = applyFilters(getTable(table), filters)
      const total = rows.length
      const sorted = sortRows(rows, order)
      const sliced = sorted.slice(offset, limit ? offset + limit : undefined)
      return { data: sliced.map((r) => ({ ...r })), total }
    },
    async insert(
      table: string,
      rows: any,
      options: { returning?: 'minimal' | 'representation' } = {}
    ) {
      const payload = Array.isArray(rows) ? rows : [rows]
      const nowIso = new Date().toISOString()
      const inserted = payload.map((r) => {
        const row = { ...r }
        if (table === 'public_infos') {
          if (!row.public_info_id) row.public_info_id = randomUUID()
          if (!row.created_at) row.created_at = nowIso
          if (!row.updated_at) row.updated_at = nowIso
        }
        return row
      })
      getTable(table).push(...inserted)
      if (options.returning === 'minimal') return null
      return inserted.map((r) => ({ ...r }))
    },
    async update(
      table: string,
      matchQueryString: string,
      patch: unknown,
      options: { returning?: 'minimal' | 'representation' } = {}
    ) {
      const { filters } = parseQuery(matchQueryString)
      const rows = applyFilters(getTable(table), filters)
      const patchData = patch && typeof patch === 'object' ? (patch as Record<string, any>) : {}
      const updated = rows.map((row) => Object.assign(row, { ...patchData }))
      if (options.returning === 'minimal') return null
      return updated.map((r) => ({ ...r }))
    },
    async delete(table: string, matchQueryString: string) {
      const { filters } = parseQuery(matchQueryString)
      const tableRows = getTable(table)
      const matching = applyFilters(tableRows, filters)
      const matchIds = new Set(matching.map((r) => JSON.stringify(r)))
      const remaining = tableRows.filter((r) => !matchIds.has(JSON.stringify(r)))
      tables.set(table, remaining)
    },
  }
}

// ===================================================================
// Tests
// ===================================================================

describe('publicInfos service', () => {
  describe('listPublicInfos', () => {
    it('returns all items with pagination', async () => {
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: randomUUID(), name: 'China Mobile', country: 'CN', mcc: '460', mnc: '000', lte_bands: 'B1,B3' },
          { public_info_id: randomUUID(), name: 'AT&T', country: 'US', mcc: '310', mnc: '410', lte_bands: 'B2,B4' },
        ],
      })
      const result = await listPublicInfos({ supabase, name: null, mcc: null, mnc: null, page: 1, pageSize: 50 })
      expect(result.ok).toBe(true)
      expect(result.value.items.length).toBe(2)
      expect(result.value.total).toBe(2)
      expect(result.value.page).toBe(1)
      expect(result.value.pageSize).toBe(50)
    })

    it('defaults page=1 and pageSize=50, and caps pageSize at 100', async () => {
      const rows = Array.from({ length: 120 }, (_, i) => ({
        public_info_id: randomUUID(),
        name: `Carrier ${String(i).padStart(3, '0')}`,
        country: 'XX',
        mcc: '999',
        mnc: String(i).padStart(3, '0'),
      }))
      const supabase = createFakeSupabase({ public_infos: rows })
      const defaults = await listPublicInfos({
        supabase,
        name: null,
        mcc: null,
        mnc: null,
        page: null,
        pageSize: null,
      })
      expect(defaults.ok).toBe(true)
      expect(defaults.value.page).toBe(1)
      expect(defaults.value.pageSize).toBe(50)
      expect(defaults.value.items.length).toBe(50)

      const capped = await listPublicInfos({
        supabase,
        name: null,
        mcc: null,
        mnc: null,
        page: 1,
        pageSize: 500,
      })
      expect(capped.ok).toBe(true)
      expect(capped.value.pageSize).toBe(100)
      expect(capped.value.items.length).toBe(100)
    })

    it('filters by name with fuzzy substring (ilike), not exact match', async () => {
      const supabase = createFakeSupabase({
        public_infos: [
          {
            public_info_id: randomUUID(),
            name: 'China Mobile Communications Group Co., Ltd.',
            country: 'CN',
            mcc: '460',
            mnc: '000',
          },
          { public_info_id: randomUUID(), name: 'AT&T', country: 'US', mcc: '310', mnc: '410' },
        ],
      })
      const result = await listPublicInfos({
        supabase,
        name: 'china mobile',
        mcc: null,
        mnc: null,
        page: 1,
        pageSize: 50,
      })
      expect(result.ok).toBe(true)
      expect(result.value.items.length).toBe(1)
      expect(result.value.items[0].name).toContain('China Mobile')
    })

    it('filters by name (ilike)', async () => {
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: randomUUID(), name: 'China Mobile', country: 'CN', mcc: '460', mnc: '000' },
          { public_info_id: randomUUID(), name: 'AT&T', country: 'US', mcc: '310', mnc: '410' },
        ],
      })
      const result = await listPublicInfos({ supabase, name: 'china', mcc: null, mnc: null, page: 1, pageSize: 50 })
      expect(result.ok).toBe(true)
      expect(result.value.items.length).toBe(1)
      expect(result.value.items[0].name).toBe('China Mobile')
    })

    it('filters by mcc alone (all carriers in that country)', async () => {
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: randomUUID(), name: 'China Mobile', country: 'CN', mcc: '460', mnc: '000' },
          { public_info_id: randomUUID(), name: 'China Unicom', country: 'CN', mcc: '460', mnc: '001' },
          { public_info_id: randomUUID(), name: 'AT&T', country: 'US', mcc: '310', mnc: '410' },
        ],
      })
      const result = await listPublicInfos({ supabase, name: null, mcc: '460', mnc: null, page: 1, pageSize: 50 })
      expect(result.ok).toBe(true)
      expect(result.value.items.length).toBe(2)
      expect(result.value.items.every((i) => i.mcc === '460')).toBe(true)
    })

    it('filters by mcc+mnc pair (exact carrier)', async () => {
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: randomUUID(), name: 'China Mobile', country: 'CN', mcc: '460', mnc: '000' },
          { public_info_id: randomUUID(), name: 'AT&T', country: 'US', mcc: '310', mnc: '410' },
        ],
      })
      const result = await listPublicInfos({ supabase, name: null, mcc: '460', mnc: '000', page: 1, pageSize: 20 })
      expect(result.ok).toBe(true)
      expect(result.value.items.length).toBe(1)
      expect(result.value.items[0].mcc).toBe('460')
    })

    it('returns 400 if only mnc provided without mcc', async () => {
      const supabase = createFakeSupabase({})
      const result = await listPublicInfos({ supabase, name: null, mcc: null, mnc: '000', page: 1, pageSize: 20 })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/mnc/i)
    })
  })

  describe('createPublicInfo', () => {
    it('creates a new PLMN entry', async () => {
      const supabase = createFakeSupabase({ public_infos: [] })
      const result = await createPublicInfo({
        supabase,
        payload: { name: 'Vodafone', country: 'DE', mcc: '262', mnc: '02', lteBands: 'B1,B3,B7' },
      })
      expect(result.ok).toBe(true)
      expect(result.value.name).toBe('Vodafone')
      expect(result.value.country).toBe('DE')
      expect(result.value.mcc).toBe('262')
      expect(result.value.mnc).toBe('002')  // normalized to 3-digit
      expect(result.value.lteBands).toBe('B1,B3,B7')
    })

    it('returns 400 if name is missing', async () => {
      const supabase = createFakeSupabase({ public_infos: [] })
      const result = await createPublicInfo({
        supabase,
        payload: { country: 'DE', mcc: '262', mnc: '02' },
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
    })

    it('returns 400 if country is missing', async () => {
      const supabase = createFakeSupabase({ public_infos: [] })
      const result = await createPublicInfo({
        supabase,
        payload: { name: 'Vodafone', mcc: '262', mnc: '02' },
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.message).toMatch(/country/i)
    })

    it('returns 400 if mcc is invalid', async () => {
      const supabase = createFakeSupabase({ public_infos: [] })
      const result = await createPublicInfo({
        supabase,
        payload: { name: 'Test', country: 'XX', mcc: '26', mnc: '02' },
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
    })

    it('normalizes 2-digit mnc to 3 digits on create and detects duplicate', async () => {
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: randomUUID(), name: 'Existing', country: 'HK', mcc: '454', mnc: '002' },
        ],
      })
      const dup = await createPublicInfo({
        supabase,
        payload: { name: 'New', country: 'Hong Kong', mcc: '454', mnc: '02' },
      })
      expect(dup.ok).toBe(false)
      expect(dup.status).toBe(409)
      expect(dup.code).toBe('DUPLICATE_PLMN')
      expect(dup.message).toMatch(/mnc=002/)

      const created = await createPublicInfo({
        supabase,
        payload: { name: 'CSL', country: 'Hong Kong', mcc: '454', mnc: '03' },
      })
      expect(created.ok).toBe(true)
      expect(created.value.mnc).toBe('003')
    })

    it('returns 409 DUPLICATE_PLMN when mcc+mnc already exists (does not overwrite)', async () => {
      const id = randomUUID()
      const supabase = createFakeSupabase({
        public_infos: [
          {
            public_info_id: id,
            name: 'Existing',
            country: 'XX',
            mcc: '262',
            mnc: '002',
            lte_bands: 'B1',
            created_at: '2020-01-01T00:00:00.000Z',
          },
        ],
      })
      const result = await createPublicInfo({
        supabase,
        payload: { name: 'Vodafone', country: 'DE', mcc: '262', mnc: '02', lteBands: 'B1,B3,B7' },
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.code).toBe('DUPLICATE_PLMN')
      expect(supabase.getTable('public_infos')[0].name).toBe('Existing')
    })
  })

  describe('updatePublicInfo', () => {
    it('updates an existing entry with required fields', async () => {
      const id = randomUUID()
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: id, name: 'Vodafone', country: 'DE', mcc: '262', mnc: '002' },
        ],
      })
      const result = await updatePublicInfo({
        supabase,
        publicInfoId: id,
        payload: { name: 'Vodafone DE', country: 'DE', mcc: '262', mnc: '02', lteBands: 'B1,B20' },
      })
      expect(result.ok).toBe(true)
      expect(result.value.name).toBe('Vodafone DE')
      expect(result.value.lteBands).toBe('B1,B20')
    })

    it('returns 404 if entry does not exist', async () => {
      const supabase = createFakeSupabase({ public_infos: [] })
      const result = await updatePublicInfo({
        supabase,
        publicInfoId: randomUUID(),
        payload: { name: 'Test', country: 'XX', mcc: '001', mnc: '01' },
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })

    it('returns 400 if required fields are missing', async () => {
      const id = randomUUID()
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: id, name: 'Vodafone', country: 'DE', mcc: '262', mnc: '002' },
        ],
      })
      const result = await updatePublicInfo({
        supabase,
        publicInfoId: id,
        payload: { name: 'Only name' },
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
    })

    it('returns 400 if publicInfoId is invalid', async () => {
      const supabase = createFakeSupabase({})
      const result = await updatePublicInfo({
        supabase,
        publicInfoId: 'not-a-uuid',
        payload: { name: 'Test', country: 'XX', mcc: '001', mnc: '01' },
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
    })

    it('returns 409 DUPLICATE_PLMN when mcc+mnc belongs to another row', async () => {
      const id1 = randomUUID()
      const id2 = randomUUID()
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: id1, name: 'Vodafone', country: 'DE', mcc: '262', mnc: '002' },
          { public_info_id: id2, name: 'T-Mobile', country: 'DE', mcc: '262', mnc: '001' },
        ],
      })
      const result = await updatePublicInfo({
        supabase,
        publicInfoId: id2,
        payload: { name: 'T-Mobile', country: 'DE', mcc: '262', mnc: '002' },
      })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
      expect(result.code).toBe('DUPLICATE_PLMN')
    })

    it('normalizes 2-digit mnc on PATCH and detects duplicate against other rows', async () => {
      const id1 = randomUUID()
      const id2 = randomUUID()
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: id1, name: 'A', country: 'HK', mcc: '454', mnc: '002' },
          { public_info_id: id2, name: 'B', country: 'HK', mcc: '454', mnc: '003' },
        ],
      })
      const conflict = await updatePublicInfo({
        supabase,
        publicInfoId: id2,
        payload: { name: 'B', country: 'HK', mcc: '454', mnc: '02' },
      })
      expect(conflict.ok).toBe(false)
      expect(conflict.status).toBe(409)
      expect(conflict.code).toBe('DUPLICATE_PLMN')

      const ok = await updatePublicInfo({
        supabase,
        publicInfoId: id2,
        payload: { name: 'B updated', country: 'Hong Kong', mcc: '454', mnc: '03' },
      })
      expect(ok.ok).toBe(true)
      expect(ok.value.mnc).toBe('003')
      expect(ok.value.name).toBe('B updated')
    })

    it('allows keeping the same mcc+mnc on the same publicInfoId', async () => {
      const id = randomUUID()
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: id, name: 'Vodafone', country: 'DE', mcc: '262', mnc: '002' },
        ],
      })
      const result = await updatePublicInfo({
        supabase,
        publicInfoId: id,
        payload: { name: 'Vodafone GmbH', country: 'Germany', mcc: '262', mnc: '002' },
      })
      expect(result.ok).toBe(true)
      expect(result.value.name).toBe('Vodafone GmbH')
      expect(result.value.country).toBe('Germany')
    })
  })

  describe('deletePublicInfo', () => {
    it('deletes an existing entry', async () => {
      const id = randomUUID()
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: id, name: 'Vodafone', mcc: '262', mnc: '002' },
        ],
      })
      const result = await deletePublicInfo({ supabase, publicInfoId: id })
      expect(result.ok).toBe(true)
      expect(result.value.deleted).toBe(true)
      // Verify it was removed
      const remaining = supabase.getTable('public_infos')
      expect(remaining.length).toBe(0)
    })

    it('returns 404 if entry does not exist', async () => {
      const supabase = createFakeSupabase({ public_infos: [] })
      const result = await deletePublicInfo({ supabase, publicInfoId: randomUUID() })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })

    it('returns 400 if publicInfoId is invalid', async () => {
      const supabase = createFakeSupabase({})
      const result = await deletePublicInfo({ supabase, publicInfoId: 'not-a-uuid' })
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
    })
  })

  describe('combined name + mcc+mnc filters', () => {
    it('filters by name AND mcc+mnc together', async () => {
      const supabase = createFakeSupabase({
        public_infos: [
          { public_info_id: randomUUID(), name: 'China Mobile', country: 'CN', mcc: '460', mnc: '000' },
          { public_info_id: randomUUID(), name: 'China Unicom', country: 'CN', mcc: '460', mnc: '001' },
          { public_info_id: randomUUID(), name: 'AT&T', country: 'US', mcc: '310', mnc: '410' },
        ],
      })
      const result = await listPublicInfos({ supabase, name: 'China', mcc: '460', mnc: '000', page: 1, pageSize: 20 })
      expect(result.ok).toBe(true)
      expect(result.value.items.length).toBe(1)
      expect(result.value.items[0].name).toBe('China Mobile')
    })
  })
})
