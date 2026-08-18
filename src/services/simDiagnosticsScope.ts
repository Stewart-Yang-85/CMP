type ScopeSupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
}

export type SimDiagnosticsAccessInput = {
  supabase: ScopeSupabaseClient
  iccid: string
  roleScope: string | null
  role: string | null
  authResellerId: string | null
  userEnterpriseId: string | null
  userDepartmentId: string | null
}

export type SimDiagnosticsAccessResult =
  | { ok: true; sim: Record<string, unknown>; enterpriseIdForQuery: string | null }
  | { ok: false; status: number; code: string; message: string }

function isMissingSimResellerColumnError(err: unknown) {
  const text = String((err as { body?: string; message?: string })?.body ?? (err as Error)?.message ?? '').toLowerCase()
  return text.includes('column sims.reseller_id does not exist')
}

async function detectSimResellerColumn(supabase: ScopeSupabaseClient) {
  try {
    await supabase.select('sims', 'select=reseller_id&limit=1', { suppressMissingColumns: true })
    return true
  } catch (err) {
    if (isMissingSimResellerColumnError(err)) return false
    throw err
  }
}

async function buildResellerOwnerIds(supabase: ScopeSupabaseClient, resellerTenantId: string) {
  const ownerIds = new Set<string>([resellerTenantId])
  try {
    const rows = await supabase.select(
      'resellers',
      `select=id&tenant_id=eq.${encodeURIComponent(resellerTenantId)}&limit=1`,
      { suppressMissingColumns: true },
    )
    const row = Array.isArray(rows) ? (rows[0] as { id?: string } | undefined) : undefined
    if (row?.id) ownerIds.add(String(row.id))
  } catch {
    /* optional in some seeds */
  }
  return ownerIds
}

async function assertResellerCanReadSim(
  supabase: ScopeSupabaseClient,
  sim: Record<string, unknown>,
  resellerTenantId: string,
  hasSimResellerColumn: boolean,
): Promise<boolean> {
  const ownerIds = await buildResellerOwnerIds(supabase, resellerTenantId)
  if (hasSimResellerColumn && sim.reseller_id != null && String(sim.reseller_id) !== '') {
    if (ownerIds.has(String(sim.reseller_id))) return true
  }
  if (sim.enterprise_id) {
    const entRows = await supabase.select(
      'tenants',
      `select=parent_id&tenant_id=eq.${encodeURIComponent(String(sim.enterprise_id))}&limit=1`,
    )
    const ent = Array.isArray(entRows) ? (entRows[0] as { parent_id?: string | null }) : null
    if (ent && String(ent.parent_id || '') === resellerTenantId) return true
    return false
  }
  if (sim.supplier_id) {
    const rsRows = await supabase.select(
      'reseller_suppliers',
      `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerTenantId)}&supplier_id=eq.${encodeURIComponent(String(sim.supplier_id))}&limit=1`,
    )
    if (Array.isArray(rsRows) && rsRows.length > 0) return true
  }
  return false
}

async function loadSimByIccid(supabase: ScopeSupabaseClient, iccid: string, hasSimResellerColumn: boolean) {
  const cols = ['sim_id', 'iccid', 'enterprise_id', 'supplier_id', 'operator_id', 'department_id', 'apn']
  if (hasSimResellerColumn) cols.push('reseller_id')
  const rows = await supabase.select(
    'sims',
    `select=${cols.join(',')}&iccid=eq.${encodeURIComponent(iccid)}&limit=1`,
    { suppressMissingColumns: true },
  )
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) ?? null : null
}

export async function ensureSimDiagnosticsAccess(
  input: SimDiagnosticsAccessInput,
): Promise<SimDiagnosticsAccessResult> {
  const { supabase, iccid, roleScope, role, authResellerId, userEnterpriseId, userDepartmentId } = input
  const hasSimResellerColumn = await detectSimResellerColumn(supabase)
  const sim = await loadSimByIccid(supabase, iccid, hasSimResellerColumn)
  if (!sim) {
    return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND', message: 'sim not found in CMP inventory.' }
  }

  if (roleScope === 'platform' || role === 'platform_admin') {
    return { ok: true, sim, enterpriseIdForQuery: null }
  }

  if (roleScope === 'reseller') {
    if (!authResellerId) {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Reseller scope is required.' }
    }
    const allowed = await assertResellerCanReadSim(supabase, sim, String(authResellerId), hasSimResellerColumn)
    if (!allowed) {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'SIM is not in your reseller scope.' }
    }
    return { ok: true, sim, enterpriseIdForQuery: null }
  }

  if (roleScope === 'customer' || roleScope === 'department') {
    if (!userEnterpriseId || !sim.enterprise_id || String(sim.enterprise_id) !== String(userEnterpriseId)) {
      return { ok: false, status: 403, code: 'FORBIDDEN', message: 'SIM is not in your enterprise scope.' }
    }
    if (roleScope === 'department') {
      if (userDepartmentId && sim.department_id && String(sim.department_id) !== String(userDepartmentId)) {
        return { ok: false, status: 403, code: 'FORBIDDEN', message: 'SIM is not in your department scope.' }
      }
    }
    return { ok: true, sim, enterpriseIdForQuery: String(userEnterpriseId) }
  }

  return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Insufficient permissions.' }
}
