import { describe, expect, it, vi } from 'vitest'
import { runOneTimeSubscriptionExpiry } from '../src/services/subscriptionOneTimeExpiry.ts'

vi.mock('../src/services/eventEmitter.js', () => ({
  emitEvent: vi.fn(async () => undefined),
}))

const deactivateMock = vi.fn(async () => ({ action: 'QUEUED' as const, jobId: 'job-sim-1' }))

vi.mock('../src/services/subscriptionSimCoupling.js', () => ({
  maybeDeactivateSimWhenNoActiveSubscription: (...args: unknown[]) => deactivateMock(...args),
}))

describe('runOneTimeSubscriptionExpiry', () => {
  it('expires ACTIVE ONE_TIME when expires_at elapsed and couples SIM deactivate', async () => {
    deactivateMock.mockClear()
    const updates: Array<{ table: string; match: string; patch: Record<string, unknown> }> = []
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'subscriptions') {
          return [
            {
              subscription_id: 'sub-1',
              enterprise_id: 'ent-1',
              sim_id: 'sim-1',
              package_id: 'pkg-1',
              state: 'ACTIVE',
              subscription_kind: 'MAIN',
              expires_at: '2020-01-01T00:00:00.000Z',
            },
          ]
        }
        if (table === 'packages') {
          return [{ package_id: 'pkg-1', price_plan_id: 'pp-1' }]
        }
        if (table === 'price_plans') {
          return [{ price_plan_id: 'pp-1', type: 'ONE_TIME' }]
        }
        return []
      }),
      selectWithCount: vi.fn(async () => ({ data: [], total: 0 })),
      update: vi.fn(async (table: string, match: string, patch: Record<string, unknown>) => {
        updates.push({ table, match, patch })
        return []
      }),
      insert: vi.fn(async () => []),
    }

    const result = await runOneTimeSubscriptionExpiry({
      supabase,
      now: new Date('2026-01-01T00:00:00.000Z'),
      requestId: 'test-req',
    })

    expect(result.ok).toBe(true)
    expect(result.value.processed).toBe(1)
    expect(updates.some((u) => u.table === 'subscriptions' && u.patch.state === 'EXPIRED')).toBe(true)
    expect(deactivateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        simId: 'sim-1',
        reason: 'ONE_TIME_EXPIRED_NO_ACTIVE_SUBSCRIPTION',
      })
    )
    expect(result.value.results[0]?.simLifecycle?.action).toBe('QUEUED')
  })

  it('skips non-ONE_TIME even if expires_at set', async () => {
    deactivateMock.mockClear()
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'subscriptions') {
          return [
            {
              subscription_id: 'sub-2',
              enterprise_id: 'ent-1',
              package_id: 'pkg-2',
              state: 'ACTIVE',
              expires_at: '2020-01-01T00:00:00.000Z',
            },
          ]
        }
        if (table === 'packages') {
          return [{ package_id: 'pkg-2', price_plan_id: 'pp-2' }]
        }
        if (table === 'price_plans') {
          return [{ price_plan_id: 'pp-2', type: 'FIXED_BUNDLE' }]
        }
        return []
      }),
      selectWithCount: vi.fn(async () => ({ data: [], total: 0 })),
      update: vi.fn(async () => []),
      insert: vi.fn(async () => []),
    }

    const result = await runOneTimeSubscriptionExpiry({
      supabase,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })

    expect(result.ok).toBe(true)
    expect(result.value.processed).toBe(0)
    expect(deactivateMock).not.toHaveBeenCalled()
  })
})
