import { computeMonthlyCharges } from '../billing.js'
import { transitionBillStatus } from './billStatusMachine.js'
import { resolveBillingSchedule } from './billingSchedule.js'

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
  actorRole?: string | null
  requestId?: string | null
  sourceIp?: string | null
}

function toError(status: number, code: string, message: string): ServiceResult<never> {
  return { ok: false, status, code, message }
}

function isValidPeriod(value: unknown) {
  return /^\d{4}-\d{2}$/.test(String(value || '').trim())
}

function toDateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

async function writeAuditLog(supabase: SupabaseClient, payload: Record<string, unknown>) {
  await supabase.insert('audit_logs', payload, { returning: 'minimal' })
}

function parsePeriod(period: string) {
  const [yearStr, monthStr] = String(period).split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const start = new Date(Date.UTC(year, month - 1, 1))
  const endExclusive = new Date(Date.UTC(year, month, 1))
  const endInclusive = new Date(Date.UTC(year, month, 0))
  return { start, endExclusive, endInclusive }
}

function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

async function loadEnterpriseList(supabase: SupabaseClient, enterpriseId?: string | null) {
  if (enterpriseId) {
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id,name&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const row = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
    return row ? [row] : []
  }
  const rows = await supabase.select('tenants', 'select=tenant_id,parent_id,name&tenant_type=eq.ENTERPRISE')
  return Array.isArray(rows) ? (rows as Record<string, any>[]) : []
}

function aggregateLineItems({
  lineItems,
  sims,
  packages,
  departments,
}: {
  lineItems: Record<string, any>[]
  sims: Record<string, any>[]
  packages: Record<string, any>[]
  departments: Record<string, any>[]
}) {
  const simMap = new Map<string, any>()
  const simMeta = new Map<string, any>()
  for (const sim of sims) {
    simMeta.set(String(sim.sim_id), sim)
  }
  const packageMeta = new Map<string, any>()
  for (const pkg of packages) {
    if (pkg?.package_version_id) packageMeta.set(String(pkg.package_version_id), pkg)
  }
  const departmentMeta = new Map<string, any>()
  for (const dept of departments) {
    if (dept?.tenant_id) departmentMeta.set(String(dept.tenant_id), dept)
  }
  const extraItems: Record<string, any>[] = []
  for (const item of lineItems) {
    const simId = item.sim_id ? String(item.sim_id) : null
    const pkgId = item.package_version_id ? String(item.package_version_id) : null
    if (!simId) {
      extraItems.push({
        sim_id: null,
        package_version_id: pkgId,
        item_type: 'PACKAGE_TOTAL',
        amount: Number(item.amount ?? 0),
        metadata: {
          description: item.metadata?.description ?? 'Package usage total',
          packageVersionId: pkgId,
          currency: item.metadata?.currency ?? null,
        },
      })
      continue
    }
    const current = simMap.get(simId) || {
      simId,
      packageVersionId: pkgId,
      monthlyFee: 0,
      usageCharge: 0,
      overageCharge: 0,
      usageKb: 0,
    }
    if (item.item_type === 'MONTHLY_FEE') {
      current.monthlyFee += Number(item.amount ?? 0)
      if (pkgId) current.packageVersionId = pkgId
    } else if (item.item_type === 'USAGE_CHARGE') {
      const chargeType = item.metadata?.chargeType
      if (String(chargeType).toUpperCase() === 'OVERAGE') {
        current.overageCharge += Number(item.amount ?? 0)
      } else {
        current.usageCharge += Number(item.amount ?? 0)
      }
      current.usageKb += Number(item.metadata?.chargedKb ?? 0)
      if (pkgId) current.packageVersionId = pkgId
    }
    simMap.set(simId, current)
  }
  const l3Items: Record<string, any>[] = []
  for (const entry of simMap.values()) {
    const sim = simMeta.get(entry.simId) || {}
    const pkg = entry.packageVersionId ? packageMeta.get(entry.packageVersionId) : null
    const dept = sim.department_id ? departmentMeta.get(String(sim.department_id)) : null
    const subtotal = Number((entry.monthlyFee + entry.usageCharge + entry.overageCharge).toFixed(2))
    const groupKey = sim.department_id ? String(sim.department_id) : entry.packageVersionId
    const groupType = sim.department_id ? 'DEPARTMENT' : entry.packageVersionId ? 'PACKAGE' : null
    l3Items.push({
      sim_id: entry.simId,
      package_version_id: entry.packageVersionId ?? null,
      item_type: 'SIM_TOTAL',
      amount: subtotal,
      group_key: groupKey ?? null,
      group_type: groupType,
      metadata: {
        iccid: sim.iccid ?? null,
        msisdn: sim.msisdn ?? null,
        departmentId: sim.department_id ?? null,
        departmentName: dept?.name ?? null,
        packageVersionId: entry.packageVersionId ?? null,
        packageName: pkg?.packages?.name ?? null,
        monthlyFee: Number(entry.monthlyFee.toFixed(2)),
        usageCharge: Number(entry.usageCharge.toFixed(2)),
        overageCharge: Number(entry.overageCharge.toFixed(2)),
        usageKb: Math.floor(entry.usageKb),
        subtotal,
      },
    })
  }
  return { l3Items, extraItems }
}

