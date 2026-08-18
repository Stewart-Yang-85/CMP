/**
 * Inbound supplier webhooks: HTTP header **webhookKey** must match upstream_integrations.webhookKey.
 */

type HeaderReq = { headers: Record<string, string | string[] | undefined> }

function pickHeader(req: HeaderReq, name: string): string | null {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return raw[0] ? String(raw[0]).trim() : null
  return raw ? String(raw).trim() : null
}

export function getInboundWebhookKeyFromReq(req: HeaderReq): string | null {
  return pickHeader(req, 'webhookkey')
}
