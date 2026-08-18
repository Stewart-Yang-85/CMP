export type BatchScopeSupabaseClient = {
  select: (table: string, queryString: string, options?: Record<string, unknown>) => Promise<unknown>
}

export type BatchLifecycleScopeContext = {
  roleScope: string | null
  role: string | null
  authResellerId: string | null
  userEnterpriseId: string | null
  userDepartmentId: string | null
  enterpriseIdFilter: string | null
  hasSimResellerColumn: boolean
}

export async function loadSimsByIccidsForScopeCheck(
  supabase: BatchScopeSupabaseClient,
  iccids: string[],
  hasSimResellerColumn: boolean,
): Promise<Record<string, unknown>[]> {
  const unique = Array.from(new Set(iccids.map((v) => String(v).trim()).filter(Boolean)))
  if (unique.length === 0) return []
  const inList = unique.map((i) => encodeURIComponent(i)).join(',')
  const cols = ['sim_id', 'iccid', 'enterprise_id', 'supplier_id', 'department_id']
  if (hasSimResellerColumn) cols.push('reseller_id')
  const rows = await supabase.select('sims', `select=${cols.join(',')}&iccid=in.(${inList})`)
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/**
 * Returns ICCIDs that exist in DB but are outside the caller's lifecycle tenant scope
 * (same rules as single-SIM assertSimLifecycleAccess).
 */
export async function findIccidsOutOfLifecycleScope(
  supabase: BatchScopeSupabaseClient,
  iccids: string[],
  simRows: Record<string, unknown>[],
  ctx: BatchLifecycleScopeContext,
  normalizeIccid: (value: unknown) => string,
  assertResellerCanReadSim: (
    supabase: BatchScopeSupabaseClient,
    sim: Record<string, unknown>,
    resellerTenantId: string,
    hasSimResellerColumn: boolean,
  ) => Promise<boolean>,
): Promise<string[]> {
  if (ctx.roleScope === 'platform' || ctx.role === 'platform_admin') {
    return []
  }

  const byIccid = new Map<string, Record<string, unknown>>()
  for (const row of simRows) {
    const key = normalizeIccid(row.iccid)
    if (key) byIccid.set(key, row)
  }

  const outOfScope: string[] = []
  for (const raw of iccids) {
    const iccid = normalizeIccid(raw)
    if (!iccid) continue
    const sim = byIccid.get(iccid)
    if (!sim) continue

    if (ctx.roleScope === 'reseller') {
      if (!ctx.authResellerId) {
        outOfScope.push(iccid)
        continue
      }
      if (ctx.enterpriseIdFilter) {
        if (!sim.enterprise_id || String(sim.enterprise_id) !== String(ctx.enterpriseIdFilter)) {
          outOfScope.push(iccid)
          continue
        }
      }
      const allowed = await assertResellerCanReadSim(
        supabase,
        sim,
        String(ctx.authResellerId),
        ctx.hasSimResellerColumn,
      )
      if (!allowed) outOfScope.push(iccid)
      continue
    }

    if (ctx.roleScope === 'customer' || ctx.roleScope === 'department') {
      if (
        !sim.enterprise_id ||
        !ctx.userEnterpriseId ||
        String(sim.enterprise_id) !== String(ctx.userEnterpriseId)
      ) {
        outOfScope.push(iccid)
        continue
      }
      if (ctx.roleScope === 'department') {
        const userDeptId = ctx.userDepartmentId
        if (sim.department_id && userDeptId && String(sim.department_id) !== String(userDeptId)) {
          outOfScope.push(iccid)
        }
      }
    }
  }

  return outOfScope
}
