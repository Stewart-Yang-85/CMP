import { describe, expect, it } from 'vitest'
import { parseIccidsFromAssignInventoryCsv } from '../src/services/simImportCsv.js'
import {
  normalizeBatchLifecycleAction,
  resolveBatchStatusChangeInput,
} from '../src/utils/batchStatusChangeInput.js'

const VALID_ICCID = '8986012345678901234'
const VALID_CSV = `iccid\n${VALID_ICCID}\n`

describe('normalizeBatchLifecycleAction', () => {
  it('maps Swagger labels to internal enums', () => {
    expect(normalizeBatchLifecycleAction('Activate')).toBe('ACTIVATE')
    expect(normalizeBatchLifecycleAction('Mark-test-ready')).toBe('MARK_TEST_READY')
  })
})

describe('resolveBatchStatusChangeInput', () => {
  it('accepts JSON iccids', () => {
    const result = resolveBatchStatusChangeInput({
      contentType: 'application/json',
      jsonBody: {
        action: 'Deactivate',
        iccids: [VALID_ICCID],
        reason: 'test',
      },
      parseCsv: parseIccidsFromAssignInventoryCsv,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('json')
      expect(result.iccids).toEqual([VALID_ICCID])
      expect(result.fields.action).toBe('DEACTIVATE')
    }
  })

  it('rejects JSON when iccids and file are both present', () => {
    const result = resolveBatchStatusChangeInput({
      contentType: 'application/json',
      jsonBody: {
        action: 'Deactivate',
        iccids: [VALID_ICCID],
        file: 'ignored',
      },
      parseCsv: parseIccidsFromAssignInventoryCsv,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('BATCH_INPUT_CONFLICT')
    }
  })

  it('rejects JSON with empty iccids', () => {
    const result = resolveBatchStatusChangeInput({
      contentType: 'application/json',
      jsonBody: { action: 'Deactivate', iccids: [] },
      parseCsv: parseIccidsFromAssignInventoryCsv,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('BAD_REQUEST')
  })

  it('accepts multipart CSV file', () => {
    const result = resolveBatchStatusChangeInput({
      contentType: 'multipart/form-data; boundary=----test',
      multipartFields: { action: 'RETIRE', confirm: 'true', reason: 'done' },
      multipartFiles: { file: { content: VALID_CSV } },
      parseCsv: parseIccidsFromAssignInventoryCsv,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('csv')
      expect(result.iccids).toEqual([VALID_ICCID])
      expect(result.fields.confirm).toBe(true)
    }
  })

  it('rejects multipart when iccids field and file are both present', () => {
    const result = resolveBatchStatusChangeInput({
      contentType: 'multipart/form-data; boundary=----test',
      multipartFields: { action: 'Deactivate', iccids: VALID_ICCID },
      multipartFiles: { file: { content: VALID_CSV } },
      parseCsv: parseIccidsFromAssignInventoryCsv,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('BATCH_INPUT_CONFLICT')
  })

  it('rejects multipart without file', () => {
    const result = resolveBatchStatusChangeInput({
      contentType: 'multipart/form-data; boundary=----test',
      multipartFields: { action: 'DEACTIVATE' },
      multipartFiles: {},
      parseCsv: parseIccidsFromAssignInventoryCsv,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('BAD_REQUEST')
  })

  it('accepts multipart iccids list without file', () => {
    const result = resolveBatchStatusChangeInput({
      contentType: 'multipart/form-data; boundary=----test',
      multipartFields: { action: 'Mark-test-ready', reason: 'ready', iccids: `${VALID_ICCID},8986012345678901235` },
      multipartFiles: {},
      parseCsv: parseIccidsFromAssignInventoryCsv,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('form')
      expect(result.fields.action).toBe('MARK_TEST_READY')
      expect(result.iccids.length).toBe(2)
    }
  })

  it('requires confirm for Retire in JSON', () => {
    const result = resolveBatchStatusChangeInput({
      contentType: 'application/json',
      jsonBody: { action: 'Retire', iccids: [VALID_ICCID], reason: 'end' },
      parseCsv: parseIccidsFromAssignInventoryCsv,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('confirm')
  })
})
