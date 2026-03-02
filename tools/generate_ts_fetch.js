import { generate } from 'openapi-typescript-codegen'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, '..')
  const input = path.resolve(root, 'iot-cmp-api.yaml')
  const output = path.resolve(root, 'gen', 'ts-fetch')
  await generate({
    input,
    output,
    httpClient: 'fetch',
    useUnionTypes: true,
    useOptions: true,
    exportCore: true,
    exportServices: true,
    exportModels: true,
    enums: true,
  })
  console.log('Generated typescript-fetch client to', output)
}

main().catch((err) => {
  console.error(err?.stack || String(err))
  process.exit(1)
})
