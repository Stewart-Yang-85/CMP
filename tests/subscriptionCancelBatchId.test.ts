import { describe, expect, it } from 'vitest'
import { cancelSubscription, SUBSCRIPTION_CANCEL_JOB_TYPE } from '../src/services/subscription.ts'

describe('subscription cancel batchId', () => {
  it('returns DUPLICATE_BATCH when batchId was already used', async () => {
    const supabase = {
      select: async (table: string, query: string) => {
        if (table === 'jobs' && query.includes(SUBSCRIPTION_CANCEL_JOB_TYPE)) {
          return [{ job_id: 'job-1', status: 'SUCCEEDED' }]
        }
        return []
      },
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
      selectWithCount: async () => ({ data: [], total: 0 }),
    }
    const result = await cancelSubscription({
      supabase,
      enterpriseId: '43326e05-5704-4e0d-8175-547d6b555132',
      subscriptionId: 'db04df47-9756-46e1-901d-bc883c65994d',
      batchId: 'cancel-batch-001',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.code).toBe('DUPLICATE_BATCH')
      expect(result.message).toContain('Duplicate batch cancel')
    }
  })
})
