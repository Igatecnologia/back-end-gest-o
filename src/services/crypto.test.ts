import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, isEncryptedPayload } from './crypto.js'

describe('crypto service', () => {
  it('encrypt/decrypt roundtrip', () => {
    const input = 'login:senha-super-secreta'
    const encrypted = encryptSecret(input)
    expect(isEncryptedPayload(encrypted)).toBe(true)
    const output = decryptSecret(encrypted)
    expect(output).toBe(input)
  })
})
