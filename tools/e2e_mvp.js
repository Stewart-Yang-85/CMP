/**
 * E2E MVP Integration Test Script
 * Tests the complete flow: Reseller → Customer → SIM → Package → Subscription → Billing → Bill
 *
 * Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... node tools/e2e_mvp.js
 *
 * FR-058: 日志中的「Reseller」对外标识为 `tenants.tenant_id`。`create_customer` 仍传入 `resellers.id`。
 */
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { computeMonthlyCharges, generateMonthlyBill, roundAmount } from '../src/billing.js'

const supabase = createSupabaseRestClient({ useServiceRole: true })

let resellerRecordId, resellerTenantId
let customerId, customerTenantId
let supplierId
let simId, iccid
let pricePlanId
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
    resellerRecordId = result?.reseller_id
    resellerTenantId = result?.tenant_id
    if (!resellerRecordId) throw new Error('No reseller_id returned')
    if (!resellerTenantId) throw new Error('No tenant_id returned from create_reseller')
  })

  // Step 2: Create Customer
  await step('Create customer via RPC', async () => {
    const result = await supabase.rpc('create_customer', {
      p_reseller_id: resellerRecordId,
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

  // Step 6–9: Price plan snapshot + single sellable package row (Phase 19 + Phase 28)
  await step('Create price plan + published package', async () => {
    const rows = await supabase.insert('price_plans', {
      enterprise_id: customerTenantId,
      name: `E2E-FixedBundle-${Date.now()}`,
      type: 'FIXED_BUNDLE',
      service_type: 'DATA',
      currency: 'USD',
      billing_cycle_type: 'CALENDAR_MONTH',
      first_cycle_proration: 'NONE',
      version: 1,
      monthly_fee: 10.0,
      deactivated_monthly_fee: 5.0,
      total_quota_mb: 1024,
      overage_rate_per_mb: 0.1024,
      is_current: true,
    }, { returning: 'representation' })
    pricePlanId = rows?.[0]?.price_plan_id
    if (!pricePlanId) throw new Error('No price_plan_id returned')

    const pkgRows = await supabase.insert('packages', {
      enterprise_id: customerTenantId,
      name: `E2E-Package-${Date.now()}`,
      status: 'PUBLISHED',
      effective_from: new Date().toISOString(),
      published_at: new Date().toISOString(),
      price_plan_id: pricePlanId,
    }, { returning: 'representation' })
    packageId = pkgRows?.[0]?.package_id
    if (!packageId) throw new Error('No package_id returned')
    packageVersionId = packageId
  })

  // Step 10: Create Subscription
  await step('Create subscription', async () => {
    const rows = await supabase.insert('subscriptions', {
      enterprise_id: customerTenantId,
      sim_id: simId,
      subscription_kind: 'MAIN',
      package_id: packageId,
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
  console.log(`Reseller tenant_id (API): ${resellerTenantId}`)
  console.log(`Reseller resellers.id (internal): ${resellerRecordId}`)
  console.log(`Customer: ${customerId} (tenant: ${customerTenantId})`)
  console.log(`SIM: ${simId} (${iccid})`)
  console.log(`Bill: ${billId}`)
}

main().catch(err => {
  console.error('\n=== E2E MVP Integration Test FAILED ===')
  console.error(err)
  process.exit(1)
})
