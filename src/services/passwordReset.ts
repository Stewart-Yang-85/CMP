import crypto from 'node:crypto'
import { hashSecretScrypt } from '../password.js'
import { sendMail } from './mail.js'

type SupabaseClient = {
  select: (table: string, queryString: string, options?: { headers?: Record<string, string> }) => Promise<unknown>
  insert: (table: string, rows: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
  update: (table: string, matchQueryString: string, patch: unknown, options?: { returning?: 'minimal' | 'representation' }) => Promise<unknown>
}

function getEnv(name: string, fallback = '') {
  const v = process.env[name]
  return v != null && String(v).trim() !== '' ? String(v).trim() : fallback
}

function sha256Hex(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function tokenTtlMinutes() {
  const n = Number(getEnv('PASSWORD_RESET_TOKEN_TTL_MINUTES', '60'))
  if (!Number.isFinite(n) || n < 5) return 60
  if (n > 24 * 60) return 24 * 60
  return Math.floor(n)
}

function resetLinkBase() {
  // Portal SPA route that reads ?token=
  return getEnv('PASSWORD_RESET_URL_BASE', 'http://127.0.0.1:5173/reset-password').replace(/\/$/, '')
}

function normalizeEmail(value: unknown) {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s || !s.includes('@') || s.length > 320) return null
  return s
}

const GENERIC_FORGOT_MESSAGE =
  'If an account exists for this email, a password reset link will be sent.'

export type ForgotPasswordResult = {
  ok: true
  message: string
  /** Present only when mail mode is `log` (no HTTP/SMTP) — for local testing; never enable in production responses. */
  devResetUrl?: string
}

export async function requestPasswordReset({
  supabase,
  email,
  requestIp,
  includeDevResetUrl,
}: {
  supabase: SupabaseClient
  email: unknown
  requestIp?: string | null
  includeDevResetUrl?: boolean
}): Promise<ForgotPasswordResult> {
  const normalized = normalizeEmail(email)
  // Always return the same message shape for invalid/missing emails (anti-enumeration).
  if (!normalized) {
    return { ok: true, message: GENERIC_FORGOT_MESSAGE }
  }

  const userRows = await supabase.select(
    'users',
    `select=user_id,email,status,password_hash&email=ilike.${encodeURIComponent(normalized)}&limit=1`
  )
  const user = Array.isArray(userRows) ? (userRows[0] as Record<string, unknown> | undefined) : undefined
  if (!user?.user_id || String(user.status || '').toUpperCase() !== 'ACTIVE' || !user.password_hash) {
    return { ok: true, message: GENERIC_FORGOT_MESSAGE }
  }

  const userId = String(user.user_id)
  const rawToken = crypto.randomBytes(32).toString('base64url')
  const tokenHash = sha256Hex(rawToken)
  const ttlMin = tokenTtlMinutes()
  const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000).toISOString()

  // Invalidate prior unused tokens for this user.
  await supabase.update(
    'password_reset_tokens',
    `user_id=eq.${encodeURIComponent(userId)}&used_at=is.null`,
    { used_at: new Date().toISOString() },
    { returning: 'minimal' }
  )

  await supabase.insert(
    'password_reset_tokens',
    {
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      request_ip: requestIp ? String(requestIp).slice(0, 128) : null,
    },
    { returning: 'minimal' }
  )

  const resetUrl = `${resetLinkBase()}?token=${encodeURIComponent(rawToken)}`
  const subject = 'Reset your CMP password'
  const text = [
    'You requested a password reset for your CMP account.',
    '',
    `Open this link within ${ttlMin} minutes to set a new password:`,
    resetUrl,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n')
  const html = `<p>You requested a password reset for your CMP account.</p>
<p><a href="${resetUrl}">Reset your password</a> (valid for ${ttlMin} minutes).</p>
<p>If you did not request this, you can ignore this email.</p>`

  const mailed = await sendMail({
    to: String(user.email || normalized),
    subject,
    text,
    html,
  })
  if (!mailed.ok) {
    // Still generic to client; log server-side for ops.
    console.error('[password-reset] mail failed:', mailed.error)
  }

  const out: ForgotPasswordResult = { ok: true, message: GENERIC_FORGOT_MESSAGE }
  if (includeDevResetUrl && mailed.ok && mailed.mode === 'log') {
    out.devResetUrl = resetUrl
  }
  return out
}

export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

export async function resetPasswordWithToken({
  supabase,
  token,
  newPassword,
}: {
  supabase: SupabaseClient
  token: unknown
  newPassword: string
}): Promise<ResetPasswordResult> {
  const rawToken = String(token ?? '').trim()
  if (!rawToken || rawToken.length < 20) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'token is required.' }
  }
  const tokenHash = sha256Hex(rawToken)
  const rows = await supabase.select(
    'password_reset_tokens',
    `select=token_id,user_id,expires_at,used_at&token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`
  )
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined
  if (!row?.token_id || !row.user_id) {
    return { ok: false, status: 400, code: 'INVALID_TOKEN', message: 'Reset token is invalid or expired.' }
  }
  if (row.used_at) {
    return { ok: false, status: 400, code: 'INVALID_TOKEN', message: 'Reset token is invalid or expired.' }
  }
  const expiresAt = row.expires_at ? new Date(String(row.expires_at)).getTime() : 0
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return { ok: false, status: 400, code: 'INVALID_TOKEN', message: 'Reset token is invalid or expired.' }
  }

  const userId = String(row.user_id)
  const userRows = await supabase.select(
    'users',
    `select=user_id,tenant_id,status&user_id=eq.${encodeURIComponent(userId)}&limit=1`
  )
  const user = Array.isArray(userRows) ? (userRows[0] as Record<string, unknown> | undefined) : undefined
  if (!user?.user_id || String(user.status || '').toUpperCase() !== 'ACTIVE') {
    return { ok: false, status: 400, code: 'INVALID_TOKEN', message: 'Reset token is invalid or expired.' }
  }

  const nowIso = new Date().toISOString()
  await supabase.update(
    'users',
    `user_id=eq.${encodeURIComponent(userId)}`,
    { password_hash: hashSecretScrypt(newPassword) },
    { returning: 'minimal' }
  )
  await supabase.update(
    'password_reset_tokens',
    `token_id=eq.${encodeURIComponent(String(row.token_id))}`,
    { used_at: nowIso },
    { returning: 'minimal' }
  )
  // Invalidate any other outstanding tokens for the user.
  await supabase.update(
    'password_reset_tokens',
    `user_id=eq.${encodeURIComponent(userId)}&used_at=is.null`,
    { used_at: nowIso },
    { returning: 'minimal' }
  )

  await supabase.insert(
    'audit_logs',
    {
      actor_user_id: userId,
      actor_role: null,
      tenant_id: user.tenant_id ?? null,
      action: 'PASSWORD_RESET',
      target_type: 'USER',
      target_id: userId,
      request_id: null,
      source_ip: null,
    },
    { returning: 'minimal' }
  )

  return { ok: true }
}
