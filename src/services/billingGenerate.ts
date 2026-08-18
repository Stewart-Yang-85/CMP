/** Monthly rating / line items: Covered -> carrier OOP roaming -> UNCLASSIFIED — see `computeMonthlyCharges` in `billing.js` (Phase 30 / billing-api §4.2). */
import { computeMonthlyCharges, updateUsageDailySummaryClassifiedUsage, updateUsagePackageDailySummary } from '../billing.js'
import { transitionBillStatus } from './billStatusMachine.js'
import {
  buildAdjustmentBillLineItems,
  computeAdjustedBillTotal,
  loadApprovedAdjustmentSettlement,
  markAdjustmentNotesApplied,
} from './adjustmentNote.js'
import {
  findInvalidAdjustmentNoteIccids,
  emitAdjustmentIccidSettlementWarnings,
} from './adjustmentNoteIccid.js'
import { resolveBillingSchedule } from './billingSchedule.js'
import { actorUserIdForDb } from '../utils/actorUserId.js'

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

/** YYYY-MM for the UTC calendar month containing `now`. */
export function currentBillingYearMonthUtc(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Billing period must be a completed month strictly before the current UTC month. */
export function isPastBillingPeriod(period: unknown, now: Date = new Date()): boolean {
  const value = String(period ?? '').trim()
  if (!isValidPeriod(value)) return false
  return value < currentBillingYearMonthUtc(now)
}

function toDateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

async function writeAuditLog(supabase: SupabaseClient, payload: Record<string, unknown>) {
  await supabase.insert(
    'audit_logs',
    {
      ...payload,
      actor_user_id: actorUserIdForDb(payload.actor_user_id as string | null | undefined),
    },
    { returning: 'minimal' }
  )
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

async function loadEnterpriseList(
  supabase: SupabaseClient,
  enterpriseId?: string | null,
  resellerId?: string | null
) {
  if (enterpriseId) {
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id,name&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
    )
    const row = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
    if (!row) return []
    if (resellerId && String(row.parent_id || '') !== String(resellerId)) return []
    return [row]
  }
  if (resellerId) {
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id,name&parent_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.ENTERPRISE`
    )
    return Array.isArray(rows) ? (rows as Record<string, any>[]) : []
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
    const pid = pkg?.package_id ? String(pkg.package_id) : pkg?.package_version_id ? String(pkg.package_version_id) : ''
    if (pid) packageMeta.set(pid, pkg)
  }
  const departmentMeta = new Map<string, any>()
  for (const dept of departments) {
    if (dept?.tenant_id) departmentMeta.set(String(dept.tenant_id), dept)
  }
  const extraItems: Record<string, any>[] = []
  for (const item of lineItems) {
    const simId = item.sim_id ? String(item.sim_id) : null
    const pkgId = item.package_id ? String(item.package_id) : item.package_version_id ? String(item.package_version_id) : null
    if (!simId) {
      extraItems.push({
        sim_id: null,
        package_id: pkgId,
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
      usageMb: 0,
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
      current.usageMb += Number(item.metadata?.chargedMb ?? 0)
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
      package_id: entry.packageVersionId ?? null,
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
        packageName: pkg?.name ?? pkg?.packages?.name ?? null,
        monthlyFee: Number(entry.monthlyFee.toFixed(2)),
        usageCharge: Number(entry.usageCharge.toFixed(2)),
        overageCharge: Number(entry.overageCharge.toFixed(2)),
        usageMb: Math.floor(entry.usageMb),
        subtotal,
      },
    })
  }
  return { l3Items, extraItems }
}

async function loadPackagesForBilling(supabase: SupabaseClient, packageIds: string[]) {
  if (!packageIds.length) return []
  const idFilter = packageIds.map((id) => encodeURIComponent(id)).join(',')
  const rows = await supabase.select(
    'packages',
    `select=package_id,name&package_id=in.(${idFilter})`
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
  if (!isPastBillingPeriod(period)) {
    return toError(400, 'BAD_REQUEST', 'period must be a month before the current month.')
  }
  const { start, endExclusive, endInclusive } = parsePeriod(period)
  const enterprises = await loadEnterpriseList(supabase, enterpriseId ?? null, resellerId ?? null)
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
  const settlementWarnings: Array<Record<string, unknown>> = []
  for (const enterprise of enterprises) {
    const calc = await computeMonthlyCharges({
      enterpriseId: enterprise.tenant_id,
      billPeriod: period,
      calculationId: jobId || `calc-${Date.now()}`,
    }, supabase)
    if (!calc) continue
    const existing = await supabase.select(
      'bills',
      `select=bill_id&enterprise_id=eq.${encodeURIComponent(enterprise.tenant_id)}&period_start=eq.${encodeURIComponent(toDateOnly(start))}&period_end=eq.${encodeURIComponent(toDateOnly(endInclusive))}&status=neq.VOIDED&limit=1`
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
    const packageIds = Array.from(
      new Set<string>(
        calc.lineItems
          .map((i: any) => i.package_id ?? i.package_version_id)
          .filter(Boolean)
          .map(String)
      )
    )
    const [departments, packages] = await Promise.all([
      loadDepartments(supabase, departmentIds),
      loadPackagesForBilling(supabase, packageIds),
    ])
    const { l3Items, extraItems } = aggregateLineItems({
      lineItems: calc.lineItems,
      sims,
      packages,
      departments,
    })
    const billCurrency = calc.currency ?? schedule.value.currency ?? 'USD'
    const adjustmentSettlement = await loadApprovedAdjustmentSettlement(
      supabase,
      String(enterprise.tenant_id),
      billCurrency
    )
    const adjustmentIccidIssues = adjustmentSettlement.noteIds.length
      ? await findInvalidAdjustmentNoteIccids(
        supabase,
        String(enterprise.tenant_id),
        adjustmentSettlement.noteIds
      )
      : []
    const ratingTotal = Number(calc.totalBillAmount.toFixed(2))
    const finalTotal = computeAdjustedBillTotal(ratingTotal, adjustmentSettlement.netAdjustment)
    const nowIso = new Date().toISOString()
    const dueDate = toDateOnly(addDays(endInclusive, 30))
    const billRows = await supabase.insert('bills', {
      enterprise_id: enterprise.tenant_id,
      reseller_id: enterprise.parent_id ?? null,
      period_start: toDateOnly(start),
      period_end: toDateOnly(endInclusive),
      status: 'GENERATED',
      total_amount: finalTotal,
      currency: billCurrency,
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
        ratingTotal,
        adjustmentCreditTotal: adjustmentSettlement.creditTotal,
        adjustmentDebitTotal: adjustmentSettlement.debitTotal,
        adjustmentNet: adjustmentSettlement.netAdjustment,
        totalAmount: finalTotal,
        currency: billCurrency,
        dueDate,
        appliedAdjustmentNoteIds: adjustmentSettlement.noteIds,
      },
    })
    const adjustmentLineItems = buildAdjustmentBillLineItems(adjustmentSettlement, billId)
    const allItems = [...l3Items, ...extraItems, ...adjustmentLineItems]
    if (allItems.length) {
      const batchSize = 100
      for (let i = 0; i < allItems.length; i += batchSize) {
        const batch = allItems.slice(i, i + batchSize).map((item) => ({
          bill_id: billId,
          item_type: item.item_type,
          sim_id: item.sim_id,
          package_id: item.package_id ?? item.package_version_id ?? null,
          amount: item.amount,
          metadata: item.metadata,
          group_key: item.group_key ?? null,
          group_type: item.group_type ?? null,
        }))
        await supabase.insert('bill_line_items', batch, { returning: 'minimal' })
      }
    }
    if (adjustmentSettlement.noteIds.length) {
      const applied = await markAdjustmentNotesApplied({
        supabase,
        noteIds: adjustmentSettlement.noteIds,
        appliedBillId: billId,
        enterpriseId: String(enterprise.tenant_id),
        actorUserId: actorUserId ?? null,
        requestId: requestId ?? null,
      })
      if (!applied.ok) {
        return applied
      }
      if (adjustmentIccidIssues.length) {
        await emitAdjustmentIccidSettlementWarnings({
          supabase,
          enterpriseId: String(enterprise.tenant_id),
          appliedBillId: billId,
          jobId: jobId ?? null,
          requestId: requestId ?? null,
          actorUserId: actorUserId ?? null,
          issues: adjustmentIccidIssues,
        })
        settlementWarnings.push({
          enterpriseId: enterprise.tenant_id,
          billId,
          issues: adjustmentIccidIssues,
        })
      }
    }
    if (Array.isArray(calc.ratingResults) && calc.ratingResults.length) {
      const batchSize = 200
      for (let i = 0; i < calc.ratingResults.length; i += batchSize) {
        const batch = calc.ratingResults.slice(i, i + batchSize)
        await supabase.insert('rating_results', batch, { returning: 'minimal' })
      }
      await updateUsageDailySummaryClassifiedUsage(supabase, calc.ratingResults)
      await updateUsagePackageDailySummary(supabase, calc.ratingResults)
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
      ratingTotal,
      adjustmentNet: adjustmentSettlement.netAdjustment,
      totalAmount: finalTotal,
      appliedAdjustmentNoteIds: adjustmentSettlement.noteIds,
      ...(adjustmentIccidIssues.length
        ? { adjustmentIccidWarnings: adjustmentIccidIssues }
        : {}),
    })
  }
  return {
    ok: true,
    value: {
      period,
      results,
      ...(settlementWarnings.length ? { adjustmentIccidWarnings: settlementWarnings } : {}),
    },
  }
}
