import type { FastifyRequest } from 'fastify'
import { parseRoamingProfileRatesCsv } from '../services/simImportCsv.js'
import {
  createApnProfile,
  deprecateApnProfile,
  createRoamingProfile,
  deprecateRoamingProfile,
  createCoveredNetworkProfile,
  deprecateCoveredNetworkProfile,
  cloneApnProfile,
  exportRoamingProfileRatesCsv,
  listApnProfiles,
  listRoamingProfiles,
  listCoveredNetworkProfiles,
  getApnProfileDetail,
  getRoamingProfileDetail,
  getCoveredNetworkProfileDetail,
  publishApnProfile,
  publishRoamingProfile,
  publishCoveredNetworkProfile,
  patchCoveredNetworkProfile,
  rollbackProfileVersion,
  updateApnProfile,
  updateRoamingProfile,
} from '../services/networkProfile.js'
import { getAuthContext, checkPermissions } from '../middleware/rbac.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'

type Deps = {
  createSupabaseRestClient: (options: { useServiceRole: boolean; traceId?: string | null }) => {
    select: (table: string, queryString: string) => Promise<unknown>
    insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
    update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  }
  getTraceId: (reply: any) => string | null
  sendError: (reply: any, status: number, code: string, message: string) => void
  ensureResellerAdmin: (req: any, reply: any) => { scope?: string | null; resellerId?: string | null; userId?: string | null; role?: string | null } | null
  ensureResellerSales: (req: any, reply: any) => { scope?: string | null } | null
  isValidUuid: (value: unknown) => boolean
  readRequestBody: (req: FastifyRequest, maxBytes: number) => Promise<Buffer>
  parseMultipartFormData: (buffer: Buffer, boundary: string) => {
    fields: Record<string, unknown>
    files: Record<string, { filename: string; content: string }>
  }
}

