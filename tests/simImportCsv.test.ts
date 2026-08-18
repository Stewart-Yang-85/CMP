import { describe, expect, it } from 'vitest'
import { parseIccidsFromAssignInventoryCsv, parseSimImportCsv, resolveRowImeiLockPairing } from '../src/services/simImportCsv.ts'

const sampleImei = '123456789012345'

describe('parseSimImportCsv', () => {
  it('accepts rows without IME Lock (iccid + imsi only)', () => {
    const csv = [
      'iccid,imsi',
      '8986012345678901234,imsi-1',
      '',
    ].join('\n')
    const result = parseSimImportCsv(csv)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rows[0].bound_imei).toBeNull()
      expect(result.rows[0].imei_lock_enabled).toBe(false)
    }
  })

  it('accepts mixed IME Lock on/off rows in one file', () => {
    const csv = [
      'iccid,imsi,imeiLockEnabled,imei',
      '8986012345678901234,imsi-1,,',
      `8986012345678901235,imsi-2,true,${sampleImei}`,
      '',
    ].join('\n')
    const result = parseSimImportCsv(csv)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rows[0].bound_imei).toBeNull()
      expect(result.rows[0].imei_lock_enabled).toBe(false)
      expect(result.rows[1].bound_imei).toBe(sampleImei)
      expect(result.rows[1].imei_lock_enabled).toBe(true)
    }
  })

  it('accepts flexible header names for IME Lock row', () => {
    const csv = [
      'ICCID,IMSI,imeiLockEnabled,bound_imei',
      `8986012345678901234,imsi-1,true,${sampleImei}`,
      '',
    ].join('\n')
    const result = parseSimImportCsv(csv)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.rows[0].bound_imei).toBe(sampleImei)
      expect(result.rows[0].imei_lock_enabled).toBe(true)
    }
  })

  it('rejects IME Lock on without imei', () => {
    const csv = [
      'iccid,imsi,imeiLockEnabled,imei',
      '8986012345678901234,imsi-1,true,',
      '',
    ].join('\n')
    const result = parseSimImportCsv(csv)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_FORMAT')
    }
  })

  it('rejects imei without imeiLockEnabled true', () => {
    const csv = [
      'iccid,imsi,imeiLockEnabled,imei',
      `8986012345678901234,imsi-1,,${sampleImei}`,
      '',
    ].join('\n')
    const result = parseSimImportCsv(csv)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_FORMAT')
    }
  })

  it('rejects explicit false with imei when lock column exists', () => {
    const csv = [
      'iccid,imsi,imeiLockEnabled,imei',
      `8986012345678901234,imsi-1,false,${sampleImei}`,
      '',
    ].join('\n')
    const result = parseSimImportCsv(csv)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('INVALID_FORMAT')
    }
  })
})

describe('parseIccidsFromAssignInventoryCsv', () => {
  it('accepts header with iccid only', () => {
    const r = parseIccidsFromAssignInventoryCsv('iccid\n8986012345678901234\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.iccids).toEqual(['8986012345678901234'])
  })

  it('accepts iccid with empty imsi column', () => {
    const r = parseIccidsFromAssignInventoryCsv('iccid,imsi\n8986012345678901234,\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.iccids).toEqual(['8986012345678901234'])
  })

  it('skips blank and IMSI-only rows; keeps valid ICCIDs', () => {
    const csv = [
      'ICCID,IMSI',
      '89860099000000100021,460011000000031',
      '89860099000000100022,',
      ',',
      ',454121000000082',
      '',
    ].join('\n')
    const r = parseIccidsFromAssignInventoryCsv(csv)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.iccids).toEqual(['89860099000000100021', '89860099000000100022'])
    }
  })

  it('rejects malformed non-empty iccid with row number', () => {
    const r = parseIccidsFromAssignInventoryCsv('iccid\n12345\n')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('INVALID_FORMAT')
      expect(r.message).toMatch(/Row 2: invalid iccid/i)
    }
  })

  it('rejects CSV without iccid column', () => {
    const r = parseIccidsFromAssignInventoryCsv('imsi\n460001234567890\n')
    expect(r.ok).toBe(false)
  })
})

describe('resolveRowImeiLockPairing', () => {
  it('treats omitted lock and imei columns as off', () => {
    const headerIndex = new Map([
      ['iccid', 0],
      ['imsi', 1],
    ])
    const result = resolveRowImeiLockPairing(['8986012345678901234', 'imsi-1'], headerIndex, 2)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.imei_lock_enabled).toBe(false)
      expect(result.bound_imei).toBeNull()
    }
  })
})
