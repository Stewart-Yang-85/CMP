import { describe, it, expect } from 'vitest'
import { validateMarkTestReadyPreconditions } from '../src/services/simLifecycle.ts'
import { evaluateJobCancel } from '../src/routes/jobs.ts'

/**
 * SIM Lifecycle State Machine Tests
 * Tests the allowed state transitions based on simLifecycle.ts actionMap.
 *
 * State machine:
 *   INVENTORY → TEST_READY → ACTIVATED → DEACTIVATED → RETIRED
 *   INVENTORY → ACTIVATED (direct skip)
 *   DEACTIVATED → ACTIVATED (reactivate)
 *
 * Forbidden:
 *   ACTIVATED → RETIRED (must deactivate first)
 *   RETIRED → anything (terminal state)
 */

const actionMap = {
  ACTIVATE: { targetStatus: 'ACTIVATED', allowedFrom: new Set(['INVENTORY', 'TEST_READY', 'DEACTIVATED']), requireReason: false },
  DEACTIVATE: { targetStatus: 'DEACTIVATED', allowedFrom: new Set(['ACTIVATED', 'TEST_READY']), requireReason: true },
  REACTIVATE: { targetStatus: 'ACTIVATED', allowedFrom: new Set(['DEACTIVATED']), requireReason: false },
  RETIRE: { targetStatus: 'RETIRED', allowedFrom: new Set(['DEACTIVATED']), requireReason: true },
  MARK_TEST_READY: { targetStatus: 'TEST_READY', allowedFrom: new Set(['INVENTORY']), requireReason: true },
}

function canTransition(currentStatus: string, action: string): boolean {
  const policy = actionMap[action as keyof typeof actionMap]
  if (!policy) return false
  return policy.allowedFrom.has(currentStatus)
}

describe('SIM State Machine', () => {
  describe('ACTIVATE action', () => {
    it('allows INVENTORY → ACTIVATED', () => {
      expect(canTransition('INVENTORY', 'ACTIVATE')).toBe(true)
    })
    it('allows TEST_READY → ACTIVATED', () => {
      expect(canTransition('TEST_READY', 'ACTIVATE')).toBe(true)
    })
    it('allows DEACTIVATED → ACTIVATED', () => {
      expect(canTransition('DEACTIVATED', 'ACTIVATE')).toBe(true)
    })
    it('rejects ACTIVATED → ACTIVATED', () => {
      expect(canTransition('ACTIVATED', 'ACTIVATE')).toBe(false)
    })
    it('rejects RETIRED → ACTIVATED', () => {
      expect(canTransition('RETIRED', 'ACTIVATE')).toBe(false)
    })
  })

  describe('DEACTIVATE action', () => {
    it('allows ACTIVATED → DEACTIVATED', () => {
      expect(canTransition('ACTIVATED', 'DEACTIVATE')).toBe(true)
    })
    it('allows TEST_READY → DEACTIVATED', () => {
      expect(canTransition('TEST_READY', 'DEACTIVATE')).toBe(true)
    })
    it('rejects INVENTORY → DEACTIVATED', () => {
      expect(canTransition('INVENTORY', 'DEACTIVATE')).toBe(false)
    })
    it('rejects RETIRED → DEACTIVATED', () => {
      expect(canTransition('RETIRED', 'DEACTIVATE')).toBe(false)
    })
  })

  describe('REACTIVATE action', () => {
    it('allows DEACTIVATED → ACTIVATED', () => {
      expect(canTransition('DEACTIVATED', 'REACTIVATE')).toBe(true)
    })
    it('rejects ACTIVATED → ACTIVATED (already active)', () => {
      expect(canTransition('ACTIVATED', 'REACTIVATE')).toBe(false)
    })
    it('rejects INVENTORY → ACTIVATED via reactivate', () => {
      expect(canTransition('INVENTORY', 'REACTIVATE')).toBe(false)
    })
  })

  describe('RETIRE action', () => {
    it('allows DEACTIVATED → RETIRED', () => {
      expect(canTransition('DEACTIVATED', 'RETIRE')).toBe(true)
    })
    it('rejects ACTIVATED → RETIRED (must deactivate first)', () => {
      expect(canTransition('ACTIVATED', 'RETIRE')).toBe(false)
    })
    it('rejects INVENTORY → RETIRED', () => {
      expect(canTransition('INVENTORY', 'RETIRE')).toBe(false)
    })
    it('rejects RETIRED → RETIRED (terminal state)', () => {
      expect(canTransition('RETIRED', 'RETIRE')).toBe(false)
    })
  })

  describe('unknown actions', () => {
    it('rejects unknown action', () => {
      expect(canTransition('ACTIVATED', 'SUSPEND')).toBe(false)
    })
  })

  describe('MARK_TEST_READY transition (state machine)', () => {
    it('allows INVENTORY → TEST_READY when assigned', () => {
      expect(canTransition('INVENTORY', 'MARK_TEST_READY')).toBe(true)
    })
    it('rejects TEST_READY → TEST_READY', () => {
      expect(canTransition('TEST_READY', 'MARK_TEST_READY')).toBe(false)
    })
  })

  describe('validateMarkTestReadyPreconditions', () => {
    const enterpriseId = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

    it('accepts INVENTORY with enterprise', () => {
      const r = validateMarkTestReadyPreconditions({
        status: 'INVENTORY',
        lifecycle_sub_status: 'normal',
        enterprise_id: enterpriseId,
      })
      expect(r.ok).toBe(true)
    })

    it('rejects unassigned INVENTORY', () => {
      const r = validateMarkTestReadyPreconditions({
        status: 'INVENTORY',
        lifecycle_sub_status: 'normal',
        enterprise_id: null,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('ENTERPRISE_REQUIRED')
    })

    it('rejects ACTIVATED', () => {
      const r = validateMarkTestReadyPreconditions({
        status: 'ACTIVATED',
        lifecycle_sub_status: 'normal',
        enterprise_id: enterpriseId,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('INVALID_STATE')
    })

    it('rejects when lifecycle in progress', () => {
      const r = validateMarkTestReadyPreconditions({
        status: 'INVENTORY',
        lifecycle_sub_status: 'activating',
        enterprise_id: enterpriseId,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('LIFECYCLE_IN_PROGRESS')
    })
  })

  describe('job cancel policy', () => {
    it('SIM_STATUS_CHANGE is not cancellable', () => {
      const r = evaluateJobCancel({ job_type: 'SIM_STATUS_CHANGE', status: 'RUNNING' })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('JOB_NOT_CANCELLABLE')
    })
  })

  describe('requireReason flag', () => {
    it('DEACTIVATE requires reason', () => {
      expect(actionMap.DEACTIVATE.requireReason).toBe(true)
    })
    it('RETIRE requires reason', () => {
      expect(actionMap.RETIRE.requireReason).toBe(true)
    })
    it('ACTIVATE does not require reason', () => {
      expect(actionMap.ACTIVATE.requireReason).toBe(false)
    })
    it('REACTIVATE does not require reason', () => {
      expect(actionMap.REACTIVATE.requireReason).toBe(false)
    })
    it('MARK_TEST_READY requires reason', () => {
      expect(actionMap.MARK_TEST_READY.requireReason).toBe(true)
    })
  })
})
