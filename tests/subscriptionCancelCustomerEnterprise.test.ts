import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../dist/app.js'
import { signJwtHs256 } from '../src/jwt.js'

const AUTH_SECRET = 'test-auth-secret-cancel-enterprise'
const enterpriseId = '43326e05-5704-4e0d-8175-547d6b555132'
const wrongEnterpriseId = '43326e05-5704-4e0d-8175-547d6b555133'
const otherEnterpriseId = '99999999-9999-9999-9999-999999999999'
const subscriptionId = '33dee543-ae61-4e9c-9740-f30fa33130a4'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function customerToken() {
  const now = Math.floor(Date.now() / 1000)
  return signJwtHs256(
    {
      iss: 'iot-cmp-api',
      sub: '61417d8e-6af5-4687-8898-accbbb20f5e9',
      iat: now,
      exp: now + 3600,
      userId: '61417d8e-6af5-4687-8898-accbbb20f5e9',
      role: 'customer_admin',
      roleScope: 'customer',
      resellerId: '0925eb82-53ef-4522-8d81-07ebaa17d819',
      customerId: enterpriseId,
    },
    AUTH_SECRET
  )
}

function installSupabaseMock(tenantRows: Array<Record<string, unknown>>) {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = new URL(raw)
    const method = String(init?.method || 'GET').toUpperCase()

    if (url.pathname.endsWith('/rest/v1/tenants') && method === 'GET') {
      const idMatch = url.search.match(/tenant_id=eq\.([^&]+)/)
      const id = idMatch ? decodeURIComponent(idMatch[1]) : null
      const row = tenantRows.find((r) => String(r.tenant_id) === id)
      return jsonResponse(200, row ? [row] : [])
    }
    if (url.pathname.endsWith('/rest/v1/subscriptions') && method === 'GET') {
      return jsonResponse(200, [
        {
          subscription_id: subscriptionId,
          enterprise_id: enterpriseId,
          state: 'PENDING',
          subscription_kind: 'MAIN',
          expires_at: null,
        },
      ])
    }
    if (url.pathname.endsWith('/rest/v1/subscriptions') && method === 'PATCH') {
      return jsonResponse(200, [])
    }
    if (url.pathname.endsWith('/rest/v1/audit_logs') && method === 'POST') {
      return jsonResponse(201, [])
    }
    return jsonResponse(200, [])
  }
}

async function injectCancel(enterpriseIdQuery: string) {
  const app = createApp()
  await app.ready()
  const url = `/v1/subscriptions/${subscriptionId}:cancel?enterpriseId=${encodeURIComponent(enterpriseIdQuery)}`
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${customerToken()}`, accept: 'application/json' },
  })
  return { status: response.statusCode, body: response.json() as Record<string, unknown> }
}

describe('POST /subscriptions/:id:cancel customer enterpriseId', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  it('returns 404 when enterpriseId is not in tenants', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET

    installSupabaseMock([{ tenant_id: enterpriseId, tenant_type: 'ENTERPRISE' }])

    const { status, body } = await injectCancel(wrongEnterpriseId)
    expect(status).toBe(404)
    expect(body.code).toBe('RESOURCE_NOT_FOUND')
    expect(body.message).toBe('enterpriseId Not found.')
  })

  it('returns 403 when enterpriseId exists but does not match token', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key'
    process.env.SUPABASE_ANON_KEY = 'anon-key'
    process.env.AUTH_TOKEN_SECRET = AUTH_SECRET

    installSupabaseMock([
      { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE' },
      { tenant_id: otherEnterpriseId, tenant_type: 'ENTERPRISE' },
    ])

    const { status, body } = await injectCancel(otherEnterpriseId)
    expect(status).toBe(403)
    expect(body.code).toBe('FORBIDDEN')
    expect(body.message).toBe('enterpriseId must match your token scope.')
  })
})
