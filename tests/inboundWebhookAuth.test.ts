import { describe, expect, it } from 'vitest'
import { getInboundWebhookKeyFromReq } from '../src/utils/inboundWebhookAuth.ts'

describe('getInboundWebhookKeyFromReq', () => {
  it('reads webhookKey header', () => {
    const key = getInboundWebhookKeyFromReq({ headers: { webhookkey: 'secret-1' } })
    expect(key).toBe('secret-1')
  })

  it('does not accept X-API-Key', () => {
    const key = getInboundWebhookKeyFromReq({ headers: { 'x-api-key': 'legacy' } })
    expect(key).toBeNull()
  })
})
