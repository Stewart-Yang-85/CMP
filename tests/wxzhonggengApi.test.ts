import { describe, expect, it } from 'vitest'
import { isWxApiSuccess } from '../src/vendors/wxzhonggeng.js'

describe('isWxApiSuccess', () => {
  it('accepts code 00000 with success true', () => {
    expect(isWxApiSuccess({ code: '00000', success: true, data: {} })).toBe(true)
  })

  it('rejects business error codes', () => {
    expect(isWxApiSuccess({ code: 'A0003', success: false, message: 'token invalid' })).toBe(false)
    expect(isWxApiSuccess({ code: 'B0001', success: true, message: 'iccid not found' })).toBe(false)
  })

  it('rejects explicit success false', () => {
    expect(isWxApiSuccess({ code: '00000', success: false })).toBe(false)
  })
})
