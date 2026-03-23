import { runSimImport } from '../services/simImport.js'
import { parseSimIdentifier, fetchSimStateHistory, changeSimStatus, batchDeactivateSims, batchChangeSimStatus } from '../services/simLifecycle.js'

function escapeCsv(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`
  }
  return s
}

function safeHeaderValue(value) {
  return encodeURIComponent(String(value ?? '')).replace(/%0D|%0A|%00/gi, '')
}

function setXFilters(res, value) {
  res.setHeader('X-Filters', safeHeaderValue(value))
}

async function resolveOperatorFilter(supabase, operatorId, supplierId = null) {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const operatorRows = await supabase.select(
    'operators',
    `select=operator_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`
  )
  const operator = Array.isArray(operatorRows) ? operatorRows[0] : null
  if (operator?.operator_id) {
    return { operatorIds: [String(operator.operator_id)] }
  }
  const mappedRows = await supabase.select(
    'operators',
    `select=operator_id&business_operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}`
  )
  const operatorIds = Array.from(
    new Set(
      (Array.isArray(mappedRows) ? mappedRows : [])
        .map((row) => (row?.operator_id ? String(row.operator_id) : ''))
        .filter(Boolean)
    )
  )
  if (!operatorIds.length) return null
  return { operatorIds }
}

function appendOperatorFilter(filters, operatorFilter) {
  const operatorIds = Array.isArray(operatorFilter?.operatorIds) ? operatorFilter.operatorIds : []
  if (!operatorIds.length) return
  if (operatorIds.length === 1) {
    filters.push(`operator_id=eq.${encodeURIComponent(operatorIds[0])}`)
    return
  }
  filters.push(`operator_id=in.(${operatorIds.map((id) => encodeURIComponent(id)).join(',')})`)
}

async function loadBusinessOperatorMap(supabase, operatorIds) {
  const ids = Array.from(new Set(
    (Array.isArray(operatorIds) ? operatorIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  ))
  if (!ids.length) return new Map()
  const operatorRows = await supabase.select(
    'operators',
    `select=operator_id,business_operator_id&operator_id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`
  )
  const operatorToBusinessMap = new Map()
  const businessIds = new Set(ids)
  for (const row of (Array.isArray(operatorRows) ? operatorRows : [])) {
    const operatorId = row?.operator_id ? String(row.operator_id) : null
    const businessOperatorId = row?.business_operator_id ? String(row.business_operator_id) : null
    if (!operatorId || !businessOperatorId) continue
    operatorToBusinessMap.set(operatorId, businessOperatorId)
    businessIds.add(businessOperatorId)
  }
  const rows = await supabase.select(
    'business_operators',
    `select=operator_id,name,mcc,mnc&operator_id=in.(${Array.from(businessIds).map((id) => encodeURIComponent(id)).join(',')})`
  )
  const businessMap = new Map(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.operator_id)
      .map((row) => [String(row.operator_id), row])
  )
  const resolvedMap = new Map()
  for (const id of ids) {
    const resolvedId = operatorToBusinessMap.get(id) ?? id
    const business = businessMap.get(resolvedId)
    if (business) resolvedMap.set(id, business)
  }
  return resolvedMap
}

function isMissingSimResellerColumnError(err) {
  const text = String(err?.body ?? err?.message ?? '').toLowerCase()
  return text.includes('column sims.reseller_id does not exist')
}

async function detectSimResellerColumn(supabase) {
  try {
    await supabase.select('sims', 'select=reseller_id&limit=1', { suppressMissingColumns: true })
    return true
  } catch (err) {
    if (isMissingSimResellerColumnError(err)) return false
    throw err
  }
}

/**
 * Resolve auth.resellerId (may be resellers.id or tenants.tenant_id) to both IDs.
 * tenants.parent_id uses tenant_id; reseller_suppliers and sims.reseller_id use resellers.id.
 */
async function resolveResellerIdentity(supabase, rawResellerId) {
  if (!rawResellerId || !/^[0-9a-f-]{36}$/i.test(String(rawResellerId))) return null
  const id = String(rawResellerId).trim()
  const rows = await supabase.select(
    'resellers',
    `select=id,tenant_id&or=(id.eq.${encodeURIComponent(id)},tenant_id.eq.${encodeURIComponent(id)})&limit=1`
  )
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null
  if (!row) return null
  return {
    resellerId: row.id ? String(row.id) : null,
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
  }
}

export function registerSimPhase4Routes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getRoleScope,
    getEnterpriseIdFromReq,
    getDepartmentIdFromReq,
    buildSimTenantFilter,
    ensureResellerAdmin,
    ensureResellerSales,
    resolveEnterpriseForReseller,
    resolveDepartmentForEnterprise,
    normalizeIccid,
    isValidIccid,
    isValidUuid,
    readRequestBody,
    parseMultipartFormData,
    toIsoDateTime,
    pushSimStatusToUpstream,
  } = deps
  const resellerSalesRoles = new Set(['reseller_admin', 'reseller_sales', 'reseller_sales_director'])
  const ensureSimReadAccess = (req, res) => {
    const roleScope = getRoleScope(req)
    const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
    if (!roleScope && !role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (roleScope === 'platform' || role === 'platform_admin') return { scope: 'platform' }
    if (roleScope === 'reseller' && role && resellerSalesRoles.has(role)) {
      const rid = req?.cmpAuth?.resellerId ?? req?.tenantScope?.resellerId ?? null
      return { scope: 'reseller', resellerId: rid ? String(rid) : null }
    }
    if (roleScope === 'customer') return { scope: 'customer' }
    if (roleScope === 'department') return { scope: 'department' }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }
  const ensureSimListAccess = (req, res) => {
    const roleScope = getRoleScope(req)
    const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
    if (!roleScope && !role) {
      sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
      return null
    }
    if (roleScope === 'platform' || role === 'platform_admin') return { scope: 'platform' }
    if (roleScope === 'reseller' && role && resellerSalesRoles.has(role)) {
      const rid = req?.cmpAuth?.resellerId ?? req?.tenantScope?.resellerId ?? null
      return { scope: 'reseller', resellerId: rid ? String(rid) : null }
    }
    if (roleScope === 'customer') return { scope: 'customer' }
    if (roleScope === 'department') return { scope: 'department' }
    sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    return null
  }

  const simCsvHandler = async (req, res) => {
    if (!ensureSimReadAccess(req, res)) return

    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })

    const resellerIdQuery = req.query.resellerId ? String(req.query.resellerId) : null
    const pathEnterpriseId = req.params.enterpriseId ? String(req.params.enterpriseId) : null
    const enterpriseIdQuery = pathEnterpriseId || (req.query.enterpriseId ? String(req.query.enterpriseId) : null)
    const departmentIdQuery = req.query.departmentId ? String(req.query.departmentId) : null

    let enterpriseId = null
    let departmentId = null
    let resellerId = null
    let resellerTenantIdForCsv = null
    const roleScope = getRoleScope(req)
    const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null

    if (roleScope === 'platform' || role === 'platform_admin') {
      if (resellerIdQuery && !isValidUuid(resellerIdQuery)) {
        return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
      }
      if (enterpriseIdQuery && !isValidUuid(enterpriseIdQuery)) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
      }
      if (resellerIdQuery) {
        const resolved = await resolveResellerIdentity(supabase, resellerIdQuery)
        if (resolved) {
          resellerId = resolved.resellerId
          resellerTenantIdForCsv = resolved.tenantId
        } else {
          resellerId = resellerIdQuery
          resellerTenantIdForCsv = resellerIdQuery
        }
      }
      enterpriseId = enterpriseIdQuery
    } else if (roleScope === 'reseller') {
      const raw = req?.cmpAuth?.resellerId ? String(req.cmpAuth.resellerId) : null
      if (raw) {
        const resolved = await resolveResellerIdentity(supabase, raw)
        if (resolved) {
          resellerId = resolved.resellerId
          resellerTenantIdForCsv = resolved.tenantId
        } else {
          resellerId = raw
        }
      }
      if (enterpriseIdQuery) {
        if (!isValidUuid(enterpriseIdQuery)) {
          return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        }
        enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdQuery)
        if (!enterpriseId) return
      }
    } else if (roleScope === 'customer') {
      enterpriseId = getEnterpriseIdFromReq(req)
      if (pathEnterpriseId && pathEnterpriseId !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Access denied to this enterprise.')
      }
    } else if (roleScope === 'department') {
      enterpriseId = getEnterpriseIdFromReq(req)
      departmentId = getDepartmentIdFromReq(req)
      if (pathEnterpriseId && pathEnterpriseId !== enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'Access denied to this enterprise.')
      }
    }

    if (departmentIdQuery && !departmentId) {
      if (enterpriseId) {
        departmentId = await resolveDepartmentForEnterprise(req, res, supabase, enterpriseId, departmentIdQuery)
        if (!departmentId) return
      } else if (roleScope === 'platform' || roleScope === 'reseller' || role === 'platform_admin') {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required when filtering by departmentId.')
      }
    }

    const includeSensitive = (roleScope === 'platform' || roleScope === 'reseller' || role === 'platform_admin') && !pathEnterpriseId

    const iccid = req.query.iccid ? normalizeIccid(req.query.iccid) : null
    const msisdn = req.query.msisdn ? String(req.query.msisdn) : null
    const status = req.query.status ? String(req.query.status) : null
    const supplierId = includeSensitive && req.query.supplierId ? String(req.query.supplierId).trim() : null
    const operatorId = includeSensitive && req.query.operatorId ? String(req.query.operatorId).trim() : null
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : null
    const limitInput = req.query.limit ? Number(req.query.limit) : null
    const limit = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : Number.isFinite(limitInput) && limitInput > 0 ? limitInput : 1000
    const page = req.query.page ? Number(req.query.page) : 1
    const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))

    if (iccid && !isValidIccid(iccid)) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccid must be 18-20 digits.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    let operatorFilter = null
    if (operatorId) {
      const resolved = await resolveOperatorFilter(supabase, operatorId, supplierId)
      if (!resolved) {
        const headers = [
          'simId',
          'iccid',
          'imsi',
          'msisdn',
          'status',
          'lifecycleSubStatus',
          'upstreamStatus',
          'upstreamStatusUpdatedAt',
          'formFactor',
          'activationCode',
          ...(includeSensitive ? ['supplierId', 'supplierName', 'operatorId', 'operatorName', 'mcc', 'mnc'] : []),
          'apn',
          ...(includeSensitive ? ['resellerId', 'resellerName'] : []),
          'enterpriseId',
          'enterpriseName',
          'departmentId',
          'departmentName',
          'activationDate',
          'totalUsageBytes',
          'imei',
        ]
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', 'attachment; filename="sims.csv"')
        const filterPairs = []
        if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
        if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
        if (resellerId) filterPairs.push(`resellerId=${resellerId}`)
        if (iccid) filterPairs.push(`iccid=${iccid}`)
        if (msisdn) filterPairs.push(`msisdn=${msisdn}`)
        if (status) filterPairs.push(`status=${status}`)
        if (supplierId) filterPairs.push(`supplierId=${supplierId}`)
        if (operatorId) filterPairs.push(`operatorId=${operatorId}`)
        filterPairs.push(`page=${page}`)
        if (pageSize) filterPairs.push(`pageSize=${pageSize}`)
        filterPairs.push(`limit=${limit}`)
        setXFilters(res, filterPairs.join(';'))
        res.send(`${headers.map(escapeCsv).join(',')}\n`)
        return
      }
      operatorFilter = resolved
    }

    const includeResellerInventory = !enterpriseId && roleScope === 'reseller' && !!resellerId
    const hasSimResellerColumn = await detectSimResellerColumn(supabase)
    let resellerEnterpriseIds = null
    let resellerSupplierIdsCsv = null
    const tenantIdForCsvEnterprises = resellerTenantIdForCsv || resellerId
    if (!enterpriseId && resellerId && tenantIdForCsvEnterprises && (roleScope === 'platform' || roleScope === 'reseller' || role === 'platform_admin')) {
      const resellerRows = await supabase.select('tenants', `select=tenant_id&parent_id=eq.${encodeURIComponent(tenantIdForCsvEnterprises)}&tenant_type=eq.ENTERPRISE`)
      resellerEnterpriseIds = (Array.isArray(resellerRows) ? resellerRows : []).map((t) => String(t.tenant_id))
      if (!hasSimResellerColumn && resellerId) {
        const resellerSupplierRows = await supabase.select('reseller_suppliers', `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerId)}`)
        resellerSupplierIdsCsv = Array.from(new Set(
          (Array.isArray(resellerSupplierRows) ? resellerSupplierRows : [])
            .map((row) => (row?.supplier_id ? String(row.supplier_id) : ''))
            .filter(Boolean)
        ))
      }
    }

    const filters = []
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (!enterpriseId && resellerEnterpriseIds) {
      if (resellerId) {
        if (hasSimResellerColumn) {
          const resellerIdValues = [resellerId]
          if (resellerTenantIdForCsv && resellerTenantIdForCsv !== resellerId) resellerIdValues.push(resellerTenantIdForCsv)
          const resellerIdFilter = resellerIdValues.length > 1
            ? `reseller_id=in.(${resellerIdValues.map((id) => encodeURIComponent(id)).join(',')})`
            : `reseller_id=eq.${encodeURIComponent(resellerId)}`
          if (resellerEnterpriseIds.length) {
            filters.push(`or=(enterprise_id.in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')}),${resellerIdFilter})`)
          } else {
            filters.push(resellerIdFilter)
          }
        } else {
          const rsIds = resellerSupplierIdsCsv || []
          if (resellerEnterpriseIds.length > 0 && rsIds.length === 0) {
            filters.push(`enterprise_id=in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
          } else if (resellerEnterpriseIds.length > 0 && rsIds.length > 0) {
            const assignedFilter = `enterprise_id.in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`
            const unassignedFilter = `and(enterprise_id.is.null,supplier_id.in.(${rsIds.map((id) => encodeURIComponent(id)).join(',')}))`
            filters.push(`or=(${assignedFilter},${unassignedFilter})`)
          } else if (rsIds.length > 0) {
            filters.push(`and(enterprise_id.is.null,supplier_id.in.(${rsIds.map((id) => encodeURIComponent(id)).join(',')}))`)
          } else {
            const csvHeaders = ['simId', 'iccid', 'imsi', 'msisdn', 'status', 'lifecycleSubStatus', 'upstreamStatus', 'upstreamStatusUpdatedAt', 'formFactor', 'activationCode', ...(includeSensitive ? ['supplierId', 'supplierName', 'operatorId', 'operatorName', 'mcc', 'mnc'] : []), 'apn', ...(includeSensitive ? ['resellerId', 'resellerName'] : []), 'enterpriseId', 'enterpriseName', 'departmentId', 'departmentName', 'activationDate', 'totalUsageBytes', 'imei']
            res.setHeader('Content-Type', 'text/csv; charset=utf-8')
            res.setHeader('Content-Disposition', 'attachment; filename="sims.csv"')
            res.send(`${csvHeaders.map(escapeCsv).join(',')}\n`)
            return
          }
        }
      } else {
        filters.push(`enterprise_id=in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
      }
    }
    if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
    if (iccid) filters.push(`iccid=eq.${encodeURIComponent(iccid)}`)
    if (msisdn) filters.push(`msisdn=eq.${encodeURIComponent(msisdn)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
    appendOperatorFilter(filters, operatorFilter)

    const filterQs = filters.length ? `&${filters.join('&')}` : ''
    const simSelectFields = [
      'sim_id', 'iccid', 'primary_imsi', 'msisdn', 'status', 'apn', 'activation_date', 'bound_imei', 'activation_code',
      'supplier_id', 'operator_id',
      ...(hasSimResellerColumn ? ['reseller_id'] : []),
      'enterprise_id', 'department_id', 'form_factor', 'upstream_status', 'upstream_status_updated_at', 'created_at',
      'suppliers(name)', 'operators(name)',
    ].join(',')
    const { data } = await supabase.selectWithCount(
      'sims',
      `select=${simSelectFields}&order=iccid.asc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )
    const rows = Array.isArray(data) ? data : []
    const businessOperatorMap = await loadBusinessOperatorMap(
      supabase,
      rows.map((r) => r.operator_id)
    )

    const enterpriseIds = Array.from(new Set(rows.map((r) => r.enterprise_id).filter(Boolean).map((v) => String(v))))
    const departmentIds = Array.from(new Set(rows.map((r) => r.department_id).filter(Boolean).map((v) => String(v))))
    const supplierIds = Array.from(new Set(rows.map((r) => r.supplier_id).filter(Boolean).map((v) => String(v))))
    const tenantIds = Array.from(new Set([...enterpriseIds, ...departmentIds]))
    let tenantNameMap = new Map()
    let tenantParentMap = new Map()
    let resellerNameMap = new Map()
    let supplierResellerMap = new Map()
    if (supplierIds.length) {
      const supplierRows = await supabase.select(
        'reseller_suppliers',
        `select=supplier_id,reseller_id&supplier_id=in.(${supplierIds.map((id) => encodeURIComponent(id)).join(',')})`
      )
      supplierResellerMap = new Map(
        (Array.isArray(supplierRows) ? supplierRows : [])
          .filter((row) => row?.supplier_id && row?.reseller_id)
          .map((row) => [String(row.supplier_id), String(row.reseller_id)])
      )
    }

    if (tenantIds.length) {
      const tRows = await supabase.select('tenants', `select=tenant_id,name,parent_id&tenant_id=in.(${tenantIds.map((id) => encodeURIComponent(id)).join(',')})`)
      const tRowsArr = Array.isArray(tRows) ? tRows : []
      tenantNameMap = new Map(tRowsArr.map((t) => [String(t.tenant_id), t.name ?? null]))
      tenantParentMap = new Map(tRowsArr.map((t) => [String(t.tenant_id), t.parent_id ? String(t.parent_id) : null]))

      const resellerIds = Array.from(new Set(tRowsArr.map((t) => t.parent_id).filter(Boolean).map((v) => String(v))))
      const directResellerIds = hasSimResellerColumn
        ? Array.from(new Set(rows.map((r) => r.reseller_id).filter(Boolean).map((v) => String(v))))
        : []
      const allResellerIds = Array.from(new Set([
        ...resellerIds,
        ...directResellerIds,
        ...(!hasSimResellerColumn ? Array.from(supplierResellerMap.values()) : []),
      ]))
      if (allResellerIds.length) {
        const rRows = await supabase.select('tenants', `select=tenant_id,name&tenant_id=in.(${allResellerIds.map((id) => encodeURIComponent(id)).join(',')})`)
        resellerNameMap = new Map((Array.isArray(rRows) ? rRows : []).map((t) => [String(t.tenant_id), t.name ?? null]))
      }
    }

    const headers = [
      'simId',
      'iccid',
      'imsi',
      'msisdn',
      'status',
      'lifecycleSubStatus',
      'upstreamStatus',
      'upstreamStatusUpdatedAt',
      'formFactor',
      'activationCode',
      ...(includeSensitive ? ['supplierId', 'supplierName', 'operatorId', 'operatorName', 'mcc', 'mnc'] : []),
      'apn',
      ...(includeSensitive ? ['resellerId', 'resellerName'] : []),
      'enterpriseId',
      'enterpriseName',
      'departmentId',
      'departmentName',
      'activationDate',
      'totalUsageBytes',
      'imei',
    ]

    const csvRows = [headers.map(escapeCsv).join(',')]
    for (const r of rows) {
      const resolvedResellerId = hasSimResellerColumn && r.reseller_id
        ? String(r.reseller_id)
        : (r.enterprise_id
            ? tenantParentMap.get(String(r.enterprise_id)) ?? null
            : (r.supplier_id ? supplierResellerMap.get(String(r.supplier_id)) ?? null : null))
      const operator = r.operator_id ? businessOperatorMap.get(String(r.operator_id)) : null
      csvRows.push([
        escapeCsv(r.sim_id ?? ''),
        escapeCsv(r.iccid ?? ''),
        escapeCsv(r.primary_imsi ?? ''),
        escapeCsv(r.msisdn ?? ''),
        escapeCsv(r.status ?? ''),
        escapeCsv(''),
        escapeCsv(r.upstream_status ?? ''),
        escapeCsv(toIsoDateTime(r.upstream_status_updated_at) ?? ''),
        escapeCsv(r.form_factor ?? ''),
        escapeCsv(r.activation_code ?? ''),
        ...(includeSensitive ? [
          escapeCsv(r.supplier_id ?? ''),
          escapeCsv(r.suppliers?.name ?? ''),
          escapeCsv(operator?.operator_id ?? r.operator_id ?? ''),
          escapeCsv(operator?.name ?? r.operators?.name ?? ''),
          escapeCsv(operator?.mcc ?? ''),
          escapeCsv(operator?.mnc ?? ''),
        ] : []),
        escapeCsv(r.apn ?? ''),
        ...(includeSensitive ? [
          escapeCsv(resolvedResellerId ?? ''),
          escapeCsv(resolvedResellerId ? resellerNameMap.get(resolvedResellerId) ?? '' : ''),
        ] : []),
        escapeCsv(r.enterprise_id ?? ''),
        escapeCsv(r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? '' : ''),
        escapeCsv(r.department_id ?? ''),
        escapeCsv(r.department_id ? tenantNameMap.get(String(r.department_id)) ?? '' : ''),
        escapeCsv(toIsoDateTime(r.activation_date) ?? ''),
        escapeCsv(''),
        escapeCsv(r.bound_imei ?? ''),
      ].join(','))
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="sims.csv"')
    {
      const filterPairs = []
      if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
      if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
      if (resellerId) filterPairs.push(`resellerId=${resellerId}`)
      if (iccid) filterPairs.push(`iccid=${iccid}`)
      if (msisdn) filterPairs.push(`msisdn=${msisdn}`)
      if (status) filterPairs.push(`status=${status}`)
      if (supplierId) filterPairs.push(`supplierId=${supplierId}`)
      if (operatorId) filterPairs.push(`operatorId=${operatorId}`)
      filterPairs.push(`page=${page}`)
      if (pageSize) filterPairs.push(`pageSize=${pageSize}`)
      filterPairs.push(`limit=${limit}`)
      setXFilters(res, filterPairs.join(';'))
    }
    res.send(`${csvRows.join('\n')}\n`)
  }

  app.get(`${prefix}/sims:csv`, simCsvHandler)
  app.get(`${prefix}/enterprises/:enterpriseId/sims:csv`, simCsvHandler)

  app.post(`${prefix}/sims/import-jobs`, async (req, res) => {
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
    let bodyBuffer
    try {
      bodyBuffer = await readRequestBody(req, 50 * 1024 * 1024)
    } catch {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large.')
    }
    const { fields, files } = parseMultipartFormData(bodyBuffer, boundaryMatch[1])
    if (auth.scope !== 'reseller' && auth.scope !== 'platform') {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }
    const authResellerId = auth?.resellerId ? String(auth.resellerId).trim() : null
    const resellerId = fields.resellerId ? String(fields.resellerId).trim() : null
    const supplierId = fields.supplierId ? String(fields.supplierId).trim() : null
    const batchId = fields.batchId ? String(fields.batchId).trim() : null
    const apn = fields.apn ? String(fields.apn).trim() : null
    const operatorId = fields.operatorId ? String(fields.operatorId).trim() : null
    if (!resellerId || !isValidUuid(resellerId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId is required and must be a valid uuid.')
    }
    if (auth.scope === 'reseller') {
      if (!authResellerId || !isValidUuid(authResellerId)) {
        return sendError(res, 403, 'FORBIDDEN', 'Invalid reseller context.')
      }
      if (resellerId !== authResellerId) {
        return sendError(res, 403, 'FORBIDDEN', 'resellerId is out of scope.')
      }
    }
    if (!supplierId || !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
    }
    if (!apn) {
      return sendError(res, 400, 'BAD_REQUEST', 'apn is required.')
    }
    if (!operatorId || !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
    }
    const file = files.file
    if (!file || !file.content) {
      return sendError(res, 400, 'INVALID_FORMAT', 'file is required.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const enterpriseId = null
    const csvText = String(file.content ?? '')
    const result = await runSimImport({
      supabase,
      csvText,
      supplierId,
      apn,
      operatorId,
      enterpriseId,
      batchId,
      traceId: getTraceId(res),
      actorUserId: auth.userId ?? null,
      actorRole: auth.role ?? null,
      resellerId,
      sourceIp: req.ip,
    })
    if (!result.ok) {
      return sendError(res, result.status, result.code, result.message)
    }
    res.status(202).json({
      jobId: result.jobId,
      status: result.status,
      totalRows: result.totalRows,
      createdAt: result.createdAt,
    })
  })

  app.post(`${prefix}/sims`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const {
      iccid: iccidRaw,
      imsi,
      secondaryImsi1,
      secondaryImsi2,
      secondaryImsi3,
      msisdn,
      apn,
      supplierId,
      operatorId,
      enterpriseId: enterpriseIdBody,
      formFactor,
      activationCode,
      imei,
      imeiLockEnabled,
    } = req.body ?? {}
    const iccid = normalizeIccid(iccidRaw)
    if (!iccid || !isValidIccid(iccid)) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
    }
    const imsiValue = String(imsi ?? '').trim()
    if (!imsiValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'imsi is required.')
    }
    const apnValue = String(apn ?? '').trim()
    if (!apnValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'apn is required.')
    }
    const supplierIdValue = supplierId ? String(supplierId).trim() : null
    const operatorIdValue = operatorId ? String(operatorId).trim() : null
    if (!supplierIdValue || !isValidUuid(supplierIdValue)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId is required and must be a valid uuid.')
    }
    if (!operatorIdValue || !isValidUuid(operatorIdValue)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId is required and must be a valid uuid.')
    }
    if (enterpriseIdBody && !isValidUuid(enterpriseIdBody)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const formFactorRaw = formFactor ? String(formFactor).trim() : ''
    const allowedFormFactors = new Set(['consumer_removable', 'industrial_removable', 'consumer_embedded', 'industrial_embedded'])
    if (formFactorRaw && !allowedFormFactors.has(formFactorRaw)) {
      return sendError(res, 400, 'BAD_REQUEST', 'formFactor is invalid.')
    }
    const imeiValue = imei ? String(imei).trim() : ''
    if (imeiValue && !/^\d{15}$/.test(imeiValue)) {
      return sendError(res, 400, 'BAD_REQUEST', 'imei must be 15 digits.')
    }
    if (imeiLockEnabled === true && !imeiValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'imei is required when imeiLockEnabled is true.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    let enterpriseId = enterpriseIdBody ? String(enterpriseIdBody).trim() : null
    if (auth.scope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!enterpriseId) return
    }
    const operatorRows = await supabase.select(
      'operators',
      `select=operator_id&operator_id=eq.${encodeURIComponent(operatorIdValue)}&supplier_id=eq.${encodeURIComponent(supplierIdValue)}&limit=1`
    )
    const operator = Array.isArray(operatorRows) ? operatorRows[0] : null
    if (!operator?.operator_id) {
      return sendError(res, 400, 'INVALID_OPERATOR', 'Operator is not linked to supplier.')
    }
    const businessRows = await supabase.select(
      'business_operators',
      `select=operator_id&operator_id=eq.${encodeURIComponent(operatorIdValue)}&limit=1`
    )
    const business = Array.isArray(businessRows) ? businessRows[0] : null
    if (!business?.operator_id) {
      return sendError(res, 400, 'INVALID_OPERATOR', 'Operator is not found in business operators.')
    }
    const existingRows = await supabase.select('sims', `select=sim_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`)
    const existing = Array.isArray(existingRows) ? existingRows[0] : null
    if (existing) {
      return sendError(res, 409, 'DUPLICATE_ICCID', 'ICCID already exists.')
    }
    const insertPayload = {
      iccid,
      primary_imsi: imsiValue,
      imsi_secondary_1: secondaryImsi1 ? String(secondaryImsi1).trim() : null,
      imsi_secondary_2: secondaryImsi2 ? String(secondaryImsi2).trim() : null,
      imsi_secondary_3: secondaryImsi3 ? String(secondaryImsi3).trim() : null,
      msisdn: msisdn ? String(msisdn).trim() : null,
      supplier_id: supplierIdValue,
      operator_id: operator.operator_id,
      enterprise_id: enterpriseId ?? null,
      status: 'INVENTORY',
      apn: apnValue,
      bound_imei: imeiValue || null,
      activation_code: activationCode ? String(activationCode).trim() : null,
      last_status_change_at: new Date().toISOString(),
    }
    if (formFactorRaw) {
      insertPayload.form_factor = formFactorRaw
    }
    const rows = await supabase.insert('sims', insertPayload)
    const sim = Array.isArray(rows) ? rows[0] : null
    res.status(201).json({
      simId: sim?.sim_id ?? null,
      iccid,
      status: sim?.status ?? 'INVENTORY',
      createdAt: sim?.created_at ?? new Date().toISOString(),
    })
  })

  app.get(`${prefix}/enterprises/:enterpriseId/sims`, async (req, res) => {
    const auth = ensureSimReadAccess(req, res)
    if (!auth) return
    const enterpriseIdParam = String(req.params.enterpriseId || '').trim()
    if (!enterpriseIdParam || !isValidUuid(enterpriseIdParam)) {
      return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const roleScope = getRoleScope(req)
    const role = req?.cmpAuth?.role ? String(req.cmpAuth.role) : null
    let enterpriseId = enterpriseIdParam
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam)
      if (!enterpriseId) return
    } else if (roleScope === 'customer' || roleScope === 'department') {
      const fromReq = getEnterpriseIdFromReq(req)
      if (!fromReq || String(fromReq) !== enterpriseIdParam) {
        return sendError(res, 403, 'FORBIDDEN', 'Enterprise scope required.')
      }
    } else if (!(roleScope === 'platform' || role === 'platform_admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
    }

    const iccidRaw = req.query.iccid ? normalizeIccid(req.query.iccid) : null
    const msisdn = req.query.msisdn ? String(req.query.msisdn) : null
    const status = req.query.status ? String(req.query.status) : null
    const supplierId = req.query.supplierId ? String(req.query.supplierId) : null
    const operatorId = req.query.operatorId ? String(req.query.operatorId) : null
    const departmentIdQuery = req.query.departmentId ? String(req.query.departmentId) : null
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : (req.query.limit ? Number(req.query.limit) : 20)
    const page = req.query.page ? Number(req.query.page) : 1
    const limit = Math.min(100, Math.max(1, pageSize))
    const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
    if (iccidRaw && !/^\d{1,20}$/.test(iccidRaw)) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
    }
    if (supplierId && !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    let operatorFilter = null
    if (operatorId) {
      const resolved = await resolveOperatorFilter(supabase, operatorId, supplierId)
      if (!resolved) {
        return res.json({ items: [], total: 0, page, pageSize: limit })
      }
      operatorFilter = resolved
    }
    const departmentId = roleScope === 'department' ? getDepartmentIdFromReq(req) : await resolveDepartmentForEnterprise(req, res, supabase, enterpriseId, departmentIdQuery)
    if (departmentIdQuery && roleScope !== 'department' && departmentIdQuery && !departmentId) return

    const filters = []
    filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
    if (iccidRaw) {
      if (iccidRaw.length >= 18) {
        filters.push(`iccid=eq.${encodeURIComponent(iccidRaw)}`)
      } else {
        filters.push(`iccid=ilike.${encodeURIComponent(iccidRaw + '%')}`)
      }
    }
    if (msisdn) filters.push(`msisdn=eq.${encodeURIComponent(msisdn)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
    appendOperatorFilter(filters, operatorFilter)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const { data, total } = await supabase.selectWithCount(
      'sims',
      `select=sim_id,iccid,primary_imsi,msisdn,status,apn,activation_date,bound_imei,activation_code,supplier_id,operator_id,enterprise_id,department_id,form_factor,upstream_status,upstream_status_updated_at,created_at,suppliers(name),operators(name)&order=iccid.asc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )

    const rows = Array.isArray(data) ? data : []
    const businessOperatorMap = await loadBusinessOperatorMap(
      supabase,
      rows.map((r) => r.operator_id)
    )
    const enterpriseIds = Array.from(new Set(rows.map((r) => r.enterprise_id).filter(Boolean).map((v) => String(v))))
    const departmentIds = Array.from(new Set(rows.map((r) => r.department_id).filter(Boolean).map((v) => String(v))))
    const tenantIds = Array.from(new Set([...enterpriseIds, ...departmentIds]))
    let tenantNameMap = new Map()
    if (tenantIds.length) {
      const tRows = await supabase.select('tenants', `select=tenant_id,name&tenant_id=in.(${tenantIds.map((id) => encodeURIComponent(id)).join(',')})`)
      tenantNameMap = new Map((Array.isArray(tRows) ? tRows : []).map((t) => [String(t.tenant_id), t.name ?? null]))
    }

    const includeSensitive = roleScope === 'platform' || roleScope === 'reseller'
    const items = rows.map((r) => {
      const businessOperator = r.operator_id ? businessOperatorMap.get(String(r.operator_id)) : null
      return {
      simId: r.sim_id,
      iccid: r.iccid,
      imsi: r.primary_imsi,
      msisdn: r.msisdn,
      status: r.status,
      lifecycleSubStatus: null,
      upstreamStatus: r.upstream_status ?? null,
      upstreamStatusUpdatedAt: r.upstream_status_updated_at ?? null,
      formFactor: r.form_factor ?? null,
      activationCode: r.activation_code ?? null,
      ...(includeSensitive ? {
        supplierId: r.supplier_id,
        supplierName: r.suppliers?.name ?? null,
        operatorId: businessOperator?.operator_id ?? r.operator_id ?? null,
        operatorName: businessOperator?.name ?? r.operators?.name ?? null,
        mcc: businessOperator?.mcc ?? null,
        mnc: businessOperator?.mnc ?? null,
      } : {}),
      enterpriseId: r.enterprise_id ?? null,
      enterpriseName: r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? null : null,
      departmentId: r.department_id ?? null,
      departmentName: r.department_id ? tenantNameMap.get(String(r.department_id)) ?? null : null,
      apn: r.apn,
      activationDate: toIsoDateTime(r.activation_date),
      totalUsageBytes: null,
      imei: r.bound_imei ?? null,
      }
    })

    {
      const filterPairs = []
      if (iccidRaw) filterPairs.push(`iccid=${iccidRaw}`)
      if (msisdn) filterPairs.push(`msisdn=${msisdn}`)
      if (status) filterPairs.push(`status=${status}`)
      if (supplierId) filterPairs.push(`supplierId=${supplierId}`)
      if (operatorId) filterPairs.push(`operatorId=${operatorId}`)
      filterPairs.push(`enterpriseId=${enterpriseId}`)
      if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
      filterPairs.push(`pageSize=${limit}`)
      filterPairs.push(`page=${page}`)
      setXFilters(res, filterPairs.join(';'))
    }
    res.json({
      items,
      total: typeof total === 'number' ? total : items.length,
      page,
      pageSize: limit,
    })
  })

  app.get(`${prefix}/sims`, async (req, res) => {
    const auth = ensureSimListAccess(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const roleScope = getRoleScope(req)
    const iccidRaw = req.query.iccid ? normalizeIccid(req.query.iccid) : null
    const msisdn = req.query.msisdn ? String(req.query.msisdn) : null
    const status = req.query.status ? String(req.query.status) : null
    const supplierId = req.query.supplierId ? String(req.query.supplierId) : null
    const operatorId = req.query.operatorId ? String(req.query.operatorId) : null
    const resellerIdQuery = req.query.resellerId ? String(req.query.resellerId) : null
    const enterpriseIdQuery = req.query.enterpriseId ? String(req.query.enterpriseId) : null
    const departmentIdQuery = req.query.departmentId ? String(req.query.departmentId) : null
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : (req.query.limit ? Number(req.query.limit) : 20)
    const page = req.query.page ? Number(req.query.page) : 1
    const limit = Math.min(100, Math.max(1, pageSize))
    const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
    if (iccidRaw && !/^\d{1,20}$/.test(iccidRaw)) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccid must be 1-20 digits.')
    }
    if (supplierId && !isValidUuid(supplierId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
    }
    if (operatorId && !isValidUuid(operatorId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'operatorId must be a valid uuid.')
    }
    if (resellerIdQuery && !isValidUuid(resellerIdQuery)) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    }
    let operatorFilter = null
    if (operatorId) {
      const resolved = await resolveOperatorFilter(supabase, operatorId, supplierId)
      if (!resolved) {
        return res.json({ items: [], total: 0, page, pageSize: limit })
      }
      operatorFilter = resolved
    }
    let enterpriseId = getEnterpriseIdFromReq(req)
    let resellerId = null
    let resellerTenantId = null
    if (roleScope === 'reseller') {
      const raw = auth?.resellerId ? String(auth.resellerId) : null
      if (raw) {
        const resolved = await resolveResellerIdentity(supabase, raw)
        if (resolved) {
          resellerId = resolved.resellerId
          resellerTenantId = resolved.tenantId
        }
      }
      if (enterpriseIdQuery) {
        enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdQuery)
        if (!enterpriseId) return
      }
    } else if (roleScope === 'platform') {
      if (enterpriseIdQuery) enterpriseId = enterpriseIdQuery
      if (resellerIdQuery) {
        const resolved = await resolveResellerIdentity(supabase, resellerIdQuery)
        if (resolved) {
          resellerId = resolved.resellerId
          resellerTenantId = resolved.tenantId
        } else {
          resellerId = resellerIdQuery
          resellerTenantId = resellerIdQuery
        }
      }
    }
    const departmentId = roleScope === 'department' ? getDepartmentIdFromReq(req) : await resolveDepartmentForEnterprise(req, res, supabase, enterpriseId, departmentIdQuery)
    if (departmentIdQuery && roleScope !== 'department' && departmentIdQuery && !departmentId) return

    const includeResellerInventory = !enterpriseId && roleScope === 'reseller' && !!resellerId
    const hasSimResellerColumn = await detectSimResellerColumn(supabase)
    let resellerEnterpriseIds = null
    let resellerSupplierIds = null
    const tenantIdForEnterprises = resellerTenantId || resellerId
    if (!enterpriseId && resellerId && tenantIdForEnterprises) {
      const resellerRows = await supabase.select('tenants', `select=tenant_id&parent_id=eq.${encodeURIComponent(tenantIdForEnterprises)}&tenant_type=eq.ENTERPRISE`)
      resellerEnterpriseIds = (Array.isArray(resellerRows) ? resellerRows : []).map((t) => String(t.tenant_id))
      if (!hasSimResellerColumn) {
        const resellerSupplierRows = await supabase.select('reseller_suppliers', `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerId)}`)
        resellerSupplierIds = Array.from(new Set(
          (Array.isArray(resellerSupplierRows) ? resellerSupplierRows : [])
            .map((row) => (row?.supplier_id ? String(row.supplier_id) : ''))
            .filter(Boolean)
        ))
      }
    }

    const filters = []
    if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
    if (!enterpriseId && resellerEnterpriseIds) {
      if (resellerId) {
        if (hasSimResellerColumn) {
          const resellerIdValues = [resellerId]
          if (resellerTenantId && resellerTenantId !== resellerId) resellerIdValues.push(resellerTenantId)
          const resellerIdFilter = resellerIdValues.length > 1
            ? `reseller_id=in.(${resellerIdValues.map((id) => encodeURIComponent(id)).join(',')})`
            : `reseller_id=eq.${encodeURIComponent(resellerId)}`
          if (resellerEnterpriseIds.length) {
            filters.push(`or=(enterprise_id.in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')}),${resellerIdFilter})`)
          } else {
            filters.push(resellerIdFilter)
          }
        } else {
          if (resellerEnterpriseIds.length > 0 && (!resellerSupplierIds || resellerSupplierIds.length === 0)) {
            filters.push(`enterprise_id=in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
          } else if (resellerEnterpriseIds.length > 0 && resellerSupplierIds && resellerSupplierIds.length > 0) {
            const assignedFilter = `enterprise_id.in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`
            const unassignedFilter = `and(enterprise_id.is.null,supplier_id.in.(${resellerSupplierIds.map((id) => encodeURIComponent(id)).join(',')}))`
            filters.push(`or=(${assignedFilter},${unassignedFilter})`)
          } else if (resellerSupplierIds && resellerSupplierIds.length > 0) {
            filters.push(`and(enterprise_id.is.null,supplier_id.in.(${resellerSupplierIds.map((id) => encodeURIComponent(id)).join(',')}))`)
          } else {
            return res.json({ items: [], total: 0, page, pageSize: limit })
          }
        }
      } else {
        filters.push(`enterprise_id=in.(${resellerEnterpriseIds.map((id) => encodeURIComponent(id)).join(',')})`)
      }
    }
    if (departmentId) filters.push(`department_id=eq.${encodeURIComponent(departmentId)}`)
    if (iccidRaw) {
      if (iccidRaw.length >= 18) {
        filters.push(`iccid=eq.${encodeURIComponent(iccidRaw)}`)
      } else {
        filters.push(`iccid=ilike.${encodeURIComponent(iccidRaw + '%')}`)
      }
    }
    if (msisdn) filters.push(`msisdn=eq.${encodeURIComponent(msisdn)}`)
    if (status) filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(supplierId)}`)
    appendOperatorFilter(filters, operatorFilter)
    const filterQs = filters.length ? `&${filters.join('&')}` : ''

    const simSelectFields = [
      'sim_id', 'iccid', 'primary_imsi', 'msisdn', 'status', 'apn', 'activation_date', 'bound_imei', 'activation_code',
      'supplier_id', 'operator_id',
      ...(hasSimResellerColumn ? ['reseller_id'] : []),
      'enterprise_id', 'department_id', 'form_factor', 'upstream_status', 'upstream_status_updated_at', 'created_at',
      'suppliers(name)', 'operators(name)',
    ].join(',')
    const { data, total } = await supabase.selectWithCount(
      'sims',
      `select=${simSelectFields}&order=iccid.asc&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}${filterQs}`
    )

    const rows = Array.isArray(data) ? data : []
    const businessOperatorMap = await loadBusinessOperatorMap(
      supabase,
      rows.map((r) => r.operator_id)
    )
    const enterpriseIds = Array.from(new Set(rows.map((r) => r.enterprise_id).filter(Boolean).map((v) => String(v))))
    const departmentIds = Array.from(new Set(rows.map((r) => r.department_id).filter(Boolean).map((v) => String(v))))
    const supplierIds = Array.from(new Set(rows.map((r) => r.supplier_id).filter(Boolean).map((v) => String(v))))
    const tenantIds = Array.from(new Set([...enterpriseIds, ...departmentIds]))
    let tenantNameMap = new Map()
    let tenantParentMap = new Map()
    let resellerNameMap = new Map()
    let supplierResellerMap = new Map()
    if (supplierIds.length) {
      const supplierRows = await supabase.select(
        'reseller_suppliers',
        `select=supplier_id,reseller_id&supplier_id=in.(${supplierIds.map((id) => encodeURIComponent(id)).join(',')})`
      )
      supplierResellerMap = new Map(
        (Array.isArray(supplierRows) ? supplierRows : [])
          .filter((row) => row?.supplier_id && row?.reseller_id)
          .map((row) => [String(row.supplier_id), String(row.reseller_id)])
      )
    }
    if (tenantIds.length) {
      const tRows = await supabase.select('tenants', `select=tenant_id,name,parent_id&tenant_id=in.(${tenantIds.map((id) => encodeURIComponent(id)).join(',')})`)
      const tRowsArr = Array.isArray(tRows) ? tRows : []
      tenantNameMap = new Map(tRowsArr.map((t) => [String(t.tenant_id), t.name ?? null]))
      tenantParentMap = new Map(tRowsArr.map((t) => [String(t.tenant_id), t.parent_id ? String(t.parent_id) : null]))
      const resellerIds = Array.from(new Set(tRowsArr.map((t) => t.parent_id).filter(Boolean).map((v) => String(v))))
      const directResellerIds = hasSimResellerColumn
        ? Array.from(new Set(rows.map((r) => r.reseller_id).filter(Boolean).map((v) => String(v))))
        : []
      const allResellerIds = Array.from(new Set([
        ...resellerIds,
        ...directResellerIds,
        ...(!hasSimResellerColumn ? Array.from(supplierResellerMap.values()) : []),
      ]))
      if (allResellerIds.length) {
        const rRows = await supabase.select('tenants', `select=tenant_id,name&tenant_id=in.(${allResellerIds.map((id) => encodeURIComponent(id)).join(',')})`)
        resellerNameMap = new Map((Array.isArray(rRows) ? rRows : []).map((t) => [String(t.tenant_id), t.name ?? null]))
      }
    }

    const includeReseller = roleScope === 'platform' || roleScope === 'reseller'
    const items = rows.map((r) => {
      const resellerId = includeReseller
        ? (hasSimResellerColumn && r.reseller_id
            ? String(r.reseller_id)
            : (r.enterprise_id
                ? tenantParentMap.get(String(r.enterprise_id)) ?? null
                : (r.supplier_id ? supplierResellerMap.get(String(r.supplier_id)) ?? null : null)))
        : null
      const businessOperator = r.operator_id ? businessOperatorMap.get(String(r.operator_id)) : null
      return {
        simId: r.sim_id,
        iccid: r.iccid,
        imsi: r.primary_imsi,
        msisdn: r.msisdn,
        status: r.status,
        lifecycleSubStatus: null,
        upstreamStatus: r.upstream_status ?? null,
        upstreamStatusUpdatedAt: r.upstream_status_updated_at ?? null,
        formFactor: r.form_factor ?? null,
        activationCode: r.activation_code ?? null,
        supplierId: r.supplier_id,
        supplierName: r.suppliers?.name ?? null,
        operatorId: businessOperator?.operator_id ?? r.operator_id ?? null,
        operatorName: businessOperator?.name ?? r.operators?.name ?? null,
        mcc: businessOperator?.mcc ?? null,
        mnc: businessOperator?.mnc ?? null,
        apn: r.apn,
        ...(includeReseller ? {
          resellerId,
          resellerName: resellerId ? resellerNameMap.get(resellerId) ?? null : null,
        } : {}),
        enterpriseId: r.enterprise_id ?? null,
        enterpriseName: r.enterprise_id ? tenantNameMap.get(String(r.enterprise_id)) ?? null : null,
        departmentId: r.department_id ?? null,
        departmentName: r.department_id ? tenantNameMap.get(String(r.department_id)) ?? null : null,
        activationDate: toIsoDateTime(r.activation_date),
        totalUsageBytes: null,
        imei: r.bound_imei ?? null,
      }
    })

    {
      const filterPairs = []
      if (iccidRaw) filterPairs.push(`iccid=${iccidRaw}`)
      if (msisdn) filterPairs.push(`msisdn=${msisdn}`)
      if (status) filterPairs.push(`status=${status}`)
      if (supplierId) filterPairs.push(`supplierId=${supplierId}`)
      if (operatorId) filterPairs.push(`operatorId=${operatorId}`)
      if (resellerId) filterPairs.push(`resellerId=${resellerId}`)
      if (enterpriseId) filterPairs.push(`enterpriseId=${enterpriseId}`)
      if (departmentId) filterPairs.push(`departmentId=${departmentId}`)
      filterPairs.push(`pageSize=${limit}`)
      filterPairs.push(`page=${page}`)
      setXFilters(res, filterPairs.join(';'))
    }
    res.json({
      items,
      total: typeof total === 'number' ? total : items.length,
      page,
      pageSize: limit,
    })
  })

  app.get(`${prefix}/sims/:simId`, async (req, res) => {
    const auth = ensureSimReadAccess(req, res)
    if (!auth) return
    const simIdResult = parseSimIdentifier(req.params.simId)
    if (!simIdResult.ok) {
      return sendError(res, simIdResult.status, simIdResult.code, simIdResult.message)
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })

    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,primary_imsi,msisdn,status,apn,activation_date,bound_imei,activation_code,supplier_id,operator_id,enterprise_id,department_id,form_factor,upstream_status,upstream_status_updated_at,created_at,suppliers(name),operators(name)&${simIdResult.field}=eq.${encodeURIComponent(simIdResult.value)}&limit=1`
    )
    let sim = Array.isArray(rows) ? rows[0] : null
    if (!sim && simIdResult.field === 'iccid') {
      const iccidValue = String(simIdResult.value || '').trim()
      const fallbackRows = await supabase.select(
        'sims',
        `select=sim_id,iccid,primary_imsi,msisdn,status,apn,activation_date,bound_imei,activation_code,supplier_id,operator_id,enterprise_id,department_id,form_factor,upstream_status,upstream_status_updated_at,created_at,suppliers(name),operators(name)&iccid=ilike.${encodeURIComponent(`%${iccidValue}%`)}&limit=20`
      )
      const candidates = Array.isArray(fallbackRows) ? fallbackRows : []
      const normalizeDigits = (value) => String(value || '').replace(/\D/g, '')
      const target = normalizeDigits(iccidValue)
      sim = candidates.find((row) => normalizeDigits(row.iccid) === target) ?? null
    }
    if (!sim) {
      return sendError(res, 404, 'NOT_FOUND', 'SIM not found.')
    }

    const roleScope = getRoleScope(req)
    const userEnterpriseId = getEnterpriseIdFromReq(req)

    let enterpriseName = null
    let departmentName = null
    let resellerId = null
    let resellerName = null

    if (sim.enterprise_id) {
      const entRows = await supabase.select('tenants', `select=tenant_id,name,parent_id&tenant_id=eq.${sim.enterprise_id}`)
      const ent = Array.isArray(entRows) ? entRows[0] : null
      if (ent) {
        enterpriseName = ent.name
        if (roleScope === 'reseller') {
          const authResellerId = auth.resellerId ? String(auth.resellerId) : null
          if (String(ent.parent_id) !== authResellerId) {
            return sendError(res, 403, 'FORBIDDEN', 'SIM enterprise does not belong to your reseller.')
          }
        }
        resellerId = ent.parent_id
        if (resellerId) {
          const resRows = await supabase.select('tenants', `select=name&tenant_id=eq.${resellerId}`)
          if (Array.isArray(resRows) && resRows[0]) {
            resellerName = resRows[0].name
          }
        }
      } else if (roleScope === 'reseller') {
        return sendError(res, 403, 'FORBIDDEN', 'SIM enterprise not found in tenant hierarchy.')
      }
    } else {
      if (roleScope === 'reseller') {
        return sendError(res, 403, 'FORBIDDEN', 'SIM is not assigned to any enterprise.')
      }
    }

    if (roleScope === 'customer' || roleScope === 'department') {
      if (!sim.enterprise_id || !userEnterpriseId || String(sim.enterprise_id) !== String(userEnterpriseId)) {
        return sendError(res, 403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
      }
      if (roleScope === 'department') {
        const userDeptId = getDepartmentIdFromReq(req)
        if (sim.department_id && String(sim.department_id) !== String(userDeptId)) {
          return sendError(res, 403, 'FORBIDDEN', 'SIM does not belong to your department.')
        }
      }
    }

    if (sim.department_id) {
      const deptRows = await supabase.select('tenants', `select=name&tenant_id=eq.${sim.department_id}`)
      if (Array.isArray(deptRows) && deptRows[0]) departmentName = deptRows[0].name
    }

    const businessOperatorRows = sim.operator_id
      ? await supabase.select(
        'business_operators',
        `select=operator_id,name,mcc,mnc&operator_id=eq.${encodeURIComponent(String(sim.operator_id))}&limit=1`
      )
      : []
    const businessOperator = Array.isArray(businessOperatorRows) ? businessOperatorRows[0] : null

    const includeReseller = roleScope === 'platform' || roleScope === 'reseller'

    res.json({
      simId: sim.sim_id,
      iccid: sim.iccid,
      imsi: sim.primary_imsi,
      msisdn: sim.msisdn,
      status: sim.status,
      lifecycleSubStatus: null,
      upstreamStatus: sim.upstream_status ?? null,
      upstreamStatusUpdatedAt: sim.upstream_status_updated_at ?? null,
      formFactor: sim.form_factor ?? null,
      activationCode: sim.activation_code ?? null,
      supplierId: sim.supplier_id,
      supplierName: sim.suppliers?.name ?? null,
      operatorId: sim.operator_id ?? null,
      operatorName: businessOperator?.name ?? sim.operators?.name ?? null,
      mcc: businessOperator?.mcc ?? null,
      mnc: businessOperator?.mnc ?? null,
      ...(includeReseller ? {
        resellerId,
        resellerName,
      } : {}),
      enterpriseId: sim.enterprise_id ?? null,
      enterpriseName,
      departmentId: sim.department_id ?? null,
      departmentName,
      apn: sim.apn,
      activationDate: toIsoDateTime(sim.activation_date),
      totalUsageBytes: null,
      imei: sim.bound_imei ?? null,
    })
  })

  app.get(`${prefix}/sims/:simId/state-history`, async (req, res) => {
    const auth = ensureSimReadAccess(req, res)
    if (!auth) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const simId = parseSimIdentifier(req.params.simId)
    if (!simId.ok) {
      return sendError(res, simId.status, simId.code, simId.message)
    }
    const roleScope = getRoleScope(req)
    const enterpriseIdInput = req.query.enterpriseId ? String(req.query.enterpriseId) : null
    let enterpriseId = getEnterpriseIdFromReq(req)
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdInput)
      if (!enterpriseId) return
    } else if (roleScope === 'platform' && enterpriseIdInput) {
      enterpriseId = enterpriseIdInput
    }
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : (req.query.limit ? Number(req.query.limit) : 20)
    const page = req.query.page ? Number(req.query.page) : 1
    const limit = Math.min(100, Math.max(1, pageSize))
    const tenantQs = buildSimTenantFilter(req, enterpriseId)
    const result = await fetchSimStateHistory({
      supabase,
      simIdentifier: simId,
      tenantQs,
      page,
      limit,
    })
    if (!result.ok) {
      return sendError(res, result.status, result.code, result.message)
    }
    res.json({
      simId: result.sim.sim_id,
      iccid: result.sim.iccid,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      items: result.items,
    })
  })

  const handleSimStatusChange = async ({ req, res, action, newStatus, allowedFrom, requireReason, auth, commitmentExempt }) => {
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const simId = parseSimIdentifier(req.params.simId)
    if (!simId.ok) {
      sendError(res, simId.status, simId.code, simId.message)
      return
    }
    const { reason, idempotencyKey, enterpriseId: enterpriseIdBody } = req.body ?? {}
    if (requireReason && !reason) {
      sendError(res, 400, 'BAD_REQUEST', 'reason is required.')
      return
    }
    const roleScope = getRoleScope(req)
    let enterpriseId = getEnterpriseIdFromReq(req)
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdBody ? String(enterpriseIdBody) : null)
      if (!enterpriseId) return
    } else if (roleScope === 'platform' && enterpriseIdBody) {
      enterpriseId = String(enterpriseIdBody)
    }
    const tenantQs = buildSimTenantFilter(req, enterpriseId)
    const result = await changeSimStatus({
      supabase,
      simIdentifier: simId,
      tenantQs,
      action,
      newStatus,
      allowedFrom,
      reason: reason ?? null,
      idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
      actor: auth,
      traceId: getTraceId(res),
      sourceIp: req.ip,
      pushSimStatusToUpstream,
      commitmentExempt: !!commitmentExempt,
    })
    if (!result.ok) {
      sendError(res, result.status, result.code, result.message)
      return
    }
    if (result.idempotent) {
      res.status(200).json({
        jobId: result.jobId,
        status: result.status,
        progress: result.progress,
      })
      return
    }
    res.status(202).json({
      jobId: result.jobId,
      status: result.status,
    })
  }

  app.post(`${prefix}/sims/:simId\\:activate`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    await handleSimStatusChange({
      req,
      res,
      action: 'SIM_ACTIVATE',
      newStatus: 'ACTIVATED',
      allowedFrom: new Set(['INVENTORY', 'TEST_READY', 'DEACTIVATED']),
      requireReason: false,
      auth,
    })
  })

  app.post(`${prefix}/sims/:simId\\:deactivate`, async (req, res) => {
    const auth = ensureResellerSales(req, res)
    if (!auth) return
    await handleSimStatusChange({
      req,
      res,
      action: 'SIM_DEACTIVATE',
      newStatus: 'DEACTIVATED',
      allowedFrom: new Set(['ACTIVATED', 'TEST_READY']),
      requireReason: true,
      auth,
    })
  })

  app.post(`${prefix}/sims/:simId\\:reactivate`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    await handleSimStatusChange({
      req,
      res,
      action: 'SIM_REACTIVATE',
      newStatus: 'ACTIVATED',
      allowedFrom: new Set(['DEACTIVATED']),
      requireReason: false,
      auth,
    })
  })

  app.post(`${prefix}/sims/:simId\\:retire`, async (req, res) => {
    const auth = ensureResellerAdmin(req, res)
    if (!auth) return
    const { confirm, commitmentExempt } = req.body ?? {}
    if (confirm !== true) {
      return sendError(res, 400, 'BAD_REQUEST', 'confirm must be true.')
    }
    await handleSimStatusChange({
      req,
      res,
      action: 'SIM_RETIRE',
      newStatus: 'RETIRED',
      allowedFrom: new Set(['DEACTIVATED']),
      requireReason: true,
      auth,
      commitmentExempt: !!commitmentExempt,
    })
  })

  app.post(`${prefix}/sims:batch-status-change`, async (req, res) => {
    const auth = ensureSimReadAccess(req, res)
    if (!auth) return
    const actor = req?.cmpAuth ?? null
    const { action, iccids, reason, enterpriseId: enterpriseIdBody, commitmentExempt, confirm } = req.body ?? {}
    const actionValue = String(action || '').trim().toUpperCase()
    if (!actionValue) {
      return sendError(res, 400, 'BAD_REQUEST', 'action is required.')
    }
    if (actionValue === 'RETIRE' && confirm !== true) {
      return sendError(res, 400, 'BAD_REQUEST', 'confirm must be true.')
    }
    // List of ICCIDs (18-20 digits) to process.
    // Format: ["89860012345678901234", "89860012345678901235"]
    const rawIccids = Array.isArray(iccids) ? iccids : []
    if (rawIccids.length === 0) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccids must be a non-empty array.')
    }
    if (rawIccids.length > 100) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccids must not exceed 100 items.')
    }
    const targetIds = rawIccids.map((v) => normalizeIccid(v))
    if (targetIds.some((v) => !v || !isValidIccid(v))) {
      return sendError(res, 400, 'BAD_REQUEST', 'iccids must be 18-20 digits.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const roleScope = getRoleScope(req)
    let enterpriseId = getEnterpriseIdFromReq(req)
    if (roleScope === 'reseller') {
      enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdBody ? String(enterpriseIdBody) : null)
      if (!enterpriseId && enterpriseIdBody) return
    } else if (roleScope === 'platform' && enterpriseIdBody) {
      enterpriseId = String(enterpriseIdBody)
    } else if (roleScope === 'customer' || roleScope === 'department') {
      if (!enterpriseId) {
        return sendError(res, 403, 'FORBIDDEN', 'enterpriseId is required.')
      }
      if (enterpriseIdBody && String(enterpriseIdBody) !== String(enterpriseId)) {
        return sendError(res, 403, 'FORBIDDEN', 'enterpriseId is out of scope.')
      }
    }
    const tenantQs = buildSimTenantFilter(req, enterpriseId)
    const result = await batchChangeSimStatus({
      supabase,
      simIds: targetIds,
      tenantQs,
      enterpriseId: enterpriseId ?? null,
      action: actionValue,
      reason: reason ?? null,
      actor,
      traceId: getTraceId(res),
      sourceIp: req.ip,
      pushSimStatusToUpstream,
      commitmentExempt: !!commitmentExempt,
    })
    if (!result.ok) {
      return sendError(res, result.status, result.code, result.message)
    }
    const statusCode = result.failed === 0 ? 200 : (result.succeeded === 0 ? 400 : 207)
    res.status(statusCode).json(result)
  })

  app.post(`${prefix}/sims:batch-deactivate`, async (req, res) => {
    try {
      const auth = ensureResellerAdmin(req, res)
      if (!auth) return
      const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
      const { reason, idempotencyKey, enterpriseId: enterpriseIdBody } = req.body ?? {}
      const roleScope = getRoleScope(req)
      let enterpriseId = getEnterpriseIdFromReq(req)
      if (roleScope === 'reseller') {
        enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdBody ? String(enterpriseIdBody) : null)
        if (!enterpriseId) return
      } else if (roleScope === 'platform' && enterpriseIdBody) {
        enterpriseId = String(enterpriseIdBody)
      }
      if (!enterpriseId) {
        return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
      }
      const result = await batchDeactivateSims({
        supabase,
        enterpriseId,
        reason: reason ?? null,
        idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
        actor: auth,
        traceId: getTraceId(res),
        sourceIp: req.ip,
        pushSimStatusToUpstream,
      })
      if (!result.ok) {
        return sendError(res, result.status, result.code, result.message)
      }
      if (result.idempotent) {
        return res.status(200).json({
          jobId: result.jobId,
          status: result.status,
          progress: result.progress,
        })
      }
      res.status(202).json({
        jobId: result.jobId,
        status: result.status,
        totalRows: result.totalRows,
      })
    } catch (err) {
      const status = Number(err?.status) || 500
      const code = err?.code || (err?.upstreamType ? 'UPSTREAM_ERROR' : 'INTERNAL_ERROR')
      const message = status >= 500 ? 'Unexpected error.' : String(err?.message || 'Unexpected error.')
      return sendError(res, status, code, message)
    }
  })
}
