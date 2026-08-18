import { describe, expect, it, vi } from 'vitest'
import { getNextBillStatus, transitionBillStatus } from '../src/services/billStatusMachine.ts'

vi.mock('../src/services/eventEmitter.js', () => ({
  emitEvent: vi.fn(async () => {}),
}))

describe('mark-paid status gates', () => {
  it('getNextBillStatus allows pay from PUBLISHED and OVERDUE only', () => {
    expect(getNextBillStatus('PUBLISHED', 'pay')).toBe('PAID')
    expect(getNextBillStatus('OVERDUE', 'pay')).toBe('PAID')
    expect(getNextBillStatus('GENERATED', 'pay')).toBeNull()
    expect(getNextBillStatus('PAID', 'pay')).toBeNull()
    expect(getNextBillStatus('WRITTEN_OFF', 'pay')).toBeNull()
    expect(getNextBillStatus('VOIDED', 'pay')).toBeNull()
  })

  for (const status of ['GENERATED', 'PAID', 'WRITTEN_OFF', 'VOIDED'] as const) {
    it(`transitionBillStatus pay rejects ${status}`, async () => {
      const supabase = {
        select: vi.fn(async () => [
          {
            bill_id: 'b1',
            status,
            enterprise_id: 'e1',
            period_start: '2026-01-01',
            total_amount: 100,
          },
        ]),
        update: vi.fn(),
      }
      const result = await transitionBillStatus({
        supabase: supabase as any,
        billId: 'b1',
        action: 'pay',
        paymentRef: 'REF-1',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(409)
        expect(result.code).toBe('INVALID_STATUS')
      }
      expect(supabase.update).not.toHaveBeenCalled()
    })
  }

  for (const status of ['PUBLISHED', 'OVERDUE'] as const) {
    it(`transitionBillStatus pay succeeds from ${status}`, async () => {
      const updated = {
        bill_id: 'b1',
        status: 'PAID',
        enterprise_id: 'e1',
        period_start: '2026-01-01',
        total_amount: 100,
        paid_amount: 88.5,
        paid_at: '2026-03-08T10:00:00Z',
        payment_ref: 'REF-1',
      }
      const supabase = {
        select: vi.fn(async () => [
          {
            bill_id: 'b1',
            status,
            enterprise_id: 'e1',
            period_start: '2026-01-01',
            total_amount: 100,
          },
        ]),
        update: vi.fn(async () => [updated]),
      }
      const result = await transitionBillStatus({
        supabase: supabase as any,
        billId: 'b1',
        action: 'pay',
        paymentRef: 'REF-1',
        paidAt: '2026-03-08T10:00:00Z',
        paidAmount: 88.5,
      })
      expect(result.ok).toBe(true)
      expect(supabase.update).toHaveBeenCalledWith(
        'bills',
        'bill_id=eq.b1',
        expect.objectContaining({ paid_amount: 88.5, status: 'PAID' }),
        { returning: 'representation' }
      )
    })
  }
})
