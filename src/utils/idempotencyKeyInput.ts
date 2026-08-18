export type ParseOptionalIdempotencyKeyResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string }

/** Omit or null → no key; explicit empty/whitespace string → invalid. */
export function parseOptionalIdempotencyKey(value: unknown): ParseOptionalIdempotencyKeyResult {
  if (value === undefined || value === null) {
    return { ok: true, value: null }
  }
  const trimmed = String(value).trim()
  if (trimmed === '') {
    return { ok: false, message: 'idempotencyKey must be a non-empty string when provided.' }
  }
  return { ok: true, value: trimmed }
}
