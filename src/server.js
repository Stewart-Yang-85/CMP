import 'dotenv/config'
import { createApp } from './app.js'

const app = createApp()
const port = process.env.PORT ? Number(process.env.PORT) : 3000

app.listen(port, () => {
  process.stdout.write(`API listening on http://localhost:${port}\n`)
})

