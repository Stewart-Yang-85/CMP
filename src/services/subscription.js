function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function isValidIccid(value) {
  const s = String(value || '').trim()
  return /^\d{18,20}$/.test(s)
}

function toError(status, code, message) {
  return { ok: false, status, code, message }
}

async function writeAuditLog(supabase, payload) {
  await supabase.insert('audit_logs', payload, { returning: 'minimal' })
}

function toIsoDateTime(value) {
  if (!value) return null
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function normalizeCommercialTerms(obj) {
  const t = obj && typeof obj === 'object' ? obj : {}
  const v = (k) => (t[k] !== undefined && t[k] !== null ? t[k] : undefined)
  const n = (x) => {
    const y = Number(x)
    return Number.isFinite(y) && y >= 0 ? y : undefined
  }
  const up = (s) => (typeof s === 'string' ? s.toUpperCase() : undefined)
  const commitmentPeriodMonths =
    n(v('commitmentPeriodMonths')) ?? n(v('commitment_period_months')) ?? n(v('commitmentMonths'))
  const commitmentPeriodDays =
    n(v('commitmentPeriodDays')) ?? n(v('commitment_period_days')) ?? n(v('commitmentDays'))
  const expiryBoundaryRaw =
    up(v('expiryBoundary')) ?? up(v('expiry_boundary'))
  const expiryBoundary =
    (expiryBoundaryRaw === 'CALENDAR_DAY_END' || expiryBoundaryRaw === 'DURATION_EXCLUSIVE_END')
      ? expiryBoundaryRaw
      : undefined
  return {
    commitmentPeriodMonths,
    commitmentPeriodDays,
    expiryBoundary,
  }
}

function firstDayNextMonthUtc() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0))
}

function addDaysUtc(date, days) {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function computeCommitmentEndAt(effectiveAtIso, terms) {
  try {
    const base = new Date(effectiveAtIso)
    const months = Number(terms.commitmentPeriodMonths ?? 0)
    const days = Number(terms.commitmentPeriodDays ?? 0)
    if (Number.isFinite(months) && months > 0) {
      const y = base.getUTCFullYear()
      const m = base.getUTCMonth()
      const d = base.getUTCDate()
      return new Date(Date.UTC(m + months >= 12 ? y + Math.floor((m + months) / 12) : y, (m + months) % 12, d, base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds())).toISOString()
    }
    if (Number.isFinite(days) && days > 0) {
      return addDaysUtc(base, days).toISOString()
    }
  } catch {
    return null
  }
  return null
}

function computeOneTimeExpiry(effectiveAtIso, validityDays, expiryBoundary) {
  const days = Number(validityDays ?? 0)
  if (!effectiveAtIso || !Number.isFinite(days) || days < 1) return null
  const base = new Date(effectiveAtIso)
  if (Number.isNaN(base.getTime())) return null
  if (expiryBoundary === 'DURATION_EXCLUSIVE_END') {
    return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
  }
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (days - 1), 23, 59, 59, 999)
  return end.toISOString()
}

