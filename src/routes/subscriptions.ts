import crypto from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import {
  batchCreateSubscriptions,
  batchExportSubscriptions,
  createSubscription,
  switchSubscription,
  cancelSubscription,
  listSimSubscriptions,
  listSubscriptions,
  listSubscriptionsSearch,
  listEnterpriseSubscriptionsSanitized,
  getSubscription,
  SUBSCRIPTION_BATCH_MAX_BYTES,
} from '../services/subscription.js'
import { parseSimIdentifier } from '../services/simLifecycle.js'

type Deps = {
  createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => {
    select: (table: string, queryString: string) => Promise<unknown>
    selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
    insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
    update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
    delete: (table: string, matchQueryString: string) => Promise<unknown>
  }
  getTraceId: (reply: any) => string | null
  sendError: (reply: any, status: number, code: string, message: string) => void
  ensureResellerSales: (req: any, reply: any) => { scope?: string | null } | null
  resolveEnterpriseForReseller: (req: any, reply: any, supabase: any, enterpriseId: string | null) => Promise<string | null>
  getRoleScope: (req: any) => string | null
  getEnterpriseIdFromReq: (req: any) => string | null
  buildSimTenantFilter: (req: any, enterpriseId: string | null) => string
  isValidUuid: (value: unknown) => boolean
  readRequestBody: (req: FastifyRequest, maxBytes: number) => Promise<Buffer>
  parseMultipartFormData: (buffer: Buffer, boundary: string) => {
    fields: Record<string, unknown>
    files: Record<string, { filename: string; content: string }>
  }
}

