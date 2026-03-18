import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'

type Row = Record<string, any>

function parseQuery(queryString: string) {
  const parts = String(queryString || '').split('&').filter(Boolean)
  const filters: Array<{ field: string; op: string; value: string | string[] }> = []
  let limit: number | null = null
  let offset = 0
  let order: string | null = null
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx)
    const value = part.slice(idx + 1)
    if (key === 'select') continue
    if (key === 'limit') {
      const n = Number(value)
      limit = Number.isFinite(n) ? n : null
      continue
    }
    if (key === 'offset') {
      const n = Number(value)
      offset = Number.isFinite(n) ? n : 0
      continue
    }
    if (key === 'order') {
      order = decodeURIComponent(value)
      continue
    }
    const opIdx = value.indexOf('.')
    if (opIdx < 0) continue
    const op = value.slice(0, opIdx)
    const raw = value.slice(opIdx + 1)
    if (op === 'in') {
      const inner = raw.startsWith('(') && raw.endsWith(')') ? raw.slice(1, -1) : raw
      const values = inner.length ? inner.split(',').map((v) => decodeURIComponent(v)) : []
      filters.push({ field: key, op, value: values })
      continue
    }
    filters.push({ field: key, op, value: decodeURIComponent(raw) })
  }
  return { filters, limit, offset, order }
}

function applyFilters(rows: Row[], filters: Array<{ field: string; op: string; value: string | string[] }>) {
  if (!filters.length) return rows
  return rows.filter((row) => {
    for (const f of filters) {
      const actual = row?.[f.field]
      if (f.op === 'eq') {
        if (String(actual ?? '') !== String(f.value ?? '')) return false
        continue
      }
      if (f.op === 'in') {
        const values = Array.isArray(f.value) ? f.value : []
        if (!values.includes(String(actual ?? ''))) return false
        continue
      }
      if (f.op === 'ilike') {
        const target = String(actual ?? '').toLowerCase()
        const pattern = String(f.value ?? '').toLowerCase()
        const token = pattern.replace(/%/g, '')
        if (!target.includes(token)) return false
        continue
      }
      if (f.op === 'gte') {
        const a = new Date(String(actual ?? '')).getTime()
        const b = new Date(String(f.value ?? '')).getTime()
        if (Number.isFinite(a) && Number.isFinite(b)) {
          if (a < b) return false
        } else {
          if (String(actual ?? '') < String(f.value ?? '')) return false
        }
        continue
      }
    }
    return true
  })
}

function sortRows(rows: Row[], order: string | null) {
  if (!order) return rows
  const parts = order.split('.')
  const field = parts[0]
  const dir = parts[1]?.toLowerCase() === 'desc' ? -1 : 1
  return rows.slice().sort((a, b) => {
    const av = a?.[field]
    const bv = b?.[field]
    if (av === bv) return 0
    if (av === undefined || av === null) return 1
    if (bv === undefined || bv === null) return -1
    return av < bv ? -1 * dir : 1 * dir
  })
}

