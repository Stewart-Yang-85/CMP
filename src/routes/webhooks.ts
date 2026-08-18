import {
  createWebhookSubscription,
  deprecateWebhookSubscription,
  getWebhookSubscription,
  listOutboundWebhookEvents,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  retryWebhookDelivery,
  updateWebhookSubscription,
} from '../services/webhook.js'

type Deps = {
  createSupabaseRestClient: (args: { useServiceRole: boolean; traceId?: string | null }) => any
  getTraceId: (res: any) => string | null
  sendError: (res: any, status: number, code: string, message: string) => void
  getRoleScope: (req: any) => string | null
  getEnterpriseIdFromReq: (req: any) => string | null
  resolveEnterpriseForReseller: (req: any, res: any, supabase: any, enterpriseId: string | null) => Promise<string | null>
  isValidUuid: (value: string) => boolean
}

type ScopeContext =
  | { scope: 'platform'; resellerId?: string | null; enterpriseId?: string | null }
  | { scope: 'reseller'; resellerId: string }
  | { scope: 'customer'; enterpriseId: string }

type TargetScope = {
  resellerId?: string | null
  enterpriseId?: string | null
}

function getAuth(req: any) {
  const auth = req?.cmpAuth ?? {}
  return {
    roleScope: auth.roleScope ? String(auth.roleScope) : null,
    role: auth.role ? String(auth.role) : null,
    resellerId: auth.resellerId ? String(auth.resellerId) : null,
    customerId: auth.customerId ? String(auth.customerId) : null,
    userId: auth.userId ? String(auth.userId) : null,
  }
}

function resolveScope(req: any, res: any, deps: Deps): ScopeContext | null {
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
    return { scope: 'customer', enterpriseId }
  }
  deps.sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.')
  return null
}

async function lookupResellerTenantId(
  supabase: any,
  resellerId: string
): Promise<{ ok: true; resellerId: string } | { ok: false; reason: 'not_found' }> {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as { tenant_id?: string } | undefined) : null
  if (!row?.tenant_id) return { ok: false, reason: 'not_found' }
  return { ok: true, resellerId: String(row.tenant_id) }
}

async function lookupEnterpriseTenant(
  supabase: any,
  enterpriseId: string
): Promise<
  | { ok: true; enterpriseId: string; parentResellerId: string | null }
  | { ok: false; reason: 'not_found' }
> {
  const rows = await supabase.select(
    'tenants',
    `select=tenant_id,parent_id&tenant_id=eq.${encodeURIComponent(enterpriseId)}&tenant_type=eq.ENTERPRISE&limit=1`
  )
  const row = Array.isArray(rows)
    ? (rows[0] as { tenant_id?: string; parent_id?: string | null } | undefined)
    : null
  if (!row?.tenant_id) return { ok: false, reason: 'not_found' }
  return {
    ok: true,
    enterpriseId: String(row.tenant_id),
    parentResellerId: row.parent_id ? String(row.parent_id) : null,
  }
}

/**
 * Normalize optional id fields: missing / blank / whitespace → null.
 */
function readOptionalUuidField(source: Record<string, any>, key: string): string | null {
  if (source[key] === undefined || source[key] === null) return null
  const trimmed = String(source[key]).trim()
  return trimmed ? trimmed : null
}

/**
 * Validate body/query resellerId + enterpriseId existence and parent/child match.
 * Returns the normalized target scope, or null after sending an error response.
 */
