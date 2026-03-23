/**
 * 最小验证 runBillingGenerate（T059）：写 bills / line_items / rating_results，可选自动 publish。
 *
 * 前置：.env 含 SUPABASE_URL、SUPABASE_ANON_KEY、SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node tools/test_billing_generate.js --enterpriseId <uuid> --period 2026-02
 *   node tools/test_billing_generate.js --enterpriseId <uuid> --period 2026-02 --resellerId <代理商-tenant-uuid>
 *   node tools/test_billing_generate.js --enterpriseId <uuid> --period 2026-02 --autoPublish true
 *
 * 说明：
 * - period 须为 YYYY-MM；该企业该账期若已有账单会跳过（幂等）。
 * - 若无订阅/用量等，computeMonthlyCharges 可能不产生新账单，results 可能为空。
 */
import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { runBillingGenerate } from '../src/services/billingGenerate.js'

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return null
  const v = process.argv[idx + 1]
  return !v || v.startsWith('--') ? null : v
}

function parseAutoPublish(raw) {
  if (raw == null) return undefined
  const s = String(raw).toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return undefined
}

async function main() {
  const enterpriseId = getArg('enterpriseId')
  const period = getArg('period')
  const resellerId = getArg('resellerId')
  const autoPublish = parseAutoPublish(getArg('autoPublish'))

  if (!enterpriseId || !period) {
    console.error(
      'Usage: node tools/test_billing_generate.js --enterpriseId <uuid> --period YYYY-MM [--resellerId <uuid>] [--autoPublish true|false]'
    )
    process.exit(1)
  }

  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const jobId = `test-billing-gen-${Date.now()}`
  const result = await runBillingGenerate({
    supabase,
    period: period.trim(),
    enterpriseId,
    resellerId: resellerId ?? null,
    autoPublish,
    actorUserId: null,
    actorRole: 'platform_admin',
    requestId: jobId,
    sourceIp: null,
    jobId,
  })

  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }

  console.log(JSON.stringify(result.value, null, 2))
  const n = Array.isArray(result.value?.results) ? result.value.results.length : 0
  if (n === 0) {
    console.log(
      'Done: no new bills (可能该账期已有账单，或 computeMonthlyCharges 无计费结果)。'
    )
  } else {
    console.log(`OK: 已生成 ${n} 条账单记录，请查表 bills / bill_line_items。`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
