import fs from 'fs'

const simOrder = [
  '/sims/import-jobs:',
  '/sims:',
  '/sims:csv:',
  '/enterprises/{enterpriseId}/sims:',
  '/enterprises/{enterpriseId}/sims:csv:',
  '/sims:assign-inventory-to-enterprise:',
  '/sims:assign-to-department:',
  '/sims/{iccid}:',
  '/sims:batch-status-change:',
  '/sims/{iccid}/subscriptions:',
  '/sims/{iccid}/usage:',
  '/sims/{iccid}/usage:csv:',
  '/sims/{iccid}/quota-balance:',
  '/sims:batch-deactivate:',
]

const jobsOrder = ['/jobs/{jobId}:', '/jobs/{jobId}:cancel:']

function splitPathBlocks(sectionBody) {
  const lines = sectionBody.split(/\r?\n/)
  const blocks = new Map()
  let currentKey = null
  let currentLines = []
  let pendingPrefix = []

  const flush = () => {
    if (currentKey) blocks.set(currentKey, currentLines.join('\n') + (currentLines.length ? '\n' : ''))
  }

  for (const line of lines) {
    const pathMatch = line.match(/^  (\/.+):$/)
    if (pathMatch) {
      flush()
      currentKey = pathMatch[1] + ':'
      currentLines = [...pendingPrefix, line]
      pendingPrefix = []
    } else if (currentKey) {
      currentLines.push(line)
    } else if (line.trim()) {
      pendingPrefix.push(line)
    }
  }
  flush()
  return blocks
}

function reorderFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  const start = text.indexOf('  # --- SIM Management ---')
  const diag = text.indexOf('  # --- Diagnostics ---', start)
  if (start < 0 || diag < 0) throw new Error(`markers not found in ${file}`)

  const before = text.slice(0, start)
  const simSection = text.slice(start, diag)
  const after = text.slice(diag)

  const header = '  # --- SIM Management ---\n'
  const body = simSection.startsWith(header) ? simSection.slice(header.length) : simSection
  const blocks = splitPathBlocks(body)

  const orderedKeys = [...simOrder, ...jobsOrder]
  const missing = orderedKeys.filter((k) => !blocks.has(k))
  const extra = [...blocks.keys()].filter((k) => !orderedKeys.includes(k))
  if (missing.length) throw new Error(`${file}: missing paths: ${missing.join(', ')}`)
  if (extra.length) throw new Error(`${file}: unexpected paths in SIM section: ${extra.join(', ')}`)

  const reordered = header + orderedKeys.map((k) => blocks.get(k)).join('\n')
  fs.writeFileSync(file, before + reordered + after)
  console.log(`Reordered SIM paths in ${file}`)
}

for (const file of ['iot-cmp-api.yaml', 'packages/openapi/openapi.yaml']) {
  reorderFile(file)
}