function createFakeSupabase(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>()
  const ensureTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name) as Row[]
  }
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((r) => ({ ...r })))
  }
  const getTable = (name: string) => ensureTable(name)
  const insertRow = (table: string, row: Row) => {
    const nowIso = new Date().toISOString()
    if (table === 'jobs') {
      if (!row.job_id) row.job_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'sims') {
      if (!row.sim_id) row.sim_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'price_plans') {
      if (!row.price_plan_id) row.price_plan_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'price_plan_versions') {
      if (!row.price_plan_version_id) row.price_plan_version_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'packages') {
      if (!row.package_id) row.package_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'package_versions') {
      if (!row.package_version_id) row.package_version_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'apn_profiles') {
      if (!row.apn_profile_id) row.apn_profile_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
    }
    if (table === 'roaming_profiles') {
      if (!row.roaming_profile_id) row.roaming_profile_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
      if (!row.updated_at) row.updated_at = nowIso
    }
    if (table === 'profile_versions') {
      if (!row.profile_version_id) row.profile_version_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'audit_logs') {
      if (!row.audit_id) row.audit_id = randomUUID()
    }
    if (table === 'events') {
      if (!row.event_id) row.event_id = randomUUID()
    }
    if (table === 'subscriptions') {
      if (!row.subscription_id) row.subscription_id = randomUUID()
      if (!row.created_at) row.created_at = nowIso
    }
    if (table === 'share_links') {
      if (!row.code) row.code = `s_${randomUUID().replaceAll('-', '').slice(0, 10)}`
      if (!row.created_at) row.created_at = nowIso
    }
    return row
  }
  return {
    getTable,
    async select(table: string, queryString: string) {
      const { filters, limit, offset, order } = parseQuery(queryString)
      const rows = applyFilters(getTable(table), filters)
      const sorted = sortRows(rows, order)
      const sliced = sorted.slice(offset, limit ? offset + limit : undefined)
      return sliced.map((r) => ({ ...r }))
    },
    async selectWithCount(table: string, queryString: string) {
      const { filters, limit, offset, order } = parseQuery(queryString)
      const rows = applyFilters(getTable(table), filters)
      const total = rows.length
      const sorted = sortRows(rows, order)
      const sliced = sorted.slice(offset, limit ? offset + limit : undefined)
      return { data: sliced.map((r) => ({ ...r })), total }
    },
    async rpc(fn: string, params: Record<string, any>) {
      const name = String(fn || '')
      if (name === 'list_bills') {
        const period = params?.p_period ? String(params.p_period) : null
        const status = params?.p_status ? String(params.p_status) : null
        const sortByRaw = params?.p_sort_by ? String(params.p_sort_by) : null
        const sortOrderRaw = params?.p_sort_order ? String(params.p_sort_order) : null
        const limit = Number.isFinite(Number(params?.p_limit)) ? Number(params.p_limit) : 1000
        const offset = Number.isFinite(Number(params?.p_offset)) ? Number(params.p_offset) : 0
        const filters: Array<{ field: string; op: string; value: string | string[] }> = []
        if (period) {
          const m = period.match(/^(\d{4})-(\d{2})$/)
          if (m) {
            const y = Number(m[1])
            const mm = Number(m[2])
            const start = `${m[1]}-${m[2]}-01`
            const end = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10)
            filters.push({ field: 'period_start', op: 'eq', value: start })
            filters.push({ field: 'period_end', op: 'eq', value: end })
          }
        }
        if (status) filters.push({ field: 'status', op: 'eq', value: status })
        const sortMap: Record<string, string> = { period: 'period_start', dueDate: 'due_date', totalAmount: 'total_amount', status: 'status' }
        const sortBy = sortByRaw && sortMap[sortByRaw] ? sortMap[sortByRaw] : 'period_start'
        const sortOrder = sortOrderRaw === 'asc' || sortOrderRaw === 'desc' ? sortOrderRaw : 'desc'
        const rows = applyFilters(getTable('bills'), filters)
        const sorted = sortRows(rows, `${sortBy}.${sortOrder}`)
        const total = sorted.length
        const sliced = sorted.slice(offset, offset + limit)
        const items = sliced.map((b) => ({
          billId: b.bill_id,
          enterpriseId: b.enterprise_id ?? null,
          period: String(b.period_start ?? '').slice(0, 7),
          status: b.status ?? null,
          dueDate: b.due_date ?? null,
          currency: b.currency ?? null,
          totalAmount: b.total_amount ?? null,
        }))
        return { items, total }
      }
      throw new Error(`rpc_not_implemented:${name}`)
    },
    async insert(table: string, rows: any, options: { returning?: 'minimal' | 'representation' } = {}) {
      const payload = Array.isArray(rows) ? rows : [rows]
      const inserted = payload.map((r) => insertRow(table, { ...r }))
      getTable(table).push(...inserted)
      if (options.returning === 'minimal') return null
      return inserted.map((r) => ({ ...r }))
    },
    async update(table: string, matchQueryString: string, patch: unknown, options: { returning?: 'minimal' | 'representation' } = {}) {
      const { filters } = parseQuery(matchQueryString)
      const rows = applyFilters(getTable(table), filters)
      const patchData = patch && typeof patch === 'object' ? (patch as Record<string, any>) : {}
      const updated = rows.map((row) => Object.assign(row, { ...patchData }))
      if (options.returning === 'minimal') return null
      return updated.map((r) => ({ ...r }))
    },
    async delete(table: string, matchQueryString: string) {
      const { filters } = parseQuery(matchQueryString)
      const existing = getTable(table)
      const kept: Row[] = []
      for (const row of existing) {
        const hit = applyFilters([row], filters).length === 1
        if (!hit) kept.push(row)
      }
      tables.set(table, kept)
      return null
    },
    async upsert(table: string, rows: any, _options: any = {}) {
      const payload = Array.isArray(rows) ? rows : [rows]
      for (const row of payload) {
        getTable(table).push(insertRow(table, { ...row }))
      }
      return payload
    },
  }
}

type Field = {
  location: string
  name: string
  required: boolean
  schemaSummary: string
  boundaries: Array<{ kind: string; value: any }>
  typeErrors: Array<{ kind: string; value: any }>
}

type Operation = {
  opId: string
  method: string
  path: string
  summary: string | null
  securityLabel: string
  source: string
  rbac: null | { roles?: string[]; permissions?: string[] }
  fields: Field[]
  stateSuites?: Array<{ key: string; title: string }>
  concurrencySuggested?: boolean
}

