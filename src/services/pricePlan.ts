type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string }

type AuditContext = {
  actorUserId?: string | null
  actorRole?: string | null
  requestId?: string | null
  sourceIp?: string | null
}

function isValidUuid(value: unknown) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function toError(status: number, code: string, message: string) {
  return { ok: false, status, code, message } as const
}

async function writeAuditLog(supabase: SupabaseClient, payload: Record<string, unknown>) {
  await supabase.insert('audit_logs', payload, { returning: 'minimal' })
}

function toNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function toInteger(value: unknown) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Number.isInteger(num) ? num : Math.trunc(num)
}

function normalizePaygRates(paygRates: unknown, meta: unknown) {
  const zones: Record<string, { mccmnc: string[]; ratePerKb: number }> = {}
  const list = Array.isArray(paygRates) ? paygRates : []
  for (const rate of list) {
    if (!rate || typeof rate !== 'object') continue
    const zoneCode = String((rate as { zoneCode?: string }).zoneCode || '').trim()
    const countries = Array.isArray((rate as { countries?: unknown[] }).countries)
      ? (rate as { countries?: unknown[] }).countries!.map((c) => String(c).trim()).filter(Boolean)
      : []
    const ratePerKb = toNumber((rate as { ratePerKb?: unknown }).ratePerKb)
    if (!zoneCode || !countries.length || ratePerKb === null || ratePerKb < 0) {
      return { ok: false as const, message: 'paygRates must include zoneCode, countries[], and ratePerKb >= 0.' }
    }
    zones[zoneCode] = { mccmnc: countries, ratePerKb }
  }
  return { ok: true as const, value: { zones, meta } }
}

function denormalizePaygRates(paygRates: any) {
  const zones = paygRates?.zones || {}
  const out = []
  for (const [zoneCode, zone] of Object.entries(zones)) {
    if (!zone) continue
    out.push({
      zoneCode,
      countries: Array.isArray((zone as { mccmnc?: unknown[] }).mccmnc) ? (zone as { mccmnc?: unknown[] }).mccmnc : [],
      ratePerKb: (zone as { ratePerKb?: number }).ratePerKb ?? 0,
    })
  }
  return out
}

function resolveVersionStatus(version: any) {
  if (!version || !version.effective_from) return 'DRAFT'
  const now = Date.now()
  const effective = new Date(version.effective_from).getTime()
  if (Number.isNaN(effective)) return 'DRAFT'
  return effective <= now ? 'PUBLISHED' : 'DRAFT'
}

function buildMeta(payload: any) {
  const meta: Record<string, unknown> = {}
  if (payload?.commercialTerms) meta.commercialTerms = payload.commercialTerms
  if (payload?.controlPolicy) meta.controlPolicy = payload.controlPolicy
  if (payload?.expiryBoundary) meta.expiryBoundary = payload.expiryBoundary
  if (payload?.prorationRounding) meta.prorationRounding = payload.prorationRounding
  return Object.keys(meta).length ? meta : null
}

