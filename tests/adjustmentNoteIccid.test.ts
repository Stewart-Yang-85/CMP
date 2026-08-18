import { describe, it, expect, vi } from 'vitest'
import { createAdjustmentNote, approveAdjustmentNote } from '../src/services/adjustmentNote.ts'
import {
  assertAdjustmentItemsIccidsForEnterprise,
  findInvalidAdjustmentNoteIccids,
} from '../src/services/adjustmentNoteIccid.ts'

const billId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const enterpriseId = '33333333-3333-4333-8333-333333333333'
const noteId = '11111111-1111-4111-8111-111111111111'
const validIccid = '89860012345678901234'
const invalidIccid = '89860099999999999999'

function publishedBill() {
  return {
    bill_id: billId,
    enterprise_id: enterpriseId,
    status: 'PUBLISHED',
    currency: 'CNY',
    period_start: '2026-02-01',
    period_end: '2026-02-28',
  }
}

describe('adjustmentNoteIccid validation', () => {
  it('assertAdjustmentItemsIccidsForEnterprise rejects empty iccid field', async () => {
    const result = await assertAdjustmentItemsIccidsForEnterprise({ select: vi.fn() } as any, enterpriseId, [
      { iccid: '' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ICCID')
    }
  })

  it('assertAdjustmentItemsIccidsForEnterprise accepts omitted iccid', async () => {
    const result = await assertAdjustmentItemsIccidsForEnterprise({ select: vi.fn() } as any, enterpriseId, [
      { iccid: null },
      {},
    ])
    expect(result.ok).toBe(true)
  })

  it('assertAdjustmentItemsIccidsForEnterprise returns SIM_NOT_FOUND for unknown iccid', async () => {
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'sims') return []
        return []
      }),
    }
    const result = await assertAdjustmentItemsIccidsForEnterprise(supabase as any, enterpriseId, [
      { iccid: invalidIccid },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
      expect(result.code).toBe('SIM_NOT_FOUND')
    }
  })

  it('createAdjustmentNote rejects items with invalid iccid', async () => {
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'bills') return [publishedBill()]
        if (table === 'sims') return []
        return []
      }),
      insert: vi.fn(async () => []),
      selectWithCount: vi.fn(),
      update: vi.fn(),
    }
    const result = await createAdjustmentNote({
      supabase: supabase as any,
      billId,
      type: 'CREDIT',
      amount: 100,
      reason: 'goodwill',
      items: [{ iccid: invalidIccid, description: 'line', amount: 100 }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SIM_NOT_FOUND')
    expect(supabase.insert).not.toHaveBeenCalled()
  })

  it('createAdjustmentNote accepts valid iccid under enterprise', async () => {
    const insert = vi.fn(async (table: string) => {
      if (table === 'adjustment_notes') return [{ note_id: noteId }]
      return []
    })
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'bills') return [publishedBill()]
        if (table === 'sims') return [{ iccid: validIccid }]
        return []
      }),
      insert,
      selectWithCount: vi.fn(),
      update: vi.fn(),
    }
    const result = await createAdjustmentNote({
      supabase: supabase as any,
      billId,
      type: 'CREDIT',
      amount: 100,
      reason: 'goodwill',
      items: [{ iccid: validIccid, description: 'line', amount: 100 }],
    })
    expect(result.ok).toBe(true)
    expect(insert).toHaveBeenCalled()
  })

  it('approveAdjustmentNote re-validates stored item iccids', async () => {
    const supabase = {
      select: vi.fn(async (table: string, query: string) => {
        if (table === 'adjustment_notes') {
          return [
            {
              note_id: noteId,
              status: 'DRAFT',
              enterprise_id: enterpriseId,
              note_type: 'CREDIT',
              total_amount: 50,
              currency: 'CNY',
            },
          ]
        }
        if (table === 'adjustment_note_items') {
          return [{ amount: 50, metadata: { iccid: invalidIccid, description: 'line' } }]
        }
        if (table === 'sims') return []
        if (table === 'events') return []
        return []
      }),
      insert: vi.fn(async () => []),
      update: vi.fn(async () => []),
      selectWithCount: vi.fn(),
    }
    const result = await approveAdjustmentNote({
      supabase: supabase as any,
      noteId,
      actorUserId: '44444444-4444-4444-8444-444444444444',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('SIM_NOT_FOUND')
    expect(supabase.update).not.toHaveBeenCalled()
  })

  it('findInvalidAdjustmentNoteIccids detects stale invalid iccids at settlement', async () => {
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'adjustment_note_items') {
          return [
            {
              note_id: noteId,
              metadata: { iccid: invalidIccid },
            },
          ]
        }
        if (table === 'sims') return []
        return []
      }),
    }
    const issues = await findInvalidAdjustmentNoteIccids(supabase as any, enterpriseId, [noteId])
    expect(issues).toEqual([{ noteId, iccid: invalidIccid, code: 'SIM_NOT_FOUND' }])
  })
})
