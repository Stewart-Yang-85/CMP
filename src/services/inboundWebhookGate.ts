import type { UpstreamIntegrationRuntime } from './upstreamIntegration.js'
import { loadUpstreamIntegrationRuntime } from './upstreamIntegration.js'
import { isInboundEventKeyActive, isInboundWebhookSubscribed } from './inboundWebhookCatalog.js'
import { adapterSupportsInboundEvent } from '../vendors/inboundWebhookCapabilities.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any

export type InboundWebhookGateResult =
  | { ok: true; integration: UpstreamIntegrationRuntime }
  | { ok: false; status: number; code: string; message: string; audit?: boolean }

export async function validateInboundWebhookGate({
  supabase,
  supplierId,
  operatorId,
  adapterType,
  eventKey,
  traceId,
  sourceIp,
}: {
  supabase: SupabaseClient
  supplierId: string
  operatorId: string
  adapterType: string
  eventKey: string
  traceId?: string | null
  sourceIp?: string | null
}): Promise<InboundWebhookGateResult> {
  const adapter = String(adapterType ?? '').trim().toLowerCase()
  const key = String(eventKey ?? '').trim()

  if (!(await isInboundEventKeyActive(supabase, key))) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: `Unknown inbound webhook event: ${key}.` }
  }

  const integration = await loadUpstreamIntegrationRuntime(supabase, supplierId, operatorId)
  if (!integration) {
    return {
      ok: false,
      status: 503,
      code: 'UPSTREAM_NOT_CONFIGURED',
      message: 'Webhook integration not configured.',
    }
  }

  if (integration.adapterType !== adapter) {
    return {
      ok: false,
      status: 400,
      code: 'BAD_REQUEST',
      message: `adapterType in path (${adapter}) does not match integration (${integration.adapterType}).`,
    }
  }

  if (!adapterSupportsInboundEvent(adapter, key)) {
    return {
      ok: false,
      status: 403,
      code: 'WEBHOOK_EVENT_NOT_SUPPORTED',
      message: `Adapter does not support inbound event ${key}.`,
      audit: true,
    }
  }

  const subscribed = await isInboundWebhookSubscribed(supabase, integration.integrationId, key)
  if (!subscribed) {
    await writeInboundWebhookAudit(supabase, {
      action: 'WEBHOOK_EVENT_NOT_SUBSCRIBED',
      integrationId: integration.integrationId,
      supplierId: integration.supplierId,
      eventKey: key,
      traceId,
      sourceIp,
    })
    return {
      ok: false,
      status: 403,
      code: 'WEBHOOK_EVENT_NOT_SUBSCRIBED',
      message: `Inbound webhook event ${key} is not subscribed for this integration.`,
      audit: true,
    }
  }

  return { ok: true, integration }
}

async function writeInboundWebhookAudit(
  supabase: SupabaseClient,
  {
    action,
    integrationId,
    supplierId,
    eventKey,
    traceId,
    sourceIp,
  }: {
    action: string
    integrationId: string
    supplierId: string
    eventKey: string
    traceId?: string | null
    sourceIp?: string | null
  }
) {
  try {
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'SYSTEM',
        tenant_id: null,
        action,
        target_type: 'UPSTREAM_INTEGRATION',
        target_id: integrationId,
        request_id: traceId ?? null,
        source_ip: sourceIp ?? null,
        after_data: { supplierId, eventKey },
      },
      { returning: 'minimal' }
    )
  } catch {
    /* audit must not block response */
  }
}
