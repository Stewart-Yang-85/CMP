import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../dist/app.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const base = 'https://admin-audits.supabase.test'

const resellerId = '11111111-1111-1111-1111-111111111111'
const enterpriseId = '22222222-2222-2222-2222-222222222222'
const otherEnterpriseId = '33333333-3333-3333-3333-333333333333'
const otherResellerId = '44444444-4444-4444-4444-444444444444'

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  })
}

function eqParam(sp: URLSearchParams, key: string) {
  const v = sp.get(key)
  if (!v?.startsWith('eq.')) return null
  return decodeURIComponent(v.slice(3))
}

function inParam(sp: URLSearchParams, key: string) {
  const v = sp.get(key)
  if (!v?.startsWith('in.(') || !v.endsWith(')')) return null
  return v
    .slice(4, -1)
    .split(',')
    .map((s) => decodeURIComponent(s.trim()))
    .filter(Boolean)
}

function installSupabaseMock(state: { tenants: any[]; auditLogs: any[]; lastAuditQuery?: string }) {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!raw.startsWith(base)) return originalFetch(input as any, init)
    const url = new URL(raw)
    const method = String(init?.method || 'GET').toUpperCase()
    const table = url.pathname.match(/\/rest\/v1\/([^/?]+)/)?.[1] ?? ''
    const sp = url.searchParams

    if (table === 'tenants' && method === 'GET') {
      const tenantId = eqParam(sp, 'tenant_id')
      const tenantType = eqParam(sp, 'tenant_type')
      const parentId = eqParam(sp, 'parent_id')
      let rows = state.tenants.slice()
      if (tenantId) rows = rows.filter((r) => String(r.tenant_id) === tenantId)
      if (tenantType) rows = rows.filter((r) => String(r.tenant_type) === tenantType)
      if (parentId) rows = rows.filter((r) => String(r.parent_id) === parentId)
      return jsonResponse(200, rows, { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` })
    }

    if (table === 'audit_logs' && method === 'GET') {
      state.lastAuditQuery = url.search
      const tenantEq = eqParam(sp, 'tenant_id')
      const tenantIn = inParam(sp, 'tenant_id')
      let rows = state.auditLogs.slice()
      if (tenantEq) rows = rows.filter((r) => String(r.tenant_id) === tenantEq)
      if (tenantIn) rows = rows.filter((r) => tenantIn.includes(String(r.tenant_id)))
      return jsonResponse(200, rows, {
        'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}`,
      })
    }

    return jsonResponse(200, [])
  }
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = createApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await app.close()
  }
}

describe('GET /admin/audits tenant scope (resellerId/enterpriseId)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  function setupEnv() {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.ADMIN_API_KEY = 'cmp-admin-key'
    process.env.AUTH_TOKEN_SECRET = 'test-secret'
  }

  const tenants = [
    { tenant_id: resellerId, tenant_type: 'RESELLER', parent_id: null },
    { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId },
    { tenant_id: otherEnterpriseId, tenant_type: 'ENTERPRISE', parent_id: otherResellerId },
    { tenant_id: otherResellerId, tenant_type: 'RESELLER', parent_id: null },
  ]

  const auditLogs = [
    {
      audit_id: 1,
      actor_user_id: null,
      actor_role: 'ADMIN',
      tenant_id: resellerId,
      action: 'RESELLER_ACTION',
      target_type: 'API_CLIENT',
      target_id: 'c1',
      request_id: 'r1',
      created_at: '2026-08-01T00:00:00.000Z',
      before_data: null,
      after_data: null,
    },
    {
      audit_id: 2,
      actor_user_id: null,
      actor_role: 'ADMIN',
      tenant_id: enterpriseId,
      action: 'ENTERPRISE_ACTION',
      target_type: 'API_CLIENT',
      target_id: 'c2',
      request_id: 'r2',
      created_at: '2026-08-01T01:00:00.000Z',
      before_data: null,
      after_data: null,
    },
    {
      audit_id: 3,
      actor_user_id: null,
      actor_role: 'ADMIN',
      tenant_id: otherEnterpriseId,
      action: 'OTHER_ACTION',
      target_type: 'API_CLIENT',
      target_id: 'c3',
      request_id: 'r3',
      created_at: '2026-08-01T02:00:00.000Z',
      before_data: null,
      after_data: null,
    },
  ]

  it('rejects invalid enterpriseId uuid', async () => {
    setupEnv()
    const state = { tenants, auditLogs, lastAuditQuery: '' }
    installSupabaseMock(state)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/audits?enterpriseId=not-a-uuid`, {
        headers: { 'X-API-Key': 'cmp-admin-key' },
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('VALIDATION_ERROR')
      expect(String(body.message)).toMatch(/enterpriseId/)
    })
  })

  it('returns 404 when enterprise does not exist', async () => {
    setupEnv()
    const state = { tenants, auditLogs, lastAuditQuery: '' }
    installSupabaseMock(state)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(
        `${baseUrl}/v1/admin/audits?enterpriseId=99999999-9999-9999-9999-999999999999`,
        { headers: { 'X-API-Key': 'cmp-admin-key' } }
      )
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.code).toBe('RESOURCE_NOT_FOUND')
    })
  })

  it('filters by enterpriseId only', async () => {
    setupEnv()
    const state = { tenants, auditLogs, lastAuditQuery: '' }
    installSupabaseMock(state)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/audits?enterpriseId=${enterpriseId}`, {
        headers: { 'X-API-Key': 'cmp-admin-key' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items).toHaveLength(1)
      expect(body.items[0].tenantId).toBe(enterpriseId)
      expect(state.lastAuditQuery).toContain(`tenant_id=eq.${encodeURIComponent(enterpriseId)}`)
    })
  })

  it('filters by resellerId as reseller + child enterprises', async () => {
    setupEnv()
    const state = { tenants, auditLogs, lastAuditQuery: '' }
    installSupabaseMock(state)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/audits?resellerId=${resellerId}`, {
        headers: { 'X-API-Key': 'cmp-admin-key' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      const ids = body.items.map((i: any) => i.tenantId).sort()
      expect(ids).toEqual([enterpriseId, resellerId].sort())
      expect(state.lastAuditQuery).toMatch(/tenant_id=in\./)
      expect(state.lastAuditQuery).toContain(encodeURIComponent(resellerId))
      expect(state.lastAuditQuery).toContain(encodeURIComponent(enterpriseId))
    })
  })

  it('rejects enterpriseId that does not belong to resellerId', async () => {
    setupEnv()
    const state = { tenants, auditLogs, lastAuditQuery: '' }
    installSupabaseMock(state)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(
        `${baseUrl}/v1/admin/audits?resellerId=${resellerId}&enterpriseId=${otherEnterpriseId}`,
        { headers: { 'X-API-Key': 'cmp-admin-key' } }
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('VALIDATION_ERROR')
      expect(String(body.message)).toMatch(/does not belong/)
    })
  })

  it('CSV uses the same resellerId filter', async () => {
    setupEnv()
    const state = { tenants, auditLogs, lastAuditQuery: '' }
    installSupabaseMock(state)
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/v1/admin/audits:csv?resellerId=${resellerId}&pageSize=10`, {
        headers: { 'X-API-Key': 'cmp-admin-key' },
      })
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('auditId,actorUserId,actorRole,tenantId')
      expect(text).toContain(resellerId)
      expect(text).toContain(enterpriseId)
      expect(text).not.toContain(otherEnterpriseId)
    })
  })
})
