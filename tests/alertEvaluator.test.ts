import { describe, expect, it, vi } from 'vitest'
import { runAlertEvaluation } from '../src/services/alerting.js'

const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'

function createEvaluatorSupabase() {
  const alerts: Record<string, unknown>[] = []
  return {
    alerts,
    async select(table: string) {
      if (table === 'config_parameters') return []
      if (table === 'alert_rule_configs') return []
      if (table === 'tenants') {
        return [
          { tenant_id: resellerId, tenant_type: 'RESELLER' },
          { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId },
        ]
      }
      if (table === 'sims') {
        return [
          {
            sim_id: 'sim-usage',
            enterprise_id: enterpriseId,
            operator_id: 'op-home',
            status: 'ACTIVATED',
            activation_date: '2026-06-18T11:50:00.000Z',
            upstream_status: 'CONNECTED',
            upstream_status_updated_at: '2026-06-18T11:50:00.000Z',
          },
          {
            sim_id: 'sim-silent',
            enterprise_id: enterpriseId,
            operator_id: 'op-home',
            status: 'DEACTIVATED',
            activation_date: '2026-06-17T00:00:00.000Z',
            last_status_change_at: '2026-06-17T00:00:00.000Z',
            upstream_status: 'CONNECTED',
            upstream_status_updated_at: '2026-06-18T11:50:00.000Z',
          },
          {
            sim_id: 'sim-upstream',
            enterprise_id: enterpriseId,
            operator_id: 'op-home',
            status: 'ACTIVATED',
            activation_date: '2026-06-18T11:50:00.000Z',
            upstream_status: 'DISCONNECTED',
            upstream_status_updated_at: '2026-06-18T09:00:00.000Z',
          },
        ]
      }
      if (table === 'operators') {
        return [{ operator_id: 'op-home', business_operators: { mcc: '460', mnc: '01' } }]
      }
      if (table === 'usage_daily_summary') {
        return [{
          sim_id: 'sim-usage',
          enterprise_id: enterpriseId,
          usage_day: '2026-06-18',
          total_mb: 200,
          visited_mccmnc: '46002',
        }]
      }
      if (table === 'usage_package_daily_summary') {
        return [{
          reseller_id: resellerId,
          enterprise_id: enterpriseId,
          sim_id: 'sim-usage',
          usage_day: '2026-06-18',
          subscription_id: 'sub-usage',
          package_id: 'pkg-one-time',
          price_plan_id: 'price-one-time',
          price_plan_type: 'ONE_TIME',
          in_profile_mb: 90,
          out_of_profile_mb: 25,
        }]
      }
      if (table === 'rating_results') return []
      if (table === 'subscriptions') {
        return [{
          subscription_id: 'sub-usage',
          sim_id: 'sim-usage',
          enterprise_id: enterpriseId,
          package_id: 'pkg-one-time',
          subscription_kind: 'MAIN',
          state: 'ACTIVE',
        }]
      }
      if (table === 'packages') {
        return [{
          package_id: 'pkg-one-time',
          enterprise_id: enterpriseId,
          price_plan_id: 'price-one-time',
        }]
      }
      if (table === 'price_plans_expanded') {
        return [{
          price_plan_id: 'price-one-time',
          enterprise_id: enterpriseId,
          type: 'ONE_TIME',
          quota_mb: 100,
        }]
      }
      if (table === 'cdr_files') {
        return [{ cdr_file_id: 'cdr-1', supplier_id: 'supplier-1', operator_id: 'operator-1', received_at: '2026-06-18T09:00:00.000Z', ingested_at: null }]
      }
      if (table === 'cdr_file_sim_refs') {
        return [{
          cdr_file_id: 'cdr-1',
          iccid: '89860000000000000001',
          sim_id: 'sim-usage',
          reseller_id: resellerId,
          enterprise_id: enterpriseId,
        }]
      }
      if (table === 'upstream_integration_health_checks') {
        return [{
          integration_id: 'integration-1',
          reseller_id: resellerId,
          supplier_id: 'supplier-1',
          operator_id: 'operator-1',
          probe_type: 'TOKEN',
          status: 'DISCONNECTED',
          consecutive_failure_count: 3,
          last_success_at: '2026-06-18T06:00:00.000Z',
          last_failure_at: '2026-06-18T11:55:00.000Z',
          last_error_code: 'TOKEN_HTTP_503',
          last_error_message: 'token_http_503',
        }]
      }
      if (table === 'alerts') return []
      return []
    },
    async insert(table: string, row: Record<string, unknown>) {
      if (table === 'alerts') {
        alerts.push(row)
        return [{ ...row }]
      }
      return [{ ...row }]
    },
    async update() {
      return []
    },
    async selectWithCount() {
      return { data: [], total: 0 }
    },
  }
}

