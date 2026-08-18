import { describe, expect, it } from 'vitest'
import { parseMarkPaidPaidAmount } from '../src/utils/markPaidInput.ts'

describe('parseMarkPaidPaidAmount', () => {
  it('accepts zero and positive finite numbers', () => {
    expect(parseMarkPaidPaidAmount(0)).toEqual({ ok: true, value: 0 })
    expect(parseMarkPaidPaidAmount(15480.5)).toEqual({ ok: true, value: 15480.5 })
    expect(parseMarkPaidPaidAmount(10.126)).toEqual({ ok: true, value: 10.13 })
  })

  it('rejects missing, non-number, non-finite, and negative values', () => {
    expect(parseMarkPaidPaidAmount(undefined).ok).toBe(false)
    expect(parseMarkPaidPaidAmount(null).ok).toBe(false)
    expect(parseMarkPaidPaidAmount('100').ok).toBe(false)
    expect(parseMarkPaidPaidAmount(Number.NaN).ok).toBe(false)
    const negative = parseMarkPaidPaidAmount(-1)
    expect(negative.ok).toBe(false)
    if (!negative.ok) {
      expect(negative.message).toContain('greater than or equal to zero')
    }
  })
})
