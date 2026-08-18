import { describe, expect, it, vi } from 'vitest'
import { transitionBillStatus } from '../src/services/billStatusMachine.ts'
import { emitEvent } from '../src/services/eventEmitter.js'

vi.mock('../src/services/eventEmitter.js', () => ({
  emitEvent: vi.fn(async () => {}),
}))

describe('write-off persistence', () => {
  it('transitionBillStatus write_off persists written_off_at and write_off_reason', async () => {
    const updated = {
      bill_id: 'b1',
      status: 'WRITTEN_OFF',
      enterprise_id: 'e1',
      period_start: '2026-01-01',
      total_amount: 200,
      written_off_at: '2026-06-05T14:00:00Z',
      write_off_reason: 'uncollectible',
    }
    const supabase = {
      select: vi.fn(async () => [
        {
          bill_id: 'b1',
          status: 'OVERDUE',
          enterprise_id: 'e1',
          period_start: '2026-01-01',
          total_amount: 200,
        },
      ]),
      update: vi.fn(async () => [updated]),
    }
    const result = await transitionBillStatus({
      supabase: supabase as any,
      billId: 'b1',
      action: 'write_off',
      writeOffReason: 'uncollectible',
    })
    expect(result.ok).toBe(true)
    expect(supabase.update).toHaveBeenCalledWith(
      'bills',
      'bill_id=eq.b1',
      expect.objectContaining({
        status: 'WRITTEN_OFF',
        write_off_reason: 'uncollectible',
        written_off_at: expect.any(String),
      }),
      { returning: 'representation' }
    )
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BILL_WRITTEN_OFF',
        payload: expect.objectContaining({
          billId: 'b1',
          writtenOffAt: '2026-06-05T14:00:00Z',
          reason: 'uncollectible',
        }),
      })
    )
  })
})
