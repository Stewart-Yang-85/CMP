import 'dotenv/config'
import crypto from 'node:crypto'
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
  if (!v) {
    throw new Error(`Missing --${name}`)
  }
  return v
}

function generateSecret() {
  return crypto.randomBytes(24).toString('base64url')
}

async function main() {
  const clientId = requireArg('clientId')
  const enterpriseId = requireArg('enterpriseId')
  const clientSecret = getArg('clientSecret') || generateSecret()

  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const secretHash = hashSecretScrypt(clientSecret)

  const rows = await supabase.insert('api_clients', {
    client_id: clientId,
    secret_hash: secretHash,
    enterprise_id: enterpriseId,
    status: 'ACTIVE',
  })

  const created = Array.isArray(rows) ? rows[0] : null
  if (!created) {
    throw new Error('Failed to create api client.')
  }

  process.stdout.write(`clientId=${clientId}\n`)
  process.stdout.write(`clientSecret=${clientSecret}\n`)
  process.stdout.write(`enterpriseId=${enterpriseId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  process.exit(1)
})

