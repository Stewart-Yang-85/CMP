import { actorUserIdForDb } from '../utils/actorUserId.js';
import { buildPaginationResponse, parsePagination } from '../utils/pagination.js';
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
function carrierModuleApnProfileId(mod) {
    if (mod?.apn_profile_id != null && String(mod.apn_profile_id).trim() !== '') {
        return String(mod.apn_profile_id).trim();
    }
    return '';
}
function carrierModuleRoamingProfileId(mod) {
    if (mod?.roaming_profile_id != null && String(mod.roaming_profile_id).trim() !== '') {
        return String(mod.roaming_profile_id).trim();
    }
    return '';
}
/** In-memory scan: Carrier Service rows + `packages` referencing an APN snapshot. */
async function collectApnProfileUsage(supabase, apnProfileId) {
    const csRows = (await supabase.select('carrier_service_modules', 'select=carrier_service_id,apn_profile_id,roaming_profile_id,status'));
    const carrierServiceIds = [];
    const csList = Array.isArray(csRows) ? csRows : [];
    for (const r of csList) {
        const st = String(r?.status ?? '').toUpperCase();
        if (st === 'DEPRECATED')
            continue;
        const id = carrierModuleApnProfileId(r);
        if (id === apnProfileId)
            carrierServiceIds.push(String(r.carrier_service_id));
    }
    const carrierSet = new Set(carrierServiceIds);
    const pvRows = (await supabase.select('packages', 'select=package_id,carrier_service_id'));
    const packageIdSet = new Set();
    const pvList = Array.isArray(pvRows) ? pvRows : [];
    for (const pv of pvList) {
        const pkgId = String(pv?.package_id ?? '').trim();
        if (!pkgId)
            continue;
        const cid = String(pv?.carrier_service_id ?? '').trim();
        if (cid && carrierSet.has(cid))
            packageIdSet.add(pkgId);
        if (cid) {
            const mod = csList.find((c) => String(c.carrier_service_id) === cid);
            if (mod) {
                const st = String(mod?.status ?? '').toUpperCase();
                if (st !== 'DEPRECATED') {
                    const id2 = carrierModuleApnProfileId(mod);
                    if (id2 === apnProfileId)
                        packageIdSet.add(pkgId);
                }
            }
        }
    }
    return { carrierServiceIds, packageIds: [...packageIdSet] };
}
/**
 * In-memory scan: `carrier_service_modules` + `packages` only (Phase 30 OOP: Carrier `roamingProfileId`
 * and package snapshot / `carrier_service_id` link). Roaming deprecate does not consult `price_plans`.
 */