type ReportItem = {
  id: string
  opId: string
  method: string
  path: string
  category: string
  ok: boolean
  status: number
  expected: string
  note?: string
  request: { url: string; headers: Record<string, string>; query?: Record<string, any>; body?: any }
  response: { headers: Record<string, string>; body: string }
}

type RequestShape = {
  url: string
  headers: Record<string, string>
  query?: Record<string, any>
  body?: any
}

function base64Url(buf: Buffer) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/g, '')
}

function signRs256Jwt(payload: Record<string, any>, privateKeyPem: string, kid: string) {
  const header = { alg: 'RS256', typ: 'JWT', kid }
  const enc = (obj: any) => base64Url(Buffer.from(JSON.stringify(obj)))
  const data = `${enc(header)}.${enc(payload)}`
  const signer = createSign('RSA-SHA256')
  signer.update(data)
  signer.end()
  const sig = signer.sign(privateKeyPem)
  return `${data}.${base64Url(sig)}`
}

function realizePlaceholder(v: any, ctx: Record<string, any>) {
  if (typeof v === 'string') {
    if (v === '__UUID__') return ctx.uuid
    if (v === '__ONE__') return 'x'
    if (v === '__INVALID_ENUM__') return '__INVALID_ENUM__'
    const m1 = v.match(/^<string length=(\d+)>$/)
    if (m1) return 'a'.repeat(Number(m1[1]))
    const m2 = v.match(/^<array size=(\d+)>$/)
    if (m2) return Array.from({ length: Number(m2[1]) }).map(() => 'x')
    const mm = v.match(/^<match (.+)>$/)
    if (mm) {
      const pat = String(mm[1])
      if (pat.includes('\\d{18,20}') || pat.includes('[0-9]{18,20}')) return ctx.iccid
      if (pat.includes('\\d{15}')) return '1'.repeat(15)
      return 'a'
    }
    const mx = v.match(/^<mismatch (.+)>$/)
    if (mx) return 'mismatch'
  }
  return v
}

function pickValidValue(field: Field, ctx: Record<string, any>) {
  const b = field.boundaries || []
  const prefer = ['合法枚举', '合法UUID', '最小长度', '最大长度', '满足pattern', 'true', 'false', '零值']
  for (const k of prefer) {
    const hit = b.find((x) => x.kind === k)
    if (hit) return realizePlaceholder(hit.value, ctx)
  }
  if (field.schemaSummary.includes('boolean')) return true
  if (field.schemaSummary.includes('integer') || field.schemaSummary.includes('number')) return 1
  if (field.schemaSummary.includes('format=uuid')) return ctx.uuid
  if (field.schemaSummary.includes('pattern') && field.schemaSummary.includes('18,20')) return ctx.iccid
  return 'x'
}

function setDeep(obj: any, dotted: string, value: any) {
  const parts = dotted.split('.')
  let cur = obj
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i]
    const isArray = raw.endsWith('[]')
    const key = isArray ? raw.slice(0, -2) : raw
    if (i === parts.length - 1) {
      if (isArray) {
        cur[key] = Array.isArray(value) ? value : [value]
      } else {
        cur[key] = value
      }
      return
    }
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
}

function replacePathParams(p: string, params: Record<string, string>) {
  return p.replaceAll(/\{([^}]+)\}/g, (_m, name) => encodeURIComponent(String(params[name] ?? '')))
}

function buildBase(op: Operation, ctx: Record<string, any>) {
  const pathParams: Record<string, string> = {}
  const query: Record<string, any> = {}
  const headers: Record<string, string> = {}
  const bodyByType = new Map<string, any>()

  for (const f of op.fields) {
    if (f.location === 'path') {
      const key = f.name
      if (key.toLowerCase().includes('iccid')) pathParams[key] = ctx.iccid
      else if (key.toLowerCase().includes('simid')) pathParams[key] = ctx.simId
      else if (key.toLowerCase().includes('billid')) pathParams[key] = ctx.billId
      else if (key.toLowerCase().includes('runid')) pathParams[key] = ctx.runId
      else if (key.toLowerCase().includes('webhookid')) pathParams[key] = ctx.webhookId
      else pathParams[key] = ctx.uuid
    } else if (f.location === 'query' && f.required) {
      query[f.name] = pickValidValue(f, ctx)
    } else if (f.location.startsWith('body:') && f.required) {
      const ct = f.location.slice('body:'.length)
      if (!bodyByType.has(ct)) bodyByType.set(ct, {})
      const body = bodyByType.get(ct)
      setDeep(body, f.name, pickValidValue(f, ctx))
    }
  }

  const contentType = bodyByType.has('application/json')
    ? 'application/json'
    : (bodyByType.keys().next().value ?? null)
  const body = contentType ? bodyByType.get(contentType) : undefined
  if (contentType && body !== undefined && contentType !== 'multipart/form-data') headers['content-type'] = contentType

  const sec = op.securityLabel
  if (sec.includes('AdminApiKeyAuth')) {
    headers['x-api-key'] = String(process.env.ADMIN_API_KEY || 'adminkey')
  } else if (sec.includes('BearerAuth')) {
    headers['x-api-key'] = String(process.env.ADMIN_API_KEY || 'adminkey')
  } else if (sec.includes('ApiKeyAuth')) {
    headers['x-api-key'] = String(process.env.ADMIN_API_KEY || 'adminkey')
  }

  return { pathParams, query, headers, body, contentType }
}

