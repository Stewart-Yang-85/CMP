import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/services/eventEmitter.js', () => ({
  emitEvent: vi.fn(async () => ({ eventId: 'evt-1' })),
}))

import { voidBill } from '../src/services/billVoid.ts'

const billId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const enterpriseId = '33333333-3333-4333-8333-333333333333'
const noteId = '11111111-1111-4111-8111-111111111111'

function billWithStatus(status: string) {
  return {
    bill_id: billId,
    enterprise_id: enterpriseId,
    period_start: '2026-05-01',
    period_end: '2026-05-31',
    status,
    total_amount: 1000,
    currency: 'CNY',
  }
}

function generatedBill() {
  return billWithStatus('GENERATED')
}

function mockVoidSuccessSupabase(inputStatus: string, reason: string) {
  const update = vi.fn(async (table: string) => {
    if (table === 'bills') {
      return [
        {
          ...billWithStatus('VOIDED'),
          voided_at: '2026-06-05T10:00:00Z',
          void_reason: reason,
        },
      ]
    }
    return []
  })
  const supabase = {
    select: vi.fn(async (table: string) => {
      if (table === 'bills') return [billWithStatus(inputStatus)]
      if (table === 'adjustment_notes') return []
      return []
    }),
    update,
  }
  return { supabase, update }
}

describe('bill void (Phase 41)', () => {
  it('voidBill rejects PAID bills', async () => {
    const supabase = {
      select: vi.fn(async () => [{ ...generatedBill(), status: 'PAID' }]),
      update: vi.fn(),
    }
    const result = await voidBill({
      supabase: supabase as any,
      billId,
      reason: 'retry',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_STATUS')
  })

  it('voidBill blocks when APPROVED adjustment notes reference the bill', async () => {
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'bills') return [generatedBill()]
        if (table === 'adjustment_notes') {
          return [{ note_id: noteId, status: 'APPROVED' }]
        }
        return []
      }),
      update: vi.fn(),
    }
    const result = await voidBill({
      supabase: supabase as any,
      billId,
      reason: 'retry',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ADJUSTMENT_NOTES_BLOCK_VOID')
  })

  it('voidBill cancels DRAFT notes and voids GENERATED bill', async () => {
    const update = vi.fn(async (table: string) => {
      if (table === 'bills') {
        return [{ ...generatedBill(), status: 'VOIDED', voided_at: '2026-06-05T10:00:00Z', void_reason: 'retry' }]
      }
      return []
    })
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'bills') return [generatedBill()]
        if (table === 'adjustment_notes') {
          return [{ note_id: noteId, status: 'DRAFT' }]
        }
        return []
      }),
      update,
    }
    const result = await voidBill({
      supabase: supabase as any,
      billId,
      reason: '批价错误重出',
      actorUserId: '44444444-4444-4444-8444-444444444444',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('VOIDED')
      expect(result.value.cancelledNoteIds).toEqual([noteId])
    }
    expect(update).toHaveBeenCalledWith(
      'adjustment_notes',
      expect.stringContaining('status=eq.DRAFT'),
      { status: 'CANCELLED' },
      expect.any(Object)
    )
    expect(update).toHaveBeenCalledWith(
      'bills',
      expect.any(String),
      expect.objectContaining({ status: 'VOIDED', void_reason: '批价错误重出' }),
      expect.any(Object)
    )
  })

  it('voidBill voids PUBLISHED bill when no blocking adjustment notes', async () => {
    const { supabase, update } = mockVoidSuccessSupabase('PUBLISHED', '客户尚未付款，整单重出')
    const result = await voidBill({
      supabase: supabase as any,
      billId,
      reason: '客户尚未付款，整单重出',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('VOIDED')
      expect(result.value.cancelledNoteIds).toEqual([])
    }
    expect(update).toHaveBeenCalledWith(
      'bills',
      expect.any(String),
      expect.objectContaining({ status: 'VOIDED', void_reason: '客户尚未付款，整单重出' }),
      expect.any(Object)
    )
    expect(update).not.toHaveBeenCalledWith('adjustment_notes', expect.any(String), expect.any(Object), expect.any(Object))
  })

  it('voidBill voids OVERDUE bill when no blocking adjustment notes', async () => {
    const { supabase, update } = mockVoidSuccessSupabase('OVERDUE', '错账作废后重出')
    const result = await voidBill({
      supabase: supabase as any,
      billId,
      reason: '错账作废后重出',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe('VOIDED')
    }
    expect(update).toHaveBeenCalledWith(
      'bills',
      expect.any(String),
      expect.objectContaining({ status: 'VOIDED', void_reason: '错账作废后重出' }),
      expect.any(Object)
    )
  })

  it('voidBill blocks PUBLISHED bill when APPLIED adjustment notes reference the bill', async () => {
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'bills') return [billWithStatus('PUBLISHED')]
        if (table === 'adjustment_notes') {
          return [{ note_id: noteId, status: 'APPLIED' }]
        }
        return []
      }),
      update: vi.fn(),
    }
    const result = await voidBill({
      supabase: supabase as any,
      billId,
      reason: 'retry',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('ADJUSTMENT_NOTES_BLOCK_VOID')
  })
})
