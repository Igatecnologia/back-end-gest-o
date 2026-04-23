import type { Request, Response, NextFunction } from 'express'
import { readAllUsersCached } from '../userStorage.js'
import { getDb } from '../db/sqlite.js'

/* ── Tipos extendidos para o Request ── */
export interface AuthenticatedRequest extends Request {
  userId: string
  userRole: string
  tenantId: string
}

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000 // 8 horas
const db = getDb()

function readTokenFromCookie(req: Request): string | null {
  const cookieHeader = req.headers.cookie
  if (!cookieHeader) return null
  const pairs = cookieHeader.split(';')
  for (const pair of pairs) {
    const [rawName, ...rawValue] = pair.trim().split('=')
    if (rawName !== 'iga_session') continue
    const value = rawValue.join('=')
    return value ? decodeURIComponent(value) : null
  }
  return null
}

export function registerToken(token: string, userId: string, tenantId = 'default') {
  const now = Date.now()
  const expiresAt = now + TOKEN_TTL_MS
  db.prepare(`
    INSERT OR REPLACE INTO sessions (token, user_id, tenant_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, userId, tenantId, expiresAt, now)
}

export function revokeToken(token: string) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

/** Revoga todas as sessões de um usuário (logout em todos os dispositivos). */
export function revokeAllUserSessions(userId: string): number {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
  return result.changes
}

/** Remove tokens expirados — chamado periodicamente */
function cleanupExpiredTokens() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
}

// Limpeza a cada 15 minutos
setInterval(cleanupExpiredTokens, 15 * 60 * 1000).unref()

/**
 * Middleware: exige Bearer token válido persistido no SQLite.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  const bearerToken = header?.startsWith('Bearer ') ? header.slice(7) : null
  const token = bearerToken ?? readTokenFromCookie(req)
  if (!token) {
    return res.status(401).json({ message: 'Token nao fornecido' })
  }
  const sessionRow = db
    .prepare('SELECT user_id, tenant_id, expires_at FROM sessions WHERE token = ?')
    .get(token) as { user_id: string; tenant_id: string; expires_at: number } | undefined
  if (!sessionRow) {
    return res.status(401).json({ message: 'Token invalido ou expirado' })
  }

  if (Date.now() > sessionRow.expires_at) {
    revokeToken(token)
    return res.status(401).json({ message: 'Sessao expirada. Faca login novamente.' })
  }

  const user = readAllUsersCached().find((u) => u.id === sessionRow.user_id)
  if (!user || user.status !== 'active') {
    revokeToken(token)
    return res.status(401).json({ message: 'Usuario inativo' })
  }

  const authReq = req as AuthenticatedRequest
  authReq.userId = user.id
  authReq.userRole = user.role
  authReq.tenantId = sessionRow.tenant_id ?? 'default'
  next()
}

/**
 * Middleware: exige role admin.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if ((req as AuthenticatedRequest).userRole !== 'admin') {
      return res.status(403).json({ message: 'Acesso restrito a administradores' })
    }
    next()
  })
}