export function registerNetworkProfileRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    ensureResellerAdmin,
    ensureResellerSales,
    isValidUuid,
    readRequestBody,
    parseMultipartFormData,
  } = deps

  function buildAuditContext(req: any, res: any) {
    return {
      actorUserId: actorUserIdForDb(req?.cmpAuth?.userId),
      actorRole: req?.cmpAuth?.role ?? null,
      requestId: getTraceId(res),
      sourceIp: req.ip,
    }
  }

  async function supplierIdExists(supabase: any, supplierId: string): Promise<boolean> {
    const rows = await supabase.select(
      'suppliers',
      `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return Boolean((row as any)?.supplier_id)
  }

  async function resellerTenantExists(supabase: any, resellerId: string): Promise<boolean> {
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return Boolean((row as any)?.tenant_id)
  }

  async function loadResellerSupplierIds(supabase: any, resellerId: string): Promise<string[]> {
    const rows = await supabase.select(
      'reseller_suppliers',
      `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerId)}`
    )
    return Array.from(
      new Set(
        (Array.isArray(rows) ? rows : [])
          .map((row: any) => String(row?.supplier_id ?? '').trim())
          .filter(Boolean)
      )
    )
  }

  async function loadOperatorRowsForList(supabase: any, operatorId: string, supplierId?: string | null): Promise<any[]> {
    const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
    const [byOperatorId, byBusinessOperatorId] = await Promise.all([
      supabase.select(
        'operators',
        `select=operator_id,supplier_id,business_operator_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}`
      ),
      supabase.select(
        'operators',
        `select=operator_id,supplier_id,business_operator_id&business_operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}`
      ),
    ])
    const seen = new Set<string>()
    const rows = []
    for (const row of [...(Array.isArray(byOperatorId) ? byOperatorId : []), ...(Array.isArray(byBusinessOperatorId) ? byBusinessOperatorId : [])]) {
      const id = String((row as any)?.operator_id ?? '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      rows.push(row)
    }
    return rows
  }

  async function resolveProfileListScope(
    req: any,
    res: any,
    supabase: any,
    auth: { scope?: string | null },
    input: { supplierId?: unknown; operatorId?: unknown },
  ): Promise<{ supplierId: string | null; supplierIds: string[] | null; operatorId: string | null } | null> {
    const supplierId = input.supplierId !== undefined && input.supplierId !== null && String(input.supplierId).trim() !== ''
      ? String(input.supplierId).trim()
      : null
    const operatorId = input.operatorId !== undefined && input.operatorId !== null && String(input.operatorId).trim() !== ''
      ? String(input.operatorId).trim()
      : null

    if (supplierId && !isValidUuid(supplierId)) {
      sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
      return null
    }
    if (operatorId && !isValidUuid(operatorId)) {
      sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
      return null
    }
    if (supplierId && !(await supplierIdExists(supabase, supplierId))) {
      sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
      return null
    }

    let operatorRows: any[] = []
    if (operatorId) {
      operatorRows = await loadOperatorRowsForList(supabase, operatorId, supplierId)
      if (!operatorRows.length) {
        const anyRows = supplierId ? await loadOperatorRowsForList(supabase, operatorId, null) : []
        sendError(
          res,
          400,
          'BAD_REQUEST',
          supplierId && anyRows.length ? 'operatorId is not linked to supplierId.' : 'operatorId is not found.'
        )
        return null
      }
    }

    if (auth.scope === 'reseller') {
      const tokenResellerId = String(req?.cmpAuth?.resellerId || '').trim()
      if (!tokenResellerId || !isValidUuid(tokenResellerId)) {
        sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
        return null
      }
      const allowedSupplierIds = await loadResellerSupplierIds(supabase, tokenResellerId)
      if (supplierId && !allowedSupplierIds.includes(supplierId)) {
        sendError(res, 403, 'FORBIDDEN', 'supplierId is outside reseller scope.')
        return null
      }
      if (operatorId) {
        const matchingSupplierIds = Array.from(
          new Set(operatorRows.map((row: any) => String(row?.supplier_id ?? '').trim()).filter(Boolean))
        )
        const inScopeSupplierIds = matchingSupplierIds.filter((id) => allowedSupplierIds.includes(id))
        if (!inScopeSupplierIds.length) {
          sendError(res, 403, 'FORBIDDEN', 'operatorId is outside reseller scope.')
          return null
        }
        return {
          supplierId,
          supplierIds: supplierId ? null : inScopeSupplierIds,
          operatorId,
        }
      }
      return {
        supplierId,
        supplierIds: supplierId ? null : allowedSupplierIds,
        operatorId,
      }
    }

    return { supplierId, supplierIds: null, operatorId }
  }

  async function assertResellerSupplierScope(req: any, res: any, supabase: any, auth: { scope?: string | null }, supplierId: string) {
    if (auth.scope !== 'reseller') return true
    const resellerId = String(req?.cmpAuth?.resellerId || '').trim()
    if (!resellerId || !isValidUuid(resellerId)) {
      sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      return false
    }
    const rows = await supabase.select(
      'reseller_suppliers',
      `select=reseller_id,supplier_id&reseller_id=eq.${encodeURIComponent(resellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!(row as any)?.supplier_id) {
      sendError(res, 403, 'FORBIDDEN', 'supplierId is outside reseller scope.')
      return false
    }
    return true
  }

  async function requireCoveredCatalogPerm(req: any, res: any, codes: string[]) {
    const auth = getAuthContext(req)
    if (auth.roleScope === 'platform' || auth.role === 'platform_admin') return true
    if (!(await checkPermissions(auth, codes))) {
      sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
      return false
    }
    return true
  }

  /** Platform admin must supply resellerId; reseller token may omit (defaults to token reseller). */
  function resolveCatalogWriteResellerId(
    auth: { scope?: string | null; resellerId?: string | null },
    req: any,
    res: any,
    rawResellerId: unknown
  ): string | null {
    const tokenResellerId = String(req?.cmpAuth?.resellerId || auth.resellerId || '').trim()
    const bodyReseller =
      rawResellerId === null || rawResellerId === undefined ? '' : String(rawResellerId).trim()

    if (auth.scope === 'platform') {
      if (!bodyReseller) {
        sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
        return null
      }
      if (!isValidUuid(bodyReseller)) {
        sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      return bodyReseller
    }

    if (auth.scope === 'reseller') {
      if (!bodyReseller) {
        if (!tokenResellerId || !isValidUuid(tokenResellerId)) {
          sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
          return null
        }
        return tokenResellerId
      }
      if (!isValidUuid(bodyReseller)) {
        sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      if (bodyReseller !== tokenResellerId) {
        sendError(res, 403, 'FORBIDDEN', 'resellerId must match the authenticated reseller.')
        return null
      }
      return bodyReseller
    }

    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  async function resolveCatalogWriteResellerTenantId(
    supabase: any,
    auth: { scope?: string | null; resellerId?: string | null },
    req: any,
    res: any,
    rawResellerId: unknown
  ): Promise<string | null> {
    const tokenResellerId = String(req?.cmpAuth?.resellerId || auth.resellerId || '').trim()
    const bodyReseller =
      rawResellerId === null || rawResellerId === undefined ? '' : String(rawResellerId).trim()

    if (auth.scope === 'platform') {
      if (!bodyReseller) {
        sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
        return null
      }
      if (!isValidUuid(bodyReseller)) {
        sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      if (!(await resellerTenantExists(supabase, bodyReseller))) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', 'resellerId is not found.')
        return null
      }
      return bodyReseller
    }

    if (auth.scope === 'reseller') {
      if (!tokenResellerId || !isValidUuid(tokenResellerId)) {
        sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
        return null
      }
      const effectiveResellerId = bodyReseller || tokenResellerId
      if (!isValidUuid(effectiveResellerId)) {
        sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      if (!(await resellerTenantExists(supabase, effectiveResellerId))) {
        sendError(res, 404, 'RESOURCE_NOT_FOUND', 'resellerId is not found.')
        return null
      }
      if (effectiveResellerId !== tokenResellerId) {
        sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
        return null
      }
      return effectiveResellerId
    }

    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  async function loadApnProfileSupplierId(supabase: any, apnProfileId: string) {
    const rows = await supabase.select(
      'apn_profiles',
      `select=apn_profile_id,supplier_id&apn_profile_id=eq.${encodeURIComponent(apnProfileId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return (row as any)?.supplier_id ? String((row as any).supplier_id) : null
  }

  async function loadRoamingProfileSupplierId(supabase: any, roamingProfileId: string) {
    const rows = await supabase.select(
      'roaming_profiles',
      `select=roaming_profile_id,supplier_id&roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return (row as any)?.supplier_id ? String((row as any).supplier_id) : null
  }

  async function loadCoveredNetworkProfileSupplierId(supabase: any, coveredNetworkProfileId: string) {
    const rows = await supabase.select(
      'covered_network_profiles',
      `select=covered_network_profile_id,supplier_id&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return (row as any)?.supplier_id ? String((row as any).supplier_id) : null
  }

  async function loadOperatorSupplierId(supabase: any, operatorId: string) {
    const byOperatorIdRows = await supabase.select(
      'operators',
      `select=operator_id,supplier_id&operator_id=eq.${encodeURIComponent(operatorId)}&limit=1`
    )
    const byOperatorId = Array.isArray(byOperatorIdRows) ? byOperatorIdRows[0] : null
    if ((byOperatorId as any)?.supplier_id) return String((byOperatorId as any).supplier_id)
    const byBusinessOperatorIdRows = await supabase.select(
      'operators',
      `select=operator_id,supplier_id&business_operator_id=eq.${encodeURIComponent(operatorId)}&limit=1`
    )
    const byBusinessOperatorId = Array.isArray(byBusinessOperatorIdRows) ? byBusinessOperatorIdRows[0] : null
    return (byBusinessOperatorId as any)?.supplier_id ? String((byBusinessOperatorId as any).supplier_id) : null
  }

  app.post(`${prefix}/apn-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supplierId = String(req?.body?.supplierId || '').trim()
    if (!isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    const audit = buildAuditContext(req, res)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (!(await supplierIdExists(supabase, supplierId))) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
    }
    const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
    if (!allowed) return
    const result = await createApnProfile({ supabase, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.code(201).send((result as any).value)
  })

  app.post(`${prefix}/roaming-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const supplierId = String(req?.body?.supplierId || '').trim()
    if (!isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    const audit = buildAuditContext(req, res)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (!(await supplierIdExists(supabase, supplierId))) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
    }
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? { ...(req.body as Record<string, unknown>) }
        : {}
    const resolvedResellerId = await resolveCatalogWriteResellerTenantId(supabase, auth, req, res, payload.resellerId)
    if (!resolvedResellerId) return
    payload.resellerId = resolvedResellerId
    const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
    if (!allowed) return
    const result = await createRoamingProfile({ supabase, payload, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.code(201).send((result as any).value)
  })

  app.post(`${prefix}/roaming-profiles/import-csv`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const contentType = req.headers['content-type'] ? String(req.headers['content-type']) : ''
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return sendError(res, 400, 'BAD_REQUEST', 'multipart/form-data is required.')
    }
    const boundaryMatch = contentType.match(/boundary=([^;]+)/i)
    if (!boundaryMatch) {
      return sendError(res, 400, 'BAD_REQUEST', 'multipart boundary is required.')
    }
    let bodyBuffer: Buffer
    try {
      bodyBuffer = await readRequestBody(req, 10 * 1024 * 1024)
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
    }
    const { fields, files } = parseMultipartFormData(bodyBuffer, boundaryMatch[1])
    const name = fields.name ? String(fields.name).trim() : ''
    const supplierId = fields.supplierId ? String(fields.supplierId).trim() : ''
    const operatorId = fields.operatorId ? String(fields.operatorId).trim() : ''
    if (!name) {
      return sendError(res, 400, 'BAD_REQUEST', 'name is required.')
    }
    if (!supplierId || !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
    }
    if (!operatorId || !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
    }
    const file = files.file
    if (!file || !file.content) {
      return sendError(res, 400, 'INVALID_FORMAT', 'file is required.')
    }
    const parsedCsv = parseRoamingProfileRatesCsv(String(file.content ?? ''))
    if (!parsedCsv.ok) {
      return sendError(res, parsedCsv.status, parsedCsv.code, parsedCsv.message)
    }
    const audit = buildAuditContext(req, res)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (!(await supplierIdExists(supabase, supplierId))) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
    }
    const resellerId = await resolveCatalogWriteResellerTenantId(supabase, auth, req, res, fields.resellerId)
    if (!resellerId) return
    const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
    if (!allowed) return
    const result = await createRoamingProfile({
      supabase,
      payload: {
        name,
        resellerId,
        supplierId,
        operatorId,
        mccmncList: parsedCsv.entries,
      },
      audit,
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.code(201).send({
      ...(result as any).value,
      rowCount: parsedCsv.rowCount,
    })
  })

  app.post(`${prefix}/covered-network-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.write']))) return
    const supplierId = String(req?.body?.supplierId || '').trim()
    if (!isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    const audit = buildAuditContext(req, res)
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    if (!(await supplierIdExists(supabase, supplierId))) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
    }
    const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
    if (!allowed) return
    const payload =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? { ...(req.body as Record<string, unknown>) }
        : {}
    const resolvedResellerId = resolveCatalogWriteResellerId(auth, req, res, payload.resellerId)
    if (!resolvedResellerId) return
    payload.resellerId = resolvedResellerId
    const result = await createCoveredNetworkProfile({ supabase, payload, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.code(201).send((result as any).value)
  })

  app.get(`${prefix}/apn-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { supplierId, operatorId, apnProfileId, status, page, pageSize } = req.query ?? {}
    if (apnProfileId && !isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const scope = await resolveProfileListScope(req, res, supabase, auth, { supplierId, operatorId })
    if (!scope) return
    const result = await listApnProfiles({
      supabase,
      supplierId: scope.supplierId,
      supplierIds: scope.supplierIds,
      operatorId: scope.operatorId,
      apnProfileId,
      status,
      page,
      pageSize,
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.get(`${prefix}/roaming-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const { supplierId, operatorId: operatorIdRaw, carrierId, status, page, pageSize } = req.query ?? {}
    const operatorId = operatorIdRaw ?? carrierId ?? null
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const scope = await resolveProfileListScope(req, res, supabase, auth, { supplierId, operatorId })
    if (!scope) return
    const result = await listRoamingProfiles({
      supabase,
      supplierId: scope.supplierId,
      supplierIds: scope.supplierIds,
      operatorId: scope.operatorId,
      status,
      page,
      pageSize,
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.get(`${prefix}/covered-network-profiles`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.list']))) return
    const {
      supplierId,
      operatorId: operatorIdRaw,
      carrierId,
      resellerId,
      coveredNetworkProfileId,
      status,
      page,
      pageSize,
    } = req.query ?? {}
    const operatorId = operatorIdRaw ?? carrierId ?? null
    if (!supplierId && !operatorId && !coveredNetworkProfileId) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId, operatorId, or coveredNetworkProfileId is required.')
    }
    if (coveredNetworkProfileId && !isValidUuid(coveredNetworkProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    if (resellerId && !isValidUuid(resellerId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let supplierIdForList = supplierId
    let effectiveResellerId = resellerId ? String(resellerId).trim() : null
    if (supplierIdForList && !(await supplierIdExists(supabase, String(supplierIdForList)))) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is not found.')
    }
    if (effectiveResellerId && !(await resellerTenantExists(supabase, effectiveResellerId))) {
      return sendError(res, 404, 'RESOURCE_NOT_FOUND', 'resellerId is not found.')
    }
    if (auth.scope === 'reseller') {
      const tokenResellerId = String(req?.cmpAuth?.resellerId || '').trim()
      if (!tokenResellerId || !isValidUuid(tokenResellerId)) {
        return sendError(res, 403, 'FORBIDDEN', 'Reseller scope is missing resellerId.')
      }
      if (effectiveResellerId && effectiveResellerId !== tokenResellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId does not match authenticated reseller.')
      }
      effectiveResellerId = tokenResellerId
      if (!supplierIdForList && operatorId) {
        const supplierIdFromOperator = await loadOperatorSupplierId(supabase, String(operatorId))
        if (!supplierIdFromOperator) {
          return sendError(res, 400, 'BAD_REQUEST', 'operatorId is not found.')
        }
        supplierIdForList = supplierIdFromOperator
      }
      if (!supplierIdForList) {
        return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required for reseller scope.')
      }
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, String(supplierIdForList))
      if (!allowed) return
    }
    const result = await listCoveredNetworkProfiles({
      supabase,
      supplierId: supplierIdForList,
      operatorId,
      resellerId: effectiveResellerId,
      coveredNetworkProfileId,
      status,
      page,
      pageSize,
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.get(`${prefix}/apn-profiles/:apnProfileId`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    if (!isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadApnProfileSupplierId(supabase, apnProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await getApnProfileDetail({ supabase, apnProfileId })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.get(`${prefix}/roaming-profiles/:roamingProfileId`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    if (!isValidUuid(roamingProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await getRoamingProfileDetail({ supabase, roamingProfileId })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.get(`${prefix}/roaming-profiles/:roamingProfileId/export-csv`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    if (!isValidUuid(roamingProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await exportRoamingProfileRatesCsv({ supabase, roamingProfileId })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    const { csv, filename } = (result as any).value
    res
      .code(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv)
  })

  app.get(`${prefix}/covered-network-profiles/:coveredNetworkProfileId`, async (req: any, res: any) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.read']))) return
    const coveredNetworkProfileId = String(req.params.coveredNetworkProfileId || '').trim()
    if (!isValidUuid(coveredNetworkProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await getCoveredNetworkProfileDetail({ supabase, coveredNetworkProfileId })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.patch(`${prefix}/covered-network-profiles/:coveredNetworkProfileId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.write']))) return
    const audit = buildAuditContext(req, res)
    const coveredNetworkProfileId = String(req.params.coveredNetworkProfileId || '').trim()
    if (!isValidUuid(coveredNetworkProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await patchCoveredNetworkProfile({
      supabase,
      coveredNetworkProfileId,
      payload: req.body ?? {},
      audit,
    })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.put(`${prefix}/apn-profiles/:apnProfileId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = buildAuditContext(req, res)
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    if (!isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadApnProfileSupplierId(supabase, apnProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await updateApnProfile({ supabase, apnProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.put(`${prefix}/roaming-profiles/:roamingProfileId`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = buildAuditContext(req, res)
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    if (!isValidUuid(roamingProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await updateRoamingProfile({ supabase, roamingProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId/clone`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = buildAuditContext(req, res)
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    if (!isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await cloneApnProfile({ supabase, apnProfileId, payload: req.body ?? {}, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.code(201).send((result as any).value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/clone`, async (req: any, res: any) => {
    sendError(
      res,
      410,
      'GONE',
      'Roaming profile clone is not supported. Use GET /roaming-profiles/{roamingProfileId}:export-csv and POST /roaming-profiles:import-csv to create a new profile.'
    )
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId/publish`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = buildAuditContext(req, res)
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    if (!isValidUuid(apnProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadApnProfileSupplierId(supabase, apnProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await publishApnProfile({ supabase, apnProfileId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/apn-profiles/:apnProfileId/deprecate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = buildAuditContext(req, res)
    const apnProfileId = String(req.params.apnProfileId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadApnProfileSupplierId(supabase, apnProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await deprecateApnProfile({ supabase, apnProfileId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/publish`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = buildAuditContext(req, res)
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    if (!isValidUuid(roamingProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await publishRoamingProfile({ supabase, roamingProfileId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/covered-network-profiles/:coveredNetworkProfileId/publish`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.publish']))) return
    const audit = buildAuditContext(req, res)
    const coveredNetworkProfileId = String(req.params.coveredNetworkProfileId || '').trim()
    if (!isValidUuid(coveredNetworkProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await publishCoveredNetworkProfile({ supabase, coveredNetworkProfileId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/covered-network-profiles/:coveredNetworkProfileId/deprecate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    if (!(await requireCoveredCatalogPerm(req, res, ['catalog.covered_network_profiles.deprecate']))) return
    const audit = buildAuditContext(req, res)
    const coveredNetworkProfileId = String(req.params.coveredNetworkProfileId || '').trim()
    if (!isValidUuid(coveredNetworkProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadCoveredNetworkProfileSupplierId(supabase, coveredNetworkProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await deprecateCoveredNetworkProfile({ supabase, coveredNetworkProfileId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/roaming-profiles/:roamingProfileId/deprecate`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = buildAuditContext(req, res)
    const roamingProfileId = String(req.params.roamingProfileId || '').trim()
    if (!isValidUuid(roamingProfileId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const supplierId = await loadRoamingProfileSupplierId(supabase, roamingProfileId)
    if (supplierId) {
      const allowed = await assertResellerSupplierScope(req, res, supabase, auth, supplierId)
      if (!allowed) return
    }
    const result = await deprecateRoamingProfile({ supabase, roamingProfileId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })

  app.post(`${prefix}/profile-versions/:profileVersionId/rollback`, async (req: any, res: any) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const audit = buildAuditContext(req, res)
    const profileVersionId = String(req.params.profileVersionId || '').trim()
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await rollbackProfileVersion({ supabase, profileVersionId, audit })
    if (!result.ok) return sendError(res, (result as any).status, (result as any).code, (result as any).message)
    res.send((result as any).value)
  })
}
