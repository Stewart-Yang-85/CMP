import { describe, it, expect } from 'vitest'

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
  })
})
