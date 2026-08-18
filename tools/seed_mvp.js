/**
 * Seed script for MVP test data.
 * Creates test reseller, customer, supplier, and operator via Supabase RPC.
 * Usage: node tools/seed_mvp.js
 *
 * FR-058: 对外 API / JWT / 路径中的「代理商 id」= RESELLER `tenants.tenant_id`。
 * `create_customer` RPC 的 `p_reseller_id` 仍为库内 `resellers.id`（由 create_reseller 返回的 `reseller_id`）。
 * `reseller_suppliers.reseller_id` 等 FK → tenants 的列使用 `tenant_id`。
 */
import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

/** REST 客户端将 PG 23505 映射为 ClientError.code === 'DUPLICATE' */
function isUniqueViolation(err) {
  return (
    err?.code === '23505' ||
    err?.code === 'DUPLICATE' ||
    err?.body?.code === '23505' ||
    String(err?.message || '').toLowerCase().includes('duplicate') ||
    String(err?.message || '').includes('already exists')
  )
}

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
    if (isUniqueViolation(err)) {
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

  const resellerRecordId = reseller.reseller_id || reseller.id
  const resellerTenantId = reseller.tenant_id
  if (!resellerRecordId) {
    console.error('[Seed] FAILED: reseller row missing resellers.id / reseller_id')
    process.exit(1)
  }
  if (!resellerTenantId) {
    console.error('[Seed] FAILED: reseller row missing tenant_id (required for reseller_suppliers / API id)')
    process.exit(1)
  }
  console.log('[Seed] Reseller tenant_id (API paths / JWT / curl):', resellerTenantId)
  console.log('[Seed] Reseller resellers.id (create_customer RPC only):', resellerRecordId)

  console.log('[Seed] Creating test customer via RPC...')
  let customer
  try {
    const result = await supabase.rpc('create_customer', {
      p_reseller_id: resellerRecordId,
      p_name: 'Test Enterprise MVP',
      p_auto_suspend_enabled: true,
    })
    customer = result
    console.log('[Seed] Customer created:', JSON.stringify(customer))
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.log('[Seed] Customer already exists, fetching...')
      const rows = await supabase.select(
        'tenants',
        `select=*&name=eq.Test%20Enterprise%20MVP&tenant_type=eq.ENTERPRISE&limit=1`
      )
      customer = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
      console.log('[Seed] Existing customer:', JSON.stringify(customer))
    } else {
      throw err
    }
  }

  console.log('[Seed] Ensuring test supplier (idempotent by name)...')
  let supplier
  const existingSuppliers = await supabase.select(
    'suppliers',
    'select=*&name=eq.Test%20Supplier%20MVP&limit=1'
  )
  if (Array.isArray(existingSuppliers) && existingSuppliers.length > 0) {
    supplier = existingSuppliers[0]
    console.log('[Seed] Supplier already present:', JSON.stringify(supplier))
  } else {
    const rows = await supabase.insert(
      'suppliers',
      {
        name: 'Test Supplier MVP',
        status: 'ACTIVE',
      },
      { returning: 'representation' }
    )
    supplier = Array.isArray(rows) ? rows[0] : null
    console.log('[Seed] Supplier created:', JSON.stringify(supplier))
  }

  if (supplier?.supplier_id && resellerTenantId) {
    const sid = String(supplier.supplier_id)
    console.log('[Seed] Linking supplier to reseller...')
    const existingLink = await supabase.select(
      'reseller_suppliers',
      `select=reseller_id&reseller_id=eq.${encodeURIComponent(resellerTenantId)}&supplier_id=eq.${encodeURIComponent(sid)}&limit=1`
    )
    if (Array.isArray(existingLink) && existingLink.length > 0) {
      console.log('[Seed] Reseller-Supplier link already exists')
    } else {
      try {
        await supabase.insert(
          'reseller_suppliers',
          {
            reseller_id: resellerTenantId,
            supplier_id: sid,
          },
          { returning: 'minimal' }
        )
        console.log('[Seed] Reseller-Supplier link created')
      } catch (err) {
        if (isUniqueViolation(err)) {
          console.log('[Seed] Reseller-Supplier link already exists')
        } else {
          console.warn('[Seed] Warning linking supplier:', err?.message)
        }
      }
    }
  }

  console.log('[Seed] MVP seed data complete!')
  console.log('[Seed] Summary:')
  console.log('  Reseller:', reseller?.name || resellerTenantId, `(tenant_id=${resellerTenantId})`)
  console.log('  Enterprise:', customer?.name || customer?.tenant_id || customer?.customer_id)
  console.log('  Supplier:', supplier?.name || supplier?.supplier_id)
}

main().catch(err => {
  console.error('[Seed] FATAL:', err)
  process.exit(1)
})
