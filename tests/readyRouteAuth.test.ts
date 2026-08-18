import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../dist/app.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
const base = 'https://ready-auth.supabase.test'

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  })
}

function installReadySupabaseMock() {
  globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!raw.startsWith(base)) return originalFetch(input as any, init)
    const url = new URL(raw)
    const table = url.pathname.match(/\/rest\/v1\/([^/?]+)/)?.[1] ?? ''
    if (table === 'sims') {
      return jsonResponse(200, [{ sim_id: 'sim-1' }], { 'content-range': '0-0/1' })
    }
    if (table === 'upstream_integrations') {
      return jsonResponse(200, [], { 'content-range': '0--1/0' })
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

describe('GET /ready auth', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k]
      else process.env[k] = originalEnv[k]
    })
  })

  it('returns 401 without credentials', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    installReadySupabaseMock()
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/ready`)
      expect(res.status).toBe(401)
    })
  })

  it('allows platform admin via ADMIN_API_KEY', async () => {
    process.env.SUPABASE_URL = base
    process.env.SUPABASE_ANON_KEY = 'anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    process.env.ADMIN_API_KEY = 'admin-key'
    installReadySupabaseMock()
    await withServer(async (baseUrl) => {
      const res = await originalFetch(`${baseUrl}/ready`, {
        headers: { 'x-api-key': 'admin-key' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toHaveProperty('ok')
      expect(body).toHaveProperty('details')
    })
  })
})
