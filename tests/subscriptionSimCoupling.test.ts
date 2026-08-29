import { describe, expect, it, vi } from 'vitest'
import {
  countActiveSubscriptionsForSim,
  maybeActivateSimWhenSoleActiveSubscription,
  maybeDeactivateSimWhenNoActiveSubscription,
} from '../src/services/subscriptionSimCoupling.ts'

const changeSimStatus = vi.fn()

vi.mock('../src/services/simLifecycle.js', () => ({
  changeSimStatus: (...args: unknown[]) => changeSimStatus(...args),
}))

describe('subscriptionSimCoupling', () => {
  it('countActiveSubscriptionsForSim counts ACTIVE only', async () => {
    const supabase = {
      select: vi.fn(async () => [{ subscription_id: 'a' }, { subscription_id: 'b' }]),
    }
    await expect(countActiveSubscriptionsForSim(supabase, 'sim-1')).resolves.toBe(2)
    expect(supabase.select).toHaveBeenCalledWith(
      'subscriptions',
      expect.stringContaining('state=eq.ACTIVE')
    )
  })

  it('maybeDeactivateSimWhenNoActiveSubscription skips when ACTIVE remain', async () => {
    changeSimStatus.mockClear()
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'subscriptions') return [{ subscription_id: 'still-active' }]
        return []
      }),
    }
    const r = await maybeDeactivateSimWhenNoActiveSubscription({ supabase, simId: 'sim-1' })
    expect(r.action).toBe('SKIPPED')
    expect(r.detail).toMatch(/STILL_HAS_ACTIVE/)
    expect(changeSimStatus).not.toHaveBeenCalled()
  })

  it('maybeDeactivateSimWhenNoActiveSubscription queues deactivate for ACTIVATED', async () => {
    changeSimStatus.mockReset()
    changeSimStatus.mockResolvedValue({ ok: true, jobId: 'j1' })
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'subscriptions') return []
        if (table === 'sims') {
          return [
            {
              sim_id: 'sim-1',
              status: 'ACTIVATED',
              reseller_id: 'r1',
            },
          ]
        }
        return []
      }),
    }
    const r = await maybeDeactivateSimWhenNoActiveSubscription({
      supabase,
      simId: 'sim-1',
      reason: 'TEST',
    })
    expect(r.action).toBe('QUEUED')
    expect(changeSimStatus).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SIM_DEACTIVATE', newStatus: 'DEACTIVATED' })
    )
  })

  it('maybeActivateSimWhenSoleActiveSubscription only for DEACTIVATED + sole ACTIVE', async () => {
    changeSimStatus.mockReset()
    changeSimStatus.mockResolvedValue({ ok: true, jobId: 'j2' })
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'subscriptions') return [{ subscription_id: 'only' }]
        if (table === 'sims') {
          return [{ sim_id: 'sim-1', status: 'DEACTIVATED', reseller_id: 'r1' }]
        }
        return []
      }),
    }
    const r = await maybeActivateSimWhenSoleActiveSubscription({ supabase, simId: 'sim-1' })
    expect(r.action).toBe('QUEUED')
    expect(changeSimStatus).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SIM_ACTIVATE', newStatus: 'ACTIVATED' })
    )
  })

  it('maybeActivateSimWhenSoleActiveSubscription skips TEST_READY', async () => {
    changeSimStatus.mockClear()
    const supabase = {
      select: vi.fn(async (table: string) => {
        if (table === 'subscriptions') return [{ subscription_id: 'only' }]
        if (table === 'sims') {
          return [{ sim_id: 'sim-1', status: 'TEST_READY', reseller_id: 'r1' }]
        }
        return []
      }),
    }
    const r = await maybeActivateSimWhenSoleActiveSubscription({ supabase, simId: 'sim-1' })
    expect(r.action).toBe('SKIPPED')
    expect(r.detail).toMatch(/TEST_READY/)
    expect(changeSimStatus).not.toHaveBeenCalled()
  })
})
