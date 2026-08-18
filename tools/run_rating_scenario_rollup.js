import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { DEFAULT_RATING_SCENARIO_SCOPE } from './rating_scenario_catalog.js'

function arg(name) {
  const flag = `--${name}`
  const idx = process.argv.indexOf(flag)
  if (idx < 0) return null
  const value = process.argv[idx + 1]
  return value && !value.startsWith('--') ? value : ''
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function currentPeriodUtc() {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

function parsePeriod(value) {
  const period = String(value || currentPeriodUtc()).trim()
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error('--period must be YYYY-MM')
  }
  return period
}

function parsePositiveInt(name, fallback) {
  const raw = arg(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`)
  }
  return Math.floor(value)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadRollupRunner() {
  const moduleUrl = new URL('../dist/services/usageRatingRollup.js', import.meta.url)
  if (!fs.existsSync(moduleUrl)) {
    throw new Error('dist/services/usageRatingRollup.js not found. Run `npm run build` before this tool.')
  }
  const mod = await import(moduleUrl.href)
  if (typeof mod.runUsageRatingRollup !== 'function') {
    throw new Error('dist/services/usageRatingRollup.js does not export runUsageRatingRollup.')
  }
  return mod.runUsageRatingRollup
}

async function countRows(supabase, table, query) {
  const { total } = await supabase.selectWithCount(table, `select=*&${query}&limit=1`)
  return Number(total || 0)
}

async function probeRollupOutputs(supabase, { period, runId, enterpriseId }) {
  const runPattern = encodeURIComponent(`USAGE_ROLLUP:${period}:*:${runId}`)
  const filters = [`calculation_id=like.${runPattern}`]
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  const query = filters.join('&')
  const ratingResults = await countRows(supabase, 'rating_results', query)
  const packageSummaries = await countRows(supabase, 'usage_package_daily_summary', query)
  return { ratingResults, packageSummaries }
}

async function waitForRollupOutputs(supabase, options) {
  const timeoutMs = options.timeoutMs
  const intervalMs = options.intervalMs
  const startedAt = Date.now()
  let last = null
  let stableCount = 0
  const snapshots = []
  while (Date.now() - startedAt <= timeoutMs) {
    const snapshot = await probeRollupOutputs(supabase, options)
    snapshot.elapsedMs = Date.now() - startedAt
    snapshots.push(snapshot)
    const sameAsLast = last
      && last.ratingResults === snapshot.ratingResults
      && last.packageSummaries === snapshot.packageSummaries
    stableCount = sameAsLast ? stableCount + 1 : 0
    const ratingVisible = snapshot.ratingResults >= options.expectedRatingRows
    const summaryVisible = options.expectedRatingRows === 0 || snapshot.packageSummaries > 0
    if (ratingVisible && summaryVisible && stableCount >= 1) {
      return { ok: true, snapshot, snapshots }
    }
    last = snapshot
    await sleep(intervalMs)
  }
  return {
    ok: false,
    snapshot: last || { ratingResults: 0, packageSummaries: 0, elapsedMs: Date.now() - startedAt },
    snapshots,
  }
}

function printHelp() {
  console.log(`Usage:
  node tools/run_rating_scenario_rollup.js [options]

Options:
  --period YYYY-MM          Rating period. Default: current UTC month.
  --enterpriseId <uuid>     Enterprise scope. Default: Phase 46 scenario enterprise.
  --resellerId <uuid>       Reseller scope. Default: Phase 46 scenario reseller.
  --runId <uuid>            UUID used in calculation_id suffix. Default: random UUID.
  --dry-run                 Preview only. This is the default.
  --apply                   Execute rollup.
  --no-wait                 Do not poll output tables after execution.
  --timeout-ms <number>     Wait timeout. Default: 60000.
  --interval-ms <number>    Poll interval. Default: 2000.
  --json                    Print machine-readable JSON.
  --help                    Show this help.

Examples:
  node tools/run_rating_scenario_rollup.js --period 2026-06 --dry-run
  node tools/run_rating_scenario_rollup.js --period 2026-06 --apply
  node tools/run_rating_scenario_rollup.js --period 2026-06 --apply --json
`)
}

async function main() {
  if (hasFlag('help')) {
    printHelp()
    return
  }

  const period = parsePeriod(arg('period'))
  const mode = hasFlag('apply') ? 'apply' : 'dry-run'
  const json = hasFlag('json')
  const wait = !hasFlag('no-wait')
  const timeoutMs = parsePositiveInt('timeout-ms', 60000)
  const intervalMs = parsePositiveInt('interval-ms', 2000)
  const enterpriseId = arg('enterpriseId') || DEFAULT_RATING_SCENARIO_SCOPE.enterpriseId
  const resellerId = arg('resellerId') || DEFAULT_RATING_SCENARIO_SCOPE.resellerId
  const runId = arg('runId') || crypto.randomUUID()

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error('--runId must be a valid UUID. This avoids invalid jobs.job_id updates.')
  }

  const payload = {
    period,
    mode,
    wait,
    scope: { enterpriseId, resellerId },
    runId,
    calculationIdPattern: `USAGE_ROLLUP:${period}:*:${runId}`,
  }

  if (mode === 'dry-run') {
    const output = {
      ok: true,
      ...payload,
      wouldRun: {
        service: 'runUsageRatingRollup',
        input: { period, enterpriseId, resellerId, jobId: runId },
      },
    }
    if (json) {
      console.log(JSON.stringify(output, null, 2))
      return
    }
    console.log('Rating scenario rollup dry-run')
    console.log(`Period: ${period}`)
    console.log(`Enterprise: ${enterpriseId}`)
    console.log(`Reseller: ${resellerId}`)
    console.log(`Run ID: ${runId}`)
    console.log(`Calculation ID pattern: ${payload.calculationIdPattern}`)
    console.log('Add --apply to execute.')
    return
  }

  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const runUsageRatingRollup = await loadRollupRunner()
  const startedAt = Date.now()
  const result = await runUsageRatingRollup({
    supabase,
    period,
    enterpriseId,
    resellerId,
    jobId: runId,
  })
  const durationMs = Date.now() - startedAt

  if (!result?.ok) {
    const output = { ok: false, ...payload, durationMs, result }
    if (json) console.log(JSON.stringify(output, null, 2))
    throw new Error(result?.message || 'Usage rating rollup failed.')
  }

  const expectedRatingRows = Number(result?.value?.ratingRows || 0)
  const waitResult = wait
    ? await waitForRollupOutputs(supabase, {
      period,
      runId,
      enterpriseId,
      expectedRatingRows,
      timeoutMs,
      intervalMs,
    })
    : null

  const output = {
    ok: waitResult ? waitResult.ok : true,
    ...payload,
    durationMs,
    result,
    waitResult,
  }

  if (json) {
    console.log(JSON.stringify(output, null, 2))
    if (!output.ok) process.exitCode = 1
    return
  }

  console.log('Rating scenario rollup executed')
  console.log(`Period: ${period}`)
  console.log(`Enterprise: ${enterpriseId}`)
  console.log(`Reseller: ${resellerId}`)
  console.log(`Run ID: ${runId}`)
  console.log(`Rating rows: ${expectedRatingRows}`)
  console.log(`Duration: ${durationMs}ms`)
  if (waitResult) {
    console.log(`Output visible: ${waitResult.ok ? 'YES' : 'NO'}`)
    console.log(`rating_results: ${waitResult.snapshot.ratingResults}`)
    console.log(`usage_package_daily_summary: ${waitResult.snapshot.packageSummaries}`)
  }
  if (!output.ok) process.exitCode = 1
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err)
  process.exitCode = 1
})
