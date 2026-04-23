/**
 * Serviço de audit log — registra eventos de segurança na tabela audit_log.
 * Nunca loga dados sensíveis (senhas, tokens, credenciais).
 */
import { randomBytes } from 'node:crypto'
import { getDb } from '../db/sqlite.js'

const db = getDb()

const insertStmt = db.prepare(`
  INSERT INTO audit_log (id, user_id, action, resource, metadata_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`)

type AuditEntry = {
  userId?: string | null
  action: string
  resource: string
  metadata?: Record<string, unknown>
}

export function logAudit(entry: AuditEntry) {
  const id = randomBytes(8).toString('hex')
  const now = new Date().toISOString()
  const meta = entry.metadata ? JSON.stringify(entry.metadata) : null
  try {
    insertStmt.run(id, entry.userId ?? null, entry.action, entry.resource, meta, now)
  } catch {
    // Melhor esforço — nunca deve impedir o fluxo principal
  }
}