function snapshotBody(body: any) {
  if (!body) return body
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const out: Record<string, any> = {}
    for (const [k, v] of body.entries()) {
      if (v instanceof Blob) {
        out[k] = { type: v.type, size: v.size }
      } else {
        out[k] = String(v)
      }
    }
    return out
  }
  return body
}

function buildBodiesByType(op: Operation, ctx: Record<string, any>) {
  const byType = new Map<string, any>()
  const groups = new Map<string, Field[]>()
  for (const f of op.fields) {
    if (!f.location.startsWith('body:')) continue
    const ct = f.location.slice('body:'.length)
    if (!groups.has(ct)) groups.set(ct, [])
    groups.get(ct)?.push(f)
  }
  for (const [ct, fields] of groups.entries()) {
    if (ct === 'multipart/form-data') {
      const fd = new FormData()
      for (const f of fields.filter((x) => x.required)) {
        if (f.schemaSummary.includes('format=binary') || f.name.toLowerCase() === 'file') {
          const csv = ['iccid,imsi,msisdn', `${ctx.iccid},imsi1,123`, ''].join('\n')
          fd.set(f.name, new Blob([csv], { type: 'text/csv' }), 'import.csv')
        } else {
          fd.set(f.name, String(pickValidValue(f, ctx)))
        }
      }
      byType.set(ct, fd)
    } else {
      const body: any = {}
      const ordered = fields.slice().sort((a, b) => {
        const aa = a.name.endsWith('[]') ? 1 : 0
        const bb = b.name.endsWith('[]') ? 1 : 0
        return aa - bb
      })
      for (const f of ordered.filter((x) => x.required)) {
        setDeep(body, f.name, pickValidValue(f, ctx))
      }
      byType.set(ct, body)
    }
  }
  return byType
}

function cloneBody(body: any) {
  if (!body) return body
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fd = new FormData()
    for (const [k, v] of body.entries()) {
      fd.append(k, v as any)
    }
    return fd
  }
  return JSON.parse(JSON.stringify(body))
}

function setBodyField(body: any, contentType: string, fieldPath: string, value: any, ctx: Record<string, any>) {
  const realized = realizePlaceholder(value, ctx)
  if (contentType === 'multipart/form-data') {
    const fd = body as FormData
    if (fieldPath.toLowerCase() === 'file') {
      if (realized === '' || realized === null || realized === undefined) {
        fd.delete(fieldPath)
      } else {
        const csv = ['iccid,imsi,msisdn', `${ctx.iccid},imsi1,123`, ''].join('\n')
        fd.set(fieldPath, new Blob([csv], { type: 'text/csv' }), 'import.csv')
      }
      return
    }
    if (realized === '__MISSING_REQUIRED__') {
      fd.delete(fieldPath)
      return
    }
    if (realized === '__EXTRA_FIELDS__') {
      fd.set('extraField', 'x')
      return
    }
    if (realized === null || realized === undefined) {
      fd.set(fieldPath, 'null')
      return
    }
    fd.set(fieldPath, String(realized))
    return
  }

  if (realized === '__MISSING_REQUIRED__') {
    const parts = fieldPath.split('.')
    const last = parts[parts.length - 1]
    let cur = body
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i]
      if (!cur?.[k]) return
      cur = cur[k]
    }
    if (cur && typeof cur === 'object') delete cur[last]
    return
  }
  if (realized === '__EXTRA_FIELDS__') {
    body.extraField = 'x'
    return
  }
  setDeep(body, fieldPath, realized)
}

function mergeHeaders(a: Record<string, string>, b: Record<string, string>) {
  return { ...a, ...b }
}

function shouldBe4xx(kind: string, required: boolean) {
  if (kind === '非法枚举') return true
  if (kind === '超过最大长度') return true
  if (kind === '小于最小长度') return true
  if (kind === '不满足pattern') return true
  if (kind === '非法UUID') return true
  if (kind === '空字符串' || kind === '空白字符串') return required
  if (kind === '缺失必填字段') return true
  return false
}

