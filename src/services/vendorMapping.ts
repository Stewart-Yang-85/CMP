type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  delete: (table: string, matchQueryString: string) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

type AuditContext = {
  actorUserId?: string | null
  actorRole?: string | null
  requestId?: string | null
  sourceIp?: string | null
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

async function writeAuditLog(supabase: SupabaseClient, payload: Record<string, unknown>) {
  await supabase.insert('audit_logs', payload, { returning: 'minimal' })
}

function normalizePage(value: unknown, fallback: number) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function normalizePageSize(value: unknown, fallback: number) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.min(200, Math.floor(num))
}

export async function createVendorProductMapping({
  supabase,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  payload: Record<string, any>
  audit?: AuditContext
}): Promise<ServiceResult<{
  mappingId: string
  packageVersionId: string
  supplierId: string
  externalProductId: string
  provisioningParameters: unknown
  createdAt: string
}>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const packageVersionId = String(payload?.packageVersionId || '').trim()
  const supplierId = String(payload?.supplierId || '').trim()
  const externalProductId = String(payload?.externalProductId || '').trim()
  if (!isValidUuid(packageVersionId)) {
    return toError(400, 'BAD_REQUEST', 'packageVersionId must be a valid uuid.')
  }
  if (!isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.')
  }
  if (!externalProductId) {
    return toError(400, 'BAD_REQUEST', 'externalProductId is required.')
  }
  const rows = await supabase.insert(
    'vendor_product_mappings',
    {
      package_version_id: packageVersionId,
      supplier_id: supplierId,
      external_product_id: externalProductId,
      provisioning_parameters: payload?.provisioningParameters ?? null,
    },
    { returning: 'representation' }
  )
  const mapping = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  if (!mapping?.mapping_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create vendor product mapping.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'VENDOR_MAPPING_CREATED',
    target_type: 'VENDOR_MAPPING',
    target_id: mapping.mapping_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      mappingId: mapping.mapping_id,
      packageVersionId: mapping.package_version_id,
      supplierId: mapping.supplier_id,
      externalProductId: mapping.external_product_id,
      provisioningParameters: mapping.provisioning_parameters ?? null,
    },
  })
  return {
    ok: true,
    value: {
      mappingId: mapping.mapping_id,
      packageVersionId: mapping.package_version_id,
      supplierId: mapping.supplier_id,
      externalProductId: mapping.external_product_id,
      provisioningParameters: mapping.provisioning_parameters ?? null,
      createdAt: mapping.created_at,
    },
  }
}

export async function listVendorProductMappings({
  supabase,
  supplierId,
  packageVersionId,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  supplierId?: string | null
  packageVersionId?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}): Promise<ServiceResult<{ items: Array<Record<string, unknown>>; total: number }>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  const filters: string[] = []
  if (supplierId) filters.push(`supplier_id=eq.${encodeURIComponent(String(supplierId))}`)
  if (packageVersionId) filters.push(`package_version_id=eq.${encodeURIComponent(String(packageVersionId))}`)
  const filterQs = filters.length ? `&${filters.join('&')}` : ''
  const rows = await supabase.select(
    'vendor_product_mappings',
    `select=mapping_id,package_version_id,supplier_id,external_product_id,provisioning_parameters,created_at&order=created_at.desc${filterQs}`
  )
  let items = Array.isArray(rows) ? rows : []
  const p = normalizePage(page, 1)
  const ps = normalizePageSize(pageSize, 20)
  const start = (p - 1) * ps
  const total = items.length
  items = items.slice(start, start + ps).map((row: any) => ({
    mappingId: row.mapping_id,
    packageVersionId: row.package_version_id,
    supplierId: row.supplier_id,
    externalProductId: row.external_product_id,
    provisioningParameters: row.provisioning_parameters ?? null,
    createdAt: row.created_at,
  }))
  return { ok: true, value: { items, total } }
}

export async function getVendorProductMapping({
  supabase,
  mappingId,
}: {
  supabase: SupabaseClient
  mappingId: string
}): Promise<ServiceResult<{
  mappingId: string
  packageVersionId: string
  supplierId: string
  externalProductId: string
  provisioningParameters: unknown
  createdAt: string
}>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!mappingId || !isValidUuid(mappingId)) {
    return toError(400, 'BAD_REQUEST', 'mappingId must be a valid uuid.')
  }
  const rows = await supabase.select(
    'vendor_product_mappings',
    `select=mapping_id,package_version_id,supplier_id,external_product_id,provisioning_parameters,created_at&mapping_id=eq.${encodeURIComponent(mappingId)}&limit=1`
  )
  const mapping = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  if (!mapping?.mapping_id) return toError(404, 'NOT_FOUND', 'vendor product mapping not found.')
  return {
    ok: true,
    value: {
      mappingId: mapping.mapping_id,
      packageVersionId: mapping.package_version_id,
      supplierId: mapping.supplier_id,
      externalProductId: mapping.external_product_id,
      provisioningParameters: mapping.provisioning_parameters ?? null,
      createdAt: mapping.created_at,
    },
  }
}

