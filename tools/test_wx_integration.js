import { createWxzhonggengClient } from '../src/vendors/wxzhonggeng.js'
import dotenv from 'dotenv'

dotenv.config()

async function run() {
  console.log('Initializing WXZHONGGENG Client...')
  const client = createWxzhonggengClient()
  
  const iccid = '893107032536638542'
  console.log(`\nTesting getSimStatus for ICCID: ${iccid}`)
  
  try {
    const result = await client.getSimStatus(iccid)
    console.log('Result:', JSON.stringify(result, null, 2))
    
    if (result && result.success) {
      console.log('✅ getSimStatus SUCCESS')
    } else {
      console.log('❌ getSimStatus FAILED (API returned failure)')
    }

    // Test getUsage
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    console.log(`\nTesting getUsage for ICCID: ${iccid} Date: ${today}`)
    try {
      const usage = await client.getUsage(iccid, today)
      console.log('Usage Result:', JSON.stringify(usage, null, 2))
      if (usage) {
        console.log('✅ getUsage SUCCESS')
      } else {
        console.log('⚠️ getUsage RETURNED NULL (Maybe no usage for today?)')
      }
    } catch (err) {
      console.error('❌ getUsage ERROR:', err.message)
    }

  } catch (err) {
    console.error('❌ getSimStatus ERROR:', err.message)
  }
}

run()
