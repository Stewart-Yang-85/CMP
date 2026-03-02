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
  const pkgs = await c.select('packages', `enterprise_id=eq.${encodeURIComponent(ent)}&select=package_id,name,created_at&order=created_at.desc&limit=10`)
  const pkgIds = Array.isArray(pkgs) ? pkgs.map((p) => p.package_id) : []
  process.stdout.write(`packages.count=${Array.isArray(pkgs) ? pkgs.length : 0}\n`)
  if (pkgIds.length > 0) {
    const pv = await c.select('package_versions', `package_id=in.(${pkgIds.map((id) => encodeURIComponent(id)).join(',')})&select=package_version_id,package_id,version,status,service_type,created_at&order=created_at.desc`)
    process.stdout.write(`package_versions.count=${Array.isArray(pv) ? pv.length : 0}\n`)
  } else {
    process.stdout.write('package_versions.count=0\n')
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  if (err && err.body) {
    process.stderr.write(`${String(err.body)}\n`)
  }
  process.exit(1)
})
