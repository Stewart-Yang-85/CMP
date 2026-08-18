import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { rbac, getAuthContext, checkPermissions } from '../middleware/rbac.js'
import { buildPaginationResponse, parsePagination } from '../utils/pagination.js'
import { transitionBillStatus } from '../services/billStatusMachine.js'
import { createAdjustmentNote } from '../services/adjustmentNote.js'
import { voidBill } from '../services/billVoid.js'
import {
  readOptionalQueryUuid,
  validateResellerTenant,
  type ScopeError,
} from '../services/billingGenerateScope.js'
import { parseOptionalIdempotencyKey } from '../utils/idempotencyKeyInput.js'
import { parseMarkPaidPaidAmount } from '../utils/markPaidInput.js'

const DEFAULT_BILL_LIST_PAGE_SIZE = 50
const MAX_BILL_LIST_PAGE_SIZE = 100
const DEFAULT_BILL_CSV_PAGE_SIZE = 100
const MAX_BILL_CSV_PAGE_SIZE = 1000
const DEFAULT_BILL_LOOKBACK_MONTHS = 12
const DEFAULT_BILL_LINE_ITEMS_PAGE_SIZE = 100
const MAX_BILL_LINE_ITEMS_PAGE_SIZE = 200
const MAX_BILL_LINE_ITEMS_CSV_PAGE_SIZE = 10000

/** Minimal supabase client for bill scope checks (compatible with app.ts and route deps). */
type BillScopeSupabase = {
  select: (table: string, queryString: string) => Promise<unknown>
}

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<{ data: unknown; total: number | null }>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type RouteDeps = {
  createSupabaseRestClient: (options?: { useServiceRole?: boolean; traceId?: string | null }) => SupabaseClient
  getTraceId: (reply: FastifyReply) => string | null
  sendError: (reply: FastifyReply, status: number, code: string, message: string) => void
  getEnterpriseIdFromReq: (req: FastifyRequest) => string | null
  getRoleScope: (req: FastifyRequest) => string | null
  isValidUuid: (value: unknown) => boolean
}

function escapeCsv(value: unknown) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function applyScopeError(reply: FastifyReply, sendError: RouteDeps['sendError'], result: ScopeError) {
  sendError(reply, result.status, result.code, result.message)
}

const SORT_BY_MAP: Record<string, string> = {
  period: 'period_start',
  dueDate: 'due_date',
  totalAmount: 'total_amount',
  status: 'status',
}

function setXFilters(reply: FastifyReply, value: string) {
  reply.header('X-Filters', value)
}

function isMissingColumnError(err: unknown, column: string) {
  const body = String((err as any)?.body || (err as any)?.message || '')
  return body.includes('does not exist') && body.includes(column)
}

function toDateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

function periodFilters(period: string | null): string[] {
  if (!period) return []
  const m = period.match(/^(\d{4})-(\d{2})$/)
  if (!m) return []
  const y = Number(m[1])
  const mm = Number(m[2])
  const monthStart = `${m[1]}-${m[2]}-01`
  const nextMonth = mm === 12 ? `${y + 1}-01-01` : `${m[1]}-${String(mm + 1).padStart(2, '0')}-01`
  return [
    `period_start=gte.${encodeURIComponent(monthStart)}`,
    `period_start=lt.${encodeURIComponent(nextMonth)}`,
  ]
}

/** When `period` is omitted: last N completed UTC months (excludes current month). */
export function defaultLookbackPeriodFilters(
  months: number = DEFAULT_BILL_LOOKBACK_MONTHS,
  now: Date = new Date()
): string[] {
  const endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1))
  return [
    `period_start=gte.${encodeURIComponent(toDateOnly(start))}`,
    `period_start=lt.${encodeURIComponent(toDateOnly(endExclusive))}`,
  ]
}

function resolveBillListPagination(
  query: Record<string, unknown>,
  mode: 'list' | 'csv' = 'list'
) {
  const pageRaw = query.page as string | number | null | undefined
  const pageSizeRaw = query.pageSize as string | number | null | undefined
  return parsePagination(
    { page: pageRaw, pageSize: pageSizeRaw },
    {
      defaultPage: 1,
      defaultPageSize: mode === 'csv' ? DEFAULT_BILL_CSV_PAGE_SIZE : DEFAULT_BILL_LIST_PAGE_SIZE,
      maxPageSize: mode === 'csv' ? MAX_BILL_CSV_PAGE_SIZE : MAX_BILL_LIST_PAGE_SIZE,
    }
  )
}

function billPeriodFilters(period: string | null): string[] {
  if (period) return periodFilters(period)
  return defaultLookbackPeriodFilters()
}

