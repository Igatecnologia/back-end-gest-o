/**
 * Backup automatizado do SQLite.
 * Usa a API nativa `backup()` do better-sqlite3 (cópia segura sem lock).
 * Roda a cada 6 horas e mantém os últimos 7 backups.
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, getDbPath } from '../db/sqlite.js'
import { resolveDataDir } from '../paths.js'

const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 horas
const MAX_BACKUPS = 7

function getBackupDir(): string {
  const dir = join(resolveDataDir(), 'backups')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function pruneOldBackups(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('iga-') && f.endsWith('.db'))
    .sort()

  while (files.length > MAX_BACKUPS) {
    const oldest = files.shift()!
    try {
      unlinkSync(join(dir, oldest))
    } catch { /* melhor esforço */ }
  }
}

export function runBackup(): { ok: boolean; path?: string; error?: string } {
  try {
    const db = getDb()
    const dir = getBackupDir()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backupPath = join(dir, `iga-${stamp}.db`)

    db.backup(backupPath)
    pruneOldBackups(dir)

    console.log(`[IGA][BACKUP] SQLite backup criado: ${backupPath}`)
    return { ok: true, path: backupPath }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro desconhecido'
    console.error(`[IGA][BACKUP] Falha no backup: ${message}`)
    return { ok: false, error: message }
  }
}

export function startBackupScheduler() {
  // Backup inicial 30s após inicialização (evita competir com migrations)
  setTimeout(() => {
    runBackup()
    setInterval(runBackup, BACKUP_INTERVAL_MS).unref()
  }, 30_000).unref()
}
