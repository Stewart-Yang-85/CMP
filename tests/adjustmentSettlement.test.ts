import { describe, it, expect, vi } from 'vitest'
import {
  buildAdjustmentBillLineItems,
  computeAdjustedBillTotal,
  loadApprovedAdjustmentSettlement,
  markAdjustmentNotesApplied,
} from '../src/services/adjustmentNote.ts'

describe('adjustment settlement (PR-C)', () => {
  it('computeAdjustedBillTotal applies DEBIT minus CREDIT net to rating total', () => {
    expect(computeAdjustedBillTotal(1000, 30 - 50)).toBe(980)
    expect(computeAdjustedBillTotal(100, 25)).toBe(125)
  })

  it('loadApprovedAdjustmentSettlement loads APPROVED notes and computes net', async () => {
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table !== 'adjustment_notes') return []
        return [
          {
            note_id: '11111111-1111-4111-8111-111111111111',
            note_type: 'CREDIT',
            total_amount: 50,
            currency: 'CNY',
            reason: 'goodwill',
          },
          {
            note_id: '22222222-2222-4222-8222-222222222222',
            note_type: 'DEBIT',
            total_amount: 20,
            currency: 'CNY',
            reason: 'late cdr',
          },
        ]
      }),
    }
    const settlement = await loadApprovedAdjustmentSettlement(
      supabase as any,
      '33333333-3333-4333-8333-333333333333',
      'CNY'
    )
    expect(settlement.noteIds).toHaveLength(2)
    expect(settlement.creditTotal).toBe(50)
    expect(settlement.debitTotal).toBe(20)
    expect(settlement.netAdjustment).toBe(-30)
    expect(computeAdjustedBillTotal(500, settlement.netAdjustment)).toBe(470)
  })

  it('buildAdjustmentBillLineItems maps note types to line item types', () => {
    const settlement = {
      noteIds: ['11111111-1111-4111-8111-111111111111'],
      notes: [
        {
          noteId: '11111111-1111-4111-8111-111111111111',
          noteType: 'CREDIT' as const,
          totalAmount: 40,
          currency: 'CNY',
          reason: 'test',
        },
      ],
      creditTotal: 40,
      debitTotal: 0,
      netAdjustment: -40,
    }
    const rows = buildAdjustmentBillLineItems(settlement, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    expect(rows).toHaveLength(1)
    expect(rows[0].item_type).toBe('ADJUSTMENT_CREDIT')
    expect(rows[0].amount).toBe(40)
    expect((rows[0].metadata as Record<string, unknown>).noteId).toBe(settlement.notes[0].noteId)
  })

  it('markAdjustmentNotesApplied updates APPROVED notes and writes events', async () => {
    const update = vi.fn(async () => [])
    const insert = vi.fn(async () => [])
    const supabase = { update, insert, select: vi.fn() }
    const noteId = '11111111-1111-4111-8111-111111111111'
    const billId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const enterpriseId = '33333333-3333-4333-8333-333333333333'
    const result = await markAdjustmentNotesApplied({
      supabase: supabase as any,
      noteIds: [noteId],
      appliedBillId: billId,
      enterpriseId,
      actorUserId: '44444444-4444-4444-8444-444444444444',
      requestId: 'trace-1',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.appliedCount).toBe(1)
    expect(update).toHaveBeenCalledWith(
      'adjustment_notes',
      expect.stringContaining('status=eq.APPROVED'),
      { status: 'APPLIED' },
      { returning: 'minimal' }
    )
    expect(insert).toHaveBeenCalledWith(
      'events',
      expect.objectContaining({
        event_type: 'BILL_ADJUSTMENT_NOTE_APPLIED',
        payload: expect.objectContaining({ noteId, appliedBillId: billId }),
      }),
      { returning: 'minimal' }
    )
  })
})
