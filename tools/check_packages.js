import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

function getEnv(name) {
  const v = process.env[name]
  return v ? String(v) : null
}

async function main() {
  const c = createSupabaseRestClient({ useServiceRole: true })
  const ent = getEnv('AUTH_ENTERPRISE_ID')
  if (!ent) {
    process.stderr.write('Missing AUTH_ENTERPRISE_ID\n')
    process.exit(1)
  }
  const pkgs = await c.select(
    'packages',
    `enterprise_id=eq.${encodeURIComponent(ent)}&select=package_id,name,status,created_at&order=created_at.desc&limit=10`
  )
  process.stdout.write(`packages.count=${Array.isArray(pkgs) ? pkgs.length : 0}\n`)
  if (Array.isArray(pkgs) && pkgs.length > 0) {
    const published = pkgs.filter((p) => String(p.status || '').toUpperCase() === 'PUBLISHED').length
    process.stdout.write(`packages.published=${published}\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  if (err && err.body) {
    process.stderr.write(`${String(err.body)}\n`)
  }
  process.exit(1)
})