vi.mock('../src/supabaseRest.js', () => {
  const seed = (() => {
    const supplierId = '11111111-1111-1111-1111-111111111111'
    const operatorId = '22222222-2222-2222-2222-222222222222'
    const carrierId = '99999999-9999-9999-9999-999999999999'
    const resellerId = '44444444-4444-4444-4444-444444444444'
    const enterpriseId = '33333333-3333-3333-3333-333333333333'
    const departmentId = '55555555-5555-5555-5555-555555555555'
    const billId = '66666666-6666-6666-6666-666666666666'
    const nowIso = new Date().toISOString()
    return {
      suppliers: [{ supplier_id: supplierId, name: 'Supplier A', status: 'ACTIVE' }],
      operators: [{ operator_id: operatorId, supplier_id: supplierId, carrier_id: carrierId, name: 'Operator A', status: 'ACTIVE' }],
      business_operators: [{ operator_id: operatorId, mcc: '001', mnc: '01', name: 'Operator A' }],
      tenants: [
        { tenant_id: resellerId, tenant_type: 'RESELLER', reseller_status: 'ACTIVE', name: 'Reseller A', created_at: nowIso },
        { tenant_id: enterpriseId, tenant_type: 'ENTERPRISE', parent_id: resellerId, enterprise_status: 'ACTIVE', name: 'Enterprise A', created_at: nowIso },
        { tenant_id: departmentId, tenant_type: 'DEPARTMENT', parent_id: enterpriseId, name: 'Dept A', created_at: nowIso },
      ],
      reseller_enterprise_assignments: [{ reseller_id: resellerId, enterprise_id: enterpriseId }],
      sims: [{
        sim_id: '77777777-7777-7777-7777-777777777777',
        iccid: '8986012345678901234',
        primary_imsi: 'imsi1',
        msisdn: '123',
        supplier_id: supplierId,
        operator_id: operatorId,
        enterprise_id: enterpriseId,
        department_id: departmentId,
        status: 'INVENTORY',
        apn: 'apn1',
        created_at: nowIso,
      }],
      bills: [{
        bill_id: billId,
        enterprise_id: enterpriseId,
        reseller_id: resellerId,
        status: 'OPEN',
        currency: 'USD',
        period_start: '2026-02-01T00:00:00Z',
        period_end: '2026-03-01T00:00:00Z',
        created_at: nowIso,
      }],
      bill_line_items: [],
      billing_adjustment_notes: [],
    }
  })()
  const supabase = createFakeSupabase(seed)
  ;(globalThis as any).__apiSystemSupabase = supabase
  return {
    createSupabaseRestClient() {
      return supabase as any
    },
  }
})