function resolveBillSort(sortByRaw: string | null, sortOrderRaw: string | null) {
  const sortBy = sortByRaw && SORT_BY_MAP[sortByRaw] ? SORT_BY_MAP[sortByRaw] : 'period_start'
  const sortOrder = sortOrderRaw === 'asc' || sortOrderRaw === 'desc' ? sortOrderRaw : 'desc'
  return { sortBy, sortOrder }
}

function billReadPreHandler() {
  return async function billReadGuard(req: FastifyRequest, reply: FastifyReply) {
    const auth = getAuthContext(req)
    if (!auth || (!auth.userId && !auth.role && !auth.roleScope)) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' })
      return
    }
    const roleScope = auth.roleScope ? String(auth.roleScope) : null
    const role = auth.role ? String(auth.role) : null
    if (roleScope === 'platform' || role === 'platform_admin') return
    if (role === 'customer_m2m' && auth.customerId) return
    if (!(await checkPermissions(auth, ['bills.read']))) {
      reply.status(403).send({ code: 'FORBIDDEN', message: 'Insufficient permissions.' })
    }
  }
}

function isCustomerBillToken(roleScope: string | null, role: string | null) {
  return roleScope === 'customer' || roleScope === 'department' || role === 'customer_m2m'
}

/** Blocks customer / department / customer_m2m tokens from bill mutation endpoints. */
function billMutationPreHandler(requiredPermissions: string[]) {
  return async function billMutationGuard(req: FastifyRequest, reply: FastifyReply) {
    const auth = getAuthContext(req)
    if (!auth || (!auth.userId && !auth.role && !auth.roleScope)) {
      reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' })
      return
    }
    const roleScope = auth.roleScope ? String(auth.roleScope) : null
    const role = auth.role ? String(auth.role) : null
    if (isCustomerBillToken(roleScope, role)) {
      reply.status(403).send({ code: 'FORBIDDEN', message: 'Customer tokens are not permitted for this bill operation.' })
      return
    }
    if (roleScope === 'platform' || role === 'platform_admin') return
    if (!(await checkPermissions(auth, requiredPermissions))) {
      reply.status(403).send({ code: 'FORBIDDEN', message: 'Insufficient permissions.' })
    }
  }
}

const BILL_SELECT_COLUMNS =
  'bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date,reseller_id,created_at,generated_at,overdue_at,published_at,paid_at,paid_amount,payment_ref,payment_proof,written_off_at,write_off_reason,voided_at,void_reason'

function mapBillLifecycleFields(bill: Record<string, unknown>) {
  return {
    dueDate: bill.due_date ?? bill.dueDate ?? null,
    createdAt: bill.created_at ?? bill.createdAt ?? null,
    generatedAt: bill.generated_at ?? bill.generatedAt ?? null,
    overdueAt: bill.overdue_at ?? bill.overdueAt ?? null,
    publishedAt: bill.published_at ?? bill.publishedAt ?? null,
    paidAt: bill.paid_at ?? bill.paidAt ?? null,
    paidAmount: bill.paid_amount != null ? Number(bill.paid_amount) : bill.paidAmount != null ? Number(bill.paidAmount) : null,
    paymentRef: bill.payment_ref ?? bill.paymentRef ?? null,
    paymentProof: bill.payment_proof ?? bill.paymentProof ?? null,
    writtenOffAt: bill.written_off_at ?? bill.writtenOffAt ?? null,
    writeOffReason: bill.write_off_reason ?? bill.writeOffReason ?? null,
    voidedAt: bill.voided_at ?? bill.voidedAt ?? null,
    voidReason: bill.void_reason ?? bill.voidReason ?? null,
  }
}

/**
 * Load a bill row after platform / reseller / customer tenant scope checks.
 * Returns null when an error response was sent.
 */
