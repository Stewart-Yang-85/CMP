import 'dotenv/config'
import { createApp } from './app.js'

const app = createApp()
const port = process.env.PORT ? Number(process.env.PORT) : 3000
const host = process.env.HOST ? String(process.env.HOST) : '0.0.0.0'

app.listen({ port, host })
  .then(() => {
    process.stdout.write(`API listening on http://${host}:${port}\n`)
  })
  .catch((err) => {
    process.stderr.write(String(err?.stack ?? err))
    process.exit(1)
  })
