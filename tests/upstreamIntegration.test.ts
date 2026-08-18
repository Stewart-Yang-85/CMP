import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  byteaToPostgresHex,
  decryptIntegrationSecret,
  encryptIntegrationSecret,
} from '../src/services/integrationSecretCrypto.js'
import {
  createUpstreamIntegration,
  deleteUpstreamIntegration,
  getUpstreamIntegration,
  listUpstreamIntegrations,
  resolveEffectiveAuthType,
  updateUpstreamIntegration,
} from '../src/services/upstreamIntegration.js'
import { createSupplierAdapterFromIntegration } from '../src/vendors/registry.js'

function parseEqFilter(queryString: string, field: string): string | null {
  const re = new RegExp(`(?:^|[&])${field}=eq\\.([^&]+)`)
  const m = queryString.match(re)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

function createFakeSupabase(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables = new Map<string, Record<string, unknown>[]>()
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((r) => ({ ...r })))
  }
  const getTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name) as Record<string, unknown>[]
  }
  return {
    getTable,
    async select(table: string, queryString: string) {
      const rows = getTable(table)
      if (table === 'suppliers') {
        const sup = parseEqFilter(queryString, 'supplier_id')
        return rows.filter((r) => !sup || String(r.supplier_id) === sup)
      }
      if (table === 'operators') {
        const sup = parseEqFilter(queryString, 'supplier_id')
        const op = parseEqFilter(queryString, 'operator_id')
        const bo = parseEqFilter(queryString, 'business_operator_id')
        return rows.filter((r) => {
          if (sup && String(r.supplier_id) !== sup) return false
          if (op && String(r.operator_id) !== op) return false
          if (bo && String(r.business_operator_id) !== bo) return false
          return true
        })
      }
      if (table === 'reseller_suppliers') {
        const resellerId = parseEqFilter(queryString, 'reseller_id')
        const supplierId = parseEqFilter(queryString, 'supplier_id')
        return rows.filter((r) => {
          if (resellerId && String(r.reseller_id) !== resellerId) return false
          if (supplierId && String(r.supplier_id) !== supplierId) return false
          return true
        })
      }
      if (table === 'upstream_integrations') {
        const intMatch = parseEqFilter(queryString, 'integration_id')
        const resellerMatch = parseEqFilter(queryString, 'reseller_id')
        const supMatch = parseEqFilter(queryString, 'supplier_id')
        const opMatch = parseEqFilter(queryString, 'operator_id')
        const statusInMatch = queryString.match(/status=in\.\(([^)]+)\)/)
        const statusIn = statusInMatch
          ? statusInMatch[1].split(',').map((s) => decodeURIComponent(s).trim().toUpperCase())
          : null
        const statusEq = parseEqFilter(queryString, 'status')?.toUpperCase() ?? null
        return rows.filter((r) => {
          if (intMatch && String(r.integration_id) !== intMatch) return false
          if (resellerMatch && String(r.reseller_id) !== resellerMatch) return false
          if (supMatch && String(r.supplier_id) !== supMatch) return false
          if (opMatch && String(r.operator_id) !== opMatch) return false
          const rowStatus = String(r.status ?? '').toUpperCase()
          if (statusEq && rowStatus !== statusEq) return false
          if (statusIn && !statusIn.includes(rowStatus)) return false
          return true
        })
      }
      return rows
    },
    async selectWithCount(table: string, queryString: string) {
      const data = await this.select(table, queryString)
      return { data, total: data.length }
    },
    async insert(table: string, row: Record<string, unknown>) {
      const copy = {
        ...row,
        integration_id: row.integration_id ?? randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      getTable(table).push(copy)
      return [copy]
    },
    async update(table: string, _match: string, patch: Record<string, unknown>) {
      const rows = getTable(table)
      Object.assign(rows[0] ?? {}, patch)
      return rows.slice(0, 1)
    },
    async delete(table: string) {
      tables.set(table, [])
      return null
    },
  }
}

function seedSupplierOperator(
  supplierId: string,
  operatorRowId: string,
  businessOperatorId: string,
  resellerId?: string
) {
  const rid = resellerId ?? randomUUID()
  return {
    resellerId: rid,
    tables: {
      suppliers: [{ supplier_id: supplierId, name: 'Test supplier' }],
      operators: [{ operator_id: operatorRowId, supplier_id: supplierId, business_operator_id: businessOperatorId }],
      reseller_suppliers: [{ reseller_id: rid, supplier_id: supplierId, created_at: '2026-01-01T00:00:00Z' }],
    },
  }
}

