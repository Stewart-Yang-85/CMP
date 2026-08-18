import fs from 'fs'

const assignments = [
  { path: '/sims/import-jobs:', method: 'post', order: 1 },
  { path: '/sims:', method: 'get', order: 2 },
  { path: '/sims:csv:', method: 'get', order: 3 },
  { path: '/enterprises/{enterpriseId}/sims:', method: 'get', order: 4 },
  { path: '/enterprises/{enterpriseId}/sims:csv:', method: 'get', order: 5 },
  { path: '/sims:assign-inventory-to-enterprise:', method: 'post', order: 6 },
  { path: '/sims:assign-to-department:', method: 'post', order: 7 },
  { path: '/sims/{iccid}:', method: 'get', order: 8 },
  { path: '/sims/{iccid}:', method: 'patch', order: 9 },
  { path: '/sims:batch-status-change:', method: 'post', order: 10 },
  { path: '/sims/{iccid}/subscriptions:', method: 'get', order: 11 },
  { path: '/sims/{iccid}/usage:', method: 'get', order: 12 },
  { path: '/sims/{iccid}/usage:csv:', method: 'get', order: 13 },
  { path: '/sims/{iccid}/quota-balance:', method: 'get', order: 14 },
  { path: '/sims:batch-deactivate:', method: 'post', order: 15 },
]

function patchFile(file) {
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const { path: pathKey, method, order } of assignments) {
    const pathIdx = text.indexOf(`  ${pathKey}\n`)
    if (pathIdx < 0) throw new Error(`${file}: path not found: ${pathKey}`)
    const methodNeedle = `\n    ${method}:\n`
    const methodIdx = text.indexOf(methodNeedle, pathIdx)
    if (methodIdx < 0) throw new Error(`${file}: ${method} not found under ${pathKey}`)
    const tagsNeedle = '\n      tags: [SIMs]\n'
    const tagsIdx = text.indexOf(tagsNeedle, methodIdx)
    if (tagsIdx < 0 || tagsIdx > methodIdx + 800) {
      throw new Error(`${file}: tags: [SIMs] not found for ${method} ${pathKey}`)
    }
    const insertAt = tagsIdx + tagsNeedle.length
    const sortLine = `      x-sort-order: ${order}\n`
    const window = text.slice(insertAt, insertAt + 80)
    if (window.startsWith('      x-sort-order:')) {
      text = text.slice(0, insertAt) + sortLine + text.slice(insertAt).replace(/^      x-sort-order: \d+\n/, '')
      continue
    }
    text = text.slice(0, insertAt) + sortLine + text.slice(insertAt)
  }
  fs.writeFileSync(file, text)
  console.log(`Patched x-sort-order in ${file}`)
}

for (const file of ['iot-cmp-api.yaml', 'packages/openapi/openapi.yaml']) {
  patchFile(file)
}