async function collectRoamingProfileUsage(supabase, roamingProfileId) {
    const csRows = (await supabase.select('carrier_service_modules', 'select=carrier_service_id,apn_profile_id,roaming_profile_id,status'));
    const carrierServiceIds = [];
    const csList = Array.isArray(csRows) ? csRows : [];
    for (const r of csList) {
        const st = String(r?.status ?? '').toUpperCase();
        if (st === 'DEPRECATED')
            continue;
        const id = carrierModuleRoamingProfileId(r);
        if (id === roamingProfileId)
            carrierServiceIds.push(String(r.carrier_service_id));
    }
    const carrierSet = new Set(carrierServiceIds);
    const pvRows = (await supabase.select('packages', 'select=package_id,carrier_service_id'));
    const packageIdSet = new Set();
    const pvList = Array.isArray(pvRows) ? pvRows : [];
    for (const pv of pvList) {
        const pkgId = String(pv?.package_id ?? '').trim();
        if (!pkgId)
            continue;
        const cid = String(pv?.carrier_service_id ?? '').trim();
        if (cid && carrierSet.has(cid))
            packageIdSet.add(pkgId);
        if (cid) {
            const mod = csList.find((c) => String(c.carrier_service_id) === cid);
            if (mod) {
                const st = String(mod?.status ?? '').toUpperCase();
                if (st !== 'DEPRECATED') {
                    const id2 = carrierModuleRoamingProfileId(mod);
                    if (id2 === roamingProfileId)
                        packageIdSet.add(pkgId);
                }
            }
        }
    }
    return { carrierServiceIds, packageIds: [...packageIdSet] };
}
function firstDayNextMonthUtc() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0));
}
function normalizeMccMnc(value) {
    const raw = String(value || '').trim();
    if (!raw)
        return null;
    if (/^\d{3}-\*$/.test(raw))
        return raw;
    const exact = raw.match(/^(\d{3})-?(\d{2,3})$/);
    if (!exact)
        return null;
    return `${exact[1]}-${exact[2]}`;
}
function normalizeRoamingEntry(raw) {
    if (!raw || typeof raw !== 'object')
        return { ok: false, message: 'mccmncList entry must be an object.' };
    const mcc = String(raw.mcc ?? '').trim();
    const mnc = String(raw.mnc ?? '').trim();
    const rateInput = raw.ratePerMb;
    const normalized = normalizeMccMnc(`${mcc}-${mnc}`);
    if (!normalized)
        return { ok: false, message: `Invalid mcc/mnc value: ${mcc}-${mnc}` };
    if (rateInput === undefined || rateInput === null || String(rateInput).trim() === '') {
        return { ok: false, message: `ratePerMb is required for ${mcc}-${mnc}` };
    }
    const rateValue = Number(rateInput);
    if (!Number.isFinite(rateValue) || rateValue < 0) {
        return { ok: false, message: `ratePerMb must be a non-negative number for ${mcc}-${mnc}` };
    }
    const [normalizedMcc, normalizedMnc] = normalized.split('-');
    return { ok: true, value: { mcc: normalizedMcc, mnc: normalizedMnc, ratePerMb: rateValue } };
}
function normalizeRoamingEntryList(list) {
    const entries = Array.isArray(list) ? list : [];
    const normalized = [];
    for (const raw of entries) {
        const parsed = normalizeRoamingEntry(raw);
        if (!parsed.ok)
            return parsed;
        normalized.push(parsed.value);
    }
    return { ok: true, value: normalized };
}
function normalizeCoveredEntry(raw) {
    if (!raw || typeof raw !== 'object')
        return { ok: false, message: 'coverage entry must be an object.' };
    const mcc = String(raw.mcc ?? '').trim();
    const mnc = String(raw.mnc ?? '').trim();
    const normalized = normalizeMccMnc(`${mcc}-${mnc}`);
    if (!normalized)
        return { ok: false, message: `Invalid mcc/mnc value: ${mcc}-${mnc}` };
    const [normalizedMcc, normalizedMnc] = normalized.split('-');
    return { ok: true, value: { mcc: normalizedMcc, mnc: normalizedMnc } };
}
function validateCoveredCoverageList(list) {
    const entries = Array.isArray(list) ? list : [];
    if (!entries.length)
        return { ok: false, message: 'coverage is required.' };
    const normalized = [];
    const seen = new Set();
    const mccStarCount = new Map();
    for (const raw of entries) {
        const parsed = normalizeCoveredEntry(raw);
        if (!parsed.ok)
            return parsed;
        const key = `${parsed.value.mcc}\0${parsed.value.mnc}`;
        if (seen.has(key)) {
            return { ok: false, message: `Duplicate mcc/mnc combination: ${parsed.value.mcc}-${parsed.value.mnc}` };
        }
        seen.add(key);
        if (parsed.value.mnc === '*') {
            const c = (mccStarCount.get(parsed.value.mcc) ?? 0) + 1;
            mccStarCount.set(parsed.value.mcc, c);
            if (c > 1)
                return { ok: false, message: `Duplicate mcc-* wildcard for mcc ${parsed.value.mcc}` };
        }
        normalized.push(parsed.value);
    }
    return { ok: true, value: normalized };
}
function normalizeCoverageMode(raw) {
    const value = String(raw ?? 'LIST').trim().toUpperCase();
    return value === 'NONE' ? 'NONE' : 'LIST';
}
function validateCoverageForMode(mode, list) {
    const entries = Array.isArray(list) ? list : [];
    if (mode === 'NONE') {
        if (entries.length) {
            return { ok: false, message: 'coverage must be empty when coverageMode is NONE.' };
        }
        return { ok: true, value: [] };
    }
    return validateCoveredCoverageList(list);
}
async function fetchCoveredEntriesMap(supabase, profileIds) {
    const map = new Map();
    if (!profileIds.length)
        return map;
    const values = profileIds.map((id) => encodeURIComponent(id)).join(',');
    const rows = await supabase.select('covered_network_profile_entries', `select=covered_network_profile_id,mcc,mnc&covered_network_profile_id=in.(${values})&order=mcc.asc,mnc.asc`);
    for (const row of Array.isArray(rows) ? rows : []) {
        const pid = String(row.covered_network_profile_id ?? '').trim();
        if (!pid)
            continue;
        if (!map.has(pid))
            map.set(pid, []);
        map.get(pid).push({
            mcc: String(row.mcc ?? '').trim(),
            mnc: String(row.mnc ?? '').trim(),
        });
    }
    return map;
}
async function collectPricePlansReferencingCoveredProfile(supabase, coveredNetworkProfileId) {
    const rows = await supabase.select('price_plans', `select=price_plan_id&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`);
    const list = Array.isArray(rows) ? rows : [];
    return list.map((r) => String(r.price_plan_id ?? '').trim()).filter(Boolean);
}
async function resolveResellerTenantId(supabase, resellerId) {
    if (!resellerId || !isValidUuid(resellerId))
        return null;
    const rows = await supabase.select('tenants', `select=tenant_id&tenant_id=eq.${encodeURIComponent(resellerId)}&tenant_type=eq.RESELLER&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.tenant_id ? String(row.tenant_id) : null;
}
async function loadOperatorByOperatorId(supabase, operatorId, supplierId) {
    const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : '';
    const rows = await supabase.select('operators', `select=operator_id,supplier_id,name,status,business_operator_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`);
    return Array.isArray(rows) ? rows[0] : null;
}
async function loadOperatorByBusinessOperatorId(supabase, businessOperatorId, supplierId) {
    const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : '';
    const rows = await supabase.select('operators', `select=operator_id,supplier_id,name,status,business_operator_id&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}${supplierFilter}&limit=1`);
    return Array.isArray(rows) ? rows[0] : null;
}
/** All supplier-bound operator rows for a business_operator_id (same catalog id may exist under multiple suppliers). */
async function loadAllOperatorIdsByBusinessOperatorId(supabase, businessOperatorId, supplierId) {
    const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : '';
    const rows = await supabase.select('operators', `select=operator_id&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}${supplierFilter}`);
    const list = Array.isArray(rows) ? rows : [];
    return list.map((r) => String(r?.operator_id ?? '').trim()).filter(Boolean);
}
async function loadOperator(supabase, operatorId, supplierId) {
    const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId);
    if (byOperatorId)
        return byOperatorId;
    return loadOperatorByBusinessOperatorId(supabase, operatorId, supplierId);
}
async function resolveBoundOperatorIds(supabase, operatorId, supplierId) {
    const ids = new Set();
    const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId);
    if (byOperatorId?.operator_id)
        ids.add(String(byOperatorId.operator_id));
    for (const id of await loadAllOperatorIdsByBusinessOperatorId(supabase, operatorId, supplierId)) {
        if (id)
            ids.add(id);
    }
    return Array.from(ids);
}
async function mapPublicOperatorIdByBoundOperatorIds(supabase, operatorIds) {
    const map = new Map();
    const normalized = operatorIds.map((id) => String(id || '').trim()).filter(Boolean);
    if (!normalized.length)
        return map;
    const uniqueIds = Array.from(new Set(normalized));
    const values = uniqueIds.map((id) => encodeURIComponent(id)).join(',');
    const rows = await supabase.select('operators', `select=operator_id,business_operator_id&operator_id=in.(${values})`);
    const byOperatorId = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = String(row?.operator_id ?? '').trim();
        if (!id)
            continue;
        byOperatorId.set(id, row);
    }
    for (const id of uniqueIds) {
        const row = byOperatorId.get(id);
        const businessOperatorId = String(row?.business_operator_id ?? '').trim();
        map.set(id, businessOperatorId || id);
    }
    return map;
}
async function backfillApnProfilesFromSims(supabase, supplierId) {
    const simRows = await supabase.select('sims', `select=apn,operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}`);
    const sims = Array.isArray(simRows) ? simRows : [];
    const existingRows = await supabase.select('apn_profiles', `select=apn,operator_id&supplier_id=eq.${encodeURIComponent(supplierId)}`);
    const existing = new Set();
    if (Array.isArray(existingRows)) {
        for (const row of existingRows) {
            const apn = String(row.apn ?? '').trim();
            const op = String(row.operator_id ?? '').trim();
            if (!apn || !op)
                continue;
            existing.add(`${apn}::${op}`);
        }
    }
    for (const sim of sims) {
        const apn = String(sim.apn ?? '').trim();
        const operatorId = String(sim.operator_id ?? '').trim();
        if (!apn || !operatorId)
            continue;
        const key = `${apn}::${operatorId}`;
        if (existing.has(key))
            continue;
        const nowIso = new Date().toISOString();
        const profileRows = await supabase.insert('apn_profiles', {
            name: `${apn}-${operatorId.slice(0, 8)}`,
            apn,
            auth_type: 'NONE',
            username: null,
            password_ref: null,
            supplier_id: supplierId,
            operator_id: operatorId,
            status: 'PUBLISHED',
            published_at: nowIso,
            effective_from: nowIso,
        }, { returning: 'representation' });
        const profile = Array.isArray(profileRows) ? profileRows[0] : null;
        if (profile?.apn_profile_id) {
            // SIM-derived APN rows are treated as already-published operational snapshots.
        }
        existing.add(key);
    }
}
async function loadProfile(supabase, table, idField, idValue) {
    const rows = await supabase.select(table, `select=*&${idField}=eq.${encodeURIComponent(idValue)}&limit=1`);
    return Array.isArray(rows) ? rows[0] : null;
}
export async function rollbackProfileVersion({ supabase, profileVersionId, audit, }) {
    if (!isValidUuid(profileVersionId)) {
        return toError(400, 'BAD_REQUEST', 'profileVersionId must be a valid uuid.');
    }
    const rows = await supabase.select('profile_versions', `select=profile_version_id,profile_type,profile_id,status,effective_from,version&profile_version_id=eq.${encodeURIComponent(profileVersionId)}&limit=1`);
    const version = Array.isArray(rows) ? rows[0] : null;
    if (!version)
        return toError(404, 'NOT_FOUND', 'Profile version not found.');
    if (version.status !== 'PUBLISHED') {
        return toError(409, 'INVALID_STATUS', 'Only PUBLISHED version can be rolled back.');
    }
    const effective = version.effective_from ? new Date(version.effective_from).getTime() : null;
    if (!effective || effective <= Date.now()) {
        return toError(409, 'INVALID_STATUS', 'Only scheduled (future) version can be rolled back.');
    }
    await supabase.update('profile_versions', `profile_version_id=eq.${encodeURIComponent(profileVersionId)}`, { status: 'DRAFT', effective_from: null, effective_to: null }, { returning: 'minimal' });
    await supabase.update('profile_change_requests', `profile_version_id=eq.${encodeURIComponent(profileVersionId)}&status=eq.SCHEDULED`, { status: 'CANCELLED', cancelled_at: new Date().toISOString() }, { returning: 'minimal' });
    const previousRows = await supabase.select('profile_versions', `select=profile_version_id,effective_to&profile_type=eq.${encodeURIComponent(String(version.profile_type))}&profile_id=eq.${encodeURIComponent(String(version.profile_id))}&status=eq.PUBLISHED&version=lt.${encodeURIComponent(String(version.version))}&order=version.desc&limit=1`);
    const previous = Array.isArray(previousRows) ? previousRows[0] : null;
    if (previous?.profile_version_id) {
        await supabase.update('profile_versions', `profile_version_id=eq.${encodeURIComponent(String(previous.profile_version_id))}`, { effective_to: null }, { returning: 'minimal' });
    }
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'PROFILE_VERSION_ROLLBACK',
        target_type: 'PROFILE_VERSION',
        target_id: profileVersionId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        before_data: {
            profileType: version.profile_type,
            profileId: version.profile_id,
            version: version.version,
            status: version.status,
            effectiveFrom: version.effective_from,
        },
        after_data: { status: 'CANCELLED' },
    });
    return { ok: true, value: { profileId: String(version.profile_id), profileVersionId, status: 'CANCELLED' } };
}
export async function createApnProfile({ supabase, payload, audit, }) {
    const name = String(payload?.name || '').trim();
    const apn = String(payload?.apn || '').trim();
    const authType = payload?.authType ? String(payload.authType) : 'NONE';
    const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null;
    const operatorId = payload?.operatorId ? String(payload.operatorId).trim() : null;
    if (!name)
        return toError(400, 'BAD_REQUEST', 'name is required.');
    if (!apn)
        return toError(400, 'BAD_REQUEST', 'apn is required.');
    if (!supplierId || !isValidUuid(supplierId)) {
        return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.');
    }
    if (!operatorId) {
        return toError(400, 'BAD_REQUEST', 'operatorId is required.');
    }
    if (!isValidUuid(operatorId)) {
        return toError(400, 'BAD_REQUEST', 'operatorId must be a valid uuid.');
    }
    const operator = await loadOperator(supabase, operatorId, supplierId);
    if (!operator) {
        return toError(400, 'BAD_REQUEST', 'operatorId is not found.');
    }
    if (String(operator?.supplier_id ?? '') !== String(supplierId)) {
        return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.');
    }
    const resolvedOperatorId = String(operator?.operator_id ?? operatorId);
    const rows = await supabase.insert('apn_profiles', {
        name,
        apn,
        auth_type: authType,
        username: payload?.username ? String(payload.username) : null,
        password_ref: payload?.passwordRef ? String(payload.passwordRef) : null,
        supplier_id: supplierId,
        operator_id: resolvedOperatorId,
        status: 'DRAFT',
    }, { returning: 'representation' });
    const profile = Array.isArray(rows) ? rows[0] : null;
    if (!profile?.apn_profile_id)
        return toError(500, 'INTERNAL_ERROR', 'Failed to create APN profile.');
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'APN_PROFILE_CREATED',
        target_type: 'APN_PROFILE',
        target_id: profile.apn_profile_id,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: {
            apnProfileId: profile.apn_profile_id,
            status: 'DRAFT',
            name,
            apn,
            authType,
            supplierId,
            operatorId: resolvedOperatorId,
        },
    });
    const id = String(profile.apn_profile_id);
    return {
        ok: true,
        value: {
            apnProfileId: id,
            status: 'DRAFT',
            createdAt: profile.created_at,
        },
    };
}
export async function createRoamingProfile({ supabase, payload, audit, }) {
    const name = String(payload?.name || '').trim();
    const resellerId = payload?.resellerId ? String(payload.resellerId).trim() : null;
    const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null;
    let operatorId = null;
    if (payload?.operatorId !== undefined && payload?.operatorId !== null) {
        operatorId = String(payload.operatorId).trim() || null;
    }
    else if (payload?.carrierId !== undefined && payload?.carrierId !== null) {
        operatorId = String(payload.carrierId).trim() || null;
    }
    const list = Array.isArray(payload?.mccmncList) ? payload.mccmncList : [];
    if (!name)
        return toError(400, 'BAD_REQUEST', 'name is required.');
    if (resellerId && !isValidUuid(resellerId)) {
        return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.');
    }
    if (!supplierId || !isValidUuid(supplierId)) {
        return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.');
    }
    if (!operatorId) {
        return toError(400, 'BAD_REQUEST', 'operatorId is required.');
    }
    if (!isValidUuid(operatorId)) {
        return toError(400, 'BAD_REQUEST', 'operatorId must be a valid uuid.');
    }
    if (!list.length)
        return toError(400, 'BAD_REQUEST', 'mccmncList is required.');
    const normalized = normalizeRoamingEntryList(list);
    if (!normalized.ok)
        return toError(400, 'BAD_REQUEST', normalized.message);
    const operator = await loadOperator(supabase, operatorId, supplierId);
    if (!operator) {
        return toError(400, 'BAD_REQUEST', 'operatorId is not found.');
    }
    if (String(operator?.supplier_id ?? '') !== String(supplierId)) {
        return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.');
    }
    const resolvedOperatorId = String(operator?.operator_id ?? operatorId);
    const normalizedList = normalized.value;
    const rows = await supabase.insert('roaming_profiles', {
        name,
        mccmnc_list: normalizedList,
        supplier_id: supplierId,
        operator_id: resolvedOperatorId,
        status: 'DRAFT',
    }, { returning: 'representation' });
    const profile = Array.isArray(rows) ? rows[0] : null;
    if (!profile?.roaming_profile_id)
        return toError(500, 'INTERNAL_ERROR', 'Failed to create roaming profile.');
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'ROAMING_PROFILE_CREATED',
        target_type: 'ROAMING_PROFILE',
        target_id: profile.roaming_profile_id,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: {
            roamingProfileId: profile.roaming_profile_id,
            status: 'DRAFT',
            name,
            resellerId,
            supplierId,
            operatorId: resolvedOperatorId,
            carrierId: resolvedOperatorId,
            mccmncList: normalizedList,
        },
    });
    return {
        ok: true,
        value: {
            roamingProfileId: String(profile.roaming_profile_id),
            status: 'DRAFT',
            createdAt: profile.created_at,
        },
    };
}
export async function listApnProfiles({ supabase, supplierId, supplierIds, operatorId, apnProfileId, status, page, pageSize, }) {
    const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 20 });
    const filters = [];
    const supplierIdValue = supplierId ? String(supplierId) : null;
    const hasSupplierIdsInput = Array.isArray(supplierIds);
    const supplierIdValues = supplierIdValue
        ? []
        : Array.from(new Set((hasSupplierIdsInput ? supplierIds : []).map((id) => String(id).trim()).filter(Boolean)));
    const operatorIdValue = operatorId ? String(operatorId) : null;
    const apnProfileIdValue = apnProfileId ? String(apnProfileId).trim() : null;
    if (apnProfileIdValue && !isValidUuid(apnProfileIdValue)) {
        return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.');
    }
    if (supplierIdValues.some((id) => !isValidUuid(id))) {
        return toError(400, 'BAD_REQUEST', 'supplierIds contains invalid uuid.');
    }
    if (!supplierIdValue && hasSupplierIdsInput && !supplierIdValues.length) {
        return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) };
    }
    if (apnProfileIdValue) {
        filters.push(`apn_profile_id=eq.${encodeURIComponent(apnProfileIdValue)}`);
    }
    if (supplierIdValue) {
        await backfillApnProfilesFromSims(supabase, supplierIdValue);
        filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`);
    }
    else if (supplierIdValues.length) {
        for (const id of supplierIdValues) {
            await backfillApnProfilesFromSims(supabase, id);
        }
        filters.push(`supplier_id=in.(${supplierIdValues.map((id) => encodeURIComponent(id)).join(',')})`);
    }
    if (operatorIdValue) {
        const operatorIds = await resolveBoundOperatorIds(supabase, operatorIdValue, supplierIdValue);
        if (!operatorIds.length)
            return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) };
        if (operatorIds.length === 1) {
            filters.push(`operator_id=eq.${encodeURIComponent(String(operatorIds[0]))}`);
        }
        else {
            const values = operatorIds.map((id) => encodeURIComponent(id)).join(',');
            filters.push(`operator_id=in.(${values})`);
        }
    }
    if (status)
        filters.push(`status=eq.${encodeURIComponent(String(status))}`);
    const filterQs = filters.length ? `&${filters.join('&')}` : '';
    const rows = await supabase.select('apn_profiles', `select=apn_profile_id,name,apn,auth_type,username,password_ref,supplier_id,operator_id,status,published_at,effective_from,deprecated_at,source_apn_profile_id,created_at,updated_at&order=created_at.desc${filterQs}`);
    const profiles = Array.isArray(rows) ? rows : [];
    const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(supabase, profiles.map((p) => String(p.operator_id ?? '').trim()).filter(Boolean));
    const items = profiles.map((p) => ({
        apnProfileId: p.apn_profile_id,
        name: p.name,
        apn: p.apn,
        authType: p.auth_type,
        supplierId: p.supplier_id,
        operatorId: operatorIdMap.get(String(p.operator_id ?? '').trim()) ?? p.operator_id ?? null,
        status: p.status,
        publishedAt: p.published_at ?? null,
        effectiveFrom: p.effective_from ?? null,
        deprecatedAt: p.deprecated_at ?? null,
        sourceApnProfileId: p.source_apn_profile_id ?? null,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
    }));
    const total = items.length;
    const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize);
    return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) };
}
export async function listRoamingProfiles({ supabase, supplierId, supplierIds, operatorId, roamingProfileId, status, page, pageSize, }) {
    const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 20 });
    const filters = [];
    const supplierIdValue = supplierId ? String(supplierId) : null;
    const hasSupplierIdsInput = Array.isArray(supplierIds);
    const supplierIdValues = supplierIdValue
        ? []
        : Array.from(new Set((hasSupplierIdsInput ? supplierIds : []).map((id) => String(id).trim()).filter(Boolean)));
    const operatorIdValue = operatorId ? String(operatorId) : null;
    const roamingProfileIdValue = roamingProfileId ? String(roamingProfileId).trim() : null;
    if (roamingProfileIdValue && !isValidUuid(roamingProfileIdValue)) {
        return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.');
    }
    if (supplierIdValues.some((id) => !isValidUuid(id))) {
        return toError(400, 'BAD_REQUEST', 'supplierIds contains invalid uuid.');
    }
    if (!supplierIdValue && hasSupplierIdsInput && !supplierIdValues.length) {
        return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) };
    }
    if (roamingProfileIdValue) {
        filters.push(`roaming_profile_id=eq.${encodeURIComponent(roamingProfileIdValue)}`);
    }
    if (supplierIdValue)
        filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`);
    else if (supplierIdValues.length)
        filters.push(`supplier_id=in.(${supplierIdValues.map((id) => encodeURIComponent(id)).join(',')})`);
    if (operatorIdValue) {
        const operatorIds = await resolveBoundOperatorIds(supabase, operatorIdValue, supplierIdValue);
        if (!operatorIds.length)
            return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) };
        if (operatorIds.length === 1) {
            filters.push(`operator_id=eq.${encodeURIComponent(String(operatorIds[0]))}`);
        }
        else {
            const values = operatorIds.map((id) => encodeURIComponent(id)).join(',');
            filters.push(`operator_id=in.(${values})`);
        }
    }
    if (status)
        filters.push(`status=eq.${encodeURIComponent(String(status))}`);
    const filterQs = filters.length ? `&${filters.join('&')}` : '';
    const rows = await supabase.select('roaming_profiles', `select=roaming_profile_id,name,mccmnc_list,supplier_id,operator_id,status,published_at,effective_from,deprecated_at,source_roaming_profile_id,created_at,updated_at&order=created_at.desc${filterQs}`);
    const profiles = Array.isArray(rows) ? rows : [];
    const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(supabase, profiles.map((p) => String(p.operator_id ?? '').trim()).filter(Boolean));
    const items = profiles.map((p) => ({
        roamingProfileId: p.roaming_profile_id,
        name: p.name,
        mccmncList: p.mccmnc_list,
        supplierId: p.supplier_id,
        operatorId: operatorIdMap.get(String(p.operator_id ?? '').trim()) ?? p.operator_id ?? null,
        carrierId: operatorIdMap.get(String(p.operator_id ?? '').trim()) ?? p.operator_id ?? null,
        status: p.status,
        publishedAt: p.published_at ?? null,
        effectiveFrom: p.effective_from ?? null,
        deprecatedAt: p.deprecated_at ?? null,
        sourceRoamingProfileId: p.source_roaming_profile_id ?? null,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
    }));
    const total = items.length;
    const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize);
    return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) };
}
export async function getApnProfileDetail({ supabase, apnProfileId, }) {
    if (!isValidUuid(apnProfileId))
        return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.');
    const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'APN profile not found.');
    const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(supabase, [String(profile.operator_id ?? '').trim()].filter(Boolean));
    const publicOperatorId = operatorIdMap.get(String(profile.operator_id ?? '').trim()) ?? profile.operator_id ?? null;
    return {
        ok: true,
        value: {
            apnProfileId: profile.apn_profile_id,
            name: profile.name,
            apn: profile.apn,
            authType: profile.auth_type,
            username: profile.username,
            passwordRef: profile.password_ref,
            supplierId: profile.supplier_id,
            operatorId: publicOperatorId,
            status: profile.status,
            publishedAt: profile.published_at ?? null,
            effectiveFrom: profile.effective_from ?? null,
            sourceApnProfileId: profile.source_apn_profile_id ?? null,
            createdAt: profile.created_at,
            updatedAt: profile.updated_at,
        },
    };
}
export async function getRoamingProfileDetail({ supabase, roamingProfileId, }) {
    if (!isValidUuid(roamingProfileId))
        return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.');
    const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'Roaming profile not found.');
    const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(supabase, [String(profile.operator_id ?? '').trim()].filter(Boolean));
    const publicOperatorId = operatorIdMap.get(String(profile.operator_id ?? '').trim()) ?? profile.operator_id ?? null;
    return {
        ok: true,
        value: {
            roamingProfileId: profile.roaming_profile_id,
            name: profile.name,
            mccmncList: profile.mccmnc_list,
            supplierId: profile.supplier_id,
            operatorId: publicOperatorId,
            carrierId: publicOperatorId,
            status: profile.status,
            publishedAt: profile.published_at ?? null,
            effectiveFrom: profile.effective_from ?? null,
            sourceRoamingProfileId: profile.source_roaming_profile_id ?? null,
            createdAt: profile.created_at,
            updatedAt: profile.updated_at,
        },
    };
}
export async function publishApnProfile({ supabase, apnProfileId, audit, }) {
    if (!isValidUuid(apnProfileId))
        return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.');
    const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'APN profile not found.');
    if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
        return toError(409, 'INVALID_STATUS', 'Only DRAFT APN profiles can be published.');
    }
    const effectiveFrom = firstDayNextMonthUtc().toISOString();
    const publishedAt = new Date().toISOString();
    await supabase.update('apn_profiles', `apn_profile_id=eq.${encodeURIComponent(apnProfileId)}`, {
        status: 'PUBLISHED',
        effective_from: effectiveFrom,
        published_at: publishedAt,
        updated_at: publishedAt,
    }, { returning: 'minimal' });
    const value = {
        apnProfileId,
        status: 'PUBLISHED',
        effectiveFrom,
        publishedAt,
    };
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'APN_PROFILE_PUBLISHED',
        target_type: 'APN_PROFILE',
        target_id: apnProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: value,
    });
    return { ok: true, value };
}
export async function deprecateApnProfile({ supabase, apnProfileId, audit, }) {
    if (!isValidUuid(apnProfileId))
        return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.');
    const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'APN profile not found.');
    const st = String(profile.status ?? '').toUpperCase();
    if (st !== 'PUBLISHED') {
        return toError(409, 'INVALID_STATUS', 'Only PUBLISHED APN profiles can be deprecated.');
    }
    const usage = await collectApnProfileUsage(supabase, apnProfileId);
    if (usage.carrierServiceIds.length || usage.packageIds.length) {
        return toError(409, 'RESOURCE_IN_USE', `APN profile is still referenced by carrier services or subscription packages. carrierServiceIds=${usage.carrierServiceIds.join(',')}; packageIds=${usage.packageIds.join(',')}`);
    }
    const nowIso = new Date().toISOString();
    await supabase.update('apn_profiles', `apn_profile_id=eq.${encodeURIComponent(apnProfileId)}`, {
        status: 'DEPRECATED',
        updated_at: nowIso,
    }, { returning: 'minimal' });
    const value = {
        apnProfileId,
        status: 'DEPRECATED',
        publishedAt: profile.published_at ?? null,
        effectiveFrom: profile.effective_from ?? null,
        deprecatedAt: nowIso,
    };
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'APN_PROFILE_DEPRECATED',
        target_type: 'APN_PROFILE',
        target_id: apnProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: value,
    });
    return { ok: true, value };
}
export async function publishRoamingProfile({ supabase, roamingProfileId, audit, }) {
    if (!isValidUuid(roamingProfileId))
        return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.');
    const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'Roaming profile not found.');
    if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
        return toError(409, 'INVALID_STATUS', 'Only DRAFT roaming profiles can be published.');
    }
    const effectiveFrom = firstDayNextMonthUtc().toISOString();
    const publishedAt = new Date().toISOString();
    await supabase.update('roaming_profiles', `roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}`, {
        status: 'PUBLISHED',
        effective_from: effectiveFrom,
        published_at: publishedAt,
        updated_at: publishedAt,
    }, { returning: 'minimal' });
    const value = {
        roamingProfileId,
        status: 'PUBLISHED',
        effectiveFrom,
        publishedAt,
    };
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'ROAMING_PROFILE_PUBLISHED',
        target_type: 'ROAMING_PROFILE',
        target_id: roamingProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: value,
    });
    return { ok: true, value };
}
export async function deprecateRoamingProfile({ supabase, roamingProfileId, audit, }) {
    if (!isValidUuid(roamingProfileId))
        return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.');
    const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'Roaming profile not found.');
    const st = String(profile.status ?? '').toUpperCase();
    if (st !== 'PUBLISHED') {
        return toError(409, 'INVALID_STATUS', 'Only PUBLISHED roaming profiles can be deprecated.');
    }
    const usage = await collectRoamingProfileUsage(supabase, roamingProfileId);
    if (usage.carrierServiceIds.length || usage.packageIds.length) {
        return toError(409, 'RESOURCE_IN_USE', `Roaming profile is still referenced by carrier services or subscription packages. carrierServiceIds=${usage.carrierServiceIds.join(',')}; packageIds=${usage.packageIds.join(',')}`);
    }
    const nowIso = new Date().toISOString();
    await supabase.update('roaming_profiles', `roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}`, {
        status: 'DEPRECATED',
        updated_at: nowIso,
    }, { returning: 'minimal' });
    const value = {
        roamingProfileId,
        status: 'DEPRECATED',
        publishedAt: profile.published_at ?? null,
        effectiveFrom: profile.effective_from ?? null,
        deprecatedAt: nowIso,
    };
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'ROAMING_PROFILE_DEPRECATED',
        target_type: 'ROAMING_PROFILE',
        target_id: roamingProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: value,
    });
    return { ok: true, value };
}
export async function createCoveredNetworkProfile({ supabase, payload, audit, }) {
    const name = String(payload?.name || '').trim();
    const supplierId = payload?.supplierId ? String(payload.supplierId).trim() : null;
    let operatorId = null;
    if (payload?.operatorId !== undefined && payload?.operatorId !== null) {
        operatorId = String(payload.operatorId).trim() || null;
    }
    else if (payload?.carrierId !== undefined && payload?.carrierId !== null) {
        operatorId = String(payload.carrierId).trim() || null;
    }
    const rawResellerRaw = payload?.resellerId;
    const rawReseller = rawResellerRaw === undefined || rawResellerRaw === null ? null : String(rawResellerRaw).trim() || null;
    const coverageList = payload?.coverage !== undefined ? payload.coverage : payload?.mccmncList;
    const coverageMode = normalizeCoverageMode(payload?.coverageMode ?? payload?.coverage_mode);
    if (!name)
        return toError(400, 'BAD_REQUEST', 'name is required.');
    if (!supplierId || !isValidUuid(supplierId)) {
        return toError(400, 'BAD_REQUEST', 'supplierId must be a valid uuid.');
    }
    if (!operatorId)
        return toError(400, 'BAD_REQUEST', 'operatorId is required.');
    if (!isValidUuid(operatorId))
        return toError(400, 'BAD_REQUEST', 'operatorId must be a valid uuid.');
    if (!rawReseller) {
        return toError(400, 'BAD_REQUEST', 'resellerId is required.');
    }
    if (!isValidUuid(rawReseller)) {
        return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.');
    }
    const normalizedCov = validateCoverageForMode(coverageMode, coverageList);
    if (!normalizedCov.ok)
        return toError(400, 'BAD_REQUEST', normalizedCov.message);
    const operator = await loadOperator(supabase, operatorId, supplierId);
    if (!operator)
        return toError(400, 'BAD_REQUEST', 'operatorId is not found.');
    if (String(operator?.supplier_id ?? '') !== String(supplierId)) {
        return toError(400, 'BAD_REQUEST', 'operatorId is not linked to supplierId.');
    }
    const resolvedOperatorId = String(operator?.operator_id ?? operatorId);
    const resellerTenantId = await resolveResellerTenantId(supabase, rawReseller);
    if (!resellerTenantId) {
        return toError(400, 'BAD_REQUEST', 'resellerId is not a valid RESELLER tenant.');
    }
    const rows = await supabase.insert('covered_network_profiles', {
        name,
        reseller_id: resellerTenantId,
        supplier_id: supplierId,
        operator_id: resolvedOperatorId,
        coverage_mode: coverageMode,
        status: 'DRAFT',
    }, { returning: 'representation' });
    const profile = Array.isArray(rows) ? rows[0] : null;
    const pid = profile?.covered_network_profile_id
        ? String(profile.covered_network_profile_id)
        : null;
    if (!pid)
        return toError(500, 'INTERNAL_ERROR', 'Failed to create CoveredNetworkProfile.');
    const entryRows = normalizedCov.value.map((e) => ({
        covered_network_profile_id: pid,
        mcc: e.mcc,
        mnc: e.mnc,
    }));
    if (entryRows.length) {
        await supabase.insert('covered_network_profile_entries', entryRows, { returning: 'minimal' });
    }
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'COVERED_NETWORK_PROFILE_CREATED',
        target_type: 'COVERED_NETWORK_PROFILE',
        target_id: pid,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: {
            coveredNetworkProfileId: pid,
            status: 'DRAFT',
            name,
            resellerId: resellerTenantId,
            supplierId,
            operatorId: resolvedOperatorId,
            coverageMode,
            coverage: normalizedCov.value,
        },
    });
    return {
        ok: true,
        value: {
            coveredNetworkProfileId: pid,
            status: 'DRAFT',
            createdAt: profile.created_at,
        },
    };
}
export async function listCoveredNetworkProfiles({ supabase, supplierId, operatorId, resellerId, coveredNetworkProfileId, status, page, pageSize, }) {
    const pagination = parsePagination({ page, pageSize }, { defaultPageSize: 20, maxPageSize: 20 });
    const filters = [];
    const supplierIdValue = supplierId ? String(supplierId) : null;
    const operatorIdValue = operatorId ? String(operatorId) : null;
    const resellerIdValue = resellerId ? String(resellerId).trim() : null;
    const profileIdValue = coveredNetworkProfileId ? String(coveredNetworkProfileId).trim() : null;
    if (!supplierIdValue && !operatorIdValue && !profileIdValue) {
        return toError(400, 'BAD_REQUEST', 'supplierId, operatorId, or coveredNetworkProfileId is required.');
    }
    if (profileIdValue && !isValidUuid(profileIdValue)) {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.');
    }
    if (resellerIdValue && !isValidUuid(resellerIdValue)) {
        return toError(400, 'BAD_REQUEST', 'resellerId must be a valid uuid.');
    }
    if (profileIdValue) {
        filters.push(`covered_network_profile_id=eq.${encodeURIComponent(profileIdValue)}`);
    }
    if (supplierIdValue)
        filters.push(`supplier_id=eq.${encodeURIComponent(supplierIdValue)}`);
    if (operatorIdValue) {
        const operatorIds = await resolveBoundOperatorIds(supabase, operatorIdValue, supplierIdValue);
        if (!operatorIds.length)
            return { ok: true, value: buildPaginationResponse([], 0, pagination.page, pagination.pageSize) };
        if (operatorIds.length === 1) {
            filters.push(`operator_id=eq.${encodeURIComponent(String(operatorIds[0]))}`);
        }
        else {
            const values = operatorIds.map((id) => encodeURIComponent(id)).join(',');
            filters.push(`operator_id=in.(${values})`);
        }
    }
    if (resellerIdValue)
        filters.push(`reseller_id=eq.${encodeURIComponent(resellerIdValue)}`);
    if (status)
        filters.push(`status=eq.${encodeURIComponent(String(status))}`);
    const filterQs = filters.length ? `&${filters.join('&')}` : '';
    const rows = await supabase.select('covered_network_profiles', `select=covered_network_profile_id,name,reseller_id,supplier_id,operator_id,coverage_mode,status,published_at,effective_from,source_covered_network_profile_id,created_at,updated_at&order=created_at.desc${filterQs}`);
    const profiles = Array.isArray(rows) ? rows : [];
    const ids = profiles.map((p) => String(p.covered_network_profile_id ?? '').trim()).filter(Boolean);
    const entryMap = await fetchCoveredEntriesMap(supabase, ids);
    const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(supabase, profiles.map((p) => String(p.operator_id ?? '').trim()).filter(Boolean));
    const items = profiles.map((p) => {
        const id = String(p.covered_network_profile_id ?? '');
        const pubOp = operatorIdMap.get(String(p.operator_id ?? '').trim()) ?? p.operator_id ?? null;
        return {
            coveredNetworkProfileId: id,
            name: p.name,
            coverageMode: normalizeCoverageMode(p.coverage_mode),
            coverage: entryMap.get(id) ?? [],
            resellerId: p.reseller_id ?? null,
            supplierId: p.supplier_id,
            operatorId: pubOp,
            status: p.status,
            publishedAt: p.published_at ?? null,
            effectiveFrom: p.effective_from ?? null,
            sourceCoveredNetworkProfileId: p.source_covered_network_profile_id ?? null,
            createdAt: p.created_at,
            updatedAt: p.updated_at,
        };
    });
    const total = items.length;
    const pagedItems = items.slice(pagination.offset, pagination.offset + pagination.pageSize);
    return { ok: true, value: buildPaginationResponse(pagedItems, total, pagination.page, pagination.pageSize) };
}
export async function getCoveredNetworkProfileDetail({ supabase, coveredNetworkProfileId, }) {
    if (!isValidUuid(coveredNetworkProfileId)) {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.');
    }
    const profile = await loadProfile(supabase, 'covered_network_profiles', 'covered_network_profile_id', coveredNetworkProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'CoveredNetworkProfile not found.');
    const entryMap = await fetchCoveredEntriesMap(supabase, [coveredNetworkProfileId]);
    const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(supabase, [
        String(profile.operator_id ?? '').trim(),
    ].filter(Boolean));
    const publicOperatorId = operatorIdMap.get(String(profile.operator_id ?? '').trim()) ??
        profile.operator_id ??
        null;
    return {
        ok: true,
        value: {
            coveredNetworkProfileId: profile.covered_network_profile_id,
            name: profile.name,
            coverageMode: normalizeCoverageMode(profile.coverage_mode),
            coverage: entryMap.get(coveredNetworkProfileId) ?? [],
            resellerId: profile.reseller_id ?? null,
            supplierId: profile.supplier_id,
            operatorId: publicOperatorId,
            status: profile.status,
            publishedAt: profile.published_at ?? null,
            effectiveFrom: profile.effective_from ?? null,
            sourceCoveredNetworkProfileId: profile.source_covered_network_profile_id ?? null,
            createdAt: profile.created_at,
            updatedAt: profile.updated_at,
        },
    };
}
export async function patchCoveredNetworkProfile({ supabase, coveredNetworkProfileId, payload, audit, }) {
    if (!isValidUuid(coveredNetworkProfileId)) {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.');
    }
    const profile = (await loadProfile(supabase, 'covered_network_profiles', 'covered_network_profile_id', coveredNetworkProfileId));
    if (!profile)
        return toError(404, 'NOT_FOUND', 'CoveredNetworkProfile not found.');
    if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
        return toError(409, 'INVALID_STATUS', 'Only DRAFT CoveredNetworkProfile can be patched.');
    }
    const updates = {};
    if (payload?.name !== undefined)
        updates.name = String(payload.name).trim();
    const nextCoverageMode = payload?.coverageMode !== undefined || payload?.coverage_mode !== undefined
        ? normalizeCoverageMode(payload?.coverageMode ?? payload?.coverage_mode)
        : normalizeCoverageMode(profile.coverage_mode);
    if (payload?.coverageMode !== undefined || payload?.coverage_mode !== undefined) {
        updates.coverage_mode = nextCoverageMode;
    }
    let newCoverage = null;
    if (payload?.coverage !== undefined) {
        const normalized = validateCoverageForMode(nextCoverageMode, payload.coverage);
        if (!normalized.ok)
            return toError(400, 'BAD_REQUEST', normalized.message);
        newCoverage = normalized.value;
    }
    else if ((payload?.coverageMode !== undefined || payload?.coverage_mode !== undefined) && nextCoverageMode === 'NONE') {
        newCoverage = [];
    }
    if (!Object.keys(updates).length && newCoverage === null) {
        return toError(400, 'BAD_REQUEST', 'At least one of name or coverage must be provided.');
    }
    const nowIso = new Date().toISOString();
    if (Object.keys(updates).length) {
        updates.updated_at = nowIso;
        await supabase.update('covered_network_profiles', `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`, updates, { returning: 'minimal' });
    }
    if (newCoverage !== null) {
        const del = supabase.delete;
        if (typeof del !== 'function') {
            return toError(500, 'INTERNAL_ERROR', 'Storage client does not support delete.');
        }
        await del('covered_network_profile_entries', `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`);
        const entryRows = newCoverage.map((e) => ({
            covered_network_profile_id: coveredNetworkProfileId,
            mcc: e.mcc,
            mnc: e.mnc,
        }));
        if (entryRows.length) {
            await supabase.insert('covered_network_profile_entries', entryRows, { returning: 'minimal' });
        }
        await supabase.update('covered_network_profiles', `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`, { updated_at: nowIso }, { returning: 'minimal' });
    }
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'COVERED_NETWORK_PROFILE_UPDATED',
        target_type: 'COVERED_NETWORK_PROFILE',
        target_id: coveredNetworkProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: { name: updates.name, coverageMode: updates.coverage_mode, coverageReplaced: newCoverage !== null },
    });
    return getCoveredNetworkProfileDetail({ supabase, coveredNetworkProfileId });
}
export async function publishCoveredNetworkProfile({ supabase, coveredNetworkProfileId, audit, }) {
    if (!isValidUuid(coveredNetworkProfileId)) {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.');
    }
    const profile = await loadProfile(supabase, 'covered_network_profiles', 'covered_network_profile_id', coveredNetworkProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'CoveredNetworkProfile not found.');
    if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
        return toError(409, 'INVALID_STATUS', 'Only DRAFT CoveredNetworkProfile can be published.');
    }
    const coverageMode = normalizeCoverageMode(profile.coverage_mode);
    if (coverageMode === 'LIST') {
        const entryCheck = await supabase.select('covered_network_profile_entries', `select=entry_id&covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}&limit=1`);
        if (!Array.isArray(entryCheck) || !entryCheck.length) {
            return toError(400, 'BAD_REQUEST', 'CoveredNetworkProfile must have at least one coverage entry before publish.');
        }
    }
    const effectiveFrom = firstDayNextMonthUtc().toISOString();
    const publishedAt = new Date().toISOString();
    await supabase.update('covered_network_profiles', `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`, {
        status: 'PUBLISHED',
        effective_from: effectiveFrom,
        published_at: publishedAt,
        updated_at: publishedAt,
    }, { returning: 'minimal' });
    const value = {
        coveredNetworkProfileId,
        status: 'PUBLISHED',
        effectiveFrom,
        publishedAt,
    };
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'COVERED_NETWORK_PROFILE_PUBLISHED',
        target_type: 'COVERED_NETWORK_PROFILE',
        target_id: coveredNetworkProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: value,
    });
    return { ok: true, value };
}
export async function deprecateCoveredNetworkProfile({ supabase, coveredNetworkProfileId, audit, }) {
    if (!isValidUuid(coveredNetworkProfileId)) {
        return toError(400, 'BAD_REQUEST', 'coveredNetworkProfileId must be a valid uuid.');
    }
    const profile = await loadProfile(supabase, 'covered_network_profiles', 'covered_network_profile_id', coveredNetworkProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'CoveredNetworkProfile not found.');
    const st = String(profile.status ?? '').toUpperCase();
    if (st !== 'PUBLISHED') {
        return toError(409, 'INVALID_STATUS', 'Only PUBLISHED CoveredNetworkProfile can be deprecated.');
    }
    const refs = await collectPricePlansReferencingCoveredProfile(supabase, coveredNetworkProfileId);
    if (refs.length) {
        return toError(409, 'REFERENCES_BLOCKED', `Still referenced by price plans: ${refs.join(',')}`);
    }
    const nowIso = new Date().toISOString();
    await supabase.update('covered_network_profiles', `covered_network_profile_id=eq.${encodeURIComponent(coveredNetworkProfileId)}`, {
        status: 'DEPRECATED',
        updated_at: nowIso,
    }, { returning: 'minimal' });
    const value = {
        coveredNetworkProfileId,
        status: 'DEPRECATED',
        publishedAt: profile.published_at ?? null,
        effectiveFrom: profile.effective_from ?? null,
        deprecatedAt: nowIso,
    };
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'COVERED_NETWORK_PROFILE_DEPRECATED',
        target_type: 'COVERED_NETWORK_PROFILE',
        target_id: coveredNetworkProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: value,
    });
    return { ok: true, value };
}
export async function cloneApnProfile({ supabase, apnProfileId, payload, audit, }) {
    if (!isValidUuid(apnProfileId))
        return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.');
    const source = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId);
    if (!source)
        return toError(404, 'NOT_FOUND', 'Source APN profile not found.');
    const name = payload?.name ? String(payload.name).trim() : `${source.name} (Copy)`;
    const rows = await supabase.insert('apn_profiles', {
        name,
        apn: source.apn,
        auth_type: source.auth_type,
        username: source.username ?? null,
        password_ref: source.password_ref ?? null,
        supplier_id: source.supplier_id,
        operator_id: source.operator_id,
        status: 'DRAFT',
        source_apn_profile_id: apnProfileId,
    }, { returning: 'representation' });
    const cloned = Array.isArray(rows) ? rows[0] : null;
    if (!cloned?.apn_profile_id)
        return toError(500, 'INTERNAL_ERROR', 'Failed to clone APN profile.');
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'APN_PROFILE_CLONED',
        target_type: 'APN_PROFILE',
        target_id: cloned.apn_profile_id,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: {
            apnProfileId: cloned.apn_profile_id,
            sourceApnProfileId: apnProfileId,
        },
    });
    return {
        ok: true,
        value: {
            apnProfileId: cloned.apn_profile_id,
            sourceApnProfileId: apnProfileId,
            status: 'DRAFT',
            createdAt: cloned.created_at,
        },
    };
}
export async function cloneRoamingProfile({ supabase, roamingProfileId, payload, audit, }) {
    if (!isValidUuid(roamingProfileId))
        return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.');
    const source = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId);
    if (!source)
        return toError(404, 'NOT_FOUND', 'Source roaming profile not found.');
    const name = payload?.name ? String(payload.name).trim() : `${source.name} (Copy)`;
    const rows = await supabase.insert('roaming_profiles', {
        name,
        mccmnc_list: source.mccmnc_list,
        supplier_id: source.supplier_id,
        operator_id: source.operator_id,
        status: 'DRAFT',
        source_roaming_profile_id: roamingProfileId,
    }, { returning: 'representation' });
    const cloned = Array.isArray(rows) ? rows[0] : null;
    if (!cloned?.roaming_profile_id)
        return toError(500, 'INTERNAL_ERROR', 'Failed to clone roaming profile.');
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'ROAMING_PROFILE_CLONED',
        target_type: 'ROAMING_PROFILE',
        target_id: cloned.roaming_profile_id,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: {
            roamingProfileId: cloned.roaming_profile_id,
            sourceRoamingProfileId: roamingProfileId,
        },
    });
    return {
        ok: true,
        value: {
            roamingProfileId: cloned.roaming_profile_id,
            sourceRoamingProfileId: roamingProfileId,
            status: 'DRAFT',
            createdAt: cloned.created_at,
        },
    };
}
export async function updateApnProfile({ supabase, apnProfileId, payload, audit, }) {
    if (!isValidUuid(apnProfileId))
        return toError(400, 'BAD_REQUEST', 'apnProfileId must be a valid uuid.');
    const profile = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'APN profile not found.');
    if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
        return toError(409, 'INVALID_STATUS', 'Only DRAFT APN profiles can be updated. Clone to a new draft snapshot first.');
    }
    const updates = {};
    if (payload?.name !== undefined)
        updates.name = String(payload.name).trim();
    if (payload?.apn !== undefined)
        updates.apn = String(payload.apn).trim();
    if (payload?.authType !== undefined)
        updates.auth_type = String(payload.authType);
    if (payload?.username !== undefined)
        updates.username = payload.username ? String(payload.username) : null;
    if (payload?.passwordRef !== undefined)
        updates.password_ref = payload.passwordRef ? String(payload.passwordRef) : null;
    if (!Object.keys(updates).length) {
        return toError(400, 'BAD_REQUEST', 'At least one field must be provided for update.');
    }
    updates.updated_at = new Date().toISOString();
    await supabase.update('apn_profiles', `apn_profile_id=eq.${encodeURIComponent(apnProfileId)}`, updates, { returning: 'minimal' });
    const refreshed = await loadProfile(supabase, 'apn_profiles', 'apn_profile_id', apnProfileId);
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'APN_PROFILE_UPDATED',
        target_type: 'APN_PROFILE',
        target_id: apnProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        before_data: {
            name: profile.name,
            apn: profile.apn,
            authType: profile.auth_type,
        },
        after_data: {
            name: refreshed?.name,
            apn: refreshed?.apn,
            authType: refreshed?.auth_type,
        },
    });
    return {
        ok: true,
        value: {
            apnProfileId: refreshed.apn_profile_id,
            name: refreshed.name,
            apn: refreshed.apn,
            authType: refreshed.auth_type,
            username: refreshed.username,
            passwordRef: refreshed.password_ref,
            supplierId: refreshed.supplier_id,
            operatorId: refreshed.operator_id,
            status: refreshed.status,
            publishedAt: refreshed.published_at ?? null,
            effectiveFrom: refreshed.effective_from ?? null,
            sourceApnProfileId: refreshed.source_apn_profile_id ?? null,
            createdAt: refreshed.created_at,
            updatedAt: refreshed.updated_at,
        },
    };
}
export async function updateRoamingProfile({ supabase, roamingProfileId, payload, audit, }) {
    if (!isValidUuid(roamingProfileId))
        return toError(400, 'BAD_REQUEST', 'roamingProfileId must be a valid uuid.');
    const profile = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId);
    if (!profile)
        return toError(404, 'NOT_FOUND', 'Roaming profile not found.');
    if (String(profile.status ?? '').toUpperCase() !== 'DRAFT') {
        return toError(409, 'INVALID_STATUS', 'Only DRAFT roaming profiles can be updated. Clone to a new draft snapshot first.');
    }
    const updates = {};
    if (payload?.name !== undefined)
        updates.name = String(payload.name).trim();
    let normalizedList = null;
    if (payload?.mccmncList !== undefined) {
        const list = Array.isArray(payload.mccmncList) ? payload.mccmncList : [];
        if (!list.length)
            return toError(400, 'BAD_REQUEST', 'mccmncList must not be empty.');
        const normalized = normalizeRoamingEntryList(list);
        if (!normalized.ok)
            return toError(400, 'BAD_REQUEST', normalized.message);
        normalizedList = normalized.value;
        updates.mccmnc_list = normalizedList;
    }
    if (!Object.keys(updates).length) {
        return toError(400, 'BAD_REQUEST', 'At least one field must be provided for update.');
    }
    updates.updated_at = new Date().toISOString();
    await supabase.update('roaming_profiles', `roaming_profile_id=eq.${encodeURIComponent(roamingProfileId)}`, updates, { returning: 'minimal' });
    const refreshed = await loadProfile(supabase, 'roaming_profiles', 'roaming_profile_id', roamingProfileId);
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: null,
        action: 'ROAMING_PROFILE_UPDATED',
        target_type: 'ROAMING_PROFILE',
        target_id: roamingProfileId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        before_data: {
            name: profile.name,
            mccmncList: profile.mccmnc_list,
        },
        after_data: {
            name: refreshed?.name,
            mccmncList: refreshed?.mccmnc_list,
        },
    });
    const operatorIdMap = await mapPublicOperatorIdByBoundOperatorIds(supabase, [String(refreshed.operator_id ?? '').trim()].filter(Boolean));
    const publicOperatorId = operatorIdMap.get(String(refreshed.operator_id ?? '').trim()) ?? refreshed.operator_id ?? null;
    return {
        ok: true,
        value: {
            roamingProfileId: refreshed.roaming_profile_id,
            name: refreshed.name,
            mccmncList: refreshed.mccmnc_list,
            supplierId: refreshed.supplier_id,
            operatorId: publicOperatorId,
            carrierId: publicOperatorId,
            status: refreshed.status,
            publishedAt: refreshed.published_at ?? null,
            effectiveFrom: refreshed.effective_from ?? null,
            sourceRoamingProfileId: refreshed.source_roaming_profile_id ?? null,
            createdAt: refreshed.created_at,
            updatedAt: refreshed.updated_at,
        },
    };
}
