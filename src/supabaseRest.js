function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing env var ${name}`)
  }
  return value
}

function parseContentRangeTotal(contentRange) {
  if (!contentRange) return null
  const m = String(contentRange).match(/\/(\d+|\*)$/)
  if (!m) return null
  if (m[1] === '*') return null
  return Number(m[1])
}

function isMissingColumnError(body) {
  const text = String(body ?? '')
  return (
    (text.includes('does not exist') && text.includes('column')) ||
    text.includes('Could not find the') ||
    text.includes('PGRST204')
  )
}

export function createSupabaseRestClient({ useServiceRole = false, traceId = null } = {}) {
  const baseUrl = requireEnv('SUPABASE_URL').replace(/\/+$/, '')
  const anonKey = requireEnv('SUPABASE_ANON_KEY')
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (useServiceRole && !serviceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY (required for write operations).')
  }

  const key = useServiceRole ? serviceRoleKey : anonKey
  const timeoutMs = Number(process.env.SUPABASE_TIMEOUT_MS) > 0 ? Number(process.env.SUPABASE_TIMEOUT_MS) : 8000
  const retryMax = Number(process.env.SUPABASE_RETRY_MAX) > 0 ? Number(process.env.SUPABASE_RETRY_MAX) : 2
  const retryBackoffMs = Number(process.env.SUPABASE_RETRY_BACKOFF_MS) > 0 ? Number(process.env.SUPABASE_RETRY_BACKOFF_MS) : 200
  const cbFailThreshold = Number(process.env.SUPABASE_CB_FAILURE_THRESHOLD) > 0 ? Number(process.env.SUPABASE_CB_FAILURE_THRESHOLD) : 3
  const cbCooldownMs = Number(process.env.SUPABASE_CB_COOLDOWN_MS) > 0 ? Number(process.env.SUPABASE_CB_COOLDOWN_MS) : 15000

  const circuit = { failures: 0, openedUntil: 0 }
  function makeUpstreamError(type, status, body, extra = {}) {
    const err = new Error(type)
    err.name = 'UpstreamError'
    err.upstreamType = type
    err.status = status
    err.body = body
    if (extra && extra.retryAfter !== undefined && extra.retryAfter !== null) {
      err.retryAfter = extra.retryAfter
    }
    return err
  }

  async function request(method, url, { headers = {}, body } = {}) {
    const now = Date.now()
    if (circuit.openedUntil > now) {
      throw makeUpstreamError('UPSTREAM_CIRCUIT_OPEN', 503, null)
    }
    let attempt = 0
    let lastErr = null
    while (attempt <= retryMax) {
      attempt += 1
      const ac = new AbortController()
      const tid = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            ...headers,
            ...(traceId ? { 'X-Request-Id': String(traceId) } : {}),
          },
          body,
          signal: ac.signal,
        })
        clearTimeout(tid)
        const text = await res.text()
        if (res.status >= 500 || res.status === 429) {
          circuit.failures += 1
          if (circuit.failures >= cbFailThreshold) {
            circuit.openedUntil = Date.now() + cbCooldownMs
          }
          if (attempt <= retryMax) {
            await new Promise((r) => setTimeout(r, retryBackoffMs))
            continue
          }
          if (res.status === 429) {
            const ra = res.headers.get('retry-after')
            throw makeUpstreamError('UPSTREAM_RATE_LIMITED', 429, text, { retryAfter: ra })
          }
          throw makeUpstreamError('UPSTREAM_SERVER_ERROR', res.status, text)
        } else {
          circuit.failures = 0
        }
        return { res, text }
      } catch (err) {
        clearTimeout(tid)
        lastErr = err
        circuit.failures += 1
        if (circuit.failures >= cbFailThreshold) {
          circuit.openedUntil = Date.now() + cbCooldownMs
        }
        if (attempt <= retryMax) {
          await new Promise((r) => setTimeout(r, retryBackoffMs))
          continue
        }
        if (err?.name === 'AbortError') throw makeUpstreamError('UPSTREAM_TIMEOUT', 504, null)
        throw makeUpstreamError('UPSTREAM_NETWORK_ERROR', 503, String(err?.message || 'network_error'))
      }
    }
    throw lastErr ?? new Error('Supabase request failed')
  }

  return {
    async select(table, queryString, { headers = {}, suppressMissingColumns = false } = {}) {
      const url = `${baseUrl}/rest/v1/${table}?${queryString}`
      const { res, text } = await request('GET', url, { headers })

      if (!res.ok) {
        if (!(suppressMissingColumns && isMissingColumnError(text))) {
          console.error(`Supabase upstream error: ${res.status} ${url} ${text}`)
        }
        throw makeUpstreamError('UPSTREAM_BAD_RESPONSE', res.status, text)
      }

      if (!text) return null
      return JSON.parse(text)
    },
    async selectWithCount(table, queryString) {
      const url = `${baseUrl}/rest/v1/${table}?${queryString}`
      const { res, text } = await request('GET', url, {
        headers: { Prefer: 'count=exact' },
      })

      if (!res.ok) {
        console.error(`Supabase upstream error: ${res.status} ${url} ${text}`)
        throw makeUpstreamError('UPSTREAM_BAD_RESPONSE', res.status, text)
      }

      const total = parseContentRangeTotal(res.headers.get('content-range'))
      const data = text ? JSON.parse(text) : null
      return { data, total }
    },
    async insert(table, rows, { returning = 'representation', suppressMissingColumns = false } = {}) {
      const url = `${baseUrl}/rest/v1/${table}`
      const payload = Array.isArray(rows) ? rows : [rows]
      const { res, text } = await request('POST', url, {
        headers: {
          Prefer: `return=${returning}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        if (!(suppressMissingColumns && isMissingColumnError(text))) {
          console.error(`Supabase upstream error: ${res.status} ${url} ${text}`)
        }
        throw makeUpstreamError('UPSTREAM_BAD_RESPONSE', res.status, text)
      }

      if (!text) return null
      return JSON.parse(text)
    },
    async update(table, matchQueryString, patch, { returning = 'representation', suppressMissingColumns = false } = {}) {
      const url = `${baseUrl}/rest/v1/${table}?${matchQueryString}`
      const { res, text } = await request('PATCH', url, {
        headers: {
          Prefer: `return=${returning}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch ?? {}),
      })

      if (!res.ok) {
        if (!(suppressMissingColumns && isMissingColumnError(text))) {
          console.error(`Supabase upstream error: ${res.status} ${url} ${text}`)
        }
        throw makeUpstreamError('UPSTREAM_BAD_RESPONSE', res.status, text)
      }

      if (!text) return null
      return JSON.parse(text)
    },
    async delete(table, matchQueryString) {
      const url = `${baseUrl}/rest/v1/${table}?${matchQueryString}`
      const { res, text } = await request('DELETE', url, {
        headers: { Prefer: 'return=minimal' },
      })
      if (!res.ok) {
        throw makeUpstreamError('UPSTREAM_BAD_RESPONSE', res.status, text)
      }
      return null
    },
    async rpc(functionName, args) {
      const url = `${baseUrl}/rest/v1/rpc/${functionName}`
      const { res, text } = await request('POST', url, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args ?? {}),
      })

      if (!res.ok) {
        throw makeUpstreamError('UPSTREAM_BAD_RESPONSE', res.status, text)
      }

      if (!text) return null
      return JSON.parse(text)
    }
  }
}
