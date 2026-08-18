import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getAuthContext, rbac } from '../middleware/rbac.js'
import { parsePagination } from '../utils/pagination.js'
import {
  periodToMonthStart,
  splitReportWindowForUsageSources,
} from '../services/usageMonthlyRollup.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount?: (
    table: string,
    queryString: string,
  ) => Promise<{ data: unknown; total: number | null }>
}

type RouteDeps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => SupabaseClient
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  getRoleScope: (req: FastifyRequest) => string | null
  getEnterpriseIdFromReq: (req: FastifyRequest) => string | null
  isValidUuid: (value: unknown) => boolean
}

type ReportScope = {
  enterpriseId: string | null
  enterpriseIds: string[] | null
  resellerId: string | null
}

const SIM_STATUSES = ['INVENTORY', 'TEST_READY', 'ACTIVATED', 'DEACTIVATED', 'RETIRED'] as const

/** Shared max span for report date windows (calendar months, inclusive). */
const MAX_REPORT_MONTHS = 36

function parseDateOnly(value: unknown) {
  const raw = value ? String(value).trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const date = new Date(`${raw}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return null
  return date
}

function parseReportDateRange(query: Record<string, unknown>) {
  const startDay = parseDateOnly(query.startDate)
  const endDay = parseDateOnly(query.endDate)
  if (!startDay || !endDay) return null
  if (startDay.getTime() > endDay.getTime()) return null
  return { startDay, endDay }
}

function enforceMaxReportMonths(
  range: { startDay: Date; endDay: Date },
  reply: FastifyReply,
  sendError: RouteDeps['sendError'],
): boolean {
  if (monthsInclusive(range.startDay, range.endDay) > MAX_REPORT_MONTHS) {
    sendError(
      reply,
      400,
      'BAD_REQUEST',
      `startDate/endDate span must be at most ${MAX_REPORT_MONTHS} calendar months.`,
    )
    return false
  }
  return true
}

function normalizeReportGranularity(value: unknown) {
  const raw = String(value || '').toLowerCase()
  return raw === 'month' || raw === 'monthly' ? 'month' : 'day'
}

function daysInclusive(startDay: Date, endDay: Date) {
  return Math.floor((endDay.getTime() - startDay.getTime()) / (24 * 60 * 60 * 1000)) + 1
}

function monthsInclusive(startDay: Date, endDay: Date) {
  return (endDay.getUTCFullYear() - startDay.getUTCFullYear()) * 12 + (endDay.getUTCMonth() - startDay.getUTCMonth()) + 1
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

function mccFromVisited(visited: unknown): string | null {
  const digits = String(visited ?? '').replace(/\D/g, '')
  if (digits.length < 3) return null
  return digits.slice(0, 3)
}

async function loadEnterpriseTenant(supabase: SupabaseClient, enterpriseId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type,name&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`,
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
}

async function loadResellerTenant(supabase: SupabaseClient, resellerId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,tenant_type&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`,
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
}

async function listEnterpriseIdsForReseller(supabase: SupabaseClient, resellerId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`,
  )
  return Array.isArray(rows)
    ? rows.map((r) => (r as Record<string, unknown>)?.tenant_id).filter(Boolean).map(String)
    : []
}

