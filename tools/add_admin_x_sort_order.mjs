import fs from 'fs'

/** Keep in sync with ADMIN_SWAGGER_OPERATIONS_ORDER in src/app.ts */
const assignments = [
  { path: '/admin/api-clients:', method: 'post', order: 1 },
  { path: '/admin/api-clients/{clientId}/deactivate:', method: 'post', order: 2 },
  { path: '/admin/api-clients/{clientId}/rotate:', method: 'post', order: 3 },
  { path: '/admin/api-clients:', method: 'get', order: 4 },
  { path: '/admin/api-clients:csv:', method: 'get', order: 5 },
  { path: '/admin/audits:', method: 'get', order: 6 },
  { path: '/admin/audits:csv:', method: 'get', order: 7 },
  { path: '/admin/events:', method: 'get', order: 8 },
  { path: '/admin/events:csv:', method: 'get', order: 9 },
  { path: '/admin/jobs:', method: 'get', order: 10 },
  { path: '/admin/jobs:csv:', method: 'get', order: 11 },
  { path: '/admin/jobs:test-ready-expiry-run:', method: 'post', order: 12 },
  { path: '/admin/sims/{iccid}:backdate-test-start:', method: 'post', order: 13 },
  { path: '/admin/wx/sims/{iccid}/status:', method: 'get', order: 14 },
  { path: '/admin/jobs:wx-sync-daily-usage:', method: 'post', order: 15 },
  { path: '/admin/jobs:wx-sync-sim-info-batch:', method: 'post', order: 16 },
  { path: '/admin/audits/{auditId}:', method: 'get', order: 17 },
  { path: '/admin/events/{eventId}:', method: 'get', order: 18 },
  { path: '/admin/jobs/{jobId}:', method: 'get', order: 19 },
]

function patchFile(file) {
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const { path: pathKey, method, order } of assignments) {
    const pathIdx = text.indexOf(`  ${pathKey}\n`)
    if (pathIdx < 0) throw new Error(`${file}: path not found: ${pathKey}`)
    const methodNeedle = `\n    ${method}:\n`
    const methodIdx = text.indexOf(methodNeedle, pathIdx)
    if (methodIdx < 0) throw new Error(`${file}: ${method} not found under ${pathKey}`)
    const insertAt = methodIdx + methodNeedle.length
    const sortLine = `      x-sort-order: ${order}\n`
    const window = text.slice(insertAt, insertAt + 80)
    if (window.startsWith('      x-sort-order:')) {
      text = text.slice(0, insertAt) + sortLine + text.slice(insertAt).replace(/^      x-sort-order: [\d.]+\n/, '')
      continue
    }
    text = text.slice(0, insertAt) + sortLine + text.slice(insertAt)
  }
  fs.writeFileSync(file, text)
  console.log(`Patched Admin x-sort-order in ${file}`)
}

for (const file of ['iot-cmp-api.yaml', 'packages/openapi/openapi.yaml']) {
  patchFile(file)
}
