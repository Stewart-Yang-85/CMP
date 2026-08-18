/**
 * Create an interactive platform_admin user (email + password) for Portal login.
 *
 * Backend has no POST API for platform_admin users (only reseller/enterprise users).
 * This one-off tool inserts into `users` + `user_roles` via service role.
 *
 * Usage (from 04_Project_CMP_v1.1, with .env loaded):
 *   node tools/create_platform_admin_user.js --email admin@example.com --password 'ChangeMe123!'
 *   node tools/create_platform_admin_user.js --email admin@example.com --password '...' --displayName 'Platform Admin'
 *   node tools/create_platform_admin_user.js --email admin@example.com --password '...' --tenantId <uuid>
 *
 * Notes:
 * - users.tenant_id is NOT NULL; if --tenantId omitted, attaches to first RESELLER tenant
 *   (JWT still has role=platform_admin / roleScope=platform).
 * - Re-run with same email under same tenant updates password_hash and ensures role.
 */
import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'
import { hashSecretScrypt } from '../src/password.js'

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return null
  const v = process.argv[idx + 1]
  if (!v || v.startsWith('--')) return null
  return v
}

function requireArg(name) {
  const v = getArg(name)
  if (!v) throw new Error(`Missing --${name}`)
  return v
}

async function main() {
  const email = requireArg('email').trim().toLowerCase()
  const password = requireArg('password')
  const displayName = getArg('displayName') || 'Platform Admin'
  let tenantId = getArg('tenantId')

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .env')
  }

  const supabase = createSupabaseRestClient({ useServiceRole: true })

  if (!tenantId) {
    const rows = await supabase.select(
      'tenants',
      'select=tenant_id,name,tenant_type&tenant_type=eq.RESELLER&order=created_at.asc&limit=1',
    )
    const first = Array.isArray(rows) ? rows[0] : null
    if (!first?.tenant_id) {
      throw new Error(
        'No RESELLER tenant found. Create a reseller first, or pass --tenantId <uuid>.',
      )
    }
    tenantId = String(first.tenant_id)
    console.log(`Using tenant ${tenantId} (${first.name ?? first.tenant_type})`)
  }

  const existing = await supabase.select(
    'users',
    `select=user_id,email,status,tenant_id&email=eq.${encodeURIComponent(email)}&tenant_id=eq.${encodeURIComponent(tenantId)}&limit=1`,
  )
  const row = Array.isArray(existing) ? existing[0] : null
  const passwordHash = hashSecretScrypt(password)

  let userId
  if (row?.user_id) {
    userId = String(row.user_id)
    await supabase.update(
      'users',
      `user_id=eq.${encodeURIComponent(userId)}`,
      {
        password_hash: passwordHash,
        display_name: displayName,
        status: 'ACTIVE',
      },
    )
    console.log(`Updated existing user ${userId}`)
  } else {
    const inserted = await supabase.insert('users', {
      tenant_id: tenantId,
      email,
      display_name: displayName,
      status: 'ACTIVE',
      password_hash: passwordHash,
    })
    const created = Array.isArray(inserted) ? inserted[0] : null
    if (!created?.user_id) throw new Error('Failed to insert user')
    userId = String(created.user_id)
    console.log(`Created user ${userId}`)
  }

  const roles = await supabase.select(
    'user_roles',
    `select=user_id,role_name&user_id=eq.${encodeURIComponent(userId)}&role_name=eq.platform_admin&limit=1`,
  )
  const hasRole = Array.isArray(roles) && roles.length > 0
  if (!hasRole) {
    await supabase.insert('user_roles', { user_id: userId, role_name: 'platform_admin' }, { returning: 'minimal' })
    console.log('Assigned role platform_admin')
  } else {
    console.log('Role platform_admin already present')
  }

  console.log('\nPortal login:')
  console.log(`  email:    ${email}`)
  console.log(`  password: (as provided)`)
  console.log(`  role:     platform_admin`)
}

main().catch((err) => {
  console.error(err?.message ?? err)
  process.exit(1)
})