export function registerSubscriptionRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerSales,
    resolveEnterpriseForReseller,
    getRoleScope,
    getEnterpriseIdFromReq,
    buildSimTenantFilter,
    isValidUuid,
    readRequestBody,
    parseMultipartFormData,
  } = deps
  const resellerSalesRoles = new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director'])
  const ensureSubscriptionAccess = (req: any, res: any) => {
    const roleScope = getRoleScope(req)
    const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
    if (!roleScope && !role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (roleScope === 'platform' || role === 'platform_admin') return { scope: 'platform' }
    if (roleScope === 'reseller' && role && resellerSalesRoles.has(role)) return { scope: 'reseller' }
    if (roleScope === 'customer') return { scope: 'customer' }
    if (roleScope === 'department') return { scope: 'department' }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  /** Customer/department: optional enterpriseId must exist, match JWT; invalid uuid → 400; not found → 404; mismatch → 403. */
  const resolveCustomerScopedEnterpriseId = async (
    req: any,
    res: any,
    supabase: ReturnType<Deps['createSupabaseRestClient']>,
    providedEnterpriseId: string | null
  ): Promise<string | null> => {
    const fromReq = getEnterpriseIdFromReq(req)
    const tokenEnterpriseId = fromReq ? String(fromReq).trim() : null
    if (!tokenEnterpriseId || !isValidUuid(tokenEnterpriseId)) {
      sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      return null
    }
    if (providedEnterpriseId) {
      if (!isValidUuid(providedEnterpriseId)) {
        sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const enterpriseRows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(providedEnterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      const enterpriseExists =
        Array.isArray(enterpriseRows) && !!(enterpriseRows[0] as Record<string, unknown> | undefined)?.tenant_id
      if (!enterpriseExists) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', 'enterpriseId Not found.')
        return null
      }
      if (providedEnterpriseId !== tokenEnterpriseId) {
        sendError(res, 403, 'FORBIDDEN', 'enterpriseId must match your token scope.')
        return null
      }
    }
    return tokenEnterpriseId
  }

  app.get(`${prefix}/subscriptions`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const query = req.query ?? {}
    const roleScope = getRoleScope(req)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
    if (roleScope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (roleScope === 'platform') {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
      if (enterpriseId && !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      if (!enterpriseId) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required for list subscriptions.')
      }
    } else {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = fromReq ? String(fromReq) : null
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
      const queryEnterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
      if (queryEnterpriseId && queryEnterpriseId !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'enterpriseId in query must match your token scope.')
      }
    }
    const result = await listSubscriptions({
      supabase,
      enterpriseId,
      iccid: query.iccid,
      state: query.state,
      kind: query.kind,
      page: query.page,
      pageSize: query.pageSize,
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    const filterPairs: string[] = []
    if (query.enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
    if (query.iccid) filterPairs.push(`iccid=${query.iccid}`)
    if (query.state) filterPairs.push(`state=${query.state}`)
    if (query.kind) filterPairs.push(`kind=${query.kind}`)
    filterPairs.push(`page=${result.value.page}`)
    filterPairs.push(`pageSize=${result.value.pageSize}`)
    res.header('X-Filters', filterPairs.join(';'))
    res.send(result.value)
  })

  app.get(`${prefix}/subscriptions/:subscriptionId`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const subscriptionId = req.params.subscriptionId
    const roleScope = getRoleScope(req)
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getSubscription({ supabase, subscriptionId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)

    const subscriptionEnterpriseId = String(result.value.enterpriseId || '').trim()
    const queryEnterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
    if (queryEnterpriseId) {
      if (!isValidUuid(queryEnterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      if (queryEnterpriseId !== subscriptionEnterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'enterpriseId does not match subscription.')
      }
    }

    if (roleScope === 'reseller') {
      const scoped = await resolveEnterpriseForReseller(req, res, supabase, subscriptionEnterpriseId)
      if (!scoped) return
    } else if (roleScope === 'platform') {
      // subscriptionId is globally unique; no enterpriseId required.
    } else {
      const tokenEnterpriseId = await resolveCustomerScopedEnterpriseId(req, res, supabase, queryEnterpriseId)
      if (!tokenEnterpriseId) return
      if (subscriptionEnterpriseId !== tokenEnterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Subscription does not belong to your enterprise.')
      }
    }
    res.send(result.value)
  })

  app.get(`${prefix}/subscriptions:search`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const roleScope = getRoleScope(req)
    if (roleScope !== 'platform' && roleScope !== 'reseller' && roleScope !== 'customer') {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
    if (roleScope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
      const tokenResellerId = req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId).trim() : null
      const resellerIdQuery = query.resellerId ? String(query.resellerId).trim() : null
      if (resellerIdQuery) {
        if (!isValidUuid(resellerIdQuery)) return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        if (tokenResellerId && resellerIdQuery !== tokenResellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
        }
      }
    } else if (roleScope === 'customer') {
      const tokenEnterpriseId = getEnterpriseIdFromReq(req)
      if (!tokenEnterpriseId || !isValidUuid(tokenEnterpriseId)) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
      if (query.resellerId !== undefined && query.resellerId !== null && String(query.resellerId).trim() !== '') {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId is not allowed for customer scope.')
      }
      if (enterpriseId) {
        if (!isValidUuid(enterpriseId)) return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        const enterpriseRows = await supabase.select(
          'tenants',
          `select=tenant_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
        )
        const enterpriseExists =
          Array.isArray(enterpriseRows) && !!(enterpriseRows[0] as Record<string, unknown> | undefined)?.tenant_id
        if (!enterpriseExists) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'enterpriseId Not found.')
        }
        if (String(tokenEnterpriseId).trim() !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'enterpriseId must match your token scope.')
        }
      } else {
        enterpriseId = String(tokenEnterpriseId).trim()
      }
    } else if (enterpriseId && !isValidUuid(enterpriseId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const result = await listSubscriptionsSearch({
      supabase,
      enterpriseId,
      departmentId: query.departmentId,
      resellerId: query.resellerId,
      iccid: query.iccid,
      imsi: query.imsi,
      state: query.state,
      kind: query.kind,
      supplierId: query.supplierId,
      operatorId: query.operatorId,
      packageId: query.packageId,
      page: query.page,
      pageSize: query.pageSize,
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    const filterPairs: string[] = []
    if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
    if (query.departmentId) filterPairs.push(`departmentId=${query.departmentId}`)
    if (query.resellerId) filterPairs.push(`resellerId=${query.resellerId}`)
    if (query.iccid) filterPairs.push(`iccid=${query.iccid}`)
    if (query.imsi) filterPairs.push(`imsi=${query.imsi}`)
    if (query.state) filterPairs.push(`state=${query.state}`)
    if (query.kind) filterPairs.push(`kind=${query.kind}`)
    if (query.supplierId) filterPairs.push(`supplierId=${query.supplierId}`)
    if (query.operatorId) filterPairs.push(`operatorId=${query.operatorId}`)
    if (query.packageId) filterPairs.push(`packageId=${query.packageId}`)
    filterPairs.push(`page=${result.value.page}`)
    filterPairs.push(`pageSize=${result.value.pageSize}`)
    res.header('X-Filters', filterPairs.join(';'))
    res.send(result.value)
  })

  app.get(`${prefix}/enterprises/:enterpriseId/subscriptions`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const roleScope = getRoleScope(req)
    const enterpriseId = req.params.enterpriseId ? String(req.params.enterpriseId).trim() : ''
    if (!isValidUuid(enterpriseId)) return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseRows = await supabase.select(
      'tenants',
      `select=tenant_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const enterpriseExists =
      Array.isArray(enterpriseRows) && !!(enterpriseRows[0] as Record<string, unknown> | undefined)?.tenant_id
    if (!enterpriseExists) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'enterpriseId Not found.')
    }
    if (roleScope === 'reseller') {
      const scoped = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!scoped) return
    } else if (roleScope !== 'platform') {
      const tokenEnterpriseId = getEnterpriseIdFromReq(req)
      if (!tokenEnterpriseId || String(tokenEnterpriseId) !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'enterpriseId in path must match your token scope.')
      }
    }
    const query = req.query ?? {}
    const result = await listEnterpriseSubscriptionsSanitized({
      supabase,
      enterpriseId,
      departmentId: query.departmentId,
      iccid: query.iccid,
      imsi: query.imsi,
      state: query.state,
      kind: query.kind,
      packageId: query.packageId,
      page: query.page,
      pageSize: query.pageSize,
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    const filterPairs: string[] = [`enterpriseId=${enterpriseId}`]
    if (query.departmentId) filterPairs.push(`departmentId=${query.departmentId}`)
    if (query.iccid) filterPairs.push(`iccid=${query.iccid}`)
    if (query.imsi) filterPairs.push(`imsi=${query.imsi}`)
    if (query.state) filterPairs.push(`state=${query.state}`)
    if (query.kind) filterPairs.push(`kind=${query.kind}`)
    if (query.packageId) filterPairs.push(`packageId=${query.packageId}`)
    filterPairs.push(`page=${result.value.page}`)
    filterPairs.push(`pageSize=${result.value.pageSize}`)
    res.header('X-Filters', filterPairs.join(';'))
    res.send(result.value)
  })

  app.post(`${prefix}/subscriptions`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const body = req.body ?? {}
    const roleScope = getRoleScope(req)
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = body.enterpriseId ? String(body.enterpriseId).trim() : null
    if (roleScope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (roleScope === 'platform') {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
    } else {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = fromReq ? String(fromReq) : null
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
    }
    const result = await createSubscription({
      supabase,
      enterpriseId,
      iccid: body.iccid,
      packageId: body.packageId,
      kind: body.kind,
      effectiveAt: body.effectiveAt,
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
      audit,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(202).send(result.value)
  })

  app.post(`${prefix}/subscriptions:batch-create`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const roleScope = getRoleScope(req)
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return sendError(res, 400, 'BAD_REQUEST', 'multipart/form-data is required.')
    }
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i)
    if (!boundaryMatch) {
      return sendError(res, 400, 'BAD_REQUEST', 'multipart boundary is required.')
    }
    const boundary = boundaryMatch[1].trim().replace(/^["']|["']$/g, '')
    let bodyBuffer: Buffer
    try {
      bodyBuffer = await readRequestBody(req, SUBSCRIPTION_BATCH_MAX_BYTES)
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
    }
    const { fields, files } = parseMultipartFormData(bodyBuffer, boundary)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = fields.enterpriseId ? String(fields.enterpriseId).trim() : null
    if (roleScope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (roleScope === 'platform') {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
    } else {
      const provided = enterpriseId
      enterpriseId = await resolveCustomerScopedEnterpriseId(req, res, supabase, provided)
      if (!enterpriseId) return
    }
    const upFile = files.file
    if (!upFile?.content) {
      return sendError(res, 400, 'BAD_REQUEST', 'file is required.')
    }
    const fileText = String(upFile.content ?? '')
    const fileHash = crypto.createHash('sha256').update(Buffer.from(fileText, 'utf8')).digest('hex')
    const batchId = fields.batchId ? String(fields.batchId).trim() : null
    const result = await batchCreateSubscriptions({
      supabase,
      enterpriseId,
      packageId: fields.packageId ? String(fields.packageId).trim() : '',
      kind: fields.kind !== undefined && fields.kind !== null ? fields.kind : undefined,
      effectiveAt:
        fields.effectiveAt !== undefined && fields.effectiveAt !== null && String(fields.effectiveAt).trim() !== ''
          ? String(fields.effectiveAt).trim()
          : undefined,
      fileText,
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
      audit,
      batchId,
      fileHash,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.post(`${prefix}/subscriptions:batch-export`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const roleScope = getRoleScope(req)
    const body = req.body ?? {}
    const query = req.query ?? {}
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId =
      body.enterpriseId !== undefined && body.enterpriseId !== null && String(body.enterpriseId).trim() !== ''
        ? String(body.enterpriseId).trim()
        : query.enterpriseId
          ? String(query.enterpriseId).trim()
          : null
    const resellerIdValue =
      body.resellerId !== undefined && body.resellerId !== null && String(body.resellerId).trim() !== ''
        ? String(body.resellerId).trim()
        : query.resellerId
          ? String(query.resellerId).trim()
          : null
    if (roleScope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
      const tokenResellerId = req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId).trim() : null
      if (resellerIdValue) {
        if (!isValidUuid(resellerIdValue)) return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        if (tokenResellerId && resellerIdValue !== tokenResellerId) {
          return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
        }
      }
    } else if (roleScope === 'platform') {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
      if (enterpriseId && !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
    } else if (roleScope === 'customer') {
      const tokenEnterpriseId = getEnterpriseIdFromReq(req)
      if (!tokenEnterpriseId || !isValidUuid(tokenEnterpriseId)) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
      if (resellerIdValue) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId is not allowed for customer scope.')
      }
      if (enterpriseId) {
        if (!isValidUuid(enterpriseId)) return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        const enterpriseRows = await supabase.select(
          'tenants',
          `select=tenant_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
        )
        const enterpriseExists =
          Array.isArray(enterpriseRows) && !!(enterpriseRows[0] as Record<string, unknown> | undefined)?.tenant_id
        if (!enterpriseExists) {
          return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'enterpriseId Not found.')
        }
        if (String(tokenEnterpriseId).trim() !== enterpriseId) {
          return sendError(res, 403, 'FORBIDDEN', 'enterpriseId must match your token scope.')
        }
      } else {
        enterpriseId = String(tokenEnterpriseId).trim()
      }
    } else if (enterpriseId && !isValidUuid(enterpriseId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const pickParam = (key: string): string | null => {
      const q = query[key]
      if (q !== undefined && q !== null && String(q).trim() !== '') return String(q).trim()
      const b = body[key]
      if (b !== undefined && b !== null && String(b).trim() !== '') return String(b).trim()
      return null
    }
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req?.ip ?? null,
    }
    const result = await batchExportSubscriptions({
      supabase,
      enterpriseId,
      departmentId: body.departmentId ?? query.departmentId,
      resellerId: resellerIdValue,
      iccid: body.iccid ?? query.iccid,
      imsi: body.imsi ?? query.imsi,
      state: body.state ?? query.state,
      kind: body.kind ?? query.kind,
      supplierId: body.supplierId ?? query.supplierId,
      operatorId: body.operatorId ?? query.operatorId,
      packageId: body.packageId ?? query.packageId,
      page: body.page ?? query.page,
      pageSize: body.pageSize ?? query.pageSize,
      batchId: pickParam('batchId'),
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
      audit,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res
      .header('Content-Disposition', `attachment; filename="${result.value.filename}"`)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .send(result.value.csvText)
  })

  app.post(`${prefix}/subscriptions:switch`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const body = req.body ?? {}
    const query = req.query ?? {}
    const pickParam = (key: string): string | null => {
      const q = query[key]
      if (q !== undefined && q !== null && String(q).trim() !== '') return String(q).trim()
      const b = body[key]
      if (b !== undefined && b !== null && String(b).trim() !== '') return String(b).trim()
      return null
    }
    const roleScope = getRoleScope(req)
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = pickParam('enterpriseId')
    if (roleScope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (roleScope === 'platform') {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
    } else {
      enterpriseId = await resolveCustomerScopedEnterpriseId(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    }
    const result = await switchSubscription({
      supabase,
      enterpriseId,
      iccid: pickParam('iccid'),
      fromSubscriptionId: pickParam('fromSubscriptionId'),
      toPackageId: pickParam('toPackageId'),
      effectiveStrategy: pickParam('effectiveStrategy'),
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
      audit,
      batchId: pickParam('batchId'),
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/subscriptions/:subscriptionId/cancel`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const roleScope = getRoleScope(req)
    const audit = {
      actorUserId: req?.cmpAuth?.userId ?? null,
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const query = req.query ?? {}
    let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
    if (roleScope === 'reseller') {
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (roleScope === 'platform') {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
    } else {
      const provided = enterpriseId
      enterpriseId = await resolveCustomerScopedEnterpriseId(req, res, supabase, provided)
      if (!enterpriseId) return
    }
    const immediate = query.immediate
    const batchId = query.batchId ? String(query.batchId).trim() : null
    const result = await cancelSubscription({
      supabase,
      enterpriseId,
      subscriptionId: req.params.subscriptionId,
      immediate,
      audit,
      batchId,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/sims/:simId/subscriptions`, async (req: any, res: any) => {
    const auth = ensureSubscriptionAccess(req, res)
    if (!auth) return
    const parsed = parseSimIdentifier(req.params.simId)
    if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
    const roleScope = getRoleScope(req)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const query = req.query ?? {}
    let enterpriseId = query.enterpriseId ? String(query.enterpriseId).trim() : null
    if (!enterpriseId && (roleScope === 'platform' || roleScope === 'reseller')) {
      const sim = await supabase.select('sims', `select=enterprise_id&${parsed.field}=eq.${encodeURIComponent(parsed.value)}&limit=1`)
      const found = Array.isArray(sim) ? sim[0] : null
      if (found && (found as { enterprise_id?: string | null }).enterprise_id) {
        enterpriseId = String((found as { enterprise_id?: string | null }).enterprise_id)
      }
      if (!enterpriseId && parsed.field === 'iccid') {
        const iccidValue = String(parsed.value || '').trim()
        const fallback = await supabase.select(
          'sims',
          `select=enterprise_id,iccid&iccid=ilike.${encodeURIComponent(`%${iccidValue}%`)}&limit=20`
        )
        const candidates = Array.isArray(fallback) ? fallback : []
        const normalizeDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '')
        const target = normalizeDigits(iccidValue)
        const match = candidates.find((row: any) => normalizeDigits(row.iccid) === target)
        if (match && match.enterprise_id) {
          enterpriseId = String(match.enterprise_id)
        }
      }
    }
    if (roleScope === 'reseller') {
      if (!enterpriseId) {
        return sendError(res, 404, 'SIM_NOT_FOUND', `sim ${parsed.value} not found.`)
      }
      if (!isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    } else if (roleScope === 'platform') {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = enterpriseId || (fromReq ? String(fromReq) : null)
      if (!enterpriseId) {
        return sendError(res, 404, 'SIM_NOT_FOUND', `sim ${parsed.value} not found.`)
      }
      if (!isValidUuid(enterpriseId)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
    } else {
      const fromReq = getEnterpriseIdFromReq(req)
      enterpriseId = fromReq ? String(fromReq) : null
      if (!enterpriseId || !isValidUuid(enterpriseId)) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Enterprise token required.')
      }
    }
    const result = await listSimSubscriptions({
      supabase,
      enterpriseId,
      simIdentifier: { field: parsed.field, value: parsed.value },
      tenantFilter: buildSimTenantFilter(req, enterpriseId),
      state: query.state,
      kind: query.kind,
      page: query.page,
      pageSize: query.pageSize,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })
}
