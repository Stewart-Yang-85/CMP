import { describe, it, expect, vi } from 'vitest'
import { createAdjustmentNote, listAdjustmentNotes } from '../src/services/adjustmentNote.ts'
import { parseOptionalIdempotencyKey } from '../src/utils/idempotencyKeyInput.ts'
import {
  billingGenerateReplayStatusCode,
  billingGenerateScopeFromPayload,
  billingGenerateScopesEqual,
  buildBillingGenerateJobResponse,
} from '../src/services/billingGenerateScope.ts'

const billId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const enterpriseId = '33333333-3333-4333-8333-333333333333'
const noteId = '11111111-1111-4111-8111-111111111111'

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

function existingNote(overrides: Record<string, unknown> = {}) {
  return {
    note_id: noteId,
    enterprise_id: enterpriseId,
    note_type: 'CREDIT',
    status: 'DRAFT',
    total_amount: 100,
    currency: 'CNY',
    reason: 'goodwill',
    source_bill_id: billId,
    idempotency_key: 'adjust-key-1',
    created_at: '2026-03-01T10:00:00Z',
    ...overrides,
  }
}

describe('adjustment idempotency (Phase 40)', () => {
  it('parseOptionalIdempotencyKey rejects empty string', () => {
    expect(parseOptionalIdempotencyKey('')).toEqual({
      ok: false,
      message: 'idempotencyKey must be a non-empty string when provided.',
    })
    expect(parseOptionalIdempotencyKey('   ')).toEqual({
      ok: false,
      message: 'idempotencyKey must be a non-empty string when provided.',
    })
  })

  it('parseOptionalIdempotencyKey treats omitted or null as no key', () => {
    expect(parseOptionalIdempotencyKey(undefined)).toEqual({ ok: true, value: null })
    expect(parseOptionalIdempotencyKey(null)).toEqual({ ok: true, value: null })
    expect(parseOptionalIdempotencyKey('  key-1  ')).toEqual({ ok: true, value: 'key-1' })
  })

  it('createAdjustmentNote returns IDEMPOTENCY_CONFLICT when billId + idempotencyKey already used', async () => {
    const note = existingNote()
    const supabase = {
      select: vi.fn(async (table: string, query: string) => {
        if (table === 'bills') return [publishedBill()]
        if (table === 'adjustment_notes' && query.includes('idempotency_key')) return [note]
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
      idempotencyKey: 'adjust-key-1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('IDEMPOTENCY_CONFLICT')
    }
    expect(supabase.insert).not.toHaveBeenCalled()
  })

  it('createAdjustmentNote inserts source_bill_id and idempotency_key for new notes', async () => {
    const insert = vi.fn(async () => [{ note_id: noteId }])
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'bills') return [publishedBill()]
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
      amount: 80,
      reason: 'one-time credit',
      idempotencyKey: 'adjust-key-new',
    })
    expect(result.ok).toBe(true)
    expect(insert).toHaveBeenCalledWith(
      'adjustment_notes',
      expect.objectContaining({
        source_bill_id: billId,
        idempotency_key: 'adjust-key-new',
      }),
      expect.any(Object)
    )
  })

  it('listAdjustmentNotes returns billId, reason, and idempotencyKey', async () => {
    const note = existingNote()
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'bills') return [{ bill_id: billId, enterprise_id: enterpriseId }]
        if (table === 'tenants') return [{ tenant_id: enterpriseId, name: 'Acme IoT' }]
        return []
      }),
      selectWithCount: vi.fn(async () => ({ data: [note], total: 1 })),
      insert: vi.fn(),
      update: vi.fn(),
    }
    const result = await listAdjustmentNotes({
      supabase: supabase as any,
      billId,
      scope: { roleScope: 'platform', role: 'platform_admin', resellerId: null },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.items).toHaveLength(1)
      expect(result.value.items[0].billId).toBe(billId)
      expect(result.value.items[0].enterpriseId).toBe(enterpriseId)
      expect(result.value.items[0].enterpriseName).toBe('Acme IoT')
      expect(result.value.items[0].reason).toBe('goodwill')
      expect(result.value.items[0].idempotencyKey).toBe('adjust-key-1')
    }
    const query = supabase.selectWithCount.mock.calls[0]?.[1] as string
    expect(query).toContain('source_bill_id')
    expect(query).toContain('idempotency_key')
    expect(query).toContain(`source_bill_id=eq.${encodeURIComponent(billId)}`)
  })

  it('listAdjustmentNotes clamps pageSize to 200', async () => {
    const supabase = {
      select: vi.fn(async () => []),
      selectWithCount: vi.fn(async () => ({ data: [], total: 0 })),
      insert: vi.fn(),
      update: vi.fn(),
    }
    const result = await listAdjustmentNotes({
      supabase: supabase as any,
      pageSize: 500,
      scope: { roleScope: 'platform', role: 'platform_admin', resellerId: null },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.pageSize).toBe(200)
    }
    const query = supabase.selectWithCount.mock.calls[0]?.[1] as string
    expect(query).toContain('limit=200')
  })

  it('listAdjustmentNotes accepts CANCELLED status filter', async () => {
    const supabase = {
      select: vi.fn(async () => []),
      selectWithCount: vi.fn(async () => ({ data: [], total: 0 })),
      insert: vi.fn(),
      update: vi.fn(),
    }
    const result = await listAdjustmentNotes({
      supabase: supabase as any,
      status: 'CANCELLED',
      scope: { roleScope: 'platform', role: 'platform_admin', resellerId: null },
    })
    expect(result.ok).toBe(true)
    const query = supabase.selectWithCount.mock.calls[0]?.[1] as string
    expect(query).toContain('status=eq.CANCELLED')
  })
})

describe('billing:generate idempotency helpers', () => {
  it('billingGenerateScopesEqual compares period/resellerId/enterpriseId', () => {
    const a = { period: '2026-02', resellerId: 'r1', enterpriseId: null }
    const b = { period: '2026-02', resellerId: 'r1', enterpriseId: null }
    const c = { period: '2026-03', resellerId: 'r1', enterpriseId: null }
    expect(billingGenerateScopesEqual(a, b)).toBe(true)
    expect(billingGenerateScopesEqual(a, c)).toBe(false)
  })

  it('billingGenerateScopeFromPayload reads job payload fields', () => {
    expect(
      billingGenerateScopeFromPayload({
        period: '2026-02',
        resellerId: 'r1',
        enterpriseId: 'e1',
      })
    ).toEqual({
      period: '2026-02',
      resellerId: 'r1',
      enterpriseId: 'e1',
    })
  })

  it('buildBillingGenerateJobResponse echoes idempotencyKey', () => {
    const scope = { period: '2026-02', resellerId: 'r1', enterpriseId: null }
    expect(
      buildBillingGenerateJobResponse(
        { job_id: 'job-1', status: 'QUEUED' },
        scope,
        'billing-key-1'
      )
    ).toMatchObject({
      jobId: 'job-1',
      period: '2026-02',
      status: 'QUEUED',
      idempotencyKey: 'billing-key-1',
    })
  })

  it('billingGenerateReplayStatusCode returns 200 only for SUCCEEDED', () => {
    expect(billingGenerateReplayStatusCode('SUCCEEDED')).toBe(200)
    expect(billingGenerateReplayStatusCode('QUEUED')).toBe(202)
    expect(billingGenerateReplayStatusCode('RUNNING')).toBe(202)
  })
})
