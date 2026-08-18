import fs from 'node:fs'

const files = ['iot-cmp-api.yaml', 'packages/openapi/openapi.yaml']

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const lines = src.split('\n')
  const out = []
  let inAdminOperation = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    out.push(line)

    if (/^\s{6}tags: \[Admin\]\s*$/.test(line)) {
      inAdminOperation = true
      continue
    }
    if (inAdminOperation && /^\s{4}[a-z]+:\s*$/.test(line)) {
      inAdminOperation = false
    }
    if (inAdminOperation && /^\s{8}- AdminApiKeyAuth: \[\]\s*$/.test(line)) {
      const next = lines[i + 1] ?? ''
      if (!/^\s{8}- BearerAuth: \[\]\s*$/.test(next)) {
        out.push('        - BearerAuth: []')
      }
    }
  }

  fs.writeFileSync(file, out.join('\n'))
  console.log(`Updated dual admin security: ${file}`)
}
