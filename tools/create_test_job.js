import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

async function main() {
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  
  console.log('Creating test job...')
  // Note: This requires the 'payload' column to be added to the 'jobs' table.
  // Run: supabase/migrations/0016_jobs_payload.sql
  
  const { data, error } = await supabase.insert('jobs', {
    job_type: 'ASYNC_SIM_ACTIVATION',
    status: 'QUEUED',
    payload: { iccid: '893107032536638556', targetStatus: 'ACTIVATED' },
    progress_processed: 0,
    progress_total: 100
  })

  if (error) {
    console.error('Failed to create job:', error)
    process.exit(1)
  } else {
    console.log('Job created successfully.')
    if (Array.isArray(data) && data.length > 0) {
        console.log('Job ID:', data[0].job_id)
    }
  }
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
