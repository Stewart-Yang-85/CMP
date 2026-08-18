import {
  computeMonthlyCharges,
  updateUsageDailySummaryClassifiedUsage,
  updateUsagePackageDailySummary,
} from '../billing.js'
import { currentUtcYearMonth, resolveUsageMonthlyRollupScope } from './usageMonthlyRollup.js'

type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  insert: (
    table: string,
    rows: unknown,
    options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
  ) => Promise<unknown>
  update: (
    table: string,
    matchQueryString: string,
    patch: unknown,
    options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
  ) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

function toError(status: number, code: string, message: string): ServiceResult<never> {
  return { ok: false, status, code, message }
}

function isValidPeriod(value: unknown) {
  return /^\d{4}-\d{2}$/.test(String(value || '').trim())
}

function currentBillingYearMonthUtc(now: Date = new Date()) {
  return currentUtcYearMonth(now)
}

async function loadEnterprisesForScope(
  supabase: SupabaseClient,
  scope: {
    resellerId: string | null
    enterpriseId: string | null
    enterpriseIds: string[] | null
  }
) {
  if (scope.enterpriseId) {
    return [{ tenant_id: scope.enterpriseId }]
  }
  if (scope.enterpriseIds) {
    return scope.enterpriseIds.map((id) => ({ tenant_id: id }))
  }
  if (scope.resellerId) {
    const rows = await supabase.select(
      'tenants',
      `select=tenant_id,parent_id&parent_id=eq.${encodeURIComponent(scope.resellerId)}&tenant_type=eq.ENTERPRISE`
    )
    return Array.isArray(rows) ? (rows as Record<string, any>[]) : []
  }
  const rows = await supabase.select('tenants', 'select=tenant_id,parent_id&tenant_type=eq.ENTERPRISE')
  return Array.isArray(rows) ? (rows as Record<string, any>[]) : []
}

async function insertRatingResults(supabase: SupabaseClient, ratingResults: Record<string, any>[]) {
  if (!ratingResults.length) return
  const batchSize = 200
  for (let i = 0; i < ratingResults.length; i += batchSize) {
    const batch = ratingResults.slice(i, i + batchSize)
    try {
      await supabase.insert('rating_results', batch, { returning: 'minimal', suppressMissingColumns: true })
    } catch (err: any) {
      const body = String(err?.body || '')
      if (body.includes('rule_version_id') && body.includes('PGRST204')) {
        const sanitized = batch.map(({ rule_version_id, ...rest }) => rest)
        await supabase.insert('rating_results', sanitized, { returning: 'minimal' })
      } else {
        throw err
      }
    }
  }
}

export async function runUsageRatingRollup({
  supabase,
  period,
  enterpriseId,
  resellerId,
  jobId,
  now,
}: {
  supabase: SupabaseClient
  period?: string | null
  enterpriseId?: string | null
  resellerId?: string | null
  jobId?: string | null
  now?: Date
}): Promise<ServiceResult<Record<string, any>>> {
  const clock = now ?? new Date()
  const effectivePeriod = String(period || currentBillingYearMonthUtc(clock)).trim()
  if (!isValidPeriod(effectivePeriod)) return toError(400, 'BAD_REQUEST', 'period must be YYYY-MM.')
  if (effectivePeriod > currentUtcYearMonth(clock)) {
    return toError(400, 'BAD_REQUEST', 'period cannot be a future calendar month.')
  }

  const scopeAtExec = await resolveUsageMonthlyRollupScope(supabase, {
    roleScope: 'platform',
    tokenResellerId: null,
    resellerId: resellerId ?? null,
    enterpriseId: enterpriseId ?? null,
  })
  if (!scopeAtExec.ok) {
    return toError(scopeAtExec.status, scopeAtExec.code, scopeAtExec.message)
  }

  const enterprises = await loadEnterprisesForScope(supabase, scopeAtExec)
  if (!enterprises.length) {
    return toError(404, 'NOT_FOUND', 'No enterprises found for usage rating rollup scope.')
  }

  const runId = jobId || `${Date.now()}`
  let processedEnterprises = 0
  let ratingRows = 0
  let totalAmount = 0
  for (const enterprise of enterprises) {
    const entId = String((enterprise as any).tenant_id)
    const scopeLabel = resellerId ? `reseller:${resellerId}` : `enterprise:${entId}`
    const calculationId = `USAGE_ROLLUP:${effectivePeriod}:${scopeLabel}:${runId}`
    const result = await computeMonthlyCharges(
      { enterpriseId: entId, billPeriod: effectivePeriod, calculationId, logPrefix: 'Rating' },
      supabase
    )
    const rows = Array.isArray((result as any).ratingResults) ? (result as any).ratingResults : []
    await insertRatingResults(supabase, rows)
    await updateUsageDailySummaryClassifiedUsage(supabase, rows)
    await updateUsagePackageDailySummary(supabase, rows)
    processedEnterprises += 1
    ratingRows += rows.length
    totalAmount += Number((result as any).totalBillAmount ?? 0) || 0
  }

  if (jobId) {
    await supabase.update(
      'jobs',
      `job_id=eq.${encodeURIComponent(jobId)}`,
      {
        status: 'SUCCEEDED',
        progress_processed: processedEnterprises,
        progress_total: enterprises.length,
        finished_at: new Date().toISOString(),
      },
      { returning: 'minimal', suppressMissingColumns: true }
    )
  }

  return {
    ok: true,
    value: {
      period: effectivePeriod,
      enterpriseCount: processedEnterprises,
      ratingRows,
      totalAmount: Number(totalAmount.toFixed(2)),
    },
  }
}
