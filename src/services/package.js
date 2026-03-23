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

async function loadOperator(supabase, operatorId) {
  const rows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id&operator_id=eq.${encodeURIComponent(operatorId)}&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

function normalizeRoamingProfile(carrierServiceConfig) {
  const allowedMccMnc = normalizeAllowedMccMnc(carrierServiceConfig?.roamingProfile?.allowedMccMnc)
  const rat = carrierServiceConfig?.rat ? String(carrierServiceConfig.rat) : '4G'
  const profileId = carrierServiceConfig?.roamingProfileId ? String(carrierServiceConfig.roamingProfileId).trim() : null
  const profileVersionId = carrierServiceConfig?.roamingProfileVersionId
    ? String(carrierServiceConfig.roamingProfileVersionId).trim()
    : null
  const payload = {
    type: 'MCCMNC_ALLOWLIST',
    mccmnc: allowedMccMnc,
    rat,
    ...(profileId ? { profileId } : {}),
    ...(profileVersionId ? { profileVersionId } : {}),
  }
  return payload
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractPricePlanMeta(version) {
  const paygRates = version?.payg_rates
  if (!isPlainObject(paygRates)) return {}
  const meta = paygRates.meta
  return isPlainObject(meta) ? meta : {}
}

function normalizeCommercialTerms(input) {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (!isPlainObject(input)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms must be an object.')
  }
  const src = input
  const testPeriodDaysRaw = src.testPeriodDays
  const testQuotaMbRaw = src.testQuotaMb
  const commitmentPeriodMonthsRaw = src.commitmentPeriodMonths
  const testExpiryConditionRaw = src.testExpiryCondition
  const testExpiryActionRaw = src.testExpiryAction
  const testPeriodDays = testPeriodDaysRaw === undefined ? undefined : toInteger(testPeriodDaysRaw)
  const testQuotaMb = testQuotaMbRaw === undefined ? undefined : toInteger(testQuotaMbRaw)
  const commitmentPeriodMonths = commitmentPeriodMonthsRaw === undefined ? undefined : toInteger(commitmentPeriodMonthsRaw)
  const testExpiryCondition = testExpiryConditionRaw === undefined ? undefined : String(testExpiryConditionRaw).trim().toUpperCase()
  const testExpiryAction = testExpiryActionRaw === undefined ? undefined : String(testExpiryActionRaw).trim().toUpperCase()
  if (testPeriodDays !== undefined && (testPeriodDays === null || testPeriodDays < 0)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testPeriodDays must be a non-negative integer.')
  }
  if (testQuotaMb !== undefined && (testQuotaMb === null || testQuotaMb < 0)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testQuotaMb must be a non-negative integer.')
  }
  if (commitmentPeriodMonths !== undefined && (commitmentPeriodMonths === null || commitmentPeriodMonths < 0)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.commitmentPeriodMonths must be a non-negative integer.')
  }
  const allowedCondition = new Set(['PERIOD_ONLY', 'QUOTA_ONLY', 'PERIOD_OR_QUOTA'])
  if (testExpiryCondition !== undefined && !allowedCondition.has(testExpiryCondition)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testExpiryCondition is invalid.')
  }
  const allowedAction = new Set(['ACTIVATED', 'DEACTIVATED'])
  if (testExpiryAction !== undefined && !allowedAction.has(testExpiryAction)) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms.testExpiryAction is invalid.')
  }
  return {
    ok: true,
    value: {
      ...(testPeriodDays !== undefined ? { testPeriodDays } : {}),
      ...(testQuotaMb !== undefined ? { testQuotaMb } : {}),
      ...(testExpiryCondition !== undefined ? { testExpiryCondition } : {}),
      ...(testExpiryAction !== undefined ? { testExpiryAction } : {}),
      ...(commitmentPeriodMonths !== undefined ? { commitmentPeriodMonths } : {}),
    },
  }
}

function normalizeControlPolicy(input) {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (!isPlainObject(input)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy must be an object.')
  }
  const src = input
  const enabledRaw = src.enabled
  const cutoffPolicyId = src.cutoffPolicyId ? String(src.cutoffPolicyId).trim() : null
  const throttlingPolicyId = src.throttlingPolicyId ? String(src.throttlingPolicyId).trim() : null
  const cutoffThresholdMbRaw = src.cutoffThresholdMb
  const cutoffThresholdMb = cutoffThresholdMbRaw === undefined ? undefined : toInteger(cutoffThresholdMbRaw)
  if (enabledRaw !== undefined && typeof enabledRaw !== 'boolean') {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.enabled must be a boolean.')
  }
  if (cutoffPolicyId && !isValidUuid(cutoffPolicyId)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoffPolicyId must be a valid uuid.')
  }
  if (throttlingPolicyId && !isValidUuid(throttlingPolicyId)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.throttlingPolicyId must be a valid uuid.')
  }
  if (cutoffThresholdMb !== undefined && (cutoffThresholdMb === null || cutoffThresholdMb < 0)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoffThresholdMb must be a non-negative integer.')
  }
  return {
    ok: true,
    value: {
      ...(enabledRaw !== undefined ? { enabled: enabledRaw } : {}),
      ...(cutoffPolicyId ? { cutoffPolicyId } : {}),
      ...(throttlingPolicyId ? { throttlingPolicyId } : {}),
      ...(cutoffThresholdMb !== undefined ? { cutoffThresholdMb } : {}),
    },
  }
}

function normalizeCarrierServiceConfig(input) {
  if (!isPlainObject(input)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig must be an object.')
  }
  const src = input
  const supplierId = String(src.supplierId ?? '').trim()
  if (!isValidUuid(supplierId)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.supplierId must be a valid uuid.')
  }
  const operatorIdRaw = String(src.operatorId ?? src.carrierId ?? '').trim()
  if (!isValidUuid(operatorIdRaw)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.operatorId must be a valid uuid.')
  }
  const apn = String(src.apn ?? '').trim()
  if (!apn) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.apn is required.')
  }
  const rat = String(src.rat ?? '4G').trim().toUpperCase()
  const allowedRat = new Set(['3G', '4G', '5G', 'NB-IOT'])
  if (!allowedRat.has(rat)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.rat is invalid.')
  }
  const apnProfileId = src.apnProfileId ? String(src.apnProfileId).trim() : null
  if (apnProfileId && !isValidUuid(apnProfileId)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.apnProfileId must be a valid uuid.')
  }
  const apnProfileVersionId = src.apnProfileVersionId ? String(src.apnProfileVersionId).trim() : null
  if (apnProfileVersionId && !isValidUuid(apnProfileVersionId)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.apnProfileVersionId must be a valid uuid.')
  }
  const roamingProfileId = src.roamingProfileId ? String(src.roamingProfileId).trim() : null
  if (roamingProfileId && !isValidUuid(roamingProfileId)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.roamingProfileId must be a valid uuid.')
  }
  const roamingProfileVersionId = String(src.roamingProfileVersionId ?? '').trim()
  if (roamingProfileVersionId && !isValidUuid(roamingProfileVersionId)) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.roamingProfileVersionId must be a valid uuid.')
  }
  if (!roamingProfileId && !roamingProfileVersionId) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.roamingProfileId or carrierServiceConfig.roamingProfileVersionId is required.')
  }
  return {
    ok: true,
    value: {
      supplierId,
      operatorId: operatorIdRaw,
      apn,
      rat,
      ...(apnProfileId ? { apnProfileId } : {}),
      ...(apnProfileVersionId ? { apnProfileVersionId } : {}),
      ...(roamingProfileId ? { roamingProfileId } : {}),
      ...(roamingProfileVersionId ? { roamingProfileVersionId } : {}),
    },
  }
}

