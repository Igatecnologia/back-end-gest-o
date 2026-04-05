import { Router } from 'express'
import { readAllUsers, verifyUserPassword } from '../userStorage.js'
import { randomBytes } from 'node:crypto'
import { registerToken, revokeToken } from '../middleware/auth.js'
import rateLimit from 'express-rate-limit'

export const authRouter = Router()

/** Rate limit: maximo 10 tentativas de login por IP a cada 15 min */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Muitas tentativas. Aguarde 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * POST /api/v1/auth/login
 * Publica — sem middleware de auth.
 */
authRouter.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ message: 'Email e senha obrigatorios' })
  }

  const user = readAllUsers().find(
    (u) => u.email.toLowerCase() === email.trim().toLowerCase() && u.status === 'active',
  )

  if (!user || !verifyUserPassword(password, user.passwordHash)) {
    return res.status(401).json({ message: 'Email ou senha incorretos' })
  }

  const token = randomBytes(32).toString('hex')
  registerToken(token, user.id)

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  })
})

/**
 * POST /api/v1/auth/logout
 * Invalida o token.
 */
authRouter.post('/logout', (req, res) => {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    revokeToken(header.slice(7))
  }
  res.json({ ok: true })
})