function validatePayload(payload: any): ServiceResult<{
  name: string
  type: string
  serviceType: string
  currency: string
  billingCycleType: string
  firstCycleProration: string
  monthlyFee: number | null
  deactivatedMonthlyFee: number | null
  oneTimeFee: number | null
  quotaKb: number | null
  validityDays: number | null
  perSimQuotaKb: number | null
  totalQuotaKb: number | null
  overageRatePerKb: number | null
  tiers: unknown[] | null
  paygRates: unknown[] | null
  meta: unknown
}> {
  const name = String(payload?.name || '').trim()
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  const type = String(payload?.type || '').trim()
  const allowedTypes = new Set(['ONE_TIME', 'SIM_DEPENDENT_BUNDLE', 'FIXED_BUNDLE', 'TIERED_VOLUME_PRICING'])
  if (!allowedTypes.has(type)) return toError(400, 'BAD_REQUEST', 'type is invalid.')
  const serviceType = String(payload?.serviceType || '').trim()
  if (serviceType && !['DATA', 'VOICE', 'SMS'].includes(serviceType)) {
    return toError(400, 'BAD_REQUEST', 'serviceType is invalid.')
  }
  const monthlyFee = toNumber(payload?.monthlyFee)
  const deactivatedMonthlyFee = toNumber(payload?.deactivatedMonthlyFee)
  const oneTimeFee = toNumber(payload?.oneTimeFee)
  const quotaKb = toInteger(payload?.quotaKb)
  const validityDays = toInteger(payload?.validityDays)
  const perSimQuotaKb = toInteger(payload?.perSimQuotaKb)
  const totalQuotaKb = toInteger(payload?.totalQuotaKb)
  const overageRatePerKb = toNumber(payload?.overageRatePerKb)
  if (type === 'ONE_TIME') {
    if (oneTimeFee === null || oneTimeFee < 0) return toError(400, 'BAD_REQUEST', 'oneTimeFee must be >= 0.')
    if (quotaKb === null || quotaKb < 0) return toError(400, 'BAD_REQUEST', 'quotaKb must be >= 0.')
    if (validityDays === null || validityDays < 1) return toError(400, 'BAD_REQUEST', 'validityDays must be > 0.')
    const boundary = String(payload?.expiryBoundary || '').trim()
    if (!['CALENDAR_DAY_END', 'DURATION_EXCLUSIVE_END'].includes(boundary)) {
      return toError(400, 'BAD_REQUEST', 'expiryBoundary is required for ONE_TIME.')
    }
  }
  if (type !== 'ONE_TIME') {
    if (monthlyFee === null || monthlyFee < 0) return toError(400, 'BAD_REQUEST', 'monthlyFee must be >= 0.')
    if (deactivatedMonthlyFee === null || deactivatedMonthlyFee < 0) {
      return toError(400, 'BAD_REQUEST', 'deactivatedMonthlyFee must be >= 0.')
    }
    if (monthlyFee !== null && deactivatedMonthlyFee !== null && deactivatedMonthlyFee >= monthlyFee) {
      return toError(400, 'BAD_REQUEST', 'deactivatedMonthlyFee must be < monthlyFee.')
    }
  }
  if (type === 'SIM_DEPENDENT_BUNDLE') {
    if (perSimQuotaKb === null || perSimQuotaKb < 0) {
      return toError(400, 'BAD_REQUEST', 'perSimQuotaKb must be >= 0.')
    }
  }
  if (type === 'FIXED_BUNDLE') {
    if (totalQuotaKb === null || totalQuotaKb < 0) {
      return toError(400, 'BAD_REQUEST', 'totalQuotaKb must be >= 0.')
    }
  }
  if (type === 'TIERED_VOLUME_PRICING') {
    const tiers = Array.isArray(payload?.tiers) ? payload.tiers : []
    if (!tiers.length) return toError(400, 'BAD_REQUEST', 'tiers must be provided.')
    for (const tier of tiers) {
      const fromKb = toInteger((tier as { fromKb?: unknown }).fromKb)
      const toKb = toInteger((tier as { toKb?: unknown }).toKb)
      const ratePerKb = toNumber((tier as { ratePerKb?: unknown }).ratePerKb)
      if (fromKb === null || fromKb < 0 || toKb === null || toKb <= fromKb || ratePerKb === null || ratePerKb < 0) {
        return toError(400, 'BAD_REQUEST', 'tiers must include fromKb < toKb and ratePerKb >= 0.')
      }
    }
  }
  if (overageRatePerKb !== null && overageRatePerKb < 0) {
    return toError(400, 'BAD_REQUEST', 'overageRatePerKb must be >= 0.')
  }
  return {
    ok: true,
    value: {
      name,
      type,
      serviceType: serviceType || 'DATA',
      currency: payload?.currency ? String(payload.currency) : 'USD',
      billingCycleType: payload?.billingCycleType ? String(payload.billingCycleType) : 'CALENDAR_MONTH',
      firstCycleProration: payload?.firstCycleProration ? String(payload.firstCycleProration) : 'NONE',
      monthlyFee,
      deactivatedMonthlyFee,
      oneTimeFee,
      quotaKb,
      validityDays,
      perSimQuotaKb,
      totalQuotaKb,
      overageRatePerKb,
      tiers: Array.isArray(payload?.tiers) ? payload.tiers : null,
      paygRates: Array.isArray(payload?.paygRates) ? payload.paygRates : null,
      meta: buildMeta(payload),
    },
  }
}

