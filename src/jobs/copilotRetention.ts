/**
 * Job de retenção: apaga mensagens do copilot com mais de 30 dias.
 * Roda diariamente.
 */
import { getDb } from '../db/sqlite.js'

const RETENTION_DAYS = 30
const INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 horas

function cleanup() {
  const db = getDb()
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const result = db.prepare('DELETE FROM copilot_messages WHERE created_at < ?').run(cutoff)
  if (result.changes > 0) {
    console.log(`[IGA][RETENTION] ${result.changes} mensagem(ns) do copilot removida(s) (> ${RETENTION_DAYS} dias)`)
  }
}

export function startCopilotRetentionJob() {
  // Primeira execução 2min após inicialização
  setTimeout(() => {
    cleanup()
    setInterval(cleanup, INTERVAL_MS).unref()
  }, 120_000).unref()
}
