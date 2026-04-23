import { getDb } from '../../db/sqlite.js'
import { decryptSecret, encryptSecret, isEncryptedPayload } from '../crypto.js'

/**
 * Config do copiloto persistida em SQLite (tabela app_settings).
 * Permite que cada instalação desktop configure sua própria chave Groq
 * sem expô-la no .exe. Chaves criptografadas com AES-256-GCM.
 */

export type CopilotProviderChoice = 'auto' | 'groq' | 'local'

export type CopilotConfig = {
  provider: CopilotProviderChoice
  groqApiKey: string | null
  groqModel: string | null
}

export type CopilotConfigPublic = Omit<CopilotConfig, 'groqApiKey'> & {
  groqApiKeySet: boolean
  groqApiKeyMasked: string | null
}

const KEY = 'copilot_config'

const DEFAULT_CONFIG: CopilotConfig = {
  provider: 'auto',
  groqApiKey: null,
  groqModel: 'llama-3.3-70b-versatile',
}

type StoredShape = {
  provider: CopilotProviderChoice
  groqApiKey: unknown
  groqModel: string | null
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}

export function getCopilotConfig(): CopilotConfig {
  const db = getDb()
  const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(KEY) as
    | { value_json: string }
    | undefined
  if (!row) return { ...DEFAULT_CONFIG }

  let parsed: StoredShape
  try {
    parsed = JSON.parse(row.value_json) as StoredShape
  } catch {
    return { ...DEFAULT_CONFIG }
  }

  let groqApiKey: string | null = null
  if (isEncryptedPayload(parsed.groqApiKey)) {
    try {
      groqApiKey = decryptSecret(parsed.groqApiKey)
    } catch {
      groqApiKey = null
    }
  }

  return {
    provider: parsed.provider ?? 'auto',
    groqApiKey,
    groqModel: parsed.groqModel ?? DEFAULT_CONFIG.groqModel,
  }
}

export function getCopilotConfigPublic(): CopilotConfigPublic {
  const cfg = getCopilotConfig()
  return {
    provider: cfg.provider,
    groqApiKeySet: Boolean(cfg.groqApiKey),
    groqApiKeyMasked: cfg.groqApiKey ? maskKey(cfg.groqApiKey) : null,
    groqModel: cfg.groqModel,
  }
}

export type UpdateCopilotConfigInput = {
  provider?: CopilotProviderChoice
  /** string: define nova chave; null: limpa; undefined: mantém. */
  groqApiKey?: string | null
  groqModel?: string | null
}

function resolveSecret(input: string | null | undefined, current: string | null): string | null {
  if (input === undefined) return current
  if (input === null || input.trim() === '') return null
  return input.trim()
}

export function updateCopilotConfig(input: UpdateCopilotConfigInput, updatedBy: string): CopilotConfigPublic {
  const current = getCopilotConfig()
  const next: CopilotConfig = {
    provider: input.provider ?? current.provider,
    groqApiKey: resolveSecret(input.groqApiKey, current.groqApiKey),
    groqModel: input.groqModel ?? current.groqModel,
  }

  const stored: StoredShape = {
    provider: next.provider,
    groqApiKey: next.groqApiKey ? encryptSecret(next.groqApiKey) : null,
    groqModel: next.groqModel,
  }

  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO app_settings (key, value_json, is_secret, updated_at, updated_by)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(KEY, JSON.stringify(stored), now, updatedBy)

  return getCopilotConfigPublic()
}
