import { describe, expect, it, afterEach } from 'vitest'
import { getTestReadyDaysWithoutMainSubscription } from '../src/services/testReadyExpiry.ts'

describe('getTestReadyDaysWithoutMainSubscription', () => {
  const prevNew = process.env.TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION
  const prevLegacy = process.env.TEST_PERIOD_DAYS

  afterEach(() => {
    if (prevNew === undefined) delete process.env.TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION
    else process.env.TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION = prevNew
    if (prevLegacy === undefined) delete process.env.TEST_PERIOD_DAYS
    else process.env.TEST_PERIOD_DAYS = prevLegacy
  })

  it('defaults to 30', () => {
    delete process.env.TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION
    delete process.env.TEST_PERIOD_DAYS
    expect(getTestReadyDaysWithoutMainSubscription()).toBe(30)
  })

  it('reads TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION', () => {
    process.env.TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION = '14'
    delete process.env.TEST_PERIOD_DAYS
    expect(getTestReadyDaysWithoutMainSubscription()).toBe(14)
  })

  it('falls back to legacy TEST_PERIOD_DAYS', () => {
    delete process.env.TEST_READY_DAYS_WITHOUT_MAIN_SUBSCRIPTION
    process.env.TEST_PERIOD_DAYS = '7'
    expect(getTestReadyDaysWithoutMainSubscription()).toBe(7)
  })
})
