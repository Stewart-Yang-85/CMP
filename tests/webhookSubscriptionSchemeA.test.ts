import { describe, expect, it } from 'vitest'
import {
  createWebhookSubscription,
  updateWebhookSubscription,
} from '../src/services/webhook.ts'

function makeStore(seed: Array<Record<string, any>> = []) {
  const rows = seed.map((r) => ({ ...r }))
  const supabase = {
    async select(table: string, qs: string) {
      if (table !== 'webhook_subscriptions') return []
      let list = [...rows]
      const params = new URLSearchParams(qs.replace(/^select=[^&]*&?/, '').replace(/^select=[^&]*$/, ''))
      // crude filter from PostgREST-style query string
      const parts = qs.split('&')
      for (const part of parts) {
        if (part.startsWith('select=')) continue
        if (part.startsWith('limit=')) continue
        if (part.startsWith('enterprise_id=eq.')) {
          const v = decodeURIComponent(part.slice('enterprise_id=eq.'.length))
          list = list.filter((r) => String(r.enterprise_id) === v)
        } else if (part.startsWith('reseller_id=eq.')) {
          const v = decodeURIComponent(part.slice('reseller_id=eq.'.length))
          list = list.filter((r) => String(r.reseller_id) === v)
        } else if (part === 'enterprise_id=is.null') {
          list = list.filter((r) => r.enterprise_id == null)
        } else if (part.startsWith('webhook_id=eq.')) {
          const v = decodeURIComponent(part.slice('webhook_id=eq.'.length))
          list = list.filter((r) => String(r.webhook_id) === v)
        } else if (part.startsWith('webhook_id=neq.')) {
          const v = decodeURIComponent(part.slice('webhook_id=neq.'.length))
          list = list.filter((r) => String(r.webhook_id) !== v)
        } else if (part.startsWith('event_types=eq.')) {
          const raw = decodeURIComponent(part.slice('event_types=eq.'.length))
          // `{TYPE}` → TYPE
          const type = raw.replace(/^\{/, '').replace(/\}$/, '')
          list = list.filter((r) => Array.isArray(r.event_types) && r.event_types[0] === type)
        } else if (part.startsWith('status=in.')) {
          const raw = part.slice('status=in.'.length)
          const statuses = raw
            .replace(/^\(/, '')
            .replace(/\)$/, '')
            .split(',')
            .map((s) => decodeURIComponent(s))
          list = list.filter((r) => statuses.includes(String(r.status || '').toUpperCase()))
        }
      }
      return list
    },
    async insert(table: string, row: any) {
      if (table !== 'webhook_subscriptions') return []
      const created = {
        webhook_id: `wh-${rows.length + 1}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deprecated_at: null,
        ...row,
      }
      rows.push(created)
      return [created]
    },
    async update(table: string, matchQs: string, patch: any) {
      if (table !== 'webhook_subscriptions') return []
      const id = decodeURIComponent(matchQs.replace('webhook_id=eq.', ''))
      const idx = rows.findIndex((r) => String(r.webhook_id) === id)
      if (idx < 0) return []
      rows[idx] = { ...rows[idx], ...patch }
      return [rows[idx]]
    },
  }
  return { supabase, rows }
}

describe('webhook subscription Scheme A (one event type per URL)', () => {
  it('creates with singular eventType and returns eventType + eventTypes', async () => {
    const { supabase } = makeStore()
    const result = await createWebhookSubscription({
      supabase: supabase as any,
      resellerId: 'r1',
      enterpriseId: 'e1',
      payload: {
        url: 'https://hooks.example.com/sim',
        secret: 's3cret',
        eventType: 'SIM_STATUS_CHANGED',
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.eventType).toBe('SIM_STATUS_CHANGED')
    expect(result.value.eventTypes).toEqual(['SIM_STATUS_CHANGED'])
  })

  it('rejects multi-element eventTypes', async () => {
    const { supabase } = makeStore()
    const result = await createWebhookSubscription({
      supabase: supabase as any,
      resellerId: 'r1',
      enterpriseId: 'e1',
      payload: {
        url: 'https://hooks.example.com/multi',
        secret: 's3cret',
        eventTypes: ['SIM_STATUS_CHANGED', 'BILL_PUBLISHED'],
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.message).toMatch(/exactly one event type/i)
  })

  it('allows two live subscriptions for different event types on same enterprise', async () => {
    const { supabase } = makeStore()
    const a = await createWebhookSubscription({
      supabase: supabase as any,
      resellerId: 'r1',
      enterpriseId: 'e1',
      payload: {
        url: 'https://hooks.example.com/sim',
        secret: 's1',
        eventType: 'SIM_STATUS_CHANGED',
      },
    })
    const b = await createWebhookSubscription({
      supabase: supabase as any,
      resellerId: 'r1',
      enterpriseId: 'e1',
      payload: {
        url: 'https://hooks.example.com/bill',
        secret: 's2',
        eventType: 'BILL_PUBLISHED',
      },
    })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
  })

  it('returns 409 when same enterprise + eventType already live', async () => {
    const { supabase } = makeStore([
      {
        webhook_id: 'wh-existing',
        reseller_id: 'r1',
        enterprise_id: 'e1',
        url: 'https://hooks.example.com/old',
        secret: 'old',
        event_types: ['SIM_STATUS_CHANGED'],
        enabled: true,
        status: 'ACTIVE',
      },
    ])
    const result = await createWebhookSubscription({
      supabase: supabase as any,
      resellerId: 'r1',
      enterpriseId: 'e1',
      payload: {
        url: 'https://hooks.example.com/new',
        secret: 'new',
        eventType: 'SIM_STATUS_CHANGED',
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.code).toBe('DUPLICATE')
  })

  it('rejects PATCH that would collide on eventType', async () => {
    const { supabase } = makeStore([
      {
        webhook_id: 'wh-a',
        reseller_id: 'r1',
        enterprise_id: 'e1',
        url: 'https://hooks.example.com/a',
        secret: 'a',
        event_types: ['SIM_STATUS_CHANGED'],
        enabled: true,
        status: 'ACTIVE',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        webhook_id: 'wh-b',
        reseller_id: 'r1',
        enterprise_id: 'e1',
        url: 'https://hooks.example.com/b',
        secret: 'b',
        event_types: ['BILL_PUBLISHED'],
        enabled: true,
        status: 'ACTIVE',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ])
    const result = await updateWebhookSubscription({
      supabase: supabase as any,
      webhookId: 'wh-b',
      payload: { eventType: 'SIM_STATUS_CHANGED' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.code).toBe('DUPLICATE')
  })
})
