export type ParseMarkPaidPaidAmountResult =
  | { ok: true; value: number }
  | { ok: false; message: string }

export function parseMarkPaidPaidAmount(value: unknown): ParseMarkPaidPaidAmountResult {
  if (value === undefined || value === null || typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, message: 'paidAmount is required.' }
  }
  if (value < 0) {
    return { ok: false, message: 'paidAmount must be greater than or equal to zero.' }
  }
  return { ok: true, value: Number(value.toFixed(2)) }
}
