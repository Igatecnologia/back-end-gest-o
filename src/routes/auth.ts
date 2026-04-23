import { Router, type Response } from 'express'
import { z } from 'zod'
import {
  readAllUsers,
  writeAllUsers,
  verifyUserPassword,
  hashUserPassword,
} from '../userStorage.js'
import { resolveEffectivePermissions } from '../permissions.js'
import { randomBytes } from 'node:crypto'
import { registerToken, revokeToken, revokeAllUserSessions, requireAuth, type AuthenticatedRequest } from '../middleware/auth.js'
import rateLimit from 'express-rate-limit'
import { resolveTenantId } from '../utils/tenant.js'
import { logAudit } from '../services/auditLog.js'
import { generateCsrfToken, buildCsrfCookie } from '../middleware/csrf.js'

export const authRouter = Router()

function buildSessionCookie(token: string): string {
  const isProd = process.env.NODE_ENV === 'production'
  const parts = [
    `iga_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'Max-Age=28800',
    'SameSite=Strict',
  ]
  if (isProd) parts.push('Secure')
  return parts.join('; ')
}

function clearSessionCookie(): string {
  const isProd = process.env.NODE_ENV === 'production'
  const parts = [
    'iga_session=',
    'HttpOnly',
    'Path=/',
    'Max-Age=0',
    'SameSite=Strict',
  ]
  if (isProd) parts.push('Secure')
  return parts.join('; ')
}

function readSessionCookieToken(cookieHeader?: string): string | null {
  if (!cookieHeader) return null
  const cookies = cookieHeader.split(';')
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.trim().split('=')
    if (name !== 'iga_session') continue
    const value = valueParts.join('=')
    return value ? decodeURIComponent(value) : null
  }
  return null
}

/** Rate limit: 5 tentativas de login por IP a cada 15 min — mitiga brute force. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: 'Muitas tentativas. Aguarde 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const loginSchema = z.object({
  email: z.string().email('Email invalido'),
  password: z.string().min(1, 'Senha obrigatoria'),
})

const changePasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * POST /api/v1/auth/login
 */
authRouter.post('/login', loginLimiter, (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Dados invalidos' })
  }

  const { email, password } = parsed.data

  const user = readAllUsers().find(
    (u) => u.email.toLowerCase() === email.trim().toLowerCase() && u.status === 'active',
  )

  if (!user || !verifyUserPassword(password, user.passwordHash)) {
    logAudit({ action: 'login_failed', resource: 'auth', metadata: { email: email.trim().toLowerCase(), ip: req.ip } })
    return res.status(401).json({ message: 'Email ou senha incorretos' })
  }

  const token = randomBytes(32).toString('hex')
  const tenantId = resolveTenantId(req)
  registerToken(token, user.id, tenantId)
  logAudit({ userId: user.id, action: 'login_success', resource: 'auth', metadata: { ip: req.ip, tenantId } })
  const csrfToken = generateCsrfToken()
  res.setHeader('Set-Cookie', [buildSessionCookie(token), buildCsrfCookie(csrfToken)])

  const permissions = resolveEffectivePermissions(user.role, user.permissions)

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      /** Se true, frontend deve bloquear o app e redirecionar para troca de senha. */
      mustChangePassword: user.mustChangePassword ?? false,
    },
    permissions,
  })
})

/** Mínimo 12 chars, maiúscula, minúscula, dígito e caractere especial — impede senhas triviais. */
const strongPasswordSchema = z
  .string()
  .min(12, 'Senha deve ter no minimo 12 caracteres')
  .regex(/[a-z]/, 'Inclua ao menos uma letra minuscula')
  .regex(/[A-Z]/, 'Inclua ao menos uma letra maiuscula')
  .regex(/\d/, 'Inclua ao menos um numero')
  .regex(/[^A-Za-z0-9]/, 'Inclua ao menos um caractere especial (!@#$%...)')

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Senha atual obrigatoria'),
  newPassword: strongPasswordSchema,
})

/**
 * POST /api/v1/auth/change-password
 * Troca a senha do usuário autenticado. Limpa `mustChangePassword` se estava ativo.
 */
authRouter.post('/change-password', requireAuth, changePasswordLimiter, (req, res: Response) => {
  const authReq = req as unknown as AuthenticatedRequest
  const parsed = changePasswordSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Dados invalidos' })
  }
  const { currentPassword, newPassword } = parsed.data
  if (currentPassword === newPassword) {
    return res.status(400).json({ message: 'A nova senha deve ser diferente da atual' })
  }

  const all = readAllUsers()
  const idx = all.findIndex((u) => u.id === authReq.userId)
  if (idx < 0) return res.status(404).json({ message: 'Usuario nao encontrado' })

  if (!verifyUserPassword(currentPassword, all[idx].passwordHash)) {
    logAudit({ userId: authReq.userId, action: 'password_change_failed', resource: 'auth', metadata: { ip: req.ip } })
    return res.status(401).json({ message: 'Senha atual incorreta' })
  }

  all[idx] = {
    ...all[idx],
    passwordHash: hashUserPassword(newPassword),
    mustChangePassword: false,
    updatedAt: new Date().toISOString(),
  }
  writeAllUsers(all)
  logAudit({ userId: authReq.userId, action: 'password_changed', resource: 'auth', metadata: { ip: req.ip } })
  res.json({ ok: true })
})

/**
 * GET /api/v1/auth/me
 * Resolve usuário autenticado a partir do cookie HttpOnly/sessão ativa.
 */
authRouter.get('/me', requireAuth, (req, res) => {
  const authReq = req as unknown as AuthenticatedRequest
  const user = readAllUsers().find((u) => u.id === authReq.userId && u.status === 'active')
  if (!user) return res.status(401).json({ message: 'Sessão inválida' })
  const permissions = resolveEffectivePermissions(user.role, user.permissions)
  return res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword ?? false,
    },
    permissions,
  })
})

/**
 * POST /api/v1/auth/logout
 */
authRouter.post('/logout', (req, res) => {
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ')
    ? header.slice(7)
    : readSessionCookieToken(req.headers.cookie)
  if (token) revokeToken(token)
  logAudit({ action: 'logout', resource: 'auth', metadata: { ip: req.ip } })
  res.setHeader('Set-Cookie', clearSessionCookie())
  res.json({ ok: true })
})

/**
 * POST /api/v1/auth/logout-all
 * Revoga TODAS as sessões do usuário autenticado (logout em todos os dispositivos).
 */
authRouter.post('/logout-all', requireAuth, (req, res) => {
  const authReq = req as unknown as AuthenticatedRequest
  const revoked = revokeAllUserSessions(authReq.userId)
  logAudit({ userId: authReq.userId, action: 'logout_all', resource: 'auth', metadata: { ip: req.ip, sessionsRevoked: revoked } })
  res.setHeader('Set-Cookie', clearSessionCookie())
  res.json({ ok: true, sessionsRevoked: revoked })
})
