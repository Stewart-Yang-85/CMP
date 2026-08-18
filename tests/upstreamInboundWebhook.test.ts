import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  applyIntegrationWebhookSubscriptions,
  isInboundWebhookSubscribed,
  listInboundWebhookEventsForApi,
  listIntegrationSubscriptions,
} from '../src/services/inboundWebhookCatalog.js'
import { validateInboundWebhookGate } from '../src/services/inboundWebhookGate.js'
import { adapterSupportsInboundEvent } from '../src/vendors/inboundWebhookCapabilities.js'
import {
  byteaToPostgresHex,
  encryptIntegrationSecret,
} from '../src/services/integrationSecretCrypto.js'
import { createUpstreamIntegration } from '../src/services/upstreamIntegration.js'

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
  const catalogEvents = [
    { event_key: 'subscription', display_name: 'Subscription', description: null, status: 'ACTIVE', sort_order: 10 },
    { event_key: 'update-location', display_name: 'Update Location', description: null, status: 'ACTIVE', sort_order: 20 },
    { event_key: 'sim-status-changed', display_name: 'SIM status changed', description: null, status: 'ACTIVE', sort_order: 30 },
    { event_key: 'traffic-alert', display_name: 'Traffic alert', description: null, status: 'ACTIVE', sort_order: 40 },
  ]
  if (!tables.has('upstream_inbound_webhook_events')) {
    tables.set('upstream_inbound_webhook_events', catalogEvents.map((r) => ({ ...r })))
  }
  const getTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name) as Record<string, unknown>[]
  }
  return {
    getTable,
    async select(table: string, queryString: string) {
      const rows = getTable(table)
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
        const supMatch = parseEqFilter(queryString, 'supplier_id')
        const opMatch = parseEqFilter(queryString, 'operator_id')
        return rows.filter((r) => {
          if (intMatch && String(r.integration_id) !== intMatch) return false
          if (supMatch && String(r.supplier_id) !== supMatch) return false
          if (opMatch && String(r.operator_id) !== opMatch) return false
          return true
        })
      }
      if (table === 'upstream_inbound_webhook_events') {
        const key = parseEqFilter(queryString, 'event_key')
        if (key) return rows.filter((r) => String(r.event_key) === key)
        return rows
      }
      if (table === 'upstream_integration_webhook_subscriptions') {
        const intId = parseEqFilter(queryString, 'integration_id')
        const eventKey = parseEqFilter(queryString, 'event_key')
        const enabledEq = queryString.includes('enabled=eq.true')
        return rows.filter((r) => {
          if (intId && String(r.integration_id) !== intId) return false
          if (eventKey && String(r.event_key) !== eventKey) return false
          if (enabledEq && r.enabled !== true) return false
          return true
        })
      }
      if (table === 'business_operators') {
        const id = parseEqFilter(queryString, 'operator_id')
        if (id) return rows.filter((r) => String(r.operator_id) === id)
      }
      return rows
    },
    async insert(table: string, row: Record<string, unknown>) {
      const copy = { ...row }
      if (table === 'upstream_integrations') {
        copy.integration_id = copy.integration_id ?? randomUUID()
        copy.created_at = new Date().toISOString()
        copy.updated_at = new Date().toISOString()
      }
      if (table === 'upstream_integration_webhook_subscriptions') {
        copy.updated_at = new Date().toISOString()
        copy.created_at = copy.created_at ?? new Date().toISOString()
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

describe('upstream inbound webhook Phase 38', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    process.env.INTEGRATION_SECRET_KEY = 'test-integration-secret-key-32chars!!'
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, savedEnv)
  })

  it('lists catalog filtered by adapterType', async () => {
    const supabase = createFakeSupabase()
    const result = await listInboundWebhookEventsForApi(supabase, 'wxzhonggeng')
    expect(result.items.length).toBe(4)
    expect(result.adapterCapabilities).toContain('update-location')
  })

  it('adapterSupportsInboundEvent for wxzhonggeng', () => {
    expect(adapterSupportsInboundEvent('wxzhonggeng', 'update-location')).toBe(true)
    expect(adapterSupportsInboundEvent('wxzhonggeng', 'cdr-file-ready')).toBe(false)
  })

  it('creates integration with no subscriptions by default', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const businessOperatorId = randomUUID()
    const resellerId = randomUUID()
    const supabase = createFakeSupabase({
      operators: [{ operator_id: operatorRowId, supplier_id: supplierId, business_operator_id: businessOperatorId }],
      reseller_suppliers: [{ reseller_id: resellerId, supplier_id: supplierId }],
    })
    const created = await createUpstreamIntegration({
      supabase,
      payload: {
        resellerId,
        supplierId,
        operatorId: businessOperatorId,
        adapterType: 'wxzhonggeng',
        name: 'Inbound webhook test',
        apiEndpoint: 'https://upstream.example.com',
        apiKey: 'key-id',
        apiSecret: 'secret-value',
        webhookKey: 'whsec',
        authType: 'api_key',
      },
      baseUrl: 'http://localhost:3000',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const subs = await listIntegrationSubscriptions(supabase, String(created.value.integrationId))
    expect(subs.length).toBe(0)
    expect((created.value as any).webhookEndpoints).toEqual([])
  })

  it('rejects webhook when event not subscribed', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const integrationId = randomUUID()
    const wh = encryptIntegrationSecret('whsec-test')
    const supabase = createFakeSupabase({
      operators: [{ operator_id: operatorRowId, supplier_id: supplierId, business_operator_id: operatorRowId }],
      upstream_integrations: [
        {
          integration_id: integrationId,
          supplier_id: supplierId,
          operator_id: operatorRowId,
          adapter_type: 'wxzhonggeng',
          enabled: true,
          status: 'ACTIVE',
          webhook_key_encrypted: byteaToPostgresHex(wh),
        },
      ],
    })
    const gate = await validateInboundWebhookGate({
      supabase,
      supplierId,
      operatorId: operatorRowId,
      adapterType: 'wxzhonggeng',
      eventKey: 'update-location',
    })
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.status).toBe(403)
    expect(gate.code).toBe('WEBHOOK_EVENT_NOT_SUBSCRIBED')
  })

  it('allows webhook when subscription enabled', async () => {
    const supplierId = randomUUID()
    const operatorRowId = randomUUID()
    const integrationId = randomUUID()
    const wh = encryptIntegrationSecret('whsec-test')
    const supabase = createFakeSupabase({
      operators: [{ operator_id: operatorRowId, supplier_id: supplierId, business_operator_id: operatorRowId }],
      upstream_integrations: [
        {
          integration_id: integrationId,
          supplier_id: supplierId,
          operator_id: operatorRowId,
          adapter_type: 'wxzhonggeng',
          enabled: true,
          status: 'ACTIVE',
          webhook_key_encrypted: byteaToPostgresHex(wh),
        },
      ],
    })
    const applied = await applyIntegrationWebhookSubscriptions({
      supabase,
      integrationId,
      adapterType: 'wxzhonggeng',
      subscriptions: [{ eventKey: 'update-location', enabled: true }],
    })
    expect(applied.ok).toBe(true)
    const subscribed = await isInboundWebhookSubscribed(supabase, integrationId, 'update-location')
    expect(subscribed).toBe(true)
    const gate = await validateInboundWebhookGate({
      supabase,
      supplierId,
      operatorId: operatorRowId,
      adapterType: 'wxzhonggeng',
      eventKey: 'update-location',
    })
    expect(gate.ok).toBe(true)
    if (!gate.ok) return
    expect(gate.integration.webhookKey).toBe('whsec-test')
  })
})
