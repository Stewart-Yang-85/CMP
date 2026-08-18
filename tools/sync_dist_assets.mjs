/**
 * Copy hand-written JS (and related JSON) from src/ into dist/ so `node dist/server.js`
 * resolves the same import paths as TypeScript emit (e.g. ./supabaseRest.js).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src')
const distDir = path.join(root, 'dist')

const files = [
  'billing.js',
  'colonUrlRewrite.js',
  'worker.js',
  'supabaseRest.js',
  'jwt.js',
  'password.js',
  'services/alertDelivery.js',
  'services/alerting.js',
  'services/resellerTenantScope.js',
  'services/publicInfo.js',
  'services/simLifecycleFinalize.js',
  'services/simStatusChangeJob.js',
  'services/subscriptionProvisionJob.js',
  'services/subscriptionScheduledCancel.js',
  'services/lateCdr.js',
  'services/usageCleaning.js',
  'vendors/wxzhonggeng.js',
  'vendors/wxzhonggeng_schema.json',
  'vendors/wxzhonggeng_config.json',
]

for (const rel of files) {
  const from = path.join(srcDir, rel)
  const to = path.join(distDir, rel)
  if (!fs.existsSync(from)) {
    process.stderr.write(`sync_dist_assets: missing source ${rel}\n`)
    process.exitCode = 1
    continue
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}
