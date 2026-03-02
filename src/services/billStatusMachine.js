import { emitEvent } from './eventEmitter.js'

function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function normalizeAction(value) {
  return String(value || '').trim().toLowerCase()
}

const transitions = {
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

export function getNextBillStatus(currentStatus, action) {
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
}) {
  if (!billId) {
    return toError(400, 'BAD_REQUEST', 'billId is required.')
  }
  const rows = await supabase.select('bills', `select=bill_id,enterprise_id,period_start,period_end,status,total_amount,currency,due_date&bill_id=eq.${encodeURIComponent(billId)}&limit=1`)
  const bill = Array.isArray(rows) ? rows[0] : null
  if (!bill) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Bill not found.')
  }
  const normalizedAction = normalizeAction(action)
  if (String(bill.status || '').toUpperCase() === 'PAID' && normalizedAction === 'pay') {
    return { ok: true, value: bill }
  }
  const nextStatus = getNextBillStatus(bill.status, action)
  if (!nextStatus) {
    return toError(409, 'INVALID_STATUS', `Cannot ${action} bill in status ${bill.status}.`)
  }
  const nowIso = new Date().toISOString()
  const patch = {
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
  }
  if (nextStatus === 'OVERDUE') {
    patch.overdue_at = nowIso
  }
  const updatedRows = await supabase.update(
    'bills',
    `bill_id=eq.${encodeURIComponent(billId)}`,
    patch,
    { returning: 'representation' }
  )
  const updated = Array.isArray(updatedRows) ? updatedRows[0] : null
  if (!updated) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to update bill status.')
  }
  if (nextStatus === 'PUBLISHED') {
    await emitEvent({
      eventType: 'BILL_PUBLISHED',
      tenantId: updated.enterprise_id ?? null,
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
      tenantId: updated.enterprise_id ?? null,
      actorUserId: actorUserId ?? null,
      requestId: requestId ?? null,
      payload: {
        billId: updated.bill_id,
        customerId: updated.enterprise_id,
        paidAmount: Number(updated.total_amount ?? 0),
        paidAt: updated.paid_at ?? paidAt ?? nowIso,
        paymentRef: paymentRef ?? null,
      },
    })
  }
  return { ok: true, value: updated }
}
