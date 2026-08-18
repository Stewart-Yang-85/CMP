import { actorUserIdForDb } from '../utils/actorUserId.js';

function isValidUuid(value) {
    const s = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}
function toError(status, code, message) {
    return { ok: false, status, code, message };
}
async function writeAuditLog(supabase, payload) {
    await supabase.insert('audit_logs', {
        ...payload,
        actor_user_id: actorUserIdForDb(payload.actor_user_id),
    }, { returning: 'minimal' });
}
function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}
function toInteger(value) {
    const num = Number(value);
    if (!Number.isFinite(num))
        return null;
    return Number.isInteger(num) ? num : Math.trunc(num);
}
function toBoolean(value) {
    if (typeof value === 'boolean')
        return value;
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    return null;
}
function resolveVersionStatus(version) {
    if (!version)
        return 'DRAFT';
    const raw = String(version.status ?? '').trim().toUpperCase();
    if (raw === 'DRAFT' || raw === 'PUBLISHED' || raw === 'DEPRECATED')
        return raw;
    if (version.deprecated_at)
        return 'DEPRECATED';
    if (!version.effective_from)
        return 'DRAFT';
    const now = Date.now();
    const effective = new Date(version.effective_from).getTime();
    if (Number.isNaN(effective))
        return 'DRAFT';
    return effective <= now ? 'PUBLISHED' : 'DRAFT';
}
function normalizeCarrierService(input, serviceType) {
    if (input === null || input === undefined)
        return { ok: true, value: null };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return toError(400, 'BAD_REQUEST', 'carrierService must be an object.');
    }
    const src = input;
    const supplierId = String(src.supplierId ?? '').trim();
    const operatorId = String(src.operatorId ?? '').trim();
    if (supplierId && !isValidUuid(supplierId)) {
        return toError(400, 'BAD_REQUEST', 'carrierService.supplierId must be a valid uuid.');
    }
    if (operatorId && !isValidUuid(operatorId)) {
        return toError(400, 'BAD_REQUEST', 'carrierService.operatorId must be a valid uuid.');
    }
    const rat = String(src.rat ?? '4G').trim();
    if (rat && !['3G', '4G', '5G', 'NB-IoT'].includes(rat)) {
        return toError(400, 'BAD_REQUEST', 'carrierService.rat is invalid.');
    }
    const apn = String(src.apn ?? '').trim();
    const apnProfileId = String(src.apnProfileId ?? '').trim();
    const apnProfileVersionId = String(src.apnProfileVersionId ?? '').trim();
    const roamingProfileId = String(src.roamingProfileId ?? '').trim();
    if (apnProfileVersionId) {
        return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileVersionId is no longer supported. Use carrierService.apnProfileId.');
    }
    if (apnProfileId && !isValidUuid(apnProfileId)) {
        return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileId must be a valid uuid.');
    }
    if (roamingProfileId && !isValidUuid(roamingProfileId)) {
        return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId must be a valid uuid.');
    }
    const roamingProfile = src.roamingProfile;
    const allowedMccMnc = Array.isArray(roamingProfile?.allowedMccMnc)
        ? roamingProfile.allowedMccMnc.map((v) => String(v).trim()).filter(Boolean)
        : [];
    if (serviceType === 'DATA' && !apn && !apnProfileId && !roamingProfileId) {
        return toError(400, 'BAD_REQUEST', 'carrierService.apn or carrierService.apnProfileId or carrierService.roamingProfileId is required for DATA serviceType.');
    }
    if (roamingProfile !== undefined && !Array.isArray(roamingProfile?.allowedMccMnc)) {
        return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfile.allowedMccMnc must be an array.');
    }
    return {
        ok: true,
        value: {
            ...(supplierId ? { supplierId } : {}),
            ...(operatorId ? { operatorId } : {}),
            rat: rat || '4G',
            ...(apn ? { apn } : {}),
            ...(apnProfileId ? { apnProfileId } : {}),
            ...(roamingProfileId ? { roamingProfileId } : {}),
            ...(allowedMccMnc.length ? { roamingProfile: { allowedMccMnc } } : {}),
        },
    };
}
function parseCarrierMccMncPattern(value) {
    const raw = String(value ?? '').trim();
    if (!raw)
        return null;
    const wildcard = raw.match(/^(\d{3})-\*$/);
    if (wildcard) {
        return { mcc: wildcard[1], mnc: null, normalized: `${wildcard[1]}-*` };
    }
    const exact = raw.match(/^(\d{3})-?(\d{2,3})$/);
    if (!exact)
        return null;
    return { mcc: exact[1], mnc: exact[2], normalized: `${exact[1]}-${exact[2]}` };
}
function normalizeCarrierMccMncList(input) {
    const list = Array.isArray(input) ? input : [];
    const normalized = [];
    for (const item of list) {
        if (typeof item === 'string') {
            const parsed = parseCarrierMccMncPattern(item);
            if (!parsed)
                return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc contains invalid value: ${String(item)}`);
            normalized.push(parsed.normalized);
            continue;
        }
        if (item && typeof item === 'object') {
            const mcc = String(item.mcc ?? '').trim();
            const mnc = String(item.mnc ?? '').trim();
            const parsed = parseCarrierMccMncPattern(`${mcc}-${mnc}`);
            if (!parsed)
                return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc contains invalid value: ${mcc}-${mnc}`);
            normalized.push(parsed.normalized);
            continue;
        }
        return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfile.allowedMccMnc entries are invalid.');
    }
    return { ok: true, value: Array.from(new Set(normalized)) };
}
async function loadOperatorBinding(supabase, supplierId, operatorId) {
    const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : '';
    const directRows = await supabase.select('operators', `select=operator_id,business_operator_id,supplier_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`);
    const direct = Array.isArray(directRows) ? directRows[0] : null;
    if (direct?.operator_id) {
        return {
            ok: true,
            value: {
                operatorId: String(direct.operator_id),
                businessOperatorId: String(direct?.business_operator_id ?? '').trim() || null,
            },
        };
    }
    const mappedRows = await supabase.select('operators', `select=operator_id,business_operator_id,supplier_id&business_operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`);
    const mapped = Array.isArray(mappedRows) ? mappedRows[0] : null;
    if (mapped?.operator_id) {
        return {
            ok: true,
            value: {
                operatorId: String(mapped.operator_id),
                businessOperatorId: String(mapped?.business_operator_id ?? operatorId).trim() || null,
            },
        };
    }
    if (supplierId)
        return toError(400, 'BAD_REQUEST', 'carrierService.operatorId is not linked to supplierId.');
    return toError(400, 'BAD_REQUEST', 'carrierService.operatorId is not found.');
}
async function hasSupplierCapabilityForBusinessOperator(supabase, supplierId, businessOperatorId) {
    const directRows = await supabase.select('operators', `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&operator_id=eq.${encodeURIComponent(businessOperatorId)}&limit=1`);
    if (Array.isArray(directRows) && directRows[0]?.operator_id)
        return true;
    const mappedRows = await supabase.select('operators', `select=operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}&limit=1`);
    return Array.isArray(mappedRows) && Boolean(mappedRows[0]?.operator_id);
}
async function validateCarrierServiceReferences(supabase, serviceType, carrierService) {
    if (!carrierService || typeof carrierService !== 'object')
        return { ok: true, value: null };
    const supplierId = String(carrierService.supplierId ?? '').trim() || null;
    const operatorIdInput = String(carrierService.operatorId ?? '').trim() || null;
    const apn = String(carrierService.apn ?? '').trim() || null;
    const apnProfileId = String(carrierService.apnProfileId ?? '').trim() || null;
    const apnProfileVersionId = String(carrierService.apnProfileVersionId ?? '').trim() || null;
    if (apnProfileVersionId) {
        return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileVersionId is no longer supported. Use carrierService.apnProfileId.');
    }
    const roamingProfileId = String(carrierService.roamingProfileId ?? '').trim() || null;
    const rawAllowed = carrierService?.roamingProfile?.allowedMccMnc;
    const allowedNormalize = normalizeCarrierMccMncList(rawAllowed);
    if (!allowedNormalize.ok)
        return allowedNormalize;
    const allowedMccMnc = allowedNormalize.value;
    let resolvedOperatorId = null;
    let resolvedBusinessOperatorId = null;
    if (operatorIdInput) {
        const resolved = await loadOperatorBinding(supabase, supplierId, operatorIdInput);
        if (!resolved.ok)
            return resolved;
        resolvedOperatorId = resolved.value.operatorId;
        resolvedBusinessOperatorId = resolved.value.businessOperatorId;
    }
    let apnFromProfile = null;
    if (apnProfileId) {
        const profileRows = await supabase.select('apn_profiles', `select=apn_profile_id,apn,supplier_id,operator_id,status&apn_profile_id=eq.${encodeURIComponent(apnProfileId)}&limit=1`);
        const profile = Array.isArray(profileRows) ? profileRows[0] : null;
        if (!profile?.apn_profile_id) {
            return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileId is not found.');
        }
        if (supplierId && String(profile?.supplier_id ?? '').trim() !== supplierId) {
            return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileId does not belong to supplierId.');
        }
        if (resolvedOperatorId && String(profile?.operator_id ?? '').trim() !== resolvedOperatorId) {
            return toError(400, 'BAD_REQUEST', 'carrierService.apnProfileId does not match operatorId.');
        }
        apnFromProfile = String(profile?.apn ?? '').trim() || null;
    }
    const apnToValidate = apn || apnFromProfile;
    if (serviceType === 'DATA' && !apnToValidate && !roamingProfileId) {
        return toError(400, 'BAD_REQUEST', 'carrierService.apn or carrierService.apnProfileId or carrierService.roamingProfileId is required for DATA serviceType.');
    }
    if (apn && apnFromProfile && apn !== apnFromProfile) {
        return toError(400, 'BAD_REQUEST', 'carrierService.apn must match carrierService.apnProfileId.');
    }
    if (apnToValidate && supplierId) {
        const filters = [
            `supplier_id=eq.${encodeURIComponent(supplierId)}`,
            `apn=eq.${encodeURIComponent(apnToValidate)}`,
        ];
        if (resolvedOperatorId)
            filters.push(`operator_id=eq.${encodeURIComponent(resolvedOperatorId)}`);
        const rows = await supabase.select('apn_profiles', `select=apn_profile_id,status&${filters.join('&')}&limit=1`);
        const apnProfile = Array.isArray(rows) ? rows[0] : null;
        if (!apnProfile?.apn_profile_id) {
            return toError(400, 'BAD_REQUEST', 'carrierService.apn is not found in supplier capability directory.');
        }
        const status = String(apnProfile?.status ?? '').trim().toUpperCase();
        if (status === 'DEPRECATED') {
            return toError(400, 'BAD_REQUEST', 'carrierService.apn is deprecated for current supplier capability.');
        }
    }
    if (roamingProfileId) {
        const profileRows = await supabase.select('roaming_profiles', `select=roaming_profile_id,supplier_id,operator_id,mccmnc_list,status&roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}&limit=1`);
        const profile = Array.isArray(profileRows) ? profileRows[0] : null;
        if (!profile?.roaming_profile_id) {
            return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId is not found.');
        }
        if (supplierId && String(profile?.supplier_id ?? '').trim() !== supplierId) {
            return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId does not belong to supplierId.');
        }
        if (resolvedOperatorId && String(profile?.operator_id ?? '').trim() !== resolvedOperatorId) {
            return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId does not match operatorId.');
        }
        if (!allowedMccMnc.length) {
            const fromProfile = normalizeCarrierMccMncList(profile?.mccmnc_list);
            if (!fromProfile.ok)
                return fromProfile;
            for (const value of fromProfile.value)
                allowedMccMnc.push(value);
        }
        const roamingStatus = String(profile?.status ?? '').trim().toUpperCase();
        if (roamingStatus === 'DEPRECATED') {
            return toError(400, 'BAD_REQUEST', 'carrierService.roamingProfileId is deprecated for current supplier capability.');
        }
    }
    for (const pattern of allowedMccMnc) {
        const parsed = parseCarrierMccMncPattern(pattern);
        if (!parsed) {
            return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc contains invalid value: ${pattern}`);
        }
        const query = parsed.mnc
            ? `select=operator_id,mcc,mnc&mcc=eq.${encodeURIComponent(parsed.mcc)}&mnc=eq.${encodeURIComponent(parsed.mnc)}`
            : `select=operator_id,mcc,mnc&mcc=eq.${encodeURIComponent(parsed.mcc)}`;
        const rows = await supabase.select('business_operators', query);
        const operators = Array.isArray(rows) ? rows : [];
        if (!operators.length) {
            return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc is unknown: ${pattern}`);
        }
        if (supplierId) {
            let hasCapability = false;
            for (const row of operators) {
                const businessOperatorId = String(row?.operator_id ?? '').trim();
                if (!businessOperatorId)
                    continue;
                if (await hasSupplierCapabilityForBusinessOperator(supabase, supplierId, businessOperatorId)) {
                    hasCapability = true;
                    break;
                }
            }
            if (!hasCapability) {
                return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc is not supported by supplier: ${pattern}`);
            }
        }
        if (resolvedBusinessOperatorId) {
            const matched = operators.some((row) => {
                const businessOperatorId = String(row?.operator_id ?? '').trim();
                return businessOperatorId === resolvedBusinessOperatorId || businessOperatorId === resolvedOperatorId;
            });
            if (!matched) {
                return toError(400, 'BAD_REQUEST', `carrierService.roamingProfile.allowedMccMnc does not match operatorId: ${pattern}`);
            }
        }
    }
    return { ok: true, value: null };
}
const PRICE_PLAN_TYPES_WITH_COVERED_NETWORK = new Set([
    'ONE_TIME',
    'SIM_DEPENDENT_BUNDLE',
    'FIXED_BUNDLE',
    'TIERED_VOLUME_PRICING',
]);
/** All supported price plan types use **CoveredNetworkProfile** for in-profile (MCC,MNC) scope. */
export function pricePlanTypeUsesCoveredNetwork(type) {
    return PRICE_PLAN_TYPES_WITH_COVERED_NETWORK.has(String(type || '').trim());
}
/** `unset` = body omitted key; `null` = JSON null (clear / explicit null). */
function parseCoveredNetworkProfileIdInput(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return 'unset';
    if (!Object.prototype.hasOwnProperty.call(payload, 'coveredNetworkProfileId'))
        return 'unset';
    const v = payload.coveredNetworkProfileId;
    if (v === null || v === undefined || v === '')
        return null;
    return String(v).trim();
}
async function loadEnterpriseParentResellerId(supabase, enterpriseId) {
    const rows = await supabase.select('tenants', `select=parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row)
        return null;
    const parent = String(row?.parent_id ?? '').trim();
    return parent || null;
}
/** Reseller (tenants.tenant_id, RESELLER) must match the ENTERPRISE row's parent_id. */
export async function assertEnterpriseBelongsToReseller(supabase, enterpriseId, resellerId) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.');
    }
    if (!isValidUuid(resellerId)) {
        return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.');
    }
    const rows = await supabase.select('tenants', `select=tenant_id,parent_id,tenant_type&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId is not found.');
    }
    if (String(row.tenant_type ?? '').trim() !== 'ENTERPRISE') {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must reference an ENTERPRISE tenant.');
    }
    const parent = String(row.parent_id ?? '').trim();
    const rid = String(resellerId).trim();
    if (!parent || parent !== rid) {
        return toError(400, 'BAD_REQUEST', 'resellerId does not match the enterprise parent (tenants.parent_id).');
    }
    const rrows = await supabase.select('tenants', `select=tenant_id,tenant_type&tenant_id=eq.${encodeURIComponent(rid)}&limit=1`);
    const r = Array.isArray(rrows) ? rrows[0] : null;
    if (!r || String(r.tenant_type ?? '').trim() !== 'RESELLER') {
        return toError(400, 'BAD_REQUEST', 'resellerId must reference a RESELLER tenant.');
    }
    return { ok: true, value: null };
}
async function assertResellerSupplierBinding(supabase, resellerTenantId, supplierId) {
    const rows = await supabase.select('reseller_suppliers', `select=supplier_id&reseller_id=eq.${encodeURIComponent(resellerTenantId)}&supplier_id=eq.${encodeURIComponent(supplierId)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    return Boolean(row?.supplier_id);
}
/**
 * Validates CoveredNetworkProfile for a price plan row: existence, lifecycle, reseller/supplier scope vs enterprise.
 */
async function validateCoveredNetworkProfileForPricePlan(supabase, enterpriseId, coveredNetworkProfileId, carrierService, options) {
    if (!isValidUuid(coveredNetworkProfileId)) {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.');
    }
    const profileRows = await supabase.select('covered_network_profiles', `select=covered_network_profile_id,supplier_id,reseller_id,operator_id,status&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}&limit=1`);
    const profile = Array.isArray(profileRows) ? profileRows[0] : null;
    if (!profile?.covered_network_profile_id) {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is not found.');
    }
    const status = String(profile.status ?? '').trim().toUpperCase();
    if (status === 'DEPRECATED') {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId references a DEPRECATED profile.');
    }
    if (options.requirePublished) {
        if (status !== 'PUBLISHED') {
            return toError(409, 'INVALID_STATUS', 'coveredNetworkProfileId must reference a PUBLISHED covered network profile.');
        }
    }
    else if (status !== 'DRAFT' && status !== 'PUBLISHED') {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId has an invalid status.');
    }
    const supplierId = String(profile.supplier_id ?? '').trim();
    const profileResellerId = String(profile.reseller_id ?? '').trim() || null;
    const enterpriseResellerId = await loadEnterpriseParentResellerId(supabase, enterpriseId);
    if (profileResellerId) {
        if (!enterpriseResellerId) {
            return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is scoped to a reseller but enterprise has no reseller parent.');
        }
        if (profileResellerId !== enterpriseResellerId) {
            return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is outside enterprise reseller scope.');
        }
    }
    if (enterpriseResellerId) {
        const bound = await assertResellerSupplierBinding(supabase, enterpriseResellerId, supplierId);
        if (!bound) {
            return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId supplier is not linked to the enterprise reseller.');
        }
    }
    const csSupplier = carrierService ? String(carrierService.supplierId ?? '').trim() || null : null;
    if (csSupplier && csSupplier !== supplierId) {
        return toError(400, 'BAD_REQUEST', 'carrierService.supplierId must match coveredNetworkProfile supplier.');
    }
    return { ok: true, value: null };
}
async function resolveCoveredNetworkProfileIdForWrite(supabase, enterpriseId, planType, payload, existingCoveredId, mode, carrierService, lifecycle) {
    const uses = pricePlanTypeUsesCoveredNetwork(planType);
    const raw = parseCoveredNetworkProfileIdInput(payload);
    let next = null;
    if (!uses) {
        if (raw !== 'unset' && raw !== null && String(raw).trim() !== '') {
            return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is not supported for this price plan type.');
        }
        return { ok: true, value: null };
    }
    if (mode === 'create') {
        if (raw === 'unset' || raw === null) {
            return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is required.');
        }
        next = String(raw).trim() || null;
    }
    else {
        if (raw === 'unset') {
            next = existingCoveredId ? String(existingCoveredId).trim() || null : null;
        }
        else if (raw === null) {
            return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId cannot be cleared.');
        }
        else {
            next = String(raw).trim() || null;
        }
    }
    if (!next || !isValidUuid(next)) {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId is required.');
    }
    const v = await validateCoveredNetworkProfileForPricePlan(supabase, enterpriseId, next, carrierService, lifecycle);
    if (!v.ok)
        return v;
    return { ok: true, value: next };
}
function parseUpstreamMessage(error) {
    const body = error?.body;
    if (typeof body === 'string' && body.trim()) {
        try {
            const parsed = JSON.parse(body);
            const message = String(parsed?.message || '').trim();
            if (message)
                return message;
        }
        catch { }
    }
    const message = String(error?.message || '').trim();
    return message && message !== 'UPSTREAM_BAD_RESPONSE' ? message : '';
}
function mapUpstreamFailure(error) {
    const status = Number(error?.status);
    const message = parseUpstreamMessage(error);
    if (status === 400)
        return toError(400, 'BAD_REQUEST', message || 'Request payload is invalid.');
    if (status === 404)
        return toError(404, 'NOT_FOUND', message || 'Related resource not found.');
    if (status === 409)
        return toError(409, 'CONFLICT', message || 'Request conflicts with current resource state.');
    if (status === 429)
        return toError(429, 'UPSTREAM_RATE_LIMITED', message || 'Upstream service rate limited.');
    return toError(502, 'UPSTREAM_ERROR', message || 'Upstream service error.');
}
function validatePayload(payload, options = {}) {
    const requireCommonFields = options.requireCommonFields !== false;
    if (payload?.commercialTerms !== undefined && payload?.commercialTerms !== null) {
        return toError(400, 'BAD_REQUEST', 'commercialTerms must not be set on a price plan; use package commercialTermsId.');
    }
    if (payload?.controlPolicy !== undefined && payload?.controlPolicy !== null) {
        return toError(400, 'BAD_REQUEST', 'controlPolicy must not be set on a price plan; use package controlPolicyId.');
    }
    if (payload?.carrierService !== undefined && payload?.carrierService !== null) {
        return toError(400, 'BAD_REQUEST', 'carrierService must not be set on a price plan; use package carrierServiceId.');
    }
    if (payload?.carrierServiceConfig !== undefined && payload?.carrierServiceConfig !== null) {
        return toError(400, 'BAD_REQUEST', 'carrierServiceConfig must not be set on a price plan; use package carrierServiceId.');
    }
    const paygList = payload?.paygRates;
    if (Array.isArray(paygList) && paygList.length > 0) {
        return toError(400, 'BAD_REQUEST', 'paygRates are not supported on price plans.');
    }
    const name = String(payload?.name || '').trim();
    if (!name)
        return toError(400, 'BAD_REQUEST', 'name is required.');
    const rawType = String(payload?.price_plan_type ?? payload?.type ?? '').trim();
    const type = rawType === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : rawType;
    const allowedTypes = new Set(['ONE_TIME', 'SIM_DEPENDENT_BUNDLE', 'FIXED_BUNDLE', 'TIERED_VOLUME_PRICING']);
    if (!allowedTypes.has(type))
        return toError(400, 'BAD_REQUEST', 'price_plan_type is invalid.');
    const serviceType = String(payload?.serviceType || '').trim();
    if (requireCommonFields && !serviceType)
        return toError(400, 'BAD_REQUEST', 'serviceType is required.');
    if (serviceType && !['DATA', 'VOICE', 'SMS'].includes(serviceType)) {
        return toError(400, 'BAD_REQUEST', 'serviceType is invalid.');
    }
    const currency = String(payload?.currency || '').trim();
    if (requireCommonFields && !currency)
        return toError(400, 'BAD_REQUEST', 'currency is required.');
    const billingCycleType = String(payload?.billingCycleType || '').trim();
    if (requireCommonFields && !billingCycleType)
        return toError(400, 'BAD_REQUEST', 'billingCycleType is required.');
    if (billingCycleType && !['CALENDAR_MONTH', 'CUSTOM_RANGE'].includes(billingCycleType)) {
        return toError(400, 'BAD_REQUEST', 'billingCycleType is invalid.');
    }
    const firstCycleProration = String(payload?.firstCycleProration || '').trim();
    if (requireCommonFields && !firstCycleProration)
        return toError(400, 'BAD_REQUEST', 'firstCycleProration is required.');
    if (firstCycleProration && !['NONE', 'DAILY_PRORATION'].includes(firstCycleProration)) {
        return toError(400, 'BAD_REQUEST', 'firstCycleProration is invalid.');
    }
    const prorationRounding = String(payload?.prorationRounding || '').trim();
    if (requireCommonFields && !prorationRounding)
        return toError(400, 'BAD_REQUEST', 'prorationRounding is required.');
    if (prorationRounding && !['ROUND_HALF_UP'].includes(prorationRounding)) {
        return toError(400, 'BAD_REQUEST', 'prorationRounding is invalid.');
    }
    const monthlyFee = toNumber(payload?.monthlyFee);
    const deactivatedMonthlyFee = toNumber(payload?.deactivatedMonthlyFee);
    const oneTimeFee = toNumber(payload?.oneTimeFee);
    const quotaMb = toInteger(payload?.quotaMb);
    const validityDays = toInteger(payload?.validityDays);
    const perSimQuotaMb = toInteger(payload?.perSimQuotaMb);
    const totalQuotaMb = toInteger(payload?.totalQuotaMb);
    const overageRatePerMb = toNumber(payload?.overageRatePerMb);
    let expiryBoundary = null;
    if (type === 'ONE_TIME') {
        if (oneTimeFee === null || oneTimeFee < 0)
            return toError(400, 'BAD_REQUEST', 'oneTimeFee must be >= 0.');
        if (quotaMb === null || quotaMb < 0)
            return toError(400, 'BAD_REQUEST', 'quotaMb must be >= 0.');
        if (validityDays === null || validityDays < 1)
            return toError(400, 'BAD_REQUEST', 'validityDays must be > 0.');
        const boundary = String(payload?.expiryBoundary || '').trim();
        if (!['CALENDAR_DAY_END', 'DURATION_EXCLUSIVE_END'].includes(boundary)) {
            return toError(400, 'BAD_REQUEST', 'expiryBoundary is required for ONE_TIME.');
        }
        expiryBoundary = boundary;
    }
    if (type !== 'ONE_TIME') {
        if (monthlyFee === null || monthlyFee < 0)
            return toError(400, 'BAD_REQUEST', 'monthlyFee must be >= 0.');
        if (deactivatedMonthlyFee === null || deactivatedMonthlyFee < 0) {
            return toError(400, 'BAD_REQUEST', 'deactivatedMonthlyFee must be >= 0.');
        }
        const bothFeesZero = monthlyFee === 0 && deactivatedMonthlyFee === 0;
        if (monthlyFee !== null && deactivatedMonthlyFee !== null && deactivatedMonthlyFee >= monthlyFee && !bothFeesZero) {
            return toError(400, 'BAD_REQUEST', 'deactivatedMonthlyFee must be < monthlyFee.');
        }
    }
    if (type === 'SIM_DEPENDENT_BUNDLE') {
        if (perSimQuotaMb === null || perSimQuotaMb < 0) {
            return toError(400, 'BAD_REQUEST', 'perSimQuotaMb must be >= 0.');
        }
    }
    if (type === 'FIXED_BUNDLE') {
        if (totalQuotaMb === null || totalQuotaMb < 0) {
            return toError(400, 'BAD_REQUEST', 'totalQuotaMb must be >= 0.');
        }
    }
    if (type === 'TIERED_VOLUME_PRICING') {
        const tiers = Array.isArray(payload?.tiers) ? payload.tiers : [];
        if (!tiers.length)
            return toError(400, 'BAD_REQUEST', 'tiers must be provided.');
        let prevFromMb = null;
        let prevToMb = null;
        for (const tier of tiers) {
            const fromMb = toInteger(tier.fromMb);
            const toMb = toInteger(tier.toMb);
            const ratePerMb = toNumber(tier.ratePerMb);
            if (fromMb === null || fromMb < 0 || toMb === null || toMb <= fromMb || ratePerMb === null || ratePerMb < 0) {
                return toError(400, 'BAD_REQUEST', 'tiers must include fromMb < toMb and ratePerMb >= 0.');
            }
            if (prevFromMb !== null && fromMb <= prevFromMb) {
                return toError(400, 'BAD_REQUEST', 'tiers must be sorted by fromMb in ascending order.');
            }
            if (prevToMb !== null && fromMb !== prevToMb) {
                return toError(400, 'BAD_REQUEST', 'tiers must be continuous: next fromMb must equal previous toMb.');
            }
            prevFromMb = fromMb;
            prevToMb = toMb;
        }
    }
    if (overageRatePerMb !== null && overageRatePerMb < 0) {
        return toError(400, 'BAD_REQUEST', 'overageRatePerMb must be >= 0.');
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
            prorationRounding: prorationRounding || 'ROUND_HALF_UP',
            expiryBoundary,
            monthlyFee,
            deactivatedMonthlyFee,
            oneTimeFee,
            quotaMb,
            validityDays,
            perSimQuotaMb,
            totalQuotaMb,
            overageRatePerMb,
            tiers: Array.isArray(payload?.tiers) ? payload.tiers : null,
        },
    };
}
export async function loadPricePlan(supabase, pricePlanId) {
    const rows = await supabase.select('price_plans', `select=${PRICE_PLAN_PARENT_SELECT}&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`);
    const parent = Array.isArray(rows) ? rows[0] : null;
    if (!parent)
        return null;
    const pType = String(parent.type ?? '').trim();
    const child = await selectChildRowForPlan(supabase, pType, pricePlanId);
    return mergeChildIntoParentRow(parent, child, pType);
}
async function listLatestReferencingPackageIds(supabase, pricePlanId) {
    const rows = await supabase.select('packages', `select=package_id&price_plan_id=eq.${encodeURIComponent(pricePlanId)}`);
    const list = Array.isArray(rows) ? rows : [];
    return Array.from(new Set(list.map((row) => String(row?.package_id ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}
const PRICE_PLAN_PARENT_SELECT = 'price_plan_id,enterprise_id,reseller_id,name,type,service_type,currency,billing_cycle_type,first_cycle_proration,source_price_plan_id,version,status,effective_from,deprecated_at,proration_rounding,covered_network_profile_id,created_at';
function mergeChildIntoParentRow(parent, child, planType) {
    const out = { ...parent };
    const t = String(planType || '').trim();
    if (!child)
        return out;
    if (t === 'FIXED_BUNDLE') {
        out.monthly_fee = child.monthly_fee;
        out.deactivated_monthly_fee = child.deactivated_monthly_fee;
        out.total_quota_mb = child.total_quota_mb;
        out.overage_rate_per_mb = child.overage_rate_per_mb;
    }
    else if (t === 'SIM_DEPENDENT_BUNDLE') {
        out.monthly_fee = child.monthly_fee;
        out.deactivated_monthly_fee = child.deactivated_monthly_fee;
        out.per_sim_quota_mb = child.per_sim_quota_mb;
        out.overage_rate_per_mb = child.overage_rate_per_mb;
    }
    else if (t === 'ONE_TIME') {
        out.one_time_fee = child.one_time_fee;
        out.quota_mb = child.quota_mb;
        out.validity_days = child.validity_days;
        out.expiry_boundary = child.expiry_boundary;
    }
    else if (t === 'TIERED_VOLUME_PRICING') {
        out.monthly_fee = child.monthly_fee;
        out.deactivated_monthly_fee = child.deactivated_monthly_fee;
        out.tiers = child.tiers;
        out.overage_rate_per_mb = child.overage_rate_per_mb;
    }
    return out;
}
async function selectChildRowForPlan(supabase, planType, pricePlanId) {
    const t = String(planType || '').trim();
    const q = `select=*&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`;
    if (t === 'FIXED_BUNDLE') {
        const r = await supabase.select('price_plan_fixed_bundle', q);
        return Array.isArray(r) ? r[0] : null;
    }
    if (t === 'SIM_DEPENDENT_BUNDLE') {
        const r = await supabase.select('price_plan_sim_dependent_bundle', q);
        return Array.isArray(r) ? r[0] : null;
    }
    if (t === 'ONE_TIME') {
        const r = await supabase.select('price_plan_one_time', q);
        return Array.isArray(r) ? r[0] : null;
    }
    if (t === 'TIERED_VOLUME_PRICING') {
        const r = await supabase.select('price_plan_tiered_volume_pricing', q);
        return Array.isArray(r) ? r[0] : null;
    }
    return null;
}
async function fetchChildMapsForPlanIds(supabase, ids) {
    const empty = {
        fb: new Map(),
        sdb: new Map(),
        ot: new Map(),
        tv: new Map(),
    };
    if (!ids.length)
        return empty;
    const inList = ids.map((id) => encodeURIComponent(id)).join(',');
    const q = `select=*&price_plan_id=in.(${inList})`;
    const [fbRows, sdbRows, otRows, tvRows] = await Promise.all([
        supabase.select('price_plan_fixed_bundle', q),
        supabase.select('price_plan_sim_dependent_bundle', q),
        supabase.select('price_plan_one_time', q),
        supabase.select('price_plan_tiered_volume_pricing', q),
    ]);
    const toMap = (rows) => new Map((Array.isArray(rows) ? rows : [])
        .map((r) => [String(r?.price_plan_id ?? ''), r])
        .filter((e) => Boolean(e[0])));
    return { fb: toMap(fbRows), sdb: toMap(sdbRows), ot: toMap(otRows), tv: toMap(tvRows) };
}
function mergeListRow(parent, maps) {
    const t = String(parent?.type ?? '').trim();
    const pid = String(parent?.price_plan_id ?? '');
    const child = t === 'FIXED_BUNDLE'
        ? maps.fb.get(pid)
        : t === 'SIM_DEPENDENT_BUNDLE'
            ? maps.sdb.get(pid)
            : t === 'ONE_TIME'
                ? maps.ot.get(pid)
                : t === 'TIERED_VOLUME_PRICING'
                    ? maps.tv.get(pid)
                    : null;
    return mergeChildIntoParentRow(parent, child, t);
}
async function insertPricingExtensionRow(supabase, pricePlanId, planType, v) {
    const t = String(planType || '').trim();
    if (t === 'FIXED_BUNDLE') {
        await supabase.insert('price_plan_fixed_bundle', {
            price_plan_id: pricePlanId,
            monthly_fee: v.monthlyFee ?? 0,
            deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
            total_quota_mb: v.totalQuotaMb,
            overage_rate_per_mb: v.overageRatePerMb,
        }, { returning: 'minimal' });
    }
    else if (t === 'SIM_DEPENDENT_BUNDLE') {
        await supabase.insert('price_plan_sim_dependent_bundle', {
            price_plan_id: pricePlanId,
            monthly_fee: v.monthlyFee ?? 0,
            deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
            per_sim_quota_mb: v.perSimQuotaMb,
            overage_rate_per_mb: v.overageRatePerMb,
        }, { returning: 'minimal' });
    }
    else if (t === 'ONE_TIME') {
        await supabase.insert('price_plan_one_time', {
            price_plan_id: pricePlanId,
            one_time_fee: v.oneTimeFee ?? 0,
            quota_mb: v.quotaMb ?? 0,
            validity_days: v.validityDays ?? 1,
            expiry_boundary: v.expiryBoundary ?? 'CALENDAR_DAY_END',
        }, { returning: 'minimal' });
    }
    else if (t === 'TIERED_VOLUME_PRICING') {
        await supabase.insert('price_plan_tiered_volume_pricing', {
            price_plan_id: pricePlanId,
            monthly_fee: v.monthlyFee ?? 0,
            deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
            tiers: v.tiers ?? [],
            overage_rate_per_mb: v.overageRatePerMb,
        }, { returning: 'minimal' });
    }
}
async function updatePricingExtensionRow(supabase, pricePlanId, planType, v) {
    const enc = encodeURIComponent(pricePlanId);
    const t = String(planType || '').trim();
    if (t === 'FIXED_BUNDLE') {
        await supabase.update('price_plan_fixed_bundle', `price_plan_id=eq.${enc}`, {
            monthly_fee: v.monthlyFee ?? 0,
            deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
            total_quota_mb: v.totalQuotaMb,
            overage_rate_per_mb: v.overageRatePerMb,
        }, { returning: 'minimal' });
    }
    else if (t === 'SIM_DEPENDENT_BUNDLE') {
        await supabase.update('price_plan_sim_dependent_bundle', `price_plan_id=eq.${enc}`, {
            monthly_fee: v.monthlyFee ?? 0,
            deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
            per_sim_quota_mb: v.perSimQuotaMb,
            overage_rate_per_mb: v.overageRatePerMb,
        }, { returning: 'minimal' });
    }
    else if (t === 'ONE_TIME') {
        await supabase.update('price_plan_one_time', `price_plan_id=eq.${enc}`, {
            one_time_fee: v.oneTimeFee ?? 0,
            quota_mb: v.quotaMb ?? 0,
            validity_days: v.validityDays ?? 1,
            expiry_boundary: v.expiryBoundary ?? 'CALENDAR_DAY_END',
        }, { returning: 'minimal' });
    }
    else if (t === 'TIERED_VOLUME_PRICING') {
        await supabase.update('price_plan_tiered_volume_pricing', `price_plan_id=eq.${enc}`, {
            monthly_fee: v.monthlyFee ?? 0,
            deactivated_monthly_fee: v.deactivatedMonthlyFee ?? 0,
            tiers: v.tiers ?? [],
            overage_rate_per_mb: v.overageRatePerMb,
        }, { returning: 'minimal' });
    }
}
/**
 * Public snapshot — discriminated by `type` (aligned with Create request shapes).
 * `price_plan_type` mirrors API discriminator (TIERED_PRICING alias for TIERED_VOLUME_PRICING).
 */
function mapPricePlanApiRow(version) {
    if (!version)
        return null;
    const status = resolveVersionStatus(version);
    const internalType = String(version.type ?? '').trim();
    const apiPlanType = internalType === 'TIERED_VOLUME_PRICING' ? 'TIERED_PRICING' : internalType;
    const common = {
        pricePlanId: version.price_plan_id,
        enterpriseId: version.enterprise_id ?? null,
        resellerId: version.reseller_id ?? null,
        sourcePricePlanId: version.source_price_plan_id ?? null,
        name: version.name ?? null,
        type: internalType,
        price_plan_type: apiPlanType,
        serviceType: version.service_type ?? null,
        currency: version.currency ?? null,
        status,
        createdAt: version.created_at ?? null,
        effectiveFrom: version.effective_from,
        deprecatedAt: version.deprecated_at ?? null,
        billingCycleType: version.billing_cycle_type ?? null,
        firstCycleProration: version.first_cycle_proration ?? null,
        prorationRounding: version.proration_rounding ?? null,
        coveredNetworkProfileId: version.covered_network_profile_id ?? null,
    };
    if (internalType === 'ONE_TIME') {
        return {
            ...common,
            oneTimeFee: version.one_time_fee,
            quotaMb: version.quota_mb,
            validityDays: version.validity_days,
            expiryBoundary: version.expiry_boundary ?? null,
        };
    }
    if (internalType === 'SIM_DEPENDENT_BUNDLE') {
        return {
            ...common,
            monthlyFee: version.monthly_fee,
            deactivatedMonthlyFee: version.deactivated_monthly_fee,
            perSimQuotaMb: version.per_sim_quota_mb,
            overageRatePerMb: version.overage_rate_per_mb,
        };
    }
    if (internalType === 'FIXED_BUNDLE') {
        return {
            ...common,
            monthlyFee: version.monthly_fee,
            deactivatedMonthlyFee: version.deactivated_monthly_fee,
            totalQuotaMb: version.total_quota_mb,
            overageRatePerMb: version.overage_rate_per_mb,
        };
    }
    if (internalType === 'TIERED_VOLUME_PRICING') {
        return {
            ...common,
            monthlyFee: version.monthly_fee,
            deactivatedMonthlyFee: version.deactivated_monthly_fee,
            tiers: version.tiers ?? null,
            overageRatePerMb: version.overage_rate_per_mb,
        };
    }
    return {
        ...common,
        monthlyFee: version.monthly_fee,
        deactivatedMonthlyFee: version.deactivated_monthly_fee,
        oneTimeFee: version.one_time_fee,
        quotaMb: version.quota_mb,
        validityDays: version.validity_days,
        perSimQuotaMb: version.per_sim_quota_mb,
        totalQuotaMb: version.total_quota_mb,
        overageRatePerMb: version.overage_rate_per_mb,
        tiers: version.tiers ?? null,
        expiryBoundary: version.expiry_boundary ?? null,
    };
}
export async function createPricePlan({ supabase, enterpriseId, resellerId, payload, audit, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.');
    }
    const scope = await assertEnterpriseBelongsToReseller(supabase, enterpriseId, resellerId);
    if (!scope.ok)
        return scope;
    const validated = validatePayload(payload, { requireCommonFields: true });
    if (!validated.ok)
        return validated;
    const { name, type, serviceType, currency, billingCycleType, firstCycleProration, prorationRounding, expiryBoundary, monthlyFee, deactivatedMonthlyFee, oneTimeFee, quotaMb, validityDays, perSimQuotaMb, totalQuotaMb, overageRatePerMb, tiers, } = validated.value;
    const coveredResolved = await resolveCoveredNetworkProfileIdForWrite(supabase, enterpriseId, type, payload, null, 'create', null, { requirePublished: true });
    if (!coveredResolved.ok)
        return coveredResolved;
    try {
        const created = await supabase.insert('price_plans', {
            enterprise_id: enterpriseId,
            reseller_id: resellerId,
            name,
            type,
            service_type: serviceType,
            currency,
            billing_cycle_type: billingCycleType,
            first_cycle_proration: firstCycleProration,
            source_price_plan_id: null,
            version: 1,
            status: 'DRAFT',
            effective_from: null,
            proration_rounding: prorationRounding,
            covered_network_profile_id: coveredResolved.value,
        }, { returning: 'representation' });
        const plan = Array.isArray(created) ? created[0] : null;
        if (!plan?.price_plan_id) {
            return toError(500, 'INTERNAL_ERROR', 'Failed to create price plan.');
        }
        await insertPricingExtensionRow(supabase, String(plan.price_plan_id), type, {
            monthlyFee,
            deactivatedMonthlyFee,
            oneTimeFee,
            quotaMb,
            validityDays,
            perSimQuotaMb,
            totalQuotaMb,
            overageRatePerMb,
            tiers,
            expiryBoundary,
        });
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
                },
            });
        }
        return {
            ok: true,
            value: {
                pricePlanId: plan.price_plan_id,
                status: 'DRAFT',
                createdAt: plan.created_at,
            },
        };
    }
    catch (error) {
        return mapUpstreamFailure(error);
    }
}
export async function listPricePlans({ supabase, enterpriseId, resellerId, type, status, page, pageSize, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId is required and must be a valid uuid.');
    }
    const listScope = await assertEnterpriseBelongsToReseller(supabase, enterpriseId, resellerId);
    if (!listScope.ok)
        return listScope;
    const statusFilter = status ? String(status).trim().toUpperCase() : null;
    if (statusFilter &&
        statusFilter !== 'DRAFT' &&
        statusFilter !== 'PUBLISHED' &&
        statusFilter !== 'DEPRECATED') {
        return toError(400, 'BAD_REQUEST', 'status must be one of DRAFT, PUBLISHED, DEPRECATED.');
    }
    const typeFilterRaw = type ? String(type).trim().toUpperCase() : null;
    const typeFilter = typeFilterRaw === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : typeFilterRaw;
    const allowedListTypes = new Set([
        'ONE_TIME',
        'SIM_DEPENDENT_BUNDLE',
        'FIXED_BUNDLE',
        'TIERED_VOLUME_PRICING',
    ]);
    if (typeFilter && !allowedListTypes.has(typeFilter)) {
        return toError(400, 'BAD_REQUEST', 'type must be one of ONE_TIME, SIM_DEPENDENT_BUNDLE, FIXED_BUNDLE, TIERED_PRICING (or TIERED_VOLUME_PRICING).');
    }
    const planRows = await supabase.select('price_plans', `select=${PRICE_PLAN_PARENT_SELECT}&enterprise_id=eq.${encodeURIComponent(enterpriseId)}&reseller_id=eq.${encodeURIComponent(resellerId)}${typeFilter ? `&type=eq.${encodeURIComponent(typeFilter)}` : ''}${statusFilter ? `&status=eq.${encodeURIComponent(statusFilter)}` : ''}&order=created_at.desc`);
    const plans = Array.isArray(planRows) ? planRows : [];
    const ids = plans.map((p) => String(p?.price_plan_id ?? '')).filter(Boolean);
    const maps = await fetchChildMapsForPlanIds(supabase, ids);
    let items = plans
        .map((plan) => mapPricePlanApiRow(mergeListRow(plan, maps)))
        .filter(Boolean);
    const p = Number(page) || 1;
    const ps = Number(pageSize) || 20;
    const start = (p - 1) * ps;
    const total = items.length;
    items = items.slice(start, start + ps);
    return { ok: true, value: { items, total } };
}
export async function getPricePlanDetail({ supabase, pricePlanId }) {
    if (!isValidUuid(pricePlanId)) {
        return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.');
    }
    const plan = await loadPricePlan(supabase, pricePlanId);
    if (!plan)
        return toError(404, 'NOT_FOUND', 'Price plan not found.');
    return {
        ok: true,
        value: mapPricePlanApiRow(plan),
    };
}
/**
 * Batch-resolve {@link mapPricePlanApiRow} snapshots for many `price_plan_id` (parent + 1:1 child rows).
 * Used by package list to embed `PricePlanSnapshot` without N+1 round-trips.
 */
