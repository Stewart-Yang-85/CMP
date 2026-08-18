import { describe, expect, it } from 'vitest'
import { switchSubscription, SUBSCRIPTION_SWITCH_JOB_TYPE } from '../src/services/subscription.ts'

describe('subscription:switch batchId', () => {
  it('returns DUPLICATE_BATCH when batchId was already used', async () => {
    const supabase = {
      select: async (table: string, query: string) => {
        if (table === 'jobs' && query.includes(SUBSCRIPTION_SWITCH_JOB_TYPE)) {
          return [{ job_id: 'job-1', status: 'SUCCEEDED' }]
        }
        return []
      },
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
      selectWithCount: async () => ({ data: [], total: 0 }),
    }
    const result = await switchSubscription({
      supabase,
      enterpriseId: '43326e05-5704-4e0d-8175-547d6b555132',
      iccid: '89860011111111111112',
      toPackageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      batchId: 'switch-batch-001',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('DUPLICATE_BATCH')
      expect(result.message).toContain('Duplicate batch switch')
    }
  })
})
