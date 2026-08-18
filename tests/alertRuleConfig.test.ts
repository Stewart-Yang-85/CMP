import { describe, expect, it } from 'vitest'
import {
  resolveEffectiveAlertRuleConfig,
  upsertAlertRuleConfig,
} from '../src/services/alertRuleConfig.js'

function parseEq(queryString: string, field: string): string | null {
  const match = queryString.match(new RegExp(`(?:^|&)${field}=eq\\.([^&]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function hasNullFilter(queryString: string, field: string) {
  return queryString.includes(`${field}=is.null`)
}

function createFakeSupabase(seed: Record<string, Record<string, unknown>[]>) {
  const tables = new Map<string, Record<string, unknown>[]>()
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((row) => ({ ...row })))
  }
  const getTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name) as Record<string, unknown>[]
  }
  return {
    getTable,
    async select(table: string, queryString: string) {
      const rows = getTable(table)
      if (table === 'tenants') {
        const tenantId = parseEq(queryString, 'tenant_id')
        const tenantType = parseEq(queryString, 'tenant_type')
        return rows.filter((row) => {
          if (tenantId && String(row.tenant_id) !== tenantId) return false
          if (tenantType && String(row.tenant_type) !== tenantType) return false
          return true
        })
      }
      if (table === 'alert_rule_configs') {
        const scopeType = parseEq(queryString, 'scope_type')
        const alertType = parseEq(queryString, 'alert_type')
        const resellerId = parseEq(queryString, 'reseller_id')
        const enterpriseId = parseEq(queryString, 'enterprise_id')
        return rows.filter((row) => {
          if (scopeType && String(row.scope_type) !== scopeType) return false
          if (alertType && String(row.alert_type) !== alertType) return false
          if (resellerId && String(row.reseller_id) !== resellerId) return false
          if (enterpriseId && String(row.enterprise_id) !== enterpriseId) return false
          if (hasNullFilter(queryString, 'reseller_id') && row.reseller_id != null) return false
          if (hasNullFilter(queryString, 'enterprise_id') && row.enterprise_id != null) return false
          return true
        })
      }
      return rows
    },
    async insert(table: string, row: Record<string, unknown>) {
      const copy = { ...row, config_id: row.config_id ?? 'cfg-new' }
      getTable(table).push(copy)
      return [copy]
    },
    async update(table: string, queryString: string, patch: Record<string, unknown>) {
      const configId = parseEq(queryString, 'config_id')
      const rows = getTable(table)
      const row = rows.find((item) => !configId || String(item.config_id) === configId)
      if (row) Object.assign(row, patch)
      return row ? [row] : []
    },
  }
}

describe('alert rule config service', () => {
  const resellerId = 'aaaaaaaa-0000-0000-0000-111111111111'
  const enterpriseId = 'bbbbbbbb-0000-0000-0000-222222222222'

  it('resolves enterprise config before reseller and platform configs', async () => {
    const supabase = createFakeSupabase({
      alert_rule_configs: [
        {
          config_id: 'cfg-platform',
          scope_type: 'PLATFORM',
          reseller_id: null,
          enterprise_id: null,
          alert_type: 'POOL_USAGE_HIGH',
          enabled: true,
          severity: 'P2',
          threshold_value: 80,
          threshold_unit: 'PERCENT',
          suppress_minutes: 30,
          delivery_channels: ['PORTAL'],
          version: 1,
        },
        {
          config_id: 'cfg-reseller',
          scope_type: 'RESELLER',
          reseller_id: resellerId,
          enterprise_id: null,
          alert_type: 'POOL_USAGE_HIGH',
          enabled: true,
          severity: 'P1',
          threshold_value: 75,
          threshold_unit: 'PERCENT',
          suppress_minutes: 30,
          delivery_channels: ['PORTAL'],
          version: 2,
        },
        {
          config_id: 'cfg-enterprise',
          scope_type: 'ENTERPRISE',
          reseller_id: resellerId,
          enterprise_id: enterpriseId,
          alert_type: 'POOL_USAGE_HIGH',
          enabled: false,
          severity: 'P3',
          threshold_value: 90,
          threshold_unit: 'PERCENT',
          suppress_minutes: 60,
          delivery_channels: ['PORTAL'],
          version: 3,
        },
      ],
    })

    const result = await resolveEffectiveAlertRuleConfig({
      supabase: supabase as any,
      alertType: 'POOL_USAGE_HIGH',
      resellerId,
      enterpriseId,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.configId).toBe('cfg-enterprise')
      expect(result.value.enabled).toBe(false)
      expect(result.value.version).toBe(3)
    }
  })

  it('validates enterprise configs belong to the reseller', async () => {
    const supabase = createFakeSupabase({
      tenants: [
        { tenant_id: resellerId, tenant_type: 'RESELLER' },
        { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: 'cccccccc-0000-0000-0000-333333333333' },
      ],
      alert_rule_configs: [],
    })

    const result = await upsertAlertRuleConfig({
      supabase: supabase as any,
      payload: {
        scopeType: 'ENTERPRISE',
        resellerId,
        enterpriseId,
        alertType: 'SILENT_SIM',
        enabled: true,
        severity: 'P3',
        thresholdValue: 24,
        thresholdUnit: 'HOURS',
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.code).toBe('FORBIDDEN')
    }
  })
})
