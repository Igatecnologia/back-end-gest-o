import { Router } from 'express'
import { z } from 'zod'
import { readAllUsers, verifyUserPassword } from '../userStorage.js'
import { resolveEffectivePermissions } from '../permissions.js'
import { randomBytes } from 'node:crypto'
import { registerToken, revokeToken } from '../middleware/auth.js'
import rateLimit from 'express-rate-limit'

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

/** Rate limit: maximo 10 tentativas de login por IP a cada 15 min */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Muitas tentativas. Aguarde 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const loginSchema = z.object({
  email: z.string().email('Email invalido'),
  password: z.string().min(1, 'Senha obrigatoria'),
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
    return res.status(401).json({ message: 'Email ou senha incorretos' })
  }

  const token = randomBytes(32).toString('hex')
  registerToken(token, user.id)
  res.setHeader('Set-Cookie', buildSessionCookie(token))

  const permissions = resolveEffectivePermissions(user.role, user.permissions)

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
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
  res.setHeader('Set-Cookie', clearSessionCookie())
  res.json({ ok: true })
})
