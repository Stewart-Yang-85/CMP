import {
  assertAdjustmentItemsIccidsForEnterprise,
} from './adjustmentNoteIccid.js'
import { parsePagination } from '../utils/pagination.js'
import { resolveEventScopeColumns, sanitizeEventPayload } from './eventEmitter.js'

const DEFAULT_ADJUSTMENT_NOTE_LIST_PAGE_SIZE = 20
const MAX_ADJUSTMENT_NOTE_LIST_PAGE_SIZE = 200

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

/** Minimal client for settlement helpers (no selectWithCount required). */
type SettlementSupabaseClient = Pick<SupabaseClient, 'select' | 'update' | 'insert'>

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
  if (v === 'DRAFT' || v === 'APPROVED' || v === 'APPLIED' || v === 'CANCELLED') return v
  return null
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

export type AdjustmentNoteListScope = {
  roleScope: string | null
  role: string | null
  resellerId: string | null
}

async function enterpriseIdsUnderReseller(supabase: SupabaseClient, resellerId: string): Promise<string[]> {
  const tenantRows = await supabase.select(
    'tenants',
    `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
  )
  return Array.isArray(tenantRows)
    ? tenantRows
        .map((r) => (r as { tenant_id?: string })?.tenant_id)
        .filter(Boolean)
        .map((v) => String(v))
    : []
}

async function assertEnterpriseInAdjustmentScope(
  supabase: SupabaseClient,
  enterpriseId: string,
  scope: AdjustmentNoteListScope | null | undefined,
  notFoundMessage: string
): Promise<ServiceResult<true>> {
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
    const ent = Array.isArray(entRows) ? (entRows[0] as { parent_id?: string | null } | undefined) : undefined
    if (!ent || String(ent.parent_id ?? '') !== String(scope.resellerId)) {
      return toError(404, 'RESOURCE_NOT_FOUND', notFoundMessage)
    }
    return { ok: true, value: true }
  }
  return toError(403, 'FORBIDDEN', 'Insufficient permissions.')
}

async function assertBillInAdjustmentListScope(
  supabase: SupabaseClient,
  billId: string,
  scope: AdjustmentNoteListScope | null | undefined
): Promise<ServiceResult<true>> {
  const billRows = await supabase.select(
    'bills',
    `select=bill_id,enterprise_id&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
  )
  const bill = Array.isArray(billRows) ? (billRows[0] as Record<string, unknown> | undefined) : undefined
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

async function appendEnterpriseScopeFilter(
  supabase: SupabaseClient,
  filters: string[],
  scope: AdjustmentNoteListScope | null | undefined
): Promise<ServiceResult<true> | { ok: true; empty: true }> {
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

async function loadAdjustmentNoteCreatorUserId(
  supabase: SupabaseClient,
  noteId: string
): Promise<string | null> {
  const rows = await supabase.select(
    'events',
    `select=actor_user_id&event_type=eq.BILL_ADJUSTMENT_NOTE_CREATED&payload->>noteId=eq.${encodeURIComponent(noteId)}&order=occurred_at.asc&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as { actor_user_id?: string | null } | undefined) : undefined
  const creator = row?.actor_user_id ? String(row.actor_user_id) : null
  return creator && isValidUuid(creator) ? creator : null
}

function normalizeIdempotencyKey(value: unknown): string | null {
  const trimmed = value != null ? String(value).trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function normalizeAdjustmentReason(value: unknown): string | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

type AdjustmentItemInput = {
  iccid?: string | null
  description?: string | null
  amount?: number | null
}

async function loadAdjustmentNoteItemsForResponse(
  supabase: SupabaseClient,
  noteId: string,
  fallbackAmount: number
): Promise<AdjustmentItemInput[]> {
  const rows = await supabase.select(
    'adjustment_note_items',
    `select=amount,metadata&note_id=eq.${encodeURIComponent(noteId)}&order=note_item_id.asc`
  )
  const itemRows = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
  if (!itemRows.length) {
    return [{ iccid: null, description: null, amount: fallbackAmount }]
  }
  return itemRows.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>
    return {
      iccid: metadata.iccid != null ? String(metadata.iccid) : null,
      description: metadata.description != null ? String(metadata.description) : null,
      amount: Number(row.amount ?? 0),
    }
  })
}

async function buildAdjustmentNoteApiValue(
  supabase: SupabaseClient,
  note: Record<string, unknown>,
  billId: string,
  options?: { items?: AdjustmentItemInput[] }
): Promise<Record<string, unknown>> {
  const noteId = String(note.note_id ?? '')
  const totalAmount = Number(note.total_amount ?? 0)
  const items =
    options?.items ?? (await loadAdjustmentNoteItemsForResponse(supabase, noteId, totalAmount))
  const resolvedBillId = note.source_bill_id ? String(note.source_bill_id) : billId
  return {
    adjustmentNoteId: noteId,
    billId: resolvedBillId,
    type: note.note_type,
    status: note.status,
    totalAmount,
    currency: note.currency ?? null,
    reason: note.reason != null ? String(note.reason) : null,
    idempotencyKey: note.idempotency_key != null ? String(note.idempotency_key) : null,
    createdAt: note.created_at ?? null,
    items,
  }
}

export async function createAdjustmentNote({
  supabase,
  billId,
  type,
  amount,
  reason,
  items,
  idempotencyKey,
  actorUserId,
  requestId,
}: {
  supabase: SupabaseClient
  billId: string
  type: string
  amount: number
  reason?: string | null
  items?: AdjustmentItemInput[] | null
  idempotencyKey?: string | null
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
    `select=bill_id,enterprise_id,reseller_id,status,currency,period_start,period_end&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
  )
  const bill = Array.isArray(billRows) ? (billRows[0] as Record<string, any>) : null
  if (!bill) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Bill not found.')
  }
  if (!['PUBLISHED', 'OVERDUE'].includes(String(bill.status || '').toUpperCase())) {
    return toError(409, 'INVALID_STATUS', 'Adjustment is only allowed for PUBLISHED or OVERDUE bills.')
  }
  const enterpriseId = String((bill as any).enterprise_id ?? '')
  const iccidCheck = await assertAdjustmentItemsIccidsForEnterprise(supabase, enterpriseId, detailItems)
  if (!iccidCheck.ok) {
    return toError(iccidCheck.status, iccidCheck.code, iccidCheck.message)
  }
  const normalizedReason = normalizeAdjustmentReason(reason)
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey)
  if (normalizedIdempotencyKey) {
    const existingRows = await supabase.select(
      'adjustment_notes',
      `select=note_id&source_bill_id=eq.${encodeURIComponent(billId)}&idempotency_key=eq.${encodeURIComponent(normalizedIdempotencyKey)}&limit=1`
    )
    const existing = Array.isArray(existingRows) ? existingRows[0] : null
    if (existing) {
      return toError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'idempotencyKey was already used for this bill.'
      )
    }
  }
  const noteRows = await supabase.insert('adjustment_notes', {
    enterprise_id: (bill as any).enterprise_id,
    source_bill_id: billId,
    note_type: noteType,
    status: 'DRAFT',
    currency: (bill as any).currency,
    total_amount: Number(computedTotal.toFixed(2)),
    reason: normalizedReason,
    idempotency_key: normalizedIdempotencyKey,
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
  const scopedEnterpriseId = isValidUuid((bill as any).enterprise_id) ? String((bill as any).enterprise_id) : null
  const actorId = isValidUuid(actorUserId) ? actorUserId : null
  const eventScope = await resolveEventScopeColumns(supabase, {
    enterpriseId: scopedEnterpriseId,
    resellerId: (bill as any).reseller_id ?? null,
  })
  await supabase.insert('events', {
    event_type: 'BILL_ADJUSTMENT_NOTE_CREATED',
    occurred_at: new Date().toISOString(),
    enterprise_id: eventScope.enterpriseId,
    reseller_id: eventScope.resellerId,
    actor_user_id: actorId,
    request_id: requestId ?? null,
    payload: sanitizeEventPayload({
      billId,
      noteId,
      type: noteType,
      amount: Number(computedTotal.toFixed(2)),
      reason: reason ? String(reason) : null,
    }),
  }, { returning: 'minimal' })
  const value = await buildAdjustmentNoteApiValue(supabase, note as Record<string, unknown>, billId, {
    items: detailItems.length
      ? detailItems
      : itemRows.map((item) => ({
        iccid: (item as any).metadata?.iccid ?? null,
        description: (item as any).metadata?.description ?? null,
        amount: Number((item as any).amount ?? 0),
      })),
  })
  return { ok: true, value }
}

export async function approveAdjustmentNote({
  supabase,
  noteId,
  actorUserId,
  requestId,
  scope,
}: {
  supabase: SupabaseClient
  noteId: string
  actorUserId?: string | null
  requestId?: string | null
  scope?: AdjustmentNoteListScope | null
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
  const storedItems = await loadAdjustmentNoteItemsForResponse(
    supabase,
    noteId,
    Number(note.total_amount ?? 0)
  )
  const iccidCheck = await assertAdjustmentItemsIccidsForEnterprise(
    supabase,
    String(note.enterprise_id ?? ''),
    storedItems
  )
  if (!iccidCheck.ok) {
    return toError(iccidCheck.status, iccidCheck.code, iccidCheck.message)
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
  const updated = Array.isArray(updatedRows) ? (updatedRows[0] as Record<string, any>) : null
  if (!updated) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to approve adjustment note.')
  }
  const enterpriseId = isValidUuid(note.enterprise_id) ? String(note.enterprise_id) : null
  const eventScope = await resolveEventScopeColumns(supabase, { enterpriseId, resellerId: null })
  await supabase.insert('events', {
    event_type: 'BILL_ADJUSTMENT_NOTE_APPROVED',
    occurred_at: new Date().toISOString(),
    enterprise_id: eventScope.enterpriseId,
    reseller_id: eventScope.resellerId,
    actor_user_id: actorId,
    request_id: requestId ?? null,
    payload: sanitizeEventPayload({
      noteId,
      type: note.note_type ?? null,
      totalAmount: Number(updated.total_amount ?? 0),
      currency: updated.currency ?? null,
    }),
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
}: {
  supabase: SupabaseClient
  billId?: string | null
  type?: string | null
  status?: string | null
  page?: number | null
  pageSize?: number | null
  scope?: AdjustmentNoteListScope | null
}): Promise<ServiceResult<Record<string, any>>> {
  const noteType = type ? normalizeType(type) : null
  if (type && !noteType) {
    return toError(400, 'BAD_REQUEST', 'type must be CREDIT or DEBIT.')
  }
  const noteStatus = status ? normalizeStatus(status) : null
  if (status && !noteStatus) {
    return toError(400, 'BAD_REQUEST', 'status is invalid.')
  }
  const { page: currentPage, pageSize: limit, offset } = parsePagination(
    { page, pageSize },
    {
      defaultPage: 1,
      defaultPageSize: DEFAULT_ADJUSTMENT_NOTE_LIST_PAGE_SIZE,
      maxPageSize: MAX_ADJUSTMENT_NOTE_LIST_PAGE_SIZE,
    }
  )
  const filters: string[] = []
  if (billId) {
    const billScope = await assertBillInAdjustmentListScope(supabase, billId, scope)
    if (!billScope.ok) return billScope
    filters.push(`source_bill_id=eq.${encodeURIComponent(billId)}`)
  }
  const enterpriseScope = await appendEnterpriseScopeFilter(supabase, filters, scope)
  if (!enterpriseScope.ok) return enterpriseScope
  if ('empty' in enterpriseScope && enterpriseScope.empty) {
    return { ok: true, value: { items: [], total: 0, page: currentPage, pageSize: limit } }
  }
  if (noteType) filters.push(`note_type=eq.${encodeURIComponent(noteType)}`)
  if (noteStatus) filters.push(`status=eq.${encodeURIComponent(noteStatus)}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const { data, total } = await supabase.selectWithCount(
    'adjustment_notes',
    `select=note_id,enterprise_id,note_type,status,total_amount,currency,reason,source_bill_id,idempotency_key,created_at${filterQs}&order=created_at.desc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`
  )
  const rows = Array.isArray(data) ? (data as Record<string, any>[]) : []
  return {
    ok: true,
    value: {
      items: rows.map((n) => ({
        adjustmentNoteId: n.note_id,
        billId: n.source_bill_id ? String(n.source_bill_id) : null,
        enterpriseId: n.enterprise_id,
        type: n.note_type,
        status: n.status,
        totalAmount: Number(n.total_amount ?? 0),
        currency: n.currency ?? null,
        reason: n.reason != null ? String(n.reason) : null,
        idempotencyKey: n.idempotency_key != null ? String(n.idempotency_key) : null,
        createdAt: n.created_at ?? null,
      })),
      total: typeof total === 'number' ? total : rows.length,
      page: currentPage,
      pageSize: limit,
    },
  }
}

export type ApprovedAdjustmentNoteRow = {
  noteId: string
  noteType: 'CREDIT' | 'DEBIT'
  totalAmount: number
  currency: string | null
  reason: string | null
}

export type ApprovedAdjustmentSettlement = {
  noteIds: string[]
  notes: ApprovedAdjustmentNoteRow[]
  creditTotal: number
  debitTotal: number
  /** DEBIT totals minus CREDIT totals (positive increases next bill). */
  netAdjustment: number
}

export function computeAdjustedBillTotal(ratingTotal: number, netAdjustment: number): number {
  return Number((Number(ratingTotal) + Number(netAdjustment)).toFixed(2))
}

export async function loadApprovedAdjustmentSettlement(
  supabase: SettlementSupabaseClient,
  enterpriseId: string,
  billCurrency: string
): Promise<ApprovedAdjustmentSettlement> {
  const rows = await supabase.select(
    'adjustment_notes',
    `select=note_id,note_type,total_amount,currency,reason&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&status=eq.APPROVED&order=created_at.asc&limit=500`
  )
  const notes = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
  const currency = String(billCurrency || 'USD')
  const matched = notes.filter((n) => String(n.currency ?? currency) === currency)
  let creditTotal = 0
  let debitTotal = 0
  const noteIds: string[] = []
  const settlementNotes: ApprovedAdjustmentNoteRow[] = []
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

export function buildAdjustmentBillLineItems(
  settlement: ApprovedAdjustmentSettlement,
  billId: string
): Record<string, unknown>[] {
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
}: {
  supabase: SettlementSupabaseClient
  noteIds: string[]
  appliedBillId: string
  enterpriseId: string
  actorUserId?: string | null
  requestId?: string | null
}): Promise<ServiceResult<{ appliedCount: number }>> {
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
