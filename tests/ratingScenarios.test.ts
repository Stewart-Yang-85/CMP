import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// @ts-ignore - JS tool module is intentionally consumed by CLI and tests.
import {
  PRICE_PLAN_TYPES,
  RATING_SCENARIOS,
  SCENARIO_GROUPS,
  scenarioDay,
  scenarioIccid,
  validateScenarioCatalog,
} from '../tools/rating_scenario_catalog.js'

const execFileAsync = promisify(execFile)

async function runNodeTool(args: string[]) {
  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
  })
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

describe('rating scenario catalog', () => {
  it('validates IDs, generated ICCIDs, and wrapped scenario days', () => {
    const validation = validateScenarioCatalog()
    expect(validation.ok).toBe(true)
    expect(validation.count).toBe(RATING_SCENARIOS.length)
    expect(validation.count).toBeGreaterThan(40)

    const iccids = RATING_SCENARIOS.map((scenario) => scenarioIccid(scenario.id))
    expect(new Set(iccids).size).toBe(iccids.length)
    expect(iccids.every((iccid) => /^\d{20}$/.test(iccid))).toBe(true)

    expect(scenarioDay('2026-06', 'R-FB-004')).toBe('2026-06-01')
    expect(scenarioDay('2026-06', 'R-SUB-001')).toBe('2026-06-04')
  })

  it('includes US5 capacity overflow regression scenarios', () => {
    const scenarios = new Map(RATING_SCENARIOS.map((scenario) => [scenario.id, scenario]))

    expect(scenarios.get('R-PP-013')).toMatchObject({
      group: SCENARIO_GROUPS.pricePlan,
      pricePlanType: PRICE_PLAN_TYPES.oneTime,
      subscriptionType: 'MAIN',
      totalMb: 1200,
      capacityOverflow: 'ONE_TIME_MAIN_TO_FALLBACK',
    })
    expect(scenarios.get('R-PP-014')).toMatchObject({
      group: SCENARIO_GROUPS.pricePlan,
      pricePlanType: PRICE_PLAN_TYPES.oneTime,
      subscriptionType: 'MAIN_AND_ADD_ON',
      expectedSubscriptionType: 'ADD_ON',
      totalMb: 1200,
      capacityOverflow: 'ONE_TIME_ADD_ON_TO_MAIN',
    })
    expect(scenarios.get('R-PP-015')).toMatchObject({
      group: SCENARIO_GROUPS.pricePlan,
      pricePlanType: PRICE_PLAN_TYPES.tieredPricing,
      subscriptionType: 'MAIN',
      totalMb: 12000,
      capacityOverflow: 'TIERED_MAIN_TO_FALLBACK',
    })
  })
})

describe('rating scenario seed CLI', () => {
  it('lists a selected scenario without requiring Supabase credentials', async () => {
    const { stdout, stderr } = await runNodeTool([
      'tools/seed_rating_scenarios.js',
      '--period',
      '2026-06',
      '--scenario',
      'R-FB-001',
      '--list',
      '--json',
    ])
    expect(stderr).toBe('')
    const payload = JSON.parse(stdout)
    expect(payload.count).toBe(1)
    expect(payload.scenarios[0]).toMatchObject({
      scenarioId: 'R-FB-001',
      group: SCENARIO_GROUPS.fallback,
      usageDay: '2026-06-26',
    })
    expect(payload.scenarios[0].sim.iccid).toBe(scenarioIccid('R-FB-001'))
  })

  it('marks every catalog scenario as having a concrete seed handler', async () => {
    const { stdout, stderr } = await runNodeTool([
      'tools/seed_rating_scenarios.js',
      '--period',
      '2026-06',
      '--list',
      '--json',
    ])
    expect(stderr).toBe('')
    const payload = JSON.parse(stdout)
    expect(payload.count).toBe(RATING_SCENARIOS.length)
    expect(payload.scenarios.every((item: any) => item.implementationStatus.seedHandler === 'implemented')).toBe(true)
  })

  it('lists capacity overflow scenario seed inputs without requiring Supabase credentials', async () => {
    const { stdout, stderr } = await runNodeTool([
      'tools/seed_rating_scenarios.js',
      '--period',
      '2026-06',
      '--scenario',
      'R-PP-014',
      '--list',
      '--json',
    ])
    expect(stderr).toBe('')
    const payload = JSON.parse(stdout)
    expect(payload.count).toBe(1)
    expect(payload.scenarios[0]).toMatchObject({
      scenarioId: 'R-PP-014',
      group: SCENARIO_GROUPS.pricePlan,
      usageDay: '2026-06-26',
      subscription: {
        type: 'MAIN_AND_ADD_ON',
        expectedType: 'ADD_ON',
      },
      ratingInputs: {
        pricePlanType: PRICE_PLAN_TYPES.oneTime,
        totalMb: 1200,
        capacityOverflow: 'ONE_TIME_ADD_ON_TO_MAIN',
      },
    })
  })
})

