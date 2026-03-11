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

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function toInteger(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Number.isInteger(num) ? num : Math.trunc(num)
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function normalizePaygRates(paygRates, meta) {
  const zones = {}
  const list = Array.isArray(paygRates) ? paygRates : []
  for (const rate of list) {
    if (!rate) continue
    const zoneCode = String(rate.zoneCode || '').trim()
    const countries = Array.isArray(rate.countries) ? rate.countries.map((c) => String(c).trim()).filter(Boolean) : []
    const ratePerKb = toNumber(rate.ratePerKb)
    if (!zoneCode || !countries.length || ratePerKb === null || ratePerKb < 0) {
      return { ok: false, message: 'paygRates must include zoneCode, countries[], and ratePerKb >= 0.' }
    }
    zones[zoneCode] = { mccmnc: countries, ratePerKb }
  }
  return { ok: true, value: { zones, meta } }
}

function denormalizePaygRates(paygRates) {
  const zones = paygRates?.zones || {}
  const out = []
  for (const [zoneCode, zone] of Object.entries(zones)) {
    if (!zone) continue
    out.push({
      zoneCode,
      countries: Array.isArray(zone.mccmnc) ? zone.mccmnc : [],
      ratePerKb: zone.ratePerKb ?? 0,
    })
  }
  return out
}

function resolveVersionStatus(version) {
  if (!version || !version.effective_from) return 'DRAFT'
  const now = Date.now()
  const effective = new Date(version.effective_from).getTime()
  if (Number.isNaN(effective)) return 'DRAFT'
  return effective <= now ? 'PUBLISHED' : 'DRAFT'
}

function normalizeCommercialTerms(input) {
  if (input === null || input === undefined) return { ok: true, value: null }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms must be an object.')
  }
  const src = input
  const testPeriodDays = src.testPeriodDays === undefined ? null : toInteger(src.testPeriodDays)
  if (src.testPeriodDays !== undefined && (testPeriodDays === null || testPeriodDays < 0)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testPeriodDays must be >= 0.')
  }
  const testQuotaKb = src.testQuotaKb === undefined ? null : toInteger(src.testQuotaKb)
  if (src.testQuotaKb !== undefined && (testQuotaKb === null || testQuotaKb < 0)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testQuotaKb must be >= 0.')
  }
  const rawExpiryCondition = String(src.testExpiryCondition ?? '').trim()
  if (rawExpiryCondition && !['PERIOD_ONLY', 'QUOTA_ONLY', 'PERIOD_OR_QUOTA'].includes(rawExpiryCondition)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testExpiryCondition is invalid.')
  }
  const rawExpiryAction = String(src.testExpiryAction ?? '').trim()
  if (rawExpiryAction && !['ACTIVATED', 'DEACTIVATED'].includes(rawExpiryAction)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testExpiryAction is invalid.')
  }
  const commitmentPeriodMonths = src.commitmentPeriodMonths === undefined ? null : toInteger(src.commitmentPeriodMonths)
  if (src.commitmentPeriodMonths !== undefined && (commitmentPeriodMonths === null || commitmentPeriodMonths < 0)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.commitmentPeriodMonths must be >= 0.')
  }
  const commitmentPeriodDays = src.commitmentPeriodDays === undefined ? null : toInteger(src.commitmentPeriodDays)
  if (src.commitmentPeriodDays !== undefined && (commitmentPeriodDays === null || commitmentPeriodDays < 0)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.commitmentPeriodDays must be >= 0.')
  }
  return {
    ok: true,
    value: {
      ...(testPeriodDays !== null ? { testPeriodDays } : {}),
      ...(testQuotaKb !== null ? { testQuotaKb } : {}),
      testExpiryCondition: rawExpiryCondition || 'PERIOD_OR_QUOTA',
      testExpiryAction: rawExpiryAction || 'ACTIVATED',
      ...(commitmentPeriodMonths !== null ? { commitmentPeriodMonths } : {}),
      ...(commitmentPeriodDays !== null ? { commitmentPeriodDays } : {}),
    },
  }
}

