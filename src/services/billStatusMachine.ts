import { emitEvent } from './eventEmitter.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

function toError(status: number, code: string, message: string): ServiceResult<never> {
  return { ok: false, status, code, message }
}

function normalizeAction(value: unknown) {
  return String(value || '').trim().toLowerCase()
}

const transitions: Record<string, Record<string, string>> = {
  GENERATED: {
    publish: 'PUBLISHED',
  },
  PUBLISHED: {
    pay: 'PAID',
    overdue: 'OVERDUE',
  },
  OVERDUE: {
    pay: 'PAID',
    write_off: 'WRITTEN_OFF',
  },
}

const MARK_PAID_ALLOWED_STATUSES = new Set(['PUBLISHED', 'OVERDUE'])

export function getNextBillStatus(currentStatus: unknown, action: unknown) {
  const current = String(currentStatus || '').toUpperCase()
  const next = transitions[current]?.[normalizeAction(action)]
  return next ?? null
}

export async function transitionBillStatus({
  supabase,
  billId,
  action,
  actorUserId,
  requestId,
  paymentRef,
  paidAt,
  dueDate,
  paymentProof,
  paidAmount,
  writeOffReason,
}: {
  supabase: SupabaseClient
  billId: string
  action: string
  actorUserId?: string | null
  requestId?: string | null
  paymentRef?: string | null
  paidAt?: string | null
  dueDate?: string | null
  paymentProof?: string | null
  paidAmount?: number | null
  writeOffReason?: string | null
}): Promise<ServiceResult<Record<string, any>>> {
  if (!billId) {
    return toError(400, 'BAD_REQUEST', 'billId is required.')
  }
  const rows = await supabase.select(
    'bills',
    `select=bill_id,enterprise_id,period_start,period_end,status,total_amount,currency,due_date&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
  )
  const bill = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  if (!bill) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Bill not found.')
  }
  const normalizedAction = normalizeAction(action)
  const currentStatus = String(bill.status || '').toUpperCase()
  if (normalizedAction === 'pay' && !MARK_PAID_ALLOWED_STATUSES.has(currentStatus)) {
    return toError(409, 'INVALID_STATUS', `Cannot mark bill paid in status ${bill.status}.`)
  }
  const nextStatus = getNextBillStatus(bill.status, action)
  if (!nextStatus) {
    return toError(409, 'INVALID_STATUS', `Cannot ${action} bill in status ${bill.status}.`)
  }
  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = {
    status: nextStatus,
  }
  if (nextStatus === 'PUBLISHED') {
    patch.published_at = nowIso
    if (dueDate || bill.due_date) {
      patch.due_date = dueDate ?? bill.due_date
    }
  }
  if (nextStatus === 'PAID') {
    patch.paid_at = paidAt ?? nowIso
    if (paymentRef) patch.payment_ref = String(paymentRef)
    if (paymentProof != null && String(paymentProof).trim() !== '') {
      patch.payment_proof = String(paymentProof).trim()
    }
    if (paidAmount != null && Number.isFinite(Number(paidAmount))) {
      patch.paid_amount = Number(Number(paidAmount).toFixed(2))
    }
  }
  if (nextStatus === 'OVERDUE') {
    patch.overdue_at = nowIso
  }
  if (nextStatus === 'WRITTEN_OFF') {
    patch.written_off_at = nowIso
    if (writeOffReason != null && String(writeOffReason).trim() !== '') {
      patch.write_off_reason = String(writeOffReason).trim()
    }
  }
  const updatedRows = await supabase.update(
    'bills',
    `bill_id=eq.${encodeURIComponent(billId)}`,
    patch,
    { returning: 'representation' }
  )
  const updated = Array.isArray(updatedRows) ? (updatedRows[0] as Record<string, any>) : null
  if (!updated) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to update bill status.')
  }
  if (nextStatus === 'PUBLISHED') {
    await emitEvent({
      eventType: 'BILL_PUBLISHED',
      enterpriseId: updated.enterprise_id ?? null,
      actorUserId: actorUserId ?? null,
      requestId: requestId ?? null,
      payload: {
        billId: updated.bill_id,
        customerId: updated.enterprise_id,
        period: String(updated.period_start).slice(0, 7),
        totalAmount: Number(updated.total_amount ?? 0),
        dueDate: updated.due_date ?? null,
      },
    })
  }
  if (nextStatus === 'PAID') {
    await emitEvent({
      eventType: 'PAYMENT_CONFIRMED',
      enterpriseId: updated.enterprise_id ?? null,
      actorUserId: actorUserId ?? null,
      requestId: requestId ?? null,
      payload: {
        billId: updated.bill_id,
        customerId: updated.enterprise_id,
        paidAmount: Number(updated.paid_amount ?? paidAmount ?? 0),
        paidAt: updated.paid_at ?? paidAt ?? nowIso,
        paymentRef: paymentRef ?? null,
        paymentProof: paymentProof ?? updated.payment_proof ?? null,
      },
    })
  }
  if (nextStatus === 'WRITTEN_OFF') {
    await emitEvent({
      eventType: 'BILL_WRITTEN_OFF',
      enterpriseId: updated.enterprise_id ?? null,
      actorUserId: actorUserId ?? null,
      requestId: requestId ?? null,
      payload: {
        billId: updated.bill_id,
        customerId: updated.enterprise_id,
        totalAmount: Number(updated.total_amount ?? 0),
        writtenOffAt: updated.written_off_at ?? nowIso,
        reason: updated.write_off_reason ?? writeOffReason ?? null,
      },
    })
  }
  return { ok: true, value: updated }
}
