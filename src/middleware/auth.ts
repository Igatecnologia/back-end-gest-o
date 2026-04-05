import type { Request, Response, NextFunction } from 'express'
import { readAllUsers } from '../userStorage.js'

/**
 * Armazena tokens validos em memoria (token -> userId).
 * Em producao, usar JWT ou Redis.
 */
const activeTokens = new Map<string, string>()

export function registerToken(token: string, userId: string) {
  activeTokens.set(token, userId)
}

export function revokeToken(token: string) {
  activeTokens.delete(token)
}

/**
 * Middleware: exige Bearer token valido.
 * Adiciona req.userId e req.userRole ao request.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token nao fornecido' })
  }

  const token = header.slice(7)
  const userId = activeTokens.get(token)
  if (!userId) {
    return res.status(401).json({ message: 'Token invalido ou expirado' })
  }

  const user = readAllUsers().find((u) => u.id === userId)
  if (!user || user.status !== 'active') {
    activeTokens.delete(token)
    return res.status(401).json({ message: 'Usuario inativo' })
  }

  ;(req as any).userId = user.id
  ;(req as any).userRole = user.role
  next()
}

/**
 * Middleware: exige role admin.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    if ((req as any).userRole !== 'admin') {
      return res.status(403).json({ message: 'Acesso restrito a administradores' })
    }
    next()
  })
}
