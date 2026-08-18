import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const dispatchWebhookEvent = vi.fn()
  const supabase = {
    select: vi.fn(async () => []),
    insert: vi.fn(async (_table: string, row: Record<string, unknown>) => [{
      ...row,
      event_id: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
    }]),
    update: vi.fn(),
    rpc: vi.fn(),
    selectWithCount: vi.fn(),
  }
  return { dispatchWebhookEvent, supabase }
})

vi.mock('../src/supabaseRest.js', () => ({
  createSupabaseRestClient: vi.fn(() => mocks.supabase),
}))

vi.mock('../src/services/webhook.js', () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}))

import { emitEvent } from '../src/services/eventEmitter.js'

describe('event emitter webhook dispatch control', () => {
  beforeEach(() => {
    mocks.dispatchWebhookEvent.mockReset()
    mocks.dispatchWebhookEvent.mockResolvedValue({ deliveryIds: [1] })
    mocks.supabase.select.mockClear()
    mocks.supabase.insert.mockClear()
  })

  it('records events without webhook dispatch when dispatchWebhooks is false', async () => {
    const result = await emitEvent({
      eventType: 'ALERT_TRIGGERED',
      resellerId: '0925eb82-53ef-4522-8d81-07ebaa17d819',
      payload: { alertId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' },
      dispatchWebhooks: false,
    })

    expect(result).toEqual({
      duplicate: false,
      eventId: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee',
      webhookDeliveryIds: [],
    })
    expect(mocks.supabase.insert).toHaveBeenCalledWith(
      'events',
      expect.objectContaining({ event_type: 'ALERT_TRIGGERED' }),
      { returning: 'representation' },
    )
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('dispatches webhooks by default for existing event flows', async () => {
    const result = await emitEvent({
      eventType: 'ALERT_TRIGGERED',
      resellerId: '0925eb82-53ef-4522-8d81-07ebaa17d819',
      payload: { alertId: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa' },
    })

    expect(result.webhookDeliveryIds).toEqual([1])
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })
})