describe('api-system', () => {
  it(
    'executes inventory cases and writes report',
    async () => {
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const jwk = publicKey.export({ format: 'jwk' }) as any
      const kid = `kid_${randomUUID().replaceAll('-', '')}`
      const issuer = 'https://issuer.example'
      const audience = 'cmp-api'

      const jwksServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.url?.startsWith('/.well-known/jwks.json')) {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }))
          return
        }
        res.statusCode = 404
        res.end('not found')
      })
      jwksServer.listen(0, '127.0.0.1')
      await once(jwksServer, 'listening')
      const addr = jwksServer.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const jwksUrl = `http://127.0.0.1:${port}/.well-known/jwks.json`

      process.env.OIDC_JWKS_URL = jwksUrl
      process.env.OIDC_ISSUER = issuer
      process.env.OIDC_AUDIENCE = audience
      process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'adminkey'
      process.env.RATE_LIMIT_ADMIN_MAX = process.env.RATE_LIMIT_ADMIN_MAX || '1000000'
      process.env.RATE_LIMIT_ADMIN_WINDOW_MS = process.env.RATE_LIMIT_ADMIN_WINDOW_MS || '60000'
      process.env.RATE_LIMIT_WRITE_MAX = process.env.RATE_LIMIT_WRITE_MAX || '1000000'
      process.env.RATE_LIMIT_WRITE_WINDOW_MS = process.env.RATE_LIMIT_WRITE_WINDOW_MS || '60000'
      process.env.RATE_LIMIT_TOKEN_MAX = process.env.RATE_LIMIT_TOKEN_MAX || '1000000'
      process.env.RATE_LIMIT_TOKEN_WINDOW_MS = process.env.RATE_LIMIT_TOKEN_WINDOW_MS || '60000'

      const now = Math.floor(Date.now() / 1000)
      const platformAdminToken = signRs256Jwt(
        {
          iss: issuer,
          aud: audience,
          iat: now,
          exp: now + 3600,
          sub: 'user-platform',
          roleScope: 'platform',
          role: 'platform_admin',
        },
        privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        kid
      )
      const expiredToken = signRs256Jwt(
        {
          iss: issuer,
          aud: audience,
          iat: now - 7200,
          exp: now - 3600,
          sub: 'user-expired',
          roleScope: 'platform',
          role: 'platform_admin',
        },
        privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        kid
      )

      const ctx: Record<string, any> = {
        uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        simId: '77777777-7777-7777-7777-777777777777',
        iccid: '8986012345678901234',
        billId: '66666666-6666-6666-6666-666666666666',
        runId: '88888888-8888-8888-8888-888888888888',
        webhookId: '99999999-9999-9999-9999-999999999999',
        tokens: {
          platformAdmin: platformAdminToken,
          expired: expiredToken,
        },
      }

      const inventoryPath = path.resolve(process.cwd(), 'docs', 'api-system-test', 'inventory.json')
      const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as { operations: Operation[] }

      const { createApp } = await import('../src/app.js')
      const app = createApp()
      const appAny = app as any
      const apiServer = await new Promise<any>((resolve, reject) => {
        const s = appAny.listen(0, '127.0.0.1', () => resolve(s))
        s.on('error', reject)
      })
      const apiAddr = apiServer.address()
      const apiPort = typeof apiAddr === 'object' && apiAddr ? apiAddr.port : 0
      const baseUrl = `http://127.0.0.1:${apiPort}`

      const report: ReportItem[] = []
      const record = (item: ReportItem) => report.push(item)

      const tryRequest = async (method: string, url: string, headers: Record<string, string>, body: any) => {
        try {
          const init: RequestInit = { method, headers: { ...headers } }
          if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
            init.body = headers['content-type'] === 'application/json' ? JSON.stringify(body) : String(body)
          }
          const res = await fetch(`${baseUrl}${url}`, init)
          const respHeaders: Record<string, string> = {}
          for (const [k, v] of res.headers.entries()) respHeaders[k.toLowerCase()] = String(v)
          const text = await res.text()
          return { status: res.status, headers: respHeaders, body: text }
        } catch (err: any) {
          return { status: 599, headers: {}, body: String(err?.message ?? err) }
        }
      }

      const resolveUrl = (p: string, query: Record<string, any>) => {
        const qs = Object.entries(query || {})
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
        return qs ? `${p}?${qs}` : p
      }

      const requestWithFallback = async ({
        method,
        path,
        pathParams,
        query,
        headers,
        body,
      }: {
        method: string
        path: string
        pathParams: Record<string, string>
        query: Record<string, any>
        headers: Record<string, string>
        body: any
      }) => {
        const p1 = replacePathParams(path, pathParams)
        const url1 = resolveUrl(`/v1${p1}`, query)
        const url2 = resolveUrl(p1, query)
        const r1 = await tryRequest(method, url1, headers, body)
        if (r1.status !== 404) return { url: url1, ...r1 }
        const r2 = await tryRequest(method, url2, headers, body)
        return { url: url2, ...r2 }
      }

      for (const op of inventory.operations) {
        const base = buildBase(op, ctx)
        const bodiesByType = buildBodiesByType(op, ctx)

        const hpHeaders = mergeHeaders(base.headers, {})
        const hpBody =
          bodiesByType.get('application/json') ??
          bodiesByType.get('multipart/form-data') ??
          base.body
        const hp = await requestWithFallback({
          method: op.method,
          path: op.path,
          pathParams: base.pathParams,
          query: base.query,
          headers: hpHeaders,
          body: hpBody,
        })

        record({
          id: `${op.opId}-HP`,
          opId: op.opId,
          method: op.method,
          path: op.path,
          category: 'HP',
          ok: hp.status < 500,
          status: hp.status,
          expected: '2xx/3xx 或明确 4xx（不可用资源）但不得 5xx',
          request: { url: hp.url, headers: hpHeaders, query: base.query, body: snapshotBody(hpBody) },
          response: { headers: hp.headers, body: hp.body },
        })

        if (!op.securityLabel.includes('NONE')) {
          const noAuth = await tryRequest(op.method, hp.url, { ...(base.headers || {}), authorization: '', 'x-api-key': '' }, hpBody)
          record({
            id: `${op.opId}-AUTH-00`,
            opId: op.opId,
            method: op.method,
            path: op.path,
            category: 'AUTH',
            ok: noAuth.status === 401 || noAuth.status === 403,
            status: noAuth.status,
            expected: '401/403',
            request: { url: hp.url, headers: { authorization: '', 'x-api-key': '' }, query: base.query, body: snapshotBody(hpBody) },
            response: { headers: noAuth.headers, body: noAuth.body },
          })

          const invalidHeaders: Record<string, string> = (op.securityLabel.includes('AdminApiKeyAuth') || op.securityLabel.includes('ApiKeyAuth'))
            ? { 'x-api-key': 'invalid' }
            : { authorization: 'Bearer invalid.token.value' }
          const invalid = await tryRequest(op.method, hp.url, invalidHeaders, hpBody)
          record({
            id: `${op.opId}-AUTH-02`,
            opId: op.opId,
            method: op.method,
            path: op.path,
            category: 'AUTH',
            ok: invalid.status === 401 || invalid.status === 403,
            status: invalid.status,
            expected: '401/403',
            request: { url: hp.url, headers: invalidHeaders as any, query: base.query, body: snapshotBody(hpBody) },
            response: { headers: invalid.headers, body: invalid.body },
          })

          if (op.securityLabel.includes('BearerAuth')) {
            const expiredHeaders = { authorization: `Bearer ${ctx.tokens.expired}` }
            const expired = await tryRequest(op.method, hp.url, expiredHeaders, hpBody)
            record({
              id: `${op.opId}-AUTH-03`,
              opId: op.opId,
              method: op.method,
              path: op.path,
              category: 'AUTH',
              ok: expired.status === 401,
              status: expired.status,
              expected: '401',
              request: { url: hp.url, headers: expiredHeaders, query: base.query, body: snapshotBody(hpBody) },
              response: { headers: expired.headers, body: expired.body },
            })
          }
        }

        const fields = Array.isArray(op.fields) ? op.fields : []

        if (Array.isArray(op.stateSuites) && op.stateSuites.length) {
          const supabase = (globalThis as any).__apiSystemSupabase
          if (supabase && typeof supabase.getTable === 'function') {
            if (op.path.startsWith('/sims/{simId}:')) {
              const sims = supabase.getTable('sims')
              const sim = sims.find((r: any) => String(r.sim_id) === String(ctx.simId)) ?? sims[0]
              if (sim) {
                const action = op.path.split(':')[1] ? String(op.path.split(':')[1]) : ''
                const run = async (status: string, body: any, id: string, expected: string) => {
                  sim.status = status
                  const r = await requestWithFallback({
                    method: op.method,
                    path: op.path,
                    pathParams: { ...base.pathParams, simId: ctx.simId },
                    query: base.query,
                    headers: hpHeaders,
                    body,
                  })
                  record({
                    id,
                    opId: op.opId,
                    method: op.method,
                    path: op.path,
                    category: 'STATE',
                    ok: expected === '4xx' ? (r.status >= 400 && r.status < 500) : r.status < 500,
                    status: r.status,
                    expected,
                    request: { url: r.url, headers: hpHeaders, query: base.query, body: snapshotBody(body) },
                    response: { headers: r.headers, body: r.body },
                  })
                }
                if (action === 'activate') {
                  await run('INVENTORY', {}, `${op.opId}-STATE-ALLOWED`, 'not 5xx')
                  await run('RETIRED', {}, `${op.opId}-STATE-DISALLOWED`, '4xx')
                } else if (action === 'deactivate') {
                  await run('ACTIVATED', { reason: 'test' }, `${op.opId}-STATE-ALLOWED`, 'not 5xx')
                  await run('INVENTORY', { reason: 'test' }, `${op.opId}-STATE-DISALLOWED`, '4xx')
                } else if (action === 'reactivate') {
                  await run('DEACTIVATED', {}, `${op.opId}-STATE-ALLOWED`, 'not 5xx')
                  await run('INVENTORY', {}, `${op.opId}-STATE-DISALLOWED`, '4xx')
                } else if (action === 'retire') {
                  await run('DEACTIVATED', { reason: 'test', confirm: true }, `${op.opId}-STATE-ALLOWED`, 'not 5xx')
                  await run('ACTIVATED', { reason: 'test', confirm: true }, `${op.opId}-STATE-DISALLOWED`, '4xx')
                }
              }
            }
          }
        }

        if (op.concurrencySuggested) {
          const idem = `idem_${Date.now()}`
          const concBody = (() => {
            if (op.method !== 'POST') return hpBody
            if (hpBody && typeof FormData !== 'undefined' && hpBody instanceof FormData) return hpBody
            if (hpBody && typeof hpBody === 'object') return { ...(hpBody as any), idempotencyKey: idem }
            return hpBody
          })()
          const [a, b] = await Promise.all([
            requestWithFallback({ method: op.method, path: op.path, pathParams: base.pathParams, query: base.query, headers: hpHeaders, body: concBody }),
            requestWithFallback({ method: op.method, path: op.path, pathParams: base.pathParams, query: base.query, headers: hpHeaders, body: concBody }),
          ])
          record({
            id: `${op.opId}-CONC`,
            opId: op.opId,
            method: op.method,
            path: op.path,
            category: 'CONCURRENCY',
            ok: a.status < 500 && b.status < 500,
            status: Math.max(a.status, b.status),
            expected: 'not 5xx',
            request: { url: a.url, headers: hpHeaders, query: base.query, body: snapshotBody(concBody) },
            response: { headers: {}, body: `A:${a.status} B:${b.status}` },
          })
        }

        for (const f of fields) {
          if (!(f.location === 'path' || f.location === 'query' || f.location.startsWith('body:'))) continue
          const params2 = { ...base.pathParams }
          const query2 = { ...base.query }
          const headers2 = { ...base.headers }
          let bodyType = 'application/json'
          if (f.location.startsWith('body:')) bodyType = f.location.slice('body:'.length)
          const bodyBase = bodiesByType.get(bodyType)
          const body2 = cloneBody(bodyBase)
          if (bodyType && body2 !== undefined && bodyType !== 'multipart/form-data') headers2['content-type'] = bodyType
          if (bodyType === 'multipart/form-data') delete headers2['content-type']

          for (const b of f.boundaries || []) {
            const kind = String(b.kind)
            const expected4xx = shouldBe4xx(kind, f.required)
            const body3 = cloneBody(body2)
            const params3 = { ...params2 }
            const query3 = { ...query2 }
            if (f.location === 'path') params3[f.name] = String(realizePlaceholder(b.value, ctx))
            else if (f.location === 'query') query3[f.name] = realizePlaceholder(b.value, ctx)
            else if (f.location.startsWith('body:')) setBodyField(body3, bodyType, f.name, b.value, ctx)

            const r = await requestWithFallback({
              method: op.method,
              path: op.path,
              pathParams: params3,
              query: query3,
              headers: headers2,
              body: body3,
            })
            record({
              id: `${op.opId}-BND-${f.location}:${f.name}:${kind}`,
              opId: op.opId,
              method: op.method,
              path: op.path,
              category: 'BND',
              ok: expected4xx ? (r.status >= 400 && r.status < 500) : r.status < 500,
              status: r.status,
              expected: expected4xx ? '4xx' : 'not 5xx',
              request: { url: r.url, headers: headers2, query: query3, body: snapshotBody(body3) },
              response: { headers: r.headers, body: r.body },
            })
          }
        }

        for (const f of fields) {
          if (!(f.location === 'path' || f.location === 'query' || f.location.startsWith('body:'))) continue
          const params2 = { ...base.pathParams }
          const query2 = { ...base.query }
          const headers2 = { ...base.headers }
          let bodyType = 'application/json'
          if (f.location.startsWith('body:')) bodyType = f.location.slice('body:'.length)
          const bodyBase = bodiesByType.get(bodyType)
          const body2 = cloneBody(bodyBase)
          if (bodyType && body2 !== undefined && bodyType !== 'multipart/form-data') headers2['content-type'] = bodyType
          if (bodyType === 'multipart/form-data') delete headers2['content-type']

          for (const te of f.typeErrors || []) {
            const val = te.value
            if (f.location === 'path' && typeof val === 'object') continue
            if (f.location === 'query' && typeof val === 'object') continue
            const body3 = cloneBody(body2)
            const params3 = { ...params2 }
            const query3 = { ...query2 }
            if (f.location === 'path') params3[f.name] = String(val)
            else if (f.location === 'query') query3[f.name] = val
            else if (f.location.startsWith('body:')) setBodyField(body3, bodyType, f.name, val, ctx)

            const r = await requestWithFallback({
              method: op.method,
              path: op.path,
              pathParams: params3,
              query: query3,
              headers: headers2,
              body: body3,
            })
            record({
              id: `${op.opId}-TYPE-${f.location}:${f.name}:${String(te.kind)}`,
              opId: op.opId,
              method: op.method,
              path: op.path,
              category: 'TYPE',
              ok: r.status >= 400 && r.status < 500,
              status: r.status,
              expected: '4xx',
              request: { url: r.url, headers: headers2, query: query3, body: snapshotBody(body3) },
              response: { headers: r.headers, body: r.body },
            })
          }
        }
      }

      apiServer.close()
      jwksServer.close()

      const outDir = path.resolve(process.cwd(), 'docs', 'api-system-test')
      fs.mkdirSync(outDir, { recursive: true })
      const outJson = path.resolve(outDir, 'execution-report.json')
      fs.writeFileSync(outJson, JSON.stringify({ generatedAt: new Date().toISOString(), items: report }, null, 2))

      const totals = {
        total: report.length,
        passed: report.filter((r) => r.ok).length,
        failed: report.filter((r) => !r.ok).length,
      }
      const serverErrors = report.filter((r) => r.status >= 500).length
      const failures = report.filter((r) => !r.ok).slice(0, 50)
      const lines: string[] = []
      lines.push('# API 系统测试执行报告')
      lines.push('')
      lines.push(`- 总用例数: ${totals.total}`)
      lines.push(`- 通过: ${totals.passed}`)
      lines.push(`- 失败: ${totals.failed}`)
      lines.push(`- 详情(JSON): execution-report.json`)
      lines.push('')
      lines.push('## 失败用例（最多 50 条）')
      lines.push('')
      for (const f of failures) {
        lines.push(`- ${f.id} ${f.method} ${f.path} status=${f.status} expected=${f.expected}`)
      }
      fs.writeFileSync(path.resolve(outDir, 'execution-report.md'), lines.join('\n'))

      expect(serverErrors).toBe(0)
    },
    1800000
  )
})
