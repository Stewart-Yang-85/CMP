import { describe, expect, it } from 'vitest'
import {
  createAlertConfigProfile,
  createAlertConfigProfileWithItems,
  putAlertConfigItem,
  replaceAlertConfigProfileWithItems,
  resolveEffectiveAlertConfigProfile,
} from '../src/services/alertConfigProfile.ts'

const resellerId = 'aaaaaaaa-0000-4000-8000-111111111111'
const enterpriseId = 'bbbbbbbb-0000-4000-8000-222222222222'
const platformProfileId = '10000000-0000-4000-8000-000000000001'
const resellerProfileId = '10000000-0000-4000-8000-000000000002'
const enterpriseProfileId = '10000000-0000-4000-8000-000000000003'

function parseEq(queryString: string, field: string): string | null {
  const match = queryString.match(new RegExp(`(?:^|&)${field}=eq\\.([^&]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function hasNullFilter(queryString: string, field: string) {
  return queryString.includes(`${field}=is.null`)
}

function parseScopeContains(queryString: string): string | null {
  const match = queryString.match(/allowed_scope_types=cs\.\{([^}]+)\}/)
  return match ? decodeURIComponent(match[1]) : null
}

function createFakeSupabase(seed: Record<string, Record<string, unknown>[]>, options: { rpcError?: Error } = {}) {
  const tables = new Map<string, Record<string, unknown>[]>()
  const calls: Array<{ type: string; table?: string; functionName?: string; args?: Record<string, unknown> }> = []
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((row) => ({ ...row })))
  }
  const getTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name) as Record<string, unknown>[]
  }
  return {
    getTable,
    calls,
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
      if (table === 'alert_type_catalog') {
        const alertType = parseEq(queryString, 'alert_type')
        const scopeType = parseScopeContains(queryString)
        const enabled = parseEq(queryString, 'enabled')
        return rows.filter((row) => {
          if (alertType && String(row.alert_type) !== alertType) return false
          if (enabled && String(row.enabled) !== enabled) return false
          if (scopeType && !(Array.isArray(row.allowed_scope_types) && row.allowed_scope_types.includes(scopeType))) return false
          return true
        })
      }
      if (table === 'alert_config_profiles') {
        const profileId = parseEq(queryString, 'config_profile_id')
        const scopeType = parseEq(queryString, 'scope_type')
        const status = parseEq(queryString, 'status')
        const rowResellerId = parseEq(queryString, 'reseller_id')
        const rowEnterpriseId = parseEq(queryString, 'enterprise_id')
        return rows.filter((row) => {
          if (profileId && String(row.config_profile_id) !== profileId) return false
          if (scopeType && String(row.scope_type) !== scopeType) return false
          if (status && String(row.status) !== status) return false
          if (rowResellerId && String(row.reseller_id) !== rowResellerId) return false
          if (rowEnterpriseId && String(row.enterprise_id) !== rowEnterpriseId) return false
          if (hasNullFilter(queryString, 'reseller_id') && row.reseller_id != null) return false
          if (hasNullFilter(queryString, 'enterprise_id') && row.enterprise_id != null) return false
          return true
        })
      }
      if (table === 'alert_config_items') {
        const profileId = parseEq(queryString, 'config_profile_id')
        const alertType = parseEq(queryString, 'alert_type')
        return rows.filter((row) => {
          if (profileId && String(row.config_profile_id) !== profileId) return false
          if (alertType && String(row.alert_type) !== alertType) return false
          return true
        })
      }
      return rows
    },
    async insert(table: string, row: Record<string, unknown>) {
      calls.push({ type: 'insert', table })
      const copy = {
        ...row,
        config_profile_id: row.config_profile_id ?? '90000000-0000-4000-8000-000000000001',
        config_item_id: row.config_item_id ?? '90000000-0000-4000-8000-000000000002',
      }
      getTable(table).push(copy)
      return [copy]
    },
    async update(table: string, queryString: string, patch: Record<string, unknown>) {
      calls.push({ type: 'update', table })
      const profileId = parseEq(queryString, 'config_profile_id')
      const itemId = parseEq(queryString, 'config_item_id')
      const rows = getTable(table)
      const row = rows.find((item) => {
        if (profileId) return String(item.config_profile_id) === profileId
        if (itemId) return String(item.config_item_id) === itemId
        return true
      })
      if (row) Object.assign(row, patch)
      return row ? [row] : []
    },
    async rpc(functionName: string, args?: Record<string, unknown>) {
      calls.push({ type: 'rpc', functionName, args })
      if (options.rpcError) throw options.rpcError
      const nowIso = new Date().toISOString()
      const profileId = String(args?.p_profile_id ?? '90000000-0000-4000-8000-000000000001')
      const profiles = getTable('alert_config_profiles')
      const existing = profiles.find((row) => String(row.config_profile_id) === profileId)
      if (existing) {
        Object.assign(existing, {
          status: args?.p_status,
          name: args?.p_name,
          description: args?.p_description,
          version: Number(existing.version ?? 1) + 1,
          updated_at: nowIso,
        })
      } else {
        profiles.push({
          config_profile_id: profileId,
          scope_type: args?.p_scope_type,
          reseller_id: args?.p_reseller_id,
          enterprise_id: args?.p_enterprise_id,
          status: args?.p_status,
          name: args?.p_name,
          description: args?.p_description,
          version: 1,
          created_at: nowIso,
          updated_at: nowIso,
        })
      }
      const items = getTable('alert_config_items')
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (String(items[i].config_profile_id) === profileId) items.splice(i, 1)
      }
      const payloadItems = Array.isArray(args?.p_items) ? args.p_items : []
      for (const [index, item] of payloadItems.entries()) {
        const itemPayload = item as Record<string, unknown>
        items.push({
          config_item_id: `90000000-0000-4000-8000-00000000000${index + 2}`,
          config_profile_id: profileId,
          alert_type: itemPayload.alertType,
          enabled: itemPayload.enabled,
          severity: itemPayload.severity,
          threshold_value: itemPayload.thresholdValue,
          threshold_unit: itemPayload.thresholdUnit,
          window_minutes: itemPayload.windowMinutes,
          suppress_minutes: itemPayload.suppressMinutes,
          delivery_channels: itemPayload.deliveryChannels,
          delivery_targets: itemPayload.deliveryTargets,
          threshold_config: itemPayload.thresholdConfig,
          version: 1,
          created_at: nowIso,
          updated_at: nowIso,
        })
      }
      return { profileId }
    },
  }
}

function catalogRow(alertType: string, allowedScopeTypes: string[], defaultSeverity = 'P2') {
  return {
    alert_type: alertType,
    enabled: true,
    allowed_scope_types: allowedScopeTypes,
    default_severity: defaultSeverity,
    default_threshold_value: 24,
    default_threshold_unit: 'HOURS',
    default_window_minutes: 60,
    default_suppress_minutes: 30,
    default_delivery_channels: ['PORTAL'],
    default_delivery_targets: {},
    default_threshold_config: {},
    display_name: alertType,
    sort_order: 10,
  }
}

function fullItems(overrides: Array<Record<string, unknown>> = []) {
  const base = [
    {
      alertType: 'SILENT_SIM',
      enabled: true,
      severity: 'P3',
      thresholdValue: 4320,
      thresholdUnit: 'HOURS',
      windowMinutes: 60,
      suppressMinutes: 30,
      deliveryChannels: ['PORTAL'],
      deliveryTargets: {},
      thresholdConfig: {},
    },
    {
      alertType: 'WEBHOOK_DELIVERY_FAILED',
      enabled: true,
      severity: 'P2',
      thresholdValue: 3,
      thresholdUnit: 'ATTEMPTS',
      windowMinutes: 60,
      suppressMinutes: 30,
      deliveryChannels: ['PORTAL', 'WEBHOOK'],
      deliveryTargets: {},
      thresholdConfig: {},
    },
  ]
  return base.map((item, index) => ({ ...item, ...(overrides[index] ?? {}) }))
}

describe('alert config profile ABC service', () => {
  it('rejects a second ACTIVE profile for the same reseller scope', async () => {
    const supabase = createFakeSupabase({
      tenants: [{ tenant_id: resellerId, tenant_type: 'RESELLER' }],
      alert_config_profiles: [{
        config_profile_id: resellerProfileId,
        scope_type: 'RESELLER',
        reseller_id: resellerId,
        enterprise_id: null,
        status: 'ACTIVE',
      }],
    })

    const result = await createAlertConfigProfile({
      supabase: supabase as any,
      payload: { scopeType: 'RESELLER', resellerId, status: 'ACTIVE' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('CONFLICT')
    }
  })

  it('rejects items whose alert type catalog disallows the profile scope', async () => {
    const supabase = createFakeSupabase({
      alert_type_catalog: [catalogRow('CDR_DELAY', ['PLATFORM', 'RESELLER'], 'P1')],
      alert_config_profiles: [{
        config_profile_id: enterpriseProfileId,
        scope_type: 'ENTERPRISE',
        reseller_id: resellerId,
        enterprise_id: enterpriseId,
        status: 'ACTIVE',
      }],
      alert_config_items: [],
    })

    const result = await putAlertConfigItem({
      supabase: supabase as any,
      profileId: enterpriseProfileId,
      alertType: 'CDR_DELAY',
      payload: { enabled: true },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toContain('cannot be configured at ENTERPRISE scope')
    }
  })

  it('resolves ENTERPRISE items before RESELLER and PLATFORM items', async () => {
    const supabase = createFakeSupabase({
      alert_type_catalog: [catalogRow('SILENT_SIM', ['PLATFORM', 'RESELLER', 'ENTERPRISE'], 'P3')],
      alert_config_profiles: [
        { config_profile_id: platformProfileId, scope_type: 'PLATFORM', reseller_id: null, enterprise_id: null, status: 'ACTIVE' },
        { config_profile_id: resellerProfileId, scope_type: 'RESELLER', reseller_id: resellerId, enterprise_id: null, status: 'ACTIVE' },
        { config_profile_id: enterpriseProfileId, scope_type: 'ENTERPRISE', reseller_id: resellerId, enterprise_id: enterpriseId, status: 'ACTIVE' },
      ],
      alert_config_items: [
        {
          config_item_id: '20000000-0000-4000-8000-000000000001',
          config_profile_id: platformProfileId,
          alert_type: 'SILENT_SIM',
          enabled: true,
          severity: 'P3',
          threshold_value: 24,
          threshold_unit: 'HOURS',
          suppress_minutes: 30,
          delivery_channels: ['PORTAL'],
          version: 1,
        },
        {
          config_item_id: '20000000-0000-4000-8000-000000000002',
          config_profile_id: resellerProfileId,
          alert_type: 'SILENT_SIM',
          enabled: true,
          severity: 'P2',
          threshold_value: 36,
          threshold_unit: 'HOURS',
          suppress_minutes: 45,
          delivery_channels: ['PORTAL'],
          version: 2,
        },
        {
          config_item_id: '20000000-0000-4000-8000-000000000003',
          config_profile_id: enterpriseProfileId,
          alert_type: 'SILENT_SIM',
          enabled: false,
          severity: 'P1',
          threshold_value: 48,
          threshold_unit: 'HOURS',
          suppress_minutes: 60,
          delivery_channels: ['PORTAL', 'WEBHOOK'],
          version: 3,
        },
      ],
    })

    const result = await resolveEffectiveAlertConfigProfile({
      supabase: supabase as any,
      alertType: 'SILENT_SIM',
      resellerId,
      enterpriseId,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.source).toBe('ENTERPRISE')
      expect(result.value.enabled).toBe(false)
      expect(result.value.thresholdValue).toBe(48)
      expect(result.value.version).toBe(3)
    }
  })

  it('creates a full reseller profile through one RPC write', async () => {
    const supabase = createFakeSupabase({
      tenants: [{ tenant_id: resellerId, tenant_type: 'RESELLER' }],
      alert_type_catalog: [
        catalogRow('SILENT_SIM', ['PLATFORM', 'RESELLER', 'ENTERPRISE'], 'P3'),
        catalogRow('WEBHOOK_DELIVERY_FAILED', ['PLATFORM', 'RESELLER'], 'P2'),
      ],
      alert_config_profiles: [],
      alert_config_items: [],
    })

    const result = await createAlertConfigProfileWithItems({
      supabase: supabase as any,
      payload: {
        scopeType: 'RESELLER',
        resellerId,
        status: 'ACTIVE',
        name: 'Reseller alerts',
        items: fullItems(),
      },
    })

    expect(result.ok).toBe(true)
    expect(supabase.calls.filter((call) => call.type === 'rpc')).toHaveLength(1)
    expect(supabase.calls.some((call) => call.type === 'insert' || call.type === 'update')).toBe(false)
    if (result.ok) {
      expect(result.value.scopeType).toBe('RESELLER')
      expect(result.value.items).toHaveLength(2)
    }
  })

  it('rejects missing required full-profile items before RPC', async () => {
    const supabase = createFakeSupabase({
      tenants: [{ tenant_id: resellerId, tenant_type: 'RESELLER' }],
      alert_type_catalog: [
        catalogRow('SILENT_SIM', ['PLATFORM', 'RESELLER', 'ENTERPRISE'], 'P3'),
        catalogRow('WEBHOOK_DELIVERY_FAILED', ['PLATFORM', 'RESELLER'], 'P2'),
      ],
      alert_config_profiles: [],
      alert_config_items: [],
    })

    const result = await createAlertConfigProfileWithItems({
      supabase: supabase as any,
      payload: {
        scopeType: 'RESELLER',
        resellerId,
        items: [fullItems()[0]],
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toContain('Missing: WEBHOOK_DELIVERY_FAILED')
    }
    expect(supabase.calls.some((call) => call.type === 'rpc')).toBe(false)
  })

  it('rejects excessive items that are not allowed for ENTERPRISE scope', async () => {
    const supabase = createFakeSupabase({
      tenants: [
        { tenant_id: resellerId, tenant_type: 'RESELLER' },
        { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId },
      ],
      alert_type_catalog: [
        catalogRow('SILENT_SIM', ['PLATFORM', 'RESELLER', 'ENTERPRISE'], 'P3'),
        catalogRow('WEBHOOK_DELIVERY_FAILED', ['PLATFORM', 'RESELLER'], 'P2'),
      ],
      alert_config_profiles: [],
      alert_config_items: [],
    })

    const result = await createAlertConfigProfileWithItems({
      supabase: supabase as any,
      payload: {
        scopeType: 'ENTERPRISE',
        resellerId,
        enterpriseId,
        items: fullItems(),
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toContain('WEBHOOK_DELIVERY_FAILED is not allowed')
    }
    expect(supabase.calls.some((call) => call.type === 'rpc')).toBe(false)
  })

  it('rejects invalid delivery channels for full-profile items', async () => {
    const supabase = createFakeSupabase({
      tenants: [{ tenant_id: resellerId, tenant_type: 'RESELLER' }],
      alert_type_catalog: [
        catalogRow('SILENT_SIM', ['PLATFORM', 'RESELLER', 'ENTERPRISE'], 'P3'),
        catalogRow('WEBHOOK_DELIVERY_FAILED', ['PLATFORM', 'RESELLER'], 'P2'),
      ],
      alert_config_profiles: [],
      alert_config_items: [],
    })

    const result = await createAlertConfigProfileWithItems({
      supabase: supabase as any,
      payload: {
        scopeType: 'RESELLER',
        resellerId,
        items: fullItems([{ deliveryChannels: ['EMAIL'] }]),
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toContain('deliveryChannels must contain only: PORTAL, WEBHOOK')
    }
    expect(supabase.calls.some((call) => call.type === 'rpc')).toBe(false)
  })

  it('rejects replacing a profile with a different scope identity', async () => {
    const supabase = createFakeSupabase({
      tenants: [
        { tenant_id: resellerId, tenant_type: 'RESELLER' },
        { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId },
      ],
      alert_type_catalog: [
        catalogRow('SILENT_SIM', ['PLATFORM', 'RESELLER', 'ENTERPRISE'], 'P3'),
      ],
      alert_config_profiles: [{
        config_profile_id: resellerProfileId,
        scope_type: 'RESELLER',
        reseller_id: resellerId,
        enterprise_id: null,
        status: 'ACTIVE',
        version: 1,
      }],
      alert_config_items: [],
    })

    const result = await replaceAlertConfigProfileWithItems({
      supabase: supabase as any,
      profileId: resellerProfileId,
      payload: {
        scopeType: 'ENTERPRISE',
        resellerId,
        enterpriseId,
        items: [fullItems()[0]],
      },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.message).toContain('must match the existing profile')
    }
    expect(supabase.calls.some((call) => call.type === 'rpc')).toBe(false)
  })

  it('relies on RPC transaction semantics when full-profile write fails', async () => {
    const supabase = createFakeSupabase({
      tenants: [{ tenant_id: resellerId, tenant_type: 'RESELLER' }],
      alert_type_catalog: [
        catalogRow('SILENT_SIM', ['PLATFORM', 'RESELLER', 'ENTERPRISE'], 'P3'),
        catalogRow('WEBHOOK_DELIVERY_FAILED', ['PLATFORM', 'RESELLER'], 'P2'),
      ],
      alert_config_profiles: [],
      alert_config_items: [],
    }, { rpcError: new Error('rpc failed') })

    await expect(createAlertConfigProfileWithItems({
      supabase: supabase as any,
      payload: {
        scopeType: 'RESELLER',
        resellerId,
        items: fullItems(),
      },
    })).rejects.toThrow('rpc failed')

    expect(supabase.calls.filter((call) => call.type === 'rpc')).toHaveLength(1)
    expect(supabase.calls.some((call) => call.type === 'insert' || call.type === 'update')).toBe(false)
    expect(supabase.getTable('alert_config_profiles')).toHaveLength(0)
    expect(supabase.getTable('alert_config_items')).toHaveLength(0)
  })
})
