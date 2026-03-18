const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function check() {
  const iccid = process.env.SMOKE_SIM_ICCID || '893107032536638556'
  console.log(`Checking SIM ${iccid}...`)
  
  // 1. Check SIM
  const { data, error } = await supabase.from('sims').select('iccid, enterprise_id').eq('iccid', iccid).single()
  
  if (error) {
    console.error('Error fetching SIM:', error)
    return
  }
  
  console.log('SIM found:', data)
  
  if (!data.enterprise_id) {
    console.log('SIM has no enterprise_id. Assigning one...')
    
    // 2. Find an enterprise
    const { data: ent, error: entErr } = await supabase.from('enterprises').select('enterprise_id').limit(1).single()
    
    if (entErr || !ent) {
        console.error('No enterprise found. Creating one...')
        // Create an enterprise if none exists
        const newEnt = {
            name: 'Smoke Test Enterprise',
            status: 'ACTIVE'
        }
        const { data: createdEnt, error: createErr } = await supabase.from('enterprises').insert(newEnt).select().single()
        if (createErr) {
            console.error('Failed to create enterprise:', createErr)
            return
        }
        console.log('Created enterprise:', createdEnt)
        
        // Assign to SIM
        const { error: updErr } = await supabase.from('sims').update({ enterprise_id: createdEnt.enterprise_id }).eq('iccid', iccid)
        if (updErr) console.error('Update error:', updErr)
        else console.log(`Assigned NEW enterprise ${createdEnt.enterprise_id} to SIM ${iccid}`)
        
    } else {
        console.log('Found enterprise:', ent)
        // Assign to SIM
        const { error: updErr } = await supabase.from('sims').update({ enterprise_id: ent.enterprise_id }).eq('iccid', iccid)
        if (updErr) console.error('Update error:', updErr)
        else console.log(`Assigned enterprise ${ent.enterprise_id} to SIM ${iccid}`)
    }
  } else {
      console.log(`SIM already has enterprise_id: ${data.enterprise_id}`)
  }
}

check()