function normalizeControlPolicy(input) {
  if (input === null || input === undefined) return { ok: true, value: null }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy must be an object.')
  }
  const src = input
  const enabled = src.enabled === undefined ? false : toBoolean(src.enabled)
  if (src.enabled !== undefined && enabled === null) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.enabled must be boolean.')
  }
  const cutoffPolicyId = src.cutoffPolicyId === undefined ? '' : String(src.cutoffPolicyId).trim()
  const throttlingPolicyId = src.throttlingPolicyId === undefined ? '' : String(src.throttlingPolicyId).trim()
  const cutoffThresholdKb = src.cutoffThresholdKb === undefined ? null : toInteger(src.cutoffThresholdKb)
  if (src.cutoffThresholdKb !== undefined && (cutoffThresholdKb === null || cutoffThresholdKb < 0)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoffThresholdKb must be >= 0.')
  }
  const cutoffThresholdMb = src.cutoffThresholdMb === undefined ? null : toInteger(src.cutoffThresholdMb)
  if (src.cutoffThresholdMb !== undefined && (cutoffThresholdMb === null || cutoffThresholdMb < 0)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoffThresholdMb must be >= 0.')
  }
  const cutoff = {}
  if (cutoffPolicyId) cutoff.cutoffPolicyId = cutoffPolicyId
  if (cutoffThresholdKb !== null) cutoff.cutoffThresholdKb = cutoffThresholdKb
  if (cutoffThresholdMb !== null) cutoff.cutoffThresholdMb = cutoffThresholdMb
  return {
    ok: true,
    value: {
      enabled: enabled ?? false,
      ...(throttlingPolicyId ? { throttlingPolicyId } : {}),
      ...cutoff,
    },
  }
}

function normalizeCarrierService(input, serviceType) {
  if (input === null || input === undefined) return { ok: true, value: null }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toError(400, 'BAD_REQUEST', 'carrierService must be an object.')
  }
  const src = input
  const supplierId = String(src.supplierId ?? '').trim()
  const operatorId = String(src.operatorId ?? src.carrierId ?? '').trim()
  if (supplierId && !isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'carrierService.supplierId must be a valid uuid.')
  }
  if (operatorId && !isValidUuid(operatorId)) {
    return toError(400, 'BAD_REQUEST', 'carrierService.operatorId must be a valid uuid.')
  }
  const rat = String(src.rat ?? '4G').trim()
  if (rat && !['3G', '4G', '5G', 'NB-IoT'].includes(rat)) {
    return toError(400, 'BAD_REQUEST', 'carrierService.rat is invalid.')
  }
  const apn = String(src.apn ?? '').trim()
  const apnProfileId = String(src.apnProfileId ?? '').trim()
  const apnProfileVersionId = String(src.apnProfileVersionId ?? '').trim()
  const roamingProfileId = String(src.roamingProfileId ?? '').trim()
  const roamingProfileVersionId = String(src.roamingProfileVersionId ?? '').trim()
  if (apnProfileId && !isValidUuid(apnProfileId)) {
    return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileId must be a valid uuid.')
  }
  if (apnProfileVersionId && !isValidUuid(apnProfileVersionId)) {
    return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileVersionId must be a valid uuid.')
  }
  if (roamingProfileId && !isValidUuid(roamingProfileId)) {
    return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId must be a valid uuid.')
  }
  if (roamingProfileVersionId && !isValidUuid(roamingProfileVersionId)) {
    return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileVersionId must be a valid uuid.')
  }
  const roamingProfile = src.roamingProfile
  const allowedMccMnc = Array.isArray(roamingProfile?.allowedMccMnc)
    ? roamingProfile.allowedMccMnc.map((v) => String(v).trim()).filter(Boolean)
    : []
  if (serviceType === 'DATA' && !apn && !apnProfileId && !apnProfileVersionId && !roamingProfileId && !roamingProfileVersionId) {
    return toError(
      400,
      'BAD_REQUEST',
      'carrierService.apn or carrierService.apnProfileId or carrierService.apnProfileVersionId or carrierService.roamingProfileId or carrierService.roamingProfileVersionId is required for DATA serviceType.'
    )
  }
  if (roamingProfile !== undefined && !Array.isArray(roamingProfile?.allowedMccMnc)) {
    return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfile.allowedMccMnc must be an array.')
  }
  return {
    ok: true,
    value: {
      ...(supplierId ? { supplierId } : {}),
      ...(operatorId ? { operatorId } : {}),
      rat: rat || '4G',
      ...(apn ? { apn } : {}),
      ...(apnProfileId ? { apnProfileId } : {}),
      ...(apnProfileVersionId ? { apnProfileVersionId } : {}),
      ...(roamingProfileId ? { roamingProfileId } : {}),
      ...(roamingProfileVersionId ? { roamingProfileVersionId } : {}),
      ...(allowedMccMnc.length ? { roamingProfile: { allowedMccMnc } } : {}),
    },
  }
}

