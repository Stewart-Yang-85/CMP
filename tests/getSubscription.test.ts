import { describe, expect, it } from 'vitest'
import { getSubscription } from '../src/services/subscription.ts'

describe('getSubscription', () => {
  const subscriptionRow = {
    subscription_id: 'a477f2c2-547b-431a-99d6-64bf769258c8',
    sim_id: 'sim-1',
    enterprise_id: '43326e05-5704-4e0d-8175-547d6b555132',
    package_id: '23aacb0a-bf95-4438-ad60-f7e2695699dd',
    subscription_kind: 'ADD_ON',
    state: 'PENDING',
    effective_at: '2026-06-01T00:00:00.000Z',
    expires_at: null,
    cancelled_at: null,
    first_subscribed_at: '2026-06-01T00:00:00.000Z',
    commitment_end_at: '2028-06-01T00:00:00.000Z',
  }

  it('loads by subscriptionId without enterpriseId parameter', async () => {
    const supabase = {
      select: async (table: string, query: string) => {
        if (table === 'subscriptions' && query.includes('subscription_id=eq.')) {
          return [subscriptionRow]
        }
        if (table === 'packages') return [{ package_id: subscriptionRow.package_id, name: 'Pkg A' }]
        if (table === 'sims') return [{ sim_id: 'sim-1', iccid: '89860011111111111112' }]
        return []
      },
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
      selectWithCount: async () => ({ data: [], total: 0 }),
    }
    const result = await getSubscription({
      supabase,
      subscriptionId: subscriptionRow.subscription_id,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.subscriptionId).toBe(subscriptionRow.subscription_id)
      expect(result.value.enterpriseId).toBe(subscriptionRow.enterprise_id)
    }
  })

  it('returns 404 when subscriptionId not found', async () => {
    const supabase = {
      select: async () => [],
      insert: async () => [],
      update: async () => [],
      delete: async () => [],
      selectWithCount: async () => ({ data: [], total: 0 }),
    }
    const result = await getSubscription({
      supabase,
      subscriptionId: 'a477f2c2-547b-431a-99d6-64bf769258c8',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
      expect(result.code).toBe('SUBSCRIPTION_NOT_FOUND')
    }
  })
})
