import { describe, expect, it } from 'vitest'
import {
  batchExportSubscriptions,
  SUBSCRIPTION_BATCH_EXPORT_JOB_TYPE,
} from '../src/services/subscription.ts'

describe('subscriptions:batch-export batchId', () => {
  it('returns BAD_REQUEST when batchId is missing', async () => {
    const supabase = {
      select: async () => [],
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
      selectWithCount: async () => ({ data: [], total: 0 }),
    }
    const result = await batchExportSubscriptions({
      supabase,
      enterpriseId: '43326e05-5704-4e0d-8175-547d6b555132',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.code).toBe('BAD_REQUEST')
      expect(result.message).toContain('batchId is required')
    }
  })

  it('returns DUPLICATE_BATCH when batchId was already used', async () => {
    const supabase = {
      select: async (table: string, query: string) => {
        if (table === 'jobs' && query.includes(SUBSCRIPTION_BATCH_EXPORT_JOB_TYPE)) {
          return [{ job_id: 'job-1', status: 'SUCCEEDED' }]
        }
        return []
      },
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
      selectWithCount: async () => ({ data: [], total: 0 }),
    }
    const result = await batchExportSubscriptions({
      supabase,
      enterpriseId: '43326e05-5704-4e0d-8175-547d6b555132',
      batchId: 'export-batch-001',
      tenantFilter: '',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('DUPLICATE_BATCH')
      expect(result.message).toContain('Duplicate batch export')
    }
  })
})