function parseCarrierMccMncPattern(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const wildcard = raw.match(/^(\d{3})-\*$/)
  if (wildcard) {
    return { mcc: wildcard[1], mnc: null, normalized: `${wildcard[1]}-*` }
  }
  const exact = raw.match(/^(\d{3})-?(\d{2,3})$/)
  if (!exact) return null
  return { mcc: exact[1], mnc: exact[2], normalized: `${exact[1]}-${exact[2]}` }
}

function normalizeCarrierMccMncList(input) {
  const list = Array.isArray(input) ? input : []
  const normalized = []
  for (const item of list) {
    if (typeof item === 'string') {
      const parsed = parseCarrierMccMncPattern(item)
      if (!parsed) return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc contains invalid value: ${String(item)}`)
      normalized.push(parsed.normalized)
      continue
    }
    if (item && typeof item === 'object') {
      const mcc = String(item.mcc ?? '').trim()
      const mnc = String(item.mnc ?? '').trim()
      const parsed = parseCarrierMccMncPattern(`${mcc}-${mnc}`)
      if (!parsed) return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc contains invalid value: ${mcc}-${mnc}`)
      normalized.push(parsed.normalized)
      continue
    }
    return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfile.allowedMccMnc entries are invalid.')
  }
  return { ok: true, value: Array.from(new Set(normalized)) }
}

async function loadOperatorBinding(supabase, supplierId, operatorId) {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const directRows = await supabase.select(
    'operators',
    `select=operator_id,business_operator_id,supplier_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`
  )
  const direct = Array.isArray(directRows) ? directRows[0] : null
  if (direct?.operator_id) {
    return {
      ok: true,
      value: {
        operatorId: String(direct.operator_id),
        businessOperatorId: String(direct?.business_operator_id ?? '').trim() || null,
      },
    }
  }
  const mappedRows = await supabase.select(
    'operators',
    `select=operator_id,business_operator_id,supplier_id&business_operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`
  )
  const mapped = Array.isArray(mappedRows) ? mappedRows[0] : null
  if (mapped?.operator_id) {
    return {
      ok: true,
      value: {
        operatorId: String(mapped.operator_id),
        businessOperatorId: String(mapped?.business_operator_id ?? operatorId).trim() || null,
      },
    }
  }
  if (supplierId) return toError(400, 'BAD_REQUEST', 'carrierService.operatorId is not linked to supplierId.')
  return toError(400, 'BAD_REQUEST', 'carrierService.operatorId is not found.')
}

async function hasSupplierCapabilityForBusinessOperator(supabase, supplierId, businessOperatorId) {
  const directRows = await supabase.select(
    'operators',
    `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(businessOperatorId)}&limit=1`
  )
  if (Array.isArray(directRows) && directRows[0]?.operator_id) return true
  const mappedRows = await supabase.select(
    'operators',
    `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}&limit=1`
  )
  return Array.isArray(mappedRows) && Boolean(mappedRows[0]?.operator_id)
}

