import { describe, expect, it } from 'vitest'
import { recordAlertDeliveries } from '../src/services/alertDelivery.js'

function createSupabase() {
  const inserted: Record<string, unknown>[] = []
  return {
    inserted,
    supabase: {
      async insert(table: string, rows: unknown) {
        if (table === 'alert_deliveries') {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[])
        }
        return []
      },
    },
  }
}

describe('alert delivery tracking', () => {
  it('records portal, reserved email, and webhook delivery rows', async () => {
    const { supabase, inserted } = createSupabase()

    const result = await recordAlertDeliveries({
      supabase: supabase as any,
      alertId: 'aaaaaaaa-0000-0000-0000-000000000001',
      channels: ['PORTAL', 'EMAIL', 'WEBHOOK'],
      eventId: 'bbbbbbbb-0000-0000-0000-000000000002',
      webhookDeliveryIds: [101, '102'],
    })

    expect(result).toEqual({ ok: true, inserted: 4 })
    expect(inserted.map((row) => row.channel)).toEqual(['PORTAL', 'EMAIL', 'WEBHOOK', 'WEBHOOK'])
    expect(inserted.map((row) => row.status)).toEqual(['DELIVERED', 'NOT_IMPLEMENTED', 'PENDING', 'PENDING'])
    expect(inserted.filter((row) => row.channel === 'WEBHOOK').map((row) => row.webhook_delivery_id)).toEqual([101, 102])
  })

  it('defaults to portal delivery and skips webhook when no delivery exists', async () => {
    const first = createSupabase()
    await recordAlertDeliveries({
      supabase: first.supabase as any,
      alertId: 'aaaaaaaa-0000-0000-0000-000000000001',
      channels: null,
    })
    expect(first.inserted).toMatchObject([{ channel: 'PORTAL', status: 'DELIVERED' }])

    const second = createSupabase()
    await recordAlertDeliveries({
      supabase: second.supabase as any,
      alertId: 'aaaaaaaa-0000-0000-0000-000000000001',
      channels: ['WEBHOOK'],
      eventId: 'bbbbbbbb-0000-0000-0000-000000000002',
      webhookDeliveryIds: [],
    })
    expect(second.inserted).toMatchObject([{ channel: 'WEBHOOK', status: 'SKIPPED', error_code: 'NO_WEBHOOK_DELIVERY' }])
  })
})
