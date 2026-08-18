import { resolveEventScopeColumns, sanitizeEventPayload } from './eventEmitter.js'

type IccidSupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

export type AdjustmentItemIccidInput = {
  iccid?: string | null
}

export type AdjustmentIccidIssue = {
  noteId: string
  iccid: string
  code: 'INVALID_ICCID' | 'SIM_NOT_FOUND'
}

type ValidationResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

function validationError(status: number, code: string, message: string): ValidationResult {
  return { ok: false, status, code, message }
}

/** Returns trimmed ICCID when provided; null when field omitted. */
export function normalizeAdjustmentItemIccid(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

export function collectUniqueIccidsFromItems(items: AdjustmentItemIccidInput[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const item of items) {
    if (item?.iccid === undefined || item?.iccid === null) continue
    const trimmed = String(item.iccid).trim()
    if (!trimmed) continue
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      ordered.push(trimmed)
    }
  }
  return ordered
}

export function assertAdjustmentItemsIccidFields(items: AdjustmentItemIccidInput[]): ValidationResult {
  for (const item of items) {
    if (item?.iccid === undefined || item?.iccid === null) continue
    if (String(item.iccid).trim() === '') {
      return validationError(
        400,
        'INVALID_ICCID',
        'items[].iccid must be a non-empty string when provided.'
      )
    }
  }
  return { ok: true }
}

async function loadKnownEnterpriseIccids(
  supabase: IccidSupabaseClient,
  enterpriseId: string,
  iccids: string[]
): Promise<Set<string>> {
  if (!iccids.length) return new Set()
  const encoded = iccids.map((iccid) => encodeURIComponent(iccid)).join(',')
  const rows = await supabase.select(
    'sims',
    `select=iccid&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&iccid=in.(${encoded})`
  )
  const list = Array.isArray(rows) ? (rows as Array<{ iccid?: string | null }>) : []
  return new Set(list.map((row) => String(row.iccid ?? '')).filter(Boolean))
}

function missingIccids(requested: string[], known: Set<string>): string[] {
  return requested.filter((iccid) => !known.has(iccid))
}

function formatSimNotFoundMessage(iccids: string[]): string {
  if (iccids.length === 1) {
    return `sim ${iccids[0]} not found for this enterprise.`
  }
  return `Invalid adjustment item ICCIDs (not found for this enterprise): ${iccids.join(', ')}.`
}

export async function assertAdjustmentItemsIccidsForEnterprise(
  supabase: IccidSupabaseClient,
  enterpriseId: string,
  items: AdjustmentItemIccidInput[]
): Promise<ValidationResult> {
  const fieldCheck = assertAdjustmentItemsIccidFields(items)
  if (!fieldCheck.ok) return fieldCheck
  const iccids = collectUniqueIccidsFromItems(items)
  if (!iccids.length) return { ok: true }
  const known = await loadKnownEnterpriseIccids(supabase, enterpriseId, iccids)
  const missing = missingIccids(iccids, known)
  if (missing.length) {
    return validationError(404, 'SIM_NOT_FOUND', formatSimNotFoundMessage(missing))
  }
  return { ok: true }
}

async function loadAdjustmentNoteItemsByNoteIds(
  supabase: IccidSupabaseClient,
  noteIds: string[]
): Promise<Array<{ note_id: string; iccid: string | null }>> {
  if (!noteIds.length) return []
  const encoded = noteIds.map((id) => encodeURIComponent(id)).join(',')
  const rows = await supabase.select(
    'adjustment_note_items',
    `select=note_id,metadata&note_id=in.(${encoded})&order=note_item_id.asc`
  )
  const list = Array.isArray(rows) ? (rows as Array<{ note_id?: string; metadata?: Record<string, unknown> }>) : []
  return list.map((row) => {
    const metadata = row.metadata ?? {}
    const raw = metadata.iccid
    return {
      note_id: String(row.note_id ?? ''),
      iccid: raw === undefined || raw === null ? null : String(raw),
    }
  })
}

export async function findInvalidAdjustmentNoteIccids(
  supabase: IccidSupabaseClient,
  enterpriseId: string,
  noteIds: string[]
): Promise<AdjustmentIccidIssue[]> {
  if (!noteIds.length) return []
  const itemRows = await loadAdjustmentNoteItemsByNoteIds(supabase, noteIds)
  const byNote = new Map<string, string[]>()
  for (const row of itemRows) {
    if (!row.note_id) continue
    if (row.iccid === null) continue
    const trimmed = row.iccid.trim()
    if (!trimmed) {
      const list = byNote.get(row.note_id) ?? []
      list.push('')
      byNote.set(row.note_id, list)
      continue
    }
    const list = byNote.get(row.note_id) ?? []
    if (!list.includes(trimmed)) list.push(trimmed)
    byNote.set(row.note_id, list)
  }
  const allIccids = collectUniqueIccidsFromItems(
    itemRows
      .filter((row) => row.iccid != null && row.iccid.trim() !== '')
      .map((row) => ({ iccid: row.iccid }))
  )
  const known = allIccids.length ? await loadKnownEnterpriseIccids(supabase, enterpriseId, allIccids) : new Set<string>()
  const issues: AdjustmentIccidIssue[] = []
  for (const [noteId, iccids] of byNote.entries()) {
    for (const iccid of iccids) {
      if (!iccid) {
        issues.push({ noteId, iccid: '', code: 'INVALID_ICCID' })
        continue
      }
      if (!known.has(iccid)) {
        issues.push({ noteId, iccid, code: 'SIM_NOT_FOUND' })
      }
    }
  }
  return issues
}

export async function emitAdjustmentIccidSettlementWarnings({
  supabase,
  enterpriseId,
  appliedBillId,
  jobId,
  requestId,
  actorUserId,
  issues,
}: {
  supabase: IccidSupabaseClient
  enterpriseId: string
  appliedBillId: string
  jobId?: string | null
  requestId?: string | null
  actorUserId?: string | null
  issues: AdjustmentIccidIssue[]
}): Promise<void> {
  if (!issues.length) return
  const isValidUuid = (value: unknown) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim())
  const eventScope = await resolveEventScopeColumns(supabase as any, {
    enterpriseId: isValidUuid(enterpriseId) ? enterpriseId : null,
    resellerId: null,
  })
  await supabase.insert(
    'events',
    {
      event_type: 'BILL_ADJUSTMENT_ICCID_WARNING',
      occurred_at: new Date().toISOString(),
      enterprise_id: eventScope.enterpriseId,
      reseller_id: eventScope.resellerId,
      actor_user_id: isValidUuid(actorUserId) ? actorUserId : null,
      request_id: requestId ?? null,
      job_id: jobId ?? null,
      payload: sanitizeEventPayload({
        enterpriseId,
        appliedBillId,
        jobId: jobId ?? null,
        issueCount: issues.length,
        issues,
      }),
    },
    { returning: 'minimal' }
  )
}