async function loadPackageVersions(supabase: SupabaseClient, packageVersionIds: string[]) {
  if (!packageVersionIds.length) return []
  const idFilter = packageVersionIds.map((id) => encodeURIComponent(id)).join(',')
  const rows = await supabase.select(
    'package_versions',
    `select=package_version_id,packages(name)&package_version_id=in.(${idFilter})`
  )
  return Array.isArray(rows) ? (rows as Record<string, any>[]) : []
}

async function loadDepartments(supabase: SupabaseClient, departmentIds: string[]) {
  if (!departmentIds.length) return []
  const idFilter = departmentIds.map((id) => encodeURIComponent(id)).join(',')
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,name&tenant_id=in.(${idFilter})&tenant_type=eq.DEPARTMENT`
  )
  return Array.isArray(rows) ? (rows as Record<string, any>[]) : []
}

export async function runBillingGenerate({
  supabase,
  period,
  enterpriseId,
  resellerId,
  autoPublish,
  actorUserId,
  actorRole,
  requestId,
  sourceIp,
  jobId,
}: {
  supabase: SupabaseClient
  period: string
  enterpriseId?: string | null
  resellerId?: string | null
  autoPublish?: boolean | null
  actorUserId?: string | null
  actorRole?: string | null
  requestId?: string | null
  sourceIp?: string | null
  jobId?: string | null
}): Promise<ServiceResult<Record<string, any>>> {
  if (!isValidPeriod(period)) {
    return toError(400, 'BAD_REQUEST', 'period must be YYYY-MM.')
  }
  const { start, endExclusive, endInclusive } = parsePeriod(period)
  const enterprises = await loadEnterpriseList(supabase, enterpriseId ?? null)
  if (!enterprises.length) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'No enterprises found to bill.')
  }
  const schedule = await resolveBillingSchedule({
    supabase,
    enterpriseId: enterpriseId ?? null,
    resellerId: resellerId ?? null,
  })
  if (!schedule.ok) return schedule
  const results: Record<string, any>[] = []
  for (const enterprise of enterprises) {
    const calc = await computeMonthlyCharges({
      enterpriseId: enterprise.tenant_id,
      billPeriod: period,
      calculationId: jobId || `calc-${Date.now()}`,
    }, supabase)
    if (!calc) continue
    const existing = await supabase.select(
      'bills',
      `select=bill_id&enterprise_id=eq.${encodeURIComponent(enterprise.tenant_id)}&period_start=eq.${encodeURIComponent(toDateOnly(start))}&period_end=eq.${encodeURIComponent(toDateOnly(endInclusive))}&limit=1`
    )
    if (Array.isArray(existing) && existing.length) {
      continue
    }
    const simsRows = await supabase.select(
      'sims',
      `select=sim_id,iccid,msisdn,department_id&enterprise_id=eq.${encodeURIComponent(enterprise.tenant_id)}`
    )
    const sims = Array.isArray(simsRows) ? (simsRows as Record<string, any>[]) : []
    const departmentIds = Array.from(new Set(sims.map((s) => s.department_id).filter(Boolean).map(String)))
    const packageIds = Array.from(new Set<string>(calc.lineItems.map((i: any) => i.package_version_id).filter(Boolean).map(String)))
    const [departments, packages] = await Promise.all([
      loadDepartments(supabase, departmentIds),
      loadPackageVersions(supabase, packageIds),
    ])
    const { l3Items, extraItems } = aggregateLineItems({
      lineItems: calc.lineItems,
      sims,
      packages,
      departments,
    })
    const nowIso = new Date().toISOString()
    const dueDate = toDateOnly(addDays(endInclusive, 30))
    const billRows = await supabase.insert('bills', {
      enterprise_id: enterprise.tenant_id,
      reseller_id: enterprise.parent_id ?? null,
      period_start: toDateOnly(start),
      period_end: toDateOnly(endInclusive),
      status: 'GENERATED',
      total_amount: Number(calc.totalBillAmount.toFixed(2)),
      currency: calc.currency ?? schedule.value.currency ?? 'USD',
      generated_at: nowIso,
      due_date: dueDate,
    }, { returning: 'representation' })
    const bill = Array.isArray(billRows) ? (billRows[0] as Record<string, any>) : null
    if (!bill?.bill_id) continue
    const billId = bill.bill_id
    await writeAuditLog(supabase, {
      actor_user_id: actorUserId ?? null,
      actor_role: actorRole ?? null,
      tenant_id: enterprise.tenant_id,
      action: 'BILL_GENERATED',
      target_type: 'BILL',
      target_id: billId,
      request_id: requestId ?? null,
      source_ip: sourceIp ?? null,
      after_data: {
        billId,
        enterpriseId: enterprise.tenant_id,
        resellerId: enterprise.parent_id ?? null,
        periodStart: toDateOnly(start),
        periodEnd: toDateOnly(endInclusive),
        status: 'GENERATED',
        totalAmount: Number(calc.totalBillAmount.toFixed(2)),
        currency: calc.currency ?? schedule.value.currency ?? 'USD',
        dueDate,
      },
    })
    const allItems = [...l3Items, ...extraItems]
    if (allItems.length) {
      const batchSize = 100
      for (let i = 0; i < allItems.length; i += batchSize) {
        const batch = allItems.slice(i, i + batchSize).map((item) => ({
          bill_id: billId,
          item_type: item.item_type,
          sim_id: item.sim_id,
          package_version_id: item.package_version_id,
          amount: item.amount,
          metadata: item.metadata,
          group_key: item.group_key ?? null,
          group_type: item.group_type ?? null,
        }))
        await supabase.insert('bill_line_items', batch, { returning: 'minimal' })
      }
    }
    if (Array.isArray(calc.ratingResults) && calc.ratingResults.length) {
      const batchSize = 200
      for (let i = 0; i < calc.ratingResults.length; i += batchSize) {
        const batch = calc.ratingResults.slice(i, i + batchSize)
        await supabase.insert('rating_results', batch, { returning: 'minimal' })
      }
    }
    const shouldPublish = typeof autoPublish === 'boolean' ? autoPublish : schedule.value.autoPublish
    if (shouldPublish) {
      await transitionBillStatus({
        supabase,
        billId,
        action: 'publish',
        actorUserId: actorUserId ?? null,
        requestId: requestId ?? null,
        dueDate,
      })
    }
    results.push({
      billId,
      enterpriseId: enterprise.tenant_id,
      status: shouldPublish ? 'PUBLISHED' : 'GENERATED',
      totalAmount: Number(calc.totalBillAmount.toFixed(2)),
    })
  }
  return { ok: true, value: { period, results } }
}
