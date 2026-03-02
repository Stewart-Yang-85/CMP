import crypto from 'node:crypto'

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input))
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlDecodeToString(input) {
  const s = String(input).replaceAll('-', '+').replaceAll('_', '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(`${s}${pad}`, 'base64').toString('utf8')
}

export function signJwtHs256(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerPart = base64UrlEncode(JSON.stringify(header))
  const payloadPart = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${headerPart}.${payloadPart}`
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest()
  const sigPart = base64UrlEncode(sig)
  return `${signingInput}.${sigPart}`
}

export function verifyJwtHs256(token, secret) {
  const parts = String(token).split('.')
  if (parts.length !== 3) return { ok: false, error: 'invalid_format' }
  const [headerPart, payloadPart, sigPart] = parts
  const signingInput = `${headerPart}.${payloadPart}`
  const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest()
  const expectedSigPart = base64UrlEncode(expectedSig)

  const a = Buffer.from(sigPart)
  const b = Buffer.from(expectedSigPart)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid_signature' }
  }

  let headerJson
  let payloadJson
  try {
    headerJson = JSON.parse(base64UrlDecodeToString(headerPart))
    payloadJson = JSON.parse(base64UrlDecodeToString(payloadPart))
  } catch {
    return { ok: false, error: 'invalid_json' }
  }

  if (headerJson?.alg !== 'HS256') return { ok: false, error: 'unsupported_alg' }
  const now = Math.floor(Date.now() / 1000)
  if (typeof payloadJson?.exp === 'number' && now >= payloadJson.exp) {
    return { ok: false, error: 'expired' }
  }

  return { ok: true, payload: payloadJson }
}