async function loadEnterpriseStatus(supabase, enterpriseId) {
  if (!enterpriseId) return null
  const rows = await supabase.select(
    'tenants',
    `select=enterprise_status&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row?.enterprise_status ? String(row.enterprise_status) : null
}

async function loadSimByIccid(supabase, iccid, tenantFilter) {
  const rows = await supabase.select(
    'sims',
    `select=sim_id,enterprise_id,status,iccid&iccid=eq.${encodeURIComponent(iccid)}${tenantFilter}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadPackageVersion(supabase, packageVersionId) {
  const rows = await supabase.select(
    'package_versions',
    `select=package_version_id,package_id,status,commercial_terms,price_plan_version_id,effective_from&package_version_id=eq.${encodeURIComponent(packageVersionId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadPricePlanVersion(supabase, pricePlanVersionId) {
  const rows = await supabase.select(
    'price_plan_versions',
    `select=price_plan_version_id,price_plan_id,validity_days,payg_rates&price_plan_version_id=eq.${encodeURIComponent(pricePlanVersionId)}&limit=1`
  )
  const v = Array.isArray(rows) ? rows[0] : null
  if (!v?.price_plan_id) return null
  const planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,type&price_plan_id=eq.${encodeURIComponent(String(v.price_plan_id))}&limit=1`
  )
  const plan = Array.isArray(planRows) ? planRows[0] : null
  return { version: v, plan }
}

function resolveExpiryBoundary(terms, paygRates) {
  const meta = paygRates && typeof paygRates === 'object' ? paygRates.meta : undefined
  const fromMeta = meta && typeof meta === 'object' ? meta.expiryBoundary : undefined
  const v = typeof fromMeta === 'string' ? fromMeta.toUpperCase() : undefined
  if (v === 'CALENDAR_DAY_END' || v === 'DURATION_EXCLUSIVE_END') return v
  return terms.expiryBoundary
}

export async function createSubscription({
  supabase,
  enterpriseId,
  iccid,
  packageVersionId,
  kind,
  effectiveAt,
  tenantFilter,
  audit,
}) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const iccidValue = String(iccid || '').trim()
  if (!isValidIccid(iccidValue)) {
    return toError(400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
  }
  const pkgId = String(packageVersionId || '').trim()
  if (!isValidUuid(pkgId)) {
    return toError(400, 'BAD_REQUEST', 'packageVersionId is required and must be a valid uuid.')
  }
  const sim = await loadSimByIccid(supabase, iccidValue, tenantFilter)
  if (!sim) {
    return toError(404, 'SIM_NOT_FOUND', `sim ${iccidValue} not found.`)
  }
  if (String(sim.enterprise_id) !== String(enterpriseId)) {
    return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
  }
  if (String(sim.status || '').toUpperCase() === 'RETIRED') {
    return toError(409, 'SIM_RETIRED', 'SIM is retired.')
  }
  const enterpriseStatus = await loadEnterpriseStatus(supabase, enterpriseId)
  if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
    return toError(409, 'ENTERPRISE_SUSPENDED', 'Enterprise is not active.')
  }
  const pkg = await loadPackageVersion(supabase, pkgId)
  if (!pkg || String(pkg.status || '').toUpperCase() !== 'PUBLISHED') {
    return toError(404, 'PACKAGE_NOT_FOUND', `packageVersion ${pkgId} not found.`)
  }
  const effectiveIso = toIsoDateTime(effectiveAt) ?? new Date().toISOString()
  if (!effectiveIso) {
    return toError(400, 'BAD_REQUEST', 'effectiveAt must be a valid date-time.')
  }
  const now = new Date()
  const isImmediate = new Date(effectiveIso).getTime() <= now.getTime()
  const subKind = (kind && String(kind).toUpperCase() === 'ADD_ON') ? 'ADD_ON' : 'MAIN'
  if (isImmediate && subKind === 'MAIN') {
    const active = await supabase.select(
      'subscriptions',
      `select=subscription_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=eq.ACTIVE&subscription_kind=eq.MAIN&limit=1`
    )
    if (Array.isArray(active) && active.length > 0) {
      return toError(409, 'MAIN_SUBSCRIPTION_EXISTS', 'SIM already has an ACTIVE MAIN subscription.')
    }
  }
  const terms = normalizeCommercialTerms(pkg.commercial_terms)
  const commitmentEndAt = computeCommitmentEndAt(effectiveIso, terms)
  let expiresAt = null
  if (pkg.price_plan_version_id) {
    const pp = await loadPricePlanVersion(supabase, String(pkg.price_plan_version_id))
    if (pp?.plan && String(pp.plan.type || '').toUpperCase() === 'ONE_TIME') {
      const expiryBoundary = resolveExpiryBoundary(terms, pp.version?.payg_rates)
      const validityDays = Number(pp.version?.validity_days ?? 0)
      expiresAt = computeOneTimeExpiry(effectiveIso, Number.isFinite(validityDays) ? validityDays : null, expiryBoundary)
    }
  }
  const rows = await supabase.insert('subscriptions', {
    enterprise_id: enterpriseId,
    sim_id: sim.sim_id,
    subscription_kind: subKind,
    package_version_id: pkg.package_version_id,
    state: isImmediate ? 'ACTIVE' : 'PENDING',
    effective_at: effectiveIso,
    expires_at: expiresAt,
    commitment_end_at: commitmentEndAt,
    first_subscribed_at: effectiveIso,
  })
  const created = Array.isArray(rows) ? rows[0] : null
  if (created?.subscription_id) {
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: enterpriseId ?? null,
      action: 'SUBSCRIPTION_CREATED',
      target_type: 'SUBSCRIPTION',
      target_id: String(created.subscription_id),
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: {
        iccid: sim.iccid ?? iccidValue,
        simId: sim.sim_id,
        packageVersionId: pkg.package_version_id,
        kind: subKind,
        state: isImmediate ? 'ACTIVE' : 'PENDING',
        effectiveAt: effectiveIso,
        expiresAt,
        commitmentEndAt,
      },
    })
  }
  return {
    ok: true,
    value: {
      subscriptionId: String(created?.subscription_id ?? ''),
      state: isImmediate ? 'ACTIVE' : 'PENDING',
      effectiveAt: effectiveIso,
      expiresAt,
      commitmentEndAt,
    },
  }
}

