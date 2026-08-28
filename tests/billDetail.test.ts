import { describe, expect, it } from 'vitest'
import { buildBillDetail, buildBillDetailCsv } from '../src/routes/bills.ts'

describe('bill detail lifecycle fields', () => {
  const bill = {
    bill_id: 'b1',
    enterprise_id: 'e1',
    period_start: '2026-02-01',
    status: 'PAID',
    currency: 'USD',
    total_amount: 100,
    due_date: '2026-03-31',
    created_at: '2026-02-01T08:00:00Z',
    generated_at: '2026-02-01T08:05:00Z',
    overdue_at: null,
    published_at: '2026-02-05T10:00:00Z',
    paid_at: '2026-03-15T12:00:00Z',
    paid_amount: 99.5,
    payment_ref: 'TXN-001',
    payment_proof: 'bank slip #42',
    voided_at: null,
    void_reason: null,
    written_off_at: '2026-06-01T10:00:00Z',
    write_off_reason: 'uncollectible debt',
  }

  it('buildBillDetail maps bill lifecycle timestamps and payment fields', () => {
    const detail = buildBillDetail({ bill, lineItems: [], enterpriseName: 'Acme IoT' })
    expect(detail.enterpriseId).toBe('e1')
    expect(detail.enterpriseName).toBe('Acme IoT')
    expect(detail.dueDate).toBe('2026-03-31')
    expect(detail.createdAt).toBe('2026-02-01T08:00:00Z')
    expect(detail.generatedAt).toBe('2026-02-01T08:05:00Z')
    expect(detail.publishedAt).toBe('2026-02-05T10:00:00Z')
    expect(detail.paidAt).toBe('2026-03-15T12:00:00Z')
    expect(detail.paidAmount).toBe(99.5)
    expect(detail.paymentRef).toBe('TXN-001')
    expect(detail.paymentProof).toBe('bank slip #42')
    expect(detail.overdueAt).toBeNull()
    expect(detail.voidedAt).toBeNull()
    expect(detail.voidReason).toBeNull()
    expect(detail.writtenOffAt).toBe('2026-06-01T10:00:00Z')
    expect(detail.writeOffReason).toBe('uncollectible debt')
  })

  it('buildBillDetailCsv includes lifecycle bill section rows', () => {
    const detail = buildBillDetail({ bill, lineItems: [], enterpriseName: 'Acme IoT' })
    const csv = buildBillDetailCsv(detail)
    expect(csv).toContain('bill,enterpriseId,,e1,')
    expect(csv).toContain('bill,enterpriseName,,Acme IoT,')
    expect(csv).toContain('bill,paidAmount,,99.5,')
    expect(csv).toContain('bill,paymentRef,,TXN-001,')
    expect(csv).toContain('bill,paidAt,,2026-03-15T12:00:00Z,')
    expect(csv).toContain('bill,writeOffReason,,uncollectible debt,')
    expect(csv).toContain('bill,voidReason,,,')
  })
})