async function resolveValidatedTargetIds({
  res,
  deps,
  supabase,
  resellerIdRaw,
  enterpriseIdRaw,
  requiredResellerId,
  requiredEnterpriseId,
  requireEnterpriseId,
  requireResellerId,
}: {
  res: any
  deps: Deps
  supabase: any
  resellerIdRaw: string | null
  enterpriseIdRaw: string | null
  /** When set, body resellerId (if present) must equal this; otherwise bind to it. */
  requiredResellerId?: string | null
  /** When set, body enterpriseId (if present) must equal this; otherwise bind to it. */
  requiredEnterpriseId?: string | null
  /** When true, enterpriseId must be present after resolution. */
  requireEnterpriseId?: boolean
  /** When true, resellerId must be present in the request (not only inferred). */
  requireResellerId?: boolean
}): Promise<TargetScope | null> {
  const resellerIdIn = resellerIdRaw ? String(resellerIdRaw).trim() : null
  const enterpriseIdIn = enterpriseIdRaw ? String(enterpriseIdRaw).trim() : null

  if (requireResellerId && !resellerIdIn) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId is required.')
    return null
  }
  if (requireEnterpriseId && !enterpriseIdIn && !requiredEnterpriseId) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    return null
  }

  if (resellerIdIn && !deps.isValidUuid(resellerIdIn)) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
    return null
  }
  if (enterpriseIdIn && !deps.isValidUuid(enterpriseIdIn)) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
    return null
  }

  let resellerId: string | null = null
  let enterpriseId: string | null = null
  let enterpriseParentId: string | null = null

  if (resellerIdIn) {
    const reseller = await lookupResellerTenantId(supabase, resellerIdIn)
    if (!reseller.ok) {
      deps.sendError(res, 404, 'NOT_FOUND', `reseller ${resellerIdIn} not found.`)
      return null
    }
    resellerId = reseller.resellerId
  }

  if (enterpriseIdIn) {
    const enterprise = await lookupEnterpriseTenant(supabase, enterpriseIdIn)
    if (!enterprise.ok) {
      deps.sendError(res, 404, 'NOT_FOUND', `enterprise ${enterpriseIdIn} not found.`)
      return null
    }
    enterpriseId = enterprise.enterpriseId
    enterpriseParentId = enterprise.parentResellerId
  }

  if (requiredEnterpriseId) {
    if (enterpriseIdIn && enterpriseId !== requiredEnterpriseId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'enterpriseId does not match your enterprise scope.')
      return null
    }
    enterpriseId = enterpriseId ?? requiredEnterpriseId
    if (!enterpriseParentId) {
      const ent = await lookupEnterpriseTenant(supabase, enterpriseId)
      if (!ent.ok) {
        deps.sendError(res, 404, 'NOT_FOUND', `enterprise ${enterpriseId} not found.`)
        return null
      }
      enterpriseParentId = ent.parentResellerId
    }
  }

  if (requiredResellerId) {
    if (resellerIdIn && resellerId !== requiredResellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'resellerId does not match your reseller scope.')
      return null
    }
    resellerId = resellerId ?? requiredResellerId
    const reseller = await lookupResellerTenantId(supabase, resellerId)
    if (!reseller.ok) {
      deps.sendError(res, 404, 'NOT_FOUND', `reseller ${resellerId} not found.`)
      return null
    }
    resellerId = reseller.resellerId
  }

  if (enterpriseId && !resellerId) {
    if (!enterpriseParentId) {
      deps.sendError(res, 400, 'BAD_REQUEST', 'enterprise has no parent reseller.')
      return null
    }
    const parent = await lookupResellerTenantId(supabase, enterpriseParentId)
    if (!parent.ok) {
      deps.sendError(res, 400, 'BAD_REQUEST', 'enterprise parent reseller is invalid.')
      return null
    }
    resellerId = parent.resellerId
  }

  if (resellerId && enterpriseId) {
    if (!enterpriseParentId) {
      const ent = await lookupEnterpriseTenant(supabase, enterpriseId)
      enterpriseParentId = ent.ok ? ent.parentResellerId : null
    }
    if (!enterpriseParentId || enterpriseParentId !== resellerId) {
      deps.sendError(
        res,
        400,
        'BAD_REQUEST',
        'enterpriseId does not belong to resellerId (parent/child mismatch).'
      )
      return null
    }
  }

  if (requireEnterpriseId && !enterpriseId) {
    deps.sendError(res, 400, 'BAD_REQUEST', 'enterpriseId is required.')
    return null
  }

  return { resellerId, enterpriseId }
}

