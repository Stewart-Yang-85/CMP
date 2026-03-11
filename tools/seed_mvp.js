/**
 * Seed script for MVP test data.
 * Creates test reseller, customer, supplier, and operator via Supabase RPC.
 * Usage: node tools/seed_mvp.js
 */
import { createSupabaseRestClient } from '../src/supabaseRest.js'

async function main() {
  const supabase = createSupabaseRestClient({ useServiceRole: true })

  console.log('[Seed] Creating test reseller via RPC...')
  let reseller
  try {
    const result = await supabase.rpc('create_reseller', {
      p_name: 'Test Reseller MVP',
      p_contact_email: 'admin@testreselller.com',
      p_contact_phone: '+8613800138000',
      p_currency: 'CNY',
    })
    reseller = result
    console.log('[Seed] Reseller created:', JSON.stringify(reseller))
  } catch (err) {
    if (err?.code === '23505') {
      console.log('[Seed] Reseller already exists, fetching...')
      const rows = await supabase.select('resellers', 'select=*&name=eq.Test%20Reseller%20MVP&limit=1')
      reseller = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
      console.log('[Seed] Existing reseller:', JSON.stringify(reseller))
    } else {
      throw err
    }
  }

  if (!reseller) {
    console.error('[Seed] FAILED: No reseller created or found')
    process.exit(1)
  }

  const resellerId = reseller.reseller_id || reseller.id
  console.log('[Seed] Using reseller_id:', resellerId)

  console.log('[Seed] Creating test customer via RPC...')
  let customer
  try {
    const result = await supabase.rpc('create_customer', {
      p_reseller_id: resellerId,
      p_name: 'Test Enterprise MVP',
      p_auto_suspend_enabled: true,
    })
    customer = result
    console.log('[Seed] Customer created:', JSON.stringify(customer))
  } catch (err) {
    if (err?.code === '23505') {
      console.log('[Seed] Customer already exists, fetching...')
      const rows = await supabase.select('customers', `select=*&name=eq.Test%20Enterprise%20MVP&limit=1`)
      customer = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
      console.log('[Seed] Existing customer:', JSON.stringify(customer))
    } else {
      throw err
    }
  }

  console.log('[Seed] Creating test supplier...')
  let supplier
  try {
    const rows = await supabase.insert('suppliers', {
      name: 'Test Supplier MVP',
      status: 'ACTIVE',
    }, { returning: 'representation' })
    supplier = Array.isArray(rows) ? rows[0] : null
    console.log('[Seed] Supplier created:', JSON.stringify(supplier))
  } catch (err) {
    if (String(err?.body || '').includes('23505') || String(err?.message || '').includes('duplicate')) {
      console.log('[Seed] Supplier already exists, fetching...')
      const rows = await supabase.select('suppliers', 'select=*&name=eq.Test%20Supplier%20MVP&limit=1')
      supplier = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
    } else {
      throw err
    }
  }

  if (supplier && resellerId) {
    console.log('[Seed] Linking supplier to reseller...')
    try {
      await supabase.insert('reseller_suppliers', {
        reseller_id: resellerId,
        supplier_id: supplier.supplier_id,
      }, { returning: 'minimal' })
      console.log('[Seed] Reseller-Supplier link created')
    } catch (err) {
      if (String(err?.body || '').includes('23505')) {
        console.log('[Seed] Reseller-Supplier link already exists')
      } else {
        console.warn('[Seed] Warning linking supplier:', err?.message)
      }
    }
  }

  console.log('[Seed] MVP seed data complete!')
  console.log('[Seed] Summary:')
  console.log('  Reseller:', reseller?.name || resellerId)
  console.log('  Customer:', customer?.name || customer?.customer_id)
  console.log('  Supplier:', supplier?.name || supplier?.supplier_id)
}

main().catch(err => {
  console.error('[Seed] FATAL:', err)
  process.exit(1)
})
