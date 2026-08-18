import { listInboundWebhookEventsForApi } from '../services/inboundWebhookCatalog.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  /** Platform admin JWT or ADMIN_API_KEY via X-API-Key */
  requireAdminAccess: (req: any, res: any) => boolean
}

export function registerUpstreamWebhookEventRoutes({
  app,
  prefix,
  deps,
}: {
  app: any
  prefix: string
  deps: Deps
}) {
  const { createSupabaseRestClient, getTraceId, sendError, requireAdminAccess } = deps

  app.get(`${prefix}/upstream-webhook-events`, async (req: any, res: any) => {
    if (!requireAdminAccess(req, res)) return
    const adapterType = req.query?.adapterType ? String(req.query.adapterType).trim() : null
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await listInboundWebhookEventsForApi(supabase, adapterType)
    res.send(result)
  })
}
