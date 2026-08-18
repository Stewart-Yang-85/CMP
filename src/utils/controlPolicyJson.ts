/**
 * Product-package Control Policy snapshot JSON (`control_policy_modules.control_policy`, Price Plan meta).
 * Canonical contract: specs/20260208-iot-cmp-reseller/clarifications/control-policy-module.md
 */

export type ControlPolicyNormalizeResult =
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; status: number; code: string; message: string }

function toError(status: number, code: string, message: string): ControlPolicyNormalizeResult {
  return { ok: false, status, code, message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toInteger(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Number.isInteger(num) ? num : Math.trunc(num)
}

export const LEGACY_CONTROL_POLICY_KEYS = ['cutoffPolicyId', 'throttlingPolicyId', 'cutoffThresholdMb'] as const

export function stripLegacyControlPolicyKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out = { ...obj }
  for (const k of LEGACY_CONTROL_POLICY_KEYS) delete out[k]
  return out
}

const CONTROL_POLICY_TOP = new Set(['enabled', 'cutoff', 'throttling'])

/** Canonical enum strings for API error messages (see control-policy-module.md). */
const CONTROL_POLICY_TIME_WINDOWS = ['DAILY', 'MONTHLY'] as const
const CONTROL_POLICY_CUTOFF_ACTIONS = ['DEACTIVATED'] as const

function allowedValuesMsg(values: readonly string[]): string {
  return `Allowed values: ${values.join(', ')}.`
}

function rejectLegacyKeys(src: Record<string, unknown>): ControlPolicyNormalizeResult | null {
  for (const k of LEGACY_CONTROL_POLICY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.${k} is not supported (use cutoff / throttling).`)
    }
  }
  return null
}

function parseCutoff(input: unknown): ControlPolicyNormalizeResult {
  if (!isPlainObject(input)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoff is invalid.')
  }
  const allowed = new Set(['timeWindow', 'thresholdMb', 'action'])
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.cutoff.${k} is invalid.`)
    }
  }
  const tw = String((input as { timeWindow?: unknown }).timeWindow ?? '').trim().toUpperCase()
  if (tw !== 'DAILY' && tw !== 'MONTHLY') {
    return toError(400, 'BAD_REQUEST', `controlPolicy.cutoff.timeWindow is invalid. ${allowedValuesMsg(CONTROL_POLICY_TIME_WINDOWS)}`)
  }
  const thresholdMb = toInteger((input as { thresholdMb?: unknown }).thresholdMb)
  if (thresholdMb === null || thresholdMb < 0) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.cutoff.thresholdMb is invalid.')
  }
  let action = 'DEACTIVATED'
  if ((input as { action?: unknown }).action !== undefined) {
    const a = String((input as { action?: unknown }).action ?? '').trim().toUpperCase()
    if (a !== 'DEACTIVATED') {
      return toError(400, 'BAD_REQUEST', `controlPolicy.cutoff.action is invalid. ${allowedValuesMsg(CONTROL_POLICY_CUTOFF_ACTIONS)}`)
    }
    action = a
  }
  return { ok: true, value: { timeWindow: tw, thresholdMb, action } }
}

