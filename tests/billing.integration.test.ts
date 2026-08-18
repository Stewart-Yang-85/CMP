/**
 * Billing Golden Case Integration Tests (T036-T040)
 *
 * Uses Mock Supabase with fixtures/billing_golden_mock_data.json to verify:
 * - T036: computeMonthlyCharges batch query (sim_id=in. + Promise.all)
 * - T037: Waterfall matching (Add-on → Main → PAYG)
 * - T038: FIXED_BUNDLE pool deduction (simContexts sorted by sim_id)
 * - T039: Overage billing (overage_rate_per_mb)
 * - T040: Out-of-profile OOP roaming via package roamingProfileId + roaming_profiles.mccmnc_list
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeMonthlyCharges } from '../src/billing.js'
import mockData from '../fixtures/billing_golden_mock_data.json'
import goldenCases from '../fixtures/golden_cases.json'

const meta = mockData._meta as {
  enterpriseId: string
  supplierId: string
  billPeriod: string
  periodStart: string
  periodEnd: string
}

function createMockSupabase() {
  const selectCalls: { table: string; query: string }[] = []
  const selectWithCountCalls: { table: string; query: string }[] = []

  const mock = {
    selectCalls: () => [...selectCalls],
    selectWithCountCalls: () => [...selectWithCountCalls],

    async select(table: string, queryString: string) {
      selectCalls.push({ table, query: queryString })
      switch (table) {
        case 'sims':
          return mockData.sims
        case 'packages':
          return (mockData as { packages?: unknown }).packages ?? []
        case 'price_plan_versions':
          return mockData.price_plan_versions
        case 'price_plans':
          return mockData.price_plans
        case 'price_plans_expanded':
          return mockData.price_plans
        case 'subscriptions': {
          const match = queryString.match(/sim_id=in\.\(([^)]+)\)/)
          if (match) {
            const ids = match[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
            return (mockData.subscriptions as { sim_id: string }[]).filter((s) =>
              ids.includes(s.sim_id)
            )
          }
          return mockData.subscriptions
        }
        case 'usage_daily_summary': {
          const match = queryString.match(/sim_id=in\.\(([^)]+)\)/)
          if (match) {
            const ids = match[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
            return (mockData.usage_daily_summary as { sim_id: string }[]).filter((u) =>
              ids.includes(u.sim_id)
            )
          }
          return mockData.usage_daily_summary
        }
        case 'sim_state_history':
          return mockData.sim_state_history
        case 'covered_network_profile_entries':
          return (mockData as { covered_network_profile_entries?: unknown[] }).covered_network_profile_entries ?? []
        case 'roaming_profiles': {
          const rows = (mockData as { roaming_profiles?: { roaming_profile_id: string }[] }).roaming_profiles ?? []
          const match = queryString.match(/roaming_profile_id=in\.\(([^)]+)\)/)
          if (match) {
            const ids = match[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
            return rows.filter((r) => ids.includes(r.roaming_profile_id))
          }
          return rows
        }
        case 'carrier_service_modules': {
          const rows =
            (mockData as { carrier_service_modules?: { carrier_service_id: string }[] }).carrier_service_modules ?? []
          const match = queryString.match(/carrier_service_id=in\.\(([^)]+)\)/)
          if (match) {
            const ids = match[1].split(',').map((s) => decodeURIComponent(s.trim()))
            return rows.filter((r) => ids.includes(r.carrier_service_id))
          }
          return rows
        }
        default:
          return []
      }
    },

    async selectWithCount(table: string, queryString: string) {
      selectWithCountCalls.push({ table, query: queryString })
      if (table === 'sims') {
        const data = mockData.sims
        return { data, total: data.length }
      }
      return { data: [], total: 0 }
    },
  }

  return mock
}

describe('Billing Golden Case Integration (T036-T040)', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>

  beforeEach(() => {
    mockSupabase = createMockSupabase()
  })

  it('T036: uses batch sim_id=in.() and Promise.all for subscriptions/usage/history', async () => {
    const result = await computeMonthlyCharges(
      {
        enterpriseId: meta.enterpriseId,
        billPeriod: meta.billPeriod,
        calculationId: 'golden-integration-test',
      },
      mockSupabase as any
    )

    expect(result).toBeDefined()
    expect(result.ratingResults.length).toBeGreaterThanOrEqual(8)

    const subSelects = mockSupabase.selectCalls().filter((c) => c.table === 'subscriptions')
    const usageSelects = mockSupabase.selectCalls().filter((c) => c.table === 'usage_daily_summary')
    const historySelects = mockSupabase.selectCalls().filter((c) => c.table === 'sim_state_history')

    expect(subSelects.length).toBeGreaterThanOrEqual(1)
    expect(usageSelects.length).toBeGreaterThanOrEqual(1)
    expect(historySelects.length).toBeGreaterThanOrEqual(1)

    expect(subSelects.some((c) => c.query.includes('sim_id=in.'))).toBe(true)
    expect(usageSelects.some((c) => c.query.includes('sim_id=in.'))).toBe(true)
    expect(historySelects.some((c) => c.query.includes('sim_id=in.'))).toBe(true)
  })

  it('T039+T040+T041: rating results match golden_cases.json expected values', async () => {
    const result = await computeMonthlyCharges(
      {
        enterpriseId: meta.enterpriseId,
        billPeriod: meta.billPeriod,
        calculationId: 'golden-integration-test',
      },
      mockSupabase as any
    )

    const byInputRef = new Map<string, (typeof result.ratingResults)[0]>()
    for (const r of result.ratingResults) {
      const ref = (r as { input_ref?: string }).input_ref
      if (ref && ref.startsWith('golden:')) {
        byInputRef.set(ref, r)
      }
    }

    for (const gc of goldenCases.cases as { id: string; expected: { classification: string; charged_mb: number; rate_per_mb: number | null; amount: number } }[]) {
      const ref = `golden:${gc.id}`
      const actual = byInputRef.get(ref)
      expect(actual, `Missing result for ${ref}`).toBeDefined()
      if (!actual) continue

      const exp = gc.expected
      expect(actual.classification, `${gc.id} classification`).toBe(exp.classification)
      expect(actual.amount, `${gc.id} amount`).toBe(exp.amount)

      const chargedMb = (actual as { charged_kb?: number; charged_mb?: number }).charged_mb ?? (actual as { charged_kb?: number }).charged_kb
      if (chargedMb !== undefined) {
        expect(chargedMb, `${gc.id} charged_mb`).toBe(exp.charged_mb)
      }

      const ratePerMb = (actual as { rate_per_kb?: number; rate_per_mb?: number }).rate_per_mb ?? (actual as { rate_per_kb?: number }).rate_per_kb
      if (exp.rate_per_mb !== null) {
        expect(ratePerMb, `${gc.id} rate_per_mb`).toBe(exp.rate_per_mb)
      } else {
        expect(ratePerMb == null || ratePerMb === 0, `${gc.id} rate should be null/0`).toBe(true)
      }
    }
  })

  it('produces 8 rating results for 8 golden cases', async () => {
    const result = await computeMonthlyCharges(
      {
        enterpriseId: meta.enterpriseId,
        billPeriod: meta.billPeriod,
        calculationId: 'golden-integration-test',
      },
      mockSupabase as any
    )

    const goldenRefs = new Set(
      (goldenCases.cases as { id: string }[]).map((c) => `golden:${c.id}`)
    )
    const foundRefs = result.ratingResults
      .map((r) => (r as { input_ref?: string }).input_ref)
      .filter((ref): ref is string => !!ref && goldenRefs.has(ref))

    expect(foundRefs.length, 'All 8 golden cases should have rating results').toBe(8)
  })
})

function createPhase30MockSupabase(phase30Data: {
  sims: unknown[]
  packages: unknown[]
  price_plans: unknown[]
  subscriptions: unknown[]
  usage_daily_summary: unknown[]
  sim_state_history: unknown[]
  covered_network_profile_entries?: unknown[]
  roaming_profiles?: unknown[]
  carrier_service_modules?: unknown[]
}) {
  return {
    async select(table: string, queryString: string) {
      switch (table) {
        case 'sims':
          return phase30Data.sims
        case 'packages':
          return phase30Data.packages
        case 'carrier_service_modules': {
          const rows = (phase30Data.carrier_service_modules ?? []) as { carrier_service_id?: string }[]
          const m = queryString.match(/carrier_service_id=in\.\(([^)]+)\)/)
          if (m) {
            const ids = m[1].split(',').map((s) => decodeURIComponent(s.trim()))
            return rows.filter((r) => r.carrier_service_id && ids.includes(String(r.carrier_service_id)))
          }
          return rows
        }
        case 'price_plans':
          return phase30Data.price_plans
        case 'price_plans_expanded':
          return phase30Data.price_plans
        case 'covered_network_profile_entries':
          return phase30Data.covered_network_profile_entries ?? []
        case 'roaming_profiles':
          return phase30Data.roaming_profiles ?? []
        case 'subscriptions': {
          const match = queryString.match(/sim_id=in\.\(([^)]+)\)/)
          if (match) {
            const ids = match[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
            return (phase30Data.subscriptions as { sim_id: string }[]).filter((s) => ids.includes(s.sim_id))
          }
          return phase30Data.subscriptions
        }
        case 'usage_daily_summary': {
          const match = queryString.match(/sim_id=in\.\(([^)]+)\)/)
          if (match) {
            const ids = match[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
            return (phase30Data.usage_daily_summary as { sim_id: string }[]).filter((u) => ids.includes(u.sim_id))
          }
          return phase30Data.usage_daily_summary
        }
        case 'sim_state_history':
          return phase30Data.sim_state_history
        default:
          return []
      }
    },
    async selectWithCount(table: string, _queryString: string) {
      if (table === 'sims') {
        const data = phase30Data.sims as unknown[]
        return { data, total: data.length }
      }
      return { data: [], total: 0 }
    },
  }
}

/** T226: in-profile vs OOP roaming cases (mock DB); CoveredNetworkProfile API/service tests: `coveredNetworkProfile.test.ts`. */
describe('Phase 30 (T222) billing waterfall — Covered vs OOP roaming vs PAYG', () => {
  const enterpriseId = meta.enterpriseId
  const supplierId = meta.supplierId
  const coveredId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
  const roamingId = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr'
  const pkgId = 'pkg-phase30-1'
  const ppId = 'pp-phase30-1'
  const simId = 'ssssssss-ssss-ssss-ssss-ssssssssss02'

  const basePhase30 = {
    sims: [{ sim_id: simId, iccid: '89860000000000999999', enterprise_id: enterpriseId, status: 'ACTIVATED' }],
    subscriptions: [
      {
        subscription_id: 'sub-p30-1',
        sim_id: simId,
        package_id: pkgId,
        subscription_kind: 'MAIN',
        state: 'ACTIVE',
        effective_at: '2024-12-01T00:00:00Z',
        expires_at: null,
      },
    ],
    packages: [
      {
        package_id: pkgId,
        price_plan_id: ppId,
        name: 'Phase30 pkg',
        carrier_service_id: 'cs-phase30-1',
      },
    ],
    carrier_service_modules: [
      {
        carrier_service_id: 'cs-phase30-1',
        supplier_id: supplierId,
        operator_id: '22222222-2222-2222-2222-222222222222',
        roaming_profile_id: roamingId,
        apn_profile_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        rat: '4G',
        status: 'PUBLISHED',
      },
    ],
    price_plans: [
      {
        price_plan_id: ppId,
        type: 'FIXED_BUNDLE',
        currency: 'USD',
        first_cycle_proration: 'NONE',
        covered_network_profile_id: coveredId,
        monthly_fee: 0,
        deactivated_monthly_fee: 0,
        total_quota_mb: 200,
        overage_rate_per_mb: 2,
      },
    ],
    covered_network_profile_entries: [{ covered_network_profile_id: coveredId, mcc: '234', mnc: '15' }],
    roaming_profiles: [
      {
        roaming_profile_id: roamingId,
        mccmnc_list: [{ mcc: '234', mnc: '15', ratePerMb: 99 }],
      },
    ],
    sim_state_history: [] as unknown[],
  }

  it('in-profile matches CoveredNetworkProfile mcc-* against any MNC under that MCC', async () => {
    const phase30Data = {
      ...basePhase30,
      covered_network_profile_entries: [
        { covered_network_profile_id: coveredId, mcc: '310', mnc: '*' },
      ],
      usage_daily_summary: [
        {
          sim_id: simId,
          iccid: '89860000000000999999',
          enterprise_id: enterpriseId,
          supplier_id: supplierId,
          usage_day: '2025-01-15',
          visited_mccmnc: '310-260',
          total_mb: 25,
          input_ref: 'p30:covered-mcc-star',
        },
      ],
    }
    const result = await computeMonthlyCharges(
      {
        enterpriseId,
        billPeriod: meta.billPeriod,
        calculationId: 'phase30-covered-wildcard',
      },
      createPhase30MockSupabase(phase30Data) as any
    )
    const row = result.ratingResults.find(
      (r) => (r as { input_ref?: string }).input_ref === 'p30:covered-mcc-star'
    )
    expect(row).toBeDefined()
    expect((row as { classification?: string }).classification).toBe('IN_PACKAGE')
    expect(Number((row as { amount?: number }).amount)).toBe(0)
  })

  it('in-profile membership follows CoveredNetworkProfile entries even if package.roaming_profile disagrees', async () => {
    const phase30Data = {
      ...basePhase30,
      usage_daily_summary: [
        {
          sim_id: simId,
          iccid: '89860000000000999999',
          enterprise_id: enterpriseId,
          supplier_id: supplierId,
          usage_day: '2025-01-15',
          visited_mccmnc: '234-15',
          total_mb: 50,
          input_ref: 'p30:covered-in',
        },
      ],
    }
    const result = await computeMonthlyCharges(
      {
        enterpriseId,
        billPeriod: meta.billPeriod,
        calculationId: 'phase30-covered',
      },
      createPhase30MockSupabase(phase30Data) as any
    )
    const row = result.ratingResults.find((r) => (r as { input_ref?: string }).input_ref === 'p30:covered-in')
    expect(row).toBeDefined()
    expect((row as { classification?: string }).classification).toBe('IN_PACKAGE')
    expect(Number((row as { amount?: number }).amount)).toBe(0)
  })

  it('out-of-profile uses carrier roaming tariff (price plan has no zone PAYG)', async () => {
    const phase30Data = {
      ...basePhase30,
      price_plans: [basePhase30.price_plans[0]],
      usage_daily_summary: [
        {
          sim_id: simId,
          iccid: '89860000000000999999',
          enterprise_id: enterpriseId,
          supplier_id: supplierId,
          usage_day: '2025-01-15',
          visited_mccmnc: '999-99',
          total_mb: 10,
          input_ref: 'p30:oop-first',
        },
      ],
      roaming_profiles: [
        {
          roaming_profile_id: roamingId,
          mccmnc_list: [{ mcc: '999', mnc: '99', ratePerMb: 3 }],
        },
      ],
    }
    const result = await computeMonthlyCharges(
      {
        enterpriseId,
        billPeriod: meta.billPeriod,
        calculationId: 'phase30-oop',
      },
      createPhase30MockSupabase(phase30Data) as any
    )
    const row = result.ratingResults.find((r) => (r as { input_ref?: string }).input_ref === 'p30:oop-first')
    expect(row).toBeDefined()
    expect((row as { classification?: string }).classification).toBe('OOP_ROAMING')
    expect((row as { rate_per_mb?: number }).rate_per_mb).toBe(3)
    expect((row as { amount?: number }).amount).toBe(30)
  })
})