export async function loadBillForRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  sendError: RouteDeps['sendError'],
  supabase: BillScopeSupabase,
  billId: string,
  getRoleScope: RouteDeps['getRoleScope'],
  getEnterpriseIdFromReq: RouteDeps['getEnterpriseIdFromReq']
): Promise<Record<string, unknown> | null> {
  const auth = getAuthContext(req)
  const roleScope = getRoleScope(req)
  const role = auth.role ? String(auth.role) : null

  const rows = await supabase.select(
    'bills',
    `select=${BILL_SELECT_COLUMNS}&bill_id=eq.${encodeURIComponent(billId)}&limit=1`
  )
  const bill = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  if (!bill) {
    sendError(reply, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
    return null
  }

  if (roleScope === 'platform' || role === 'platform_admin') {
    return bill
  }

  if (roleScope === 'customer' || roleScope === 'department' || role === 'customer_m2m') {
    const enterpriseId = getEnterpriseIdFromReq(req) ?? (auth.customerId ? String(auth.customerId) : null)
    if (!enterpriseId || String(bill.enterprise_id ?? '') !== String(enterpriseId)) {
      sendError(reply, 404, 'RESOURCE_NOT_FOUND', `Bill ${billId} not found.`)
      return null
    }
    return bill
  }

  if (roleScope === 'reseller') {
    if (!auth.resellerId) {
      sendError(reply, 403, 'FORBIDDEN', 'Reseller scope required.')
      return null
    }
    const entRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(String(bill.enterprise_id))}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const ent = Array.isArray(entRows) ? (entRows[0] as { parent_id?: string | null } | undefined) : undefined
    if (!ent || String(ent.parent_id || '') !== String(auth.resellerId)) {
      sendError(reply, 403, 'FORBIDDEN', 'Bill is out of reseller scope.')
      return null
    }
    return bill
  }

  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

async function loadBillLineItems(supabase: SupabaseClient, billId: string) {
  try {
    return await supabase.select(
      'bill_line_items',
      `select=line_item_id,item_type,amount,metadata,group_key,group_type&bill_id=eq.${encodeURIComponent(billId)}&order=line_item_id.asc`,
      { suppressMissingColumns: true }
    )
  } catch (err) {
    if (isMissingColumnError(err, 'group_key') || isMissingColumnError(err, 'group_type')) {
      return await supabase.select(
        'bill_line_items',
        `select=line_item_id,item_type,amount,metadata&bill_id=eq.${encodeURIComponent(billId)}&order=line_item_id.asc`
      )
    }
    throw err
  }
}

export function buildBillDetail({
  bill,
  lineItems,
}: {
  bill: Record<string, unknown>
  lineItems: Record<string, unknown>[]
}) {
  const simItems = lineItems.filter((it) => String(it.item_type || '') === 'SIM_TOTAL')
  let adjustmentCreditTotal = 0
  let adjustmentDebitTotal = 0
  for (const item of lineItems) {
    const itemType = String(item.item_type || '')
    const amount = Number(item.amount ?? 0)
    if (itemType === 'ADJUSTMENT_CREDIT') adjustmentCreditTotal += amount
    if (itemType === 'ADJUSTMENT_DEBIT') adjustmentDebitTotal += amount
  }
  const l1Summary = {
    monthlyFeeTotal: 0,
    usageChargeTotal: 0,
    overageChargeTotal: 0,
    adjustmentCreditTotal: Number(adjustmentCreditTotal.toFixed(2)),
    adjustmentDebitTotal: Number(adjustmentDebitTotal.toFixed(2)),
  }
  const groupMap = new Map<string, { groupKey: unknown; groupType: unknown; groupName: unknown; subtotal: number }>()
  for (const item of simItems) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>
    l1Summary.monthlyFeeTotal += Number(meta.monthlyFee ?? 0)
    l1Summary.usageChargeTotal += Number(meta.usageCharge ?? 0)
    l1Summary.overageChargeTotal += Number(meta.overageCharge ?? 0)
    const groupKey = item.group_key ?? meta.departmentId ?? meta.packageVersionId ?? null
    const groupType =
      item.group_type ?? (meta.departmentId ? 'DEPARTMENT' : meta.packageVersionId ? 'PACKAGE' : null)
    const groupName = meta.departmentName ?? meta.packageName ?? null
    const groupId = `${groupType || 'UNKNOWN'}:${groupKey || 'NONE'}`
    const subtotal = Number(item.amount ?? 0)
    const current = groupMap.get(groupId) || { groupKey, groupType, groupName, subtotal: 0 }
    current.subtotal += subtotal
    groupMap.set(groupId, current)
  }
  const l2Groups = Array.from(groupMap.values()).map((g) => ({
    groupKey: g.groupKey,
    groupType: g.groupType,
    groupName: g.groupName,
    subtotal: Number(g.subtotal.toFixed(2)),
  }))
  const billId = bill.bill_id ?? bill.billId
  const lifecycle = mapBillLifecycleFields(bill)
  return {
    billId,
    period: String(bill.period_start ?? bill.period ?? '').slice(0, 7),
    status: bill.status,
    ...lifecycle,
    currency: bill.currency,
    totalAmount: Number(bill.total_amount ?? bill.totalAmount ?? 0),
    enterpriseId: bill.enterprise_id ?? bill.enterpriseId ?? null,
    l1Summary: {
      monthlyFeeTotal: Number(l1Summary.monthlyFeeTotal.toFixed(2)),
      usageChargeTotal: Number(l1Summary.usageChargeTotal.toFixed(2)),
      overageChargeTotal: Number(l1Summary.overageChargeTotal.toFixed(2)),
      adjustmentCreditTotal: l1Summary.adjustmentCreditTotal,
      adjustmentDebitTotal: l1Summary.adjustmentDebitTotal,
    },
    l2Groups,
  }
}

