import { describe, it, expect } from 'vitest'
import { evaluateJobCancel } from '../src/routes/jobs.ts'

describe('evaluateJobCancel', () => {
  it('rejects SIM_STATUS_CHANGE', () => {
    const r = evaluateJobCancel({ job_type: 'SIM_STATUS_CHANGE', status: 'QUEUED' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('JOB_NOT_CANCELLABLE')
      expect(r.status).toBe(409)
    }
  })

  it('rejects SIM_STATUS_CHANGE when RUNNING', () => {
    const r = evaluateJobCancel({ job_type: 'SIM_STATUS_CHANGE', status: 'RUNNING' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('JOB_NOT_CANCELLABLE')
  })

  it('allows SIM_IMPORT when QUEUED', () => {
    expect(evaluateJobCancel({ job_type: 'SIM_IMPORT', status: 'QUEUED' }).ok).toBe(true)
  })

  it('rejects cancelled job', () => {
    const r = evaluateJobCancel({ job_type: 'BILLING_GENERATE', status: 'SUCCEEDED' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('INVALID_STATE')
  })
})
