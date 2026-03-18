
const { createClient } = require('@supabase/supabase-js')
const jwt = require('jsonwebtoken')
const fetch = require('node-fetch')

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const API_BASE = 'http://localhost:3000/v1'
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-jwt-token-with-at-least-32-characters-long'

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function getEnterpriseSim() {
  const { data, error } = await supabase
    .from('sims')
    .select('iccid, enterprise_id')
    .not('enterprise_id', 'is', null)
    .limit(1)
  
  if (error) throw error
  return data[0]
}

async function getEnterpriseId() {
  const { data, error } = await supabase
    .from('tenants')
    .select('tenant_id')
    .eq('tenant_type', 'ENTERPRISE')
    .limit(1)
  
  if (error) throw error
  return data[0]?.tenant_id
}

function generateToken(roleScope, role, userId = 'test-user') {
  return jwt.sign({
    sub: userId,
    roleScope,
    role,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600
  }, JWT_SECRET)
}

async function verifyCsvEndpoint() {
  console.log('Verifying /enterprises/:enterpriseId/sims:csv...')
  const enterpriseId = await getEnterpriseId()
  if (!enterpriseId) {
    console.log('No enterprise found, skipping CSV verification')
    return
  }

  // Use an enterprise user token (customer scope)
  const token = generateToken('customer', 'enterprise_admin', enterpriseId) // Usually sub is userId, but for simplicity here
  // Actually the auth middleware expects sub to be userId, and looks up role. 
  // But wait, our middleware might decode the token and trust roleScope if present?
  // Let's check src/middleware/oidcAuth.ts or just use the token structure the user provided.
  // The user provided token has: roleScope: platform, role: platform_admin.
  // But they want to test "enterprise user designed interface".
  // So I should test with an enterprise token.
  // However, `ensureSubscriptionAccess` (used in simCsvHandler) checks `auth.scope === 'customer'`.
  // The `oidcAuth` middleware sets `req.cmpAuth` from the token.
  // `getRoleScope` usually derives from `req.cmpAuth`.
  
  // Let's construct a token that mimics a customer login.
  // Usually customer login has `roleScope: 'customer'` and `customerId: enterpriseId`.
  // Wait, `getRoleScope` implementation?
  // Let's assume the token payload: { roleScope: 'customer', customerId: enterpriseId, role: 'enterprise_admin' }
  
  const customerToken = jwt.sign({
    sub: 'ent-user',
    roleScope: 'customer',
    customerId: enterpriseId,
    role: 'enterprise_admin',
    aud: 'authenticated'
  }, JWT_SECRET)

  const url = `${API_BASE}/enterprises/${enterpriseId}/sims:csv?limit=10`
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${customerToken}`,
      'Accept': 'text/csv'
    }
  })

  console.log(`CSV Response status: ${res.status}`)
  if (res.status === 200) {
    const text = await res.text()
    const firstLine = text.split('\n')[0]
    console.log(`CSV Headers: ${firstLine}`)
    
    if (firstLine.includes('supplierId') || firstLine.includes('operatorId')) {
      console.error('FAIL: CSV contains sensitive fields (supplierId/operatorId)')
    } else {
      console.log('PASS: CSV sensitive fields redacted')
    }
  } else {
    console.error(`FAIL: CSV request failed with ${res.status} ${res.statusText}`)
    console.error(await res.text())
  }
}

async function verifySubscriptionEndpoint() {
  console.log('\nVerifying /sims/:iccid/subscriptions...')
  const sim = await getEnterpriseSim()
  if (!sim) {
    console.log('No enterprise SIM found, skipping subscription verification')
    return
  }
  console.log(`Testing with ICCID: ${sim.iccid}, Enterprise: ${sim.enterprise_id}`)

  // Test with Platform Admin token (who should be able to see it without providing enterpriseId)
  const platformToken = generateToken('platform', 'platform_admin')
  
  const url = `${API_BASE}/sims/${sim.iccid}/subscriptions`
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${platformToken}`,
      'Accept': 'application/json'
    }
  })

  console.log(`Subscription Response status: ${res.status}`)
  if (res.status === 200) {
    const json = await res.json()
    console.log(`PASS: Subscription list retrieved. Count: ${json.items ? json.items.length : 0}`)
  } else {
    console.error(`FAIL: Subscription request failed with ${res.status} ${res.statusText}`)
    console.error(await res.text())
  }
}

async function main() {
  try {
    await verifyCsvEndpoint()
    await verifySubscriptionEndpoint()
  } catch (err) {
    console.error(err)
  }
}

main()
