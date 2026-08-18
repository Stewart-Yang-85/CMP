import type { AdapterType } from '../services/upstreamIntegration.js'

export const WXZHONGGENG_INBOUND_WEBHOOK_EVENTS = [
  'subscription',
  'update-location',
  'sim-status-changed',
  'traffic-alert',
] as const

export type WxInboundWebhookEventKey = (typeof WXZHONGGENG_INBOUND_WEBHOOK_EVENTS)[number]

const ADAPTER_INBOUND_EVENTS: Record<string, readonly string[]> = {
  wxzhonggeng: WXZHONGGENG_INBOUND_WEBHOOK_EVENTS,
}

export function getInboundWebhookEventsForAdapter(adapterType: string): readonly string[] {
  const key = String(adapterType ?? '').trim().toLowerCase()
  return ADAPTER_INBOUND_EVENTS[key] ?? []
}

export function adapterSupportsInboundEvent(adapterType: string, eventKey: string): boolean {
  const events = getInboundWebhookEventsForAdapter(adapterType)
  return events.includes(String(eventKey ?? '').trim())
}

export function isKnownAdapterTypeForInbound(adapterType: string): adapterType is AdapterType {
  return getInboundWebhookEventsForAdapter(adapterType).length > 0
}
