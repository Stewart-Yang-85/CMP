import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

async function main() {
  const supabase = createSupabaseRestClient({ useServiceRole: true })
  const iccid = '893107032536638556'
  
  console.log(`Checking SIM ${iccid}...`)
  const rows = await supabase.select('sims', `select=iccid,enterprise_id,status&iccid=eq.${iccid}`)
  
  if (!rows || rows.length === 0) {
    console.log('SIM not found.')
  } else {
    const sim = rows[0]
    console.log('SIM found:', sim)
    if (sim.enterprise_id) {
      console.log('Enterprise ID:', sim.enterprise_id)
      const ent = await supabase.select('tenants', `select=tenant_id,name&tenant_id=eq.${sim.enterprise_id}`)
      console.log('Enterprise:', ent)
    } else {
      console.log('No enterprise assigned.')
    }
  }
}

main().catch(console.error)
