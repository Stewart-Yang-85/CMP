import 'dotenv/config'
import pg from 'pg'
import fs from 'fs'
import path from 'path'

const { Client } = pg

async function main() {
  const dbRef = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname.split('.')[0] : null
  
  if (!dbRef) {
    console.error('Missing SUPABASE_URL')
    process.exit(1)
  }

  const dbPassword = process.env.DB_PASSWORD || process.env.SUPABASE_SERVICE_ROLE_KEY
  const dbHostRaw = process.env.DB_HOST || `db.${dbRef}.supabase.co`
  const dbHost = dbHostRaw.includes(':') && !dbHostRaw.startsWith('[') ? `[${dbHostRaw}]` : dbHostRaw
  const connectionString = process.env.DATABASE_URL || `postgres://postgres:${dbPassword}@${dbHost}:5432/postgres`
  
  console.log('Connecting to DB...')
  // console.log('Connection String:', connectionString.replace(/:[^:@]+@/, ':***@'))

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  })

  try {
    await client.connect()
    console.log('Connected to Database!')
    
    const sqlPath = path.join(process.cwd(), 'supabase/migrations/0018_add_sims_upstream_fields.sql')
    if (!fs.existsSync(sqlPath)) {
        throw new Error(`Migration file not found: ${sqlPath}`)
    }
    const sql = fs.readFileSync(sqlPath, 'utf8')
    console.log('Executing SQL...')
    await client.query(sql)
    console.log('Migration applied successfully.')
  } catch (err) {
    console.error('Migration failed:', err.message)
    console.log('\nNOTE: If authentication failed, please provide the DATABASE_URL or DB_PASSWORD in .env or run the migration manually.')
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()
