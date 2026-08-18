import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryWebhookDelivery } from '../src/services/webhook.ts'

const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'

function parseEq(queryString: string, field: string): string | null {
  const match = queryString.match(new RegExp(`(?:^|&)${field}=eq\\.([^&]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function createSupabase(ruleRows: Record<string, unknown>[]) {
  const captured: {
    alertInsert?: Record<string, unknown>
    deliveryPatch?: Record<string, unknown>
  } = {}
  const supabase = {
    async select(table: string, queryString: string) {
      if (table === 'webhook_deliveries') {
        return [{
          delivery_id: 1,
          webhook_id: 'wh-1',
          event_id: 'evt-1',
          attempt: 3,
          status: 'PENDING',
          created_at: '2026-06-18T00:00:00.000Z',
        }]
      }
      if (table === 'events') {
        return [{
          event_id: 'evt-1',
          event_type: 'ALERT_TRIGGERED',
          occurred_at: '2026-06-18T00:00:00.000Z',
          enterprise_id: enterpriseId,
          reseller_id: resellerId,
          payload: {},
        }]
      }
      if (table === 'webhook_subscriptions') {
        return [{
          webhook_id: 'wh-1',
          reseller_id: resellerId,
          enterprise_id: enterpriseId,
          url: 'https://webhook.example.test/endpoint',
          secret: 'secret',
          event_types: ['ALERT_TRIGGERED'],
          enabled: true,
          created_at: '2026-06-18T00:00:00.000Z',
          updated_at: '2026-06-18T00:00:00.000Z',
        }]
      }
      if (table === 'alert_type_catalog') {
        return [{
          alert_type: 'WEBHOOK_DELIVERY_FAILED',
          enabled: true,
          allowed_scope_types: ['PLATFORM', 'RESELLER'],
          default_severity: 'P2',
          default_threshold_value: 3,
          default_threshold_unit: 'ATTEMPTS',
          default_window_minutes: 60,
          default_suppress_minutes: 30,
          default_delivery_channels: ['PORTAL'],
          default_delivery_targets: {},
          default_threshold_config: {},
          display_name: 'Webhook delivery failed',
        }]
      }
      if (table === 'alert_config_profiles') {
        const scopeType = parseEq(queryString, 'scope_type')
        const row = ruleRows.find((item) => String(item.scope_type) === scopeType)
        if (!row) return []
        return [{
          config_profile_id: `profile-${String(scopeType).toLowerCase()}`,
          scope_type: row.scope_type,
          reseller_id: row.reseller_id,
          enterprise_id: row.enterprise_id,
          status: 'ACTIVE',
          name: `${scopeType} profile`,
          version: 1,
          created_at: '2026-06-18T00:00:00.000Z',
          updated_at: '2026-06-18T00:00:00.000Z',
        }]
      }
      if (table === 'alert_config_items') {
        const profileId = parseEq(queryString, 'config_profile_id')
        const scopeType = String(profileId || '').replace('profile-', '').toUpperCase()
        const row = ruleRows.find((item) => String(item.scope_type) === scopeType)
        if (!row) return []
        return [{
          config_item_id: row.config_id,
          config_profile_id: profileId,
          alert_type: row.alert_type,
          enabled: row.enabled,
          severity: row.severity,
          threshold_value: row.threshold_value,
          threshold_unit: row.threshold_unit,
          window_minutes: 60,
          suppress_minutes: row.suppress_minutes,
          delivery_channels: row.delivery_channels,
          delivery_targets: {},
          threshold_config: {},
          version: row.version,
          created_at: '2026-06-18T00:00:00.000Z',
          updated_at: '2026-06-18T00:00:00.000Z',
        }]
      }
      if (table === 'alerts') return []
      return []
    },
    async update(table: string, _queryString: string, patch: Record<string, unknown>) {
      if (table === 'webhook_deliveries') captured.deliveryPatch = patch
      return []
    },
    async insert(table: string, row: Record<string, unknown>) {
      if (table === 'alerts') captured.alertInsert = row
      return [{ ...row, alert_id: null }]
    },
  }
  return { supabase, captured }
}

describe('webhook delivery failed alerts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks exhausted delivery failed without creating alert when enterprise rule is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error',
    })))
    const { supabase, captured } = createSupabase([{
      config_id: 'cfg-disabled',
      scope_type: 'ENTERPRISE',
      reseller_id: resellerId,
      enterprise_id: enterpriseId,
      alert_type: 'WEBHOOK_DELIVERY_FAILED',
      enabled: false,
      severity: 'P2',
      threshold_value: 3,
      threshold_unit: 'ATTEMPTS',
      suppress_minutes: 30,
      delivery_channels: ['PORTAL'],
      version: 1,
    }])

    const result = await retryWebhookDelivery({ supabase: supabase as any, deliveryId: 1 })

    expect(result.ok).toBe(true)
    expect(result.ok && result.value.status).toBe('FAILED')
    expect(captured.deliveryPatch?.status).toBe('FAILED')
    expect(captured.alertInsert).toBeUndefined()
  })

  it('creates failed delivery alert with effective platform config', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    })))
    const { supabase, captured } = createSupabase([{
      config_id: 'cfg-platform',
      scope_type: 'PLATFORM',
      reseller_id: null,
      enterprise_id: null,
      alert_type: 'WEBHOOK_DELIVERY_FAILED',
      enabled: true,
      severity: 'P1',
      threshold_value: 5,
      threshold_unit: 'ATTEMPTS',
      suppress_minutes: 45,
      delivery_channels: ['PORTAL', 'WEBHOOK'],
      version: 2,
    }])

    const result = await retryWebhookDelivery({ supabase: supabase as any, deliveryId: 1 })

    expect(result.ok).toBe(true)
    expect(captured.deliveryPatch?.status).toBe('FAILED')
    expect(captured.alertInsert?.alert_type).toBe('WEBHOOK_DELIVERY_FAILED')
    expect(captured.alertInsert?.severity).toBe('P1')
    expect(captured.alertInsert?.threshold).toBe(5)
    expect(captured.alertInsert?.rule_id).toBe('cfg-platform')
    expect(captured.alertInsert?.rule_version).toBe(2)
    expect(captured.alertInsert?.delivery_channels).toEqual(['PORTAL', 'WEBHOOK'])
  })
})