async function resolveTargetScope({
  req: _req,
  res,
  deps,
  supabase,
  scope,
  body,
  query,
  mode,
}: {
  req: any
  res: any
  deps: Deps
  supabase: any
  scope: ScopeContext
  body?: Record<string, any>
  query?: Record<string, any>
  /** create: strict role rules; list: platform may omit filters */
  mode: 'create' | 'list'
}): Promise<TargetScope | null> {
  const source = body ?? query ?? {}
  const resellerIdRaw = readOptionalUuidField(source, 'resellerId')
  const enterpriseIdRaw = readOptionalUuidField(source, 'enterpriseId')

  if (scope.scope === 'platform') {
    if (mode === 'list') {
      // Platform list: filters optional. If both provided, must exist and match.
      // If only one provided, validate that one (and infer parent when only enterpriseId).
      if (!resellerIdRaw && !enterpriseIdRaw) {
        return { resellerId: null, enterpriseId: null }
      }
      return resolveValidatedTargetIds({
        res,
        deps,
        supabase,
        resellerIdRaw,
        enterpriseIdRaw,
        requireResellerId: false,
        requireEnterpriseId: false,
      })
    }
    // Platform create: both ids required, must exist and match.
    return resolveValidatedTargetIds({
      res,
      deps,
      supabase,
      resellerIdRaw,
      enterpriseIdRaw,
      requireResellerId: true,
      requireEnterpriseId: true,
    })
  }

  if (scope.scope === 'reseller') {
    if (mode === 'create') {
      // Reseller create: enterpriseId required; resellerId from token if omitted.
      return resolveValidatedTargetIds({
        res,
        deps,
        supabase,
        resellerIdRaw: resellerIdRaw ?? scope.resellerId,
        enterpriseIdRaw,
        requiredResellerId: scope.resellerId,
        requireEnterpriseId: true,
      })
    }
    // Reseller list: resellerId from token if omitted; if provided must exist + match token.
    // enterpriseId optional; if provided must belong to effective resellerId.
    return resolveValidatedTargetIds({
      res,
      deps,
      supabase,
      resellerIdRaw: resellerIdRaw ?? scope.resellerId,
      enterpriseIdRaw,
      requiredResellerId: scope.resellerId,
      requireEnterpriseId: false,
    })
  }

  // customer_admin (create + list): enterprise from token if omitted; reseller inferred.
  return resolveValidatedTargetIds({
    res,
    deps,
    supabase,
    resellerIdRaw,
    enterpriseIdRaw: enterpriseIdRaw ?? scope.enterpriseId,
    requiredEnterpriseId: scope.enterpriseId,
    requireEnterpriseId: true,
  })
}

function isValidDeliveryId(value: unknown) {
  const s = String(value || '').trim()
  return /^\d+$/.test(s)
}

function assertSubscriptionInScope(
  scope: ScopeContext,
  subscription: { resellerId?: string | null; enterpriseId?: string | null },
  res: any,
  deps: Deps
): boolean {
  if (scope.scope === 'reseller') {
    if (subscription.resellerId !== scope.resellerId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of reseller scope.')
      return false
    }
    return true
  }
  if (scope.scope === 'customer') {
    if (subscription.enterpriseId !== scope.enterpriseId) {
      deps.sendError(res, 403, 'FORBIDDEN', 'webhook subscription is out of customer scope.')
      return false
    }
    return true
  }
  return true
}