export async function switchSubscription({
  supabase,
  enterpriseId,
  iccid,
  newPackageVersionId,
  effectiveStrategy,
  tenantFilter,
  audit,
}) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const iccidValue = String(iccid || '').trim()
  if (!isValidIccid(iccidValue)) {
    return toError(400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.')
  }
  const pkgId = String(newPackageVersionId || '').trim()
  if (!isValidUuid(pkgId)) {
    return toError(400, 'BAD_REQUEST', 'newPackageVersionId is required and must be a valid uuid.')
  }
  const sim = await loadSimByIccid(supabase, iccidValue, tenantFilter)
  if (!sim) {
    return toError(404, 'SIM_NOT_FOUND', `sim ${iccidValue} not found.`)
  }
  if (String(sim.enterprise_id) !== String(enterpriseId)) {
    return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
  }
  if (String(sim.status || '').toUpperCase() === 'RETIRED') {
    return toError(409, 'SIM_RETIRED', 'SIM is retired.')
  }
  const enterpriseStatus = await loadEnterpriseStatus(supabase, enterpriseId)
  if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
    return toError(409, 'ENTERPRISE_SUSPENDED', 'Enterprise is not active.')
  }
  const current = await supabase.select(
    'subscriptions',
    `select=subscription_id,package_version_id,state,subscription_kind&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=eq.ACTIVE&subscription_kind=eq.MAIN&order=effective_at.desc&limit=1`
  )
  const from = Array.isArray(current) ? current[0] : null
  if (!from?.subscription_id) {
    return toError(404, 'SUBSCRIPTION_NOT_FOUND', 'No active MAIN subscription.')
  }
  const pkg = await loadPackageVersion(supabase, pkgId)
  if (!pkg || String(pkg.status || '').toUpperCase() !== 'PUBLISHED') {
    return toError(404, 'PACKAGE_NOT_FOUND', `packageVersion ${pkgId} not found.`)
  }
  const strategy = String(effectiveStrategy || '').toUpperCase() === 'IMMEDIATE' ? 'IMMEDIATE' : 'NEXT_CYCLE'
  const nowIso = new Date().toISOString()
  const nextStart = firstDayNextMonthUtc()
  const effectiveIso = strategy === 'IMMEDIATE' ? nowIso : nextStart.toISOString()
  if (strategy === 'IMMEDIATE') {
    await supabase.update(
      'subscriptions',
      `subscription_id=eq.${encodeURIComponent(String(from.subscription_id))}`,
      { state: 'CANCELLED', cancelled_at: nowIso, expires_at: nowIso }
    )
  } else {
    await supabase.update(
      'subscriptions',
      `subscription_id=eq.${encodeURIComponent(String(from.subscription_id))}`,
      { state: 'EXPIRED', cancelled_at: null, expires_at: effectiveIso }
    )
  }
  const terms = normalizeCommercialTerms(pkg.commercial_terms)
  const commitmentEndAt = computeCommitmentEndAt(effectiveIso, terms)
  let expiresAt = null
  if (pkg.price_plan_version_id) {
    const pp = await loadPricePlanVersion(supabase, String(pkg.price_plan_version_id))
    if (pp?.plan && String(pp.plan.type || '').toUpperCase() === 'ONE_TIME') {
      const expiryBoundary = resolveExpiryBoundary(terms, pp.version?.payg_rates)
      const validityDays = Number(pp.version?.validity_days ?? 0)
      expiresAt = computeOneTimeExpiry(effectiveIso, Number.isFinite(validityDays) ? validityDays : null, expiryBoundary)
    }
  }
  const rows = await supabase.insert('subscriptions', {
    enterprise_id: enterpriseId,
    sim_id: sim.sim_id,
    subscription_kind: 'MAIN',
    package_version_id: pkg.package_version_id,
    state: strategy === 'IMMEDIATE' ? 'ACTIVE' : 'PENDING',
    effective_at: effectiveIso,
    expires_at: expiresAt,
    commitment_end_at: commitmentEndAt,
    first_subscribed_at: effectiveIso,
  })
  const created = Array.isArray(rows) ? rows[0] : null
  if (created?.subscription_id) {
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: enterpriseId ?? null,
      action: 'SUBSCRIPTION_SWITCHED',
      target_type: 'SIM',
      target_id: sim.iccid ?? iccidValue,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      before_data: {
        subscriptionId: String(from?.subscription_id ?? ''),
        packageVersionId: String(from?.package_version_id ?? ''),
        state: String(from?.state ?? ''),
      },
      after_data: {
        subscriptionId: String(created?.subscription_id ?? ''),
        packageVersionId: pkg.package_version_id,
        state: strategy === 'IMMEDIATE' ? 'ACTIVE' : 'PENDING',
        effectiveAt: effectiveIso,
      },
    })
  }
  return {
    ok: true,
    value: {
      cancelledSubscriptionId: String(from.subscription_id ?? ''),
      newSubscriptionId: String(created?.subscription_id ?? ''),
      effectiveAt: effectiveIso,
    },
  }
}

