function isValidUuid(value) {
  const s = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
}

function toError(status, code, message) {
  return { ok: false, status, code, message }
}

async function writeAuditLog(supabase, payload) {
  await supabase.insert('audit_logs', payload, { returning: 'minimal' })
}

function toInteger(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Number.isInteger(num) ? num : Math.trunc(num)
}

function normalizeAllowedMccMnc(list) {
  const arr = Array.isArray(list) ? list : []
  return arr.map((v) => String(v || '').trim()).filter(Boolean)
}

function firstDayNextMonthUtc() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0))
}

function parseMccMnc(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const exact = raw.match(/^(\d{3})-?(\d{2,3})$/)
  if (!exact) return null
  const mcc = exact[1]
  let mnc = exact[2]
  if (mnc.length === 2) mnc = `0${mnc}`
  return { mcc, mnc }
}

async function resolveCarrierId(supabase, carrierServiceConfig) {
  const carrierIdRaw = carrierServiceConfig?.carrierId ? String(carrierServiceConfig.carrierId).trim() : null
  if (carrierIdRaw && isValidUuid(carrierIdRaw)) return carrierIdRaw
  const allowed = normalizeAllowedMccMnc(carrierServiceConfig?.roamingProfile?.allowedMccMnc)
  if (!allowed.length) return null
  const parsed = parseMccMnc(allowed[0])
  if (!parsed) return null
  const rows = await supabase.select(
    'carriers',
    `select=carrier_id&mcc=eq.${encodeURIComponent(parsed.mcc)}&mnc=eq.${encodeURIComponent(parsed.mnc)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row?.carrier_id ? String(row.carrier_id) : null
}

async function resolveSupplierId(supabase, carrierId, carrierServiceConfig) {
  const supplierIdRaw = carrierServiceConfig?.supplierId ? String(carrierServiceConfig.supplierId).trim() : null
  if (supplierIdRaw && isValidUuid(supplierIdRaw)) return supplierIdRaw
  if (!carrierId) return null
  const rows = await supabase.select(
    'supplier_carriers',
    `select=supplier_id&carrier_id=eq.${encodeURIComponent(carrierId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row?.supplier_id ? String(row.supplier_id) : null
}

function normalizeRoamingProfile(carrierServiceConfig) {
  const allowedMccMnc = normalizeAllowedMccMnc(carrierServiceConfig?.roamingProfile?.allowedMccMnc)
  const rat = carrierServiceConfig?.rat ? String(carrierServiceConfig.rat) : '4G'
  const profileVersionId = carrierServiceConfig?.roamingProfileVersionId ? String(carrierServiceConfig.roamingProfileVersionId).trim() : null
  const payload = {
    type: 'MCCMNC_ALLOWLIST',
    mccmnc: allowedMccMnc,
    rat,
    ...(profileVersionId ? { profileVersionId } : {}),
  }
  return payload
}

function extractApnProfileVersionId(carrierServiceConfig) {
  return carrierServiceConfig?.apnProfileVersionId ? String(carrierServiceConfig.apnProfileVersionId).trim() : null
}

function parsePaygPatterns(paygRates) {
  const zones = paygRates?.zones || {}
  const entries = []
  for (const zone of Object.values(zones)) {
    const list = Array.isArray(zone?.mccmnc) ? zone.mccmnc : []
    for (const raw of list) {
      entries.push({ zone, value: String(raw || '').trim() })
    }
  }
  return entries
}

function normalizePattern(value) {
  if (!value) return null
  if (value === '*') return { level: 'GLOBAL', key: '*' }
  const mccWildcard = value.match(/^(\d{3})-\*$/)
  if (mccWildcard) return { level: 'MCC', key: `${mccWildcard[1]}-*` }
  const exact = value.match(/^(\d{3})-?(\d{2,3})$/)
  if (exact) return { level: 'EXACT', key: `${exact[1]}-${exact[2]}` }
  return null
}

function detectPaygConflicts(paygRates) {
  const seen = new Map()
  const entries = parsePaygPatterns(paygRates)
  for (const entry of entries) {
    const normalized = normalizePattern(entry.value)
    if (!normalized) {
      return { ok: false, message: `Invalid payg country pattern: ${entry.value}` }
    }
    const key = `${normalized.level}:${normalized.key}`
    const prev = seen.get(key)
    if (prev && prev !== entry.zone) {
      return { ok: false, message: `PAYG conflict on ${normalized.key}` }
    }
    seen.set(key, entry.zone)
  }
  return { ok: true }
}

async function loadPackage(supabase, packageId) {
  const rows = await supabase.select(
    'packages',
    `select=package_id,enterprise_id,name,created_at&package_id=eq.${encodeURIComponent(packageId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadLatestPackageVersion(supabase, packageId) {
  const rows = await supabase.select(
    'package_versions',
    `select=package_version_id,package_id,version,status,effective_from,supplier_id,carrier_id,service_type,apn,roaming_profile,control_policy,commercial_terms,price_plan_version_id,created_at&package_id=eq.${encodeURIComponent(packageId)}&order=version.desc&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

function mapPackageVersion(version) {
  if (!version) return null
  return {
    packageVersionId: version.package_version_id,
    version: version.version,
    status: version.status,
    effectiveFrom: version.effective_from,
    supplierId: version.supplier_id,
    carrierId: version.carrier_id,
    serviceType: version.service_type,
    apn: version.apn,
    roamingProfile: version.roaming_profile,
    controlPolicy: version.control_policy,
    commercialTerms: version.commercial_terms,
    pricePlanVersionId: version.price_plan_version_id,
    createdAt: version.created_at,
  }
}

export async function createPackage({ supabase, enterpriseId, payload, audit }) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const name = String(payload?.name || '').trim()
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  const pricePlanVersionId = String(payload?.pricePlanVersionId || '').trim()
  if (!isValidUuid(pricePlanVersionId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanVersionId must be a valid uuid.')
  }
  const carrierServiceConfig = payload?.carrierServiceConfig ?? {}
  const apn = String(carrierServiceConfig?.apn || '').trim()
  if (!apn) return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.apn is required.')
  const carrierId = await resolveCarrierId(supabase, carrierServiceConfig)
  if (!carrierId) return toError(400, 'BAD_REQUEST', 'carrierId cannot be resolved.')
  const supplierId = await resolveSupplierId(supabase, carrierId, carrierServiceConfig)
  if (!supplierId) return toError(400, 'BAD_REQUEST', 'supplierId cannot be resolved.')
  const pricePlanVersionRows = await supabase.select(
    'price_plan_versions',
    `select=price_plan_version_id,price_plan_id&price_plan_version_id=eq.${encodeURIComponent(pricePlanVersionId)}&limit=1`
  )
  const pricePlanVersion = Array.isArray(pricePlanVersionRows) ? pricePlanVersionRows[0] : null
  if (!pricePlanVersion) return toError(404, 'NOT_FOUND', 'Price plan version not found.')
  const planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,service_type&price_plan_id=eq.${encodeURIComponent(pricePlanVersion.price_plan_id)}&limit=1`
  )
  const plan = Array.isArray(planRows) ? planRows[0] : null
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  const roamingProfile = normalizeRoamingProfile(carrierServiceConfig)
  const apnProfileVersionId = extractApnProfileVersionId(carrierServiceConfig)
  const controlPolicy = apnProfileVersionId ? { apnProfileVersionId } : null
  const packageRows = await supabase.insert(
    'packages',
    { enterprise_id: enterpriseId, name },
    { returning: 'representation' }
  )
  const pkg = Array.isArray(packageRows) ? packageRows[0] : null
  if (!pkg?.package_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create package.')
  const versionRows = await supabase.insert(
    'package_versions',
    {
      package_id: pkg.package_id,
      version: 1,
      status: 'DRAFT',
      effective_from: null,
      supplier_id: supplierId,
      carrier_id: carrierId,
      service_type: plan.service_type ?? 'DATA',
      apn,
      roaming_profile: roamingProfile,
      control_policy: controlPolicy,
      price_plan_version_id: pricePlanVersionId,
    },
    { returning: 'representation' }
  )
  const version = Array.isArray(versionRows) ? versionRows[0] : null
  if (pkg?.package_id) {
    await writeAuditLog(supabase, {
      actor_user_id: audit?.actorUserId ?? null,
      actor_role: audit?.actorRole ?? null,
      tenant_id: enterpriseId ?? null,
      action: 'PACKAGE_CREATED',
      target_type: 'PACKAGE',
      target_id: pkg.package_id,
      request_id: audit?.requestId ?? null,
      source_ip: audit?.sourceIp ?? null,
      after_data: {
        packageId: pkg.package_id,
        packageVersionId: version?.package_version_id ?? null,
        version: version?.version ?? 1,
        status: version?.status ?? 'DRAFT',
      },
    })
  }
  return {
    ok: true,
    value: {
      packageId: pkg.package_id,
      packageVersionId: version?.package_version_id,
      version: version?.version ?? 1,
      status: version?.status ?? 'DRAFT',
      createdAt: version?.created_at ?? pkg.created_at,
    },
  }
}

export async function updatePackage({ supabase, packageId, payload, audit }) {
  if (!isValidUuid(packageId)) return toError(400, 'BAD_REQUEST', 'packageId must be a valid uuid.')
  const pkg = await loadPackage(supabase, packageId)
  if (!pkg) return toError(404, 'NOT_FOUND', 'Package not found.')
  const latestVersion = await loadLatestPackageVersion(supabase, packageId)
  if (!latestVersion) return toError(404, 'NOT_FOUND', 'Package version not found.')
  if (latestVersion.status !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT package can be updated.')
  }
  const name = payload?.name ? String(payload.name).trim() : null
  if (name) {
    await supabase.update('packages', `package_id=eq.${encodeURIComponent(packageId)}`, { name }, { returning: 'minimal' })
  }
  const carrierServiceConfig = payload?.carrierServiceConfig ?? {}
  const apn = carrierServiceConfig?.apn ? String(carrierServiceConfig.apn).trim() : null
  const roamingProfile = carrierServiceConfig?.roamingProfile ? normalizeRoamingProfile(carrierServiceConfig) : null
  const apnProfileVersionId = extractApnProfileVersionId(carrierServiceConfig)
  const controlPolicy = apnProfileVersionId ? { apnProfileVersionId } : latestVersion.control_policy ?? null
  const patch = {}
  if (apn !== null) patch.apn = apn
  if (roamingProfile !== null) patch.roaming_profile = roamingProfile
  if (controlPolicy !== null) patch.control_policy = controlPolicy
  if (payload?.pricePlanVersionId) {
    const pricePlanVersionId = String(payload.pricePlanVersionId).trim()
    if (!isValidUuid(pricePlanVersionId)) {
      return toError(400, 'BAD_REQUEST', 'pricePlanVersionId must be a valid uuid.')
    }
    patch.price_plan_version_id = pricePlanVersionId
  }
  if (Object.keys(patch).length) {
    await supabase.update(
      'package_versions',
      `package_version_id=eq.${encodeURIComponent(latestVersion.package_version_id)}`,
      patch,
      { returning: 'minimal' }
    )
  }
  const updatedVersion = await loadLatestPackageVersion(supabase, packageId)
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: pkg.enterprise_id ?? null,
    action: 'PACKAGE_UPDATED',
    target_type: 'PACKAGE',
    target_id: packageId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: mapPackageVersion(latestVersion),
    after_data: mapPackageVersion(updatedVersion),
  })
  return { ok: true, value: mapPackageVersion(updatedVersion) }
}

export async function publishPackage({ supabase, packageId, audit }) {
  if (!isValidUuid(packageId)) return toError(400, 'BAD_REQUEST', 'packageId must be a valid uuid.')
  const latestVersion = await loadLatestPackageVersion(supabase, packageId)
  if (!latestVersion) return toError(404, 'NOT_FOUND', 'Package version not found.')
  if (latestVersion.status !== 'DRAFT') {
    return toError(409, 'INVALID_STATUS', 'Only DRAFT package can be published.')
  }
  const pricePlanVersionRows = await supabase.select(
    'price_plan_versions',
    `select=price_plan_version_id,payg_rates&price_plan_version_id=eq.${encodeURIComponent(latestVersion.price_plan_version_id)}&limit=1`
  )
  const pricePlanVersion = Array.isArray(pricePlanVersionRows) ? pricePlanVersionRows[0] : null
  if (!pricePlanVersion) return toError(404, 'NOT_FOUND', 'Price plan version not found.')
  const conflictCheck = detectPaygConflicts(pricePlanVersion.payg_rates)
  if (!conflictCheck.ok) return toError(409, 'PAYG_CONFLICT', conflictCheck.message)
  const apnProfileVersionId = latestVersion.control_policy?.apnProfileVersionId
  if (apnProfileVersionId) {
    const apnVersions = await supabase.select(
      'profile_versions',
      `select=profile_version_id,status,profile_type&profile_version_id=eq.${encodeURIComponent(String(apnProfileVersionId))}&limit=1`
    )
    const apnVersion = Array.isArray(apnVersions) ? apnVersions[0] : null
    if (!apnVersion || apnVersion.profile_type !== 'APN' || apnVersion.status !== 'PUBLISHED') {
      return toError(409, 'PROFILE_VERSION_INVALID', 'APN profile version must be PUBLISHED.')
    }
  }
  const roamingProfileVersionId = latestVersion.roaming_profile?.profileVersionId
  if (roamingProfileVersionId) {
    const roamingVersions = await supabase.select(
      'profile_versions',
      `select=profile_version_id,status,profile_type&profile_version_id=eq.${encodeURIComponent(String(roamingProfileVersionId))}&limit=1`
    )
    const roamingVersion = Array.isArray(roamingVersions) ? roamingVersions[0] : null
    if (!roamingVersion || roamingVersion.profile_type !== 'ROAMING' || roamingVersion.status !== 'PUBLISHED') {
      return toError(409, 'PROFILE_VERSION_INVALID', 'Roaming profile version must be PUBLISHED.')
    }
  }
  const effectiveFrom = firstDayNextMonthUtc().toISOString()
  await supabase.update(
    'package_versions',
    `package_version_id=eq.${encodeURIComponent(latestVersion.package_version_id)}`,
    { status: 'PUBLISHED', effective_from: effectiveFrom },
    { returning: 'minimal' }
  )
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: (await loadPackage(supabase, packageId))?.enterprise_id ?? null,
    action: 'PACKAGE_PUBLISHED',
    target_type: 'PACKAGE',
    target_id: packageId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      packageVersionId: latestVersion.package_version_id,
      status: 'PUBLISHED',
      effectiveFrom,
    },
  })
  return {
    ok: true,
    value: {
      packageId,
      packageVersionId: latestVersion.package_version_id,
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
    },
  }
}

export async function listPackages({ supabase, enterpriseId, status, page, pageSize }) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const rows = await supabase.select(
    'packages',
    `select=package_id,enterprise_id,name,created_at&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&order=created_at.desc`
  )
  const packages = Array.isArray(rows) ? rows : []
  const ids = packages.map((p) => p.package_id).filter(Boolean)
  let versions = []
  if (ids.length) {
    const idFilter = ids.map((id) => encodeURIComponent(id)).join(',')
    const versionRows = await supabase.select(
      'package_versions',
      `select=package_version_id,package_id,version,status,effective_from,supplier_id,carrier_id,service_type,apn,roaming_profile,control_policy,commercial_terms,price_plan_version_id,created_at&package_id=in.(${idFilter})&order=version.desc`
    )
    versions = Array.isArray(versionRows) ? versionRows : []
  }
  const latestByPackage = new Map()
  for (const v of versions) {
    if (!v?.package_id) continue
    if (!latestByPackage.has(v.package_id)) latestByPackage.set(v.package_id, v)
  }
  let items = packages.map((pkg) => {
    const version = latestByPackage.get(pkg.package_id) || null
    return {
      packageId: pkg.package_id,
      name: pkg.name,
      status: version?.status ?? 'DRAFT',
      latestVersion: mapPackageVersion(version),
      createdAt: pkg.created_at,
    }
  })
  if (status) items = items.filter((it) => String(it.status) === String(status))
  const p = Number(page) || 1
  const ps = Number(pageSize) || 20
  const start = (p - 1) * ps
  const total = items.length
  items = items.slice(start, start + ps)
  return { ok: true, value: { items, total } }
}

export async function getPackageDetail({ supabase, packageId }) {
  if (!isValidUuid(packageId)) {
    return toError(400, 'BAD_REQUEST', 'packageId must be a valid uuid.')
  }
  const pkg = await loadPackage(supabase, packageId)
  if (!pkg) return toError(404, 'NOT_FOUND', 'Package not found.')
  const versions = await supabase.select(
    'package_versions',
    `select=package_version_id,package_id,version,status,effective_from,supplier_id,carrier_id,service_type,apn,roaming_profile,control_policy,commercial_terms,price_plan_version_id,created_at&package_id=eq.${encodeURIComponent(packageId)}&order=version.desc`
  )
  const list = Array.isArray(versions) ? versions : []
  return {
    ok: true,
    value: {
      packageId: pkg.package_id,
      enterpriseId: pkg.enterprise_id,
      name: pkg.name,
      createdAt: pkg.created_at,
      currentVersion: mapPackageVersion(list[0] ?? null),
      versions: list.map(mapPackageVersion),
    },
  }
}