export async function updateVendorProductMapping({
  supabase,
  mappingId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  mappingId: string
  payload: Record<string, any>
  audit?: AuditContext
}): Promise<ServiceResult<{
  mappingId: string
  packageVersionId: string
  supplierId: string
  externalProductId: string
  provisioningParameters: unknown
  createdAt: string
}>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!mappingId || !isValidUuid(mappingId)) {
    return toError(400, 'BAD_REQUEST', 'mappingId must be a valid uuid.')
  }
  const beforeRows = await supabase.select(
    'vendor_product_mappings',
    `select=mapping_id,package_version_id,supplier_id,external_product_id,provisioning_parameters,created_at&mapping_id=eq.${encodeURIComponent(mappingId)}&limit=1`
  )
  const before = Array.isArray(beforeRows) ? (beforeRows[0] as Record<string, any>) : null
  const update: Record<string, unknown> = {}
  if (payload?.externalProductId !== undefined) {
    const value = String(payload.externalProductId || '').trim()
    if (!value) return toError(400, 'BAD_REQUEST', 'externalProductId cannot be empty.')
    update.external_product_id = value
  }
  if (payload?.provisioningParameters !== undefined) {
    update.provisioning_parameters = payload.provisioningParameters ?? null
  }
  if (!Object.keys(update).length) {
    return toError(400, 'BAD_REQUEST', 'No valid fields to update.')
  }
  const rows = await supabase.update(
    'vendor_product_mappings',
    `mapping_id=eq.${encodeURIComponent(mappingId)}`,
    update,
    { returning: 'representation' }
  )
  const mapping = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  if (!mapping?.mapping_id) return toError(404, 'NOT_FOUND', 'vendor product mapping not found.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'VENDOR_MAPPING_UPDATED',
    target_type: 'VENDOR_MAPPING',
    target_id: mappingId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: before
      ? {
          mappingId: before.mapping_id,
          packageVersionId: before.package_version_id,
          supplierId: before.supplier_id,
          externalProductId: before.external_product_id,
          provisioningParameters: before.provisioning_parameters ?? null,
        }
      : null,
    after_data: {
      mappingId: mapping.mapping_id,
      packageVersionId: mapping.package_version_id,
      supplierId: mapping.supplier_id,
      externalProductId: mapping.external_product_id,
      provisioningParameters: mapping.provisioning_parameters ?? null,
    },
  })
  return {
    ok: true,
    value: {
      mappingId: mapping.mapping_id,
      packageVersionId: mapping.package_version_id,
      supplierId: mapping.supplier_id,
      externalProductId: mapping.external_product_id,
      provisioningParameters: mapping.provisioning_parameters ?? null,
      createdAt: mapping.created_at,
    },
  }
}

export async function deleteVendorProductMapping({
  supabase,
  mappingId,
  audit,
}: {
  supabase: SupabaseClient
  mappingId: string
  audit?: AuditContext
}): Promise<ServiceResult<{ mappingId: string }>> {
  if (!supabase) return toError(500, 'INTERNAL_ERROR', 'supabase client is required.')
  if (!mappingId || !isValidUuid(mappingId)) {
    return toError(400, 'BAD_REQUEST', 'mappingId must be a valid uuid.')
  }
  const rows = await supabase.select(
    'vendor_product_mappings',
    `select=mapping_id,package_version_id,supplier_id,external_product_id,provisioning_parameters,created_at&mapping_id=eq.${encodeURIComponent(mappingId)}&limit=1`
  )
  const mapping = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  await supabase.delete('vendor_product_mappings', `mapping_id=eq.${encodeURIComponent(mappingId)}`)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'VENDOR_MAPPING_DELETED',
    target_type: 'VENDOR_MAPPING',
    target_id: mappingId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: mapping
      ? {
          mappingId: mapping.mapping_id,
          packageVersionId: mapping.package_version_id,
          supplierId: mapping.supplier_id,
          externalProductId: mapping.external_product_id,
          provisioningParameters: mapping.provisioning_parameters ?? null,
        }
      : null,
  })
  return { ok: true, value: { mappingId } }
}
