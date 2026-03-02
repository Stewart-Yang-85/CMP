import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookSubscription,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  retryWebhookDelivery,
  updateWebhookSubscription,
} from '../services/webhook.js'

function getAuth(req) {
  const auth = req?.cmpAuth ?? {}
  return {
    roleScope: auth.roleScope ? String(auth.roleScope) : null,
    role: auth.role ? String(auth.role) : null,
    resellerId: auth.resellerId ? String(auth.resellerId) : null,
    customerId: auth.customerId ? String(auth.customerId) : null,
    userId: auth.userId ? String(auth.userId) : null,
  }
}

function resolveScope(req, res, deps) {
  const auth = getAuth(req)
  const roleScope = deps.getRoleScope(req) ?? auth.roleScope
  if (!roleScope && !auth.role) {
    deps.sendError(res, 401, 'UNAUTHORIZED', 'Authentication required.')
    return null
  }
  if (roleScope === 'platform' || auth.role === 'platform_admin') {
    return { scope: 'platform' }
  }
  if (roleScope === 'reseller' && auth.role === 'reseller_admin') {
    if (!auth.resellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.')
      return null
    }
    return { scope: 'reseller', resellerId: auth.resellerId }
  }
  if (roleScope === 'customer' && auth.role === 'customer_admin') {
    const enterpriseId = deps.getEnterpriseIdFromReq(req) ?? auth.customerId
    if (!enterpriseId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'Customer scope required.')
      return null
    }
    return { scope: 'customer', customerId: enterpriseId }
  }
  deps.sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

