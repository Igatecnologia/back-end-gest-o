import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { getDb } from './db/sqlite.js'

export type UserRecord = {
  id: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'viewer'
  status: 'active' | 'inactive'
  /** Se definido, substitui o pacote padrão do perfil. */
  permissions?: string[]
  passwordHash: string
  /** True enquanto o usuário ainda não trocou a senha inicial (seed ou reset admin). */
  mustChangePassword?: boolean
  createdAt: string
  updatedAt: string
}

const db = getDb()

function mapRow(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    email: String(row.email),
    role: row.role as UserRecord['role'],
    status: row.status as UserRecord['status'],
    permissions: row.permissions_json ? (JSON.parse(String(row.permissions_json)) as string[]) : undefined,
    passwordHash: String(row.password_hash),
    mustChangePassword: Number(row.must_change_password ?? 0) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

/** Cache de usuários com TTL — evita query repetida no middleware de auth */
const CACHE_TTL_MS = 30_000 // 30 segundos
let userCache: { data: UserRecord[]; expiresAt: number } | null = null

export function readAllUsersCached(): UserRecord[] {
  const now = Date.now()
  if (userCache && now < userCache.expiresAt) return userCache.data
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as Record<string, unknown>[]
  const data = rows.map(mapRow)
  userCache = { data, expiresAt: now + CACHE_TTL_MS }
  return data
}

/** Invalida o cache — chamar após qualquer escrita de usuários. */
export function invalidateUserCache() {
  userCache = null
}

/** Leitura direta (para operações de escrita que precisam de dados frescos) */
export function readAllUsers(): UserRecord[] {
  invalidateUserCache()
  return readAllUsersCached()
}

export function writeAllUsers(items: UserRecord[]) {
  const clearStmt = db.prepare('DELETE FROM users')
  const insertStmt = db.prepare(`
    INSERT INTO users (
      id, name, email, role, status, permissions_json, password_hash, must_change_password, preferences_json, created_at, updated_at
    ) VALUES (
      @id, @name, @email, @role, @status, @permissions_json, @password_hash, @must_change_password, @preferences_json, @created_at, @updated_at
    )
  `)
  const tx = db.transaction((records: UserRecord[]) => {
    clearStmt.run()
    for (const item of records) {
      insertStmt.run({
        id: item.id,
        name: item.name,
        email: item.email.toLowerCase(),
        role: item.role,
        status: item.status,
        permissions_json: item.permissions?.length ? JSON.stringify(item.permissions) : null,
        password_hash: item.passwordHash,
        must_change_password: item.mustChangePassword ? 1 : 0,
        preferences_json: null,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })
  tx(items)
  invalidateUserCache()
}

export function genUserId(): string {
  return `usr_${randomBytes(6).toString('hex')}_${Date.now().toString(36)}`
}

// ─── Password hashing (scrypt, zero deps) ──────────────────────────────────

export function hashUserPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

export function verifyUserPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const derived = scryptSync(password, salt, 64)
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'))
}
