import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

async function main() {
  console.log('Checking for upstream_status column in sims table...')
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  try {
    // Try to select the new column
    const result = await supabase.select('sims', 'select=upstream_status&limit=1')
    console.log('SUCCESS: Column upstream_status exists.')
  } catch (err) {
    console.log('FAILURE: Could not select upstream_status.')
    console.log('Error message:', err.message)
    if (err.body) console.log('Error body:', err.body)
  }
}

main()