export function buildBillDetailCsv(detail: ReturnType<typeof buildBillDetail>) {
  const rows: string[][] = [['section', 'name', 'count', 'amount', 'text']]
  const pushField = (section: string, name: string, value: unknown) => {
    rows.push([section, name, '', value === null || value === undefined ? '' : String(value), ''])
  }
  pushField('bill', 'billId', detail.billId)
  pushField('bill', 'enterpriseId', detail.enterpriseId)
  pushField('bill', 'period', detail.period)
  pushField('bill', 'status', detail.status)
  pushField('bill', 'currency', detail.currency)
  pushField('bill', 'totalAmount', detail.totalAmount)
  pushField('bill', 'dueDate', detail.dueDate)
  pushField('bill', 'createdAt', detail.createdAt)
  pushField('bill', 'generatedAt', detail.generatedAt)
  pushField('bill', 'overdueAt', detail.overdueAt)
  pushField('bill', 'publishedAt', detail.publishedAt)
  pushField('bill', 'paidAt', detail.paidAt)
  pushField('bill', 'paidAmount', detail.paidAmount)
  pushField('bill', 'paymentRef', detail.paymentRef)
  pushField('bill', 'paymentProof', detail.paymentProof)
  pushField('bill', 'writtenOffAt', detail.writtenOffAt)
  pushField('bill', 'writeOffReason', detail.writeOffReason)
  pushField('bill', 'voidedAt', detail.voidedAt)
  pushField('bill', 'voidReason', detail.voidReason)
  pushField('l1', 'monthlyFeeTotal', detail.l1Summary.monthlyFeeTotal)
  pushField('l1', 'usageChargeTotal', detail.l1Summary.usageChargeTotal)
  pushField('l1', 'overageChargeTotal', detail.l1Summary.overageChargeTotal)
  pushField('l1', 'adjustmentCreditTotal', detail.l1Summary.adjustmentCreditTotal ?? 0)
  pushField('l1', 'adjustmentDebitTotal', detail.l1Summary.adjustmentDebitTotal ?? 0)
  for (const group of detail.l2Groups) {
    rows.push([
      'l2',
      group.groupKey === null || group.groupKey === undefined ? '' : String(group.groupKey),
      group.groupType === null || group.groupType === undefined ? '' : String(group.groupType),
      String(group.subtotal),
      group.groupName === null || group.groupName === undefined ? '' : String(group.groupName),
    ])
  }
  return `${rows.map((row) => row.map(escapeCsv).join(',')).join('\n')}\n`
}

async function loadBillLineItemsWithCount(
  supabase: SupabaseClient,
  billId: string,
  filters: string[],
  pageSize: number,
  offset: number
) {
  const base = `bill_id=eq.${encodeURIComponent(billId)}`
  const queryFilters = [base, ...filters]
  const query = `select=line_item_id,item_type,amount,metadata,group_key,group_type&${queryFilters.join('&')}&order=line_item_id.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
  try {
    return await supabase.selectWithCount('bill_line_items', query)
  } catch (err) {
    if (isMissingColumnError(err, 'group_key') || isMissingColumnError(err, 'group_type')) {
      const fallback = `select=line_item_id,item_type,amount,metadata&${queryFilters.join('&')}&order=line_item_id.asc&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
      return await supabase.selectWithCount('bill_line_items', fallback)
    }
    throw err
  }
}

function mapBillLineItem(item: Record<string, unknown>) {
  const meta = (item.metadata ?? {}) as Record<string, unknown>
  return {
    lineItemId: item.line_item_id,
    iccid: meta.iccid ?? null,
    msisdn: meta.msisdn ?? null,
    departmentName: meta.departmentName ?? null,
    packageName: meta.packageName ?? null,
    monthlyFee: meta.monthlyFee ?? 0,
    usageCharge: meta.usageCharge ?? 0,
    overageCharge: meta.overageCharge ?? 0,
    subtotal: meta.subtotal ?? Number(item.amount ?? 0),
    usageMb: meta.usageMb ?? 0,
    groupKey: item.group_key ?? null,
    groupType: item.group_type ?? null,
  }
}

const LINE_ITEM_CSV_HEADER = [
  'lineItemId',
  'iccid',
  'msisdn',
  'departmentName',
  'packageName',
  'monthlyFee',
  'usageCharge',
  'overageCharge',
  'subtotal',
  'usageMb',
  'groupKey',
  'groupType',
]

