import { describe, expect, it } from 'vitest'
import { enqueueSubscriptionProvisionJob } from '../src/services/subscriptionProvisionJob.js'

describe('enqueueSubscriptionProvisionJob', () => {
  it('stores null actor_user_id when audit actor is a non-uuid platform subject', async () => {
    const inserted: Record<string, unknown>[] = []
    const supabase = {
      insert: async (_table: string, row: Record<string, unknown>) => {
        inserted.push(row)
        return [{ job_id: 'job-1' }]
      },
    }
    const jobId = await enqueueSubscriptionProvisionJob({
      supabase,
      subscriptionId: 'sub-1',
      enterpriseId: 'ent-1',
      iccid: '8931070325366421070',
      packageId: 'pkg-1',
      externalProductId: 'ext-1',
      effectiveAt: '2026-05-27T04:08:00.000Z',
      beforeState: 'PROVISIONING',
      audit: { actorUserId: 'cmp-admin', requestId: 'req-1' },
      idempotencyKey: 'idem-1',
    })
    expect(jobId).toBe('job-1')
    expect(inserted[0]?.actor_user_id).toBeNull()
  })
})
