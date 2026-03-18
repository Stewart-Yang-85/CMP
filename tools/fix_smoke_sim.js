import 'dotenv/config'
import { createSupabaseRestClient } from '../src/supabaseRest.js'

async function check() {
  const iccid = process.env.SMOKE_SIM_ICCID || '893107032536638556'
  console.log(`Checking SIM ${iccid}...`)
  
  const client = createSupabaseRestClient({ useServiceRole: true })
  
  // Check SIM
  // client.select returns data array directly (based on src/supabaseRest.js logic for simple select?)
  // Wait, src/supabaseRest.js:
  // select(table, queryString) { ... return JSON.parse(text) }
  
  const sims = await client.select('sims', `iccid=eq.${iccid}&select=iccid,enterprise_id&limit=1`)
  
  if (!sims || sims.length === 0) {
      console.log('SIM not found!')
      return
  }
  
  const sim = sims[0]
  console.log('SIM found:', sim)
  
  if (!sim.enterprise_id) {
    console.log('SIM has no enterprise_id. Assigning one...')
    
    // Find an enterprise
    const ents = await client.select('enterprises', 'limit=1&select=enterprise_id')
    let entId = null
    
    if (!ents || ents.length === 0) {
        console.log('No enterprise found. Creating one...')
        const newEnt = {
            name: 'Smoke Test Enterprise',
            status: 'ACTIVE'
        }
        const created = await client.insert('enterprises', newEnt)
        if (created && created.length > 0) {
            entId = created[0].enterprise_id
            console.log('Created enterprise:', entId)
        } else {
            console.error('Failed to create enterprise')
            return
        }
    } else {
        entId = ents[0].enterprise_id
        console.log('Found enterprise:', entId)
    }
    
    // Assign to SIM
    await client.update('sims', `iccid=eq.${iccid}`, { enterprise_id: entId })
    console.log(`Assigned enterprise ${entId} to SIM ${iccid}`)
    
  } else {
      console.log(`SIM already has enterprise_id: ${sim.enterprise_id}`)
  }
}

check()
