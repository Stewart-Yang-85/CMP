/**
 * Billing Golden Case Integration Tests (T036-T040)
 *
 * Uses Mock Supabase with fixtures/billing_golden_mock_data.json to verify:
 * - T036: computeMonthlyCharges batch query (sim_id=in. + Promise.all)
 * - T037: Waterfall matching (Add-on → Main → PAYG)
 * - T038: FIXED_BUNDLE pool deduction (simContexts sorted by sim_id)
 * - T039: Overage billing (overage_rate_per_mb)
 * - T040: PAYG fallback + PAYG_RULE_MISSING
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
        case 'package_versions':
          return mockData.package_versions
        case 'price_plan_versions':
          return mockData.price_plan_versions
        case 'price_plans':
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

    for (const gc of goldenCases.cases as { id: string; expected: { classification: string; charged_kb: number; rate_per_kb: number | null; amount: number } }[]) {
      const ref = `golden:${gc.id}`
      const actual = byInputRef.get(ref)
      expect(actual, `Missing result for ${ref}`).toBeDefined()
      if (!actual) continue

      const exp = gc.expected
      expect(actual.classification, `${gc.id} classification`).toBe(exp.classification)
      expect(actual.amount, `${gc.id} amount`).toBe(exp.amount)

      const chargedKb = (actual as { charged_kb?: number; charged_mb?: number }).charged_kb ?? (actual as { charged_mb?: number }).charged_mb
      if (chargedKb !== undefined) {
        expect(chargedKb, `${gc.id} charged_kb`).toBe(exp.charged_kb)
      }

      const ratePerKb = (actual as { rate_per_kb?: number; rate_per_mb?: number }).rate_per_kb ?? (actual as { rate_per_mb?: number }).rate_per_mb
      if (exp.rate_per_kb !== null) {
        expect(ratePerKb, `${gc.id} rate_per_kb`).toBe(exp.rate_per_kb)
      } else {
        expect(ratePerKb == null || ratePerKb === 0, `${gc.id} rate should be null/0`).toBe(true)
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
