import { emitEvent } from './eventEmitter.js'
import { maybeDeactivateSimWhenNoActiveSubscription } from './subscriptionSimCoupling.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { suppressMissingColumns?: boolean }) => Promise<unknown>
  selectWithCount: (table: string, queryString: string) => Promise<{ data: unknown; total: number | null }>
  update: (
    table: string,
    matchQueryString: string,
    patch: unknown,
    options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
  ) => Promise<unknown>
  insert: (
    table: string,
    rows: unknown,
    options?: { returning?: 'minimal' | 'representation'; suppressMissingColumns?: boolean }
  ) => Promise<unknown>
}

export type OneTimeExpiryResultItem = {
  subscriptionId: string
  ok: boolean
  reason?: string
  expiresAt?: string | null
  packageId?: string | null
  simId?: string | null
  simLifecycle?: { action: string; detail?: string; jobId?: string | null }
}

export type OneTimeExpiryRunResult = {
  ok: true
  value: {
    processed: number
    skipped: number
    examined: number
    results: OneTimeExpiryResultItem[]
  }
}

function isOneTimePlanType(raw: unknown): boolean {
  const t = String(raw ?? '')
    .trim()
    .toUpperCase()
  return t === 'ONE_TIME'
}

async function resolvePricePlanType(
  supabase: SupabaseClient,
  packageId: string
): Promise<string | null> {
  const pkgRows = await supabase.select(
    'packages',
    `select=package_id,price_plan_id&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  const pkg = Array.isArray(pkgRows) ? (pkgRows[0] as { price_plan_id?: string } | undefined) : undefined
  const pricePlanId = pkg?.price_plan_id ? String(pkg.price_plan_id) : ''
  if (!pricePlanId) return null
  const planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,type&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  const plan = Array.isArray(planRows) ? (planRows[0] as { type?: string } | undefined) : undefined
  return plan?.type != null ? String(plan.type) : null
}

/**
 * ACTIVE ONE_TIME subscriptions with expires_at <= now → EXPIRED.
 * Then if the SIM has no remaining ACTIVE subscriptions, enqueue SIM deactivate (upstream).
 */
export async function runOneTimeSubscriptionExpiry({
  supabase,
  now = new Date(),
  limit = 100,
  requestId = null,
}: {
  supabase: SupabaseClient
  now?: Date
  limit?: number
  requestId?: string | null
}): Promise<OneTimeExpiryRunResult> {
  const nowIso = now.toISOString()
  const batchLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)))

  const rows = await supabase.select(
    'subscriptions',
    `select=subscription_id,enterprise_id,sim_id,package_id,state,subscription_kind,effective_at,expires_at&state=eq.ACTIVE&expires_at=not.is.null&expires_at=lte.${encodeURIComponent(nowIso)}&order=expires_at.asc&limit=${batchLimit}`
  )
  const candidates = Array.isArray(rows) ? rows : []
  const results: OneTimeExpiryResultItem[] = []
  let processed = 0
  let skipped = 0

  for (const row of candidates as Array<Record<string, unknown>>) {
    const subscriptionId = String(row.subscription_id ?? '')
    const packageId = row.package_id != null ? String(row.package_id) : null
    const expiresAt = row.expires_at != null ? String(row.expires_at) : null
    const simId = row.sim_id != null ? String(row.sim_id) : null
    if (!subscriptionId) {
      skipped += 1
      continue
    }
    try {
      if (!packageId) {
        skipped += 1
        results.push({ subscriptionId, ok: false, reason: 'MISSING_PACKAGE_ID', expiresAt, packageId, simId })
        continue
      }
      const planType = await resolvePricePlanType(supabase, packageId)
      if (!isOneTimePlanType(planType)) {
        skipped += 1
        results.push({
          subscriptionId,
          ok: false,
          reason: `SKIP_NOT_ONE_TIME:${planType || 'UNKNOWN'}`,
          expiresAt,
          packageId,
          simId,
        })
        continue
      }

      await supabase.update(
        'subscriptions',
        `subscription_id=eq.${encodeURIComponent(subscriptionId)}&state=eq.ACTIVE`,
        { state: 'EXPIRED', cancelled_at: null },
        { returning: 'minimal' }
      )

      try {
        await supabase.update(
          'subscription_cancel_schedules',
          `subscription_id=eq.${encodeURIComponent(subscriptionId)}&status=eq.PENDING`,
          { status: 'CANCELLED', executed_at: nowIso },
          { returning: 'minimal' }
        )
      } catch {
        /* table may be missing */
      }

      await emitEvent({
        eventType: 'SUBSCRIPTION_CHANGED',
        enterpriseId: row.enterprise_id != null ? String(row.enterprise_id) : null,
        requestId,
        payload: {
          subscriptionId,
          simId,
          packageId,
          subscriptionKind: row.subscription_kind != null ? String(row.subscription_kind) : null,
          beforeState: 'ACTIVE',
          afterState: 'EXPIRED',
          expiresAt,
          reason: 'ONE_TIME_VALIDITY_EXPIRED',
        },
      })

      if (typeof supabase.insert === 'function') {
        await supabase.insert(
          'audit_logs',
          {
            actor_role: 'SYSTEM',
            tenant_id: row.enterprise_id != null ? String(row.enterprise_id) : null,
            action: 'SUBSCRIPTION_ONE_TIME_EXPIRED',
            target_type: 'SUBSCRIPTION',
            target_id: subscriptionId,
            request_id: requestId,
            after_data: {
              beforeState: 'ACTIVE',
              afterState: 'EXPIRED',
              expiresAt,
              packageId,
              planType: 'ONE_TIME',
            },
          },
          { returning: 'minimal', suppressMissingColumns: true }
        )
      }

      let simLifecycle: OneTimeExpiryResultItem['simLifecycle']
      if (simId) {
        const life = await maybeDeactivateSimWhenNoActiveSubscription({
          supabase,
          simId,
          requestId,
          reason: 'ONE_TIME_EXPIRED_NO_ACTIVE_SUBSCRIPTION',
        })
        simLifecycle = { action: life.action, detail: life.detail, jobId: life.jobId }
      }

      processed += 1
      results.push({ subscriptionId, ok: true, expiresAt, packageId, simId, simLifecycle })
    } catch (err) {
      skipped += 1
      results.push({
        subscriptionId,
        ok: false,
        reason: String((err as Error)?.message || err),
        expiresAt,
        packageId,
        simId,
      })
    }
  }

  return {
    ok: true,
    value: {
      processed,
      skipped,
      examined: candidates.length,
      results,
    },
  }
}
