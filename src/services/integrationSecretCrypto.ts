import crypto from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function deriveKey(): Buffer {
  const raw = process.env.INTEGRATION_SECRET_KEY?.trim()
  if (!raw) {
    throw new Error('INTEGRATION_SECRET_KEY is not configured.')
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest()
}

export function hasIntegrationSecretKey(): boolean {
  return Boolean(process.env.INTEGRATION_SECRET_KEY?.trim())
}

export function encryptIntegrationSecret(plaintext: string): Buffer {
  const key = deriveKey()
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, enc, tag])
}

export function decryptIntegrationSecret(blob: unknown): string | null {
  if (blob == null) return null
  if (!hasIntegrationSecretKey()) return null
  try {
    let buf: Buffer
    if (Buffer.isBuffer(blob)) {
      buf = blob
    } else if (typeof blob === 'string') {
      const s = blob.trim()
      if (s.startsWith('\\x')) {
        buf = Buffer.from(s.slice(2), 'hex')
      } else {
        buf = Buffer.from(s, 'base64')
      }
    } else if (blob instanceof Uint8Array) {
      buf = Buffer.from(blob)
    } else {
      return null
    }
    if (buf.length < IV_LEN + TAG_LEN + 1) return null
    const key = deriveKey()
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(buf.length - TAG_LEN)
    const ciphertext = buf.subarray(IV_LEN, buf.length - TAG_LEN)
    const decipher = crypto.createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** PostgREST bytea hex literal for JSON body inserts. */
export function byteaToPostgresHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`
}
