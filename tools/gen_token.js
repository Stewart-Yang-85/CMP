/**
 * Generate JWT tokens with any roleScope for testing.
 *
 * Usage:
 *   node tools/gen_token.js --scope platform
 *   node tools/gen_token.js --scope customer --enterpriseId <uuid>
 *   node tools/gen_token.js --scope reseller --resellerId <uuid>
 *   node tools/gen_token.js --scope department --enterpriseId <uuid> --departmentId <uuid>
 */
import 'dotenv/config'
import crypto from 'node:crypto'

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return null
  const v = process.argv[idx + 1]
  return (!v || v.startsWith('--')) ? null : v
}

function signJwtHs256(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

const scope = getArg('scope') || 'platform'
const secret = process.env.AUTH_TOKEN_SECRET
if (!secret) {
  console.error('ERROR: AUTH_TOKEN_SECRET not set in .env')
  process.exit(1)
}

const now = Math.floor(Date.now() / 1000)
const ttl = 86400

const roleMap = {
  platform: 'platform_admin',
  reseller: 'reseller_admin',
  customer: 'customer_admin',
  department: 'customer_ops',
}

const payload = {
  iss: 'iot-cmp-api',
  sub: `test-${scope}`,
  iat: now,
  exp: now + ttl,
  roleScope: scope,
  role: roleMap[scope] || scope,
}

const enterpriseId = getArg('enterpriseId')
const resellerId = getArg('resellerId')
const departmentId = getArg('departmentId')
const customerId = enterpriseId

if (enterpriseId) payload.enterpriseId = enterpriseId
if (customerId) payload.customerId = customerId
if (resellerId) payload.resellerId = resellerId
if (departmentId) payload.departmentId = departmentId

const token = signJwtHs256(payload, secret)

console.log(`\n=== ${scope.toUpperCase()} Token ===`)
console.log(`Payload: ${JSON.stringify(payload, null, 2)}`)
console.log(`\nToken (valid 24h):\n${token}\n`)