function createPoolPercentSupabase() {
  const alerts: Record<string, unknown>[] = []
  return {
    alerts,
    async select(table: string) {
      if (table === 'config_parameters') return []
      if (table === 'alert_rule_configs') return []
      if (table === 'alert_config_profiles') return []
      if (table === 'alert_config_items') return []
      if (table === 'tenants') {
        return [
          { tenant_id: resellerId, tenant_type: 'RESELLER' },
          { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId },
        ]
      }
      if (table === 'sims') {
        return [
          {
            sim_id: 'sim-pool-a',
            enterprise_id: enterpriseId,
            operator_id: 'op-home',
            status: 'ACTIVATED',
            activation_date: '2026-06-18T11:50:00.000Z',
            upstream_status: 'CONNECTED',
            upstream_status_updated_at: '2026-06-18T11:50:00.000Z',
          },
          {
            sim_id: 'sim-pool-b',
            enterprise_id: enterpriseId,
            operator_id: 'op-home',
            status: 'ACTIVATED',
            activation_date: '2026-06-18T11:50:00.000Z',
            upstream_status: 'CONNECTED',
            upstream_status_updated_at: '2026-06-18T11:50:00.000Z',
          },
        ]
      }
      if (table === 'operators') return [{ operator_id: 'op-home', business_operators: { mcc: '460', mnc: '01' } }]
      if (table === 'usage_daily_summary') return []
      if (table === 'usage_package_daily_summary') {
        return [
          {
            reseller_id: resellerId,
            enterprise_id: enterpriseId,
            sim_id: 'sim-pool-a',
            usage_day: '2026-06-18',
            subscription_id: 'sub-a',
            package_id: 'pkg-fixed',
            price_plan_id: 'price-fixed',
            price_plan_type: 'FIXED_BUNDLE',
            in_profile_mb: 160,
            out_of_profile_mb: 0,
          },
          {
            reseller_id: resellerId,
            enterprise_id: enterpriseId,
            sim_id: 'sim-pool-b',
            usage_day: '2026-06-18',
            subscription_id: 'sub-b',
            package_id: 'pkg-tiered',
            price_plan_id: 'price-tiered',
            price_plan_type: 'TIERED_VOLUME_PRICING',
            in_profile_mb: 260,
            out_of_profile_mb: 0,
          },
        ]
      }
      if (table === 'subscriptions') {
        return [
          { subscription_id: 'sub-a', sim_id: 'sim-pool-a', enterprise_id: enterpriseId, package_id: 'pkg-fixed', subscription_kind: 'MAIN', state: 'ACTIVE' },
          { subscription_id: 'sub-b', sim_id: 'sim-pool-b', enterprise_id: enterpriseId, package_id: 'pkg-fixed', subscription_kind: 'MAIN', state: 'ACTIVE' },
        ]
      }
      if (table === 'rating_results') {
        return [
          {
            sim_id: 'sim-pool-a',
            enterprise_id: enterpriseId,
            matched_package_id: 'pkg-fixed',
            matched_price_plan_id: 'price-fixed',
            classification: 'IN_PACKAGE',
            charged_mb: 160,
            usage_day: '2026-06-18',
          },
          {
            sim_id: 'sim-pool-b',
            enterprise_id: enterpriseId,
            matched_package_id: 'pkg-tiered',
            matched_price_plan_id: 'price-tiered',
            classification: 'IN_PACKAGE',
            charged_mb: 260,
            usage_day: '2026-06-18',
          },
        ]
      }
      if (table === 'packages') {
        return [
          { package_id: 'pkg-fixed', enterprise_id: enterpriseId, price_plan_id: 'price-fixed' },
          { package_id: 'pkg-tiered', enterprise_id: enterpriseId, price_plan_id: 'price-tiered' },
        ]
      }
      if (table === 'price_plans_expanded') {
        return [
          {
            price_plan_id: 'price-fixed',
            enterprise_id: enterpriseId,
            type: 'FIXED_BUNDLE',
            total_quota_mb: 200,
          },
          {
            price_plan_id: 'price-tiered',
            enterprise_id: enterpriseId,
            type: 'TIERED_VOLUME_PRICING',
            tiers: [{ toMb: 100 }, { toMb: 300 }],
          },
        ]
      }
      if (table === 'cdr_files') return []
      if (table === 'alerts') return []
      return []
    },
    async insert(table: string, row: Record<string, unknown>) {
      if (table === 'alerts') {
        alerts.push(row)
        return [{ ...row }]
      }
      return [{ ...row }]
    },
    async update() {
      return []
    },
    async selectWithCount() {
      return { data: [], total: 0 }
    },
  }
}