async function validateCarrierServiceReferences(supabase, serviceType, carrierService) {
  if (!carrierService || typeof carrierService !== 'object') return { ok: true, value: null }
  const supplierId = String(carrierService.supplierId ?? '').trim() || null
  const operatorIdInput = String(carrierService.operatorId ?? carrierService.carrierId ?? '').trim() || null
  const apn = String(carrierService.apn ?? '').trim() || null
  const apnProfileId = String(carrierService.apnProfileId ?? '').trim() || null
  const apnProfileVersionId = String(carrierService.apnProfileVersionId ?? '').trim() || null
  const roamingProfileId = String(carrierService.roamingProfileId ?? '').trim() || null
  const roamingProfileVersionId = String(carrierService.roamingProfileVersionId ?? '').trim() || null
  const rawAllowed = carrierService?.roamingProfile?.allowedMccMnc
  const allowedNormalize = normalizeCarrierMccMncList(rawAllowed)
  if (!allowedNormalize.ok) return allowedNormalize
  const allowedMccMnc = allowedNormalize.value
  let resolvedOperatorId = null
  let resolvedBusinessOperatorId = null
  if (operatorIdInput) {
    const resolved = await loadOperatorBinding(supabase, supplierId, operatorIdInput)
    if (!resolved.ok) return resolved
    resolvedOperatorId = resolved.value.operatorId
    resolvedBusinessOperatorId = resolved.value.businessOperatorId
  }
  let apnFromProfile = null
  if (apnProfileId) {
    const profileRows = await supabase.select(
      'apn_profiles',
      `select=apn_profile_id,apn,supplier_id,operator_id,status&apn_profile_id=eq.${encodeURIComponent(apnProfileId)}&limit=1`
    )
    const profile = Array.isArray(profileRows) ? profileRows[0] : null
    if (!profile?.apn_profile_id) {
      return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileId is not found.')
    }
    if (supplierId && String(profile?.supplier_id ?? '').trim() !== supplierId) {
      return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileId does not belong to supplierId.')
    }
    if (resolvedOperatorId && String(profile?.operator_id ?? '').trim() !== resolvedOperatorId) {
      return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileId does not match operatorId.')
    }
    apnFromProfile = String(profile?.apn ?? '').trim() || null
  }
  if (apnProfileVersionId) {
    const versionRows = await supabase.select(
      'profile_versions',
      `select=profile_version_id,profile_type,profile_id,config&profile_type=eq.APN&profile_version_id=eq.${encodeURIComponent(apnProfileVersionId)}&limit=1`
    )
    const profileVersion = Array.isArray(versionRows) ? versionRows[0] : null
    if (!profileVersion?.profile_id) {
      return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileVersionId is not found.')
    }
    const profileRows = await supabase.select(
      'apn_profiles',
      `select=apn_profile_id,apn,supplier_id,operator_id,status&apn_profile_id=eq.${encodeURIComponent(String(profileVersion.profile_id))}&limit=1`
    )
    const profile = Array.isArray(profileRows) ? profileRows[0] : null
    if (!profile?.apn_profile_id) {
      return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileVersionId references missing APN profile.')
    }
    if (supplierId && String(profile?.supplier_id ?? '').trim() !== supplierId) {
      return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileVersionId does not belong to supplierId.')
    }
    if (resolvedOperatorId && String(profile?.operator_id ?? '').trim() !== resolvedOperatorId) {
      return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileVersionId does not match operatorId.')
    }
    apnFromProfile = String(profile?.apn ?? '').trim() || null
  }
  const apnToValidate = apn || apnFromProfile
  if (serviceType === 'DATA' && !apnToValidate && !roamingProfileId && !roamingProfileVersionId) {
    return toError(
      400,
      'BAD_REQUEST',
      'carrierService.apn or carrierService.apnProfileId or carrierService.apnProfileVersionId or carrierService.roamingProfileId or carrierService.roamingProfileVersionId is required for DATA serviceType.'
    )
  }
  if (apn && apnFromProfile && apn !== apnFromProfile) {
    return toError(400, 'BAD_REQUEST', 'carrierService.apn must match carrierService.apnProfileId/apnProfileVersionId.')
  }
  if (apnToValidate && supplierId) {
    const filters = [
      `supplier_id=eq.${encodeURIComponent(supplierId)}`,
      `apn=eq.${encodeURIComponent(apnToValidate)}`,
    ]
    if (resolvedOperatorId) filters.push(`operator_id=eq.${encodeURIComponent(resolvedOperatorId)}`)
    const rows = await supabase.select('apn_profiles', `select=apn_profile_id,status&${filters.join('&')}&limit=1`)
    const apnProfile = Array.isArray(rows) ? rows[0] : null
    if (!apnProfile?.apn_profile_id) {
      return toError(400, 'BAD_REQUEST', 'carrierService.apn is not found in supplier capability directory.')
    }
    const status = String(apnProfile?.status ?? '').trim().toUpperCase()
    if (status === 'DEPRECATED') {
      return toError(400, 'BAD_REQUEST', 'carrierService.apn is deprecated for current supplier capability.')
    }
  }
  if (roamingProfileVersionId) {
    const versionRows = await supabase.select(
      'profile_versions',
      `select=profile_version_id,profile_type,profile_id,config&profile_type=eq.ROAMING&profile_version_id=eq.${encodeURIComponent(roamingProfileVersionId)}&limit=1`
    )
    const profileVersion = Array.isArray(versionRows) ? versionRows[0] : null
    if (!profileVersion?.profile_id) {
      return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileVersionId is not found.')
    }
    const profileRows = await supabase.select(
      'roaming_profiles',
      `select=roaming_profile_id,supplier_id,operator_id,mccmnc_list,status&roaming_profile_id=eq.${encodeURIComponent(String(profileVersion.profile_id))}&limit=1`
    )
    const profile = Array.isArray(profileRows) ? profileRows[0] : null
    if (!profile?.roaming_profile_id) {
      return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileVersionId references missing roaming profile.')
    }
    if (supplierId && String(profile?.supplier_id ?? '').trim() !== supplierId) {
      return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileVersionId does not belong to supplierId.')
    }
    if (resolvedOperatorId && String(profile?.operator_id ?? '').trim() !== resolvedOperatorId) {
      return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileVersionId does not match operatorId.')
    }
    if (!allowedMccMnc.length) {
      const fromVersion = normalizeCarrierMccMncList(profileVersion?.config?.mccmncList ?? profile?.mccmnc_list)
      if (!fromVersion.ok) return fromVersion
      for (const value of fromVersion.value) allowedMccMnc.push(value)
    }
  }
  if (roamingProfileId) {
    const profileRows = await supabase.select(
      'roaming_profiles',
      `select=roaming_profile_id,supplier_id,operator_id,mccmnc_list,status&roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}&limit=1`
    )
    const profile = Array.isArray(profileRows) ? profileRows[0] : null
    if (!profile?.roaming_profile_id) {
      return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId is not found.')
    }
    if (supplierId && String(profile?.supplier_id ?? '').trim() !== supplierId) {
      return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId does not belong to supplierId.')
    }
    if (resolvedOperatorId && String(profile?.operator_id ?? '').trim() !== resolvedOperatorId) {
      return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId does not match operatorId.')
    }
    if (!allowedMccMnc.length) {
      const fromProfile = normalizeCarrierMccMncList(profile?.mccmnc_list)
      if (!fromProfile.ok) return fromProfile
      for (const value of fromProfile.value) allowedMccMnc.push(value)
    }
  }
  for (const pattern of allowedMccMnc) {
    const parsed = parseCarrierMccMncPattern(pattern)
    if (!parsed) {
      return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc contains invalid value: ${pattern}`)
    }
    const query = parsed.mnc
      ? `select=operator_id,mcc,mnc&mcc=eq.${encodeURIComponent(parsed.mcc)}&mnc=eq.${encodeURIComponent(parsed.mnc)}`
      : `select=operator_id,mcc,mnc&mcc=eq.${encodeURIComponent(parsed.mcc)}`
    const rows = await supabase.select('business_operators', query)
    const operators = Array.isArray(rows) ? rows : []
    if (!operators.length) {
      return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc is unknown: ${pattern}`)
    }
    if (supplierId) {
      let hasCapability = false
      for (const row of operators) {
        const businessOperatorId = String(row?.operator_id ?? '').trim()
        if (!businessOperatorId) continue
        if (await hasSupplierCapabilityForBusinessOperator(supabase, supplierId, businessOperatorId)) {
          hasCapability = true
          break
        }
      }
      if (!hasCapability) {
        return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc is not supported by supplier: ${pattern}`)
      }
    }
    if (resolvedBusinessOperatorId) {
      const matched = operators.some((row) => {
        const businessOperatorId = String(row?.operator_id ?? '').trim()
        return businessOperatorId === resolvedBusinessOperatorId || businessOperatorId === resolvedOperatorId
      })
      if (!matched) {
        return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc does not match operatorId: ${pattern}`)
      }
    }
  }
  return { ok: true, value: null }
}

function extractCarrierServiceMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const value = meta.carrierService
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

function buildMeta(payload, normalized) {
  const meta = {}
  if (normalized.commercialTerms) meta.commercialTerms = normalized.commercialTerms
  if (normalized.controlPolicy) meta.controlPolicy = normalized.controlPolicy
  if (normalized.carrierService) meta.carrierService = normalized.carrierService
  if (payload?.expiryBoundary) meta.expiryBoundary = payload.expiryBoundary
  if (payload?.prorationRounding) meta.prorationRounding = payload.prorationRounding
  return Object.keys(meta).length ? meta : null
}

function parseUpstreamMessage(error) {
  const body = error?.body
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body)
      const message = String(parsed?.message || '').trim()
      if (message) return message
    } catch {}
  }
  const message = String(error?.message || '').trim()
  return message && message !== 'UPSTREAM_BAD_RESPONSE' ? message : ''
}

function mapUpstreamFailure(error) {
  const status = Number(error?.status)
  const message = parseUpstreamMessage(error)
  if (status === 400) return toError(400, 'BAD_REQUEST', message || 'Request payload is invalid.')
  if (status === 404) return toError(404, 'NOT_FOUND', message || 'Related resource not found.')
  if (status === 409) return toError(409, 'CONFLICT', message || 'Request conflicts with current resource state.')
  if (status === 429) return toError(429, 'UPSTREAM_RATE_LIMITED', message || 'Upstream service rate limited.')
  return toError(502, 'UPSTREAM_ERROR', message || 'Upstream service error.')
}

