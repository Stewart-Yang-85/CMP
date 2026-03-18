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

function parseSupabaseError(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function extractForeignKeyField(details, message) {
  const detailText = String(details ?? '')
  const detailMatch = detailText.match(/Key \(([^)]+)\)=\(([^)]+)\) is not present/)
  if (detailMatch) {
    return { field: detailMatch[1], value: detailMatch[2] }
  }
  const messageText = String(message ?? '')
  const messageMatch = messageText.match(/_([a-z_]+)_fkey/)
  if (messageMatch) {
    return { field: messageMatch[1] }
  }
  return null
}

function mapForeignKeyField(field) {
  const key = String(field ?? '').toLowerCase()
  if (!key) return null
  if (key === 'customer_id' || key === 'enterprise_id' || key === 'tenant_id') return 'enterpriseId'
  if (key === 'supplier_id') return 'supplierId'
  if (key === 'operator_id' || key === 'carrier_id') return 'operatorId'
  if (key === 'reseller_id') return 'resellerId'
  if (key === 'user_id' || key === 'actor_user_id') return 'userId'
  if (key === 'sim_id') return 'simId'
  if (key === 'department_id') return 'departmentId'
  return null
}

function makeClientError(status, code, message, body) {
  const err = new Error(message)
  err.name = 'ClientError'
  err.status = status
  err.code = code
  if (body !== undefined) {
    err.body = body
  }
  return err
}

function mapSupabaseError(status, text) {
  const body = parseSupabaseError(text)
  if (!body) return null
  const message = String(body.message ?? '')
  const details = String(body.details ?? '')
  const code = String(body.code ?? '')
  if (code === '23503' || message.includes('violates foreign key constraint')) {
    const info = extractForeignKeyField(details, message)
    const field = mapForeignKeyField(info?.field)
    const label = field ? `${field} not found.` : 'resource not found.'
    return makeClientError(404, 'RESOURCE_NOT_FOUND', label, body)
  }
  if (message.includes('invalid input syntax for type uuid')) {
    return makeClientError(400, 'BAD_REQUEST', 'invalid uuid.', body)
  }
  if (status === 404 && message) {
    return makeClientError(404, 'RESOURCE_NOT_FOUND', message, body)
  }
  return null
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
        const mapped = mapSupabaseError(res.status, text)
        if (mapped) {
          throw mapped
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
        const mapped = mapSupabaseError(res.status, text)
        if (mapped) {
          throw mapped
        }
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
        const mapped = mapSupabaseError(res.status, text)
        if (mapped) {
          throw mapped
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
        const mapped = mapSupabaseError(res.status, text)
        if (mapped) {
          throw mapped
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
        const mapped = mapSupabaseError(res.status, text)
        if (mapped) {
          throw mapped
        }
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
        const mapped = mapSupabaseError(res.status, text)
        if (mapped) {
          throw mapped
        }
        throw makeUpstreamError('UPSTREAM_BAD_RESPONSE', res.status, text)
      }

      if (!text) return null
      return JSON.parse(text)
    }
  }
}