describe('runAlertEvaluation', () => {
  it('creates the six evaluator-driven canonical alert types', async () => {
    const supabase = createEvaluatorSupabase()

    const result = await runAlertEvaluation({
      supabase: supabase as any,
      now: '2026-06-18T12:00:00.000Z',
      options: {
        configCacheSeconds: 0,
        windowMinutes: 60,
        suppressMinutes: 0,
        poolUsageHighThresholdPercent: 80,
        outOfProfileSurgeThresholdPercent: 20,
        silentSimThresholdHours: 1,
        cdrDelayThresholdHours: 1,
        upstreamDisconnectThresholdAttempts: 3,
      },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.errors).toBe(0)
      expect(result.value.created).toBe(6)
    }
    expect(Array.from(new Set(supabase.alerts.map((row) => row.alert_type))).sort()).toEqual([
      'CDR_DELAY',
      'OUT_OF_PROFILE_SURGE',
      'POOL_USAGE_HIGH',
      'SILENT_SIM',
      'UNEXPECTED_ROAMING',
      'UPSTREAM_DISCONNECT',
    ])
    const pool = supabase.alerts.find((row) => row.alert_type === 'POOL_USAGE_HIGH')
    expect(pool?.reseller_id).toBe(resellerId)
    expect(pool?.customer_id).toBe(enterpriseId)
    expect(pool?.threshold).toBe(80)
    expect(pool?.current_value).toBe(90)
    expect((pool?.metadata as any)?.thresholdUnit).toBe('PERCENT')
    expect((pool?.metadata as any)?.quotaMb).toBe(100)
    expect((pool?.metadata as any)?.usedMb).toBe(90)
    const outProfile = supabase.alerts.find((row) => row.alert_type === 'OUT_OF_PROFILE_SURGE')
    expect(outProfile?.threshold).toBe(20)
    expect(outProfile?.current_value).toBe(25)
    expect((outProfile?.metadata as any)?.thresholdUnit).toBe('PERCENT')
    expect((outProfile?.metadata as any)?.outOfProfileMb).toBe(25)
    const silent = supabase.alerts.find((row) => row.alert_type === 'SILENT_SIM')
    expect(silent?.sim_id).toBe('sim-silent')
    expect(silent?.current_value).toBe(36)
    expect((silent?.metadata as any)?.status).toBe('DEACTIVATED')
    expect((silent?.metadata as any)?.deactivatedSince).toBe('2026-06-17T00:00:00.000Z')
    const roaming = supabase.alerts.find((row) => row.alert_type === 'UNEXPECTED_ROAMING')
    expect(roaming?.threshold).toBe(20)
    expect(roaming?.current_value).toBe(25)
    expect((roaming?.metadata as any)?.outOfProfileMb).toBe(25)
    expect((roaming?.metadata as any)?.thresholdMb).toBe(20)
    expect((roaming?.metadata as any)?.thresholdUnit).toBe('MB')
    expect((roaming?.metadata as any)?.packageIds).toEqual(['pkg-one-time'])
    expect((roaming?.metadata as any)?.visitedMccMncs).toEqual(['46002'])
    const cdr = supabase.alerts.find((row) => row.alert_type === 'CDR_DELAY')
    expect(cdr?.reseller_id).toBe(resellerId)
    expect(cdr?.customer_id).toBeNull()
    expect(cdr?.sim_id).toBeNull()
    expect(cdr?.current_value).toBe(1)
    expect((cdr?.metadata as any)?.cdrFileIds).toEqual(['cdr-1'])
    expect((cdr?.metadata as any)?.affectedIccidCount).toBe(1)
    expect((cdr?.metadata as any)?.sampleIccids).toEqual(['89860000000000000001'])
    const upstream = supabase.alerts.find((row) => row.alert_type === 'UPSTREAM_DISCONNECT')
    expect(upstream?.reseller_id).toBe(resellerId)
    expect(upstream?.customer_id).toBeNull()
    expect(upstream?.sim_id).toBeNull()
    expect(upstream?.threshold).toBe(3)
    expect(upstream?.current_value).toBe(3)
    expect((upstream?.metadata as any)?.integrationId).toBe('integration-1')
    expect((upstream?.metadata as any)?.probeApi).toBe('TOKEN')
    expect((upstream?.metadata as any)?.thresholdUnit).toBe('ATTEMPTS')
  })

  it('skips UNEXPECTED_ROAMING when out-of-profile MB is below the 20 MB default threshold', async () => {
    const supabase = createEvaluatorSupabase()
    const originalSelect = supabase.select
    supabase.select = async (table: string) => {
      if (table === 'usage_package_daily_summary') {
        return [{
          reseller_id: resellerId,
          enterprise_id: enterpriseId,
          sim_id: 'sim-usage',
          usage_day: '2026-06-18',
          subscription_id: 'sub-usage',
          package_id: 'pkg-one-time',
          price_plan_id: 'price-one-time',
          price_plan_type: 'ONE_TIME',
          in_profile_mb: 90,
          out_of_profile_mb: 10,
        }]
      }
      return originalSelect.call(supabase, table)
    }

    const result = await runAlertEvaluation({
      supabase: supabase as any,
      now: '2026-06-18T12:00:00.000Z',
      options: {
        configCacheSeconds: 0,
        windowMinutes: 60,
        suppressMinutes: 0,
        poolUsageHighThresholdPercent: 80,
        outOfProfileSurgeThresholdPercent: 20,
        silentSimThresholdHours: 1,
        cdrDelayThresholdHours: 1,
        upstreamDisconnectThresholdAttempts: 3,
      },
    })

    expect(result.ok).toBe(true)
    expect(supabase.alerts.some((row) => row.alert_type === 'UNEXPECTED_ROAMING')).toBe(false)
  })

  it('falls back to default thresholds when legacy config_parameters table is missing', async () => {
    const supabase = createEvaluatorSupabase()
    const originalSelect = supabase.select
    supabase.select = async (table: string) => {
      if (table === 'config_parameters') {
        const err = new Error("Could not find the table 'public.config_parameters' in the schema cache") as any
        err.status = 404
        err.code = 'RESOURCE_NOT_FOUND'
        err.body = {
          code: 'PGRST205',
          message: "Could not find the table 'public.config_parameters' in the schema cache",
        }
        throw err
      }
      return originalSelect.call(supabase, table)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runAlertEvaluation({
      supabase: supabase as any,
      now: '2026-06-18T12:00:00.000Z',
      options: {
        configCacheSeconds: 0,
        windowMinutes: 60,
        suppressMinutes: 0,
        poolUsageHighThresholdPercent: 80,
        outOfProfileSurgeThresholdPercent: 20,
        silentSimThresholdHours: 1,
        cdrDelayThresholdHours: 1,
        upstreamDisconnectThresholdAttempts: 3,
      },
    })

    warn.mockRestore()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.errors).toBe(0)
      expect(result.value.created).toBe(6)
    }
  })

  it('creates package pool alerts for fixed bundles and each crossed tier', async () => {
    const supabase = createPoolPercentSupabase()

    const result = await runAlertEvaluation({
      supabase: supabase as any,
      now: '2026-06-18T12:00:00.000Z',
      options: {
        configCacheSeconds: 0,
        windowMinutes: 60,
        suppressMinutes: 0,
        poolUsageHighThresholdPercent: 80,
        outOfProfileSurgeThresholdPercent: 1000000,
        silentSimThresholdHours: 999,
        cdrDelayThresholdHours: 999,
        upstreamDisconnectThresholdAttempts: 999,
      },
    })

    expect(result.ok).toBe(true)
    const poolAlerts = supabase.alerts.filter((row) => row.alert_type === 'POOL_USAGE_HIGH')
    expect(poolAlerts).toHaveLength(3)
    expect(poolAlerts.map((row) => (row.metadata as any).subjectKey).sort()).toEqual([
      'package:pkg-fixed:pool',
      'package:pkg-tiered:tier:1',
      'package:pkg-tiered:tier:2',
    ])
    const fixed = poolAlerts.find((row) => (row.metadata as any).packageId === 'pkg-fixed')
    expect(fixed?.current_value).toBe(80)
    const tierTwo = poolAlerts.find((row) => (row.metadata as any).tierIndex === 2)
    expect((tierTwo?.metadata as any).tierLimitMb).toBe(300)
  })

  it('creates out-of-profile percentage alerts by package quota and tiers', async () => {
    const supabase = createPoolPercentSupabase()
    const originalSelect = supabase.select
    supabase.select = async (table: string) => {
      if (table === 'usage_package_daily_summary') {
        return [
          {
            reseller_id: resellerId,
            enterprise_id: enterpriseId,
            sim_id: 'sim-pool-a',
            usage_day: '2026-06-18',
            subscription_id: 'sub-a',
            package_id: 'pkg-fixed',
            price_plan_id: 'price-fixed',
            price_plan_type: 'FIXED_BUNDLE',
            in_profile_mb: 0,
            out_of_profile_mb: 50,
          },
          {
            reseller_id: resellerId,
            enterprise_id: enterpriseId,
            sim_id: 'sim-pool-b',
            usage_day: '2026-06-18',
            subscription_id: 'sub-b',
            package_id: 'pkg-tiered',
            price_plan_id: 'price-tiered',
            price_plan_type: 'TIERED_VOLUME_PRICING',
            in_profile_mb: 0,
            out_of_profile_mb: 80,
          },
        ]
      }
      return originalSelect.call(supabase, table)
    }

    const result = await runAlertEvaluation({
      supabase: supabase as any,
      now: '2026-06-18T12:00:00.000Z',
      options: {
        configCacheSeconds: 0,
        windowMinutes: 60,
        suppressMinutes: 0,
        poolUsageHighThresholdPercent: 1000000,
        outOfProfileSurgeThresholdPercent: 20,
        silentSimThresholdHours: 999,
        cdrDelayThresholdHours: 999,
        upstreamDisconnectThresholdAttempts: 999,
      },
    })

    expect(result.ok).toBe(true)
    const outAlerts = supabase.alerts.filter((row) => row.alert_type === 'OUT_OF_PROFILE_SURGE')
    expect(outAlerts).toHaveLength(3)
    expect(outAlerts.map((row) => (row.metadata as any).subjectKey).sort()).toEqual([
      'out:package:pkg-fixed:pool',
      'out:package:pkg-tiered:tier:1',
      'out:package:pkg-tiered:tier:2',
    ])
    const fixed = outAlerts.find((row) => (row.metadata as any).packageId === 'pkg-fixed')
    expect(fixed?.current_value).toBe(25)
    expect((fixed?.metadata as any).outOfProfileMb).toBe(50)
    expect((fixed?.metadata as any).quotaMb).toBe(200)
  })
})
