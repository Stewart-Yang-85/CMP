import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { processSimStatusChangeJob } from '../src/services/simStatusChangeJob.js'

function createFakeSupabase(initial: Record<string, unknown[]>) {
  const tables = { ...initial }
  const get = (name: string) => {
    if (!tables[name]) tables[name] = []
    return tables[name] as Record<string, unknown>[]
  }
  return {
    select: vi.fn(async (table: string) => get(table)),
    update: vi.fn(async (table: string, _q: string, patch: Record<string, unknown>) => {
      const rows = get(table)
      if (rows[0]) Object.assign(rows[0], patch)
      return [rows[0]]
    }),
    insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
      get(table).push(row)
      return [row]
    }),
    getTable: (name: string) => get(name),
  }
}

describe('processSimStatusChangeJob', () => {
  it('finalizes locally when no adapter (INVENTORY → ACTIVATED)', async () => {
    const simId = randomUUID()
    const supabase = createFakeSupabase({
      sims: [
        {
          sim_id: simId,
          iccid: '8986012345678901234',
          status: 'INVENTORY',
          lifecycle_sub_status: 'activating',
          enterprise_id: randomUUID(),
          supplier_id: null,
        },
      ],
    })
    const job = {
      job_id: randomUUID(),
      request_id: 'req-1',
      actor_user_id: null,
      payload: {
        simId,
        iccid: '8986012345678901234',
        action: 'SIM_ACTIVATE',
        afterStatus: 'ACTIVATED',
        targetStatus: 'ACTIVATED',
        beforeStatus: 'INVENTORY',
      },
    }
    const finalizeSimStatusChange = vi.fn(async ({ supabase: sb, sim, newStatus }) => {
      await sb.update('sims', '', { status: newStatus, lifecycle_sub_status: 'normal' })
    })
    const emitEvent = vi.fn(async () => {})
    const result = await processSimStatusChangeJob({
      supabase,
      job,
      adapter: null,
      emitEvent,
      finalizeSimStatusChange,
    })
    expect(result.ok).toBe(true)
    expect(result.succeeded).toBe(true)
    expect(finalizeSimStatusChange).toHaveBeenCalled()
    expect(supabase.getTable('sims')[0].status).toBe('ACTIVATED')
  })
})