export async function cancelSubscription({
  supabase,
  enterpriseId,
  subscriptionId,
  immediate,
  audit,
}) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  const id = String(subscriptionId || '').trim()
  if (!isValidUuid(id)) {
    return toError(400, 'BAD_REQUEST', 'subscriptionId must be a valid uuid.')
  }
  const rows = await supabase.select(
    'subscriptions',
    `select=subscription_id,enterprise_id,state&subscription_id=eq.${encodeURIComponent(id)}&limit=1`
  )
  const sub = Array.isArray(rows) ? rows[0] : null
  if (!sub) {
    return toError(404, 'SUBSCRIPTION_NOT_FOUND', `subscription ${id} not found.`)
  }
  if (String(sub.enterprise_id) !== String(enterpriseId)) {
    return toError(403, 'FORBIDDEN', 'Subscription does not belong to your enterprise.')
  }
  const nowIso = new Date().toISOString()
  const shouldImmediate = String(immediate || '').toLowerCase() === 'true'
  const expiresAt = shouldImmediate
    ? nowIso
    : new Date(firstDayNextMonthUtc().getTime() - 1000).toISOString()
  const nextState = shouldImmediate ? 'CANCELLED' : 'EXPIRED'
  await supabase.update(
    'subscriptions',
    `subscription_id=eq.${encodeURIComponent(id)}`,
    { state: nextState, cancelled_at: shouldImmediate ? nowIso : null, expires_at: expiresAt }
  )
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: enterpriseId ?? null,
    action: 'SUBSCRIPTION_CANCELLED',
    target_type: 'SUBSCRIPTION',
    target_id: id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: { state: String(sub.state ?? '') },
    after_data: { state: nextState, expiresAt, immediate: shouldImmediate },
  })
  return { ok: true, value: { subscriptionId: id, state: nextState, expiresAt } }
}