function parseThrottling(input: unknown): ControlPolicyNormalizeResult {
  if (!isPlainObject(input)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.throttling is invalid.')
  }
  const allowed = new Set(['timeWindow', 'tiers'])
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.${k} is invalid.`)
    }
  }
  const tw = String((input as { timeWindow?: unknown }).timeWindow ?? '').trim().toUpperCase()
  if (tw !== 'DAILY' && tw !== 'MONTHLY') {
    return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.timeWindow is invalid. ${allowedValuesMsg(CONTROL_POLICY_TIME_WINDOWS)}`)
  }
  const tiersRaw = (input as { tiers?: unknown }).tiers
  if (!Array.isArray(tiersRaw) || tiersRaw.length === 0) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.throttling.tiers is required.')
  }
  const tiers: Record<string, unknown>[] = []
  for (let i = 0; i < tiersRaw.length; i++) {
    const t = tiersRaw[i]
    if (!isPlainObject(t)) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}] is invalid.`)
    }
    const allowedTier = new Set(['thresholdMb', 'downlinkKbps', 'uplinkKbps'])
    for (const k of Object.keys(t)) {
      if (!allowedTier.has(k)) {
        return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}].${k} is invalid.`)
      }
    }
    const thresholdMb = toInteger((t as { thresholdMb?: unknown }).thresholdMb)
    const downlinkKbps = toInteger((t as { downlinkKbps?: unknown }).downlinkKbps)
    const uplinkKbps = toInteger((t as { uplinkKbps?: unknown }).uplinkKbps)
    if (thresholdMb === null || thresholdMb < 0) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}].thresholdMb is invalid.`)
    }
    if (downlinkKbps === null || downlinkKbps < 0) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}].downlinkKbps is invalid.`)
    }
    if (uplinkKbps === null || uplinkKbps < 0) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.throttling.tiers[${i}].uplinkKbps is invalid.`)
    }
    tiers.push({ thresholdMb, downlinkKbps, uplinkKbps })
  }
  return { ok: true, value: { timeWindow: tw, tiers } }
}

/**
 * Extract `controlPolicy` body from module create/update payloads without mixing in `name` / ids.
 */
export function extractControlPolicyFromPayload(payload: Record<string, unknown> | null | undefined): unknown {
  if (!payload || typeof payload !== 'object') return undefined
  if (payload.controlPolicy !== undefined && payload.controlPolicy !== null) return payload.controlPolicy
  const hasTop = ['enabled', 'cutoff', 'throttling'].some((k) => Object.prototype.hasOwnProperty.call(payload, k))
  if (!hasTop) return undefined
  return {
    enabled: (payload as { enabled?: unknown }).enabled,
    cutoff: (payload as { cutoff?: unknown }).cutoff,
    throttling: (payload as { throttling?: unknown }).throttling,
  }
}

export type ControlPolicyNormalizeMode = 'full' | 'partial'

export function normalizeControlPolicy(
  input: unknown,
  mode: ControlPolicyNormalizeMode = 'full'
): ControlPolicyNormalizeResult {
  if (input === undefined || input === null) return { ok: true, value: null }
  if (!isPlainObject(input)) {
    return toError(400, 'BAD_REQUEST', 'controlPolicy is invalid.')
  }
  const src = input
  const legacyErr = rejectLegacyKeys(src)
  if (legacyErr) return legacyErr
  for (const k of Object.keys(src)) {
    if (!CONTROL_POLICY_TOP.has(k)) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.${k} is invalid.`)
    }
  }
  const out: Record<string, unknown> = {}
  if (mode === 'full') {
    if (typeof src.enabled !== 'boolean') {
      return toError(400, 'BAD_REQUEST', 'controlPolicy.enabled is invalid.')
    }
    out.enabled = src.enabled
  } else if (src.enabled !== undefined) {
    if (typeof src.enabled !== 'boolean') {
      return toError(400, 'BAD_REQUEST', 'controlPolicy.enabled is invalid.')
    }
    out.enabled = src.enabled
  }
  if (src.cutoff !== undefined) {
    const c = parseCutoff(src.cutoff)
    if (!c.ok) return c
    out.cutoff = c.value
  }
  if (src.throttling !== undefined) {
    const t = parseThrottling(src.throttling)
    if (!t.ok) return t
    out.throttling = t.value
  }
  if (mode === 'full') {
    return { ok: true, value: out }
  }
  if (!Object.keys(out).length) {
    return { ok: true, value: null }
  }
  return { ok: true, value: out }
}

/** After merging existing + partial patch: canonicalize nested objects and enforce `enabled`. */
export function finalizeControlPolicyMerged(merged: Record<string, unknown>): ControlPolicyNormalizeResult {
  const stripped = stripLegacyControlPolicyKeys(merged)
  for (const k of Object.keys(stripped)) {
    if (!CONTROL_POLICY_TOP.has(k)) {
      return toError(400, 'BAD_REQUEST', `controlPolicy.${k} is invalid.`)
    }
  }
  if (typeof stripped.enabled !== 'boolean') {
    return toError(400, 'BAD_REQUEST', 'controlPolicy.enabled is invalid.')
  }
  const out: Record<string, unknown> = { enabled: stripped.enabled }
  if (stripped.cutoff !== undefined) {
    const c = parseCutoff(stripped.cutoff)
    if (!c.ok) return c
    out.cutoff = c.value
  }
  if (stripped.throttling !== undefined) {
    const t = parseThrottling(stripped.throttling)
    if (!t.ok) return t
    out.throttling = t.value
  }
  return { ok: true, value: out }
}
