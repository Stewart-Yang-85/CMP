import crypto from 'node:crypto'
import type { ParseAssignIccidsResult } from '../services/simImportCsv.js'

export type BatchStatusChangeFields = {
  action: string
  reason: string | null
  confirm: boolean
  commitmentExempt: boolean
  idempotencyKey: string | null
  batchId: string | null
}

export type ResolveBatchStatusChangeInputResult =
  | {
      ok: true
      iccids: string[]
      fields: BatchStatusChangeFields
      source: 'json' | 'csv' | 'form'
      /** SHA-256 hex of CSV bytes when source is **csv** (used as idempotency key if batchId omitted). */
      fileHash?: string | null
    }
  | { ok: false; status: number; code: string; message: string }

/** Normalize Swagger / client action labels to internal enum (ACTIVATE, MARK_TEST_READY, …). */
export function normalizeBatchLifecycleAction(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const slug = s.replace(/-/g, '_').replace(/\s+/g, '_').toUpperCase()
  if (slug === 'MARKTESTREADY') return 'MARK_TEST_READY'
  return slug
}

function parseMultipartBool(value: unknown): boolean {
  if (value === true) return true
  if (value === false) return false
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1'
}

function parseIccidListField(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) {
    return (value as unknown[]).map((v) => String(v).trim()).filter(Boolean)
  }
  const s = String(value).trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s) as unknown
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean)
      }
    } catch {
      return []
    }
  }
  return s
    .split(/[,\n\r]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function extractFields(
  record: Record<string, unknown>,
):
  | { ok: true; fields: BatchStatusChangeFields }
  | { ok: false; status: number; code: string; message: string } {
  const actionValue = normalizeBatchLifecycleAction(record.action)
  if (!actionValue) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'action is required.' }
  }
  const confirm = record.confirm === true || parseMultipartBool(record.confirm)
  if (actionValue === 'RETIRE' && !confirm) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'confirm must be true.' }
  }
  const reason =
    record.reason != null && String(record.reason).trim() !== '' ? String(record.reason).trim() : null
  if (
    (actionValue === 'DEACTIVATE' || actionValue === 'RETIRE' || actionValue === 'MARK_TEST_READY') &&
    !reason
  ) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'reason is required.' }
  }
  return {
    ok: true,
    fields: {
      action: actionValue,
      reason,
      confirm,
      commitmentExempt: record.commitmentExempt === true || parseMultipartBool(record.commitmentExempt),
      idempotencyKey:
        record.idempotencyKey != null && String(record.idempotencyKey).trim() !== ''
          ? String(record.idempotencyKey).trim()
          : null,
      batchId: record.batchId != null && String(record.batchId).trim() !== '' ? String(record.batchId).trim() : null,
    },
  }
}

function jsonIccidListProvided(body: Record<string, unknown>): boolean {
  return body.iccids !== undefined
}

function jsonFileProvided(body: Record<string, unknown>): boolean {
  return body.file !== undefined && body.file !== null
}

function resolveIccidsFromBody(body: Record<string, unknown>): string[] {
  const ids = body.iccids
  return Array.isArray(ids) ? (ids as unknown[]).map((v) => String(v)) : []
}

export function resolveBatchStatusChangeInput(input: {
  contentType: string
  jsonBody?: Record<string, unknown> | null
  multipartFields?: Record<string, unknown>
  multipartFiles?: Record<string, { content?: string } | undefined>
  parseCsv: (csvText: string) => ParseAssignIccidsResult
}): ResolveBatchStatusChangeInputResult {
  const isMultipart = input.contentType.toLowerCase().includes('multipart/form-data')

  if (isMultipart) {
    const fields = input.multipartFields ?? {}
    const files = input.multipartFiles ?? {}
    const formIccids = parseIccidListField(fields.iccids)
    const hasFormList = formIccids.length > 0 || fields.iccids !== undefined
    const file = files.file
    const hasFile = Boolean(file?.content && String(file.content).trim() !== '')

    if (hasFormList && formIccids.length > 0 && hasFile) {
      return {
        ok: false,
        status: 400,
        code: 'BATCH_INPUT_CONFLICT',
        message: 'Provide either iccids or file, not both.',
      }
    }
    if (!hasFile && formIccids.length === 0) {
      return {
        ok: false,
        status: 400,
        code: 'BAD_REQUEST',
        message: hasFormList ? 'iccids must be a non-empty list.' : 'iccids or file is required.',
      }
    }

    const fieldResult = extractFields(fields)
    if (!fieldResult.ok) return fieldResult

    if (hasFile) {
    const csvText = String(file!.content)
    const parsed = input.parseCsv(csvText)
    if (!parsed.ok) {
      return { ok: false, status: parsed.status, code: parsed.code, message: parsed.message }
    }
    const fileHash = crypto.createHash('sha256').update(Buffer.from(csvText, 'utf8')).digest('hex')
    return {
      ok: true,
      iccids: parsed.iccids,
      fields: fieldResult.fields,
      source: 'csv',
      fileHash,
    }
    }

    if (formIccids.length > 100) {
      return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'iccids must not exceed 100 items.' }
    }

    return {
      ok: true,
      iccids: formIccids,
      fields: fieldResult.fields,
      source: 'form',
    }
  }

  const body = input.jsonBody ?? {}
  const hasList = jsonIccidListProvided(body)
  const hasFile = jsonFileProvided(body)

  if (hasList && hasFile) {
    return {
      ok: false,
      status: 400,
      code: 'BATCH_INPUT_CONFLICT',
      message: 'Provide either iccids or file, not both.',
    }
  }
  if (!hasList) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'iccids must be a non-empty array.' }
  }

  const fieldResult = extractFields(body)
  if (!fieldResult.ok) return fieldResult

  const iccids = resolveIccidsFromBody(body)
  if (iccids.length === 0) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'iccids must be a non-empty array.' }
  }
  if (iccids.length > 100) {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'iccids must not exceed 100 items.' }
  }

  return { ok: true, iccids, fields: fieldResult.fields, source: 'json' }
}
