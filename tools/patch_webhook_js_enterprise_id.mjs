import fs from 'fs'

let t = fs.readFileSync('src/services/webhook.js', 'utf8')
t = t.replaceAll('customer_id', 'enterprise_id')
t = t.replaceAll('customerId', 'enterpriseId')
// createAlert API still expects customerId
t = t.replace(
  /customerId: subscription\.enterprise_id \?\? null,/g,
  'customerId: subscription.enterprise_id ?? null,'
)

const oldLoad = `async function loadSubscriptions({ supabase, enterpriseId, resellerId }) {
  const filters = ['enabled=eq.true']
  if (enterpriseId) filters.push(\`enterprise_id=eq.\${encodeURIComponent(enterpriseId)}\`)
  if (resellerId) filters.push(\`reseller_id=eq.\${encodeURIComponent(resellerId)}\`)`

const newLoad = `async function loadSubscriptions({ supabase, enterpriseId, resellerId }) {
  const filters = ['enabled=eq.true']
  if (enterpriseId) {
    filters.push(\`enterprise_id=eq.\${encodeURIComponent(enterpriseId)}\`)
  } else if (resellerId) {
    filters.push(\`reseller_id=eq.\${encodeURIComponent(resellerId)}\`)
    filters.push('enterprise_id=is.null')
  } else {
    return []
  }`

if (!t.includes(oldLoad)) {
  console.error('loadSubscriptions block not found after rename')
  process.exit(1)
}
t = t.replace(oldLoad, newLoad)

// Dedupe in dispatchWebhookEvent
const oldDispatch = `  const enterpriseId = event.enterprise_id ?? null
  const resellerId = event.reseller_id ?? null
  const subscriptions = [
    ...(enterpriseId ? await loadSubscriptions({ supabase, enterpriseId }) : []),
    ...(resellerId ? await loadSubscriptions({ supabase, resellerId }) : []),
  ]
  if (!subscriptions.length) return { ok: true, delivered: 0, skipped: 0 }`

const newDispatch = `  const enterpriseId = event.enterprise_id ?? null
  const resellerId = event.reseller_id ?? null
  const loaded = [
    ...(enterpriseId ? await loadSubscriptions({ supabase, enterpriseId }) : []),
    ...(resellerId ? await loadSubscriptions({ supabase, resellerId }) : []),
  ]
  const seen = new Set()
  const subscriptions = []
  for (const sub of loaded) {
    const id = String(sub.webhook_id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    subscriptions.push(sub)
  }
  if (!subscriptions.length) return { ok: true, delivered: 0, skipped: 0 }`

if (t.includes(oldDispatch)) {
  t = t.replace(oldDispatch, newDispatch)
} else {
  console.warn('dispatch block not found (may already be patched)')
}

fs.writeFileSync('src/services/webhook.js', t)
console.log('patched src/services/webhook.js')
