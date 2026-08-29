function firstDayNextMonthUtc() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0))
}

function endOfCurrentBillingPeriodIso() {
  return new Date(firstDayNextMonthUtc().getTime() - 1000).toISOString()
}

function resolveScheduledExecuteAt(sub) {
  const kind = String(sub?.subscription_kind ?? sub?.kind ?? 'MAIN').toUpperCase()
  const expiresAt = sub?.expires_at ? new Date(String(sub.expires_at)) : null
  if (kind === 'ADD_ON' && expiresAt && !Number.isNaN(expiresAt.getTime())) {
    return expiresAt.toISOString()
  }
  return firstDayNextMonthUtc().toISOString()
}

function isMissingScheduleTable(err) {
  const body = String(err?.body || err?.message || '')
  return (
    body.includes('subscription_cancel_schedules') ||
    body.includes('PGRST205') ||
    body.includes('does not exist')
  )
}

/**
 * Worker cron: apply pending rows in subscription_cancel_schedules.
 */
export async function executeScheduledCancels({ supabase }) {
  const { maybeDeactivateSimWhenNoActiveSubscription } = await import('./subscriptionSimCoupling.js')
  const nowIso = new Date().toISOString()
  let rows
  try {
    rows = await supabase.select(
      'subscription_cancel_schedules',
      `select=schedule_id,subscription_id,scheduled_execute_at&status=eq.PENDING&scheduled_execute_at=lte.${encodeURIComponent(nowIso)}&order=scheduled_execute_at.asc&limit=100`
    )
  } catch (err) {
    if (isMissingScheduleTable(err)) throw err
    return { ok: false, status: 500, code: 'INTERNAL_ERROR', message: String(err?.message || err) }
  }

  const pending = Array.isArray(rows) ? rows : []
  const results = []
  for (const row of pending) {
    const subscriptionId = String(row.subscription_id ?? '')
    const scheduleId = String(row.schedule_id ?? '')
    if (!subscriptionId || !scheduleId) continue
    try {
      const subRows = await supabase.select(
        'subscriptions',
        `select=subscription_id,state,expires_at,sim_id&subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`
      )
      const sub = Array.isArray(subRows) ? subRows[0] : null
      if (!sub) {
        await supabase.update(
          'subscription_cancel_schedules',
          `schedule_id=eq.${encodeURIComponent(scheduleId)}`,
          { status: 'CANCELLED', executed_at: nowIso },
          { returning: 'minimal' }
        )
        results.push({ subscriptionId, ok: false, reason: 'SUBSCRIPTION_NOT_FOUND' })
        continue
      }
      const state = String(sub.state ?? '').toUpperCase()
      if (state !== 'ACTIVE' && state !== 'EXPIRED') {
        await supabase.update(
          'subscription_cancel_schedules',
          `schedule_id=eq.${encodeURIComponent(scheduleId)}`,
          { status: 'CANCELLED', executed_at: nowIso },
          { returning: 'minimal' }
        )
        results.push({ subscriptionId, ok: false, reason: `SKIP_STATE_${state || 'UNKNOWN'}` })
        continue
      }
      const expiresAt =
        sub.expires_at != null && String(sub.expires_at).trim() !== ''
          ? String(sub.expires_at)
          : endOfCurrentBillingPeriodIso()
      const wasActive = state === 'ACTIVE'
      await supabase.update(
        'subscriptions',
        `subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
        { state: 'EXPIRED', cancelled_at: null, expires_at: expiresAt },
        { returning: 'minimal' }
      )
      await supabase.update(
        'subscription_cancel_schedules',
        `schedule_id=eq.${encodeURIComponent(scheduleId)}`,
        { status: 'EXECUTED', executed_at: nowIso },
        { returning: 'minimal' }
      )
      let simLifecycle = null
      const simId = sub.sim_id != null ? String(sub.sim_id) : ''
      if (wasActive && simId) {
        simLifecycle = await maybeDeactivateSimWhenNoActiveSubscription({
          supabase,
          simId,
          requestId: `scheduled-cancel-${scheduleId}`,
          reason: 'SCHEDULED_CANCEL_NO_ACTIVE_SUBSCRIPTION',
        })
      }
      results.push({ subscriptionId, ok: true, state: 'EXPIRED', expiresAt, simLifecycle })
    } catch (err) {
      results.push({ subscriptionId, ok: false, reason: String(err?.message || err) })
    }
  }
  const processed = results.filter((r) => r.ok).length
  return { ok: true, value: { processed, results } }
}

export { firstDayNextMonthUtc, endOfCurrentBillingPeriodIso, resolveScheduledExecuteAt, isMissingScheduleTable }