async function ensureProfileVersionExists(supabase, profileVersionId, profileType) {
  const rows = await supabase.select(
    'profile_versions',
    `select=profile_version_id,profile_type&profile_version_id=eq.${encodeURIComponent(profileVersionId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || String(row.profile_type ?? '').toUpperCase() !== profileType) {
    return toError(
      400,
      'BAD_REQUEST',
      `carrierServiceConfig.${profileType === 'APN' ? 'apnProfileVersionId' : 'roamingProfileVersionId'} is not found.`
    )
  }
  return { ok: true, value: null }
}

async function ensureProfileExists(supabase, profileId, profileType) {
  const table = profileType === 'APN' ? 'apn_profiles' : 'roaming_profiles'
  const key = profileType === 'APN' ? 'apn_profile_id' : 'roaming_profile_id'
  const rows = await supabase.select(table, `select=${key}&${key}=eq.${encodeURIComponent(profileId)}&limit=1`)
  const row = Array.isArray(rows) ? rows[0] : null
  if (!row || !row[key]) {
    return toError(400, 'BAD_REQUEST', `carrierServiceConfig.${profileType === 'APN' ? 'apnProfileId' : 'roamingProfileId'} is not found.`)
  }
  return { ok: true, value: null }
}

async function validateModuleReferences(supabase, carrierServiceConfig, controlPolicy) {
  const operatorId = String(carrierServiceConfig.operatorId)
  const supplierId = String(carrierServiceConfig.supplierId)
  const operator = await loadOperator(supabase, operatorId)
  if (!operator) return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.operatorId is not found.')
  if (String(operator?.supplier_id ?? '') !== supplierId) {
    return toError(400, 'BAD_REQUEST', 'carrierServiceConfig.operatorId is not linked to supplierId.')
  }
  const apnProfileId = carrierServiceConfig.apnProfileId
  if (apnProfileId) {
    const apnCheck = await ensureProfileExists(supabase, String(apnProfileId), 'APN')
    if (!apnCheck.ok) return apnCheck
  }
  const apnProfileVersionId = carrierServiceConfig.apnProfileVersionId
  if (apnProfileVersionId) {
    const apnCheck = await ensureProfileVersionExists(supabase, String(apnProfileVersionId), 'APN')
    if (!apnCheck.ok) return apnCheck
  }
  const roamingProfileId = String(carrierServiceConfig.roamingProfileId ?? '').trim()
  if (roamingProfileId) {
    const roamingCheck = await ensureProfileExists(supabase, roamingProfileId, 'ROAMING')
    if (!roamingCheck.ok) return roamingCheck
  }
  const roamingProfileVersionId = String(carrierServiceConfig.roamingProfileVersionId ?? '').trim()
  if (roamingProfileVersionId) {
    const roamingCheck = await ensureProfileVersionExists(supabase, roamingProfileVersionId, 'ROAMING')
    if (!roamingCheck.ok) return roamingCheck
  }
  const cutoffPolicyId = controlPolicy?.cutoffPolicyId ? String(controlPolicy.cutoffPolicyId) : null
  if (cutoffPolicyId) {
    const rows = await supabase.select(
      'cutoff_policies',
      `select=cutoff_policy_id&cutoff_policy_id=eq.${encodeURIComponent(cutoffPolicyId)}&limit=1`
    )
    if (!Array.isArray(rows) || !rows[0]) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoffPolicyId is not found.')
    }
  }
  const throttlingPolicyId = controlPolicy?.throttlingPolicyId ? String(controlPolicy.throttlingPolicyId) : null
  if (throttlingPolicyId) {
    const rows = await supabase.select(
      'throttling_policies',
      `select=throttling_policy_id&throttling_policy_id=eq.${encodeURIComponent(throttlingPolicyId)}&limit=1`
    )
    if (!Array.isArray(rows) || !rows[0]) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy.throttlingPolicyId is not found.')
    }
  }
  return { ok: true, value: { operatorId, supplierId } }
}

async function validateControlPolicyReferences(supabase, controlPolicy) {
  const cutoffPolicyId = controlPolicy?.cutoffPolicyId ? String(controlPolicy.cutoffPolicyId) : null
  if (cutoffPolicyId) {
    const rows = await supabase.select(
      'cutoff_policies',
      `select=cutoff_policy_id&cutoff_policy_id=eq.${encodeURIComponent(cutoffPolicyId)}&limit=1`
    )
    if (!Array.isArray(rows) || !rows[0]) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoffPolicyId is not found.')
    }
  }
  const throttlingPolicyId = controlPolicy?.throttlingPolicyId ? String(controlPolicy.throttlingPolicyId) : null
  if (throttlingPolicyId) {
    const rows = await supabase.select(
      'throttling_policies',
      `select=throttling_policy_id&throttling_policy_id=eq.${encodeURIComponent(throttlingPolicyId)}&limit=1`
    )
    if (!Array.isArray(rows) || !rows[0]) {
      return toError(400, 'BAD_REQUEST', 'controlPolicy.throttlingPolicyId is not found.')
    }
  }
  return { ok: true, value: null }
}

function normalizePackageModules(payload, pricePlanVersion) {
  const meta = extractPricePlanMeta(pricePlanVersion)
  const carrierSource = payload?.carrierServiceConfig ?? meta.carrierService
  const commercialSource = payload?.commercialTerms ?? meta.commercialTerms
  const controlSource = payload?.controlPolicy ?? meta.controlPolicy
  const carrierNormalized = normalizeCarrierServiceConfig(carrierSource)
  if (!carrierNormalized.ok) return carrierNormalized
  const commercialNormalized = normalizeCommercialTerms(commercialSource)
  if (!commercialNormalized.ok) return commercialNormalized
  if (!commercialNormalized.value) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms is required.')
  }
  const controlNormalized = normalizeControlPolicy(controlSource)
  if (!controlNormalized.ok) return controlNormalized
  if (!controlNormalized.value) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
  }
  return {
    ok: true,
    value: {
      carrierServiceConfig: carrierNormalized.value,
      commercialTerms: commercialNormalized.value,
      controlPolicy: controlNormalized.value,
    },
  }
}

export function validateCommercialTermsModule(payload) {
  const commercialNormalized = normalizeCommercialTerms(payload?.commercialTerms ?? payload)
  if (!commercialNormalized.ok) return commercialNormalized
  if (!commercialNormalized.value || !Object.keys(commercialNormalized.value).length) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms is required.')
  }
  return { ok: true, value: { commercialTerms: commercialNormalized.value } }
}

export async function validateControlPolicyModule({ supabase, payload }) {
  const controlNormalized = normalizeControlPolicy(payload?.controlPolicy ?? payload)
  if (!controlNormalized.ok) return controlNormalized
  if (!controlNormalized.value || !Object.keys(controlNormalized.value).length) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
  }
  const references = await validateControlPolicyReferences(supabase, controlNormalized.value)
  if (!references.ok) return references
  return { ok: true, value: { controlPolicy: controlNormalized.value } }
}

export async function validateCarrierServiceModule({ supabase, payload }) {
  const carrierNormalized = normalizeCarrierServiceConfig(payload?.carrierServiceConfig ?? payload)
  if (!carrierNormalized.ok) return carrierNormalized
  const references = await validateModuleReferences(supabase, carrierNormalized.value, null)
  if (!references.ok) return references
  return { ok: true, value: { carrierServiceConfig: carrierNormalized.value } }
}

function normalizeOptionalTenantId(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null }
  const id = String(value).trim()
  if (!isValidUuid(id)) return toError(400, 'BAD_REQUEST', `${fieldName} must be a valid uuid.`)
  return { ok: true, value: id }
}

function mapCommercialTermsModule(row) {
  return {
    commercialTermsId: row?.commercial_terms_id ?? null,
    commercialTerms: row?.commercial_terms ?? {},
    enterpriseId: row?.enterprise_id ?? null,
    resellerId: row?.reseller_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

function mapControlPolicyModule(row) {
  return {
    controlPolicyId: row?.control_policy_id ?? null,
    controlPolicy: row?.control_policy ?? {},
    enterpriseId: row?.enterprise_id ?? null,
    resellerId: row?.reseller_id ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

function mapCarrierServiceModule(row) {
  return {
    carrierServiceId: row?.carrier_service_id ?? null,
    supplierId: row?.supplier_id ?? null,
    operatorId: row?.operator_id ?? null,
    carrierServiceConfig: row?.carrier_service_config ?? {},
    enterpriseId: row?.enterprise_id ?? null,
    resellerId: row?.reseller_id ?? null,
    status: row?.status ?? null,
    effectiveFrom: row?.effective_from ?? null,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

export async function createCommercialTerms({ supabase, payload, audit }) {
  const normalized = validateCommercialTermsModule(payload)
  if (!normalized.ok) return normalized
  const enterpriseIdResult = normalizeOptionalTenantId(payload?.enterpriseId, 'enterpriseId')
  if (!enterpriseIdResult.ok) return enterpriseIdResult
  const resellerIdResult = normalizeOptionalTenantId(payload?.resellerId, 'resellerId')
  if (!resellerIdResult.ok) return resellerIdResult
  const rows = await supabase.insert(
    'commercial_terms_modules',
    {
      enterprise_id: enterpriseIdResult.value,
      reseller_id: resellerIdResult.value,
      commercial_terms: normalized.value.commercialTerms,
    },
    { returning: 'representation' }
  )
  const created = Array.isArray(rows) ? rows[0] : null
  if (!created?.commercial_terms_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create commercial terms.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: enterpriseIdResult.value ?? null,
    action: 'COMMERCIAL_TERMS_CREATED',
    target_type: 'COMMERCIAL_TERMS',
    target_id: created.commercial_terms_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: mapCommercialTermsModule(created),
  })
  return { ok: true, value: mapCommercialTermsModule(created) }
}

export async function updateCommercialTerms({ supabase, commercialTermsId, payload, audit }) {
  if (!isValidUuid(commercialTermsId)) return toError(400, 'BAD_REQUEST', 'commercialTermsId must be a valid uuid.')
  const rows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,enterprise_id,reseller_id,commercial_terms,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!existing?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
  const normalized = normalizeCommercialTerms(payload?.commercialTerms ?? payload)
  if (!normalized.ok) return normalized
  if (!normalized.value || !Object.keys(normalized.value).length) {
    return toError(400, 'BAD_REQUEST', 'commercialTerms is required.')
  }
  const merged = { ...(existing.commercial_terms ?? {}), ...normalized.value }
  await supabase.update(
    'commercial_terms_modules',
    `commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}`,
    { commercial_terms: merged, updated_at: new Date().toISOString() },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,enterprise_id,reseller_id,commercial_terms,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: existing?.enterprise_id ?? null,
    action: 'COMMERCIAL_TERMS_UPDATED',
    target_type: 'COMMERCIAL_TERMS',
    target_id: commercialTermsId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: mapCommercialTermsModule(existing),
    after_data: mapCommercialTermsModule(refreshed),
  })
  return { ok: true, value: mapCommercialTermsModule(refreshed) }
}

export async function getCommercialTermsDetail({ supabase, commercialTermsId }) {
  if (!isValidUuid(commercialTermsId)) return toError(400, 'BAD_REQUEST', 'commercialTermsId must be a valid uuid.')
  const rows = await supabase.select(
    'commercial_terms_modules',
    `select=commercial_terms_id,enterprise_id,reseller_id,commercial_terms,created_at,updated_at&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
  )
  const item = Array.isArray(rows) ? rows[0] : null
  if (!item?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
  return { ok: true, value: mapCommercialTermsModule(item) }
}

