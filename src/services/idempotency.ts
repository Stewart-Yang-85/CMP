import { createSupabaseRestClient } from '../supabaseRest.js'

export type IdempotencyCheckInput = {
  table: string
  idempotencyKey: string
  field?: string
  select?: string
  traceId?: string | null
}

export type IdempotencyResult<T> = {
  isDuplicate: boolean
  existing: T | null
}

export async function findExistingByIdempotencyKey<T = Record<string, unknown>>(input: IdempotencyCheckInput): Promise<T | null> {
  const field = input.field ?? 'idempotency_key'
  const select = input.select ?? '*'
  const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: input.traceId ?? null })
  const rows = await supabase.select(
    input.table,
    `select=${select}&${field}=eq.${encodeURIComponent(input.idempotencyKey)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row as T | null
}

export async function checkIdempotency<T = Record<string, unknown>>(input: IdempotencyCheckInput): Promise<IdempotencyResult<T>> {
  const existing = await findExistingByIdempotencyKey<T>(input)
  return { isDuplicate: Boolean(existing), existing }
}