function buildLineItemsCsv(items: ReturnType<typeof mapBillLineItem>[]) {
  const lines = [LINE_ITEM_CSV_HEADER.join(',')]
  for (const item of items) {
    lines.push(
      [
        item.lineItemId,
        item.iccid,
        item.msisdn,
        item.departmentName,
        item.packageName,
        item.monthlyFee,
        item.usageCharge,
        item.overageCharge,
        item.subtotal,
        item.usageMb,
        item.groupKey,
        item.groupType,
      ]
        .map(escapeCsv)
        .join(',')
    )
  }
  return `${lines.join('\n')}\n`
}

function sendBillCsv(reply: FastifyReply, billId: string, filename: string, csv: string, xFilters: string) {
  reply.header('Content-Type', 'text/csv; charset=utf-8')
  reply.header('Content-Disposition', `attachment; filename="${filename}"`)
  reply.header('X-Filters', xFilters)
  return reply.send(csv)
}

function mapBillListItem(b: Record<string, unknown>, includeResellerId: boolean) {
  return {
    billId: b.bill_id,
    period: String(b.period_start).slice(0, 7),
    status: b.status,
    dueDate: b.due_date,
    currency: b.currency,
    totalAmount: Number(b.total_amount),
    enterpriseId: b.enterprise_id,
    ...(includeResellerId ? { resellerId: b.reseller_id ?? null } : {}),
  }
}

async function enterpriseIdsUnderReseller(
  supabase: SupabaseClient,
  resellerId: string
): Promise<{ customerIds: string[]; empty: boolean }> {
  const tenantRows = await supabase.select(
    'tenants',
    `select=tenant_id&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`
  )
  const customerIds = Array.isArray(tenantRows)
    ? tenantRows.map((r) => (r as { tenant_id?: string })?.tenant_id).filter(Boolean).map((v) => encodeURIComponent(String(v)))
    : []
  return { customerIds, empty: customerIds.length === 0 }
}

async function filtersForResellerTenant(
  supabase: SupabaseClient,
  resellerTenantId: string
): Promise<{ filters: string[]; empty?: boolean }> {
  const { customerIds, empty } = await enterpriseIdsUnderReseller(supabase, resellerTenantId)
  if (empty) {
    return { filters: [`reseller_id=eq.${encodeURIComponent(resellerTenantId)}`], empty: true }
  }
  return { filters: [`enterprise_id=in.(${customerIds.join(',')})`] }
}