export async function createControlPolicy({ supabase, payload, audit }) {
  const normalized = await validateControlPolicyModule({ supabase, payload })
  if (!normalized.ok) return normalized
  const enterpriseIdResult = normalizeOptionalTenantId(payload?.enterpriseId, 'enterpriseId')
  if (!enterpriseIdResult.ok) return enterpriseIdResult
  const resellerIdResult = normalizeOptionalTenantId(payload?.resellerId, 'resellerId')
  if (!resellerIdResult.ok) return resellerIdResult
  const rows = await supabase.insert(
    'control_policy_modules',
    {
      enterprise_id: enterpriseIdResult.value,
      reseller_id: resellerIdResult.value,
      control_policy: normalized.value.controlPolicy,
    },
    { returning: 'representation' }
  )
  const created = Array.isArray(rows) ? rows[0] : null
  if (!created?.control_policy_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create control policy.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: enterpriseIdResult.value ?? null,
    action: 'CONTROL_POLICY_CREATED',
    target_type: 'CONTROL_POLICY',
    target_id: created.control_policy_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: mapControlPolicyModule(created),
  })
  return { ok: true, value: mapControlPolicyModule(created) }
}

export async function updateControlPolicy({ supabase, controlPolicyId, payload, audit }) {
  if (!isValidUuid(controlPolicyId)) return toError(400, 'BAD_REQUEST', 'controlPolicyId must be a valid uuid.')
  const rows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,enterprise_id,reseller_id,control_policy,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!existing?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
  const normalized = normalizeControlPolicy(payload?.controlPolicy ?? payload)
  if (!normalized.ok) return normalized
  if (!normalized.value || !Object.keys(normalized.value).length) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy is required.')
  }
  const merged = { ...(existing.control_policy ?? {}), ...normalized.value }
  const references = await validateControlPolicyReferences(supabase, merged)
  if (!references.ok) return references
  await supabase.update(
    'control_policy_modules',
    `control_policy_id=eq.${encodeURIComponent(controlPolicyId)}`,
    { control_policy: merged, updated_at: new Date().toISOString() },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,enterprise_id,reseller_id,control_policy,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: existing?.enterprise_id ?? null,
    action: 'CONTROL_POLICY_UPDATED',
    target_type: 'CONTROL_POLICY',
    target_id: controlPolicyId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: mapControlPolicyModule(existing),
    after_data: mapControlPolicyModule(refreshed),
  })
  return { ok: true, value: mapControlPolicyModule(refreshed) }
}

