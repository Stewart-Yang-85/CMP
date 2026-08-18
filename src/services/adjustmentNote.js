function toError(status, code, message) {
  return { ok: false, status, code, message }
}

function normalizeType(value) {
  const v = String(value || '').trim().toUpperCase()
  if (v === 'CREDIT' || v === 'DEBIT') return v
  return null
}

function normalizeStatus(value) {
  const v = String(value || '').trim().toUpperCase()
  if (v === 'DRAFT' || v === 'APPROVED' || v === 'APPLIED') return v
  return null
}

function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

async function enterpriseIdsUnderReseller(supabase, resellerId) {
  const tenantRows = await supabase.select(
    'tenants',
    `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
  )
  return Array.isArray(tenantRows)
    ? tenantRows.map((r) => r?.tenant_id).filter(Boolean).map((v) => String(v))
    : []
}

async function assertEnterpriseInAdjustmentScope(supabase, enterpriseId, scope, notFoundMessage) {
  if (!scope) {
    return { ok: true, value: true }
  }
  const roleScope = scope.roleScope
  const role = scope.role
  if (roleScope === 'platform' || role === 'platform_admin') {
    return { ok: true, value: true }
  }
  if (roleScope === 'reseller') {
    if (!scope.resellerId) {
      return toError(403, 'FORBIDDEN', 'Reseller scope required.')
    }
    const entRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const ent = Array.isArray(entRows) ? entRows[0] : null
    if (!ent || String(ent.parent_id ?? '') !== String(scope.resellerId)) {
      return toError(404, 'RESOURCE_NOT_FOUND', notFoundMessage)
    }
    return { ok: true, value: true }
  }
  return toError(403, 'FORBIDDEN', 'Insufficient permissions.')
}

async function assertBillInAdjustmentListScope(supabase, billId, scope) {
  const billRows = await supabase.select(
    'bills',
    `select=bill_id,enterprise_id&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
  )
  const bill = Array.isArray(billRows) ? billRows[0] : null
  if (!bill) {
    return toError(404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
  }
  return assertEnterpriseInAdjustmentScope(
    supabase,
    String(bill.enterprise_id ?? ''),
    scope,
    `Bill ${billId} not found.`
  )
}

async function appendEnterpriseScopeFilter(supabase, filters, scope) {
  if (!scope) {
    return { ok: true, value: true }
  }
  const roleScope = scope.roleScope
  const role = scope.role
  if (roleScope === 'platform' || role === 'platform_admin') {
    return { ok: true, value: true }
  }
  if (roleScope === 'reseller') {
    if (!scope.resellerId) {
      return toError(403, 'FORBIDDEN', 'Reseller scope required.')
    }
    const enterpriseIds = await enterpriseIdsUnderReseller(supabase, scope.resellerId)
    if (!enterpriseIds.length) {
      return { ok: true, empty: true }
    }
    const encoded = enterpriseIds.map((id) => encodeURIComponent(id)).join(',')
    filters.push(`enterprise_id=in.(${encoded})`)
    return { ok: true, value: true }
  }
  return toError(403, 'FORBIDDEN', 'Insufficient permissions.')
}

async function loadAdjustmentNoteCreatorUserId(supabase, noteId) {
  const rows = await supabase.select(
    'events',
    `select=actor_user_id&event_type=eq.BILL_ADJUSTMENT_NOTE_CREATED&payload->>noteId=eq.${encodeURIComponent(noteId)}&order=occurred_at.asc&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  const creator = row?.actor_user_id ? String(row.actor_user_id) : null
  return creator && isValidUuid(creator) ? creator : null
}

export async function createAdjustmentNote({ supabase, billId, type, amount, reason, items, actorUserId, requestId }) {
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
  const bill = Array.isArray(billRows) ? billRows[0] : null
  if (!bill) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Bill not found.')
  }
  if (!['PUBLISHED', 'OVERDUE'].includes(String(bill.status || '').toUpperCase())) {
    return toError(409, 'INVALID_STATUS', 'Adjustment is only allowed for PUBLISHED or OVERDUE bills.')
  }
  const noteRows = await supabase.insert('adjustment_notes', {
    enterprise_id: bill.enterprise_id,
    note_type: noteType,
    status: 'DRAFT',
    currency: bill.currency,
    total_amount: Number(computedTotal.toFixed(2)),
    reason: reason ? String(reason) : null,
    input_ref: 'manual',
    calculation_id: 'manual',
  }, { returning: 'representation' })
  const note = Array.isArray(noteRows) ? noteRows[0] : null
  const noteId = note?.note_id ?? null
  if (!noteId) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to create adjustment note.')
  }
  const itemRows = detailItems.length
    ? detailItems.map((item) => ({
      note_id: noteId,
      item_type: 'MANUAL',
      sim_id: null,
      amount: Number(item.amount ?? 0),
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
  const tenantId = isValidUuid(bill.enterprise_id) ? bill.enterprise_id : null
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
      currency: bill.currency ?? null,
      createdAt: new Date().toISOString(),
      items: detailItems.length ? detailItems : itemRows.map((item) => ({
        iccid: item.metadata?.iccid ?? null,
        description: item.metadata?.description ?? null,
        amount: Number(item.amount ?? 0),
      })),
    },
  }
}

export async function approveAdjustmentNote({ supabase, noteId, actorUserId, requestId, scope }) {
  if (!noteId) {
    return toError(400, 'BAD_REQUEST', 'noteId is required.')
  }
  const rows = await supabase.select(
    'adjustment_notes',
    `select=note_id,status,enterprise_id,note_type,total_amount,currency&note_id=eq.${encodeURIComponent(noteId)}&limit=1`
  )
  const note = Array.isArray(rows) ? rows[0] : null
  if (!note) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Adjustment note not found.')
  }
  const enterpriseScope = await assertEnterpriseInAdjustmentScope(
    supabase,
    String(note.enterprise_id ?? ''),
    scope,
    'Adjustment note not found.'
  )
  if (!enterpriseScope.ok) return enterpriseScope
  if (String(note.status || '').toUpperCase() !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT notes can be approved.')
  }
  const actorId = actorUserId && isValidUuid(actorUserId) ? String(actorUserId) : null
  if (actorId) {
    const creatorUserId = await loadAdjustmentNoteCreatorUserId(supabase, noteId)
    if (creatorUserId && creatorUserId === actorId) {
      return toError(403, 'FORBIDDEN', 'Creator cannot approve their own adjustment note.')
    }
  }
  const updatedRows = await supabase.update(
    'adjustment_notes',
    `note_id=eq.${encodeURIComponent(noteId)}`,
    { status: 'APPROVED' },
    { returning: 'representation' }
  )
  const updated = Array.isArray(updatedRows) ? updatedRows[0] : null
  if (!updated) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to approve adjustment note.')
  }
  const tenantId = isValidUuid(note.enterprise_id) ? String(note.enterprise_id) : null
  await supabase.insert('events', {
    event_type: 'BILL_ADJUSTMENT_NOTE_APPROVED',
    occurred_at: new Date().toISOString(),
    tenant_id: tenantId,
    actor_user_id: actorId,
    request_id: requestId ?? null,
    payload: {
      noteId,
      type: note.note_type ?? null,
      totalAmount: Number(updated.total_amount ?? 0),
      currency: updated.currency ?? null,
    },
  }, { returning: 'minimal' })
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
  scope,
}) {
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
  const filters = []
  if (billId) {
    const billScope = await assertBillInAdjustmentListScope(supabase, billId, scope)
    if (!billScope.ok) return billScope
    const noteRows = await supabase.select(
      'adjustment_note_items',
      `select=note_id&metadata->>billId=eq.${encodeURIComponent(billId)}`
    )
    const noteIds = Array.isArray(noteRows) ? noteRows.map((r) => r.note_id).filter(Boolean) : []
    if (!noteIds.length) {
      return { ok: true, value: { items: [], total: 0, page: currentPage, pageSize: limit } }
    }
    const idFilter = noteIds.map((id) => encodeURIComponent(String(id))).join(',')
    filters.push(`note_id=in.(${idFilter})`)
  }
  const enterpriseScope = await appendEnterpriseScopeFilter(supabase, filters, scope)
  if (!enterpriseScope.ok) return enterpriseScope
  if (enterpriseScope.empty) {
    return { ok: true, value: { items: [], total: 0, page: currentPage, pageSize: limit } }
  }
  if (noteType) filters.push(`note_type=eq.${encodeURIComponent(noteType)}`)
  if (noteStatus) filters.push(`status=eq.${encodeURIComponent(noteStatus)}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const { data, total } = await supabase.selectWithCount(
    'adjustment_notes',
    `select=note_id,enterprise_id,note_type,status,total_amount,currency,created_at${filterQs}&order=created_at.desc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
  )
  const rows = Array.isArray(data) ? data : []
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

export function computeAdjustedBillTotal(ratingTotal, netAdjustment) {
  return Number((Number(ratingTotal) + Number(netAdjustment)).toFixed(2))
}

export async function loadApprovedAdjustmentSettlement(supabase, enterpriseId, billCurrency) {
  const rows = await supabase.select(
    'adjustment_notes',
    `select=note_id,note_type,total_amount,currency,reason&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&status=eq.APPROVED&order=created_at.asc&limit=500`
  )
  const notes = Array.isArray(rows) ? rows : []
  const currency = String(billCurrency || 'USD')
  const matched = notes.filter((n) => String(n.currency ?? currency) === currency)
  let creditTotal = 0
  let debitTotal = 0
  const noteIds = []
  const settlementNotes = []
  for (const n of matched) {
    const noteType = normalizeType(n.note_type)
    if (!noteType) continue
    const amount = Number(n.total_amount ?? 0)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const noteId = n.note_id ? String(n.note_id) : ''
    if (!noteId) continue
    noteIds.push(noteId)
    settlementNotes.push({
      noteId,
      noteType,
      totalAmount: amount,
      currency: n.currency ? String(n.currency) : currency,
      reason: n.reason != null ? String(n.reason) : null,
    })
    if (noteType === 'CREDIT') creditTotal += amount
    else debitTotal += amount
  }
  const netAdjustment = Number((debitTotal - creditTotal).toFixed(2))
  return {
    noteIds,
    notes: settlementNotes,
    creditTotal: Number(creditTotal.toFixed(2)),
    debitTotal: Number(debitTotal.toFixed(2)),
    netAdjustment,
  }
}

export function buildAdjustmentBillLineItems(settlement, billId) {
  return settlement.notes.map((note) => ({
    bill_id: billId,
    item_type: note.noteType === 'CREDIT' ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT',
    sim_id: null,
    package_id: null,
    amount: note.totalAmount,
    metadata: {
      noteId: note.noteId,
      adjustmentType: note.noteType,
      reason: note.reason,
      description: note.reason ?? `Adjustment ${note.noteType}`,
    },
    group_key: 'ADJUSTMENT',
    group_type: 'ADJUSTMENT',
  }))
}

export async function markAdjustmentNotesApplied({
  supabase,
  noteIds,
  appliedBillId,
  enterpriseId,
  actorUserId,
  requestId,
}) {
  if (!noteIds.length) {
    return { ok: true, value: { appliedCount: 0 } }
  }
  const idList = noteIds.map((id) => encodeURIComponent(id)).join(',')
  await supabase.update(
    'adjustment_notes',
    `note_id=in.(${idList})&status=eq.APPROVED`,
    { status: 'APPLIED' },
    { returning: 'minimal' }
  )
  const tenantId = isValidUuid(enterpriseId) ? enterpriseId : null
  const actorId = actorUserId && isValidUuid(actorUserId) ? actorUserId : null
  const occurredAt = new Date().toISOString()
  for (const noteId of noteIds) {
    await supabase.insert(
      'events',
      {
        event_type: 'BILL_ADJUSTMENT_NOTE_APPLIED',
        occurred_at: occurredAt,
        tenant_id: tenantId,
        actor_user_id: actorId,
        request_id: requestId ?? null,
        payload: {
          noteId,
          appliedBillId,
          enterpriseId,
        },
      },
      { returning: 'minimal' }
    )
  }
  return { ok: true, value: { appliedCount: noteIds.length } }
}