export function registerWebhookRoutes({ app, prefix, deps }: { app: any; prefix: string; deps: Deps }) {
  const {
    createSupabaseRestClient,
    getTraceId,
    sendError,
    isValidUuid,
  } = deps

  app.get(`${prefix}/outbound-webhook-events`, async (req: any, res: any) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    res.send(listOutboundWebhookEvents())
  })

  app.post(`${prefix}/webhook-subscriptions`, async (req: any, res: any) => {
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
      mode: 'create',
    })
    if (!target) return
    if (!target.resellerId && !target.enterpriseId) {
      return sendError(res, 400, 'BAD_REQUEST', 'resellerId or enterpriseId is required.')
    }
    const result = await createWebhookSubscription({
      supabase,
      payload: req.body ?? {},
      resellerId: target.resellerId ?? null,
      enterpriseId: target.enterpriseId ?? null,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.code(201).send(result.value)
  })

  app.get(`${prefix}/webhook-subscriptions`, async (req: any, res: any) => {
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
      mode: 'list',
    })
    if (!target) return
    const result = await listWebhookSubscriptions({
      supabase,
      resellerId: target.resellerId ?? null,
      enterpriseId: target.enterpriseId ?? null,
      status: req.query?.status ?? null,
      page: req.query?.page ?? null,
      pageSize: req.query?.pageSize ?? null,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/webhook-subscriptions/:webhookId`, async (req: any, res: any) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const webhookId = req.params?.webhookId ? String(req.params.webhookId).trim() : ''
    if (!webhookId || !isValidUuid(webhookId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'webhookId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const result = await getWebhookSubscription({ supabase, webhookId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    if (!assertSubscriptionInScope(scope, result.value, res, deps)) return
    res.send(result.value)
  })

  app.patch(`${prefix}/webhook-subscriptions/:webhookId`, async (req: any, res: any) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const webhookId = req.params?.webhookId ? String(req.params.webhookId).trim() : ''
    if (!webhookId || !isValidUuid(webhookId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'webhookId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const current = await getWebhookSubscription({ supabase, webhookId })
    if (!current.ok) return sendError(res, current.status, current.code, current.message)
    if (!assertSubscriptionInScope(scope, current.value, res, deps)) return
    const result = await updateWebhookSubscription({ supabase, webhookId, payload: req.body ?? {} })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/webhook-subscriptions/:webhookId/deprecate`, async (req: any, res: any) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const webhookId = req.params?.webhookId ? String(req.params.webhookId).trim() : ''
    if (!webhookId || !isValidUuid(webhookId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'webhookId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const current = await getWebhookSubscription({ supabase, webhookId })
    if (!current.ok) return sendError(res, current.status, current.code, current.message)
    if (!assertSubscriptionInScope(scope, current.value, res, deps)) return
    const result = await deprecateWebhookSubscription({ supabase, webhookId })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.get(`${prefix}/webhook-subscriptions/:webhookId/deliveries`, async (req: any, res: any) => {
    const scope = resolveScope(req, res, deps)
    if (!scope) return
    const webhookId = req.params?.webhookId ? String(req.params.webhookId).trim() : ''
    if (!webhookId || !isValidUuid(webhookId)) {
      return sendError(res, 400, 'BAD_REQUEST', 'webhookId must be a valid uuid.')
    }
    const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) })
    const current = await getWebhookSubscription({ supabase, webhookId })
    if (!current.ok) return sendError(res, current.status, current.code, current.message)
    if (!assertSubscriptionInScope(scope, current.value, res, deps)) return
    const result = await listWebhookDeliveries({
      supabase,
      webhookId,
      page: req.query?.page ?? null,
      pageSize: req.query?.pageSize ?? null,
    })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })

  app.post(`${prefix}/webhook-deliveries/:deliveryId/retry`, async (req: any, res: any) => {
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
    const delivery = Array.isArray(deliveryRows) ? (deliveryRows[0] as Record<string, any>) : null
    if (!delivery?.webhook_id) {
      return sendError(res, 404, 'NOT_FOUND', 'webhook delivery not found.')
    }
    const current = await getWebhookSubscription({ supabase, webhookId: String(delivery.webhook_id) })
    if (!current.ok) return sendError(res, current.status, current.code, current.message)
    if (!assertSubscriptionInScope(scope, current.value, res, deps)) return
    const result = await retryWebhookDelivery({ supabase, deliveryId: Number(deliveryId) })
    if (!result.ok) return sendError(res, result.status, result.code, result.message)
    res.send(result.value)
  })
}