export async function getControlPolicyDetail({ supabase, controlPolicyId }) {
  if (!isValidUuid(controlPolicyId)) return toError(400, 'BAD_REQUEST', 'controlPolicyId must be a valid uuid.')
  const rows = await supabase.select(
    'control_policy_modules',
    `select=control_policy_id,enterprise_id,reseller_id,control_policy,created_at,updated_at&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
  )
  const item = Array.isArray(rows) ? rows[0] : null
  if (!item?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
  return { ok: true, value: mapControlPolicyModule(item) }
}

export async function createCarrierService({ supabase, payload, audit }) {
  const normalized = await validateCarrierServiceModule({ supabase, payload })
  if (!normalized.ok) return normalized
  const resellerIdResult = normalizeOptionalTenantId(payload?.resellerId, 'resellerId')
  if (!resellerIdResult.ok) return resellerIdResult
  const carrierServiceConfig = normalized.value.carrierServiceConfig
  const rows = await supabase.insert(
    'carrier_service_modules',
    {
      enterprise_id: null,
      reseller_id: resellerIdResult.value,
      supplier_id: carrierServiceConfig.supplierId,
      operator_id: carrierServiceConfig.operatorId,
      carrier_service_config: carrierServiceConfig,
    },
    { returning: 'representation' }
  )
  const created = Array.isArray(rows) ? rows[0] : null
  if (!created?.carrier_service_id) return toError(500, 'INTERNAL_ERROR', 'Failed to create carrier service.')
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: null,
    action: 'CARRIER_SERVICE_CREATED',
    target_type: 'CARRIER_SERVICE',
    target_id: created.carrier_service_id,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    after_data: mapCarrierServiceModule(created),
  })
  return { ok: true, value: mapCarrierServiceModule(created) }
}

export async function updateCarrierService({ supabase, carrierServiceId, payload, audit }) {
  if (!isValidUuid(carrierServiceId)) return toError(400, 'BAD_REQUEST', 'carrierServiceId must be a valid uuid.')
  const rows = await supabase.select(
    'carrier_service_modules',
    `select=carrier_service_id,enterprise_id,reseller_id,carrier_service_config,created_at,updated_at&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const existing = Array.isArray(rows) ? rows[0] : null
  if (!existing?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
  const mergedInput = {
    ...(existing.carrier_service_config ?? {}),
    ...(payload?.carrierServiceConfig ?? payload ?? {}),
  }
  const normalized = await validateCarrierServiceModule({ supabase, payload: { carrierServiceConfig: mergedInput } })
  if (!normalized.ok) return normalized
  const carrierServiceConfig = normalized.value.carrierServiceConfig
  await supabase.update(
    'carrier_service_modules',
    `carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}`,
    {
      supplier_id: carrierServiceConfig.supplierId,
      operator_id: carrierServiceConfig.operatorId,
      carrier_service_config: carrierServiceConfig,
      updated_at: new Date().toISOString(),
    },
    { returning: 'minimal' }
  )
  const refreshedRows = await supabase.select(
    'carrier_service_modules',
    `select=carrier_service_id,enterprise_id,reseller_id,carrier_service_config,created_at,updated_at&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const refreshed = Array.isArray(refreshedRows) ? refreshedRows[0] : null
  await writeAuditLog(supabase, {
    actor_user_id: audit?.actorUserId ?? null,
    actor_role: audit?.actorRole ?? null,
    tenant_id: existing?.enterprise_id ?? null,
    action: 'CARRIER_SERVICE_UPDATED',
    target_type: 'CARRIER_SERVICE',
    target_id: carrierServiceId,
    request_id: audit?.requestId ?? null,
    source_ip: audit?.sourceIp ?? null,
    before_data: mapCarrierServiceModule(existing),
    after_data: mapCarrierServiceModule(refreshed),
  })
  return { ok: true, value: mapCarrierServiceModule(refreshed) }
}

export async function getCarrierServiceDetail({ supabase, carrierServiceId }) {
  if (!isValidUuid(carrierServiceId)) return toError(400, 'BAD_REQUEST', 'carrierServiceId must be a valid uuid.')
  const rows = await supabase.select(
    'carrier_service_modules',
    `select=carrier_service_id,enterprise_id,reseller_id,carrier_service_config,created_at,updated_at&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
  )
  const item = Array.isArray(rows) ? rows[0] : null
  if (!item?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
  return { ok: true, value: mapCarrierServiceModule(item) }
}

function collectCarrierServiceConfigProfileRefs(config, key) {
  const refs = new Set()
  if (!config || typeof config !== 'object') return refs
  if (key === 'apnProfileId') {
    const profileId = String(config.apnProfileId ?? config.apn_profile_id ?? '').trim()
    const profileVersionId = String(config.apnProfileVersionId ?? '').trim()
    if (profileId) refs.add(profileId)
    if (profileVersionId) refs.add(profileVersionId)
    return refs
  }
  const profileId = String(config.roamingProfileId ?? config.roaming_profile_id ?? '').trim()
  const profileVersionId = String(config.roamingProfileVersionId ?? '').trim()
  if (profileId) refs.add(profileId)
  if (profileVersionId) refs.add(profileVersionId)
  return refs
}

async function resolveCompatibleProfileRefs(supabase, profileRef, profileType) {
  const refs = new Set()
  const normalized = String(profileRef ?? '').trim()
  if (!normalized) return refs
  refs.add(normalized)
  const byVersionRows = await supabase.select(
    'profile_versions',
    `select=profile_id,profile_version_id,profile_type&profile_version_id=eq.${encodeURIComponent(normalized)}&profile_type=eq.${encodeURIComponent(profileType)}&limit=1`
  )
  const byVersion = Array.isArray(byVersionRows) ? byVersionRows[0] : null
  const profileIdFromVersion = String(byVersion?.profile_id ?? '').trim()
  const profileVersionId = String(byVersion?.profile_version_id ?? '').trim()
  if (profileIdFromVersion) refs.add(profileIdFromVersion)
  if (profileVersionId) refs.add(profileVersionId)
  const byProfileRows = await supabase.select(
    'profile_versions',
    `select=profile_id,profile_version_id,profile_type&profile_id=eq.${encodeURIComponent(normalized)}&profile_type=eq.${encodeURIComponent(profileType)}`
  )
  for (const row of Array.isArray(byProfileRows) ? byProfileRows : []) {
    const profileId = String(row?.profile_id ?? '').trim()
    const profileVersion = String(row?.profile_version_id ?? '').trim()
    if (profileId) refs.add(profileId)
    if (profileVersion) refs.add(profileVersion)
  }
  return refs
}

function chooseLatestCarrierServiceReference(current, candidate) {
  const candidateRef = {
    carrier_service_id: String(candidate?.carrier_service_id ?? '').trim(),
    status: candidate?.status ?? null,
    effective_from: candidate?.effective_from ?? null,
    created_at: candidate?.created_at ?? null,
    version: Number(candidate?.version ?? 0) || 0,
  }
  if (!candidateRef.carrier_service_id) return current
  if (!current) return candidateRef
  const candidateTime = new Date(candidateRef.effective_from || candidateRef.created_at || 0).getTime()
  const currentTime = new Date(current.effective_from || current.created_at || 0).getTime()
  if (candidateTime > currentTime) return candidateRef
  if (candidateTime < currentTime) return current
  if ((candidateRef.version ?? 0) > (current.version ?? 0)) return candidateRef
  return current
}

export async function listCarrierServices({
  supabase,
  apnProfileId,
  roamingProfileId,
  status,
  page,
  pageSize,
  enterpriseId,
  resellerId,
}) {
  const apnProfileIdValue = apnProfileId ? String(apnProfileId).trim() : null
  const roamingProfileIdValue = roamingProfileId ? String(roamingProfileId).trim() : null
  if (!apnProfileIdValue && !roamingProfileIdValue) {
    return toError(400, 'BAD_REQUEST', 'apnProfileId or roamingProfileId is required.')
  }
  if (apnProfileIdValue && !isValidUuid(apnProfileIdValue)) {
    return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.')
  }
  if (roamingProfileIdValue && !isValidUuid(roamingProfileIdValue)) {
    return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.')
  }
  if (enterpriseId && !isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  if (resellerId && !isValidUuid(resellerId)) {
    return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.')
  }
  const filters = ['select=carrier_service_id,enterprise_id,reseller_id,supplier_id,operator_id,carrier_service_config,created_at,updated_at']
  if (enterpriseId) filters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  if (resellerId) filters.push(`reseller_id=eq.${encodeURIComponent(resellerId)}`)
  filters.push('order=created_at.desc')
  const [apnAcceptableRefs, roamingAcceptableRefs] = await Promise.all([
    apnProfileIdValue ? resolveCompatibleProfileRefs(supabase, apnProfileIdValue, 'APN') : Promise.resolve(new Set()),
    roamingProfileIdValue
      ? resolveCompatibleProfileRefs(supabase, roamingProfileIdValue, 'ROAMING')
      : Promise.resolve(new Set()),
  ])
  const rows = await supabase.select('carrier_service_modules', filters.join('&'))
  const services = Array.isArray(rows) ? rows : []
  const filteredServices = services.filter((row) => {
    const config = row?.carrier_service_config ?? {}
    const apnRefs = collectCarrierServiceConfigProfileRefs(config, 'apnProfileId')
    const roamingRefs = collectCarrierServiceConfigProfileRefs(config, 'roamingProfileId')
    if (apnProfileIdValue && !Array.from(apnRefs).some((ref) => apnAcceptableRefs.has(ref))) return false
    if (roamingProfileIdValue && !Array.from(roamingRefs).some((ref) => roamingAcceptableRefs.has(ref))) return false
    return true
  })
  const serviceIds = filteredServices.map((row) => String(row?.carrier_service_id ?? '').trim()).filter(Boolean)
  const latestRefByCarrierServiceId = new Map()
  if (serviceIds.length) {
    const idFilter = serviceIds.map((id) => encodeURIComponent(id)).join(',')
    const refs = await supabase.select(
      'package_versions',
      `select=carrier_service_id,status,effective_from,created_at,version&carrier_service_id=in.(${idFilter})`
    )
    for (const ref of Array.isArray(refs) ? refs : []) {
      const carrierServiceIdKey = String(ref?.carrier_service_id ?? '').trim()
      if (!carrierServiceIdKey) continue
      const current = latestRefByCarrierServiceId.get(carrierServiceIdKey)
      const next = chooseLatestCarrierServiceReference(current, ref)
      if (next) latestRefByCarrierServiceId.set(carrierServiceIdKey, next)
    }
  }
  let items = filteredServices.map((row) => {
    const mapped = mapCarrierServiceModule(row)
    const ref = latestRefByCarrierServiceId.get(String(row?.carrier_service_id ?? '').trim())
    const resolvedStatus = ref?.status ?? 'DRAFT'
    const resolvedEffectiveFrom = ref?.effective_from ?? null
    return {
      ...mapped,
      status: resolvedStatus,
      effectiveFrom: resolvedEffectiveFrom,
    }
  })
  if (status) items = items.filter((it) => String(it?.status ?? '') === String(status))
  const p = Number(page) || 1
  const ps = Number(pageSize) || 20
  const start = (p - 1) * ps
  const total = items.length
  items = items.slice(start, start + ps)
  return { ok: true, value: { items, total } }
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
    `select=package_version_id,package_id,version,status,effective_from,supplier_id,operator_id,service_type,apn,roaming_profile,carrier_service_id,carrier_service_config,control_policy_id,control_policy,commercial_terms_id,commercial_terms,price_plan_id,price_plan_version_id,created_at&package_id=eq.${encodeURIComponent(packageId)}&order=version.desc&limit=1`
  )
  return Array.isArray(rows) ? rows[0] : null
}

function mapPackageVersion(version) {
  if (!version) return null
  const roamingProfile = version.roaming_profile
  const carrierServiceConfig =
    version.carrier_service_config && typeof version.carrier_service_config === 'object'
      ? version.carrier_service_config
      : {
          supplierId: version.supplier_id ?? null,
          operatorId: version.operator_id ?? null,
          apn: version.apn ?? null,
          rat: roamingProfile?.rat ?? null,
          apnProfileId: roamingProfile?.apnProfileId ?? null,
          apnProfileVersionId: roamingProfile?.apnProfileVersionId ?? null,
          roamingProfileId: roamingProfile?.profileId ?? null,
          roamingProfileVersionId: roamingProfile?.profileVersionId ?? null,
        }
  return {
    packageVersionId: version.package_version_id,
    version: version.version,
    status: version.status,
    effectiveFrom: version.effective_from,
    supplierId: version.supplier_id,
    carrierId: version.operator_id ?? null,
    serviceType: version.service_type,
    apn: version.apn,
    roamingProfile: version.roaming_profile,
    carrierServiceConfig,
    carrierServiceId: version.carrier_service_id ?? null,
    controlPolicyId: version.control_policy_id ?? null,
    commercialTermsId: version.commercial_terms_id ?? null,
    controlPolicy: version.control_policy,
    commercialTerms: version.commercial_terms,
    pricePlanId: version.price_plan_id ?? null,
    pricePlanVersionId: version.price_plan_version_id,
    createdAt: version.created_at,
  }
}

async function resolveModulePayloadByIds({ supabase, carrierServiceId, controlPolicyId, commercialTermsId }) {
  let carrierServiceConfig = null
  let controlPolicy = null
  let commercialTerms = null
  if (carrierServiceId) {
    if (!isValidUuid(carrierServiceId)) return toError(400, 'BAD_REQUEST', 'carrierServiceId must be a valid uuid.')
    const rows = await supabase.select(
      'carrier_service_modules',
      `select=carrier_service_id,carrier_service_config&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row?.carrier_service_id) return toError(404, 'NOT_FOUND', 'Carrier service not found.')
    carrierServiceConfig = row.carrier_service_config ?? null
  }
  if (controlPolicyId) {
    if (!isValidUuid(controlPolicyId)) return toError(400, 'BAD_REQUEST', 'controlPolicyId must be a valid uuid.')
    const rows = await supabase.select(
      'control_policy_modules',
      `select=control_policy_id,control_policy&control_policy_id=eq.${encodeURIComponent(controlPolicyId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row?.control_policy_id) return toError(404, 'NOT_FOUND', 'Control policy not found.')
    controlPolicy = row.control_policy ?? null
  }
  if (commercialTermsId) {
    if (!isValidUuid(commercialTermsId)) return toError(400, 'BAD_REQUEST', 'commercialTermsId must be a valid uuid.')
    const rows = await supabase.select(
      'commercial_terms_modules',
      `select=commercial_terms_id,commercial_terms&commercial_terms_id=eq.${encodeURIComponent(commercialTermsId)}&limit=1`
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row?.commercial_terms_id) return toError(404, 'NOT_FOUND', 'Commercial terms not found.')
    commercialTerms = row.commercial_terms ?? null
  }
  return { ok: true, value: { carrierServiceConfig, controlPolicy, commercialTerms } }
}

export async function createPackage({ supabase, enterpriseId, payload, audit }) {
  if (!isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.')
  }
  const name = String(payload?.name || '').trim()
  if (!name) return toError(400, 'BAD_REQUEST', 'name is required.')
  const pricePlanId = String(payload?.pricePlanId || '').trim()
  const pricePlanVersionId = String(payload?.pricePlanVersionId || '').trim()
  if (!pricePlanId && !pricePlanVersionId) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId or pricePlanVersionId is required.')
  }
  if (pricePlanId && !isValidUuid(pricePlanId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.')
  }
  if (pricePlanVersionId && !isValidUuid(pricePlanVersionId)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanVersionId must be a valid uuid.')
  }
  const planVersionQuery = pricePlanVersionId
    ? `select=price_plan_version_id,price_plan_id,payg_rates&price_plan_version_id=eq.${encodeURIComponent(pricePlanVersionId)}&limit=1`
    : `select=price_plan_version_id,price_plan_id,payg_rates&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&order=version.desc&limit=1`
  const pricePlanVersionRows = await supabase.select('price_plan_versions', planVersionQuery)
  const pricePlanVersion = Array.isArray(pricePlanVersionRows) ? pricePlanVersionRows[0] : null
  if (!pricePlanVersion) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  const carrierServiceId = payload?.carrierServiceId ? String(payload.carrierServiceId).trim() : null
  const controlPolicyId = payload?.controlPolicyId ? String(payload.controlPolicyId).trim() : null
  const commercialTermsId = payload?.commercialTermsId ? String(payload.commercialTermsId).trim() : null
  const moduleById = await resolveModulePayloadByIds({
    supabase,
    carrierServiceId,
    controlPolicyId,
    commercialTermsId,
  })
  if (!moduleById.ok) return moduleById
  const normalizeInput = {
    ...payload,
    ...(moduleById.value.carrierServiceConfig ? { carrierServiceConfig: moduleById.value.carrierServiceConfig } : {}),
    ...(moduleById.value.controlPolicy ? { controlPolicy: moduleById.value.controlPolicy } : {}),
    ...(moduleById.value.commercialTerms ? { commercialTerms: moduleById.value.commercialTerms } : {}),
  }
  const normalizedModules = normalizePackageModules(normalizeInput, pricePlanVersion)
  if (!normalizedModules.ok) return normalizedModules
  const modulesValidate = await validateModuleReferences(
    supabase,
    normalizedModules.value.carrierServiceConfig,
    normalizedModules.value.controlPolicy
  )
  if (!modulesValidate.ok) return modulesValidate
  const planRows = await supabase.select(
    'price_plans',
    `select=price_plan_id,service_type&price_plan_id=eq.${encodeURIComponent(pricePlanVersion.price_plan_id)}&limit=1`
  )
  const plan = Array.isArray(planRows) ? planRows[0] : null
  if (!plan) return toError(404, 'NOT_FOUND', 'Price plan not found.')
  const carrierServiceConfig = normalizedModules.value.carrierServiceConfig
  const supplierId = modulesValidate.value.supplierId
  const operatorId = modulesValidate.value.operatorId
  const apn = String(carrierServiceConfig.apn)
  const roamingProfile = normalizeRoamingProfile({
    rat: carrierServiceConfig.rat,
    roamingProfileId: carrierServiceConfig.roamingProfileId,
    roamingProfileVersionId: carrierServiceConfig.roamingProfileVersionId,
  })
  if (carrierServiceConfig.apnProfileId) {
    roamingProfile.apnProfileId = carrierServiceConfig.apnProfileId
  }
  if (carrierServiceConfig.apnProfileVersionId) {
    roamingProfile.apnProfileVersionId = carrierServiceConfig.apnProfileVersionId
  }
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
      operator_id: operatorId,
      service_type: plan.service_type ?? 'DATA',
      apn,
      roaming_profile: roamingProfile,
      carrier_service_id: carrierServiceId,
      carrier_service_config: normalizedModules.value.carrierServiceConfig,
      control_policy_id: controlPolicyId,
      control_policy: normalizedModules.value.controlPolicy,
      commercial_terms_id: commercialTermsId,
      commercial_terms: normalizedModules.value.commercialTerms,
      price_plan_id: pricePlanVersion.price_plan_id,
      price_plan_version_id: pricePlanVersion.price_plan_version_id,
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
  const carrierServiceId = payload?.carrierServiceId ? String(payload.carrierServiceId).trim() : null
  const controlPolicyId = payload?.controlPolicyId ? String(payload.controlPolicyId).trim() : null
  const commercialTermsId = payload?.commercialTermsId ? String(payload.commercialTermsId).trim() : null
  const moduleById = await resolveModulePayloadByIds({
    supabase,
    carrierServiceId,
    controlPolicyId,
    commercialTermsId,
  })
  if (!moduleById.ok) return moduleById
  const mergedCarrierServiceConfig = {
    supplierId: payload?.carrierServiceConfig?.supplierId ?? moduleById.value.carrierServiceConfig?.supplierId ?? latestVersion.supplier_id,
    operatorId:
      payload?.carrierServiceConfig?.operatorId ??
      payload?.carrierServiceConfig?.carrierId ??
      moduleById.value.carrierServiceConfig?.operatorId ??
      latestVersion.operator_id,
    apn: payload?.carrierServiceConfig?.apn ?? moduleById.value.carrierServiceConfig?.apn ?? latestVersion.apn,
    rat: payload?.carrierServiceConfig?.rat ?? moduleById.value.carrierServiceConfig?.rat ?? latestVersion?.roaming_profile?.rat ?? '4G',
    apnProfileId:
      payload?.carrierServiceConfig?.apnProfileId ??
      moduleById.value.carrierServiceConfig?.apnProfileId ??
      latestVersion?.roaming_profile?.apnProfileId ??
      null,
    apnProfileVersionId:
      payload?.carrierServiceConfig?.apnProfileVersionId ??
      moduleById.value.carrierServiceConfig?.apnProfileVersionId ??
      latestVersion?.roaming_profile?.apnProfileVersionId ??
      null,
    roamingProfileId:
      payload?.carrierServiceConfig?.roamingProfileId ??
      moduleById.value.carrierServiceConfig?.roamingProfileId ??
      latestVersion?.roaming_profile?.profileId ??
      null,
    roamingProfileVersionId:
      payload?.carrierServiceConfig?.roamingProfileVersionId ??
      moduleById.value.carrierServiceConfig?.roamingProfileVersionId ??
      latestVersion?.roaming_profile?.profileVersionId ??
      null,
  }
  const carrierNormalized = normalizeCarrierServiceConfig(mergedCarrierServiceConfig)
  if (!carrierNormalized.ok) return carrierNormalized
  const commercialNormalized = normalizeCommercialTerms(
    payload?.commercialTerms !== undefined ? payload.commercialTerms : moduleById.value.commercialTerms ?? latestVersion.commercial_terms
  )
  if (!commercialNormalized.ok) return commercialNormalized
  const controlNormalized = normalizeControlPolicy(
    payload?.controlPolicy !== undefined ? payload.controlPolicy : moduleById.value.controlPolicy ?? latestVersion.control_policy
  )
  if (!controlNormalized.ok) return controlNormalized
  const modulesValidate = await validateModuleReferences(supabase, carrierNormalized.value, controlNormalized.value)
  if (!modulesValidate.ok) return modulesValidate
  const roamingProfile = normalizeRoamingProfile({
    rat: carrierNormalized.value.rat,
    roamingProfileId: carrierNormalized.value.roamingProfileId,
    roamingProfileVersionId: carrierNormalized.value.roamingProfileVersionId,
  })
  if (carrierNormalized.value.apnProfileId) {
    roamingProfile.apnProfileId = carrierNormalized.value.apnProfileId
  }
  if (carrierNormalized.value.apnProfileVersionId) {
    roamingProfile.apnProfileVersionId = carrierNormalized.value.apnProfileVersionId
  }
  const patch = {}
  patch.supplier_id = modulesValidate.value.supplierId
  patch.operator_id = modulesValidate.value.operatorId
  patch.apn = carrierNormalized.value.apn
  patch.roaming_profile = roamingProfile
  patch.carrier_service_config = carrierNormalized.value
  if (carrierServiceId !== null) patch.carrier_service_id = carrierServiceId
  if (controlPolicyId !== null) patch.control_policy_id = controlPolicyId
  if (commercialTermsId !== null) patch.commercial_terms_id = commercialTermsId
  patch.control_policy = controlNormalized.value
  patch.commercial_terms = commercialNormalized.value
  if (payload?.pricePlanId) {
    const pricePlanId = String(payload.pricePlanId).trim()
    if (!isValidUuid(pricePlanId)) {
      return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.')
    }
    patch.price_plan_id = pricePlanId
  }
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
  const pricePlanVersionRows = await supabase.select('price_plan_versions', latestVersion.price_plan_id
    ? `select=price_plan_version_id,payg_rates&price_plan_id=eq.${encodeURIComponent(latestVersion.price_plan_id)}&order=version.desc&limit=1`
    : `select=price_plan_version_id,payg_rates&price_plan_version_id=eq.${encodeURIComponent(latestVersion.price_plan_version_id)}&limit=1`)
  const pricePlanVersion = Array.isArray(pricePlanVersionRows) ? pricePlanVersionRows[0] : null
  if (!pricePlanVersion) return toError(404, 'NOT_FOUND', 'Price plan version not found.')
  const conflictCheck = detectPaygConflicts(pricePlanVersion.payg_rates)
  if (!conflictCheck.ok) return toError(409, 'PAYG_CONFLICT', conflictCheck.message)
  const apnProfileId = latestVersion.roaming_profile?.apnProfileId
  if (apnProfileId) {
    const apnProfiles = await supabase.select(
      'apn_profiles',
      `select=apn_profile_id,status&apn_profile_id=eq.${encodeURIComponent(String(apnProfileId))}&limit=1`
    )
    const apnProfile = Array.isArray(apnProfiles) ? apnProfiles[0] : null
    if (!apnProfile || apnProfile.status !== 'PUBLISHED') {
      return toError(409, 'PROFILE_VERSION_INVALID', 'APN profile must be PUBLISHED.')
    }
  }
  const apnProfileVersionId = latestVersion.roaming_profile?.apnProfileVersionId ?? latestVersion.control_policy?.apnProfileVersionId
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
  const roamingProfileId = latestVersion.roaming_profile?.profileId
  if (roamingProfileId) {
    const roamingProfiles = await supabase.select(
      'roaming_profiles',
      `select=roaming_profile_id,status&roaming_profile_id=eq.${encodeURIComponent(String(roamingProfileId))}&limit=1`
    )
    const roamingProfile = Array.isArray(roamingProfiles) ? roamingProfiles[0] : null
    if (!roamingProfile || roamingProfile.status !== 'PUBLISHED') {
      return toError(409, 'PROFILE_VERSION_INVALID', 'Roaming profile must be PUBLISHED.')
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
      `select=package_version_id,package_id,version,status,effective_from,supplier_id,operator_id,service_type,apn,roaming_profile,carrier_service_id,carrier_service_config,control_policy_id,control_policy,commercial_terms_id,commercial_terms,price_plan_id,price_plan_version_id,created_at&package_id=in.(${idFilter})&order=version.desc`
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

export async function listPackagesByModuleRefs({
  supabase,
  pricePlanId,
  commercialTermsId,
  controlPolicyId,
  enterpriseId,
  status,
  page,
  pageSize,
}) {
  const pricePlanIdValue = pricePlanId ? String(pricePlanId).trim() : null
  const commercialTermsIdValue = commercialTermsId ? String(commercialTermsId).trim() : null
  const controlPolicyIdValue = controlPolicyId ? String(controlPolicyId).trim() : null
  if (!pricePlanIdValue && !commercialTermsIdValue && !controlPolicyIdValue) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId or commercialTermsId or controlPolicyId is required.')
  }
  if (pricePlanIdValue && !isValidUuid(pricePlanIdValue)) {
    return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.')
  }
  if (commercialTermsIdValue && !isValidUuid(commercialTermsIdValue)) {
    return toError(400, 'BAD_REQUEST', 'commercialTermsId must be a valid uuid.')
  }
  if (controlPolicyIdValue && !isValidUuid(controlPolicyIdValue)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicyId must be a valid uuid.')
  }
  if (enterpriseId && !isValidUuid(enterpriseId)) {
    return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.')
  }
  let allowedPricePlanVersionIds = null
  if (pricePlanIdValue) {
    const planVersionRows = await supabase.select(
      'price_plan_versions',
      `select=price_plan_version_id&price_plan_id=eq.${encodeURIComponent(pricePlanIdValue)}`
    )
    const ids = (Array.isArray(planVersionRows) ? planVersionRows : [])
      .map((row) => String(row?.price_plan_version_id ?? '').trim())
      .filter(Boolean)
    allowedPricePlanVersionIds = new Set(ids)
  }
  const packageFilters = ['select=package_id,enterprise_id,name,created_at']
  if (enterpriseId) packageFilters.push(`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`)
  packageFilters.push('order=created_at.desc')
  const packageRows = await supabase.select('packages', packageFilters.join('&'))
  const packages = Array.isArray(packageRows) ? packageRows : []
  const packageIds = packages.map((pkg) => String(pkg?.package_id ?? '').trim()).filter(Boolean)
  if (!packageIds.length) return { ok: true, value: { items: [], total: 0 } }
  const idFilter = packageIds.map((id) => encodeURIComponent(id)).join(',')
  const versionRows = await supabase.select(
    'package_versions',
    `select=package_version_id,package_id,version,status,effective_from,supplier_id,operator_id,service_type,apn,roaming_profile,carrier_service_id,carrier_service_config,control_policy_id,control_policy,commercial_terms_id,commercial_terms,price_plan_id,price_plan_version_id,created_at&package_id=in.(${idFilter})&order=version.desc`
  )
  const versions = Array.isArray(versionRows) ? versionRows : []
  const latestByPackageId = new Map()
  for (const version of versions) {
    const packageIdKey = String(version?.package_id ?? '').trim()
    if (!packageIdKey || latestByPackageId.has(packageIdKey)) continue
    latestByPackageId.set(packageIdKey, version)
  }
  let items = packages
    .map((pkg) => {
      const version = latestByPackageId.get(String(pkg?.package_id ?? '').trim()) || null
      if (!version) return null
      return {
        packageId: pkg.package_id,
        enterpriseId: pkg.enterprise_id,
        name: pkg.name,
        status: version?.status ?? 'DRAFT',
        latestVersion: mapPackageVersion(version),
        createdAt: pkg.created_at,
      }
    })
    .filter(Boolean)
  if (allowedPricePlanVersionIds) {
    items = items.filter((item) => {
      const planId = String(item?.latestVersion?.pricePlanId ?? '').trim()
      if (planId) return planId === pricePlanIdValue
      const versionId = String(item?.latestVersion?.pricePlanVersionId ?? '').trim()
      return Boolean(versionId && allowedPricePlanVersionIds?.has(versionId))
    })
  }
  if (commercialTermsIdValue) {
    items = items.filter((item) => String(item?.latestVersion?.commercialTermsId ?? '').trim() === commercialTermsIdValue)
  }
  if (controlPolicyIdValue) {
    items = items.filter((item) => String(item?.latestVersion?.controlPolicyId ?? '').trim() === controlPolicyIdValue)
  }
  if (status) items = items.filter((item) => String(item?.status ?? '') === String(status))
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
    `select=package_version_id,package_id,version,status,effective_from,supplier_id,operator_id,service_type,apn,roaming_profile,carrier_service_id,carrier_service_config,control_policy_id,control_policy,commercial_terms_id,commercial_terms,price_plan_id,price_plan_version_id,created_at&package_id=eq.${encodeURIComponent(packageId)}&order=version.desc`
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
