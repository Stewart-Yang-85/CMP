#!/usr/bin/env node
/**
 * Manual: expire ACTIVE ONE_TIME subscriptions with expires_at <= now.
 * Usage: node tools/run_one_time_subscription_expiry.js
 */
import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { runOneTimeSubscriptionExpiry } from '../dist/services/subscriptionOneTimeExpiry.js'

async function main() {
  const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: `cli-one-time-expiry-${Date.now()}` })
  const result = await runOneTimeSubscriptionExpiry({
    supabase,
    requestId: `cli-one-time-expiry-${Date.now()}`,
    limit: Number(process.env.SUBSCRIPTION_ONE_TIME_EXPIRY_BATCH_LIMIT || 100),
  })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