export async function listSimSubscriptions({
  supabase,
  enterpriseId,
  simIdentifier,
  tenantFilter,
  state,
  kind,
  page,
  pageSize,
}) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  let simId = simIdentifier.field === 'sim_id' ? simIdentifier.value : ''
  if (!simId) {
    const sim = await loadSimByIccid(supabase, simIdentifier.value, tenantFilter)
    if (!sim) {
      return toError(404, 'SIM_NOT_FOUND', `sim ${simIdentifier.value} not found.`)
    }
    if (String(sim.enterprise_id) !== String(enterpriseId)) {
      return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.')
    }
    simId = String(sim.sim_id)
  }
  const pageNum = Math.max(1, Number(page ?? 1) || 1)
  const sizeNum = Math.min(200, Math.max(1, Number(pageSize ?? 20) || 20))
  const offset = (pageNum - 1) * sizeNum
  const filters = [
    `sim_id=eq.${encodeURIComponent(simId)}`,
  ]
  const stateValue = String(state || '').toUpperCase()
  if (stateValue === 'PENDING' || stateValue === 'ACTIVE' || stateValue === 'CANCELLED' || stateValue === 'EXPIRED') {
    filters.push(`state=eq.${encodeURIComponent(stateValue)}`)
  }
  const kindValue = String(kind || '').toUpperCase()
  if (kindValue === 'MAIN' || kindValue === 'ADD_ON') {
    filters.push(`subscription_kind=eq.${encodeURIComponent(kindValue)}`)
  }
  const query = `select=subscription_id,package_version_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&${filters.join('&')}&order=effective_at.desc&limit=${sizeNum}&offset=${offset}`
  const { data, total } = await supabase.selectWithCount('subscriptions', query)
  const rows = Array.isArray(data) ? data : []
  const packageVersionIds = rows.map((r) => String(r.package_version_id || '')).filter(Boolean)
  const versionMap = new Map()
  if (packageVersionIds.length) {
    const versions = await supabase.select(
      'package_versions',
      `select=package_version_id,package_id&package_version_id=in.(${packageVersionIds.map((v) => encodeURIComponent(v)).join(',')})`
    )
    if (Array.isArray(versions)) {
      for (const v of versions) {
        if (v.package_version_id) versionMap.set(String(v.package_version_id), v)
      }
    }
  }
  const packageIds = Array.from(versionMap.values()).map((v) => String(v.package_id || '')).filter(Boolean)
  const packageMap = new Map()
  if (packageIds.length) {
    const packages = await supabase.select(
      'packages',
      `select=package_id,name&package_id=in.(${packageIds.map((v) => encodeURIComponent(v)).join(',')})`
    )
    if (Array.isArray(packages)) {
      for (const p of packages) {
        if (p.package_id) packageMap.set(String(p.package_id), p)
      }
    }
  }
  const items = rows.map((row) => {
    const packageVersionId = String(row.package_version_id || '')
    const pkgVersion = versionMap.get(packageVersionId)
    const pkg = pkgVersion?.package_id ? packageMap.get(String(pkgVersion.package_id)) : null
    return {
      subscriptionId: String(row.subscription_id || ''),
      packageVersionId,
      packageName: pkg?.name ?? null,
      kind: String(row.subscription_kind || ''),
      state: String(row.state || ''),
      effectiveAt: row.effective_at ?? null,
      expiresAt: row.expires_at ?? null,
      cancelledAt: row.cancelled_at ?? null,
      firstSubscribedAt: row.first_subscribed_at ?? null,
      commitmentEndAt: row.commitment_end_at ?? null,
    }
  })
  return {
    ok: true,
    value: {
      items,
      total: Number(total ?? items.length),
      page: pageNum,
      pageSize: sizeNum,
    },
  }
}
