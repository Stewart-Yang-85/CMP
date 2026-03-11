import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { generateMonthlyBill } from '../src/billing.js'

async function main() {
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const runId = Date.now().toString().slice(-6)
  const randomMnc = String(Math.floor(Math.random() * 900) + 100)
  
  console.log(`Setting up E2E billing test data (Run ID: ${runId})...`)

  try {
    // 1. Create Supplier & Carrier
    // insert returns array
    const suppliers = await supabase.insert('suppliers', { name: `E2E_Supplier_${runId}` })
    const supplierId = suppliers[0].supplier_id
    
    const carriers = await supabase.insert('carriers', { mcc: '999', mnc: randomMnc, name: `E2E_Carrier_${runId}` })
    const carrierId = carriers[0].carrier_id
    const bizRows = await supabase.select(
      'business_operators',
      `select=operator_id&mcc=eq.999&mnc=eq.${encodeURIComponent(randomMnc)}&limit=1`
    )
    if (!Array.isArray(bizRows) || bizRows.length === 0) {
      await supabase.insert('business_operators', { mcc: '999', mnc: randomMnc, name: `E2E_Carrier_${runId}` })
    }
    const existingOperators = await supabase.select(
      'operators',
      `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&carrier_id=eq.${encodeURIComponent(carrierId)}&limit=1`
    )
    const operatorRow = Array.isArray(existingOperators) && existingOperators.length > 0
      ? existingOperators[0]
      : (await supabase.insert('operators', { supplier_id: supplierId, carrier_id: carrierId, name: `E2E_Carrier_${runId}` }))[0]
    const operatorId = operatorRow.operator_id
    
    // 2. Create Tenant (Enterprise)
    const tenants = await supabase.insert('tenants', { 
        name: 'E2E_Enterprise', 
        tenant_type: 'ENTERPRISE',
        code: `E2E_${Date.now()}`
    })
    const enterpriseId = tenants[0].tenant_id

    // 3. Create Price Plan & Version
    const plans = await supabase.insert('price_plans', {
        enterprise_id: enterpriseId,
        name: 'E2E_Plan',
        type: 'FIXED_BUNDLE',
        currency: 'USD'
    })
    const planId = plans[0].price_plan_id

    const ppvs = await supabase.insert('price_plan_versions', {
        price_plan_id: planId,
        version: 1,
        monthly_fee: 10.00,
        payg_rates: {
            zones: {
                "ZONE_E2E": {
                    ratePerKb: 0.01,
                    mccmnc: ["424-02"] // Test roaming network
                }
            }
        }
    })
    const ppvId = ppvs[0].price_plan_version_id

    // 4. Create Package & Version
    const pkgs = await supabase.insert('packages', {
        enterprise_id: enterpriseId,
        name: `E2E_Package_${runId}`
    })
    const pkgId = pkgs[0].package_id

    const pkgvs = await supabase.insert('package_versions', {
        package_id: pkgId,
        version: 1,
        supplier_id: supplierId,
        carrier_id: carrierId,
        operator_id: operatorId,
        price_plan_version_id: ppvId,
        roaming_profile: {
            type: 'MCCMNC_ALLOWLIST',
            mccmnc: [`999-${randomMnc}`] // Home network only, so 424-02 will be roaming/PAYG
        }
    })
    const pkgvId = pkgvs[0].package_version_id

    // 5. Create SIM
    const iccid = `89999${Date.now()}`.slice(0, 20)
    const sims = await supabase.insert('sims', {
        iccid: iccid,
        primary_imsi: `99999${Date.now()}`.slice(0, 15),
        supplier_id: supplierId,
        carrier_id: carrierId,
        operator_id: operatorId,
        enterprise_id: enterpriseId,
        status: 'ACTIVATED'
    })
    const simId = sims[0].sim_id

    // 6. Create Subscription
    await supabase.insert('subscriptions', {
        enterprise_id: enterpriseId,
        sim_id: simId,
        package_version_id: pkgvId,
        subscription_kind: 'MAIN',
        effective_at: new Date().toISOString()
    })

    // 7. Insert Usage
    // Usage in 424-02 (PAYG zone)
    const usageDay = new Date().toISOString().slice(0, 10)
    await supabase.insert('usage_daily_summary', {
        supplier_id: supplierId,
        enterprise_id: enterpriseId,
        sim_id: simId,
        iccid: iccid,
        usage_day: usageDay,
        visited_mccmnc: '424-02',
        total_kb: 1000,
        uplink_kb: 500,
        downlink_kb: 500
    })

    console.log(`Data setup complete. Enterprise: ${enterpriseId}, SIM: ${iccid}`)

    // 8. Create Billing Job
    const billPeriod = usageDay.slice(0, 7) // YYYY-MM
    // Workaround: 'jobs' table might be missing 'payload' column in some environments.
    // We store the payload in 'request_id' as a JSON string.
    const payloadObj = { enterpriseId, billPeriod }
    const jobs = await supabase.insert('jobs', {
        job_type: 'BILLING_GENERATE',
        status: 'QUEUED',
        request_id: JSON.stringify(payloadObj)
    })
    const jobId = jobs[0].job_id

    console.log(`Job created: ${jobId}. Running billing generation...`)
    await generateMonthlyBill({
        job_id: jobId,
        payload: { enterpriseId, billPeriod }
    }, supabase)
    await supabase.update('jobs', `job_id=eq.${jobId}`, {
        status: 'SUCCEEDED',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        progress_processed: 1,
        progress_total: 1
    }, { returning: 'minimal' })
    console.log('Job SUCCEEDED.')

    // 10. Verify Bill
    // Start date and end date logic in billing.js:
    // startDate = YYYY-MM-01, endDate = next month
    const startDate = `${billPeriod}-01`
    // We query by enterprise_id and period_start
    const bills = await supabase.select('bills', `select=*&enterprise_id=eq.${enterpriseId}&period_start=eq.${startDate}`)
    
    if (!bills || bills.length === 0) {
        console.error('No bill found!')
        process.exit(1)
    }

    const bill = bills[0]
    console.log('Bill generated:', bill)
    
    // Expected:
    // Monthly Fee: 10.00
    // Usage: 1000KB * 0.01 = 10.00
    // Total: 20.00
    
    if (Number(bill.total_amount) === 20.00) {
        console.log('SUCCESS: Bill total matches expected amount (20.00).')
    } else {
        console.error(`FAILURE: Bill total ${bill.total_amount} does not match expected 20.00`)
        
        // Debug line items
        const items = await supabase.select('bill_line_items', `select=*&bill_id=eq.${bill.bill_id}`)
        console.log('Line Items:', JSON.stringify(items, null, 2))
    }

  } catch (err) {
    console.error('Test failed:', err)
    process.exit(1)
  }
}

main()
