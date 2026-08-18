type SupabaseClient = {
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

export type AlertAuditInput = {
  supabase: SupabaseClient
  action: string
  targetType: string
  targetId?: string | null
  tenantId?: string | null
  actorUserId?: string | null
  actorRole?: string | null
  beforeData?: Record<string, unknown> | null
  afterData?: Record<string, unknown> | null
  requestId?: string | null
  sourceIp?: string | null
}

export type AlertInternalEventInput = {
  supabase: SupabaseClient
  eventType: string
  enterpriseId?: string | null
  resellerId?: string | null
  actorUserId?: string | null
  requestId?: string | null
  payload?: Record<string, unknown> | null
}

export async function recordAlertAuditLog({
  supabase,
  action,
  targetType,
  targetId,
  tenantId,
  actorUserId,
  actorRole,
  beforeData,
  afterData,
  requestId,
  sourceIp,
}: AlertAuditInput) {
  try {
    await supabase.insert('audit_logs', {
      actor_user_id: actorUserId ?? null,
      actor_role: actorRole ?? null,
      tenant_id: tenantId ?? null,
      action,
      target_type: targetType,
      target_id: targetId ?? null,
      before_data: beforeData ?? null,
      after_data: afterData ?? null,
      request_id: requestId ?? null,
      source_ip: sourceIp ?? null,
    }, { returning: 'minimal' })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export async function recordAlertInternalEvent({
  supabase,
  eventType,
  enterpriseId,
  resellerId,
  actorUserId,
  requestId,
  payload,
}: AlertInternalEventInput) {
  try {
    await supabase.insert('events', {
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      enterprise_id: enterpriseId ?? null,
      reseller_id: resellerId ?? null,
      actor_user_id: actorUserId ?? null,
      request_id: requestId ?? null,
      payload: payload ?? {},
    }, { returning: 'minimal' })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
