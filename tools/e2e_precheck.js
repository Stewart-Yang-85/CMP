import 'dotenv/config'

function getEnv(name) {
  const v = process.env[name]
  return v ? String(v) : null
}

function present(name) {
  return !!getEnv(name)
}

function yes(b) {
  return b ? 'yes' : 'no'
}

function main() {
  const hasAuthId = present('AUTH_CLIENT_ID')
  const hasAuthSecret = present('AUTH_CLIENT_SECRET')
  const hasAdmin = present('ADMIN_API_KEY')
  const hasSvc = present('SUPABASE_SERVICE_ROLE_KEY')
  const hasCmpKey = present('CMP_WEBHOOK_KEY') || hasAdmin
  const hasSimIccid = present('SMOKE_SIM_ICCID')
  const hasWxKey = present('WXZHONGGENG_WEBHOOK_KEY')
  const hasDemoSim = present('DEMO_SIM_ICCID')

  process.stdout.write('Env status:\n')
  process.stdout.write(`- AUTH_CLIENT_ID: ${hasAuthId ? 'present' : 'missing'}\n`)
  process.stdout.write(`- AUTH_CLIENT_SECRET: ${hasAuthSecret ? 'present' : 'missing'}\n`)
  process.stdout.write(`- ADMIN_API_KEY: ${hasAdmin ? 'present' : 'missing'}\n`)
  process.stdout.write(`- SUPABASE_SERVICE_ROLE_KEY: ${hasSvc ? 'present' : 'missing'}\n`)
  process.stdout.write(`- CMP_WEBHOOK_KEY (or ADMIN_API_KEY): ${hasCmpKey ? 'present' : 'missing'}\n`)
  process.stdout.write(`- SMOKE_SIM_ICCID: ${hasSimIccid ? 'present' : 'missing'}\n`)
  process.stdout.write(`- WXZHONGGENG_WEBHOOK_KEY: ${hasWxKey ? 'present' : 'missing'}\n`)
  process.stdout.write(`- DEMO_SIM_ICCID: ${hasDemoSim ? 'present' : 'missing'}\n`)

  const readyE2eMinimal = hasAuthId && hasAuthSecret && hasAdmin
  const readyJobs = readyE2eMinimal && hasSvc
  const readyCmpWebhook = hasCmpKey && hasSimIccid
  const readyWxWebhook = hasWxKey && (hasSimIccid || hasDemoSim)

  process.stdout.write('\nReadiness:\n')
  process.stdout.write(`- e2e_demo minimal (auth/query/audits/events): ${yes(readyE2eMinimal)}\n`)
  process.stdout.write(`- e2e_demo job triggers: ${yes(readyJobs)}\n`)
  process.stdout.write(`- e2e_demo CMP webhook: ${yes(readyCmpWebhook)}\n`)
  process.stdout.write(`- e2e_demo_wx webhooks: ${yes(readyWxWebhook)}\n`)

  process.stdout.write('\nHints:\n')
  if (!readyE2eMinimal) {
    process.stdout.write('- Set AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, ADMIN_API_KEY\n')
  }
  if (readyE2eMinimal && !readyJobs) {
    process.stdout.write('- Set SUPABASE_SERVICE_ROLE_KEY to enable job triggers\n')
  }
  if (!readyCmpWebhook) {
    process.stdout.write('- Set CMP_WEBHOOK_KEY (or ADMIN_API_KEY) and SMOKE_SIM_ICCID to run CMP webhook\n')
  }
  if (!readyWxWebhook) {
    process.stdout.write('- Set WXZHONGGENG_WEBHOOK_KEY and SMOKE_SIM_ICCID (or DEMO_SIM_ICCID) to run WX webhooks\n')
  }
}

main()
