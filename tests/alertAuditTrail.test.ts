import { describe, expect, it } from 'vitest'
import { createAlert } from '../src/services/alerting.js'

const resellerId = '0925eb82-53ef-4522-8d81-07ebaa17d819'
const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'
const alertId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

function createSupabase() {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = []
  return {
    inserts,
    updates,
    supabase: {
      async select(table: string) {
        if (table === 'alerts') return [{ alert_id: alertId }]
        return []
      },
      async update(table: string, _queryString: string, patch: Record<string, unknown>) {
        updates.push({ table, patch })
        return []
      },
      async insert(table: string, row: Record<string, unknown>) {
        inserts.push({ table, row })
        return []
      },
    },
  }
}

describe('alert audit trail', () => {
  it('records internal event and audit log when an alert is merged', async () => {
    const { supabase, inserts, updates } = createSupabase()

    const result = await createAlert({
      supabase: supabase as any,
      alertType: 'POOL_USAGE_HIGH',
      severity: 'P2',
      resellerId,
      customerId: enterpriseId,
      threshold: 80,
      currentValue: 91,
      windowStart: '2026-06-18T00:00:00.000Z',
      deliveryChannels: ['PORTAL'],
    })

    expect(result).toEqual({ ok: true, value: { created: false, alertId } })
    expect(updates).toHaveLength(1)
    expect(inserts.map((entry) => entry.table)).toEqual(['events', 'audit_logs'])
    expect(inserts[0].row.event_type).toBe('ALERT_MERGED')
    expect(inserts[0].row.reseller_id).toBe(resellerId)
    expect(inserts[0].row.enterprise_id).toBe(enterpriseId)
    expect(inserts[1].row.action).toBe('ALERT_MERGE')
    expect(inserts[1].row.target_id).toBe(alertId)
  })
})
