/**
 * Product-package Control Policy snapshot JSON (`control_policy_modules.control_policy`, Price Plan meta).
 * Canonical contract: specs/20260208-iot-cmp-reseller/clarifications/control-policy-module.md
 */
function toError(status, code, message) {
    return { ok: false, status, code, message };
}
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function toInteger(value) {
    const num = Number(value);
    if (!Number.isFinite(num))
        return null;
    return Number.isInteger(num) ? num : Math.trunc(num);
}
export const LEGACY_CONTROL_POLICY_KEYS = ['cutoffPolicyId', 'throttlingPolicyId', 'cutoffThresholdMb'];
export function stripLegacyControlPolicyKeys(obj) {
    const out = { ...obj };
    for (const k of LEGACY_CONTROL_POLICY_KEYS)
        delete out[k];
    return out;
}
const CONTROL_POLICY_TOP = new Set(['enabled', 'cutoff', 'throttling']);
function rejectLegacyKeys(src) {
    for (const k of LEGACY_CONTROL_POLICY_KEYS) {
        if (Object.prototype.hasOwnProperty.call(src, k)) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.${k} is not supported (use cutoff / throttling).`);
        }
    }
    return null;
}
function parseCutoff(input) {
    if (!isPlainObject(input)) {
        return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoff must be an object.');
    }
    const allowed = new Set(['timeWindow', 'thresholdMb', 'action']);
    for (const k of Object.keys(input)) {
        if (!allowed.has(k)) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.cutoff.${k} is not a valid field.`);
        }
    }
    const tw = String(input.timeWindow ?? '').trim().toUpperCase();
    if (tw !== 'DAILY' && tw !== 'MONTHLY') {
        return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoff.timeWindow must be DAILY or MONTHLY.');
    }
    const thresholdMb = toInteger(input.thresholdMb);
    if (thresholdMb === null || thresholdMb < 0) {
        return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoff.thresholdMb must be a non-negative integer.');
    }
    let action = 'DEACTIVATED';
    if (input.action !== undefined) {
        const a = String(input.action ?? '').trim().toUpperCase();
        if (a !== 'DEACTIVATED') {
            return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoff.action must be DEACTIVATED.');
        }
        action = a;
    }
    return { ok: true, value: { timeWindow: tw, thresholdMb, action } };
}
function parseThrottling(input) {
    if (!isPlainObject(input)) {
        return toError(400, 'BAD_REQUEST', 'controlPolicy.throttling must be an object.');
    }
    const allowed = new Set(['timeWindow', 'tiers']);
    for (const k of Object.keys(input)) {
        if (!allowed.has(k)) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.${k} is not a valid field.`);
        }
    }
    const tw = String(input.timeWindow ?? '').trim().toUpperCase();
    if (tw !== 'DAILY' && tw !== 'MONTHLY') {
        return toError(400, 'BAD_REQUEST', 'controlPolicy.throttling.timeWindow must be DAILY or MONTHLY.');
    }
    const tiersRaw = input.tiers;
    if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) {
        return toError(400, 'BAD_REQUEST', 'controlPolicy.throttling.tiers must be a non-empty array.');
    }
    const tiers = [];
    for (let i = 0; i < tiersRaw.length; i++) {
        const t = tiersRaw[i];
        if (!isPlainObject(t)) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}] must be an object.`);
        }
        const allowedTier = new Set(['thresholdMb', 'downlinkKbps', 'uplinkKbps']);
        for (const k of Object.keys(t)) {
            if (!allowedTier.has(k)) {
                return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}].${k} is not a valid field.`);
            }
        }
        const thresholdMb = toInteger(t.thresholdMb);
        const downlinkKbps = toInteger(t.downlinkKbps);
        const uplinkKbps = toInteger(t.uplinkKbps);
        if (thresholdMb === null || thresholdMb < 0) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}].thresholdMb must be a non-negative integer.`);
        }
        if (downlinkKbps === null || downlinkKbps < 0) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}].downlinkKbps must be a non-negative integer.`);
        }
        if (uplinkKbps === null || uplinkKbps < 0) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}].uplinkKbps must be a non-negative integer.`);
        }
        tiers.push({ thresholdMb, downlinkKbps, uplinkKbps });
    }
    return { ok: true, value: { timeWindow: tw, tiers } };
}
/**
 * Extract `controlPolicy` body from module create/update payloads without mixing in `name` / ids.
 */
export function extractControlPolicyFromPayload(payload) {
    if (!payload || typeof payload !== 'object')
        return undefined;
    if (payload.controlPolicy !== undefined && payload.controlPolicy !== null)
        return payload.controlPolicy;
    const hasTop = ['enabled', 'cutoff', 'throttling'].some((k) => Object.prototype.hasOwnProperty.call(payload, k));
    if (!hasTop)
        return undefined;
    return {
        enabled: payload.enabled,
        cutoff: payload.cutoff,
        throttling: payload.throttling,
    };
}
export function normalizeControlPolicy(input, mode = 'full') {
    if (input === undefined || input === null)
        return { ok: true, value: null };
    if (!isPlainObject(input)) {
        return toError(400, 'BAD_REQUEST', 'controlPolicy must be an object.');
    }
    const src = input;
    const legacyErr = rejectLegacyKeys(src);
    if (legacyErr)
        return legacyErr;
    for (const k of Object.keys(src)) {
        if (!CONTROL_POLICY_TOP.has(k)) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.${k} is not a valid field.`);
        }
    }
    const out = {};
    if (mode === 'full') {
        if (typeof src.enabled !== 'boolean') {
            return toError(400, 'BAD_REQUEST', 'controlPolicy.enabled must be a boolean.');
        }
        out.enabled = src.enabled;
    }
    else if (src.enabled !== undefined) {
        if (typeof src.enabled !== 'boolean') {
            return toError(400, 'BAD_REQUEST', 'controlPolicy.enabled must be a boolean.');
        }
        out.enabled = src.enabled;
    }
    if (src.cutoff !== undefined) {
        const c = parseCutoff(src.cutoff);
        if (!c.ok)
            return c;
        out.cutoff = c.value;
    }
    if (src.throttling !== undefined) {
        const t = parseThrottling(src.throttling);
        if (!t.ok)
            return t;
        out.throttling = t.value;
    }
    if (mode === 'full') {
        return { ok: true, value: out };
    }
    if (!Object.keys(out).length) {
        return { ok: true, value: null };
    }
    return { ok: true, value: out };
}
/** After merging existing + partial patch: canonicalize nested objects and enforce `enabled`. */
export function finalizeControlPolicyMerged(merged) {
    const stripped = stripLegacyControlPolicyKeys(merged);
    for (const k of Object.keys(stripped)) {
        if (!CONTROL_POLICY_TOP.has(k)) {
            return toError(400, 'BAD_REQUEST', `controlPolicy.${k} is not a valid field.`);
        }
    }
    if (typeof stripped.enabled !== 'boolean') {
        return toError(400, 'BAD_REQUEST', 'controlPolicy.enabled must be a boolean.');
    }
    const out = { enabled: stripped.enabled };
    if (stripped.cutoff !== undefined) {
        const c = parseCutoff(stripped.cutoff);
        if (!c.ok)
            return c;
        out.cutoff = c.value;
    }
    if (stripped.throttling !== undefined) {
        const t = parseThrottling(stripped.throttling);
        if (!t.ok)
            return t;
        out.throttling = t.value;
    }
    return { ok: true, value: out };
}
