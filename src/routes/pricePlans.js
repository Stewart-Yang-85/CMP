import { createPricePlan, listPricePlans, getPricePlanDetail, updatePricePlan, publishPricePlan, deprecatePricePlan, loadPricePlan, } from '../services/pricePlan.js';
import { actorUserIdForDb } from '../utils/actorUserId.js';
export function registerPricePlanRoutes({ app, prefix, deps }) {
    const { createSupabaseRestClient, getTraceId, sendError, ensureResellerAdmin, ensureResellerSales, resolveEnterpriseForReseller, isValidUuid, } = deps;
    /**
     * Effective reseller tenant_id: platform MUST pass `resellerId` query param; reseller MAY omit (uses token).
     */
    function resolveResellerIdForPricePlanRoute(req, res, auth, queryResellerId) {
        const q = String(queryResellerId ?? '').trim();
        if (auth.scope === 'platform') {
            if (!q || !isValidUuid(q)) {
                sendError(res, 400, 'BAD_REQUEST', 'resellerId query parameter is required and must be a valid uuid.');
                return null;
            }
            return q;
        }
        if (auth.scope === 'reseller') {
            const tokenR = String(req?.cmpAuth?.resellerId ?? '').trim();
            if (!tokenR) {
                sendError(res, 403, 'FORBIDDEN', 'Reseller scope required.');
                return null;
            }
            if (q && q !== tokenR) {
                sendError(res, 403, 'FORBIDDEN', 'resellerId does not match the authenticated reseller.');
                return null;
            }
            return q || tokenR;
        }
        sendError(res, 403, 'FORBIDDEN', 'Insufficient permissions.');
        return null;
    }
    /** Reseller tokens: price plan row must match reseller_id (or legacy rows: enterprise under reseller). */
    async function assertPricePlanResellerScope(req, res, supabase, auth, pricePlanId) {
        if (auth.scope !== 'reseller')
            return true;
        const plan = await loadPricePlan(supabase, pricePlanId);
        if (!plan) {
            sendError(res, 404, 'NOT_FOUND', 'Price plan not found.');
            return false;
        }
        const tokenR = String(req?.cmpAuth?.resellerId ?? '').trim();
        const rowR = String(plan.reseller_id ?? '').trim();
        if (rowR && tokenR && rowR === tokenR)
            return true;
        if (rowR && tokenR && rowR !== tokenR) {
            sendError(res, 403, 'FORBIDDEN', 'Price plan is out of reseller scope.');
            return false;
        }
        const enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, String(plan.enterprise_id));
        return !!enterpriseId;
    }
    app.post(`${prefix}/enterprises/:enterpriseId/price-plans`, async (req, res) => {
        const auth = ensureResellerAdmin(req, res);
        if (!auth)
            return;
        const enterpriseIdParam = String(req.params.enterpriseId || '').trim();
        if (!isValidUuid(enterpriseIdParam)) {
            return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
        }
        const qReseller = String(req.query?.resellerId ?? req.query?.reseller_id ?? '').trim();
        const resellerId = resolveResellerIdForPricePlanRoute(req, res, auth, qReseller || null);
        if (!resellerId)
            return;
        const audit = {
            actorUserId: actorUserIdForDb(req?.cmpAuth?.userId),
            actorRole: req?.cmpAuth?.role ?? null,
            requestId: getTraceId(res),
            sourceIp: req.ip,
        };
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) });
        let enterpriseId = enterpriseIdParam;
        if (auth.scope === 'reseller') {
            enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam);
            if (!enterpriseId)
                return;
        }
        const result = await createPricePlan({ supabase, enterpriseId, resellerId, payload: req.body ?? {}, audit });
        if (!result.ok)
            return sendError(res, result.status, result.code, result.message);
        res.code().send(result.value);
    });
    app.get(`${prefix}/enterprises/:enterpriseId/price-plans`, async (req, res) => {
        const auth = ensureResellerSales(req, res);
        if (!auth)
            return;
        const enterpriseIdParam = String(req.params.enterpriseId || '').trim();
        if (!isValidUuid(enterpriseIdParam)) {
            return sendError(res, 400, 'BAD_REQUEST', 'enterpriseId must be a valid uuid.');
        }
        const qReseller = String(req.query?.resellerId ?? req.query?.reseller_id ?? '').trim();
        const resellerId = resolveResellerIdForPricePlanRoute(req, res, auth, qReseller || null);
        if (!resellerId)
            return;
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) });
        let enterpriseId = enterpriseIdParam;
        if (auth.scope === 'reseller') {
            enterpriseId = await resolveEnterpriseForReseller(req, res, supabase, enterpriseIdParam);
            if (!enterpriseId)
                return;
        }
        const { type, status, page, pageSize } = req.query ?? {};
        const result = await listPricePlans({ supabase, enterpriseId, resellerId, type, status, page, pageSize });
        if (!result.ok)
            return sendError(res, result.status, result.code, result.message);
        res.send(result.value);
    });
    app.get(`${prefix}/price-plans/:pricePlanId`, async (req, res) => {
        const auth = ensureResellerSales(req, res);
        if (!auth)
            return;
        const pricePlanId = String(req.params.pricePlanId || '').trim();
        if (!isValidUuid(pricePlanId)) {
            return sendError(res, 400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.');
        }
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) });
        const allowed = await assertPricePlanResellerScope(req, res, supabase, auth, pricePlanId);
        if (!allowed)
            return;
        const result = await getPricePlanDetail({ supabase, pricePlanId });
        if (!result.ok)
            return sendError(res, result.status, result.code, result.message);
        res.send(result.value);
    });
    app.put(`${prefix}/price-plans/:pricePlanId`, async (req, res) => {
        const auth = ensureResellerAdmin(req, res);
        if (!auth)
            return;
        const pricePlanId = String(req.params.pricePlanId || '').trim();
        if (!isValidUuid(pricePlanId)) {
            return sendError(res, 400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.');
        }
        const audit = {
            actorUserId: actorUserIdForDb(req?.cmpAuth?.userId),
            actorRole: req?.cmpAuth?.role ?? null,
            requestId: getTraceId(res),
            sourceIp: req.ip,
        };
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) });
        const allowed = await assertPricePlanResellerScope(req, res, supabase, auth, pricePlanId);
        if (!allowed)
            return;
        const result = await updatePricePlan({ supabase, pricePlanId, payload: req.body ?? {}, audit });
        if (!result.ok)
            return sendError(res, result.status, result.code, result.message);
        res.send(result.value);
    });
    app.post(`${prefix}/price-plans/:pricePlanId\\:publish`, async (req, res) => {
        const auth = ensureResellerAdmin(req, res);
        if (!auth)
            return;
        const pricePlanId = String(req.params.pricePlanId || '').trim();
        if (!isValidUuid(pricePlanId)) {
            return sendError(res, 400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.');
        }
        const audit = {
            actorUserId: actorUserIdForDb(req?.cmpAuth?.userId),
            actorRole: req?.cmpAuth?.role ?? null,
            requestId: getTraceId(res),
            sourceIp: req.ip,
        };
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) });
        const allowed = await assertPricePlanResellerScope(req, res, supabase, auth, pricePlanId);
        if (!allowed)
            return;
        const result = await publishPricePlan({ supabase, pricePlanId, audit });
        if (!result.ok)
            return sendError(res, result.status, result.code, result.message);
        res.send(result.value);
    });
    app.post(`${prefix}/price-plans/:pricePlanId\\:deprecate`, async (req, res) => {
        const auth = ensureResellerAdmin(req, res);
        if (!auth)
            return;
        const pricePlanId = String(req.params.pricePlanId || '').trim();
        if (!isValidUuid(pricePlanId)) {
            return sendError(res, 400, 'BAD_REQUEST', 'pricePlanId must be a valid uuid.');
        }
        const audit = {
            actorUserId: actorUserIdForDb(req?.cmpAuth?.userId),
            actorRole: req?.cmpAuth?.role ?? null,
            requestId: getTraceId(res),
            sourceIp: req.ip,
        };
        const supabase = createSupabaseRestClient({ useServiceRole: true, traceId: getTraceId(res) });
        const allowed = await assertPricePlanResellerScope(req, res, supabase, auth, pricePlanId);
        if (!allowed)
            return;
        const result = await deprecatePricePlan({ supabase, pricePlanId, audit });
        if (!result.ok)
            return sendError(res, result.status, result.code, result.message);
        res.send(result.value);
    });
}
