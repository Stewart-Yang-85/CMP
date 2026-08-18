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
    
    const mnc3 = String(randomMnc).padStart(3, '0').slice(-3)
    let bizRows = await supabase.select(
      'business_operators',
      `select=operator_id&mcc=eq.999&mnc=eq.${encodeURIComponent(mnc3)}&limit=1`
    )
    if (!Array.isArray(bizRows) || bizRows.length === 0) {
      await supabase.insert('business_operators', { mcc: '999', mnc: mnc3, name: `E2E_Carrier_${runId}` })
      bizRows = await supabase.select(
        'business_operators',
        `select=operator_id&mcc=eq.999&mnc=eq.${encodeURIComponent(mnc3)}&limit=1`
      )
    }
    const businessOperatorId = Array.isArray(bizRows) && bizRows[0]?.operator_id ? bizRows[0].operator_id : null
    if (!businessOperatorId) throw new Error('business_operator_id missing')
    const existingOperators = await supabase.select(
      'operators',
      `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}&limit=1`
    )
    const operatorRow = Array.isArray(existingOperators) && existingOperators.length > 0
      ? existingOperators[0]
      : (await supabase.insert('operators', {
          supplier_id: supplierId,
          business_operator_id: businessOperatorId,
          name: `E2E_Carrier_${runId}`,
        }))[0]
    const operatorId = operatorRow.operator_id
    
    // 2. Create Tenant (Enterprise)
    const tenants = await supabase.insert('tenants', { 
        name: 'E2E_Enterprise', 
        tenant_type: 'ENTERPRISE',
        code: `E2E_${Date.now()}`
    })
    const enterpriseId = tenants[0].tenant_id

    // 3. Price plan (single-table snapshot)
    const plans = await supabase.insert('price_plans', {
      enterprise_id: enterpriseId,
      name: 'E2E_Plan',
      type: 'FIXED_BUNDLE',
      service_type: 'DATA',
      currency: 'USD',
      billing_cycle_type: 'CALENDAR_MONTH',
      first_cycle_proration: 'NONE',
      version: 1,
      monthly_fee: 10.0,
      payg_rates: {
        zones: {
          ZONE_E2E: {
            ratePerMb: 10.24,
            mccmnc: ['424-02'],
          },
        },
      },
      is_current: true,
    })
    const planId = plans[0].price_plan_id

    // 4. Sellable package row (public.packages)
    const pkgvs = await supabase.insert('packages', {
      enterprise_id: enterpriseId,
      name: `E2E_Package_${runId}`,
      status: 'PUBLISHED',
      effective_from: new Date().toISOString(),
      published_at: new Date().toISOString(),
      price_plan_id: planId,
    })
    const sellablePackageId = pkgvs[0].package_id

    // 5. Create SIM
    const iccid = `89999${Date.now()}`.slice(0, 20)
    const sims = await supabase.insert('sims', {
      iccid: iccid,
      primary_imsi: `99999${Date.now()}`.slice(0, 15),
      supplier_id: supplierId,
      operator_id: operatorId,
      enterprise_id: enterpriseId,
      status: 'ACTIVATED',
    })
    const simId = sims[0].sim_id

    // 6. Create Subscription
    await supabase.insert('subscriptions', {
      enterprise_id: enterpriseId,
      sim_id: simId,
      package_id: sellablePackageId,
      subscription_kind: 'MAIN',
      effective_at: new Date().toISOString(),
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
    // Usage: ~0.977MB * 10.24/MB = 10.00
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
