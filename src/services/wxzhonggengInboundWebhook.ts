import type { FastifyReply, FastifyRequest } from 'fastify'
import { resolveEventScopeColumns, sanitizeEventPayload } from './eventEmitter.js'

export type WxInboundWebhookDeps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => {
    select: (table: string, queryString: string) => Promise<unknown>
    insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
    update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  }
  getTraceId: (res: FastifyReply) => string | null
  sendError: (res: FastifyReply, status: number, code: string, message: string) => void
  requireIccid: (res: FastifyReply, value: unknown, label?: string) => string | null
  validateWebhookTimestamp: (res: FastifyReply, occurredAt: string | null, maxAgeMinutes: number) => boolean
  isDuplicateEventByPayloadField: (args: {
    supabase: unknown
    eventType: string
    field: string
    value: string
  }) => Promise<boolean>
  toIsoDateTime: (value: unknown) => string | null
  wxWebhookMaxAgeMinutes: number
}

function demoIccidAllowed(iccid: string) {
  const demoList = (process.env.DEMO_SIMS || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  return demoList.includes(iccid)
}

async function insertSimScopedEvent(
  supabase: ReturnType<WxInboundWebhookDeps['createSupabaseRestClient']>,
  sim: { enterprise_id?: string | null; reseller_id?: string | null },
  row: {
    event_type: string
    occurred_at: string
    request_id?: string | null
    payload: Record<string, unknown>
  },
) {
  const scope = await resolveEventScopeColumns(supabase as any, {
    enterpriseId: sim.enterprise_id != null ? String(sim.enterprise_id) : null,
    resellerId: sim.reseller_id != null ? String(sim.reseller_id) : null,
  })
  await supabase.insert(
    'events',
    {
      event_type: row.event_type,
      occurred_at: row.occurred_at,
      enterprise_id: scope.enterpriseId,
      reseller_id: scope.resellerId,
      request_id: row.request_id ?? null,
      payload: sanitizeEventPayload(row.payload),
    },
    { returning: 'minimal' },
  )
}

export function createWxzhonggengInboundHandlers(deps: WxInboundWebhookDeps) {
  const handleUpdateLocation = async (req: FastifyRequest, res: FastifyReply) => {
    const supabase = deps.createSupabaseRestClient({ useServiceRole: true, traceId: deps.getTraceId(res) })
    const iccid = deps.requireIccid(res, (req as any).body?.iccid)
    const body = (req as any).body ?? {}
    const messageType = String(body.messageType || '').trim()
    const msisdn = String(body.msisdn || '').trim()
    const sign = String(body.sign || '').trim()
    const uuid = String(body.uuid || '').trim()
    const data = body.data ?? {}
    const mncList = String(data?.mncList || '').trim()
    const eventTime = String(data?.eventTime || '').trim()
    const mcc = String(data?.mcc || '').trim()
    const occurredAt = (eventTime ? deps.toIsoDateTime(eventTime) : null) ?? new Date().toISOString()
    if (!iccid) return
    if (!messageType || !msisdn || !sign || !uuid || !mncList || !eventTime || !mcc) {
      return deps.sendError(
        res,
        400,
        'BAD_REQUEST',
        'messageType, msisdn, sign, uuid, data.mncList, data.eventTime, data.mcc are required.'
      )
    }
    if (!deps.validateWebhookTimestamp(res, occurredAt, deps.wxWebhookMaxAgeMinutes)) return
    const isDuplicate = await deps.isDuplicateEventByPayloadField({
      supabase,
      eventType: 'UPDATE_LOCATION',
      field: 'uuid',
      value: uuid,
    })
    if (isDuplicate) return res.send({ success: true, duplicate: true })
    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,enterprise_id,reseller_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      if (demoIccidAllowed(iccid)) return res.send({ success: true, demo: true })
      return deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    await insertSimScopedEvent(supabase, sim as { enterprise_id?: string | null; reseller_id?: string | null }, {
      event_type: 'UPDATE_LOCATION',
      occurred_at: occurredAt,
      request_id: deps.getTraceId(res),
      payload: { iccid, messageType, msisdn, mncList, mcc, eventTime, uuid },
    })
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'SYSTEM',
        tenant_id: (sim as any).enterprise_id ?? null,
        action: 'WX_WEBHOOK_SIM_ONLINE',
        target_type: 'SIM',
        target_id: (sim as any).iccid,
        request_id: deps.getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.send({ success: true })
  }

  const handleSimStatusChanged = async (req: FastifyRequest, res: FastifyReply) => {
    const supabase = deps.createSupabaseRestClient({ useServiceRole: true, traceId: deps.getTraceId(res) })
    const iccid = deps.requireIccid(res, (req as any).body?.iccid)
    const body = (req as any).body ?? {}
    const messageType = String(body.messageType || '').trim()
    const msisdn = String(body.msisdn || '').trim()
    const sign = String(body.sign || '').trim()
    const uuid = String(body.uuid || '').trim()
    const data = body.data ?? {}
    const toStatus = String(data?.toStatus || '').trim()
    const fromStatus = String(data?.fromStatus || '').trim()
    const eventTime = String(data?.eventTime || '').trim()
    const transactionId = String(data?.transactionId || '').trim()
    const occurredAt = (eventTime ? deps.toIsoDateTime(eventTime) : null) ?? new Date().toISOString()
    if (!iccid) return
    if (!messageType || !msisdn || !sign || !uuid || !toStatus || !fromStatus || !eventTime || !transactionId) {
      return deps.sendError(
        res,
        400,
        'BAD_REQUEST',
        'messageType, msisdn, sign, uuid, data.toStatus, data.fromStatus, data.eventTime, data.transactionId are required.'
      )
    }
    if (!deps.validateWebhookTimestamp(res, occurredAt, deps.wxWebhookMaxAgeMinutes)) return
    const isDuplicate = await deps.isDuplicateEventByPayloadField({
      supabase,
      eventType: 'INBOUND_SIM_STATUS_CHANGED',
      field: 'transactionId',
      value: transactionId,
    })
    if (isDuplicate) return res.send({ success: true, duplicate: true })
    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,enterprise_id,reseller_id,upstream_status,upstream_info&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      if (demoIccidAllowed(iccid)) return res.send({ success: true, demo: true })
      return deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    await supabase.update(
      'sims',
      `sim_id=eq.${encodeURIComponent((sim as any).sim_id)}`,
      {
        upstream_status: toStatus,
        upstream_info: { toStatus, fromStatus, transactionId, eventTime: occurredAt },
      },
      { returning: 'minimal' }
    )
    await insertSimScopedEvent(supabase, sim as { enterprise_id?: string | null; reseller_id?: string | null }, {
      event_type: 'INBOUND_SIM_STATUS_CHANGED',
      occurred_at: occurredAt,
      request_id: deps.getTraceId(res),
      payload: { iccid, messageType, msisdn, toStatus, fromStatus, transactionId, eventTime: occurredAt, uuid },
    })
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'SYSTEM',
        tenant_id: (sim as any).enterprise_id ?? null,
        action: 'WX_WEBHOOK_SIM_STATUS_CHANGED',
        target_type: 'SIM',
        target_id: (sim as any).iccid,
        request_id: deps.getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.send({ success: true })
  }

  const handleTrafficAlert = async (req: FastifyRequest, res: FastifyReply) => {
    const supabase = deps.createSupabaseRestClient({ useServiceRole: true, traceId: deps.getTraceId(res) })
    const iccid = deps.requireIccid(res, (req as any).body?.iccid)
    const body = (req as any).body ?? {}
    const messageType = String(body.messageType || '').trim()
    const msisdn = String(body.msisdn || '').trim()
    const sign = String(body.sign || '').trim()
    const uuid = String(body.uuid || '').trim()
    const data = body.data ?? {}
    const thresholdReached = String(data?.thresholdReached || '').trim()
    const eventTime = String(data?.eventTime || '').trim()
    const limit = String(data?.limit || '').trim()
    const eventName = String(data?.eventName || '').trim()
    const balanceAmount = String(data?.balanceAmount || '').trim()
    const addOnID = String(data?.addOnID || '').trim()
    const occurredAt = (eventTime ? deps.toIsoDateTime(eventTime) : null) ?? new Date().toISOString()
    if (!iccid) return
    if (
      !messageType ||
      !msisdn ||
      !sign ||
      !uuid ||
      !thresholdReached ||
      !eventTime ||
      !limit ||
      !eventName ||
      !balanceAmount ||
      !addOnID
    ) {
      return deps.sendError(
        res,
        400,
        'BAD_REQUEST',
        'messageType, msisdn, sign, uuid, data.thresholdReached, data.eventTime, data.limit, data.eventName, data.balanceAmount, data.addOnID are required.'
      )
    }
    if (!deps.validateWebhookTimestamp(res, occurredAt, deps.wxWebhookMaxAgeMinutes)) return
    const isDuplicate = await deps.isDuplicateEventByPayloadField({
      supabase,
      eventType: 'TRAFFIC_ALERT',
      field: 'uuid',
      value: uuid,
    })
    if (isDuplicate) return res.send({ success: true, duplicate: true })
    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,enterprise_id,reseller_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      if (demoIccidAllowed(iccid)) return res.send({ success: true, demo: true })
      return deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    await insertSimScopedEvent(supabase, sim as { enterprise_id?: string | null; reseller_id?: string | null }, {
      event_type: 'TRAFFIC_ALERT',
      occurred_at: occurredAt,
      request_id: deps.getTraceId(res),
      payload: { iccid, messageType, msisdn, thresholdReached, eventTime, limit, eventName, balanceAmount, addOnID, uuid },
    })
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'SYSTEM',
        tenant_id: (sim as any).enterprise_id ?? null,
        action: 'WX_WEBHOOK_TRAFFIC_ALERT',
        target_type: 'SIM',
        target_id: (sim as any).iccid,
        request_id: deps.getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.send({ success: true })
  }

  const handleSubscription = async (req: FastifyRequest, res: FastifyReply) => {
    const supabase = deps.createSupabaseRestClient({ useServiceRole: true, traceId: deps.getTraceId(res) })
    const iccid = deps.requireIccid(res, (req as any).body?.iccid)
    const body = (req as any).body ?? {}
    const messageType = String(body.messageType || '').trim()
    const msisdn = String(body.msisdn || '').trim()
    const sign = String(body.sign || '').trim()
    const uuid = String(body.uuid || '').trim()
    const data = body.data ?? {}
    const addOnId = String(data?.addOnId || '').trim()
    const addOnType = String(data?.addOnType || '').trim()
    const startDate = String(data?.startDate || '').trim()
    const transactionId = String(data?.transactionId || '').trim()
    const expirationDate = String(data?.expirationDate || '').trim()
    const occurredAt = (startDate ? deps.toIsoDateTime(startDate) : null) ?? new Date().toISOString()
    if (!iccid) return
    if (!messageType || !msisdn || !sign || !uuid || !addOnId || !addOnType || !startDate || !transactionId || !expirationDate) {
      return deps.sendError(
        res,
        400,
        'BAD_REQUEST',
        'messageType, msisdn, sign, uuid, data.addOnId, data.addOnType, data.startDate, data.transactionId, data.expirationDate are required.'
      )
    }
    if (!deps.validateWebhookTimestamp(res, occurredAt, deps.wxWebhookMaxAgeMinutes)) return
    const isDuplicate = await deps.isDuplicateEventByPayloadField({
      supabase,
      eventType: 'SUBSCRIPTION',
      field: 'transactionId',
      value: transactionId,
    })
    if (isDuplicate) return res.send({ success: true, duplicate: true })
    const rows = await supabase.select(
      'sims',
      `select=sim_id,iccid,enterprise_id,reseller_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    )
    const sim = Array.isArray(rows) ? rows[0] : null
    if (!sim) {
      if (demoIccidAllowed(iccid)) return res.send({ success: true, demo: true })
      return deps.sendError(res, 404, 'RESOURCE_NOT_FOUND', `sim ${iccid} not found.`)
    }
    await insertSimScopedEvent(supabase, sim as { enterprise_id?: string | null; reseller_id?: string | null }, {
      event_type: 'SUBSCRIPTION',
      occurred_at: occurredAt,
      request_id: deps.getTraceId(res),
      payload: { iccid, messageType, msisdn, addOnId, addOnType, startDate, transactionId, expirationDate, uuid },
    })
    await supabase.insert(
      'audit_logs',
      {
        actor_role: 'SYSTEM',
        tenant_id: (sim as any).enterprise_id ?? null,
        action: 'WX_WEBHOOK_SUBSCRIPTION',
        target_type: 'SIM',
        target_id: (sim as any).iccid,
        request_id: deps.getTraceId(res),
        source_ip: req.ip,
      },
      { returning: 'minimal' }
    )
    res.send({ success: true })
  }

  return {
    'update-location': handleUpdateLocation,
    'sim-status-changed': handleSimStatusChanged,
    'traffic-alert': handleTrafficAlert,
    'subscription': handleSubscription,
  } as const
}

export type WxInboundWebhookHandlerMap = ReturnType<typeof createWxzhonggengInboundHandlers>