async function resolveTargetScope({ req, res, deps, supabase, scope, body, query }) {
  const source = body ?? query ?? {}
  if (scope.scope === 'platform') {
    const resellerId = source.resellerId ? String(source.resellerId).trim() : null
    const enterpriseId = source.enterpriseId ? String(source.enterpriseId).trim() : null
    if (resellerId && enterpriseId) {
      deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId and enterpriseId cannot be used together.')
      return null
    }
    if (resellerId) {
      if (!deps.isValidUuid(resellerId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
        return null
      }
      const rows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
      )
      if (!Array.isArray(rows) || !rows[0]) {
        deps.sendError(res, 404, 'NOT_FOUND', 'reseller not found.')
        return null
      }
      return { resellerId }
    }
    if (enterpriseId) {
      if (!deps.isValidUuid(enterpriseId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const rows = await supabase.select(
        'tenants',
        `select=tenant_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
      )
      if (!Array.isArray(rows) || !rows[0]) {
        deps.sendError(res, 404, 'NOT_FOUND', 'enterprise not found.')
        return null
      }
      return { customerId: enterpriseId }
    }
    return { resellerId: null, customerId: null }
  }
  if (scope.scope === 'reseller') {
    const enterpriseId = source.enterpriseId ? String(source.enterpriseId).trim() : null
    if (enterpriseId) {
      if (!deps.isValidUuid(enterpriseId)) {
        deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
        return null
      }
      const resolved = await deps.resolveEnterpriseForReseller(req, res, supabase, enterpriseId)
      if (!resolved) return null
      return { customerId: resolved }
    }
    return { resellerId: scope.resellerId }
  }
  return { customerId: scope.customerId }
}

function isValidDeliveryId(value) {
  const s = String(value || '').trim()
  return /^\d+$/.test(s)
}

export function registerWebhookRoutes({ app, prefix, deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    getRoleScope,
    getEnterpriseIdFromReq,
    resolveEnterpriseForReseller,
    isValidUuid,
  } = deps

  app.post(`${prefix}/webhook-subscriptions`, async (req, res) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const target = await resolveTargetScope({
      req,
      res,
      deps,
      supabase,
      scope,
      body: req.body ?? {},
    })
    if (!target) return
    const result = await createWebhookSubscription({
      supabase,
      payload: req.body ?? {},
      resellerId: target.resellerId ?? null,
      customerId: target.customerId ?? null,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.status(201).json(result.value)
  })

  app.get(`${prefix}/webhook-subscriptions`, async (req, res) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const target = await resolveTargetScope({
      req,
      res,
      deps,
      supabase,
      scope,
      query: req.query ?? {},
    })
    if (!target) return
    const result = await listWebhookSubscriptions({
      supabase,
      resellerId: target.resellerId ?? null,
      customerId: target.customerId ?? null,
      page: req.query?.page ?? null,
      pageSize: req.query?.pageSize ?? null,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/webhook-subscriptions/:webhookId`, async (req, res) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const webhookId = req.params?.webhookId ? String(req.params.webhookId).trim() : ''
    if (!webhookId || !isValidUuid(webhookId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'webhookId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getWebhookSubscription({ supabase, webhookId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    if (scope.scope === 'reseller' && result.value.resellerId !== scope.resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of reseller scope.')
    }
    if (scope.scope === 'customer' && result.value.customerId !== scope.customerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of customer scope.')
    }
    res.json(result.value)
  })

  app.patch(`${prefix}/webhook-subscriptions/:webhookId`, async (req, res) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const webhookId = req.params?.webhookId ? String(req.params.webhookId).trim() : ''
    if (!webhookId || !isValidUuid(webhookId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'webhookId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const current = await getWebhookSubscription({ supabase, webhookId })
    if (!current.ok) return sendError(res, current.status, current.code, current.message)
    if (scope.scope === 'reseller' && current.value.resellerId !== scope.resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of reseller scope.')
    }
    if (scope.scope === 'customer' && current.value.customerId !== scope.customerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of customer scope.')
    }
    const result = await updateWebhookSubscription({ supabase, webhookId, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.delete(`${prefix}/webhook-subscriptions/:webhookId`, async (req, res) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const webhookId = req.params?.webhookId ? String(req.params.webhookId).trim() : ''
    if (!webhookId || !isValidUuid(webhookId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'webhookId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const current = await getWebhookSubscription({ supabase, webhookId })
    if (!current.ok) return sendError(res, current.status, current.code, current.message)
    if (scope.scope === 'reseller' && current.value.resellerId !== scope.resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of reseller scope.')
    }
    if (scope.scope === 'customer' && current.value.customerId !== scope.customerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of customer scope.')
    }
    const result = await deleteWebhookSubscription({ supabase, webhookId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.get(`${prefix}/webhook-subscriptions/:webhookId/deliveries`, async (req, res) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const webhookId = req.params?.webhookId ? String(req.params.webhookId).trim() : ''
    if (!webhookId || !isValidUuid(webhookId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'webhookId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const current = await getWebhookSubscription({ supabase, webhookId })
    if (!current.ok) return sendError(res, current.status, current.code, current.message)
    if (scope.scope === 'reseller' && current.value.resellerId !== scope.resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of reseller scope.')
    }
    if (scope.scope === 'customer' && current.value.customerId !== scope.customerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of customer scope.')
    }
    const result = await listWebhookDeliveries({
      supabase,
      webhookId,
      page: req.query?.page ?? null,
      pageSize: req.query?.pageSize ?? null,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })

  app.post(`${prefix}/webhook-deliveries/:deliveryId/retry`, async (req, res) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const deliveryId = req.params?.deliveryId ? String(req.params.deliveryId).trim() : ''
    if (!deliveryId || !isValidDeliveryId(deliveryId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'deliveryId must be a valid integer.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const deliveryRows = await supabase.select(
      'webhook_deliveries',
      `select=delivery_id,webhook_id&delivery_id=eq.${encodeURIComponent(deliveryId)}&limit=1`
    )
    const delivery = Array.isArray(deliveryRows) ? deliveryRows[0] : null
    if (!delivery?.webhook_id) {
      return sendError(res, 404, 'NOT_FOUND', 'webhook delivery not found.')
    }
    const current = await getWebhookSubscription({ supabase, webhookId: String(delivery.webhook_id) })
    if (!current.ok) return sendError(res, current.status, current.code, current.message)
    if (scope.scope === 'reseller' && current.value.resellerId !== scope.resellerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of reseller scope.')
    }
    if (scope.scope === 'customer' && current.value.customerId !== scope.customerId) {
      return sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of customer scope.')
    }
    const result = await retryWebhookDelivery({ supabase, deliveryId: Number(deliveryId) })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.json(result.value)
  })
}
