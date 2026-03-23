/**
 * Billing engine test against real Supabase database.
 * Loads .env (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).
 *
 * Usage: node -r dotenv/config tools/billing_supabase_test.js
 */
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { computeMonthlyCharges } from '../src/billing.js'

async function main() {
  console.log('=== Billing Supabase Test ===\n')

  const supabase = createSupabaseRestClient({ useServiceRole: true })

  const billPeriod = process.env.BILL_PERIOD || '2025-01'
  const enterpriseId = process.env.ENTERPRISE_ID || null

  console.log(`Bill period: ${billPeriod}`)
  console.log(`Enterprise filter: ${enterpriseId || 'ALL'}\n`)

  const result = await computeMonthlyCharges(
    {
      enterpriseId,
      billPeriod,
      calculationId: `supabase-test-${Date.now()}`,
    },
    supabase
  )

  console.log('Result:')
  console.log(`  calculationId: ${result.calculationId}`)
  console.log(`  totalBillAmount: ${result.totalBillAmount} ${result.currency}`)
  console.log(`  lineItems: ${result.lineItems.length}`)
  console.log(`  ratingResults: ${result.ratingResults.length}`)

  if (result.ratingResults.length > 0) {
    console.log('\nSample rating results (first 5):')
    result.ratingResults.slice(0, 5).forEach((r, i) => {
      console.log(
        `  ${i + 1}. iccid=${r.iccid} visited=${r.visited_mccmnc} classification=${r.classification} amount=${r.amount}`
      )
    })
  }

  console.log('\n=== Billing Supabase Test PASSED ===')
}

main().catch((err) => {
  console.error('\n=== Billing Supabase Test FAILED ===')
  console.error(err)
  process.exit(1)
})
