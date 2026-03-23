/**
 * 本地执行 runDunningCheck（需 SUPABASE_SERVICE_ROLE_KEY，与 API/Worker 相同 .env）
 *
 * 用法：
 *   node tools/run_dunning_check.js
 *   node tools/run_dunning_check.js 88962922-f9e3-42a1-bc86-d1708ed70f7a
 *   node tools/run_dunning_check.js 88962922-f9e3-42a1-bc86-d1708ed70f7a --as-of=2026-03-23
 *   DUNNING_AS_OF=2026-03-23 node tools/run_dunning_check.js <enterpriseId>   # bash
 *
 * PowerShell 设置环境变量请用（不要用 CMD 的 set）：
 *   $env:DUNNING_AS_OF="2026-03-23"; npm run dunning:check -- <enterpriseId>
 *
 * 仅处理：status in (PUBLISHED, OVERDUE) 且 due_date <= asOfDate（默认今天 UTC 日期）的账单。
 */
import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { runDunningCheck } from '../src/services/dunning.js'

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10)
}

function parseArgv() {
  let enterpriseId = null
  let asOfFromFlag = null
  for (const arg of process.argv.slice(2)) {
    const asOfMatch = arg.match(/^--as-of=(.+)$/)
    if (asOfMatch) {
      const d = asOfMatch[1].trim().slice(0, 10)
      if (d.length >= 10) asOfFromFlag = d
      continue
    }
    if (/^[0-9a-f-]{36}$/i.test(arg)) {
      enterpriseId = arg
    }
  }
  if (!enterpriseId && process.env.DUNNING_ENTERPRISE_ID) {
    enterpriseId = String(process.env.DUNNING_ENTERPRISE_ID).trim()
  }
  return { enterpriseId, asOfFromFlag }
}

function getAsOfDate(cliAsOf) {
  if (cliAsOf) return cliAsOf
  const v = process.env.DUNNING_AS_OF
  if (v && String(v).length >= 10) return String(v).slice(0, 10)
  return undefined
}

async function main() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    process.stderr.write('Missing SUPABASE_SERVICE_ROLE_KEY in environment.\n')
    process.exit(1)
  }
  const { enterpriseId: eid, asOfFromFlag } = parseArgv()
  const enterpriseId = eid || null
  const asOfDate = getAsOfDate(asOfFromFlag)
  const asOfDateUsed = asOfDate || todayUtcDate()
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const result = await runDunningCheck({
    supabase,
    enterpriseId: enterpriseId || undefined,
    asOfDate,
  })
  if (!result.ok) {
    process.stderr.write(`runDunningCheck failed: ${result.code} ${result.message}\n`)
    process.exit(1)
  }
  const v = result.value || {}
  const processed = v.processed ?? 0
  const enterprises = v.enterprises ?? 0
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        processed,
        enterprises,
        enterpriseId: enterpriseId || null,
        asOfDateUsed,
        hint:
          processed === 0 && enterprises >= 1
            ? 'No rows changed (records already match policy for these overdue bills). Re-run with a different --as-of only if you need another cutoff date.'
            : undefined,
      },
      null,
      2
    ) + '\n'
  )
  if (processed === 0 && enterprises === 0 && asOfDate) {
    process.stdout.write(
      'NOTE: No overdue bills matched (PUBLISHED/OVERDUE, due_date <= asOfDate). Try a later --as-of or check bill status/due_date.\n'
    )
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n')
  process.exit(1)
})