async function resolveBillListResellerScope(
  supabase: SupabaseClient,
  req: FastifyRequest,
  reply: FastifyReply,
  sendError: RouteDeps['sendError'],
  getRoleScope: RouteDeps['getRoleScope'],
  isValidUuid: RouteDeps['isValidUuid'],
  resellerIdRaw: string | null
): Promise<string | null | undefined> {
  const roleScope = getRoleScope(req)
  const auth = getAuthContext(req)

  if (roleScope === 'reseller') {
    const tokenResellerId = auth.resellerId ? String(auth.resellerId) : null
    if (!tokenResellerId) {
      sendError(reply, 403, 'FORBIDDEN', 'Reseller scope required.')
      return undefined
    }
    const scopedId = resellerIdRaw ?? tokenResellerId
    if (resellerIdRaw && !isValidUuid(resellerIdRaw)) {
      sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      return undefined
    }
    if (resellerIdRaw && resellerIdRaw !== tokenResellerId) {
      sendError(reply, 403, 'FORBIDDEN', 'resellerId does not match token.')
      return undefined
    }
    const check = await validateResellerTenant(supabase, scopedId)
    if (!check.ok) {
      applyScopeError(reply, sendError, check)
      return undefined
    }
    return check.value
  }

  if (roleScope === 'platform') {
    if (!resellerIdRaw) return null
    if (!isValidUuid(resellerIdRaw)) {
      sendError(reply, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      return undefined
    }
    const check = await validateResellerTenant(supabase, resellerIdRaw)
    if (!check.ok) {
      applyScopeError(reply, sendError, check)
      return undefined
    }
    return check.value
  }

  sendError(reply, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return undefined
}

type BillListQueryResult = {
  rows: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
  filterPairs: string[]
  includeResellerId: boolean
}

async function runBillListQuery(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<RouteDeps, 'createSupabaseRestClient' | 'getTraceId' | 'sendError' | 'getEnterpriseIdFromReq' | 'getRoleScope' | 'isValidUuid'>,
  paginationMode: 'list' | 'csv' = 'list'
): Promise<BillListQueryResult | undefined> {
  const { createSupabaseRestClient, getTraceId, sendError, getEnterpriseIdFromReq, getRoleScope, isValidUuid } = deps
  const auth = getAuthContext(req)
  if (auth.role === 'customer_m2m') {
    sendError(reply, 403, 'FORBIDDEN', 'Customer API keys are not permitted to list bills.')
    return undefined
  }

  const query = (req.query ?? {}) as Record<string, unknown>
  const period = query.period ? String(query.period) : null
  const status = query.status ? String(query.status) : null
  const sortByRaw = query.sortBy ? String(query.sortBy) : null
  const sortOrderRaw = query.sortOrder ? String(query.sortOrder) : null
  const { page, pageSize, offset } = resolveBillListPagination(query, paginationMode)
  const { sortBy, sortOrder } = resolveBillSort(sortByRaw, sortOrderRaw)

  const enterpriseId = getEnterpriseIdFromReq(req)
  const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })

  const filterPairs: string[] = []
  if (period) filterPairs.push(`period=${period}`)
  else filterPairs.push(`lookbackMonths=${DEFAULT_BILL_LOOKBACK_MONTHS}`)
  if (status) filterPairs.push(`status=${status}`)
  if (sortByRaw) filterPairs.push(`sortBy=${sortByRaw}`)
  if (sortOrderRaw) filterPairs.push(`sortOrder=${sortOrderRaw}`)
  filterPairs.push(`page=${page}`, `pageSize=${pageSize}`)

  if (enterpriseId) {
    const filters = [`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`]
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    filters.push(...billPeriodFilters(period))
    const qs = `select=bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date&${filters.join('&')}&order=${sortBy}.${sortOrder}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
    const { data, total } = await supabase.selectWithCount('bills', qs)
    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
    return {
      rows,
      total: typeof total === 'number' ? total : rows.length,
      page,
      pageSize,
      filterPairs,
      includeResellerId: false,
    }
  }

  const resellerIdRaw = readOptionalQueryUuid(query, 'resellerId')
  const scopedResellerId = await resolveBillListResellerScope(
    supabase,
    req,
    reply,
    sendError,
    getRoleScope,
    isValidUuid,
    resellerIdRaw
  )
  if (scopedResellerId === undefined) return undefined

  if (scopedResellerId) filterPairs.push(`resellerId=${scopedResellerId}`)

  const scoped = scopedResellerId
    ? await filtersForResellerTenant(supabase, scopedResellerId)
    : { filters: [] as string[] }
  if (scoped.empty) {
    return { rows: [], total: 0, page, pageSize, filterPairs, includeResellerId: true }
  }

  const filters = [...scoped.filters]
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
  filters.push(...billPeriodFilters(period))
  const qs = `select=bill_id,enterprise_id,period_start,period_end,status,currency,total_amount,due_date,reseller_id&${filters.join('&')}&order=${sortBy}.${sortOrder}&limit=${encodeURIComponent(String(pageSize))}&offset=${encodeURIComponent(String(offset))}`
  const { data, total } = await supabase.selectWithCount('bills', qs)
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
  return {
    rows,
    total: typeof total === 'number' ? total : rows.length,
    page,
    pageSize,
    filterPairs,
    includeResellerId: true,
  }
}

function buildBillsListCsv(items: ReturnType<typeof mapBillListItem>[], includeResellerId: boolean) {
  const headers = includeResellerId
    ? ['billId', 'period', 'status', 'dueDate', 'currency', 'totalAmount', 'enterpriseId', 'resellerId']
    : ['billId', 'period', 'status', 'dueDate', 'currency', 'totalAmount', 'enterpriseId']
  const lines = [headers.join(',')]
  for (const item of items) {
    const row = includeResellerId
      ? [
          item.billId,
          item.period,
          item.status,
          item.dueDate,
          item.currency,
          item.totalAmount,
          item.enterpriseId,
          item.resellerId ?? '',
        ]
      : [item.billId, item.period, item.status, item.dueDate, item.currency, item.totalAmount, item.enterpriseId]
    lines.push(row.map(escapeCsv).join(','))
  }
  return `${lines.join('\n')}\n`
}

export function registerBillRoutes({
  app,
  prefix,
  deps,
}: {
  app: FastifyInstance
  prefix: string
  deps: RouteDeps
}) {
  const { createSupabaseRestClient, getTraceId, sendError, getEnterpriseIdFromReq, getRoleScope, isValidUuid } = deps
  const readGuard = billReadPreHandler()
  const publishGuard = billMutationPreHandler(['bills.read'])
  const markPaidGuard = billMutationPreHandler(['bills.mark_paid'])
  const writeOffGuard = billMutationPreHandler(['bills.read'])
  const voidGuard = billMutationPreHandler(['bills.void'])
  const adjustGuard = billMutationPreHandler(['bills.adjust'])

  app.get(
    `${prefix}/bills`,
    { preHandler: rbac(['bills.list']) },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const result = await runBillListQuery(req, reply, {
        createSupabaseRestClient,
        getTraceId,
        sendError,
        getEnterpriseIdFromReq,
        getRoleScope,
        isValidUuid,
      })
      if (!result) return
      const items = result.rows.map((b) => mapBillListItem(b, result.includeResellerId))
      setXFilters(reply, result.filterPairs.join(';'))
      return reply.send(buildPaginationResponse(items, result.total, result.page, result.pageSize))
    }
  )

  app.get(
    `${prefix}/bills/csv`,
    { preHandler: rbac(['bills.list']) },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const result = await runBillListQuery(
        req,
        reply,
        {
          createSupabaseRestClient,
          getTraceId,
          sendError,
          getEnterpriseIdFromReq,
          getRoleScope,
          isValidUuid,
        },
        'csv'
      )
      if (!result) return
      const items = result.rows.map((b) => mapBillListItem(b, result.includeResellerId))
      const csv = buildBillsListCsv(items, result.includeResellerId)
      return sendBillCsv(reply, 'list', 'bills.csv', csv, result.filterPairs.join(';'))
    }
  )

  app.get(
    `${prefix}/bills/:billId`,
    { preHandler: readGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return
      const lineItemsRaw = await loadBillLineItems(supabase, billId)
      const lineItems = Array.isArray(lineItemsRaw) ? (lineItemsRaw as Record<string, unknown>[]) : []
      return reply.send(buildBillDetail({ bill, lineItems }))
    }
  )

  app.get(
    `${prefix}/bills/:billId/csv`,
    { preHandler: readGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return
      const lineItemsRaw = await loadBillLineItems(supabase, billId)
      const lineItems = Array.isArray(lineItemsRaw) ? (lineItemsRaw as Record<string, unknown>[]) : []
      const detail = buildBillDetail({ bill, lineItems })
      const csv = buildBillDetailCsv(detail)
      return sendBillCsv(reply, billId, `bill-${billId}-summary.csv`, csv, `billId=${billId}`)
    }
  )

  app.get(
    `${prefix}/bills/:billId/line-items`,
    { preHandler: readGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const query = (req.query ?? {}) as Record<string, unknown>
      const { page, pageSize, offset } = parsePagination(
        { page: query.page as string | number | null | undefined, pageSize: query.pageSize as string | number | null | undefined },
        {
          defaultPage: 1,
          defaultPageSize: DEFAULT_BILL_LINE_ITEMS_PAGE_SIZE,
          maxPageSize: MAX_BILL_LINE_ITEMS_PAGE_SIZE,
        }
      )
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return

      const result = await loadBillLineItemsWithCount(supabase, billId, ['item_type=eq.SIM_TOTAL'], pageSize, offset)
      const rows = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : []
      const items = rows.map(mapBillLineItem)
      setXFilters(reply, `billId=${billId};page=${page};pageSize=${pageSize}`)
      return reply.send({
        items,
        total: typeof result.total === 'number' ? result.total : items.length,
        page,
        pageSize,
      })
    }
  )

  app.get(
    `${prefix}/bills/:billId/line-items/csv`,
    { preHandler: readGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const query = (req.query ?? {}) as Record<string, unknown>
      const { page, pageSize, offset } = parsePagination(
        { page: query.page as string | number | null | undefined, pageSize: query.pageSize as string | number | null | undefined },
        {
          defaultPage: 1,
          defaultPageSize: MAX_BILL_LINE_ITEMS_CSV_PAGE_SIZE,
          maxPageSize: MAX_BILL_LINE_ITEMS_CSV_PAGE_SIZE,
        }
      )
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return

      const result = await loadBillLineItemsWithCount(supabase, billId, ['item_type=eq.SIM_TOTAL'], pageSize, offset)
      const rows = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : []
      const items = rows.map(mapBillLineItem)
      const csv = buildLineItemsCsv(items)
      return sendBillCsv(
        reply,
        billId,
        `bill-${billId}-line-items.csv`,
        csv,
        `billId=${billId};page=${page};pageSize=${pageSize}`
      )
    }
  )

  app.post(
    `${prefix}/bills/:billId/publish`,
    { preHandler: publishGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const body = (req.body ?? {}) as Record<string, unknown>
      const dueDateRaw = body.dueDate != null && String(body.dueDate).trim() !== '' ? String(body.dueDate).trim() : null
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return
      const auth = getAuthContext(req)
      const result = await transitionBillStatus({
        supabase,
        billId,
        action: 'publish',
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(reply),
        dueDate: dueDateRaw,
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      const v = result.value
      return reply.send({
        billId: v.bill_id ?? v.billId ?? billId,
        status: v.status ?? null,
        publishedAt: v.published_at ?? null,
        dueDate: v.due_date ?? null,
      })
    }
  )

  app.post(
    `${prefix}/bills/:billId/mark-paid`,
    { preHandler: markPaidGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const body = (req.body ?? {}) as Record<string, unknown>
      const paymentRef = body.paymentRef != null ? String(body.paymentRef).trim() : ''
      const paymentProof =
        body.paymentProof != null && String(body.paymentProof).trim() !== '' ? String(body.paymentProof).trim() : null
      const paidAt = body.paidAt != null && String(body.paidAt).trim() !== '' ? String(body.paidAt) : null
      const paidAmountParsed = parseMarkPaidPaidAmount(body.paidAmount)
      if (!paidAmountParsed.ok) {
        return sendError(reply, 400, 'BAD_REQUEST', paidAmountParsed.message)
      }
      const paidAmount = paidAmountParsed.value
      if (!paymentRef) {
        return sendError(reply, 400, 'BAD_REQUEST', 'paymentRef is required.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return
      const auth = getAuthContext(req)
      const result = await transitionBillStatus({
        supabase,
        billId,
        action: 'pay',
        paymentRef,
        paymentProof,
        paidAt,
        paidAmount,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(reply),
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      const v = result.value
      return reply.send({
        billId: v.bill_id ?? v.billId ?? billId,
        status: v.status ?? null,
        paidAmount: v.paid_amount != null ? Number(v.paid_amount) : paidAmount,
        paymentRef: v.payment_ref ?? paymentRef,
        paymentProof: v.payment_proof ?? paymentProof ?? null,
        paidAt: v.paid_at ?? paidAt ?? null,
      })
    }
  )

  app.post(
    `${prefix}/bills/:billId/write-off`,
    { preHandler: writeOffGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const body = (req.body ?? {}) as Record<string, unknown>
      const reason = body.reason != null ? String(body.reason).trim() : ''
      if (!reason) {
        return sendError(reply, 400, 'BAD_REQUEST', 'reason is required for write-off.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return
      const auth = getAuthContext(req)
      const result = await transitionBillStatus({
        supabase,
        billId,
        action: 'write_off',
        writeOffReason: reason,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(reply),
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      const v = result.value
      return reply.send({
        billId: v.bill_id ?? v.billId ?? billId,
        status: v.status ?? null,
        totalAmount: typeof v.total_amount === 'number' ? Number(v.total_amount) : null,
        writtenOffAt: v.written_off_at ?? null,
        reason: v.write_off_reason != null ? String(v.write_off_reason) : reason,
      })
    }
  )

  app.post(
    `${prefix}/bills/:billId/void`,
    { preHandler: voidGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const body = (req.body ?? {}) as Record<string, unknown>
      const reason = body.reason != null ? String(body.reason).trim() : ''
      if (!reason) {
        return sendError(reply, 400, 'BAD_REQUEST', 'reason is required for void.')
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return
      const auth = getAuthContext(req)
      const result = await voidBill({
        supabase,
        billId,
        reason,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(reply),
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      return reply.send(result.value)
    }
  )

  app.post(
    `${prefix}/bills/:billId/adjust`,
    { preHandler: adjustGuard },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const billId = String((req.params as { billId?: string }).billId || '')
      const body = (req.body ?? {}) as Record<string, unknown>
      const type = body.type != null ? String(body.type) : ''
      const reason = body.reason != null ? String(body.reason).trim() : ''
      const idempotencyKeyParsed = parseOptionalIdempotencyKey(body.idempotencyKey)
      if (!idempotencyKeyParsed.ok) {
        return sendError(reply, 400, 'BAD_REQUEST', idempotencyKeyParsed.message)
      }
      const idempotencyKey = idempotencyKeyParsed.value
      const amount = body.amount
      const items = Array.isArray(body.items) ? (body.items as Array<{ iccid?: string | null; description?: string | null; amount?: number | null }>) : []
      if (!reason) {
        return sendError(reply, 400, 'BAD_REQUEST', 'reason is required.')
      }
      let totalAmount = typeof amount === 'number' ? amount : 0
      if (items.length) {
        totalAmount = items.reduce((sum, item) => {
          const v = Number(item?.amount ?? 0)
          if (!Number.isFinite(v) || v <= 0) return sum
          return sum + v
        }, 0)
      }
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(reply) })
      const bill = await loadBillForRequest(req, reply, sendError, supabase, billId, getRoleScope, getEnterpriseIdFromReq)
      if (!bill) return
      const auth = getAuthContext(req)
      const result = await createAdjustmentNote({
        supabase,
        billId,
        type,
        amount: totalAmount,
        reason,
        items,
        idempotencyKey,
        actorUserId: auth.userId ?? null,
        requestId: getTraceId(reply),
      })
      if (!result.ok) {
        return sendError(reply, result.status, result.code, result.message)
      }
      const note = result.value || {}
      return reply.status(201).send({
        ...(note as Record<string, unknown>),
        noteId: note.noteId ?? note.adjustmentNoteId ?? null,
      })
    }
  )
}