async function loadEnterpriseNameMap(supabase: SupabaseClient, enterpriseIds: string[]) {
  const map = new Map<string, string | null>()
  if (!enterpriseIds.length) return map
  for (const chunk of chunkArray(enterpriseIds, 100)) {
    const list = chunk.map((id) => encodeURIComponent(id)).join(',')
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id,name&tenant_id=in.(${list})&tenant_type=eq.ENTERPRISE`,
    )
    for (const row of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
      if (!row.tenant_id) continue
      map.set(String(row.tenant_id), row.name != null ? String(row.name) : null)
    }
  }
  return map
}

async function resolveReportScope(
  req: FastifyRequest,
  reply: FastifyReply,
  supabase: SupabaseClient,
  enterpriseIdParam: string | null,
  resellerIdParam: string | null,
  deps: Pick<RouteDeps, 'getRoleScope' | 'getEnterpriseIdFromReq' | 'sendError' | 'isValidUuid'>,
): Promise<ReportScope | null> {
  const roleScope = deps.getRoleScope(req)
  const auth = getAuthContext(req)
  const resellerId = auth.resellerId ? String(auth.resellerId) : null

  if (roleScope === 'reseller') {
    if (!resellerId) {
      deps.sendError(reply, 403, 'FORBIDDEN', 'Reseller scope required.')
      return null
    }
    if (resellerIdParam) {
      if (!deps.isValidUuid(resellerIdParam)) {
        deps.sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      const row = await loadResellerTenant(supabase, resellerIdParam)
      if (!row?.tenant_id) {
        deps.sendError(reply, 404, 'NOT_FOUND', 'Reseller not found.')
        return null
      }
      if (resellerIdParam !== resellerId) {
        deps.sendError(reply, 403, 'FORBIDDEN', 'resellerId does not match reseller token.')
        return null
      }
    }
    if (enterpriseIdParam) {
      if (!deps.isValidUuid(enterpriseIdParam)) {
        deps.sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const row = await loadEnterpriseTenant(supabase, enterpriseIdParam)
      if (!row?.tenant_id) {
        deps.sendError(reply, 404, 'NOT_FOUND', 'Enterprise not found.')
        return null
      }
      if (String(row.parent_id ?? '') !== resellerId) {
        deps.sendError(reply, 403, 'FORBIDDEN', 'Enterprise is not in reseller scope.')
        return null
      }
      return { enterpriseId: enterpriseIdParam, enterpriseIds: null, resellerId }
    }
    const enterpriseIds = await listEnterpriseIdsForReseller(supabase, resellerId)
    return { enterpriseId: null, enterpriseIds, resellerId }
  }

  if (roleScope === 'platform' || auth.role === 'platform_admin') {
    if (resellerIdParam) {
      if (!deps.isValidUuid(resellerIdParam)) {
        deps.sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      const resellerRow = await loadResellerTenant(supabase, resellerIdParam)
      if (!resellerRow?.tenant_id) {
        deps.sendError(reply, 404, 'NOT_FOUND', 'Reseller not found.')
        return null
      }
      if (enterpriseIdParam) {
        if (!deps.isValidUuid(enterpriseIdParam)) {
          deps.sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
          return null
        }
        const enterpriseRow = await loadEnterpriseTenant(supabase, enterpriseIdParam)
        if (!enterpriseRow?.tenant_id) {
          deps.sendError(reply, 404, 'NOT_FOUND', 'Enterprise not found.')
          return null
        }
        if (String(enterpriseRow.parent_id ?? '') !== resellerIdParam) {
          deps.sendError(reply, 403, 'FORBIDDEN', 'Enterprise is not in reseller scope.')
          return null
        }
        return { enterpriseId: enterpriseIdParam, enterpriseIds: null, resellerId: resellerIdParam }
      }
      const enterpriseIds = await listEnterpriseIdsForReseller(supabase, resellerIdParam)
      return { enterpriseId: null, enterpriseIds, resellerId: resellerIdParam }
    }
    if (enterpriseIdParam) {
      if (!deps.isValidUuid(enterpriseIdParam)) {
        deps.sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const row = await loadEnterpriseTenant(supabase, enterpriseIdParam)
      if (!row?.tenant_id) {
        deps.sendError(reply, 404, 'NOT_FOUND', 'Enterprise not found.')
        return null
      }
      return { enterpriseId: enterpriseIdParam, enterpriseIds: null, resellerId: null }
    }
    return { enterpriseId: null, enterpriseIds: null, resellerId: null }
  }

  const enterpriseId = deps.getEnterpriseIdFromReq(req)
  if (!enterpriseId || !deps.isValidUuid(enterpriseId)) {
    deps.sendError(reply, 401, 'UNAUTHORIZED', 'Enterprise token required.')
    return null
  }
  if (enterpriseIdParam) {
    if (!deps.isValidUuid(enterpriseIdParam)) {
      deps.sendError(reply, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      return null
    }
    const row = await loadEnterpriseTenant(supabase, enterpriseIdParam)
    if (!row?.tenant_id) {
      deps.sendError(reply, 404, 'NOT_FOUND', 'Enterprise not found.')
      return null
    }
    if (enterpriseIdParam !== enterpriseId) {
      deps.sendError(reply, 403, 'FORBIDDEN', 'Enterprise is not in customer scope.')
      return null
    }
  }
  return { enterpriseId: String(enterpriseId), enterpriseIds: null, resellerId: null }
}

/** Usage tables: filter by enterprise_id only (inventory without enterprise excluded). */
function applyEnterpriseScope(filters: string[], scope: ReportScope, empty: () => unknown) {
  if (scope.enterpriseId) {
    filters.push(`enterprise_id=eq.${encodeURIComponent(scope.enterpriseId)}`)
    return null
  }
  if (scope.enterpriseIds) {
    if (!scope.enterpriseIds.length) return empty()
    filters.push(`enterprise_id=in.(${scope.enterpriseIds.map((v) => encodeURIComponent(v)).join(',')})`)
  }
  return null
}

/**
 * SIM summary scope: include reseller inventory (reseller_id) plus child enterprises when applicable.
 */
function applySimScopeFilters(filters: string[], scope: ReportScope): 'ok' | 'empty' {
  if (scope.enterpriseId) {
    filters.push(`enterprise_id=eq.${encodeURIComponent(scope.enterpriseId)}`)
    return 'ok'
  }
  if (scope.resellerId) {
    const rid = encodeURIComponent(scope.resellerId)
    if (scope.enterpriseIds?.length) {
      const list = scope.enterpriseIds.map((v) => encodeURIComponent(v)).join(',')
      filters.push(`or=(reseller_id.eq.${rid},enterprise_id.in.(${list}))`)
    } else {
      filters.push(`reseller_id=eq.${rid}`)
    }
    return 'ok'
  }
  return 'ok'
}

async function countSims(
  supabase: SupabaseClient,
  baseFilters: string[],
  status: string | null,
): Promise<number> {
  const filters = [...baseFilters]
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
  const qs = `select=sim_id&limit=1${filters.length ? `&${filters.join('&')}` : ''}`
  if (typeof supabase.selectWithCount === 'function') {
    const { total } = await supabase.selectWithCount('sims', qs)
    return typeof total === 'number' && Number.isFinite(total) ? total : 0
  }
  // Fallback for tests/mocks without selectWithCount: pull statuses and count (bounded).
  const selectQs = `select=status&limit=10000${filters.length ? `&${filters.join('&')}` : ''}`
  const rows = await supabase.select('sims', selectQs)
  const list = Array.isArray(rows) ? rows : []
  if (!status) return list.length
  return list.filter((r) => String((r as Record<string, unknown>).status ?? '') === status).length
}

/** Default window for visited-MCC SIM stats: current month and previous 5 months (6 calendar months). */
function defaultVisitedMccDateRange() {
  const now = new Date()
  const endDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const startDay = new Date(Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth() - 5, 1))
  return { startDay, endDay }
}

function resolveVisitedMccDateRange(
  query: Record<string, unknown>,
  sendError: RouteDeps['sendError'],
  reply: FastifyReply,
): { startDay: Date; endDay: Date } | null {
  const hasStart = query.startDate != null && String(query.startDate).trim() !== ''
  const hasEnd = query.endDate != null && String(query.endDate).trim() !== ''
  if (!hasStart && !hasEnd) return defaultVisitedMccDateRange()
  if (!hasStart || !hasEnd) {
    sendError(reply, 400, 'BAD_REQUEST', 'startDate and endDate must both be provided for visited-MCC window.')
    return null
  }
  const range = parseReportDateRange(query)
  if (!range) {
    sendError(
      reply,
      400,
      'BAD_REQUEST',
      'startDate and endDate must be valid YYYY-MM-DD dates, and startDate must be on or before endDate.',
    )
    return null
  }
  if (!enforceMaxReportMonths(range, reply, sendError)) return null
  return range
}

async function buildByEnterprise(
  supabase: SupabaseClient,
  simFilters: string[],
  scope: ReportScope,
): Promise<Array<{ enterpriseId: string | null; enterpriseName: string | null; count: number }>> {
  // Single-enterprise / customer views: skip breakdown (UI uses total/byStatus only).
  if (scope.enterpriseId) return []
  const rows = await supabase.select(
    'sims',
    `select=enterprise_id&limit=50000${simFilters.length ? `&${simFilters.join('&')}` : ''}`,
  )
  const counts = new Map<string | null, number>()
  for (const row of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
    const eid = row.enterprise_id != null && String(row.enterprise_id).trim() !== '' ? String(row.enterprise_id) : null
    counts.set(eid, (counts.get(eid) ?? 0) + 1)
  }
  const ids = [...counts.keys()].filter((id): id is string => !!id)
  const nameMap = await loadEnterpriseNameMap(supabase, ids)
  return [...counts.entries()]
    .map(([enterpriseId, count]) => ({
      enterpriseId,
      enterpriseName: enterpriseId ? nameMap.get(enterpriseId) ?? null : null,
      count,
    }))
    .sort((a, b) => b.count - a.count || String(a.enterpriseId).localeCompare(String(b.enterpriseId)))
}

/**
 * Distinct SIMs that generated usage in each **visited** MCC (from usage_daily_summary.visited_mccmnc).
 * Complete past calendar months prefer usage_monthly_summary; open/partial months use daily.
 * This is roaming/visit country MCC, not the SIM home operator MCC.
 */
async function buildByVisitedMcc(
  supabase: SupabaseClient,
  scope: ReportScope,
  startDay: Date,
  endDay: Date,
): Promise<Array<{ mcc: string; count: number }>> {
  const { monthlyPeriods, dailyRanges } = splitReportWindowForUsageSources(startDay, endDay)
  const sets = new Map<string, Set<string>>()

  const addRow = (row: Record<string, unknown>) => {
    const mcc = mccFromVisited(row.visited_mccmnc)
    if (!mcc) return
    const simKey = row.sim_id ? String(row.sim_id) : row.iccid ? String(row.iccid) : null
    if (!simKey) return
    let set = sets.get(mcc)
    if (!set) {
      set = new Set()
      sets.set(mcc, set)
    }
    set.add(simKey)
  }

  if (monthlyPeriods.length) {
    const monthStarts = monthlyPeriods.map((p) => periodToMonthStart(p))
    const filters = [`usage_month=in.(${monthStarts.map((d) => encodeURIComponent(d)).join(',')})`]
    let empty = false
    applyEnterpriseScope(filters, scope, () => {
      empty = true
    })
    if (!empty) {
      const rows = await supabase.select(
        'usage_monthly_summary',
        `select=sim_id,iccid,visited_mccmnc&${filters.join('&')}&limit=50000`,
        { suppressMissingColumns: true },
      )
      for (const row of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) addRow(row)
    }
  }

  for (const range of dailyRanges) {
    const start = range.startDay.toISOString().slice(0, 10)
    const end = range.endDay.toISOString().slice(0, 10)
    const filters = [`usage_day=gte.${encodeURIComponent(start)}`, `usage_day=lte.${encodeURIComponent(end)}`]
    let empty = false
    applyEnterpriseScope(filters, scope, () => {
      empty = true
    })
    if (empty) continue
    const rows = await supabase.select(
      'usage_daily_summary',
      `select=sim_id,iccid,visited_mccmnc&${filters.join('&')}&limit=50000`,
    )
    for (const row of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) addRow(row)
  }

  return [...sets.entries()]
    .map(([mcc, set]) => ({ mcc, count: set.size }))
    .sort((a, b) => b.count - a.count || a.mcc.localeCompare(b.mcc))
}

async function loadUsageTrendRowsHybrid(
  supabase: SupabaseClient,
  scope: ReportScope,
  startDay: Date,
  endDay: Date,
  granularity: 'day' | 'month',
  selectDaily: string,
  selectMonthly: string,
): Promise<{ rows: Record<string, unknown>[]; periodField: 'usage_day' | 'usage_month' }[]> {
  // Day granularity always reads daily facts.
  if (granularity === 'day') {
    const start = startDay.toISOString().slice(0, 10)
    const end = endDay.toISOString().slice(0, 10)
    const filters = [`usage_day=gte.${encodeURIComponent(start)}`, `usage_day=lte.${encodeURIComponent(end)}`]
    let empty = false
    applyEnterpriseScope(filters, scope, () => {
      empty = true
    })
    if (empty) return []
    const rows = await supabase.select(
      'usage_daily_summary',
      `select=${selectDaily}&${filters.join('&')}&order=usage_day.asc&limit=50000`,
    )
    return [{ rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [], periodField: 'usage_day' }]
  }

  const { monthlyPeriods, dailyRanges } = splitReportWindowForUsageSources(startDay, endDay)
  const out: { rows: Record<string, unknown>[]; periodField: 'usage_day' | 'usage_month' }[] = []

  if (monthlyPeriods.length) {
    const monthStarts = monthlyPeriods.map((p) => periodToMonthStart(p))
    const filters = [`usage_month=in.(${monthStarts.map((d) => encodeURIComponent(d)).join(',')})`]
    let empty = false
    applyEnterpriseScope(filters, scope, () => {
      empty = true
    })
    if (!empty) {
      const rows = await supabase.select(
        'usage_monthly_summary',
        `select=${selectMonthly}&${filters.join('&')}&order=usage_month.asc&limit=50000`,
        { suppressMissingColumns: true },
      )
      out.push({
        rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
        periodField: 'usage_month',
      })
    }
  }

  for (const range of dailyRanges) {
    const start = range.startDay.toISOString().slice(0, 10)
    const end = range.endDay.toISOString().slice(0, 10)
    const filters = [`usage_day=gte.${encodeURIComponent(start)}`, `usage_day=lte.${encodeURIComponent(end)}`]
    let empty = false
    applyEnterpriseScope(filters, scope, () => {
      empty = true
    })
    if (empty) continue
    const rows = await supabase.select(
      'usage_daily_summary',
      `select=${selectDaily}&${filters.join('&')}&order=usage_day.asc&limit=50000`,
    )
    out.push({
      rows: Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [],
      periodField: 'usage_day',
    })
  }
  return out
}

function trendPeriodKey(
  row: Record<string, unknown>,
  periodField: 'usage_day' | 'usage_month',
  granularity: 'day' | 'month',
): string | null {
  const raw = row[periodField] ? String(row[periodField]).slice(0, 10) : null
  if (!raw) return null
  if (granularity === 'month') return raw.slice(0, 7)
  return raw
}

export function registerReportRoutes({ app, prefix, deps }: { app: FastifyInstance; prefix: string; deps: RouteDeps }) {
  const resolveScope = async (req: FastifyRequest, reply: FastifyReply) => {
    const supabase = deps.createSupabaseRestClient({ useServiceRole: true, traceId: deps.getTraceId(reply) })
    const query = (req.query ?? {}) as Record<string, unknown>
    const enterpriseIdParam = query.enterpriseId ? String(query.enterpriseId) : null
    const resellerIdParam = query.resellerId ? String(query.resellerId) : null
    const scope = await resolveReportScope(req, reply, supabase, enterpriseIdParam, resellerIdParam, deps)
    if (!scope) return null
    return { supabase, query, scope }
  }

  const resolve = async (req: FastifyRequest, reply: FastifyReply) => {
    const scoped = await resolveScope(req, reply)
    if (!scoped) return null
    const dateRange = parseReportDateRange(scoped.query)
    if (!dateRange) {
      deps.sendError(
        reply,
        400,
        'BAD_REQUEST',
        'startDate and endDate must be valid YYYY-MM-DD dates, and startDate must be on or before endDate.',
      )
      return null
    }
    if (!enforceMaxReportMonths(dateRange, reply, deps.sendError)) return null
    return { ...scoped, dateRange }
  }

  app.get(`${prefix}/reports/sim-summary`, { preHandler: rbac(['reports.usage']) }, async (req, reply) => {
    const scoped = await resolveScope(req, reply)
    if (!scoped) return
    const visitedWindow = resolveVisitedMccDateRange(scoped.query, deps.sendError, reply)
    if (!visitedWindow) return
    const visitedStart = visitedWindow.startDay.toISOString().slice(0, 10)
    const visitedEnd = visitedWindow.endDay.toISOString().slice(0, 10)
    const emptyBody = {
      total: 0,
      byStatus: SIM_STATUSES.map((status) => ({ status, count: 0 })),
      byEnterprise: [] as Array<{ enterpriseId: string | null; enterpriseName: string | null; count: number }>,
      byVisitedMcc: [] as Array<{ mcc: string; count: number }>,
      visitedMccWindow: { startDate: visitedStart, endDate: visitedEnd },
    }
    const filters: string[] = []
    if (applySimScopeFilters(filters, scoped.scope) === 'empty') {
      return reply.send(emptyBody)
    }
    const total = await countSims(scoped.supabase, filters, null)
    const byStatus = []
    for (const status of SIM_STATUSES) {
      const count = await countSims(scoped.supabase, filters, status)
      byStatus.push({ status, count })
    }
    const byEnterprise = await buildByEnterprise(scoped.supabase, filters, scoped.scope)
    const byVisitedMcc = await buildByVisitedMcc(
      scoped.supabase,
      scoped.scope,
      visitedWindow.startDay,
      visitedWindow.endDay,
    )
    return reply.send({
      total,
      byStatus,
      byEnterprise,
      byVisitedMcc,
      visitedMccWindow: { startDate: visitedStart, endDate: visitedEnd },
    })
  })

  app.get(`${prefix}/reports/usage-trend`, { preHandler: rbac(['reports.usage']) }, async (req, reply) => {
    const ctx = await resolve(req, reply)
    if (!ctx) return
    const granularity = normalizeReportGranularity(ctx.query.granularity)
    const groupByRaw = ctx.query.groupBy
    const groupByParsed =
      groupByRaw === undefined || groupByRaw === null || String(groupByRaw).trim() === ''
        ? null
        : String(groupByRaw).trim().toLowerCase()
    if (groupByParsed && groupByParsed !== 'enterprise' && groupByParsed !== 'mcc') {
      return deps.sendError(reply, 400, 'BAD_REQUEST', 'groupBy must be enterprise or mcc when provided.')
    }
    const groupBy = groupByParsed as 'enterprise' | 'mcc' | null
    if (groupBy === 'enterprise') {
      const roleScope = deps.getRoleScope(req)
      if (roleScope === 'customer' || roleScope === 'department') {
        return deps.sendError(
          reply,
          403,
          'FORBIDDEN',
          'groupBy=enterprise is not available for enterprise/customer tokens.',
        )
      }
      if (ctx.scope.enterpriseId) {
        return deps.sendError(
          reply,
          400,
          'BAD_REQUEST',
          'groupBy=enterprise requires a reseller-wide or platform scope (omit enterpriseId).',
        )
      }
    }
    if (granularity === 'day' && daysInclusive(ctx.dateRange.startDay, ctx.dateRange.endDay) > 90) {
      return deps.sendError(reply, 400, 'BAD_REQUEST', 'granularity=day supports a maximum date range of 90 days.')
    }
    if (granularity === 'month' && monthsInclusive(ctx.dateRange.startDay, ctx.dateRange.endDay) > 36) {
      return deps.sendError(reply, 400, 'BAD_REQUEST', 'granularity=month supports a maximum date range of 36 months.')
    }
    const startDay = ctx.dateRange.startDay.toISOString().slice(0, 10)
    const endDay = ctx.dateRange.endDay.toISOString().slice(0, 10)
    const emptyPayload = {
      granularity,
      startDate: startDay,
      endDate: endDay,
      groupBy,
      items: [] as unknown[],
    }

    // Scope emptiness check (enterprise list may be empty for reseller with no children).
    {
      const probe: string[] = []
      const empty = applyEnterpriseScope(probe, ctx.scope, () => reply.send(emptyPayload))
      if (empty) return
    }

    if (!groupBy) {
      const batches = await loadUsageTrendRowsHybrid(
        ctx.supabase,
        ctx.scope,
        ctx.dateRange.startDay,
        ctx.dateRange.endDay,
        granularity,
        'usage_day,total_mb',
        'usage_month,total_mb',
      )
      const bucket = new Map<string, number>()
      for (const batch of batches) {
        for (const row of batch.rows) {
          const key = trendPeriodKey(row, batch.periodField, granularity)
          if (!key) continue
          bucket.set(key, (bucket.get(key) ?? 0) + Number(row.total_mb ?? 0))
        }
      }
      const items = [...bucket.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([period, totalMb]) => ({ period, totalMb: Number(totalMb.toFixed(2)) }))
      return reply.send({ granularity, startDate: startDay, endDate: endDay, groupBy: null, items })
    }

    if (groupBy === 'enterprise') {
      const batches = await loadUsageTrendRowsHybrid(
        ctx.supabase,
        ctx.scope,
        ctx.dateRange.startDay,
        ctx.dateRange.endDay,
        granularity,
        'usage_day,total_mb,enterprise_id',
        'usage_month,total_mb,enterprise_id',
      )
      const bucket = new Map<string, number>()
      const enterpriseIds = new Set<string>()
      for (const batch of batches) {
        for (const row of batch.rows) {
          const period = trendPeriodKey(row, batch.periodField, granularity)
          const enterpriseId = row.enterprise_id ? String(row.enterprise_id) : null
          if (!period || !enterpriseId) continue
          enterpriseIds.add(enterpriseId)
          const key = `${period}\0${enterpriseId}`
          bucket.set(key, (bucket.get(key) ?? 0) + Number(row.total_mb ?? 0))
        }
      }
      const nameMap = await loadEnterpriseNameMap(ctx.supabase, [...enterpriseIds])
      const items = [...bucket.entries()]
        .map(([key, totalMb]) => {
          const [period, groupKey] = key.split('\0')
          return {
            period,
            groupKey,
            groupLabel: nameMap.get(groupKey) ?? null,
            totalMb: Number(totalMb.toFixed(2)),
          }
        })
        .sort((a, b) => a.period.localeCompare(b.period) || a.groupKey.localeCompare(b.groupKey))
      return reply.send({ granularity, startDate: startDay, endDate: endDay, groupBy: 'enterprise', items })
    }

    // groupBy === 'mcc' — MCC derived from visited_mccmnc (first 3 digits)
    const batches = await loadUsageTrendRowsHybrid(
      ctx.supabase,
      ctx.scope,
      ctx.dateRange.startDay,
      ctx.dateRange.endDay,
      granularity,
      'usage_day,total_mb,visited_mccmnc',
      'usage_month,total_mb,visited_mccmnc',
    )
    const bucket = new Map<string, number>()
    for (const batch of batches) {
      for (const row of batch.rows) {
        const period = trendPeriodKey(row, batch.periodField, granularity)
        const mcc = mccFromVisited(row.visited_mccmnc)
        if (!period || !mcc) continue
        const key = `${period}\0${mcc}`
        bucket.set(key, (bucket.get(key) ?? 0) + Number(row.total_mb ?? 0))
      }
    }
    const items = [...bucket.entries()]
      .map(([key, totalMb]) => {
        const [period, groupKey] = key.split('\0')
        return {
          period,
          groupKey,
          groupLabel: groupKey,
          totalMb: Number(totalMb.toFixed(2)),
        }
      })
      .sort((a, b) => a.period.localeCompare(b.period) || a.groupKey.localeCompare(b.groupKey))
    return reply.send({ granularity, startDate: startDay, endDate: endDay, groupBy: 'mcc', items })
  })

  app.get(`${prefix}/reports/top-sims`, { preHandler: rbac(['reports.usage']) }, async (req, reply) => {
    const ctx = await resolve(req, reply)
    if (!ctx) return
    const { page, pageSize, offset } = parsePagination(ctx.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 50 })
    const startDay = ctx.dateRange.startDay.toISOString().slice(0, 10)
    const endDay = ctx.dateRange.endDay.toISOString().slice(0, 10)
    const filters = [`usage_day=gte.${encodeURIComponent(startDay)}`, `usage_day=lte.${encodeURIComponent(endDay)}`]
    const empty = applyEnterpriseScope(filters, ctx.scope, () =>
      reply.send({ startDate: startDay, endDate: endDay, items: [], total: 0, page, pageSize }),
    )
    if (empty) return
    const rows = await ctx.supabase.select('usage_daily_summary', `select=iccid,total_mb&${filters.join('&')}&limit=50000`)
    const totals = new Map<string, number>()
    for (const row of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
      if (!row.iccid) continue
      const iccid = String(row.iccid)
      totals.set(iccid, (totals.get(iccid) ?? 0) + Number(row.total_mb ?? 0))
    }
    const rankedItems = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([iccid, totalMb]) => ({ iccid, totalMb: Number(totalMb.toFixed(2)) }))
    const items = rankedItems.slice(offset, offset + pageSize)
    return reply.send({ startDate: startDay, endDate: endDay, items, total: rankedItems.length, page, pageSize })
  })

  app.get(`${prefix}/reports/anomaly-sims`, { preHandler: rbac(['reports.usage']) }, async (req, reply) => {
    const ctx = await resolve(req, reply)
    if (!ctx) return
    const { page, pageSize, offset } = parsePagination(ctx.query, { defaultPage: 1, defaultPageSize: 20, maxPageSize: 20 })
    const startIso = ctx.dateRange.startDay.toISOString()
    const endIso = new Date(ctx.dateRange.endDay.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString()
    const filters = [`window_start=gte.${encodeURIComponent(startIso)}`, `window_start=lte.${encodeURIComponent(endIso)}`]
    if (ctx.scope.enterpriseId) filters.push(`customer_id=eq.${encodeURIComponent(ctx.scope.enterpriseId)}`)
    else if (ctx.scope.resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(ctx.scope.resellerId)}`)
    const rows = await ctx.supabase.select(
      'alerts',
      `select=alert_id,alert_type,severity,status,sim_id,window_start,last_seen_at,created_at,sims(iccid)&order=window_start.desc&limit=1000&${filters.join('&')}`,
    )
    const map = new Map<string, Record<string, unknown> & { alertCount: number; lastSeenAt: string | null }>()
    for (const row of Array.isArray(rows) ? (rows as Record<string, any>[]) : []) {
      const simId = row.sim_id ? String(row.sim_id) : null
      if (!simId) continue
      const current = map.get(simId) ?? {
        iccid: row?.sims?.iccid ?? null,
        alertCount: 0,
        latestAlertType: null,
        latestSeverity: null,
        latestStatus: null,
        lastSeenAt: null,
      }
      current.alertCount += 1
      const lastSeen = row.last_seen_at ?? row.window_start ?? row.created_at ?? null
      if (!current.lastSeenAt || (lastSeen && new Date(lastSeen).getTime() > new Date(current.lastSeenAt).getTime())) {
        current.lastSeenAt = lastSeen ? new Date(lastSeen).toISOString() : current.lastSeenAt
        current.latestAlertType = row.alert_type ?? current.latestAlertType
        current.latestSeverity = row.severity ?? current.latestSeverity
        current.latestStatus = row.status ?? current.latestStatus
      }
      map.set(simId, current)
    }
    const rankedItems = [...map.values()].sort((a, b) => b.alertCount - a.alertCount)
    const items = rankedItems.slice(offset, offset + pageSize)
    return reply.send({
      startDate: ctx.dateRange.startDay.toISOString().slice(0, 10),
      endDate: ctx.dateRange.endDay.toISOString().slice(0, 10),
      items,
      total: rankedItems.length,
      page,
      pageSize,
    })
  })

  app.get(`${prefix}/reports/deactivation-reasons`, { preHandler: rbac(['reports.usage']) }, async (req, reply) => {
    const ctx = await resolve(req, reply)
    if (!ctx) return
    const startIso = ctx.dateRange.startDay.toISOString()
    const endIso = new Date(ctx.dateRange.endDay.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString()
    const enterpriseIds = ctx.scope.enterpriseId ? [ctx.scope.enterpriseId] : ctx.scope.enterpriseIds
    if (enterpriseIds && !enterpriseIds.length) {
      return reply.send({
        startDate: ctx.dateRange.startDay.toISOString().slice(0, 10),
        endDate: ctx.dateRange.endDay.toISOString().slice(0, 10),
        items: [],
      })
    }
    let sims: Record<string, unknown>[] = []
    if (enterpriseIds) {
      const list = enterpriseIds.map((v) => encodeURIComponent(v)).join(',')
      const rows = await ctx.supabase.select('sims', `select=sim_id,enterprise_id&enterprise_id=in.(${list})&limit=10000`)
      sims = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
    } else {
      const rows = await ctx.supabase.select('sims', 'select=sim_id,enterprise_id&limit=10000')
      sims = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
    }
    const simIds = sims.map((s) => s.sim_id).filter(Boolean).map(String)
    if (!simIds.length) {
      return reply.send({
        startDate: ctx.dateRange.startDay.toISOString().slice(0, 10),
        endDate: ctx.dateRange.endDay.toISOString().slice(0, 10),
        items: [],
      })
    }
    const reasonCounts = new Map<string, number>()
    for (const chunk of chunkArray(simIds, 200)) {
      const list = chunk.map((v) => encodeURIComponent(v)).join(',')
      const rows = await ctx.supabase.select(
        'sim_state_history',
        `select=source,sim_id,start_time&after_status=eq.DEACTIVATED&sim_id=in.(${list})&start_time=gte.${encodeURIComponent(startIso)}&start_time=lte.${encodeURIComponent(endIso)}&limit=1000`,
      )
      for (const row of Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []) {
        const source = row.source ? String(row.source) : 'UNKNOWN'
        reasonCounts.set(source, (reasonCounts.get(source) ?? 0) + 1)
      }
    }
    const items = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }))
    return reply.send({
      startDate: ctx.dateRange.startDay.toISOString().slice(0, 10),
      endDate: ctx.dateRange.endDay.toISOString().slice(0, 10),
      items,
    })
  })
}
