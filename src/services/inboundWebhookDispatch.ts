import type { FastifyReply, FastifyRequest } from 'fastify'
import { WXZHONGGENG_INBOUND_WEBHOOK_EVENTS } from '../vendors/inboundWebhookCapabilities.js'
import type { WxInboundWebhookDeps, WxInboundWebhookHandlerMap } from './wxzhonggengInboundWebhook.js'
import { createWxzhonggengInboundHandlers } from './wxzhonggengInboundWebhook.js'

export type InboundWebhookHandler = (req: FastifyRequest, res: FastifyReply) => Promise<void>

const wxHandlersByEvent = new WeakMap<WxInboundWebhookDeps, WxInboundWebhookHandlerMap>()

function getWxHandlers(deps: WxInboundWebhookDeps): WxInboundWebhookHandlerMap {
  let map = wxHandlersByEvent.get(deps)
  if (!map) {
    map = createWxzhonggengInboundHandlers(deps)
    wxHandlersByEvent.set(deps, map)
  }
  return map
}

export function resolveInboundWebhookHandler(
  deps: WxInboundWebhookDeps,
  adapterType: string,
  eventKey: string
): InboundWebhookHandler | null {
  const adapter = String(adapterType ?? '').trim().toLowerCase()
  const key = String(eventKey ?? '').trim()
  if (adapter === 'wxzhonggeng' && (WXZHONGGENG_INBOUND_WEBHOOK_EVENTS as readonly string[]).includes(key)) {
    const handlers = getWxHandlers(deps)
    return (handlers as Record<string, InboundWebhookHandler>)[key] ?? null
  }
  return null
}

export function listRegisteredInboundWebhookRoutes(deps: WxInboundWebhookDeps): Array<{
  adapterType: string
  eventKey: string
}> {
  const routes: Array<{ adapterType: string; eventKey: string }> = []
  for (const eventKey of WXZHONGGENG_INBOUND_WEBHOOK_EVENTS) {
    routes.push({ adapterType: 'wxzhonggeng', eventKey })
  }
  return routes
}
