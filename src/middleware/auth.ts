import type { Request, Response, NextFunction } from 'express'
import { readAllUsersCached } from '../userStorage.js'

/* ── Tipos extendidos para o Request ── */
export interface AuthenticatedRequest extends Request {
  userId: string
  userRole: string
}

/* ── Token store com TTL ── */
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000 // 8 horas

type TokenEntry = { userId: string; createdAt: number }
const activeTokens = new Map<string, TokenEntry>()

export function registerToken(token: string, userId: string) {
  activeTokens.set(token, { userId, createdAt: Date.now() })
}

export function revokeToken(token: string) {
  activeTokens.delete(token)
}

/** Remove tokens expirados — chamado periodicamente */
function cleanupExpiredTokens() {
  const now = Date.now()
  for (const [token, entry] of activeTokens) {
    if (now - entry.createdAt > TOKEN_TTL_MS) {
      activeTokens.delete(token)
    }
  }
}

// Limpeza a cada 15 minutos
setInterval(cleanupExpiredTokens, 15 * 60 * 1000).unref()

/**
 * Middleware: exige Bearer token valido com TTL.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token nao fornecido' })
  }

  const token = header.slice(7)
  const entry = activeTokens.get(token)
  if (!entry) {
    return res.status(401).json({ message: 'Token invalido ou expirado' })
  }

  // Verificar TTL
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    activeTokens.delete(token)
    return res.status(401).json({ message: 'Sessao expirada. Faca login novamente.' })
  }

  const user = readAllUsersCached().find((u) => u.id === entry.userId)
  if (!user || user.status !== 'active') {
    activeTokens.delete(token)
    return res.status(401).json({ message: 'Usuario inativo' })
  }

  const authReq = req as AuthenticatedRequest
  authReq.userId = user.id
  authReq.userRole = user.role
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
