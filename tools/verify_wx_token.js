import 'dotenv/config'
import { createWxzhonggengClient } from '../src/vendors/wxzhonggeng.js'

async function main() {
    const apiKey = process.env.WXZHONGGENG_API_KEY
    const apiSecret = process.env.WXZHONGGENG_API_SECRET
    const url = process.env.WXZHONGGENG_URL

    console.log('--- Config Check ---')
    console.log(`URL: ${url}`)
    console.log(`API Key: ${apiKey ? apiKey.slice(0, 4) + '***' : '(missing)'}`)
    console.log(`API Secret: ${apiSecret ? apiSecret.slice(0, 4) + '***' : '(missing)'}`)

    if (!apiKey || !apiSecret || !url) {
        console.error('Missing required environment variables.')
        return
    }

    // 1. Try standard client ping
    console.log('\n--- 1. Testing client.ping() ---')
    const client = createWxzhonggengClient()
    const pingResult = await client.ping()
    console.log(`Ping result: ${pingResult}`)

    if (pingResult) {
        console.log('SUCCESS: Token fetch confirmed.')
        return
    }

    // 2. Debugging: Probe Root URL
    console.log('\n--- 2. Probing Root URL ---')
    try {
        const rootRes = await fetch(url)
        console.log(`Root Status: ${rootRes.status}`)
        const rootText = await rootRes.text()
        const titleMatch = rootText.match(/<title>(.*?)<\/title>/i)
        if (titleMatch) {
            console.log(`Page Title: ${titleMatch[1]}`)
        } else {
            console.log('No title found (might be API or JSON response)')
            if (rootText.startsWith('{')) console.log(`Root Response: ${rootText.slice(0, 100)}...`)
        }
    } catch (e) {
        console.error(`Root Probe Error: ${e.message}`)
    }

    // 4. User Provided Endpoint Test
    console.log('\n--- 4. Testing User Provided Endpoint ---')
    const userEndpoint = '/sim-user-center/api/login'
    const userUrl = url.endsWith('/') ? url.slice(0, -1) + userEndpoint : url + userEndpoint
    
    console.log(`Trying: ${userUrl}`)
    try {
        const res = await fetch(userUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                apiKey: apiKey, 
                apiSecret: apiSecret 
            })
        })
        console.log(`  Status: ${res.status}`)
        const text = await res.text()
        console.log(`  Response: ${text.slice(0, 500)}`) // Show more context
        
        if (res.ok) {
            console.log('  *** TOKEN FETCH SUCCESSFUL ***')
            let token = null
            try {
                const json = JSON.parse(text)
                console.log('  Token keys:', Object.keys(json))
                if (json.data) {
                    console.log('  Data keys:', Object.keys(json.data))
                    token = json.data.token
                }
            } catch (e) {
                console.log('  (Response is not valid JSON)')
            }

            if (token) {
                // 5. Test Query Info Endpoint
                console.log('\n--- 5. Testing Query Info Endpoint ---')
                const queryInfoEndpoint = '/sim-card-sale/card/card-info/api/queryInfo'
                const queryInfoUrl = url.endsWith('/') ? url.slice(0, -1) + queryInfoEndpoint : url + queryInfoEndpoint
                const iccid = '893107032536638542' // User provided example

                console.log(`Trying: ${queryInfoUrl}`)
                
                // Try 1: Bearer Token (Standard)
                try {
                    console.log('  Attempt 1: Authorization: Bearer <token>')
                    const infoRes = await fetch(queryInfoUrl, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({ iccid })
                    })
                    console.log(`  Status: ${infoRes.status}`)
                    const infoText = await infoRes.text()
                    console.log(`  Response: ${infoText.slice(0, 500)}`)
                    
                    if (!infoRes.ok) {
                        // Try 2: Raw Token in Authorization
                        console.log('\n  Attempt 2: Authorization: <token>')
                        const infoRes2 = await fetch(queryInfoUrl, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'Authorization': token
                            },
                            body: JSON.stringify({ iccid })
                        })
                        console.log(`  Status: ${infoRes2.status}`)
                        console.log(`  Response: ${(await infoRes2.text()).slice(0, 500)}`)

                        // Try 3: token in Header
                        console.log('\n  Attempt 3: token: <token>')
                         const infoRes3 = await fetch(queryInfoUrl, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'token': token
                            },
                            body: JSON.stringify({ iccid })
                        })
                        console.log(`  Status: ${infoRes3.status}`)
                        console.log(`  Response: ${(await infoRes3.text()).slice(0, 500)}`)
                    }

                } catch (e) {
                    console.error(`  Error: ${e.message}`)
                }

            }
        }
    } catch (e) {
        console.error(`  Error: ${e.message}`)
    }
}

main()