async function loadPricePlan(supabase: SupabaseClient, pricePlanId: string) {
  const rows = await supabase.select(
    'price_plans',
    `select=price_plan_id,enterprise_id,name,type,service_type,currency,billing_cycle_type,first_cycle_proration,created_at&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadLatestVersion(supabase: SupabaseClient, pricePlanId: string) {
  const rows = await supabase.select(
    'price_plan_versions',
    `select=price_plan_version_id,price_plan_id,version,effective_from,monthly_fee,deactivated_monthly_fee,one_time_fee,quota_kb,validity_days,per_sim_quota_kb,total_quota_kb,overage_rate_per_kb,tiers,payg_rates,created_at&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&order=version.desc&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

function mapVersionResponse(version: any) {
  if (!version) return null
  const meta = version.payg_rates?.meta || null
  return {
    pricePlanVersionId: version.price_plan_version_id,
    version: version.version,
    status: resolveVersionStatus(version),
    effectiveFrom: version.effective_from,
    monthlyFee: version.monthly_fee,
    deactivatedMonthlyFee: version.deactivated_monthly_fee,
    oneTimeFee: version.one_time_fee,
    quotaKb: version.quota_kb,
    validityDays: version.validity_days,
    perSimQuotaKb: version.per_sim_quota_kb,
    totalQuotaKb: version.total_quota_kb,
    overageRatePerKb: version.overage_rate_per_kb,
    tiers: version.tiers ?? null,
    paygRates: denormalizePaygRates(version.payg_rates),
    commercialTerms: meta?.commercialTerms ?? null,
    controlPolicy: meta?.controlPolicy ?? null,
    expiryBoundary: meta?.expiryBoundary ?? null,
    prorationRounding: meta?.prorationRounding ?? null,
    createdAt: version.created_at,
  }
}

export async function createPricePlan({
  supabase,
  enterpriseId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  payload: unknown
  audit?: AuditContext
}) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const validated = validatePayload(payload)
  if (!validated.ok) return validated
  const {
    name,
    type,
    serviceType,
    currency,
    billingCycleType,
    firstCycleProration,
    monthlyFee,
    deactivatedMonthlyFee,
    oneTimeFee,
    quotaKb,
    validityDays,
    perSimQuotaKb,
    totalQuotaKb,
    overageRatePerKb,
    tiers,
    paygRates,
    meta,
  } = validated.value
  const paygNormalize = normalizePaygRates(paygRates, meta)
  if (!paygNormalize.ok) return toError(400, 'BAD_REQUEST', paygNormalize.message)
  const created = await supabase.insert(
    'price_plans',
    {
      enterprise_id: enterpriseId,
      name,
      type,
      service_type: serviceType,
      currency,
      billing_cycle_type: billingCycleType,
      first_cycle_proration: firstCycleProration,
    },
    { returning: 'representation' }
  )
  const plan = Array.isArray(created) ? created[0] : null
  if (!(plan as any)?.price_plan_id) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to create price plan.')
  }
  const versionRows = await supabase.insert(
    'price_plan_versions',
    {
      price_plan_id: (plan as any).price_plan_id,
      version: 1,
      effective_from: null,
      monthly_fee: monthlyFee ?? 0,
      deactivated_monthly_fee: deactivatedMonthlyFee ?? 0,
      one_time_fee: oneTimeFee ?? null,
      quota_kb: quotaKb ?? null,
      validity_days: validityDays ?? null,
      per_sim_quota_kb: perSimQuotaKb ?? null,
      total_quota_kb: totalQuotaKb ?? null,
      overage_rate_per_kb: overageRatePerKb ?? null,
      tiers: tiers ?? null,
      payg_rates: paygNormalize.value,
    },
    { returning: 'representation' }
  )
  const version = Array.isArray(versionRows) ? versionRows[0] : null
  if ((plan as any)?.price_plan_id) {
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: enterpriseId ?? null,
      action: 'PRICE_PLAN_CREATED',
      target_type: 'PRICE_PLAN',
      target_id: (plan as any).price_plan_id,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: {
        pricePlanId: (plan as any).price_plan_id,
        pricePlanVersionId: (version as any)?.price_plan_version_id ?? null,
        version: (version as any)?.version ?? 1,
      },
    })
  }
  return {
    ok: true,
    value: {
      pricePlanId: (plan as any).price_plan_id,
      version: (version as any)?.version ?? 1,
      status: 'DRAFT',
      createdAt: (version as any)?.created_at ?? (plan as any).created_at,
    },
  }
}

