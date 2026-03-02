import { transitionBillStatus } from './billStatusMachine.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

type DunningPolicy = {
  gracePeriodDays: number
  suspendAfterDays: number | null
  interruptionAfterDays: number | null
  enabled: boolean
}

type LateFeeRule = {
  feeType: string
  feeValue: number
  gracePeriodDays: number
  enabled: boolean
}

function toError(status: number, code: string, message: string): ServiceResult<never> {
  return { ok: false, status, code, message }
}

function toNumber(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toDateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

function parseDateOnly(value: unknown) {
  if (!value) return null
  const text = String(value).slice(0, 10)
  const d = new Date(`${text}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return d
}

function diffDays(from: Date, to: Date) {
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.floor((to.getTime() - from.getTime()) / msPerDay)
}

function normalizeStatus(value: unknown) {
  return String(value || '').trim().toUpperCase()
}

function resolveTargetStatus({
  daysOverdue,
  gracePeriodDays,
  suspendAfterDays,
  interruptionAfterDays,
  overdueAmount,
  smallAmountThreshold,
}: {
  daysOverdue: number
  gracePeriodDays: number
  suspendAfterDays: number | null
  interruptionAfterDays: number | null
  overdueAmount: number
  smallAmountThreshold: number
}) {
  if (daysOverdue <= 0) return 'NORMAL'
  if (overdueAmount <= smallAmountThreshold) return 'OVERDUE_WARNING'
  const suspendAfter = suspendAfterDays !== null && Number.isFinite(suspendAfterDays) ? Math.max(0, suspendAfterDays) : gracePeriodDays
  if (daysOverdue <= suspendAfter) return 'OVERDUE_WARNING'
  if (interruptionAfterDays !== null && daysOverdue > suspendAfter + interruptionAfterDays) {
    return 'SERVICE_INTERRUPTED'
  }
  return 'SUSPENDED'
}

function calculateLateFee({
  overdueAmount,
  daysOverdue,
  rule,
}: {
  overdueAmount: number
  daysOverdue: number
  rule: LateFeeRule | null
}) {
  if (!rule || !rule.enabled) return 0
  const chargeableDays = Math.max(0, daysOverdue - Math.max(0, rule.gracePeriodDays))
  if (chargeableDays <= 0) return 0
  const dayRate = rule.feeType === 'PERCENTAGE' ? Math.max(0, rule.feeValue) / 100 : Math.max(0, rule.feeValue)
  return Number((overdueAmount * dayRate * chargeableDays).toFixed(2))
}

async function loadEnterpriseRow(supabase: SupabaseClient, enterpriseId: string) {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id,enterprise_status,auto_suspend_enabled,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  return row ?? null
}

async function resolveDunningPolicy(supabase: SupabaseClient, enterpriseId: string, parentId: string | null) {
  const loadPolicy = async (id: string | null) => {
    if (!id) return null
    const rows = await supabase.select(
      'dunning_policies',
      `select=grace_period_days,suspend_after_days,interruption_after_days,enabled&enterprise_id=eq.${encodeURIComponent(id)}&limit=1`
    )
    return Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  }
  const direct = await loadPolicy(enterpriseId)
  const parent = direct ? null : await loadPolicy(parentId)
  const policy = direct ?? parent ?? {}
  return {
    gracePeriodDays: Math.max(0, Number(policy.grace_period_days ?? 3)),
    suspendAfterDays: policy.suspend_after_days !== null && policy.suspend_after_days !== undefined ? Number(policy.suspend_after_days) : null,
    interruptionAfterDays: policy.interruption_after_days !== null && policy.interruption_after_days !== undefined ? Number(policy.interruption_after_days) : 15,
    enabled: policy.enabled !== undefined ? Boolean(policy.enabled) : true,
  } satisfies DunningPolicy
}

async function resolveLateFeeRule(supabase: SupabaseClient, enterpriseId: string, parentId: string | null) {
  const loadRule = async (id: string | null) => {
    if (!id) return null
    const rows = await supabase.select(
      'late_fee_rules',
      `select=fee_type,fee_value,grace_period_days,enabled&enterprise_id=eq.${encodeURIComponent(id)}&limit=1`
    )
    return Array.isArray(rows) ? (rows[0] as Record<string, any>) : null
  }
  const direct = await loadRule(enterpriseId)
  const parent = direct ? null : await loadRule(parentId)
  const rule = direct ?? parent
  if (!rule) return null
  return {
    feeType: String(rule.fee_type || 'PERCENTAGE').toUpperCase(),
    feeValue: Number(rule.fee_value ?? 0),
    gracePeriodDays: Math.max(0, Number(rule.grace_period_days ?? 0)),
    enabled: Boolean(rule.enabled ?? true),
  } satisfies LateFeeRule
}

async function listOverdueBills(supabase: SupabaseClient, enterpriseId: string | null, asOfDate: string) {
  const filters: string[] = [
    `due_date=not.is.null`,
    `due_date=lte.${encodeURIComponent(asOfDate)}`,
    `status=in.(PUBLISHED,OVERDUE)`,
  ]
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  const rows = await supabase.select(
    'bills',
    `select=bill_id,enterprise_id,status,total_amount,due_date,period_start&${filters.join('&')}`
  )
  return Array.isArray(rows) ? (rows as Record<string, any>[]) : []
}

export async function getEnterpriseDunningSummary({
  supabase,
  enterpriseId,
  asOfDate,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  asOfDate?: string | null
}): Promise<ServiceResult<Record<string, any>>> {
  if (!enterpriseId) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required.')
  }
  const enterprise = await loadEnterpriseRow(supabase, enterpriseId)
  if (!enterprise) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Enterprise not found.')
  }
  const policy = await resolveDunningPolicy(supabase, enterpriseId, enterprise.parent_id ? String(enterprise.parent_id) : null)
  const lateFeeRule = await resolveLateFeeRule(supabase, enterpriseId, enterprise.parent_id ? String(enterprise.parent_id) : null)
  const today = asOfDate ? String(asOfDate).slice(0, 10) : toDateOnly(new Date())
  const bills = await listOverdueBills(supabase, enterpriseId, today)
  if (!bills.length) {
    return {
      ok: true,
      value: {
        enterpriseId,
        dunningStatus: 'NORMAL',
        overdueAmount: 0,
        oldestOverdueBillId: null,
        oldestOverduePeriod: null,
        daysOverdue: 0,
        gracePeriodDays: policy.gracePeriodDays,
        nextAction: null,
        nextActionDate: null,
        autoSuspendEnabled: Boolean(enterprise.auto_suspend_enabled),
      },
    }
  }
  const totalAmount = bills.reduce((sum, bill) => sum + Number(bill.total_amount ?? 0), 0)
  const oldest = bills
    .map((b) => ({ bill: b, due: parseDateOnly(b.due_date) }))
    .filter((b) => b.due)
    .sort((a, b) => (a.due as Date).getTime() - (b.due as Date).getTime())[0]
  const oldestDue = oldest?.due ?? null
  const daysOverdue = oldestDue ? Math.max(0, diffDays(oldestDue, parseDateOnly(today) as Date)) : 0
  const smallAmountThreshold = 0
  const status = policy.enabled
    ? resolveTargetStatus({
        daysOverdue,
        gracePeriodDays: policy.gracePeriodDays,
        suspendAfterDays: policy.suspendAfterDays,
        interruptionAfterDays: policy.interruptionAfterDays,
        overdueAmount: totalAmount,
        smallAmountThreshold,
      })
    : 'NORMAL'
  const nextAction =
    status === 'OVERDUE_WARNING'
      ? 'OVERDUE_REMINDER'
      : status === 'NORMAL'
        ? null
        : 'MANUAL_REVIEW'
  let nextActionDate: string | null = null
  if (oldestDue && status === 'OVERDUE_WARNING') {
    const d = new Date(oldestDue)
    d.setUTCDate(d.getUTCDate() + Math.max(0, policy.gracePeriodDays))
    nextActionDate = d.toISOString()
  } else if (oldestDue && status === 'SUSPENDED' && policy.interruptionAfterDays !== null) {
    const d = new Date(oldestDue)
    d.setUTCDate(d.getUTCDate() + Math.max(0, policy.gracePeriodDays + policy.interruptionAfterDays))
    nextActionDate = d.toISOString()
  }
  const lateFeeAmount = policy.enabled
    ? calculateLateFee({
        overdueAmount: Number(totalAmount.toFixed(2)),
        daysOverdue,
        rule: lateFeeRule,
      })
    : 0
  return {
    ok: true,
    value: {
      enterpriseId,
      dunningStatus: status,
      overdueAmount: Number(totalAmount.toFixed(2)),
      oldestOverdueBillId: oldest?.bill?.bill_id ?? null,
      oldestOverduePeriod: oldest?.bill?.period_start ? String(oldest.bill.period_start).slice(0, 7) : null,
      daysOverdue,
      gracePeriodDays: policy.gracePeriodDays,
      nextAction,
      nextActionDate,
      autoSuspendEnabled: Boolean(enterprise.auto_suspend_enabled),
      lateFeeAmount,
    },
  }
}

export async function resolveDunningForEnterprise({
  supabase,
  enterpriseId,
  asOfDate,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  asOfDate?: string | null
}): Promise<ServiceResult<Record<string, any>>> {
  if (!enterpriseId) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required.')
  }
  const enterprise = await loadEnterpriseRow(supabase, enterpriseId)
  if (!enterprise) {
    return toError(404, 'RESOURCE_NOT_FOUND', 'Enterprise not found.')
  }
  const today = asOfDate ? String(asOfDate).slice(0, 10) : toDateOnly(new Date())
  const overdue = await listOverdueBills(supabase, enterpriseId, today)
  if (overdue.length) {
    return toError(409, 'OVERDUE_REMAINING', 'Enterprise still has overdue bills.')
  }
  const records = await supabase.select(
    'dunning_records',
    `select=dunning_id,dunning_status&customer_id=eq.${encodeURIComponent(enterpriseId)}&dunning_status=neq.NORMAL`
  )
  const nowIso = new Date().toISOString()
  if (Array.isArray(records) && records.length) {
    await supabase.update(
      'dunning_records',
      `customer_id=eq.${encodeURIComponent(enterpriseId)}&dunning_status=neq.NORMAL`,
      { dunning_status: 'NORMAL', resolved_at: nowIso, updated_at: nowIso },
      { returning: 'minimal' }
    )
    for (const record of records as Record<string, any>[]) {
      if (!record.dunning_id) continue
      await supabase.insert(
        'dunning_actions',
        {
          dunning_id: record.dunning_id,
          action_type: 'RESOLVED',
          metadata: { resolvedAt: nowIso },
        },
        { returning: 'minimal' }
      )
    }
  }
  return {
    ok: true,
    value: {
      enterpriseId,
      dunningStatus: 'NORMAL',
      enterpriseStatus: enterprise.enterprise_status ?? null,
      resolvedAt: nowIso,
    },
  }
}

export async function runDunningCheck({
  supabase,
  enterpriseId,
  asOfDate,
}: {
  supabase: SupabaseClient
  enterpriseId?: string | null
  asOfDate?: string | null
}): Promise<ServiceResult<Record<string, any>>> {
  const today = asOfDate ? String(asOfDate).slice(0, 10) : toDateOnly(new Date())
  const overdueBills = await listOverdueBills(supabase, enterpriseId ?? null, today)
  if (!overdueBills.length) {
    return { ok: true, value: { processed: 0, enterprises: 0 } }
  }
  const byEnterprise = new Map<string, Record<string, any>[]>()
  for (const bill of overdueBills) {
    const eid = bill.enterprise_id ? String(bill.enterprise_id) : null
    if (!eid) continue
    const list = byEnterprise.get(eid) ?? []
    list.push(bill)
    byEnterprise.set(eid, list)
  }
  let processed = 0
  for (const [eid, bills] of byEnterprise.entries()) {
    const enterprise = await loadEnterpriseRow(supabase, eid)
    if (!enterprise) continue
    const policy = await resolveDunningPolicy(supabase, eid, enterprise.parent_id ? String(enterprise.parent_id) : null)
    const smallAmountThreshold = 0
    const totalAmount = bills.reduce((sum, bill) => sum + Number(bill.total_amount ?? 0), 0)
    const recordRows = await supabase.select(
      'dunning_records',
      `select=dunning_id,bill_id,dunning_status,overdue_since,grace_period_days,suspend_triggered_at,interruption_triggered_at,resolved_at&customer_id=eq.${encodeURIComponent(eid)}`
    )
    const recordMap = new Map<string, Record<string, any>>()
    const records = Array.isArray(recordRows) ? (recordRows as Record<string, any>[]) : []
    for (const record of records) {
      if (record.bill_id) recordMap.set(String(record.bill_id), record)
    }
    if (!policy.enabled) {
      const nowIso = new Date().toISOString()
      for (const record of records) {
        if (normalizeStatus(record.dunning_status) === 'NORMAL') continue
        await supabase.update(
          'dunning_records',
          `dunning_id=eq.${encodeURIComponent(String(record.dunning_id))}`,
          { dunning_status: 'NORMAL', resolved_at: nowIso, updated_at: nowIso },
          { returning: 'minimal' }
        )
        await supabase.insert(
          'dunning_actions',
          {
            dunning_id: record.dunning_id,
            action_type: 'RESOLVED',
            metadata: { resolvedAt: nowIso },
          },
          { returning: 'minimal' }
        )
        processed += 1
      }
      continue
    }
    const overdueBillIds = new Set<string>()
    for (const bill of bills) {
      const billId = String(bill.bill_id)
      overdueBillIds.add(billId)
      if (normalizeStatus(bill.status) === 'PUBLISHED') {
        const due = parseDateOnly(bill.due_date)
        const day = due ? toDateOnly(due) : null
        if (day && day <= today) {
          await transitionBillStatus({ supabase, billId, action: 'overdue' })
        }
      }
      const dueDate = parseDateOnly(bill.due_date)
      const daysOverdue = dueDate ? Math.max(0, diffDays(dueDate, parseDateOnly(today) as Date)) : 0
      const targetStatus = resolveTargetStatus({
        daysOverdue,
        gracePeriodDays: policy.gracePeriodDays,
        suspendAfterDays: policy.suspendAfterDays,
        interruptionAfterDays: policy.interruptionAfterDays,
        overdueAmount: totalAmount,
        smallAmountThreshold,
      })
      const existing = recordMap.get(billId)
      if (!existing) {
        const insertRows = await supabase.insert(
          'dunning_records',
          {
            customer_id: eid,
            bill_id: billId,
            dunning_status: targetStatus,
            overdue_since: bill.due_date ?? null,
            grace_period_days: policy.gracePeriodDays,
            suspend_triggered_at: targetStatus === 'SUSPENDED' ? new Date().toISOString() : null,
            interruption_triggered_at: targetStatus === 'SERVICE_INTERRUPTED' ? new Date().toISOString() : null,
          },
          { returning: 'representation' }
        )
        const inserted = Array.isArray(insertRows) ? (insertRows[0] as Record<string, any>) : null
        if (inserted?.dunning_id) {
          await supabase.insert(
            'dunning_actions',
            {
              dunning_id: inserted.dunning_id,
              action_type: targetStatus,
              metadata: {
                billId,
                daysOverdue,
                overdueAmount: Number(totalAmount.toFixed(2)),
              },
            },
            { returning: 'minimal' }
          )
        }
        processed += 1
        continue
      }
      if (normalizeStatus(existing.dunning_status) !== targetStatus) {
        const patch: Record<string, unknown> = {
          dunning_status: targetStatus,
          updated_at: new Date().toISOString(),
          resolved_at: null,
        }
        if (targetStatus === 'SUSPENDED' && !existing.suspend_triggered_at) {
          patch.suspend_triggered_at = new Date().toISOString()
        }
        if (targetStatus === 'SERVICE_INTERRUPTED' && !existing.interruption_triggered_at) {
          patch.interruption_triggered_at = new Date().toISOString()
        }
        await supabase.update(
          'dunning_records',
          `dunning_id=eq.${encodeURIComponent(String(existing.dunning_id))}`,
          patch,
          { returning: 'minimal' }
        )
        await supabase.insert(
          'dunning_actions',
          {
            dunning_id: existing.dunning_id,
            action_type: targetStatus,
            metadata: {
              billId,
              daysOverdue,
              overdueAmount: Number(totalAmount.toFixed(2)),
            },
          },
          { returning: 'minimal' }
        )
        processed += 1
      }
    }
    for (const record of records) {
      const billId = record.bill_id ? String(record.bill_id) : null
      if (!billId || overdueBillIds.has(billId)) continue
      if (normalizeStatus(record.dunning_status) === 'NORMAL') continue
      const nowIso = new Date().toISOString()
      await supabase.update(
        'dunning_records',
        `dunning_id=eq.${encodeURIComponent(String(record.dunning_id))}`,
        { dunning_status: 'NORMAL', resolved_at: nowIso, updated_at: nowIso },
        { returning: 'minimal' }
      )
      await supabase.insert(
        'dunning_actions',
        {
          dunning_id: record.dunning_id,
          action_type: 'RESOLVED',
          metadata: { resolvedAt: nowIso },
        },
        { returning: 'minimal' }
      )
      processed += 1
    }
  }
  return { ok: true, value: { processed, enterprises: byEnterprise.size } }
}