describe('upstream integration Phase 37', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_SECRET_KEY = 'test-integration-secret-key-32chars!!'
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, savedEnv)
  })

  it('encrypts and decrypts integration secrets', () => {
    const enc = encryptIntegrationSecret('top-secret')
    expect(enc.length).toBeGreaterThan(20)
    const hex = byteaToPostgresHex(enc)
    expect(decryptIntegrationSecret(hex)).toBe('top-secret')
  })

  it('parseEqFilter reads PostgREST eq filters', () => {
    const id = randomUUID()
    const qs = `select=operator_id,supplier_id,business_operator_id&business_operator_id=eq.${encodeURIComponent(id)}&limit=1`
    expect(parseEqFilter(qs, 'business_operator_id')).toBe(id)
    expect(parseEqFilter(qs, 'operator_id')).toBeNull()
  })

  const validCreatePayload = (resellerId: string, supplierId: string, businessOperatorId: string) => ({
    resellerId,
    supplierId,
    operatorId: businessOperatorId,
    adapterType: 'wxzhonggeng',
    name: 'Test upstream',
    apiEndpoint: 'https://upstream.example.com',
    apiKey: 'key-id',
    apiSecret: 'secret-value',
    webhookKey: 'whsec-test',
  })

  it('resolveEffectiveAuthType prefers api_key when both credential sets exist', () => {
    expect(
      resolveEffectiveAuthType({
        apiKey: 'k',
        apiSecret: 's',
        username: 'u',
        password: 'p',
      }).ok
    ).toBe(true)
    if (!resolveEffectiveAuthType({ apiKey: 'k', apiSecret: 's', username: 'u', password: 'p' }).ok) return
    expect(
      resolveEffectiveAuthType({ apiKey: 'k', apiSecret: 's', username: 'u', password: 'p' }).value
    ).toBe('api_key')
    expect(resolveEffectiveAuthType({ username: 'u', password: 'p' }).value).toBe('username_password')
    expect(resolveEffectiveAuthType({ apiKey: null, apiSecret: null, username: null, password: null }).ok).toBe(
      false
    )
  })

  it('rejects create when name is null or empty', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const seed = seedSupplierOperator(supplierId, operatorRowId, businessOperatorId)
    const supabase = createFakeSupabase(seed.tables)
    for (const name of [null, '', '   ']) {
      const result = await createUpstreamIntegration({
        supabase,
        payload: { ...validCreatePayload(seed.resellerId, supplierId, businessOperatorId), name },
      })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.status).toBe(400)
      expect(result.code).toBe('BAD_REQUEST')
    }
  })

  it('rejects create when integration credentials or authType are invalid', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const seed = seedSupplierOperator(supplierId, operatorRowId, businessOperatorId)
    const supabase = createFakeSupabase(seed.tables)
    const base = validCreatePayload(seed.resellerId, supplierId, businessOperatorId)
    const minimal = {
      resellerId: seed.resellerId,
      supplierId,
      operatorId: businessOperatorId,
      adapterType: 'wxzhonggeng',
      name: 'Test upstream',
      apiEndpoint: 'https://upstream.example.com',
      webhookKey: 'whsec-test',
    }
    const cases: Record<string, unknown>[] = [
      { ...base, apiEndpoint: null },
      { ...base, apiEndpoint: '' },
      { ...base, apiEndpoint: 'not-a-url' },
      { ...base, apiKey: null },
      { ...base, apiKey: '  ' },
      { ...base, apiSecret: '' },
      { ...base, webhookKey: null },
      { ...minimal },
      { ...minimal, apiKey: 'only-key' },
      { ...base, authType: 'oauth2' },
      { ...base, authType: 'bearer' },
      {
        ...minimal,
        apiKey: 'k',
        apiSecret: 's',
        username: 'u',
        password: 'p',
        authType: 'username_password',
      },
    ]
    for (const patch of cases) {
      const result = await createUpstreamIntegration({ supabase, payload: patch })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.status).toBe(400)
      expect(result.code).toBe('BAD_REQUEST')
    }
  })

  it('rejects create when supplier is not bound to reseller', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const resellerId = randomUUID()
    const supabase = createFakeSupabase(seedSupplierOperator(supplierId, operatorRowId, businessOperatorId).tables)
    const result = await createUpstreamIntegration({
      supabase,
      payload: validCreatePayload(resellerId, supplierId, businessOperatorId),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.code).toBe('SUPPLIER_NOT_BOUND')
  })

  it('rejects list when resellerId and supplierId are not bound', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const otherResellerId = randomUUID()
    const seed = seedSupplierOperator(supplierId, operatorRowId, businessOperatorId)
    const supabase = createFakeSupabase(seed.tables)
    const result = await listUpstreamIntegrations({
      supabase,
      resellerId: otherResellerId,
      supplierId,
      page: 1,
      pageSize: 20,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.code).toBe('SUPPLIER_NOT_BOUND')
  })

  it('creates upstream integration with both credential sets and prefers api_key', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const seed = seedSupplierOperator(supplierId, operatorRowId, businessOperatorId)
    const supabase = createFakeSupabase(seed.tables)
    const created = await createUpstreamIntegration({
      supabase,
      payload: {
        ...validCreatePayload(seed.resellerId, supplierId, businessOperatorId),
        username: 'backup-user',
        password: 'backup-pass',
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.authType).toBe('api_key')
    const row = supabase.getTable('upstream_integrations')[0]
    expect(row.api_key).toBe('key-id')
    expect(row.username).toBe('backup-user')
    expect(row.password_encrypted).toBeTruthy()
  })

  it('creates upstream integration with username_password auth', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const seed = seedSupplierOperator(supplierId, operatorRowId, businessOperatorId)
    const supabase = createFakeSupabase(seed.tables)
    const created = await createUpstreamIntegration({
      supabase,
      payload: {
        resellerId: seed.resellerId,
        supplierId,
        operatorId: businessOperatorId,
        adapterType: 'wxzhonggeng',
        name: 'User/pass upstream',
        apiEndpoint: 'https://upstream.example.com',
        webhookKey: 'whsec-test',
        username: 'cmp-user',
        password: 'cmp-pass',
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.authType).toBe('username_password')
    expect(created.value.username).toBe('cmp-user')
    expect(created.value.hasPassword).toBe(true)
    expect(created.value.apiKey).toBeFalsy()

    const row = supabase.getTable('upstream_integrations')[0]
    expect(row.username).toBe('cmp-user')
    expect(row.password_encrypted).toBeTruthy()
    expect(row.api_key).toBeFalsy()
  })

  it('creates upstream integration without exposing secrets in GET', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const seed = seedSupplierOperator(supplierId, operatorRowId, businessOperatorId)
    const supabase = createFakeSupabase(seed.tables)
    const created = await createUpstreamIntegration({
      supabase,
      payload: validCreatePayload(seed.resellerId, supplierId, businessOperatorId),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.hasApiSecret).toBe(true)
    expect(created.value.hasWebhookKey).toBe(true)
    expect((created.value as any).apiSecret).toBeUndefined()

    const listed = await listUpstreamIntegrations({ supabase, supplierId })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.items[0]?.operatorId).toBe(businessOperatorId)

    const got = await getUpstreamIntegration({ supabase, integrationId: String(created.value.integrationId) })
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect((got.value as any).apiSecret).toBeUndefined()
  })

  it('builds wxzhonggeng adapter from integration runtime config', () => {
    const adapter = createSupplierAdapterFromIntegration({
      integrationId: randomUUID(),
      supplierId: randomUUID(),
      operatorId: randomUUID(),
      adapterType: 'wxzhonggeng',
      apiEndpoint: 'https://upstream.example.com',
      apiKey: 'k',
      apiSecret: 's',
      username: null,
      password: null,
      webhookKey: 'w',
      authType: 'api_key',
      tokenUrl: null,
      enabled: true,
      config: {},
    })
    expect(adapter.supplierKey).toBe('wxzhonggeng')
    expect(adapter.capabilities).toBeTruthy()
  })

  it('soft-deletes integration as DEPRECATED and hides it from list', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const seed = seedSupplierOperator(supplierId, operatorRowId, businessOperatorId)
    const supabase = createFakeSupabase(seed.tables)
    const created = await createUpstreamIntegration({
      supabase,
      payload: { ...validCreatePayload(seed.resellerId, supplierId, businessOperatorId), name: 'Soft delete test' },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const integrationId = String(created.value.integrationId)
    const deleted = await deleteUpstreamIntegration({
      supabase,
      integrationId,
      payload: { deprecationReason: 'Rotated credentials', deprecatedBy: 'platform-admin-1' },
      actorId: 'jwt-sub-fallback',
    })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.deprecationReason).toBe('Rotated credentials')
    expect(deleted.value.deprecatedBy).toBe('platform-admin-1')

    const row = supabase.getTable('upstream_integrations')[0]
    expect(String(row.status)).toBe('DEPRECATED')
    expect(row.enabled).toBe(false)
    expect(row.deprecated_at).toBeTruthy()
    expect(row.deprecated_by).toBe('platform-admin-1')
    expect(row.deprecation_reason).toBe('Rotated credentials')

    const listed = await listUpstreamIntegrations({ supabase, supplierId })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.items).toHaveLength(0)

    const patched = await updateUpstreamIntegration({
      supabase,
      integrationId,
      payload: { name: 'Should not apply', enabled: true },
    })
    expect(patched.ok).toBe(false)
    if (patched.ok) return
    expect(patched.status).toBe(409)
    expect(patched.code).toBe('INVALID_STATUS')

    const deletedAgain = await deleteUpstreamIntegration({ supabase, integrationId })
    expect(deletedAgain.ok).toBe(false)
    if (deletedAgain.ok) return
    expect(deletedAgain.status).toBe(409)
  })

  it('returns 404 when list filter supplierId does not exist', async () => {
    const supplierId = randomUUID()
    const missingSupplierId = randomUUID()
    const supabase = createFakeSupabase({
      suppliers: [{ supplier_id: supplierId, name: 'Known supplier' }],
    })
    const result = await listUpstreamIntegrations({ supabase, supplierId: missingSupplierId })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(result.code).toBe('SUPPLIER_NOT_FOUND')
  })

  it('lists integrations filtered by status with pagination defaults', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const supabase = createFakeSupabase({
      ...seedSupplierOperator(supplierId, operatorRowId, businessOperatorId).tables,
      upstream_integrations: [
        {
          integration_id: randomUUID(),
          supplier_id: supplierId,
          operator_id: operatorRowId,
          name: 'Active',
          status: 'ACTIVE',
          enabled: true,
          config: {},
        },
        {
          integration_id: randomUUID(),
          supplier_id: supplierId,
          operator_id: randomUUID(),
          name: 'Deprecated',
          status: 'DEPRECATED',
          enabled: false,
          config: {},
        },
      ],
    })
    const defaultList = await listUpstreamIntegrations({ supabase, supplierId, page: 1, pageSize: 20 })
    expect(defaultList.ok).toBe(true)
    if (!defaultList.ok) return
    expect(defaultList.value.items).toHaveLength(1)
    expect(defaultList.value.page).toBe(1)
    expect(defaultList.value.pageSize).toBe(20)

    const deprecatedList = await listUpstreamIntegrations({
      supabase,
      supplierId,
      status: 'DEPRECATED',
      page: 1,
      pageSize: 20,
    })
    expect(deprecatedList.ok).toBe(true)
    if (!deprecatedList.ok) return
    expect(deprecatedList.value.items).toHaveLength(1)
    expect((deprecatedList.value.items[0] as any).status).toBe('DEPRECATED')
  })

  it('defaults deprecatedBy from actorId when omitted on delete', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const seed = seedSupplierOperator(supplierId, operatorRowId, businessOperatorId)
    const supabase = createFakeSupabase(seed.tables)
    const created = await createUpstreamIntegration({
      supabase,
      payload: validCreatePayload(seed.resellerId, supplierId, businessOperatorId),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const deleted = await deleteUpstreamIntegration({
      supabase,
      integrationId: String(created.value.integrationId),
      payload: { deprecationReason: 'EOL' },
      actorId: 'cmp-admin',
    })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.value.deprecatedBy).toBe('cmp-admin')
    expect(supabase.getTable('upstream_integrations')[0].deprecated_by).toBe('cmp-admin')
  })
})
