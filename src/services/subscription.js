import { enqueueSubscriptionProvisionJob } from './subscriptionProvisionJob.js';
function isValidUuid(value) {
    const s = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}
function isValidIccid(value) {
    const s = String(value || '').trim();
    return /^\d{18,20}$/.test(s);
}
function toError(status, code, message) {
    return { ok: false, status, code, message };
}
async function writeAuditLog(supabase, payload) {
    await supabase.insert('audit_logs', payload, { returning: 'minimal' });
}
function toIsoDateTime(value) {
    if (!value)
        return null;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime()))
        return null;
    return d.toISOString();
}
function normalizeCommercialTerms(obj) {
    const t = obj && typeof obj === 'object' ? obj : {};
    const v = (k) => (t[k] !== undefined && t[k] !== null ? t[k] : undefined);
    const n = (x) => {
        const y = Number(x);
        return Number.isFinite(y) && y >= 0 ? y : undefined;
    };
    const up = (s) => (typeof s === 'string' ? s.toUpperCase() : undefined);
    const commitmentPeriodMonths = n(v('commitmentPeriodMonths')) ?? n(v('commitment_period_months')) ?? n(v('commitmentMonths'));
    const commitmentPeriodDays = n(v('commitmentPeriodDays')) ?? n(v('commitment_period_days')) ?? n(v('commitmentDays'));
    const expiryBoundaryRaw = up(v('expiryBoundary')) ?? up(v('expiry_boundary'));
    const expiryBoundary = (expiryBoundaryRaw === 'CALENDAR_DAY_END' || expiryBoundaryRaw === 'DURATION_EXCLUSIVE_END')
        ? expiryBoundaryRaw
        : undefined;
    return {
        commitmentPeriodMonths,
        commitmentPeriodDays,
        expiryBoundary,
    };
}
function firstDayNextMonthUtc() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1, 0, 0, 0, 0));
}
function addDaysUtc(date, days) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}
function computeCommitmentEndAt(effectiveAtIso, terms) {
    try {
        const base = new Date(effectiveAtIso);
        const months = Number(terms.commitmentPeriodMonths ?? 0);
        const days = Number(terms.commitmentPeriodDays ?? 0);
        if (Number.isFinite(months) && months > 0) {
            const y = base.getUTCFullYear();
            const m = base.getUTCMonth();
            const d = base.getUTCDate();
            return new Date(Date.UTC(m + months >= 12 ? y + Math.floor((m + months) / 12) : y, (m + months) % 12, d, base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds())).toISOString();
        }
        if (Number.isFinite(days) && days > 0) {
            return addDaysUtc(base, days).toISOString();
        }
    }
    catch {
        return null;
    }
    return null;
}
function computeOneTimeExpiry(effectiveAtIso, validityDays, expiryBoundary) {
    const days = Number(validityDays ?? 0);
    if (!effectiveAtIso || !Number.isFinite(days) || days < 1)
        return null;
    const base = new Date(effectiveAtIso);
    if (Number.isNaN(base.getTime()))
        return null;
    if (expiryBoundary === 'DURATION_EXCLUSIVE_END') {
        return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    }
    const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + (days - 1), 23, 59, 59, 999);
    return end.toISOString();
}
async function loadEnterpriseStatus(supabase, enterpriseId) {
    if (!enterpriseId)
        return null;
    const rows = await supabase.select('tenants', `select=enterprise_status&tenant_id=eq.${encodeURIComponent(enterpriseId)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row?.enterprise_status ? String(row.enterprise_status) : null;
}
async function loadSimByIccid(supabase, iccid, tenantFilter) {
    const rows = await supabase.select('sims', `select=sim_id,enterprise_id,status,iccid,supplier_id,operator_id&iccid=eq.${encodeURIComponent(iccid)}${tenantFilter}&limit=1`);
    return Array.isArray(rows) ? rows[0] : null;
}
async function loadPackageCarrierContext(supabase, packageId) {
    const pkgRows = await supabase.select('packages', `select=package_id,carrier_service_id&package_id=eq.${encodeURIComponent(packageId)}&limit=1`);
    const pkg = Array.isArray(pkgRows) ? pkgRows[0] : null;
    const carrierServiceId = pkg?.carrier_service_id ? String(pkg.carrier_service_id).trim() : '';
    if (!carrierServiceId)
        return null;
    const csRows = await supabase.select('carrier_service_modules', `select=supplier_id,operator_id&carrier_service_id=eq.${encodeURIComponent(carrierServiceId)}&limit=1`);
    const cs = Array.isArray(csRows) ? csRows[0] : null;
    if (!cs?.supplier_id)
        return null;
    return {
        supplierId: String(cs.supplier_id),
        operatorId: cs.operator_id ? String(cs.operator_id) : null,
    };
}
async function loadVendorMappingForPackage(supabase, packageId) {
    const rows = await supabase.select('vendor_product_mappings', `select=mapping_id,supplier_id,external_product_id,provisioning_parameters&package_id=eq.${encodeURIComponent(packageId)}&limit=1`);
    return Array.isArray(rows) ? rows[0] : null;
}
async function loadSellablePackage(supabase, packageId) {
    const rows = await supabase.select('packages', `select=package_id,status,commercial_terms_id,price_plan_id,effective_from&package_id=eq.${encodeURIComponent(packageId)}&limit=1`);
    const pkg = Array.isArray(rows) ? rows[0] : null;
    if (!pkg)
        return null;
    const ctid = pkg.commercial_terms_id ? String(pkg.commercial_terms_id).trim() : '';
    let commercial_terms = {};
    if (ctid) {
        const ctRows = await supabase.select('commercial_terms_modules', `select=commercial_terms&commercial_terms_id=eq.${encodeURIComponent(ctid)}&limit=1`);
        const ct = Array.isArray(ctRows) ? ctRows[0] : null;
        commercial_terms = ct?.commercial_terms ?? {};
    }
    return { ...pkg, commercial_terms };
}
async function loadPricePlanVersion(supabase, pricePlanId) {
    const rows = await supabase.select('price_plans_expanded', `select=price_plan_id,type,validity_days,expiry_boundary&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`);
    const v = Array.isArray(rows) ? rows[0] : null;
    if (!v?.price_plan_id)
        return null;
    return { version: v, plan: v };
}
async function loadLatestPricePlanVersionByPlanId(supabase, pricePlanId) {
    const rows = await supabase.select('price_plans_expanded', `select=price_plan_id,type,validity_days,expiry_boundary&price_plan_id=eq.${encodeURIComponent(pricePlanId)}&limit=1`);
    const v = Array.isArray(rows) ? rows[0] : null;
    if (!v?.price_plan_id)
        return null;
    return { version: v, plan: v };
}
function resolveExpiryBoundary(terms, pricePlanRow) {
    const fromPlan = pricePlanRow
        ? String(pricePlanRow.expiry_boundary ?? '').trim().toUpperCase()
        : '';
    if (fromPlan === 'CALENDAR_DAY_END' || fromPlan === 'DURATION_EXCLUSIVE_END')
        return fromPlan;
    return terms.expiryBoundary;
}
export async function createSubscription({ supabase, enterpriseId, iccid, packageId, kind, effectiveAt, tenantFilter, audit, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
    }
    const iccidValue = String(iccid || '').trim();
    if (!isValidIccid(iccidValue)) {
        return toError(400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.');
    }
    const pkgId = String(packageId ?? '').trim();
    if (!isValidUuid(pkgId)) {
        return toError(400, 'BAD_REQUEST', 'packageId is required and must be a valid uuid.');
    }
    const sim = await loadSimByIccid(supabase, iccidValue, tenantFilter);
    if (!sim) {
        return toError(404, 'SIM_NOT_FOUND', `sim ${iccidValue} not found.`);
    }
    if (String(sim.enterprise_id) !== String(enterpriseId)) {
        return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.');
    }
    if (String(sim.status || '').toUpperCase() === 'RETIRED') {
        return toError(409, 'SIM_RETIRED', 'SIM is retired.');
    }
    const simSupplierId = sim.supplier_id ? String(sim.supplier_id).trim() : '';
    if (!simSupplierId || !isValidUuid(simSupplierId)) {
        return toError(409, 'MISSING_SUPPLIER', 'SIM supplier is not assigned.');
    }
    const enterpriseStatus = await loadEnterpriseStatus(supabase, enterpriseId);
    if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
        return toError(409, 'ENTERPRISE_SUSPENDED', 'Enterprise is not active.');
    }
    const pkg = await loadSellablePackage(supabase, pkgId);
    if (!pkg || String(pkg.status || '').toUpperCase() !== 'PUBLISHED') {
        return toError(404, 'PACKAGE_NOT_FOUND', `package ${pkgId} not found.`);
    }
    const carrierCtx = await loadPackageCarrierContext(supabase, pkgId);
    if (!carrierCtx) {
        return toError(404, 'PACKAGE_NOT_FOUND', 'Package carrier service context not found.');
    }
    if (simSupplierId !== carrierCtx.supplierId) {
        return toError(409, 'PACKAGE_SUPPLIER_MISMATCH', 'SIM supplier does not match Package carrier service supplier.');
    }
    const simOperatorId = sim.operator_id ? String(sim.operator_id).trim() : '';
    if (carrierCtx.operatorId && simOperatorId && simOperatorId !== carrierCtx.operatorId) {
        return toError(409, 'PACKAGE_OPERATOR_MISMATCH', 'SIM operator does not match Package carrier service operator.');
    }
    const mapping = await loadVendorMappingForPackage(supabase, pkgId);
    if (!mapping?.external_product_id) {
        return toError(404, 'VENDOR_PRODUCT_MAPPING_NOT_FOUND', 'Vendor product mapping not found for package.');
    }
    if (String(mapping.supplier_id ?? '') !== carrierCtx.supplierId) {
        return toError(404, 'VENDOR_PRODUCT_MAPPING_NOT_FOUND', 'Vendor product mapping supplier mismatch.');
    }
    const effectiveIso = toIsoDateTime(effectiveAt) ?? new Date().toISOString();
    if (!effectiveIso) {
        return toError(400, 'BAD_REQUEST', 'effectiveAt must be a valid date-time.');
    }
    const now = new Date();
    const isImmediate = new Date(effectiveIso).getTime() <= now.getTime();
    const subKind = (kind && String(kind).toUpperCase() === 'ADD_ON') ? 'ADD_ON' : 'MAIN';
    if (subKind === 'MAIN') {
        const blocking = await supabase.select('subscriptions', `select=subscription_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=in.(ACTIVE,PROVISIONING)&subscription_kind=eq.MAIN&limit=1`);
        if (Array.isArray(blocking) && blocking.length > 0) {
            return toError(409, 'MAIN_SUBSCRIPTION_EXISTS', 'SIM already has an ACTIVE or PROVISIONING MAIN subscription.');
        }
        if (isImmediate) {
            const pendingMain = await supabase.select('subscriptions', `select=subscription_id&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=eq.PENDING&subscription_kind=eq.MAIN&limit=1`);
            if (Array.isArray(pendingMain) && pendingMain.length > 0) {
                return toError(409, 'MAIN_SUBSCRIPTION_EXISTS', 'SIM already has a PENDING MAIN subscription.');
            }
        }
    }
    const terms = normalizeCommercialTerms(pkg.commercial_terms);
    const commitmentEndAt = computeCommitmentEndAt(effectiveIso, terms);
    let expiresAt = null;
    const pp = pkg.price_plan_id
        ? await loadLatestPricePlanVersionByPlanId(supabase, String(pkg.price_plan_id))
        : null;
    if (pp) {
        if (pp?.plan && String(pp.plan.type || '').toUpperCase() === 'ONE_TIME') {
            const expiryBoundary = resolveExpiryBoundary(terms, pp.version);
            const validityDays = Number(pp.version?.validity_days ?? 0);
            expiresAt = computeOneTimeExpiry(effectiveIso, Number.isFinite(validityDays) ? validityDays : null, expiryBoundary);
        }
    }
    const initialState = isImmediate ? 'PROVISIONING' : 'PENDING';
    const rows = await supabase.insert('subscriptions', {
        enterprise_id: enterpriseId,
        sim_id: sim.sim_id,
        subscription_kind: subKind,
        package_id: pkg.package_id,
        state: initialState,
        effective_at: effectiveIso,
        expires_at: expiresAt,
        commitment_end_at: commitmentEndAt,
        first_subscribed_at: effectiveIso,
    });
    const created = Array.isArray(rows) ? rows[0] : null;
    const subscriptionId = created?.subscription_id ? String(created.subscription_id) : null;
    if (!subscriptionId) {
        return toError(500, 'INTERNAL_ERROR', 'Failed to create subscription.');
    }
    const idempotencyKey = audit?.requestId
        ? `${audit.requestId}:${iccidValue}:${pkgId}`
        : `sub:${iccidValue}:${pkgId}:${Date.now()}`;
    let jobId = null;
    try {
        jobId = await enqueueSubscriptionProvisionJob({
            supabase,
            subscriptionId,
            enterpriseId,
            iccid: iccidValue,
            packageId: String(pkg.package_id ?? pkgId),
            externalProductId: String(mapping.external_product_id),
            effectiveAt: effectiveIso,
            beforeState: initialState,
            audit,
            idempotencyKey,
        });
    }
    catch {
        await supabase.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(subscriptionId)}`);
        return toError(500, 'INTERNAL_ERROR', 'Failed to enqueue subscription provision job.');
    }
    if (!jobId) {
        await supabase.delete('subscriptions', `subscription_id=eq.${encodeURIComponent(subscriptionId)}`);
        return toError(500, 'INTERNAL_ERROR', 'Failed to enqueue subscription provision job.');
    }
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: enterpriseId ?? null,
        action: 'SUBSCRIPTION_CREATED',
        target_type: 'SUBSCRIPTION',
        target_id: subscriptionId,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        after_data: {
            iccid: sim.iccid ?? iccidValue,
            simId: sim.sim_id,
            packageId: pkg.package_id,
            kind: subKind,
            state: initialState,
            jobId,
            effectiveAt: effectiveIso,
            expiresAt,
            commitmentEndAt,
        },
    });
    return {
        ok: true,
        value: {
            subscriptionId,
            jobId,
            packageId: String(pkg.package_id ?? ''),
            state: initialState,
            effectiveAt: effectiveIso,
            expiresAt,
            commitmentEndAt,
        },
    };
}
export async function switchSubscription({ supabase, enterpriseId, iccid, fromSubscriptionId, newPackageId, effectiveStrategy, tenantFilter, audit, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
    }
    const iccidValue = String(iccid || '').trim();
    if (!isValidIccid(iccidValue)) {
        return toError(400, 'BAD_REQUEST', 'iccid is required and must be 18-20 digits.');
    }
    const pkgId = String(newPackageId ?? '').trim();
    if (!isValidUuid(pkgId)) {
        return toError(400, 'BAD_REQUEST', 'newPackageId is required and must be a valid uuid.');
    }
    const sim = await loadSimByIccid(supabase, iccidValue, tenantFilter);
    if (!sim) {
        return toError(404, 'SIM_NOT_FOUND', `sim ${iccidValue} not found.`);
    }
    if (String(sim.enterprise_id) !== String(enterpriseId)) {
        return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.');
    }
    if (String(sim.status || '').toUpperCase() === 'RETIRED') {
        return toError(409, 'SIM_RETIRED', 'SIM is retired.');
    }
    const enterpriseStatus = await loadEnterpriseStatus(supabase, enterpriseId);
    if (enterpriseStatus && enterpriseStatus !== 'ACTIVE') {
        return toError(409, 'ENTERPRISE_SUSPENDED', 'Enterprise is not active.');
    }
    const current = await supabase.select('subscriptions', `select=subscription_id,package_id,state,subscription_kind&sim_id=eq.${encodeURIComponent(String(sim.sim_id))}&state=eq.ACTIVE&subscription_kind=eq.MAIN&order=effective_at.desc&limit=1`);
    const from = Array.isArray(current) ? current[0] : null;
    if (!from?.subscription_id) {
        return toError(404, 'SUBSCRIPTION_NOT_FOUND', 'No active MAIN subscription.');
    }
    if (fromSubscriptionId && String(from.subscription_id) !== String(fromSubscriptionId).trim()) {
        return toError(400, 'BAD_REQUEST', 'fromSubscriptionId does not match the current MAIN subscription for this SIM.');
    }
    const pkg = await loadSellablePackage(supabase, pkgId);
    if (!pkg || String(pkg.status || '').toUpperCase() !== 'PUBLISHED') {
        return toError(404, 'PACKAGE_NOT_FOUND', `package ${pkgId} not found.`);
    }
    const strategy = String(effectiveStrategy || '').toUpperCase() === 'IMMEDIATE' ? 'IMMEDIATE' : 'NEXT_CYCLE';
    const nowIso = new Date().toISOString();
    const nextStart = firstDayNextMonthUtc();
    const effectiveIso = strategy === 'IMMEDIATE' ? nowIso : nextStart.toISOString();
    if (strategy === 'IMMEDIATE') {
        await supabase.update('subscriptions', `subscription_id=eq.${encodeURIComponent(String(from.subscription_id))}`, { state: 'CANCELLED', cancelled_at: nowIso, expires_at: nowIso });
    }
    else {
        await supabase.update('subscriptions', `subscription_id=eq.${encodeURIComponent(String(from.subscription_id))}`, { state: 'EXPIRED', cancelled_at: null, expires_at: effectiveIso });
    }
    const terms = normalizeCommercialTerms(pkg.commercial_terms);
    const commitmentEndAt = computeCommitmentEndAt(effectiveIso, terms);
    let expiresAt = null;
    const pp = pkg.price_plan_id
        ? await loadLatestPricePlanVersionByPlanId(supabase, String(pkg.price_plan_id))
        : null;
    if (pp) {
        if (pp?.plan && String(pp.plan.type || '').toUpperCase() === 'ONE_TIME') {
            const expiryBoundary = resolveExpiryBoundary(terms, pp.version);
            const validityDays = Number(pp.version?.validity_days ?? 0);
            expiresAt = computeOneTimeExpiry(effectiveIso, Number.isFinite(validityDays) ? validityDays : null, expiryBoundary);
        }
    }
    const rows = await supabase.insert('subscriptions', {
        enterprise_id: enterpriseId,
        sim_id: sim.sim_id,
        subscription_kind: 'MAIN',
        package_id: pkg.package_id,
        state: strategy === 'IMMEDIATE' ? 'ACTIVE' : 'PENDING',
        effective_at: effectiveIso,
        expires_at: expiresAt,
        commitment_end_at: commitmentEndAt,
        first_subscribed_at: effectiveIso,
    });
    const created = Array.isArray(rows) ? rows[0] : null;
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
                packageId: String(from?.package_id ?? ''),
                state: String(from?.state ?? ''),
            },
            after_data: {
                subscriptionId: String(created?.subscription_id ?? ''),
                packageId: pkg.package_id,
                state: strategy === 'IMMEDIATE' ? 'ACTIVE' : 'PENDING',
                effectiveAt: effectiveIso,
            },
        });
    }
    return {
        ok: true,
        value: {
            cancelledSubscriptionId: String(from.subscription_id ?? ''),
            newSubscriptionId: String(created?.subscription_id ?? ''),
            effectiveAt: effectiveIso,
        },
    };
}
export async function cancelSubscription({ supabase, enterpriseId, subscriptionId, immediate, audit, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
    }
    const id = String(subscriptionId || '').trim();
    if (!isValidUuid(id)) {
        return toError(400, 'BAD_REQUEST', 'subscriptionId must be a valid uuid.');
    }
    const rows = await supabase.select('subscriptions', `select=subscription_id,enterprise_id,state,subscription_kind,expires_at&subscription_id=eq.${encodeURIComponent(id)}&limit=1`);
    const sub = Array.isArray(rows) ? rows[0] : null;
    if (!sub) {
        return toError(404, 'SUBSCRIPTION_NOT_FOUND', `subscription ${id} not found.`);
    }
    if (String(sub.enterprise_id) !== String(enterpriseId)) {
        return toError(403, 'FORBIDDEN', 'Subscription does not belong to your enterprise.');
    }
    const nowIso = new Date().toISOString();
    const shouldImmediate = String(immediate || '').toLowerCase() === 'true';
    const state = String(sub.state ?? '').toUpperCase();
    const endOfPeriodIso = new Date(firstDayNextMonthUtc().getTime() - 1000).toISOString();
    if (state === 'ACTIVE') {
        if (shouldImmediate) {
            return toError(400, 'BAD_REQUEST', 'ACTIVE subscription cannot be cancelled immediately. Use immediate=false.');
        }
        const kind = String(sub.subscription_kind ?? 'MAIN').toUpperCase();
        const subExpires = sub.expires_at ? new Date(String(sub.expires_at)) : null;
        const scheduledExecuteAt = kind === 'ADD_ON' && subExpires && !Number.isNaN(subExpires.getTime())
            ? subExpires.toISOString()
            : firstDayNextMonthUtc().toISOString();
        const expiresAt = sub.expires_at != null && String(sub.expires_at).trim() !== ''
            ? String(sub.expires_at)
            : endOfPeriodIso;
        try {
            const existing = await supabase.select('subscription_cancel_schedules', `select=schedule_id&subscription_id=eq.${encodeURIComponent(id)}&status=eq.PENDING&limit=1`);
            if (Array.isArray(existing) && existing.length > 0) {
                return toError(409, 'CANCEL_ALREADY_SCHEDULED', 'Cancel is already scheduled for this subscription.');
            }
            await supabase.insert('subscription_cancel_schedules', {
                subscription_id: id,
                scheduled_execute_at: scheduledExecuteAt,
                status: 'PENDING',
            }, { returning: 'minimal' });
        }
        catch (err) {
            const body = String(err?.body || err?.message || '');
            if (body.includes('subscription_cancel_schedules') ||
                body.includes('PGRST205') ||
                body.includes('does not exist')) {
                return toError(503, 'MIGRATION_REQUIRED', 'subscription_cancel_schedules table is not available. Run database migrations.');
            }
            throw err;
        }
        await writeAuditLog(supabase, {
            actor_user_id: audit?.actorUserId ?? null,
            actor_role: audit?.actorRole ?? null,
            tenant_id: enterpriseId ?? null,
            action: 'SUBSCRIPTION_CANCEL_SCHEDULED',
            target_type: 'SUBSCRIPTION',
            target_id: id,
            request_id: audit?.requestId ?? null,
            source_ip: audit?.sourceIp ?? null,
            before_data: { state },
            after_data: { scheduled: true, scheduledExecuteAt, expiresAt },
        });
        return {
            ok: true,
            value: {
                subscriptionId: id,
                state: 'ACTIVE',
                scheduled: true,
                scheduledExecuteAt,
                expiresAt,
                message: 'Cancel scheduled at end of billing period.',
            },
        };
    }
    const expiresAt = shouldImmediate ? nowIso : endOfPeriodIso;
    const nextState = shouldImmediate ? 'CANCELLED' : 'EXPIRED';
    await supabase.update('subscriptions', `subscription_id=eq.${encodeURIComponent(id)}`, { state: nextState, cancelled_at: shouldImmediate ? nowIso : null, expires_at: expiresAt });
    await writeAuditLog(supabase, {
        actor_user_id: audit?.actorUserId ?? null,
        actor_role: audit?.actorRole ?? null,
        tenant_id: enterpriseId ?? null,
        action: 'SUBSCRIPTION_CANCELLED',
        target_type: 'SUBSCRIPTION',
        target_id: id,
        request_id: audit?.requestId ?? null,
        source_ip: audit?.sourceIp ?? null,
        before_data: { state },
        after_data: { state: nextState, expiresAt, immediate: shouldImmediate },
    });
    return { ok: true, value: { subscriptionId: id, state: nextState, expiresAt } };
}
export async function listSimSubscriptions({ supabase, enterpriseId, simIdentifier, tenantFilter, state, kind, page, pageSize, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
    }
    let simId = simIdentifier.field === 'sim_id' ? simIdentifier.value : '';
    if (!simId) {
        const sim = await loadSimByIccid(supabase, simIdentifier.value, tenantFilter);
        if (!sim) {
            return toError(404, 'SIM_NOT_FOUND', `sim ${simIdentifier.value} not found.`);
        }
        if (String(sim.enterprise_id) !== String(enterpriseId)) {
            return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.');
        }
        simId = String(sim.sim_id);
    }
    const pageNum = Math.max(1, Number(page ?? 1) || 1);
    const sizeNum = Math.min(200, Math.max(1, Number(pageSize ?? 20) || 20));
    const offset = (pageNum - 1) * sizeNum;
    const filters = [
        `sim_id=eq.${encodeURIComponent(simId)}`,
    ];
    const stateValue = String(state || '').toUpperCase();
    if (stateValue === 'PENDING' || stateValue === 'ACTIVE' || stateValue === 'CANCELLED' || stateValue === 'EXPIRED') {
        filters.push(`state=eq.${encodeURIComponent(stateValue)}`);
    }
    const kindValue = String(kind || '').toUpperCase();
    if (kindValue === 'MAIN' || kindValue === 'ADD_ON') {
        filters.push(`subscription_kind=eq.${encodeURIComponent(kindValue)}`);
    }
    const query = `select=subscription_id,package_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&${filters.join('&')}&order=effective_at.desc&limit=${sizeNum}&offset=${offset}`;
    const { data, total } = await supabase.selectWithCount('subscriptions', query);
    const rows = Array.isArray(data) ? data : [];
    const packageIds = rows.map((r) => String(r.package_id || '')).filter(Boolean);
    const packageMap = new Map();
    if (packageIds.length) {
        const unique = Array.from(new Set(packageIds));
        const packages = await supabase.select('packages', `select=package_id,name&package_id=in.(${unique.map((v) => encodeURIComponent(v)).join(',')})`);
        if (Array.isArray(packages)) {
            for (const p of packages) {
                const row = p;
                if (row.package_id)
                    packageMap.set(String(row.package_id), row);
            }
        }
    }
    const items = rows.map((row) => {
        const pid = String(row.package_id || '');
        const pkg = pid ? packageMap.get(pid) : null;
        return {
            subscriptionId: String(row.subscription_id || ''),
            packageId: pid,
            packageName: pkg?.name ?? null,
            kind: String(row.subscription_kind || ''),
            state: String(row.state || ''),
            effectiveAt: row.effective_at ?? null,
            expiresAt: row.expires_at ?? null,
            cancelledAt: row.cancelled_at ?? null,
            firstSubscribedAt: row.first_subscribed_at ?? null,
            commitmentEndAt: row.commitment_end_at ?? null,
        };
    });
    return {
        ok: true,
        value: {
            items,
            total: Number(total ?? items.length),
            page: pageNum,
            pageSize: sizeNum,
        },
    };
}
function mapSubscriptionRowsToItems(rows, packageMap, simMap) {
    return rows.map((row) => {
        const pid = String(row.package_id || '');
        const pkg = pid ? packageMap.get(pid) : null;
        const sid = String(row.sim_id || '');
        const sim = sid ? simMap.get(sid) : null;
        return {
            subscriptionId: String(row.subscription_id || ''),
            enterpriseId: String(row.enterprise_id || ''),
            simId: sid,
            iccid: sim?.iccid != null ? String(sim.iccid) : null,
            packageId: pid,
            packageName: pkg?.name != null ? String(pkg.name) : null,
            kind: String(row.subscription_kind || ''),
            state: String(row.state || ''),
            effectiveAt: row.effective_at ?? null,
            expiresAt: row.expires_at ?? null,
            cancelledAt: row.cancelled_at ?? null,
            firstSubscribedAt: row.first_subscribed_at ?? null,
            commitmentEndAt: row.commitment_end_at ?? null,
        };
    });
}
export async function listSubscriptions({ supabase, enterpriseId, iccid, state, kind, page, pageSize, tenantFilter, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
    }
    const filters = [`enterprise_id=eq.${encodeURIComponent(enterpriseId)}`];
    const iccidValue = String(iccid || '').trim();
    if (iccidValue) {
        if (!isValidIccid(iccidValue)) {
            return toError(400, 'BAD_REQUEST', 'iccid must be 18-20 digits.');
        }
        const sim = await loadSimByIccid(supabase, iccidValue, tenantFilter);
        if (!sim) {
            return toError(404, 'SIM_NOT_FOUND', `sim ${iccidValue} not found.`);
        }
        if (String(sim.enterprise_id) !== String(enterpriseId)) {
            return toError(403, 'FORBIDDEN', 'SIM does not belong to your enterprise.');
        }
        filters.push(`sim_id=eq.${encodeURIComponent(String(sim.sim_id))}`);
    }
    const pageNum = Math.max(1, Number(page ?? 1) || 1);
    const sizeNum = Math.min(200, Math.max(1, Number(pageSize ?? 20) || 20));
    const offset = (pageNum - 1) * sizeNum;
    const stateValue = String(state || '').toUpperCase();
    if (stateValue === 'PENDING' || stateValue === 'ACTIVE' || stateValue === 'CANCELLED' || stateValue === 'EXPIRED') {
        filters.push(`state=eq.${encodeURIComponent(stateValue)}`);
    }
    const kindValue = String(kind || '').toUpperCase();
    if (kindValue === 'MAIN' || kindValue === 'ADD_ON') {
        filters.push(`subscription_kind=eq.${encodeURIComponent(kindValue)}`);
    }
    const query = `select=subscription_id,sim_id,enterprise_id,package_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&${filters.join('&')}&order=effective_at.desc&limit=${sizeNum}&offset=${offset}`;
    const { data, total } = await supabase.selectWithCount('subscriptions', query);
    const rows = Array.isArray(data) ? data : [];
    const packageIds = rows.map((r) => String(r.package_id || '')).filter(Boolean);
    const packageMap = new Map();
    if (packageIds.length) {
        const unique = Array.from(new Set(packageIds));
        const packages = await supabase.select('packages', `select=package_id,name&package_id=in.(${unique.map((v) => encodeURIComponent(v)).join(',')})`);
        if (Array.isArray(packages)) {
            for (const p of packages) {
                const row = p;
                if (row.package_id)
                    packageMap.set(String(row.package_id), row);
            }
        }
    }
    const simIds = rows.map((r) => String(r.sim_id || '')).filter(Boolean);
    const simMap = new Map();
    if (simIds.length) {
        const uniqueSims = Array.from(new Set(simIds));
        const sims = await supabase.select('sims', `select=sim_id,iccid&sim_id=in.(${uniqueSims.map((v) => encodeURIComponent(v)).join(',')})`);
        if (Array.isArray(sims)) {
            for (const s of sims) {
                const row = s;
                if (row.sim_id)
                    simMap.set(String(row.sim_id), row);
            }
        }
    }
    const items = mapSubscriptionRowsToItems(rows, packageMap, simMap);
    return {
        ok: true,
        value: {
            items,
            total: Number(total ?? items.length),
            page: pageNum,
            pageSize: sizeNum,
        },
    };
}
export async function getSubscription({ supabase, enterpriseId, subscriptionId, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
    }
    const id = String(subscriptionId || '').trim();
    if (!isValidUuid(id)) {
        return toError(400, 'BAD_REQUEST', 'subscriptionId must be a valid uuid.');
    }
    const rows = await supabase.select('subscriptions', `select=subscription_id,sim_id,enterprise_id,package_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&subscription_id=eq.${encodeURIComponent(id)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
        return toError(404, 'SUBSCRIPTION_NOT_FOUND', `subscription ${id} not found.`);
    }
    if (String(row.enterprise_id) !== String(enterpriseId)) {
        return toError(403, 'FORBIDDEN', 'Subscription does not belong to your enterprise.');
    }
    const packageMap = new Map();
    const pid = String(row.package_id || '');
    if (pid) {
        const pkgs = await supabase.select('packages', `select=package_id,name&package_id=eq.${encodeURIComponent(pid)}&limit=1`);
        const p = Array.isArray(pkgs) ? pkgs[0] : null;
        if (p?.package_id)
            packageMap.set(String(p.package_id), p);
    }
    const simMap = new Map();
    const sid = String(row.sim_id || '');
    if (sid) {
        const simRows = await supabase.select('sims', `select=sim_id,iccid&sim_id=eq.${encodeURIComponent(sid)}&limit=1`);
        const s = Array.isArray(simRows) ? simRows[0] : null;
        if (s?.sim_id)
            simMap.set(String(s.sim_id), s);
    }
    const [item] = mapSubscriptionRowsToItems([row], packageMap, simMap);
    return { ok: true, value: item };
}
function clampIntEnv(name, fallback, min, max) {
    const n = Number(process.env[name]);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}
/** Max non-empty lines in ICCID upload files for subscription batch APIs. */
export const SUBSCRIPTION_BATCH_MAX_ICCID_LINES = clampIntEnv('SUBSCRIPTION_BATCH_MAX_ICCID_LINES', 5000, 1, 100_000);
/** Max multipart body size (bytes) for subscription batch upload. */
export const SUBSCRIPTION_BATCH_MAX_BYTES = clampIntEnv('SUBSCRIPTION_BATCH_MAX_BYTES', 10 * 1024 * 1024, 4096, 50 * 1024 * 1024);
function stripLeadingBom(text) {
    if (text.charCodeAt(0) === 0xfeff)
        return text.slice(1);
    return text;
}
/** Non-empty trimmed lines from an ICCID list file (UTF-8; strips BOM). */
export function splitIccidFileLines(fileText) {
    const t = stripLeadingBom(String(fileText ?? ''));
    const lines = t.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
        const s = line.trim();
        if (s)
            out.push(s);
    }
    return out;
}
export async function batchCreateSubscriptions({ supabase, enterpriseId, packageId, kind, effectiveAt, fileText, tenantFilter, audit, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
    }
    const pkgId = String(packageId ?? '').trim();
    if (!isValidUuid(pkgId)) {
        return toError(400, 'BAD_REQUEST', 'packageId is required and must be a valid uuid.');
    }
    const lines = splitIccidFileLines(fileText);
    if (lines.length > SUBSCRIPTION_BATCH_MAX_ICCID_LINES) {
        return toError(400, 'BAD_REQUEST', `At most ${SUBSCRIPTION_BATCH_MAX_ICCID_LINES} ICCID lines allowed.`);
    }
    const validPatternLines = lines.filter((l) => isValidIccid(l));
    if (validPatternLines.length === 0) {
        return toError(400, 'BAD_REQUEST', 'No valid ICCID lines in file.');
    }
    const results = [];
    const seen = new Set();
    for (const line of lines) {
        if (!isValidIccid(line)) {
            results.push({
                iccid: line,
                ok: false,
                code: 'INVALID_ICCID',
                message: 'iccid must be 18-20 digits.',
            });
            continue;
        }
        if (seen.has(line)) {
            results.push({
                iccid: line,
                ok: false,
                code: 'DUPLICATE_IN_FILE',
                message: 'Duplicate ICCID in file.',
            });
            continue;
        }
        seen.add(line);
        const sub = await createSubscription({
            supabase,
            enterpriseId,
            iccid: line,
            packageId: pkgId,
            kind,
            effectiveAt,
            tenantFilter,
            audit,
        });
        if (!sub.ok) {
            results.push({ iccid: line, ok: false, code: sub.code, message: sub.message });
        }
        else {
            results.push({
                iccid: line,
                ok: true,
                subscriptionId: sub.value.subscriptionId ?? undefined,
                jobId: sub.value.jobId ?? undefined,
                packageId: sub.value.packageId ?? undefined,
                state: sub.value.state,
                effectiveAt: sub.value.effectiveAt,
                expiresAt: sub.value.expiresAt,
                commitmentEndAt: sub.value.commitmentEndAt,
            });
        }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return {
        ok: true,
        value: {
            summary: { total: results.length, succeeded, failed: results.length - succeeded },
            results,
        },
    };
}
function escapeCsvCell(value) {
    if (value === null || value === undefined)
        return '';
    const s = String(value);
    if (/[",\r\n]/.test(s))
        return `"${s.replace(/"/g, '""')}"`;
    return s;
}
async function loadPackageNamesMap(supabase, packageIds) {
    const packageMap = new Map();
    const unique = Array.from(new Set(packageIds.filter(Boolean)));
    if (!unique.length)
        return packageMap;
    const packages = await supabase.select('packages', `select=package_id,name&package_id=in.(${unique.map((v) => encodeURIComponent(v)).join(',')})`);
    if (Array.isArray(packages)) {
        for (const p of packages) {
            const row = p;
            if (row.package_id)
                packageMap.set(String(row.package_id), row);
        }
    }
    return packageMap;
}
export async function batchExportSubscriptions({ supabase, enterpriseId, fileText, scope, kind, tenantFilter, }) {
    if (!isValidUuid(enterpriseId)) {
        return toError(400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
    }
    const scopeRaw = String(scope ?? 'CURRENT').trim().toUpperCase();
    const exportScope = scopeRaw === 'ALL' ? 'ALL' : scopeRaw === 'CURRENT' ? 'CURRENT' : null;
    if (!exportScope) {
        return toError(400, 'BAD_REQUEST', 'scope must be CURRENT or ALL.');
    }
    const kindRaw = String(kind ?? '').trim().toUpperCase();
    const kindFilter = kindRaw === '' ? null : kindRaw === 'MAIN' || kindRaw === 'ADD_ON' ? kindRaw : null;
    if (kindRaw !== '' && !kindFilter) {
        return toError(400, 'BAD_REQUEST', 'kind must be MAIN or ADD_ON.');
    }
    const lines = splitIccidFileLines(fileText);
    if (lines.length > SUBSCRIPTION_BATCH_MAX_ICCID_LINES) {
        return toError(400, 'BAD_REQUEST', `At most ${SUBSCRIPTION_BATCH_MAX_ICCID_LINES} ICCID lines allowed.`);
    }
    if (lines.filter((l) => isValidIccid(l)).length === 0) {
        return toError(400, 'BAD_REQUEST', 'No valid ICCID lines in file.');
    }
    const header = [
        'iccid',
        'rowStatus',
        'errorCode',
        'message',
        'subscriptionId',
        'packageId',
        'packageName',
        'kind',
        'state',
        'effectiveAt',
        'expiresAt',
        'cancelledAt',
        'firstSubscribedAt',
        'commitmentEndAt',
    ];
    const csvRows = [header];
    const seen = new Set();
    for (const line of lines) {
        if (!isValidIccid(line)) {
            csvRows.push([
                line,
                'INVALID_ICCID',
                'BAD_REQUEST',
                'iccid must be 18-20 digits.',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
            ]);
            continue;
        }
        if (seen.has(line))
            continue;
        seen.add(line);
        const sim = await loadSimByIccid(supabase, line, tenantFilter);
        if (!sim) {
            csvRows.push([line, 'SIM_NOT_FOUND', 'SIM_NOT_FOUND', `sim ${line} not found.`, '', '', '', '', '', '', '', '', '', '']);
            continue;
        }
        if (String(sim.enterprise_id) !== String(enterpriseId)) {
            csvRows.push([
                line,
                'FORBIDDEN',
                'FORBIDDEN',
                'SIM does not belong to your enterprise.',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
            ]);
            continue;
        }
        const simId = String(sim.sim_id);
        const filters = [
            `sim_id=eq.${encodeURIComponent(simId)}`,
            `enterprise_id=eq.${encodeURIComponent(enterpriseId)}`,
        ];
        if (exportScope === 'CURRENT') {
            filters.push('state=in.(ACTIVE,PENDING)');
        }
        if (kindFilter) {
            filters.push(`subscription_kind=eq.${encodeURIComponent(kindFilter)}`);
        }
        const query = `select=subscription_id,package_id,subscription_kind,state,effective_at,expires_at,cancelled_at,first_subscribed_at,commitment_end_at&${filters.join('&')}&order=effective_at.desc&limit=2000`;
        const subRowsRaw = await supabase.select('subscriptions', query);
        const rows = Array.isArray(subRowsRaw) ? subRowsRaw : [];
        if (rows.length === 0) {
            csvRows.push([
                line,
                'NO_SUBSCRIPTIONS',
                '',
                'No matching subscriptions.',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
                '',
            ]);
            continue;
        }
        const packageMap = await loadPackageNamesMap(supabase, rows.map((r) => String(r.package_id || '')));
        for (const row of rows) {
            const pid = String(row.package_id || '');
            const pkg = pid ? packageMap.get(pid) : null;
            const pkgName = pkg?.name != null ? String(pkg.name) : '';
            csvRows.push([
                line,
                'OK',
                '',
                '',
                String(row.subscription_id || ''),
                pid,
                pkgName,
                String(row.subscription_kind || ''),
                String(row.state || ''),
                row.effective_at != null ? String(row.effective_at) : '',
                row.expires_at != null ? String(row.expires_at) : '',
                row.cancelled_at != null ? String(row.cancelled_at) : '',
                row.first_subscribed_at != null ? String(row.first_subscribed_at) : '',
                row.commitment_end_at != null ? String(row.commitment_end_at) : '',
            ]);
        }
    }
    const csvBody = csvRows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
    const csvText = `\uFEFF${csvBody}`;
    const filename = `subscriptions-export-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    return { ok: true, value: { csvText, filename } };
}
