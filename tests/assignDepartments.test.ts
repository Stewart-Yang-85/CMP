import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'

const enterpriseId = '8f49253c-fce4-44de-9a2a-e62550b856a2'
const userId = '3c38fd34-37b0-4c6d-989f-7342e42de7f5'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = createApp()
  const appAny = app as any
  const server = await new Promise<any>((resolve, reject) => {
    const s = appAny.listen(0, () => resolve(s))
    s.on('error', reject)
  })
  try {
    const port = server.address().port
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err: any) => (err ? reject(err) : resolve())))
  }
}

afterEach(() => {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('assign departments route', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  it('returns SCHEMA_NOT_READY when enterprise_user_departments table is missing', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!raw.startsWith('https://example.supabase.co/')) {
        return originalFetch(input as any, init)
      }
      const url = new URL(raw)
      const method = String(init?.method || 'GET').toUpperCase()
      const query = url.search
      if (method === 'GET' && url.pathname.endsWith('/rest/v1/tenants') && query.includes('tenant_type=eq.ENTERPRISE')) {
        return jsonResponse(200, [{ tenant_id: enterpriseId, parent_id: 'reseller-id' }])
      }
      if (method === 'GET' && url.pathname.endsWith('/rest/v1/users')) {
        return jsonResponse(200, [{ user_id: userId, tenant_id: enterpriseId }])
      }
      if (method === 'GET' && url.pathname.endsWith('/rest/v1/enterprise_user_departments')) {
        return jsonResponse(404, {
          code: 'PGRST205',
          details: null,
          hint: "Perhaps you meant the table 'public.reseller_enterprise_assignments'",
          message: "Could not find the table 'public.enterprise_user_departments' in the schema cache",
        })
      }
      return jsonResponse(200, [])
    }

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/enterprises/${enterpriseId}/users/${userId}/assign-departments`, {
        method: 'POST',
        headers: {
          'x-api-key': 'test-admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          assignedDepartmentIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
        }),
      })
      const body = await response.json()

      expect(response.status).toBe(503)
      expect(body).toMatchObject({
        code: 'SCHEMA_NOT_READY',
        message: 'enterprise_user_departments table is missing. Apply migration 0040_add_enterprise_user_departments.sql.',
      })
      expect(typeof body.traceId).toBe('string')
    })
  })

  it('assigns enterprise user departments successfully when schema is ready', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    const departmentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const insertedAssignments: Array<Record<string, string>> = []
    let deletedCalled = false

    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!raw.startsWith('https://example.supabase.co/')) {
        return originalFetch(input as any, init)
      }
      const url = new URL(raw)
      const method = String(init?.method || 'GET').toUpperCase()
      const query = url.search

      if (method === 'GET' && url.pathname.endsWith('/rest/v1/tenants') && query.includes('tenant_type=eq.ENTERPRISE')) {
        return jsonResponse(200, [{ tenant_id: enterpriseId, parent_id: 'reseller-id' }])
      }
      if (method === 'GET' && url.pathname.endsWith('/rest/v1/users')) {
        return jsonResponse(200, [{ user_id: userId, tenant_id: enterpriseId }])
      }
      if (method === 'GET' && url.pathname.endsWith('/rest/v1/enterprise_user_departments')) {
        return jsonResponse(200, [{ department_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }])
      }
      if (method === 'GET' && url.pathname.endsWith('/rest/v1/tenants') && query.includes('tenant_type=eq.DEPARTMENT')) {
        return jsonResponse(200, [{ tenant_id: departmentId, parent_id: enterpriseId }])
      }
      if (method === 'DELETE' && url.pathname.endsWith('/rest/v1/enterprise_user_departments')) {
        deletedCalled = true
        return jsonResponse(200, [])
      }
      if (method === 'POST' && url.pathname.endsWith('/rest/v1/enterprise_user_departments')) {
        const payload = JSON.parse(String(init?.body || '[]'))
        const rows = Array.isArray(payload) ? payload : [payload]
        insertedAssignments.push(...rows)
        return jsonResponse(201, rows)
      }
      if (method === 'POST' && url.pathname.endsWith('/rest/v1/audit_logs')) {
        return jsonResponse(201, [])
      }
      return jsonResponse(200, [])
    }

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/enterprises/${enterpriseId}/users/${userId}/assign-departments`, {
        method: 'POST',
        headers: {
          'x-api-key': 'test-admin-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          assignedDepartmentIds: [departmentId],
        }),
      })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        userId,
        enterpriseId,
        assignedDepartmentIds: [departmentId],
      })
      expect(deletedCalled).toBe(true)
      expect(insertedAssignments).toEqual([
        {
          user_id: userId,
          enterprise_id: enterpriseId,
          department_id: departmentId,
        },
      ])
    })
  })

  it('lists enterprise users by enterprise id', async () => {
    process.env.ADMIN_API_KEY = 'test-admin-key'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    const listUserId = '9d4f43ec-8490-4772-ad08-7115dd553f5a'

    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!raw.startsWith('https://example.supabase.co/')) {
        return originalFetch(input as any, init)
      }
      const url = new URL(raw)
      const method = String(init?.method || 'GET').toUpperCase()
      const query = url.search

      if (method === 'GET' && url.pathname.endsWith('/rest/v1/tenants') && query.includes('tenant_type=eq.ENTERPRISE')) {
        return jsonResponse(200, [{ tenant_id: enterpriseId, parent_id: 'reseller-id' }])
      }
      if (method === 'GET' && url.pathname.endsWith('/rest/v1/users') && query.includes(`tenant_id=eq.${enterpriseId}`)) {
        return new Response(
          JSON.stringify([
            {
              user_id: listUserId,
              email: 'ops@example.com',
              display_name: 'Ops User',
              status: 'ACTIVE',
              created_at: '2026-02-01T00:00:00.000Z',
            },
          ]),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'content-range': '0-0/1',
            },
          }
        )
      }
      if (method === 'GET' && url.pathname.endsWith('/rest/v1/user_roles')) {
        return jsonResponse(200, [{ user_id: listUserId, role_name: 'customer_ops' }])
      }
      return jsonResponse(200, [])
    }

    await withServer(async (baseUrl) => {
      const response = await originalFetch(`${baseUrl}/v1/enterprises/${enterpriseId}/users?page=1&pageSize=20`, {
        method: 'GET',
        headers: {
          'x-api-key': 'test-admin-key',
        },
      })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        total: 1,
        page: 1,
        pageSize: 20,
      })
      expect(body.items).toEqual([
        {
          userId: listUserId,
          enterpriseId,
          email: 'ops@example.com',
          displayName: 'Ops User',
          role: 'customer_ops',
          status: 'ACTIVE',
          departmentId: null,
          createdAt: '2026-02-01T00:00:00.000Z',
        },
      ])
    })
  })
})
