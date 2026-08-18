import nodemailer from 'nodemailer'

export type SendMailInput = {
  to: string
  subject: string
  text: string
  html?: string
}

export type MailMode = 'http' | 'smtp' | 'log'

export type SendMailResult =
  | { ok: true; mode: MailMode }
  | { ok: false; error: string }

type HttpBodyFormat = 'simple' | 'resend' | 'sendgrid'

function getEnv(name: string) {
  const v = process.env[name]
  return v != null && String(v).trim() !== '' ? String(v).trim() : null
}

function resolveFrom(preferred?: string | null) {
  return preferred || getEnv('MAIL_FROM') || getEnv('MAIL_HTTP_FROM') || getEnv('SMTP_FROM')
}

/** True when HTTP mail API is configured. */
export function isHttpMailConfigured() {
  return Boolean(getEnv('MAIL_HTTP_URL') && resolveFrom(getEnv('MAIL_HTTP_FROM')))
}

/** True when SMTP_* is configured for outbound mail. */
export function isSmtpConfigured() {
  return Boolean(getEnv('SMTP_HOST') && resolveFrom(getEnv('SMTP_FROM')))
}

/**
 * Resolve transport: MAIL_PROVIDER=auto|http|smtp|log (default auto).
 * auto → http if configured, else smtp, else log (when MAIL_DEV_LOG allows).
 */
export function resolveMailProvider(): 'http' | 'smtp' | 'log' | null {
  const raw = String(getEnv('MAIL_PROVIDER') || 'auto').toLowerCase()
  if (raw === 'http') return isHttpMailConfigured() ? 'http' : null
  if (raw === 'smtp') return isSmtpConfigured() ? 'smtp' : null
  if (raw === 'log') return 'log'
  // auto
  if (isHttpMailConfigured()) return 'http'
  if (isSmtpConfigured()) return 'smtp'
  return 'log'
}

function parseExtraHeaders(): Record<string, string> {
  const raw = getEnv('MAIL_HTTP_EXTRA_HEADERS')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v == null) continue
      out[String(k)] = String(v)
    }
    return out
  } catch {
    console.warn('[mail] MAIL_HTTP_EXTRA_HEADERS is not valid JSON; ignoring')
    return {}
  }
}

function buildHttpHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...parseExtraHeaders(),
  }
  const bearer = getEnv('MAIL_HTTP_BEARER')
  if (bearer) {
    headers.authorization = bearer.startsWith('Bearer ') ? bearer : `Bearer ${bearer}`
  }
  const apiKey = getEnv('MAIL_HTTP_API_KEY')
  if (apiKey) {
    const headerName = getEnv('MAIL_HTTP_API_KEY_HEADER') || 'X-Api-Key'
    headers[headerName] = apiKey
  }
  return headers
}

function buildHttpBody(input: SendMailInput, from: string, format: HttpBodyFormat): unknown {
  const to = input.to
  const subject = input.subject
  const text = input.text
  const html = input.html

  if (format === 'resend') {
    return {
      from,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
    }
  }

  if (format === 'sendgrid') {
    const content: Array<{ type: string; value: string }> = [{ type: 'text/plain', value: text }]
    if (html) content.push({ type: 'text/html', value: html })
    // SendGrid "from" may be "Name <email@x>" — pass through; providers usually accept email-only.
    const emailMatch = from.match(/<([^>]+)>/)
    const fromEmail = emailMatch ? emailMatch[1].trim() : from
    const fromName = emailMatch ? from.replace(/<[^>]+>/, '').trim().replace(/^"|"$/g, '') : undefined
    return {
      personalizations: [{ to: [{ email: to }] }],
      from: fromName ? { email: fromEmail, name: fromName } : { email: fromEmail },
      subject,
      content,
    }
  }

  // simple — generic gateway / custom HTTP mail API
  return {
    to,
    from,
    subject,
    text,
    ...(html ? { html } : {}),
  }
}

async function sendViaHttp(input: SendMailInput): Promise<SendMailResult> {
  const url = getEnv('MAIL_HTTP_URL')
  const from = resolveFrom(getEnv('MAIL_HTTP_FROM'))
  if (!url || !from) {
    return { ok: false, error: 'MAIL_HTTP_URL and MAIL_HTTP_FROM (or MAIL_FROM) are required for HTTP mail.' }
  }

  const formatRaw = String(getEnv('MAIL_HTTP_FORMAT') || 'simple').toLowerCase()
  const format: HttpBodyFormat =
    formatRaw === 'resend' || formatRaw === 'sendgrid' ? formatRaw : 'simple'

  const timeoutMs = Number(getEnv('MAIL_HTTP_TIMEOUT_MS') || '15000')
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000
  )

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHttpHeaders(),
      body: JSON.stringify(buildHttpBody(input, from, format)),
      signal: controller.signal,
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      const snippet = bodyText.slice(0, 500)
      return {
        ok: false,
        error: `HTTP mail provider returned ${res.status}${snippet ? `: ${snippet}` : ''}`,
      }
    }
    return { ok: true, mode: 'http' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}

async function sendViaSmtp(input: SendMailInput): Promise<SendMailResult> {
  try {
    const host = getEnv('SMTP_HOST')!
    const port = Number(getEnv('SMTP_PORT') || '587')
    const user = getEnv('SMTP_USER')
    const pass = getEnv('SMTP_PASS')
    const from = resolveFrom(getEnv('SMTP_FROM'))!
    const secure = String(getEnv('SMTP_SECURE') || '').toLowerCase() === 'true' || port === 465
    const transporter = nodemailer.createTransport({
      host,
      port: Number.isFinite(port) ? port : 587,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    })
    await transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    })
    return { ok: true, mode: 'smtp' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

async function sendViaLog(input: SendMailInput): Promise<SendMailResult> {
  const allowLog = String(getEnv('MAIL_DEV_LOG') ?? 'true').toLowerCase() !== 'false'
  if (!allowLog) {
    return { ok: false, error: 'No mail transport configured and MAIL_DEV_LOG is disabled.' }
  }
  console.info('[mail:dev-log]', {
    to: input.to,
    subject: input.subject,
    text: input.text,
  })
  return { ok: true, mode: 'log' }
}

/**
 * Send email via HTTP API, SMTP, or console log (dev fallback).
 * Prefer MAIL_PROVIDER=http|smtp|log|auto (default auto: HTTP → SMTP → log).
 * Never throws for "user not found" flows — callers should still return generic responses.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const to = String(input.to || '').trim()
  if (!to) return { ok: false, error: 'recipient is required.' }

  const payload: SendMailInput = { ...input, to }
  const provider = resolveMailProvider()
  if (provider === 'http') return sendViaHttp(payload)
  if (provider === 'smtp') return sendViaSmtp(payload)
  if (provider === 'log') return sendViaLog(payload)
  return {
    ok: false,
    error:
      'Mail provider is not configured. Set MAIL_HTTP_URL (+ MAIL_HTTP_FROM/MAIL_FROM) or SMTP_HOST (+ SMTP_FROM), or MAIL_PROVIDER=log.',
  }
}
