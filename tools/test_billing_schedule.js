/**
 * 验证 billing_config + resolveBillingSchedule（T058）。
 *
 * 不要在 PowerShell 里粘贴 `import ...` —— 那是 JavaScript，必须用 Node 执行本文件。
 *
 * 前置：.env 含 SUPABASE_URL、SUPABASE_ANON_KEY、SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node tools/test_billing_schedule.js --enterpriseId <uuid>              # 企业 billing_config（或与企业同查代理商）
 *   node tools/test_billing_schedule.js --resellerId <代理商 tenants.tenant_id>  # 仅代理商 billing_config → source 应为 RESELLER
 *   node tools/test_billing_schedule.js --enterpriseId <uuid> --resellerId <uuid>  # 企业优先；企业无行时用代理商
 *
 * 说明：billing_config.enterprise_id 存的是 tenants.tenant_id；代理商配置行里 enterprise_id 填代理商自己的 tenant_id。
 */
import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { resolveBillingSchedule } from '../src/services/billingSchedule.js'

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return null
  const v = process.argv[idx + 1]
  return !v || v.startsWith('--') ? null : v
}

async function main() {
  const enterpriseId = getArg('enterpriseId')
  const resellerId = getArg('resellerId')
  if (!enterpriseId && !resellerId) {
    console.error(
      'Usage: node tools/test_billing_schedule.js --enterpriseId <uuid> [--resellerId <uuid>]\n' +
        '   or: node tools/test_billing_schedule.js --resellerId <reseller-tenant-uuid>'
    )
    process.exit(1)
  }

  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const result = await resolveBillingSchedule({
    supabase,
    enterpriseId: enterpriseId ?? null,
    resellerId: resellerId ?? null,
  })

  if (!result.ok) {
    console.error('resolveBillingSchedule failed:', result)
    process.exit(1)
  }

  console.log(JSON.stringify(result.value, null, 2))
  console.log(
    'OK: tPlusDays ← billing_config.bill_day (默认 3)；source=CUSTOMER|RESELLER|SYSTEM 表示实际采用的配置来源。'
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
