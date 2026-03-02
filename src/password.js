import crypto from 'node:crypto'

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function b64urlToBuf(str) {
  const s = String(str).replaceAll('-', '+').replaceAll('_', '/')
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(`${s}${pad}`, 'base64')
}

export function hashSecretScrypt(secret) {
  const salt = crypto.randomBytes(16)
  const N = 16384
  const r = 8
  const p = 1
  const keyLen = 32
  const dk = crypto.scryptSync(String(secret), salt, keyLen, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${b64url(salt)}$${b64url(dk)}`
}

export function verifySecretScrypt(secret, stored) {
  const parts = String(stored).split('$')
  if (parts.length !== 6) return false
  if (parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  const salt = b64urlToBuf(parts[4])
  const expected = b64urlToBuf(parts[5])
  const dk = crypto.scryptSync(String(secret), salt, expected.length, { N, r, p })
  return crypto.timingSafeEqual(dk, expected)
}

