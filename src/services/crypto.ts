import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { resolveDataDir } from '../paths.js'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12

export type EncryptedPayloadV1 = {
  v: 1
  iv: string
  tag: string
  ciphertext: string
}

function getFallbackDevKey(): Buffer {
  const source = `iga-dev-key:${resolveDataDir()}`
  return createHash('sha256').update(source).digest()
}

let fallbackWarned = false
function getCryptoKey(): Buffer {
  const raw = process.env.IGA_SECRETS_KEY?.trim()
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('IGA_SECRETS_KEY ausente em produção')
    }
    if (!fallbackWarned) {
      fallbackWarned = true
      console.warn('[IGA][SEC] IGA_SECRETS_KEY ausente; usando fallback deterministico de desenvolvimento (ok em dev, nao em prod)')
    }
    return getFallbackDevKey()
  }
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error('IGA_SECRETS_KEY inválida: use 32 bytes hex (64 chars)')
  }
  return Buffer.from(raw, 'hex')
}

export function encryptSecret(plaintext: string): EncryptedPayloadV1 {
  const key = getCryptoKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function decryptSecret(payload: EncryptedPayloadV1): string {
  const key = getCryptoKey()
  const decipher = createDecipheriv(ALGO, key, Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

export function isEncryptedPayload(value: unknown): value is EncryptedPayloadV1 {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<EncryptedPayloadV1>
  return v.v === 1 && typeof v.iv === 'string' && typeof v.tag === 'string' && typeof v.ciphertext === 'string'
}