export async function listPricePlans({
  supabase,
  enterpriseId,
  type,
  status,
  page,
  pageSize,
}: {
  supabase: SupabaseClient
  enterpriseId: string
  type?: string | null
  status?: string | null
  page?: number | string | null
  pageSize?: number | string | null
}): Promise<ServiceResult<{ items: unknown[]; total: number }>> {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,enterprise_id,name,type,service_type,currency,billing_cycle_type,first_cycle_proration,created_at&enterprise_id=eq.${encodeURIComponent(enterpriseId)}${type ? `&type=eq.${encodeURIComponent(type)}` : ''}&order=created_at.desc`
  )
  const plans = Array.isArray(planRows) ? planRows : []
  const ids = plans.map((p: any) => p.price_plan_id).filter(Boolean)
  let versions: any[] = []
  if (ids.length) {
    const idFilter = ids.map((id) => encodeURIComponent(id)).join(',')
    const versionRows = await supabase.select(
      'price_plan_versions',
      `select=price_plan_version_id,price_plan_id,version,effective_from,monthly_fee,deactivated_monthly_fee,one_time_fee,quota_kb,validity_days,per_sim_quota_kb,total_quota_kb,overage_rate_per_kb,tiers,payg_rates,created_at&price_plan_id=in.(${idFilter})&order=version.desc`
    )
    versions = Array.isArray(versionRows) ? versionRows : []
  }
  const latestByPlan = new Map<string, any>()
  for (const v of versions) {
    if (!v?.price_plan_id) continue
    if (!latestByPlan.has(v.price_plan_id)) latestByPlan.set(v.price_plan_id, v)
  }
  let items = plans.map((plan: any) => {
    const version = latestByPlan.get(plan.price_plan_id) || null
    const statusValue = resolveVersionStatus(version)
    return {
      pricePlanId: plan.price_plan_id,
      name: plan.name,
      type: plan.type,
      serviceType: plan.service_type,
      currency: plan.currency,
      billingCycleType: plan.billing_cycle_type,
      firstCycleProration: plan.first_cycle_proration,
      status: statusValue,
      latestVersion: mapVersionResponse(version),
      createdAt: plan.created_at,
    }
  })
  if (status) items = items.filter((it) => String((it as any).status) === String(status))
  const p = Number(page) || 1
  const ps = Number(pageSize) || 20
  const start = (p - 1) * ps
  const total = items.length
  items = items.slice(start, start + ps)
  return { ok: true, value: { items, total } }
}

export async function getPricePlanDetail({ supabase, pricePlanId }: { supabase: SupabaseClient; pricePlanId: string }) {
  if (!isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.')
  }
  const plan = await loadPricePlan(supabase, pricePlanId)
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  const versions = await supabase.select(
    'price_plan_versions',
    `select=price_plan_version_id,price_plan_id,version,effective_from,monthly_fee,deactivated_monthly_fee,one_time_fee,quota_kb,validity_days,per_sim_quota_kb,total_quota_kb,overage_rate_per_kb,tiers,payg_rates,created_at&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&order=version.desc`
  )
  const list = Array.isArray(versions) ? versions : []
  const currentVersion = list.length ? list[0] : null
  return {
    ok: true,
    value: {
      pricePlanId: (plan as any).price_plan_id,
      enterpriseId: (plan as any).enterprise_id,
      name: (plan as any).name,
      type: (plan as any).type,
      serviceType: (plan as any).service_type,
      currency: (plan as any).currency,
      billingCycleType: (plan as any).billing_cycle_type,
      firstCycleProration: (plan as any).first_cycle_proration,
      createdAt: (plan as any).created_at,
      currentVersion: mapVersionResponse(currentVersion),
      versions: list.map(mapVersionResponse),
    },
  }
}

export async function createPricePlanVersion({
  supabase,
  pricePlanId,
  payload,
  audit,
}: {
  supabase: SupabaseClient
  pricePlanId: string
  payload: unknown
  audit?: AuditContext
}) {
  if (!isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.')
  }
  const plan = await loadPricePlan(supabase, pricePlanId)
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  const validated = validatePayload({ ...(payload as any), name: (plan as any).name, type: (plan as any).type, serviceType: (plan as any).service_type })
  if (!validated.ok) return validated
  const latest = await loadLatestVersion(supabase, pricePlanId)
  const nextVersion = ((latest as any)?.version ?? 0) + 1
  const {
    monthlyFee,
    deactivatedMonthlyFee,
    oneTimeFee,
    quotaKb,
    validityDays,
    perSimQuotaKb,
    totalQuotaKb,
    overageRatePerKb,
    tiers,
    paygRates,
    meta,
  } = validated.value
  const paygNormalize = normalizePaygRates(paygRates, meta)
  if (!paygNormalize.ok) return toError(400, 'BAD_REQUEST', paygNormalize.message)
  const rows = await supabase.insert(
    'price_plan_versions',
    {
      price_plan_id: pricePlanId,
      version: nextVersion,
      effective_from: null,
      monthly_fee: monthlyFee ?? 0,
      deactivated_monthly_fee: deactivatedMonthlyFee ?? 0,
      one_time_fee: oneTimeFee ?? null,
      quota_kb: quotaKb ?? null,
      validity_days: validityDays ?? null,
      per_sim_quota_kb: perSimQuotaKb ?? null,
      total_quota_kb: totalQuotaKb ?? null,
      overage_rate_per_kb: overageRatePerKb ?? null,
      tiers: tiers ?? null,
      payg_rates: paygNormalize.value,
    },
    { returning: 'representation' }
  )
  const version = Array.isArray(rows) ? rows[0] : null
  if (!(version as any)?.price_plan_version_id) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to create price plan version.')
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: (plan as any).enterprise_id ?? null,
    action: 'PRICE_PLAN_VERSION_CREATED',
    target_type: 'PRICE_PLAN',
    target_id: pricePlanId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      pricePlanVersionId: (version as any).price_plan_version_id,
      version: (version as any).version ?? nextVersion,
    },
  })
  return {
    ok: true,
    value: mapVersionResponse(version),
  }
}