export async function batchMapPricePlanSnapshotsByIds(supabase, pricePlanIds) {
    const out = new Map();
    const unique = [...new Set(pricePlanIds.map((x) => String(x).trim()).filter(Boolean))];
    for (const id of unique)
        out.set(id, null);
    if (!unique.length)
        return out;
    const inList = unique.map((id) => encodeURIComponent(id)).join(',');
    const planRows = await supabase.select('price_plans', `select=${PRICE_PLAN_PARENT_SELECT}&price_plan_id=in.(${inList})`);
    const plans = Array.isArray(planRows) ? planRows : [];
    const maps = await fetchChildMapsForPlanIds(supabase, unique);
    for (const p of plans) {
        const pid = p?.price_plan_id != null ? String(p.price_plan_id).trim() : '';
        if (!pid)
            continue;
        const merged = mergeListRow(p, maps);
        out.set(pid, mapPricePlanApiRow(merged));
    }
    return out;
}
export async function updatePricePlan({ supabase, pricePlanId, payload, audit, }) {
    if (!isValidUuid(pricePlanId)) {
        return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.');
    }
    const plan = await loadPricePlan(supabase, pricePlanId);
    if (!plan)
        return toError(404, 'NOT_FOUND', 'Price plan not found.');
    if (resolveVersionStatus(plan) !== 'DRAFT') {
        return toError(409, 'INVALID_STATUS', 'Only DRAFT price plans can be updated.');
    }
    const payloadTypeRaw = String(payload?.price_plan_type ?? payload?.type ?? '').trim();
    if (payloadTypeRaw) {
        const payloadType = payloadTypeRaw === 'TIERED_PRICING' ? 'TIERED_VOLUME_PRICING' : payloadTypeRaw;
        const planType = String(plan.type ?? '').trim();
        if (payloadType !== planType) {
            return toError(400, 'BAD_REQUEST', 'price_plan_type must match the existing price plan type.');
        }
    }
    const validated = validatePayload({
        ...payload,
        name: String(payload?.name ?? '').trim() || plan.name,
        type: plan.type,
        serviceType: plan.service_type,
        currency: plan.currency,
        billingCycleType: plan.billing_cycle_type,
        firstCycleProration: plan.first_cycle_proration,
        prorationRounding: payload?.prorationRounding ?? plan.proration_rounding ?? 'ROUND_HALF_UP',
        expiryBoundary: payload?.expiryBoundary ?? plan.expiry_boundary,
    }, { requireCommonFields: false });
    if (!validated.ok)
        return validated;
    const { name: nextName, monthlyFee, deactivatedMonthlyFee, oneTimeFee, quotaMb, validityDays, perSimQuotaMb, totalQuotaMb, overageRatePerMb, tiers, prorationRounding: nextProrationRounding, expiryBoundary: nextExpiryBoundary, } = validated.value;
    const coveredResolved = await resolveCoveredNetworkProfileIdForWrite(supabase, String(plan.enterprise_id ?? ''), String(plan.type ?? ''), payload, plan.covered_network_profile_id ?? null, 'update', null, { requirePublished: true });
    if (!coveredResolved.ok)
        return coveredResolved;
    try {
        const rows = await supabase.update('price_plans', `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`, {
            name: nextName,
            proration_rounding: nextProrationRounding,
            covered_network_profile_id: coveredResolved.value,
        }, { returning: 'representation' });
        const version = Array.isArray(rows) ? rows[0] : null;
        if (!version?.price_plan_id) {
            return toError(500, 'INTERNAL_ERROR', 'Failed to update price plan.');
        }
        await updatePricingExtensionRow(supabase, pricePlanId, String(plan.type ?? ''), {
            monthlyFee,
            deactivatedMonthlyFee,
            oneTimeFee,
            quotaMb,
            validityDays,
            perSimQuotaMb,
            totalQuotaMb,
            overageRatePerMb,
            tiers,
            expiryBoundary: nextExpiryBoundary,
        });
        await writeAuditLog(supabase, {
            actor_user_id: audit?.actorUserId ?? null,
            actor_role: audit?.actorRole ?? null,
            tenant_id: plan.enterprise_id ?? null,
            action: 'PRICE_PLAN_UPDATED',
            target_type: 'PRICE_PLAN',
            target_id: pricePlanId,
            request_id: audit?.requestId ?? null,
            source_ip: audit?.sourceIp ?? null,
            after_data: { pricePlanId },
        });
        const merged = await loadPricePlan(supabase, pricePlanId);
        if (!merged)
            return toError(500, 'INTERNAL_ERROR', 'Failed to load price plan after update.');
        return { ok: true, value: mapPricePlanApiRow(merged) };
    }
    catch (error) {
        return mapUpstreamFailure(error);
    }
}
export async function publishPricePlan({ supabase, pricePlanId, audit, }) {
    if (!isValidUuid(pricePlanId)) {
        return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.');
    }
    const plan = await loadPricePlan(supabase, pricePlanId);
    if (!plan)
        return toError(404, 'NOT_FOUND', 'Price plan not found.');
    if (resolveVersionStatus(plan) !== 'DRAFT') {
        return toError(409, 'INVALID_STATUS', 'Only DRAFT price plans can be published.');
    }
    const planType = String(plan.type ?? '').trim();
    const enterpriseId = String(plan.enterprise_id ?? '').trim();
    const coveredId = String(plan.covered_network_profile_id ?? '').trim() || null;
    if (pricePlanTypeUsesCoveredNetwork(planType)) {
        if (!coveredId) {
            return toError(409, 'INVALID_STATUS', 'coveredNetworkProfileId must be set before publishing the price plan.');
        }
        const coveredCheck = await validateCoveredNetworkProfileForPricePlan(supabase, enterpriseId, coveredId, null, { requirePublished: true });
        if (!coveredCheck.ok)
            return coveredCheck;
    }
    const nowIso = new Date().toISOString();
    try {
        const rows = await supabase.update('price_plans', `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`, { effective_from: nowIso, status: 'PUBLISHED' }, { returning: 'representation' });
        const version = Array.isArray(rows) ? rows[0] : null;
        if (!version?.price_plan_id) {
            return toError(500, 'INTERNAL_ERROR', 'Failed to publish price plan.');
        }
        await writeAuditLog(supabase, {
            actor_user_id: audit?.actorUserId ?? null,
            actor_role: audit?.actorRole ?? null,
            tenant_id: plan.enterprise_id ?? null,
            action: 'PRICE_PLAN_PUBLISHED',
            target_type: 'PRICE_PLAN',
            target_id: pricePlanId,
            request_id: audit?.requestId ?? null,
            source_ip: audit?.sourceIp ?? null,
            after_data: { pricePlanId, effectiveFrom: nowIso },
        });
        const merged = await loadPricePlan(supabase, pricePlanId);
        if (!merged)
            return toError(500, 'INTERNAL_ERROR', 'Failed to load price plan after publish.');
        return { ok: true, value: mapPricePlanApiRow(merged) };
    }
    catch (error) {
        return mapUpstreamFailure(error);
    }
}
export async function deprecatePricePlan({ supabase, pricePlanId, audit, }) {
    if (!isValidUuid(pricePlanId)) {
        return toError(400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.');
    }
    const plan = await loadPricePlan(supabase, pricePlanId);
    if (!plan)
        return toError(404, 'NOT_FOUND', 'Price plan not found.');
    if (resolveVersionStatus(plan) !== 'PUBLISHED') {
        return toError(409, 'INVALID_STATUS', 'Only PUBLISHED price plans can be deprecated.');
    }
    const referencingPackageIds = await listLatestReferencingPackageIds(supabase, pricePlanId);
    if (referencingPackageIds.length) {
        return toError(409, 'RESOURCE_IN_USE', `Price plan is referenced by packageId(s): ${referencingPackageIds.join(', ')}.`);
    }
    const nowIso = new Date().toISOString();
    try {
        const rows = await supabase.update('price_plans', `price_plan_id=eq.${encodeURIComponent(pricePlanId)}`, { deprecated_at: nowIso, status: 'DEPRECATED' }, { returning: 'representation' });
        const version = Array.isArray(rows) ? rows[0] : null;
        if (!version?.price_plan_id) {
            return toError(500, 'INTERNAL_ERROR', 'Failed to deprecate price plan.');
        }
        await writeAuditLog(supabase, {
            actor_user_id: audit?.actorUserId ?? null,
            actor_role: audit?.actorRole ?? null,
            tenant_id: plan.enterprise_id ?? null,
            action: 'PRICE_PLAN_DEPRECATED',
            target_type: 'PRICE_PLAN',
            target_id: pricePlanId,
            request_id: audit?.requestId ?? null,
            source_ip: audit?.sourceIp ?? null,
            after_data: { pricePlanId, deprecatedAt: nowIso },
        });
        const merged = await loadPricePlan(supabase, pricePlanId);
        if (!merged)
            return toError(500, 'INTERNAL_ERROR', 'Failed to load price plan after deprecate.');
        return { ok: true, value: mapPricePlanApiRow(merged) };
    }
    catch (error) {
        return mapUpstreamFailure(error);
    }
}