describe('rating scenario verifier CLI', () => {
  it('loads fallback expectations without requiring Supabase credentials', async () => {
    const { stdout, stderr } = await runNodeTool([
      'tools/verify_rating_scenarios.js',
      '--period',
      '2026-06',
      '--group',
      'fallback',
      '--json',
    ])
    expect(stderr).toBe('')
    const payload = JSON.parse(stdout)
    expect(payload.ok).toBe(true)
    expect(payload.count).toBe(6)
    expect(payload.assertionModes).toMatchObject({
      ratingResults: false,
      usageDailySummary: false,
      packageSummary: false,
      alertCandidates: false,
    })
    const noFallback = payload.expectations.find((item: any) => item.scenarioId === 'R-FB-003')
    expect(noFallback.expects.ratingResults.attribution.mode).toBe('noFallbackMapping')
    expect(noFallback.expects.usagePackageDailySummary.expected).toBe(false)
  })

  it('loads capacity overflow verifier expectations without requiring Supabase credentials', async () => {
    const { stdout, stderr } = await runNodeTool([
      'tools/verify_rating_scenarios.js',
      '--period',
      '2026-06',
      '--group',
      'pricePlan',
      '--json',
    ])
    expect(stderr).toBe('')
    const payload = JSON.parse(stdout)
    expect(payload.ok).toBe(true)
    expect(payload.count).toBe(15)

    for (const scenarioId of ['R-PP-013', 'R-PP-014', 'R-PP-015']) {
      const expectation = payload.expectations.find((item: any) => item.scenarioId === scenarioId)
      expect(expectation).toBeTruthy()
      expect(expectation.expects.ratingResults.attribution.mode).toBe('capacityOverflow')
      expect(expectation.expects.ratingResults.classification).toMatchObject({
        bucket: 'capacityOverflow',
        allowedValues: ['IN_PACKAGE', 'OVERAGE', 'TIERED_VOLUME', 'OOP_ROAMING', 'UNCLASSIFIED'],
      })
      expect(expectation.expects.usageDailySummary.metrics).toMatchObject({
        inProfileMb: '>0',
        outOfProfileMb: '>=0',
        unclassifiedMb: '>=0',
      })
      expect(expectation.expects.usagePackageDailySummary.expected).toBe(true)
    }
  })
})

describe('rating scenario rollup CLI', () => {
  it('loads the compiled Fastify/TS rollup service path', async () => {
    const script = await readFile('tools/run_rating_scenario_rollup.js', 'utf8')
    expect(script).toContain("../dist/services/usageRatingRollup.js")
    expect(script).toContain('Run `npm run build` before this tool.')
  })

  it('dry-runs with a UUID runId without requiring Supabase credentials', async () => {
    const runId = '11111111-1111-4111-8111-111111111111'
    const { stdout, stderr } = await runNodeTool([
      'tools/run_rating_scenario_rollup.js',
      '--period',
      '2026-06',
      '--dry-run',
      '--runId',
      runId,
      '--json',
    ])
    expect(stderr).toBe('')
    const payload = JSON.parse(stdout)
    expect(payload.ok).toBe(true)
    expect(payload.mode).toBe('dry-run')
    expect(payload.runId).toBe(runId)
    expect(payload.calculationIdPattern).toBe(`USAGE_ROLLUP:2026-06:*:${runId}`)
    expect(payload.wouldRun.input.jobId).toBe(runId)
  })
})
