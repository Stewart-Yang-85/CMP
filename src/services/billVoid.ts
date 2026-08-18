import { emitEvent } from './eventEmitter.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

const VOIDABLE_STATUSES = new Set(['GENERATED', 'PUBLISHED', 'OVERDUE'])

function toError(status: number, code: string, message: string): ServiceResult<never> {
  return { ok: false, status, code, message }
}

function normalizeReason(value: unknown): string | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

type LinkedNoteRow = {
  note_id?: string
  status?: string
}

async function loadLinkedAdjustmentNotes(
  supabase: SupabaseClient,
  billId: string
): Promise<LinkedNoteRow[]> {
  const rows = await supabase.select(
    'adjustment_notes',
    `select=note_id,status&source_bill_id=eq.${encodeURIComponent(billId)}&limit=500`
  )
  return Array.isArray(rows) ? (rows as LinkedNoteRow[]) : []
}

export async function voidBill({
  supabase,
  billId,
  reason,
  actorUserId,
  requestId,
}: {
  supabase: SupabaseClient
  billId: string
  reason?: string | null
  actorUserId?: string | null
  requestId?: string | null
}): Promise<ServiceResult<Record<string, unknown>>> {
  if (!billId) {
    return toError(400, 'BAD_REQUEST', 'billId is required.')
  }
  const normalizedReason = normalizeReason(reason)
  if (!normalizedReason) {
    return toError(400, 'BAD_REQUEST', 'reason is required for void.')
  }
  const rows = await supabase.select(
    'bills',
    `select=bill_id,enterprise_id,period_start,period_end,status,total_amount,currency&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
  )
  const bill = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  if (!bill) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Bill not found.')
  }
  const status = String(bill.status ?? '').toUpperCase()
  if (status === 'VOIDED') {
    return toError(409, 'INVALID_STATUS', 'Bill is already voided.')
  }
  if (!VOIDABLE_STATUSES.has(status)) {
    return toError(409, 'INVALID_STATUS', `Cannot void bill in status ${status}.`)
  }

  const linkedNotes = await loadLinkedAdjustmentNotes(supabase, billId)
  const blocking = linkedNotes.filter((n) => {
    const noteStatus = String(n.status ?? '').toUpperCase()
    return noteStatus === 'APPROVED' || noteStatus === 'APPLIED'
  })
  if (blocking.length) {
    const noteIds = blocking.map((n) => String(n.note_id ?? '')).filter(Boolean)
    return toError(
      409,
      'ADJUSTMENT_NOTES_BLOCK_VOID',
      `Cannot void bill while adjustment notes are APPROVED or APPLIED: ${noteIds.join(', ')}.`
    )
  }

  const draftNoteIds = linkedNotes
    .filter((n) => String(n.status ?? '').toUpperCase() === 'DRAFT')
    .map((n) => String(n.note_id ?? ''))
    .filter(Boolean)
  const cancelledNoteIds: string[] = []
  if (draftNoteIds.length) {
    const idList = draftNoteIds.map((id) => encodeURIComponent(id)).join(',')
    await supabase.update(
      'adjustment_notes',
      `note_id=in.(${idList})&status=eq.DRAFT`,
      { status: 'CANCELLED' },
      { returning: 'minimal' }
    )
    cancelledNoteIds.push(...draftNoteIds)
  }

  const nowIso = new Date().toISOString()
  const updatedRows = await supabase.update(
    'bills',
    `bill_id=eq.${encodeURIComponent(billId)}`,
    {
      status: 'VOIDED',
      voided_at: nowIso,
      void_reason: normalizedReason,
    },
    { returning: 'representation' }
  )
  const updated = Array.isArray(updatedRows) ? (updatedRows[0] as Record<string, unknown>) : null
  if (!updated) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to void bill.')
  }

  const enterpriseId = updated.enterprise_id != null ? String(updated.enterprise_id) : null
  const periodStart = updated.period_start != null ? String(updated.period_start) : null
  await emitEvent({
    eventType: 'BILL_VOIDED',
    enterpriseId: enterpriseId,
    actorUserId: actorUserId ?? null,
    requestId: requestId ?? null,
    payload: {
      billId,
      enterpriseId,
      period: periodStart ? periodStart.slice(0, 7) : null,
      reason: normalizedReason,
      cancelledNoteIds,
    },
  })

  return {
    ok: true,
    value: {
      billId: updated.bill_id ?? billId,
      status: updated.status ?? 'VOIDED',
      voidedAt: updated.voided_at ?? nowIso,
      reason: normalizedReason,
      cancelledNoteIds,
    },
  }
}
