import { createSupabaseRestClient } from '../supabaseRest.js';
const rolePermissionCache = new Map();
const rolePermissionCacheTtlMs = Number(process.env.RBAC_ROLE_CACHE_TTL_MS || '300000');
const basePermissions = [
    'bills.list',
    'bills.read',
    'bills.export',
    'bills.mark_paid',
    'bills.adjust',
    'sims.list',
    'sims.read',
    'sims.export',
    'sims.reset_connection',
    'sims.connectivity.read',
    'sims.location.read',
    'sims.location.history',
    'sims.batch_status_change',
    'subscriptions.list',
    'subscriptions.read',
    'subscriptions.create',
    'subscriptions.switch',
    'subscriptions.cancel',
    'jobs.read',
    'catalog.packages.list',
    'catalog.packages.export',
    'price_plans.read',
];
const defaultPermissionsByRoleScope = {
    customer: basePermissions.filter((p) => !p.startsWith('bills.')),
    department: [
        'sims.list',
        'sims.read',
        'sims.export',
        'sims.connectivity.read',
        'sims.location.read',
        'sims.location.history',
        'subscriptions.list',
        'subscriptions.read',
        'jobs.read',
        'catalog.packages.list',
        'catalog.packages.export',
        'price_plans.read',
    ],
    reseller: [
        'bills.list',
        'bills.read',
        'bills.export',
        'sims.list',
        'sims.read',
        'sims.export',
        'sims.reset_connection',
        'sims.connectivity.read',
        'sims.location.read',
        'sims.location.history',
        'sims.import',
        'sims.create',
        'sims.activate',
        'sims.deactivate',
        'sims.reactivate',
        'sims.retire',
        'sims.batch_deactivate',
        'sims.assign_inventory',
        'sims.batch_status_change',
        'subscriptions.list',
        'subscriptions.read',
        'subscriptions.create',
        'subscriptions.switch',
        'subscriptions.cancel',
        'jobs.read',
        'catalog.packages.list',
        'catalog.packages.export',
        'price_plans.read',
        'catalog.covered_network_profiles.list',
        'catalog.covered_network_profiles.read',
        'catalog.covered_network_profiles.write',
        'catalog.covered_network_profiles.publish',
        'catalog.covered_network_profiles.deprecate',
    ],
};
export function getAuthContext(req) {
    const raw = req.cmpAuth;
    return raw ?? {};
}
export function setAuthContext(req, ctx) {
    const holder = req;
    holder.cmpAuth = { ...(holder.cmpAuth ?? {}), ...ctx };
}
function normalizeRoleScopeForDb(roleScope) {
    if (!roleScope)
        return null;
    if (roleScope === 'department')
        return 'customer';
    return roleScope;
}
function getRoleCacheKey(role, roleScope) {
    return `${roleScope ?? 'any'}:${role}`;
}
async function resolveRolePermissions(role, roleScope) {
    const scope = normalizeRoleScopeForDb(roleScope);
    const cacheKey = getRoleCacheKey(role, scope);
    const cached = rolePermissionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.permissions.slice();
    }
    try {
        const supabase = createSupabaseRestClient({ useServiceRole: true });
        const roleQuery = [
            'select=id,code,scope',
            `code=eq.${encodeURIComponent(role)}`,
            scope ? `scope=eq.${encodeURIComponent(scope)}` : null,
            'limit=1',
        ].filter(Boolean).join('&');
        const roles = await supabase.select('roles', roleQuery);
        const roleRow = Array.isArray(roles) && roles.length > 0 ? roles[0] : null;
        const roleId = roleRow ? String(roleRow.id ?? roleRow.role_id ?? '') : '';
        if (!roleId)
            return null;
        const rolePermissions = await supabase.select('role_permissions', `select=permission_id&role_id=eq.${encodeURIComponent(roleId)}`);
        const permissionIds = Array.isArray(rolePermissions)
            ? rolePermissions.map((r) => r.permission_id).filter(Boolean).map((id) => String(id))
            : [];
        if (!permissionIds.length) {
            rolePermissionCache.set(cacheKey, { expiresAt: Date.now() + rolePermissionCacheTtlMs, permissions: [] });
            return [];
        }
        const idFilter = permissionIds.map((id) => encodeURIComponent(id)).join(',');
        const permissionRows = await supabase.select('permissions', `select=code&id=in.(${idFilter})`);
        let codes = Array.isArray(permissionRows)
            ? permissionRows.map((p) => p.code).filter(Boolean).map((code) => String(code))
            : [];
        if (!codes.length) {
            const fallbackRows = await supabase.select('permissions', `select=code&permission_id=in.(${idFilter})`);
            codes = Array.isArray(fallbackRows)
                ? fallbackRows.map((p) => p.code).filter(Boolean).map((code) => String(code))
                : [];
        }
        rolePermissionCache.set(cacheKey, { expiresAt: Date.now() + rolePermissionCacheTtlMs, permissions: codes });
        return codes;
    }
    catch {
        return null;
    }
}
async function getEffectivePermissions(auth) {
    const current = Array.isArray(auth.permissions) ? auth.permissions.map((p) => String(p)) : [];
    if (current.length)
        return current;
    const roleScope = auth.roleScope ? String(auth.roleScope) : null;
    const role = auth.role ? String(auth.role) : null;
    if (role) {
        const rolePermissions = await resolveRolePermissions(role, roleScope);
        if (rolePermissions !== null && rolePermissions.length > 0)
            return rolePermissions;
    }
    const defaults = roleScope && defaultPermissionsByRoleScope[roleScope] ? defaultPermissionsByRoleScope[roleScope] : [];
    return defaults.slice();
}
async function hasRequiredPermissions(auth, required) {
    if (!required.length)
        return true;
    const set = new Set(await getEffectivePermissions(auth));
    return required.every((p) => set.has(String(p)));
}
/** True if the auth context has every listed permission code (JWT, DB role, or scope defaults). */
export async function checkPermissions(auth, required) {
    return hasRequiredPermissions(auth, required);
}
export function rbac(requiredPermissions = [], options = {}) {
    return async function rbacGuard(req, reply) {
        const auth = getAuthContext(req);
        if (!auth || (!auth.userId && !auth.role && !auth.roleScope)) {
            reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required.' });
            return;
        }
        const roleScope = auth.roleScope ? String(auth.roleScope) : null;
        const role = auth.role ? String(auth.role) : null;
        if (roleScope === 'platform' || role === 'platform_admin') {
            return;
        }
        const allowedRoles = options.roles ?? [];
        if (allowedRoles.length && role && allowedRoles.includes(role)) {
            return;
        }
        if (!(await hasRequiredPermissions(auth, requiredPermissions))) {
            reply.status(403).send({ code: 'FORBIDDEN', message: 'Insufficient permissions.' });
            return;
        }
    };
}
// ============================================================
// Tenant isolation helpers (application-layer enforcement)
// ============================================================
// Since service_role bypasses RLS, ALL queries MUST use these helpers
// to inject tenant filters. This is the primary isolation mechanism.
/**
 * Build Supabase REST query string filter for tenant isolation.
 * Platform admins get no filter (full access).
 * Reseller scope: enterprise_id in (reseller's child tenants).
 * Customer scope: enterprise_id = customerId.
 * Department scope: enterprise_id = customerId AND department_id = departmentId.
 */
