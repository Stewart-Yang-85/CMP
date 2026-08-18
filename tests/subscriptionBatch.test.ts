import { describe, expect, it } from 'vitest'
import {
  batchCreateSubscriptions,
  extractBatchCreateIccidsFromCsv,
  splitIccidFileLines,
  SUBSCRIPTION_BATCH_CREATE_JOB_TYPE,
} from '../src/services/subscription.ts'

describe('subscription batch file parsing', () => {
  it('strips BOM, splits lines, trims, skips empty', () => {
    const raw = '\uFEFF89860011111111111112\n\r\n89860011111111111113  \n'
    expect(splitIccidFileLines(raw)).toEqual(['89860011111111111112', '89860011111111111113'])
  })

  it('returns empty array for whitespace-only', () => {
    expect(splitIccidFileLines('  \n\t\n')).toEqual([])
  })
})

describe('subscription batch-create csv parsing', () => {
  it('uses iccid column and ignores imsi/msisdn columns', () => {
    const csv = [
      'iccid,imsi,msisdn',
      '89860011111111111112,460010000000001,8613812340001',
      '89860011111111111113,460010000000002,8613812340002',
    ].join('\n')
    const parsed = extractBatchCreateIccidsFromCsv(csv)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.lines).toEqual(['89860011111111111112', '89860011111111111113'])
    }
  })

  it('returns BAD_REQUEST when iccid column is missing', () => {
    const parsed = extractBatchCreateIccidsFromCsv('imsi,msisdn\n46001,86138')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.code).toBe('BAD_REQUEST')
      expect(parsed.message).toBe('CSV file must contain iccid column.')
    }
  })
})

describe('subscription batch-create batchId', () => {
  it('returns DUPLICATE_BATCH when idempotency key already exists', async () => {
    const supabase = {
      select: async (table: string, query: string) => {
        if (table === 'jobs' && query.includes(SUBSCRIPTION_BATCH_CREATE_JOB_TYPE)) {
          return [{ job_id: 'existing-job', status: 'SUCCEEDED' }]
        }
        return []
      },
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
      selectWithCount: async () => ({ data: [], total: 0 }),
    }
    const csv = 'iccid\n89860011111111111112\n'
    const result = await batchCreateSubscriptions({
      supabase,
      enterpriseId: '43326e05-5704-4e0d-8175-547d6b555132',
      packageId: '23aacb0a-bf95-4438-ad60-f7e2695699dd',
      fileText: csv,
      tenantFilter: '',
      batchId: 'batch-2026-05-27-001',
      fileHash: 'abc123',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('DUPLICATE_BATCH')
    }
  })
})