function validatePayload(payload, options = {}) {
  const requireCommonFields = options.requireCommonFields !== false
  const name = String(payload?.name || '').trim()
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  const rawType = String(payload?.price_plan_type ?? payload?.type ?? '').trim()
  const type = rawType === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : rawType
  const allowedTypes = new Set(['ONE_TIME', 'SIM_DEPENDENT_BUNDLE', 'FIXED_BUNDLE', 'TIERED_VOLUME_PRICING'])
  if (!allowedTypes.has(type)) return toError(400, 'BAD_REQUEST', 'price_plan_type is invalid.')
  const serviceType = String(payload?.serviceType || '').trim()
  if (requireCommonFields && !serviceType) return toError(400, 'BAD_REQUEST', 'serviceType is required.')
  if (serviceType && !['DATA', 'VOICE', 'SMS'].includes(serviceType)) {
    return toError(400, 'BAD_REQUEST', 'serviceType is invalid.')
  }
  const currency = String(payload?.currency || '').trim()
  if (requireCommonFields && !currency) return toError(400, 'BAD_REQUEST', 'currency is required.')
  const billingCycleType = String(payload?.billingCycleType || '').trim()
  if (requireCommonFields && !billingCycleType) return toError(400, 'BAD_REQUEST', 'billingCycleType is required.')
  if (billingCycleType && !['CALENDAR_MONTH', 'CUSTOM_RANGE'].includes(billingCycleType)) {
    return toError(400, 'BAD_REQUEST', 'billingCycleType is invalid.')
  }
  const firstCycleProration = String(payload?.firstCycleProration || '').trim()
  if (requireCommonFields && !firstCycleProration) return toError(400, 'BAD_REQUEST', 'firstCycleProration is required.')
  if (firstCycleProration && !['NONE', 'DAILY_PRORATION'].includes(firstCycleProration)) {
    return toError(400, 'BAD_REQUEST', 'firstCycleProration is invalid.')
  }
  const prorationRounding = String(payload?.prorationRounding || '').trim()
  if (requireCommonFields && !prorationRounding) return toError(400, 'BAD_REQUEST', 'prorationRounding is required.')
  if (prorationRounding && !['ROUND_HALF_UP'].includes(prorationRounding)) {
    return toError(400, 'BAD_REQUEST', 'prorationRounding is invalid.')
  }
  const monthlyFee = toNumber(payload?.monthlyFee)
  const deactivatedMonthlyFee = toNumber(payload?.deactivatedMonthlyFee)
  const oneTimeFee = toNumber(payload?.oneTimeFee)
  const quotaKb = toInteger(payload?.quotaKb)
  const validityDays = toInteger(payload?.validityDays)
  const perSimQuotaKb = toInteger(payload?.perSimQuotaKb)
  const totalQuotaKb = toInteger(payload?.totalQuotaKb)
  const overageRatePerKb = toNumber(payload?.overageRatePerKb)
  const commercialTermsNormalized = normalizeCommercialTerms(payload?.commercialTerms)
  if (!commercialTermsNormalized.ok) return commercialTermsNormalized
  const controlPolicyNormalized = normalizeControlPolicy(payload?.controlPolicy)
  if (!controlPolicyNormalized.ok) return controlPolicyNormalized
  const carrierServiceInput = payload?.carrierService ?? payload?.carrierServiceConfig
  const carrierServiceNormalized = normalizeCarrierService(carrierServiceInput, serviceType || 'DATA')
  if (!carrierServiceNormalized.ok) return carrierServiceNormalized
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
      const fromKb = toInteger(tier?.fromKb)
      const toKb = toInteger(tier?.toKb)
      const ratePerKb = toNumber(tier?.ratePerKb)
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
      currency: currency || 'USD',
      billingCycleType: billingCycleType || 'CALENDAR_MONTH',
      firstCycleProration: firstCycleProration || 'NONE',
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
      meta: buildMeta(payload, {
        commercialTerms: commercialTermsNormalized.value,
        controlPolicy: controlPolicyNormalized.value,
        carrierService: carrierServiceNormalized.value,
      }),
    },
  }
}

