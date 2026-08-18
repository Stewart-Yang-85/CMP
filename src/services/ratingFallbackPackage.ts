import { actorUserIdForDb } from '../utils/actorUserId.js'
import { parsePagination } from '../utils/pagination.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

type AuditContext = {
  actorUserId?: string | null
}

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function mapMapping(row: any) {
  return {
    mappingId: row?.mapping_id ?? null,
    enterpriseId: row?.enterprise_id ?? null,
    resellerId: row?.reseller_id ?? null,
    supplierId: row?.supplier_id ?? null,
    operatorId: row?.operator_id ?? null,
    packageId: row?.package_id ?? null,
    status: row?.status ?? null,
    createdBy: row?.created_by ?? null,
    updatedBy: row?.updated_by ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

async function resolveResellerTenantId(supabase: SupabaseClient, resellerId: string) {
  if (!isValidUuid(resellerId)) return null
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return (row as any)?.tenant_id ? String((row as any).tenant_id) : null
}

async function resolveEnterpriseTenant(supabase: SupabaseClient, enterpriseId: string) {
  if (!isValidUuid(enterpriseId)) return null
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return (row as any)?.tenant_id ? row : null
}

async function supplierExists(supabase: SupabaseClient, supplierId: string) {
  if (!isValidUuid(supplierId)) return false
  const rows = await supabase.select(
    'suppliers',
    `select=supplier_id&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return Boolean((row as any)?.supplier_id)
}

async function resellerSupplierBindingExists(supabase: SupabaseClient, resellerId: string, supplierId: string) {
  const rows = await supabase.select(
    'reseller_suppliers',
    `select=reseller_id,supplier_id&reseller_id=eq.${encodeURIComponent(resellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return Boolean((row as any)?.supplier_id)
}

async function loadOperatorRowsForList(supabase: SupabaseClient, operatorId: string, supplierId?: string | null) {
  if (!isValidUuid(operatorId)) return null
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

async function resolveOperatorId(supabase: SupabaseClient, supplierId: string, operatorId: string) {
  if (!isValidUuid(operatorId)) return null
  const byOperatorRows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id&operator_id=eq.${encodeURIComponent(operatorId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  const byOperator = Array.isArray(byOperatorRows) ? byOperatorRows[0] : null
  if ((byOperator as any)?.operator_id) return String((byOperator as any).operator_id)

  const byBusinessRows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id&business_operator_id=eq.${encodeURIComponent(operatorId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`
  )
  const byBusiness = Array.isArray(byBusinessRows) ? byBusinessRows[0] : null
  return (byBusiness as any)?.operator_id ? String((byBusiness as any).operator_id) : null
}

async function validateFallbackPackage(
  supabase: SupabaseClient,
  input: { enterpriseId: string; resellerId: string; supplierId: string; operatorId: string; packageId: string }
): Promise<ServiceResult<null>> {
  const pkgRows = await supabase.select(
    'packages',
    `select=package_id,enterprise_id,status,carrier_service_id,price_plan_id&package_id=eq.${encodeURIComponent(input.packageId)}&limit=1`
  )
  const pkg = Array.isArray(pkgRows) ? pkgRows[0] : null
  if (!(pkg as any)?.package_id) return toError(404, 'NOT_FOUND', 'packageId is not found.')
  if (String((pkg as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(400, 'BAD_REQUEST', 'packageId must reference a PUBLISHED package.')
  }

  const enterpriseId = String((pkg as any).enterprise_id ?? '').trim()
  if (enterpriseId !== input.enterpriseId) {
    return toError(400, 'BAD_REQUEST', 'packageId is outside enterprise scope.')
  }
  const enterprise = await resolveEnterpriseTenant(supabase, enterpriseId)
  if (String((enterprise as any)?.parent_id ?? '').trim() !== input.resellerId) {
    return toError(400, 'BAD_REQUEST', 'packageId is outside reseller scope.')
  }

  const carrierServiceId = String((pkg as any).carrier_service_id ?? '').trim()
  const carrierRows = await supabase.select(
    'carrier_service_modules',
    `select=carrier_service_id,supplier_id,operator_id,roaming_profile_id,status&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const carrier = Array.isArray(carrierRows) ? carrierRows[0] : null
  if (!(carrier as any)?.carrier_service_id) return toError(400, 'BAD_REQUEST', 'package carrier service is not found.')
  if (String((carrier as any).status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(400, 'BAD_REQUEST', 'package carrier service must be PUBLISHED.')
  }
  if (String((carrier as any).supplier_id ?? '').trim() !== input.supplierId) {
    return toError(400, 'BAD_REQUEST', 'package carrier service supplier does not match mapping supplierId.')
  }
  if (String((carrier as any).operator_id ?? '').trim() !== input.operatorId) {
    return toError(400, 'BAD_REQUEST', 'package carrier service operator does not match mapping operatorId.')
  }
  if (!String((carrier as any).roaming_profile_id ?? '').trim()) {
    return toError(400, 'BAD_REQUEST', 'package carrier service must reference a roaming profile.')
  }

  const pricePlanId = String((pkg as any).price_plan_id ?? '').trim()
  const planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,type,covered_network_profile_id,status&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  const plan = Array.isArray(planRows) ? planRows[0] : null
  if (!(plan as any)?.price_plan_id) return toError(400, 'BAD_REQUEST', 'package price plan is not found.')
  if (String((plan as any).type ?? '').toUpperCase() !== 'FIXED_BUNDLE') {
    return toError(400, 'BAD_REQUEST', 'fallback package price plan must be FIXED_BUNDLE.')
  }
  const fixedRows = await supabase.select(
    'price_plan_fixed_bundle',
    `select=monthly_fee,deactivated_monthly_fee,total_quota_mb&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  const fixed = Array.isArray(fixedRows) ? fixedRows[0] : null
  if (Number((fixed as any)?.monthly_fee ?? NaN) !== 0 || Number((fixed as any)?.deactivated_monthly_fee ?? NaN) !== 0 || Number((fixed as any)?.total_quota_mb ?? NaN) !== 0) {
    return toError(400, 'BAD_REQUEST', 'fallback package fixed bundle fees and totalQuotaMb must be 0.')
  }

  const coveredNetworkProfileId = String((plan as any).covered_network_profile_id ?? '').trim()
  const coveredRows = await supabase.select(
    'covered_network_profiles',
    `select=covered_network_profile_id,coverage_mode,status&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}&limit=1`
  )
  const covered = Array.isArray(coveredRows) ? coveredRows[0] : null
  if (String((covered as any)?.coverage_mode ?? '').toUpperCase() !== 'NONE') {
    return toError(400, 'BAD_REQUEST', 'fallback package covered network profile must use coverageMode NONE.')
  }
  if (String((covered as any)?.status ?? '').toUpperCase() !== 'PUBLISHED') {
    return toError(400, 'BAD_REQUEST', 'fallback package covered network profile must be PUBLISHED.')
  }

  return { ok: true, value: null }
}

export async function listDefaultFallbackPackageMappings({
  supabase,
  enterpriseId,
  resellerId,
  supplierId,
  operatorId,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  enterpriseId?: string | null
  resellerId: string
  supplierId?: string | null
  operatorId?: string | null
  status?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: ReturnType<typeof mapMapping>[]; total: number; page: number; pageSize: number }>> {
  if (!isValidUuid(resellerId)) return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  if (enterpriseId && !isValidUuid(enterpriseId)) return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  if (supplierId && !isValidUuid(supplierId)) return toError(400, 'BAD_REQUEST', 'supplierId is invalid.')
  if (operatorId && !isValidUuid(operatorId)) return toError(400, 'BAD_REQUEST', 'operatorId is invalid.')
  const resolvedResellerId = await resolveResellerTenantId(supabase, resellerId)
  if (!resolvedResellerId) return toError(400, 'BAD_REQUEST', 'resellerId is not a valid RESELLER tenant.')
  if (enterpriseId) {
    const enterprise = await resolveEnterpriseTenant(supabase, String(enterpriseId))
    if (!enterprise) return toError(400, 'BAD_REQUEST', 'enterpriseId is not a valid ENTERPRISE tenant.')
    if (String((enterprise as any).parent_id ?? '').trim() !== resolvedResellerId) {
      return toError(403, 'FORBIDDEN', 'enterpriseId is outside reseller scope.')
    }
  }
  if (supplierId) {
    if (!(await supplierExists(supabase, String(supplierId)))) return toError(400, 'BAD_REQUEST', 'supplierId is not found.')
    if (!(await resellerSupplierBindingExists(supabase, resolvedResellerId, String(supplierId)))) {
      return toError(403, 'FORBIDDEN', 'supplierId is outside reseller scope.')
    }
  }
  let operatorFilterIds: string[] | null = null
  if (operatorId) {
    const operatorRows = await loadOperatorRowsForList(supabase, String(operatorId), supplierId ? String(supplierId) : null)
    if (!operatorRows?.length) {
      const anyRows = supplierId ? await loadOperatorRowsForList(supabase, String(operatorId), null) : []
      return toError(400, 'BAD_REQUEST', supplierId && anyRows?.length ? 'operatorId is not linked to supplierId.' : 'operatorId is not found.')
    }
    const inScopeRows = []
    for (const operator of operatorRows) {
      const operatorSupplierId = String((operator as any).supplier_id ?? '').trim()
      if (await resellerSupplierBindingExists(supabase, resolvedResellerId, operatorSupplierId)) {
        inScopeRows.push(operator)
      }
    }
    if (!inScopeRows.length) {
      return toError(403, 'FORBIDDEN', 'operatorId is outside reseller scope.')
    }
    operatorFilterIds = Array.from(new Set(inScopeRows.map((row: any) => String(row?.operator_id ?? '').trim()).filter(Boolean)))
  }
  const filters = [`reseller_id=eq.${encodeURIComponent(resellerId)}`]
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(String(enterpriseId))}`)
  if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(String(supplierId))}`)
  if (operatorFilterIds?.length === 1) filters.push(`operator_id=eq.${encodeURIComponent(operatorFilterIds[0])}`)
  if (operatorFilterIds && operatorFilterIds.length > 1) filters.push(`operator_id=in.(${operatorFilterIds.map((id) => encodeURIComponent(id)).join(',')})`)
  if (status) filters.push(`status=eq.${encodeURIComponent(String(status).toUpperCase())}`)
  const rows = await supabase.select(
    'default_fallback_package_mappings',
    `select=mapping_id,enterprise_id,reseller_id,supplier_id,operator_id,package_id,status,created_by,updated_by,created_at,updated_at&${filters.join('&')}&order=updated_at.desc`
  )
  const { page: currentPage, pageSize: limit, offset } = parsePagination(
    { page, pageSize },
    { defaultPage: 1, defaultPageSize: 20, maxPageSize: 20 }
  )
  const allItems = (Array.isArray(rows) ? rows : []).map(mapMapping)
  return {
    ok: true,
    value: {
      items: allItems.slice(offset, offset + limit),
      total: allItems.length,
      page: currentPage,
      pageSize: limit,
    },
  }
}

export async function setDefaultFallbackPackage({
  supabase,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<ReturnType<typeof mapMapping>>> {
  const resellerInput = String(payload?.resellerId ?? '').trim()
  const enterpriseInput = String(payload?.enterpriseId ?? '').trim()
  const supplierId = String(payload?.supplierId ?? '').trim()
  const operatorInput = String(payload?.operatorId ?? '').trim()
  const packageId = String(payload?.packageId ?? '').trim()
  if (!isValidUuid(enterpriseInput)) return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  if (!isValidUuid(resellerInput)) return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  if (!isValidUuid(supplierId)) return toError(400, 'BAD_REQUEST', 'supplierId is invalid.')
  if (!isValidUuid(operatorInput)) return toError(400, 'BAD_REQUEST', 'operatorId is invalid.')
  if (!isValidUuid(packageId)) return toError(400, 'BAD_REQUEST', 'packageId is invalid.')

  const resellerId = await resolveResellerTenantId(supabase, resellerInput)
  if (!resellerId) return toError(400, 'BAD_REQUEST', 'resellerId is not a valid RESELLER tenant.')
  const enterprise = await resolveEnterpriseTenant(supabase, enterpriseInput)
  if (!enterprise) return toError(400, 'BAD_REQUEST', 'enterpriseId is not a valid ENTERPRISE tenant.')
  const enterpriseId = String((enterprise as any).tenant_id)
  if (String((enterprise as any).parent_id ?? '').trim() !== resellerId) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is outside reseller scope.')
  }
  if (!(await supplierExists(supabase, supplierId))) return toError(400, 'BAD_REQUEST', 'supplierId is not found.')
  const operatorId = await resolveOperatorId(supabase, supplierId, operatorInput)
  if (!operatorId) return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.')

  const packageCheck = await validateFallbackPackage(supabase, { enterpriseId, resellerId, supplierId, operatorId, packageId })
  if (!packageCheck.ok) return packageCheck

  const nowIso = new Date().toISOString()
  const actor = actorUserIdForDb(audit?.actorUserId)
  const activeRows = await supabase.select(
    'default_fallback_package_mappings',
    `select=mapping_id,package_id&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&reseller_id=eq.${encodeURIComponent(resellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(operatorId)}&status=eq.ACTIVE&limit=1`
  )
  const active = Array.isArray(activeRows) ? activeRows[0] : null
  if ((active as any)?.mapping_id) {
    const mappingId = String((active as any).mapping_id)
    const activePackageId = String((active as any).package_id ?? '')
    return toError(
      409,
      'ACTIVE_FALLBACK_PACKAGE_EXISTS',
      `An ACTIVE fallback package mapping already exists for this enterprise/reseller/supplier/operator scope: mappingId=${mappingId}, packageId=${activePackageId}.`
    )
  }

  const rows = await supabase.insert(
    'default_fallback_package_mappings',
    {
      enterprise_id: enterpriseId,
      reseller_id: resellerId,
      supplier_id: supplierId,
      operator_id: operatorId,
      package_id: packageId,
      status: 'ACTIVE',
      created_by: actor,
      updated_by: actor,
      created_at: nowIso,
      updated_at: nowIso,
    },
    { returning: 'representation' }
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return { ok: true, value: mapMapping(row) }
}

export async function unsetDefaultFallbackPackage({
  supabase,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  payload: any
  audit?: AuditContext
}): Promise<ServiceResult<{ status: 'INACTIVE'; enterpriseId: string; resellerId: string; supplierId: string; operatorId: string }>> {
  const resellerInput = String(payload?.resellerId ?? '').trim()
  const enterpriseInput = String(payload?.enterpriseId ?? '').trim()
  const supplierId = String(payload?.supplierId ?? '').trim()
  const operatorInput = String(payload?.operatorId ?? '').trim()
  if (!isValidUuid(enterpriseInput)) return toError(400, 'BAD_REQUEST', 'enterpriseId is invalid.')
  if (!isValidUuid(resellerInput)) return toError(400, 'BAD_REQUEST', 'resellerId is invalid.')
  if (!isValidUuid(supplierId)) return toError(400, 'BAD_REQUEST', 'supplierId is invalid.')
  if (!isValidUuid(operatorInput)) return toError(400, 'BAD_REQUEST', 'operatorId is invalid.')
  const resellerId = await resolveResellerTenantId(supabase, resellerInput)
  if (!resellerId) return toError(400, 'BAD_REQUEST', 'resellerId is not a valid RESELLER tenant.')
  const enterprise = await resolveEnterpriseTenant(supabase, enterpriseInput)
  if (!enterprise) return toError(400, 'BAD_REQUEST', 'enterpriseId is not a valid ENTERPRISE tenant.')
  const enterpriseId = String((enterprise as any).tenant_id)
  if (String((enterprise as any).parent_id ?? '').trim() !== resellerId) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is outside reseller scope.')
  }
  if (!(await supplierExists(supabase, supplierId))) return toError(400, 'BAD_REQUEST', 'supplierId is not found.')
  const operatorId = await resolveOperatorId(supabase, supplierId, operatorInput)
  if (!operatorId) return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.')
  const activeRows = await supabase.select(
    'default_fallback_package_mappings',
    `select=mapping_id,package_id&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&reseller_id=eq.${encodeURIComponent(resellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(operatorId)}&status=eq.ACTIVE&limit=1`
  )
  const active = Array.isArray(activeRows) ? activeRows[0] : null
  if (!(active as any)?.mapping_id) {
    return toError(
      404,
      'ACTIVE_FALLBACK_PACKAGE_NOT_FOUND',
      'No ACTIVE fallback package mapping exists for this enterprise/reseller/supplier/operator scope.'
    )
  }
  await supabase.update(
    'default_fallback_package_mappings',
    `enterprise_id=eq.${encodeURIComponent(enterpriseId)}&reseller_id=eq.${encodeURIComponent(resellerId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(operatorId)}&status=eq.ACTIVE`,
    { status: 'INACTIVE', updated_by: actorUserIdForDb(audit?.actorUserId), updated_at: new Date().toISOString() },
    { returning: 'minimal' }
  )
  return { ok: true, value: { status: 'INACTIVE', enterpriseId, resellerId, supplierId, operatorId } }
}
