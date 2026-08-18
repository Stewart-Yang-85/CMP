/**
 * FR-058: RESELLER public id = tenants.tenant_id for the reseller row.
 */

export async function lookupResellerRecordId(supabase, resellerTenantId) {
  if (!resellerTenantId || !supabase) return null
  try {
    const rows = await supabase.select(
      'resellers',
      `select=id&tenant_id=eq.${encodeURIComponent(String(resellerTenantId))}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    return row?.id ? String(row.id) : null
  } catch {
    return null
  }
}

/**
 * From events.audit tenant_id (enterprise, reseller, or other), resolve the owning
 * RESELLER tenants.tenant_id, or null if unknown.
 */
export async function resolveResellerTenantIdFromContext(supabase, tenantId) {
  if (!tenantId || !supabase) return null
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(String(tenantId))}&limit=1`
  )
  const tenant = Array.isArray(rows) ? rows[0] : null
  if (!tenant) return null
  const tenantType = tenant.tenant_type ? String(tenant.tenant_type) : null
  if (tenantType === 'ENTERPRISE') {
    return tenant.parent_id ? String(tenant.parent_id) : null
  }
  if (tenantType === 'RESELLER') {
    return String(tenantId)
  }
  if (tenant.parent_id) {
    const parentRows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(String(tenant.parent_id))}&limit=1`
    )
    const parent = Array.isArray(parentRows) ? parentRows[0] : null
    if (parent?.tenant_type === 'ENTERPRISE') {
      return parent.parent_id ? String(parent.parent_id) : null
    }
  }
  return null
}
