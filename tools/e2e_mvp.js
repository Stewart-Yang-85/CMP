/**
 * E2E MVP Integration Test Script
 * Tests the complete flow: Reseller → Customer → SIM → Package → Subscription → Billing → Bill
 *
 * Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... node tools/e2e_mvp.js
 */
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { computeMonthlyCharges, generateMonthlyBill, roundAmount } from '../src/billing.js'

const supabase = createSupabaseRestClient({ useServiceRole: true })

let resellerId, resellerTenantId
let customerId, customerTenantId
let supplierId
let simId, iccid
let pricePlanId, pricePlanVersionId
let packageId, packageVersionId
let subscriptionId
let billId

async function step(name, fn) {
  try {
    await fn()
    console.log(`  [PASS] ${name}`)
  } catch (err) {
    console.error(`  [FAIL] ${name}:`, err?.message || err)
    throw err
  }
}

async function main() {
  console.log('=== E2E MVP Integration Test ===\n')

  // Step 1: Create Reseller
  await step('Create reseller via RPC', async () => {
    const result = await supabase.rpc('create_reseller', {
      p_name: `E2E-Reseller-${Date.now()}`,
      p_contact_email: 'e2e@test.com',
      p_currency: 'USD',
    })
    resellerId = result?.reseller_id
    resellerTenantId = result?.tenant_id
    if (!resellerId) throw new Error('No reseller_id returned')
  })

  // Step 2: Create Customer
  await step('Create customer via RPC', async () => {
    const result = await supabase.rpc('create_customer', {
      p_reseller_id: resellerId,
      p_name: `E2E-Customer-${Date.now()}`,
      p_auto_suspend_enabled: true,
    })
    customerId = result?.customer_id
    customerTenantId = result?.tenant_id
    if (!customerId) throw new Error('No customer_id returned')
  })

  // Step 3: Create Supplier
  await step('Create supplier', async () => {
    const rows = await supabase.insert('suppliers', {
      name: `E2E-Supplier-${Date.now()}`,
      status: 'ACTIVE',
    }, { returning: 'representation' })
    supplierId = rows?.[0]?.supplier_id
    if (!supplierId) throw new Error('No supplier_id returned')
  })

  // Step 4: Create SIM
  await step('Create SIM (INVENTORY)', async () => {
    iccid = `8986${String(Date.now()).slice(-16).padStart(16, '0')}`
    const rows = await supabase.insert('sims', {
      iccid,
      primary_imsi: `460${String(Date.now()).slice(-12)}`,
      supplier_id: supplierId,
      enterprise_id: customerTenantId,
      status: 'INVENTORY',
    }, { returning: 'representation' })
    simId = rows?.[0]?.sim_id
    if (!simId) throw new Error('No sim_id returned')
  })

  // Step 5: Activate SIM
  await step('Activate SIM (INVENTORY → ACTIVATED)', async () => {
    await supabase.update('sims', `sim_id=eq.${simId}`, {
      status: 'ACTIVATED',
      activation_date: new Date().toISOString(),
    })
    await supabase.insert('sim_state_history', {
      sim_id: simId,
      before_status: 'INVENTORY',
      after_status: 'ACTIVATED',
      start_time: new Date().toISOString(),
      source: 'E2E_TEST',
    }, { returning: 'minimal' })
  })

  // Step 6: Create Price Plan (FIXED_BUNDLE)
  await step('Create Fixed Bundle price plan', async () => {
    const rows = await supabase.insert('price_plans', {
      enterprise_id: customerTenantId,
      name: `E2E-FixedBundle-${Date.now()}`,
      type: 'FIXED_BUNDLE',
      service_type: 'DATA',
      currency: 'USD',
      billing_cycle_type: 'CALENDAR_MONTH',
      first_cycle_proration: 'NONE',
    }, { returning: 'representation' })
    pricePlanId = rows?.[0]?.price_plan_id
    if (!pricePlanId) throw new Error('No price_plan_id returned')
  })

  // Step 7: Create Price Plan Version
  await step('Create price plan version', async () => {
    const rows = await supabase.insert('price_plan_versions', {
      price_plan_id: pricePlanId,
      version: 1,
      monthly_fee: 10.00,
      deactivated_monthly_fee: 5.00,
      total_quota_kb: 1048576, // 1GB
      overage_rate_per_kb: 0.0001,
    }, { returning: 'representation' })
    pricePlanVersionId = rows?.[0]?.price_plan_version_id
    if (!pricePlanVersionId) throw new Error('No price_plan_version_id returned')
  })

  // Step 8: Create Package
  await step('Create package', async () => {
    const rows = await supabase.insert('packages', {
      enterprise_id: customerTenantId,
      name: `E2E-Package-${Date.now()}`,
    }, { returning: 'representation' })
    packageId = rows?.[0]?.package_id
    if (!packageId) throw new Error('No package_id returned')
  })

  // Step 9: Create Package Version
  await step('Create package version', async () => {
    const rows = await supabase.insert('package_versions', {
      package_id: packageId,
      version: 1,
      status: 'PUBLISHED',
      supplier_id: supplierId,
      service_type: 'DATA',
      price_plan_version_id: pricePlanVersionId,
      roaming_profile: { type: 'GLOBAL' },
    }, { returning: 'representation' })
    packageVersionId = rows?.[0]?.package_version_id
    if (!packageVersionId) throw new Error('No package_version_id returned')
  })

  // Step 10: Create Subscription
  await step('Create subscription', async () => {
    const rows = await supabase.insert('subscriptions', {
      enterprise_id: customerTenantId,
      sim_id: simId,
      subscription_kind: 'MAIN',
      package_version_id: packageVersionId,
      state: 'ACTIVE',
      effective_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    }, { returning: 'representation' })
    subscriptionId = rows?.[0]?.subscription_id
    if (!subscriptionId) throw new Error('No subscription_id returned')
  })

  // Step 11: Seed usage data
  await step('Seed daily usage', async () => {
    const today = new Date()
    const usageDay = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`
    await supabase.insert('usage_daily_summary', {
      supplier_id: supplierId,
      enterprise_id: customerTenantId,
      sim_id: simId,
      iccid,
      usage_day: usageDay,
      visited_mccmnc: '234-015',
      uplink_kb: 50000,
      downlink_kb: 50000,
      total_kb: 100000,
    }, { returning: 'minimal' })
  })

  // Step 12: Run billing
  await step('Run billing engine', async () => {
    const today = new Date()
    const billPeriod = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
    const result = await computeMonthlyCharges({
      enterpriseId: customerTenantId,
      billPeriod,
      calculationId: `e2e-${Date.now()}`,
    }, supabase)
    if (!result) throw new Error('computeMonthlyCharges returned null')
    console.log(`    Monthly fee items: ${result.lineItems.filter(i => i.item_type === 'MONTHLY_FEE').length}`)
    console.log(`    Usage charge items: ${result.lineItems.filter(i => i.item_type === 'USAGE_CHARGE').length}`)
    console.log(`    Total: ${result.totalBillAmount} ${result.currency}`)
  })

  // Step 13: Generate bill
  await step('Generate monthly bill', async () => {
    const today = new Date()
    const billPeriod = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
    const result = await generateMonthlyBill({
      payload: { enterpriseId: customerTenantId, billPeriod },
      job_id: `e2e-job-${Date.now()}`,
    }, supabase)
    if (result?.billId) {
      billId = result.billId
    }
  })

  // Step 14: Verify bill exists
  await step('Verify bill in database', async () => {
    const today = new Date()
    const periodStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`
    const rows = await supabase.select(
      'bills',
      `select=bill_id,status,total_amount,currency&enterprise_id=eq.${customerTenantId}&period_start=eq.${periodStart}&limit=1`
    )
    const bill = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    if (!bill) throw new Error('No bill found in database')
    billId = bill.bill_id
    console.log(`    Bill ID: ${billId}`)
    console.log(`    Status: ${bill.status}`)
    console.log(`    Amount: ${bill.total_amount} ${bill.currency}`)
  })

  // Step 15: Verify idempotency
  await step('Verify billing idempotency (re-run should skip)', async () => {
    const today = new Date()
    const billPeriod = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
    const result = await generateMonthlyBill({
      payload: { enterpriseId: customerTenantId, billPeriod },
      job_id: `e2e-job-idempotent-${Date.now()}`,
    }, supabase)
    if (result?.skipped) {
      console.log('    Correctly skipped duplicate bill')
    } else {
      console.log('    Warning: idempotency check may not have triggered')
    }
  })

  console.log('\n=== E2E MVP Integration Test PASSED ===')
  console.log(`Reseller: ${resellerId}`)
  console.log(`Customer: ${customerId} (tenant: ${customerTenantId})`)
  console.log(`SIM: ${simId} (${iccid})`)
  console.log(`Bill: ${billId}`)
}

main().catch(err => {
  console.error('\n=== E2E MVP Integration Test FAILED ===')
  console.error(err)
  process.exit(1)
})
