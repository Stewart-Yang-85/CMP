type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

function toError(status: number, code: string, message: string): ServiceResult<never> {
  return { ok: false, status, code, message }
}

function normalizeType(value: unknown) {
  const v = String(value || '').trim().toUpperCase()
  if (v === 'CREDIT' || v === 'DEBIT') return v
  return null
}

function normalizeStatus(value: unknown) {
  const v = String(value || '').trim().toUpperCase()
  if (v === 'DRAFT' || v === 'APPROVED' || v === 'APPLIED') return v
  return null
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

export async function createAdjustmentNote({
  supabase,
  billId,
  type,
  amount,
  reason,
  items,
  actorUserId,
  requestId,
}: {
  supabase: SupabaseClient
  billId: string
  type: string
  amount: number
  reason?: string | null
  items?: Array<{ iccid?: string | null; description?: string | null; amount?: number | null }> | null
  actorUserId?: string | null
  requestId?: string | null
}): Promise<ServiceResult<Record<string, any>>> {
  if (!billId) {
    return toError(400, 'BAD_REQUEST', 'billId is required.')
  }
  const noteType = normalizeType(type)
  if (!noteType) {
    return toError(400, 'BAD_REQUEST', 'type must be CREDIT or DEBIT.')
  }
  const detailItems = Array.isArray(items) ? items : []
  const computedTotal = detailItems.length
    ? detailItems.reduce((sum, item) => {
      const v = Number(item?.amount ?? 0)
      if (!Number.isFinite(v) || v <= 0) return sum
      return sum + v
    }, 0)
    : Number(amount)
  if (!Number.isFinite(computedTotal) || computedTotal <= 0) {
    return toError(400, 'BAD_REQUEST', 'amount must be a positive number.')
  }
  const billRows = await supabase.select(
    'bills',
    `select=bill_id,enterprise_id,status,currency,period_start,period_end&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
  )
  const bill = Array.isArray(billRows) ? (billRows[0] as Record<string, any>) : null
  if (!bill) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Bill not found.')
  }
  if (!['PUBLISHED', 'OVERDUE', 'PAID'].includes(String(bill.status || '').toUpperCase())) {
    return toError(409, 'INVALID_STATUS', 'Adjustment is only allowed for PUBLISHED, OVERDUE, or PAID bills.')
  }
  const noteRows = await supabase.insert('adjustment_notes', {
    enterprise_id: (bill as any).enterprise_id,
    note_type: noteType,
    status: 'DRAFT',
    currency: (bill as any).currency,
    total_amount: Number(computedTotal.toFixed(2)),
    reason: reason ? String(reason) : null,
    input_ref: 'manual',
    calculation_id: 'manual',
  }, { returning: 'representation' })
  const note = Array.isArray(noteRows) ? (noteRows[0] as Record<string, any>) : null
  const noteId = note?.note_id ?? null
  if (!noteId) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to create adjustment note.')
  }
  const itemRows = detailItems.length
    ? detailItems.map((item) => ({
      note_id: noteId,
      item_type: 'MANUAL',
      sim_id: null,
      amount: Number(item?.amount ?? 0),
      metadata: {
        billId,
        iccid: item?.iccid ?? null,
        description: item?.description ?? null,
        reason: reason ? String(reason) : null,
      },
    }))
    : [
      {
        note_id: noteId,
        item_type: 'MANUAL',
        sim_id: null,
        amount: Number(computedTotal.toFixed(2)),
        metadata: {
          billId,
          description: reason ? String(reason) : null,
          reason: reason ? String(reason) : null,
        },
      },
    ]
  await supabase.insert('adjustment_note_items', itemRows, { returning: 'minimal' })
  const tenantId = isValidUuid((bill as any).enterprise_id) ? (bill as any).enterprise_id : null
  const actorId = isValidUuid(actorUserId) ? actorUserId : null
  await supabase.insert('events', {
    event_type: 'BILL_ADJUSTMENT_NOTE_CREATED',
    occurred_at: new Date().toISOString(),
    tenant_id: tenantId,
    actor_user_id: actorId,
    request_id: requestId ?? null,
    payload: {
      billId,
      noteId,
      type: noteType,
      amount: Number(computedTotal.toFixed(2)),
      reason: reason ? String(reason) : null,
    },
  }, { returning: 'minimal' })
  return {
    ok: true,
    value: {
      adjustmentNoteId: noteId,
      billId: billId,
      type: noteType,
      status: 'DRAFT',
      totalAmount: Number(computedTotal.toFixed(2)),
      currency: (bill as any).currency ?? null,
      createdAt: new Date().toISOString(),
      items: detailItems.length
        ? detailItems
        : itemRows.map((item) => ({
          iccid: (item as any).metadata?.iccid ?? null,
          description: (item as any).metadata?.description ?? null,
          amount: Number((item as any).amount ?? 0),
        })),
    },
  }
}

export async function approveAdjustmentNote({
  supabase,
  noteId,
}: {
  supabase: SupabaseClient
  noteId: string
}): Promise<ServiceResult<Record<string, any>>> {
  if (!noteId) {
    return toError(400, 'BAD_REQUEST', 'noteId is required.')
  }
  const rows = await supabase.select(
    'adjustment_notes',
    `select=note_id,status,enterprise_id,note_type,total_amount,currency&note_id=eq.${encodeURIComponent(noteId)}&limit=1`
  )
  const note = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  if (!note) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Adjustment note not found.')
  }
  if (String(note.status || '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT notes can be approved.')
  }
  const updatedRows = await supabase.update(
    'adjustment_notes',
    `note_id=eq.${encodeURIComponent(noteId)}`,
    { status: 'APPROVED' },
    { returning: 'representation' }
  )
  const updated = Array.isArray(updatedRows) ? (updatedRows[0] as Record<string, any>) : null
  if (!updated) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to approve adjustment note.')
  }
  return {
    ok: true,
    value: {
      adjustmentNoteId: updated.note_id,
      status: updated.status,
      totalAmount: Number(updated.total_amount ?? 0),
      currency: updated.currency ?? null,
    },
  }
}

export async function listAdjustmentNotes({
  supabase,
  billId,
  type,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  billId?: string | null
  type?: string | null
  status?: string | null
  page?: number | null
  pageSize?: number | null
}): Promise<ServiceResult<Record<string, any>>> {
  const noteType = type ? normalizeType(type) : null
  if (type && !noteType) {
    return toError(400, 'BAD_REQUEST', 'type must be CREDIT or DEBIT.')
  }
  const noteStatus = status ? normalizeStatus(status) : null
  if (status && !noteStatus) {
    return toError(400, 'BAD_REQUEST', 'status is invalid.')
  }
  const limit = Number(pageSize || 20)
  const currentPage = Number(page || 1)
  const offset = Math.max(0, (Math.max(1, currentPage) - 1) * Math.max(0, limit))
  const filters: string[] = []
  if (billId) {
    const noteRows = await supabase.select(
      'adjustment_note_items',
      `select=note_id&metadata->>billId=eq.${encodeURIComponent(billId)}`
    )
    const noteIds = Array.isArray(noteRows)
      ? noteRows.map((r: any) => r.note_id).filter(Boolean)
      : []
    if (!noteIds.length) {
      return { ok: true, value: { items: [], total: 0, page: currentPage, pageSize: limit } }
    }
    const idFilter = noteIds.map((id: string) => encodeURIComponent(String(id))).join(',')
    filters.push(`note_id=in.(${idFilter})`)
  }
  if (noteType) filters.push(`note_type=eq.${encodeURIComponent(noteType)}`)
  if (noteStatus) filters.push(`status=eq.${encodeURIComponent(noteStatus)}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const { data, total } = await supabase.selectWithCount(
    'adjustment_notes',
    `select=note_id,enterprise_id,note_type,status,total_amount,currency,created_at${filterQs}&order=created_at.desc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
  )
  const rows = Array.isArray(data) ? (data as Record<string, any>[]) : []
  return {
    ok: true,
    value: {
      items: rows.map((n) => ({
        adjustmentNoteId: n.note_id,
        enterpriseId: n.enterprise_id,
        type: n.note_type,
        status: n.status,
        totalAmount: Number(n.total_amount ?? 0),
        currency: n.currency ?? null,
        createdAt: n.created_at ?? null,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page: currentPage,
      pageSize: limit,
    },
  }
}