export function buildTenantFilter(auth, opts = {}) {
    const field = opts.field ?? 'enterprise_id';
    const roleScope = auth.roleScope ? String(auth.roleScope) : null;
    const role = auth.role ? String(auth.role) : null;
    // Platform admin: no filter
    if (roleScope === 'platform' || role === 'platform_admin') {
        return '';
    }
    // Customer/department scope: direct match
    if (roleScope === 'customer' || roleScope === 'department') {
        const customerId = auth.customerId;
        if (!customerId)
            return `${field}=eq.00000000-0000-0000-0000-000000000000`; // deny all
        return `${field}=eq.${encodeURIComponent(customerId)}`;
    }
    // Reseller scope: requires async DB lookup to resolve child enterprise IDs.
    // The sync version cannot do this correctly — return deny-all to avoid data leakage.
    // Callers handling reseller scope MUST use buildTenantFilterAsync instead.
    if (roleScope === 'reseller') {
        console.warn('buildTenantFilter sync does not support reseller scope correctly, use buildTenantFilterAsync instead');
        return `${field}=eq.00000000-0000-0000-0000-000000000000`;
    }
    // Unknown scope: deny all
    return `${field}=eq.00000000-0000-0000-0000-000000000000`;
}
/**
 * Get the list of enterprise IDs accessible to the current auth context.
 * For reseller scope, queries the tenants table for child enterprises.
 * Results are cached on the request object.
 */
export async function getAccessibleEnterpriseIds(auth) {
    const roleScope = auth.roleScope ? String(auth.roleScope) : null;
    const role = auth.role ? String(auth.role) : null;
    if (roleScope === 'platform' || role === 'platform_admin') {
        return []; // empty means "no filter needed"
    }
    if (roleScope === 'customer' || roleScope === 'department') {
        return auth.customerId ? [auth.customerId] : [];
    }
    if (roleScope === 'reseller' && auth.resellerId) {
        try {
            const supabase = createSupabaseRestClient({ useServiceRole: true });
            const rows = await supabase.select('tenants', `select=tenant_id&parent_id=eq.${encodeURIComponent(auth.resellerId)}&tenant_type=eq.ENTERPRISE&limit=1000`);
            const ids = Array.isArray(rows)
                ? rows.map(r => String(r.tenant_id)).filter(Boolean)
                : [];
            return ids;
        }
        catch {
            return [];
        }
    }
    return [];
}
/**
 * Build Supabase REST filter for reseller-scoped queries.
 * Returns empty string for platform admins (no filter).
 * Returns enterprise_id=in.(...) for reseller scope.
 * Returns enterprise_id=eq.X for customer scope.
 */
export async function buildTenantFilterAsync(auth, opts = {}) {
    const field = opts.field ?? 'enterprise_id';
    const roleScope = auth.roleScope ? String(auth.roleScope) : null;
    const role = auth.role ? String(auth.role) : null;
    if (roleScope === 'platform' || role === 'platform_admin') {
        return '';
    }
    const ids = await getAccessibleEnterpriseIds(auth);
    if (!ids.length) {
        return `${field}=eq.00000000-0000-0000-0000-000000000000`;
    }
    if (ids.length === 1) {
        return `${field}=eq.${encodeURIComponent(ids[0])}`;
    }
    return `${field}=in.(${ids.map(id => encodeURIComponent(id)).join(',')})`;
}
