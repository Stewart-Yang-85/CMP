import { emitEvent } from './eventEmitter.js'
import { resolveResellerTenantIdFromContext } from './resellerTenantScope.js'

/** Steady-state SIM update after upstream confirmation (shared by Worker). */
export async function finalizeSimStatusChange({
  supabase,
  sim,
  newStatus,
  source,
  requestId,
  reason,
  actorRole,
  sourceIp,
  lifecycleSubStatus = 'normal',
  emitStatusEvent = true,
  jobId,
}) {
  const nowIso = new Date().toISOString()
  const beforeStatus = String(sim.status)
  const update = {
    status: newStatus,
    lifecycle_sub_status: lifecycleSubStatus,
    last_status_change_at: nowIso,
  }
  if (newStatus === 'ACTIVATED' && !sim.activation_date) {
    update.activation_date = nowIso
  }
  await supabase.update('sims', `sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`, update, { returning: 'minimal' })
  await supabase.insert(
    'sim_state_history',
    {
      sim_id: sim.sim_id,
      before_status: beforeStatus,
      after_status: newStatus,
      start_time: nowIso,
      source,
      request_id: requestId,
    },
    { returning: 'minimal' }
  )
  if (emitStatusEvent) {
    try {
      await emitEvent({
        eventType: 'SIM_STATUS_CHANGED',
        enterpriseId: sim.enterprise_id ?? null,
        resellerId: sim.reseller_id ?? null,
        requestId: requestId ?? null,
        jobId: jobId ?? null,
        occurredAt: nowIso,
        payload: {
          iccid: sim.iccid,
          simId: sim.sim_id,
          beforeStatus,
          afterStatus: newStatus,
          lifecycleSubStatus: 'normal',
          reason: reason ?? null,
          supplierId: sim.supplier_id ?? null,
        },
      })
    } catch {
      /* audit below must still run when event pipeline is unavailable */
    }
  }
  let resellerTenantId = null
  if (sim.enterprise_id) {
    resellerTenantId = await resolveResellerTenantIdFromContext(supabase, sim.enterprise_id)
  }
  await supabase.insert(
    'audit_logs',
    {
      actor_role: actorRole ?? null,
      tenant_id: sim.enterprise_id ?? null,
      action: source,
      target_type: 'SIM',
      target_id: sim.iccid,
      request_id: requestId,
      source_ip: sourceIp ?? null,
      after_data: {
        beforeStatus,
        afterStatus: newStatus,
        lifecycleSubStatus,
        reason,
        ...(resellerTenantId ? { resellerId: resellerTenantId } : {}),
      },
    },
    { returning: 'minimal' }
  )
  return nowIso
}