async function loadPricePlan(supabase, pricePlanId) {
  const rows = await supabase.select(
    'price_plans',
    `select=price_plan_id,enterprise_id,name,type,service_type,currency,billing_cycle_type,first_cycle_proration,created_at&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

async function loadLatestVersion(supabase, pricePlanId) {
  const rows = await supabase.select(
    'price_plan_versions',
    `select=price_plan_version_id,price_plan_id,version,effective_from,monthly_fee,deactivated_monthly_fee,one_time_fee,quota_kb,validity_days,per_sim_quota_kb,total_quota_kb,overage_rate_per_kb,tiers,payg_rates,created_at&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&order=version.desc&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

function mapVersionResponse(version) {
  if (!version) return null
  const meta = version.payg_rates?.meta || null
  return {
    pricePlanId: version.price_plan_id,
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
    carrierService: meta?.carrierService ?? null,
    carrierServiceConfig: meta?.carrierService ?? null,
    expiryBoundary: meta?.expiryBoundary ?? null,
    prorationRounding: meta?.prorationRounding ?? null,
    createdAt: version.created_at,
  }
}

export async function createPricePlan({ supabase, enterpriseId, payload, audit }) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const validated = validatePayload(payload, { requireCommonFields: true })
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
  const carrierService = extractCarrierServiceMeta(meta)
  const carrierValidate = await validateCarrierServiceReferences(supabase, serviceType, carrierService)
  if (!carrierValidate.ok) return carrierValidate
  try {
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
    if (!plan?.price_plan_id) {
      return toError(500, 'INTERNAL_ERROR', 'Failed to create price plan.')
    }
    const versionRows = await supabase.insert(
      'price_plan_versions',
      {
        price_plan_id: plan.price_plan_id,
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
    if (plan?.price_plan_id) {
      await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: enterpriseId ?? null,
        action: 'PRICE_PLAN_CREATED',
        target_type: 'PRICE_PLAN',
        target_id: plan.price_plan_id,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: {
          pricePlanId: plan.price_plan_id,
          pricePlanVersionId: version?.price_plan_version_id ?? null,
          version: version?.version ?? 1,
        },
      })
    }
    return {
      ok: true,
      value: {
        pricePlanId: plan.price_plan_id,
        version: version?.version ?? 1,
        status: 'DRAFT',
        createdAt: version?.created_at ?? plan.created_at,
      },
    }
  } catch (error) {
    return mapUpstreamFailure(error)
  }
}

export async function listPricePlans({ supabase, enterpriseId, type, status, page, pageSize }) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  let planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,enterprise_id,name,type,service_type,currency,billing_cycle_type,first_cycle_proration,created_at&enterprise_id=eq.${encodeURIComponent(enterpriseId)}${type ? `&type=eq.${encodeURIComponent(type)}` : ''}&order=created_at.desc`
  )
  const plans = Array.isArray(planRows) ? planRows : []
  const ids = plans.map((p) => p.price_plan_id).filter(Boolean)
  let versions = []
  if (ids.length) {
    const idFilter = ids.map((id) => encodeURIComponent(id)).join(',')
    const versionRows = await supabase.select(
      'price_plan_versions',
      `select=price_plan_version_id,price_plan_id,version,effective_from,monthly_fee,deactivated_monthly_fee,one_time_fee,quota_kb,validity_days,per_sim_quota_kb,total_quota_kb,overage_rate_per_kb,tiers,payg_rates,created_at&price_plan_id=in.(${idFilter})&order=version.desc`
    )
    versions = Array.isArray(versionRows) ? versionRows : []
  }
  const latestByPlan = new Map()
  for (const v of versions) {
    if (!v?.price_plan_id) continue
    if (!latestByPlan.has(v.price_plan_id)) latestByPlan.set(v.price_plan_id, v)
  }
  let items = plans.map((plan) => {
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
  if (status) items = items.filter((it) => String(it.status) === String(status))
  const p = Number(page) || 1
  const ps = Number(pageSize) || 20
  const start = (p - 1) * ps
  const total = items.length
  items = items.slice(start, start + ps)
  return { ok: true, value: { items, total } }
}

export async function getPricePlanDetail({ supabase, pricePlanId }) {
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
      pricePlanId: plan.price_plan_id,
      enterpriseId: plan.enterprise_id,
      name: plan.name,
      type: plan.type,
      serviceType: plan.service_type,
      currency: plan.currency,
      billingCycleType: plan.billing_cycle_type,
      firstCycleProration: plan.first_cycle_proration,
      createdAt: plan.created_at,
      currentVersion: mapVersionResponse(currentVersion),
      versions: list.map(mapVersionResponse),
    },
  }
}

export async function createPricePlanVersion({ supabase, pricePlanId, payload, audit }) {
  if (!isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.')
  }
  const plan = await loadPricePlan(supabase, pricePlanId)
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  const payloadTypeRaw = String(payload?.price_plan_type ?? payload?.type ?? '').trim()
  if (payloadTypeRaw) {
    const payloadType = payloadTypeRaw === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : payloadTypeRaw
    const planType = String(plan.type ?? '').trim()
    if (payloadType !== planType) {
      return toError(400, 'BAD_REQUEST', 'price_plan_type must match the existing price plan type.')
    }
  }
  const validated = validatePayload(
    {
      ...payload,
      name: plan.name,
      type: plan.type,
      serviceType: plan.service_type,
      currency: plan.currency,
      billingCycleType: plan.billing_cycle_type,
      firstCycleProration: plan.first_cycle_proration,
      prorationRounding: payload?.prorationRounding ?? 'ROUND_HALF_UP',
    },
    { requireCommonFields: false }
  )
  if (!validated.ok) return validated
  const latest = await loadLatestVersion(supabase, pricePlanId)
  const nextVersion = (latest?.version ?? 0) + 1
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
  const carrierService = extractCarrierServiceMeta(meta)
  const carrierValidate = await validateCarrierServiceReferences(supabase, String(plan?.service_type ?? ''), carrierService)
  if (!carrierValidate.ok) return carrierValidate
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
  if (!version?.price_plan_version_id) {
    return toError(500, 'INTERNAL_ERROR', 'Failed to create price plan version.')
  }
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: plan.enterprise_id ?? null,
    action: 'PRICE_PLAN_VERSION_CREATED',
    target_type: 'PRICE_PLAN',
    target_id: pricePlanId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: {
      pricePlanVersionId: version.price_plan_version_id,
      version: version.version ?? nextVersion,
    },
  })
  return {
    ok: true,
    value: mapVersionResponse(version),
  }
}
