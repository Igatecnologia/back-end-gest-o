/**
 * CSRF protection via double-submit cookie pattern.
 *
 * - No login: emitir cookie `XSRF-TOKEN` (readable pelo JS, NÃO HttpOnly)
 * - Em POST/PUT/DELETE: validar que header `X-XSRF-TOKEN` === cookie `XSRF-TOKEN`
 *
 * O frontend (axios interceptor) já lê o cookie e envia o header automaticamente.
 */
import { randomBytes } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

const CSRF_COOKIE = 'XSRF-TOKEN'
const CSRF_HEADER = 'x-xsrf-token'
const TOKEN_LENGTH = 32

/** Rotas isentas de CSRF (não usam cookies de sessão). */
const EXEMPT_PATHS = [
  '/api/v1/auth/login',
  '/api/proxy/login',
  '/health',
  '/health/live',
  '/health/ready',
]

function isExempt(path: string): boolean {
  return EXEMPT_PATHS.some((p) => path === p || path.startsWith(p + '/'))
}

export function generateCsrfToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('hex')
}

/**
 * Secure flag só em HTTPS real — Electron serve via http://127.0.0.1 e o
 * Chromium descarta cookies Secure em conexões não-TLS.
 */
const useSecureCookie =
  process.env.NODE_ENV === 'production' && !process.env.ELECTRON_RUN_AS_NODE

export function buildCsrfCookie(token: string): string {
  const parts = [
    `${CSRF_COOKIE}=${token}`,
    'Path=/',
    'Max-Age=28800', // 8h, mesmo que a sessão
    'SameSite=Strict',
  ]
  if (useSecureCookie) parts.push('Secure')
  // NÃO HttpOnly — o frontend precisa ler esse cookie
  return parts.join('; ')
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = pair.trim().split('=')
    if (rawName === name) return rawValue.join('=') || null
  }
  return null
}

/**
 * Middleware de CSRF: valida em POST/PUT/DELETE que o header bate com o cookie.
 * GET/HEAD/OPTIONS passam sem verificação.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Métodos seguros não precisam de CSRF
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()

  // Rotas isentas
  if (isExempt(req.path)) return next()

  const cookieToken = readCookie(req.headers.cookie, CSRF_COOKIE)
  const headerToken = req.header(CSRF_HEADER)

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ message: 'CSRF token invalido ou ausente' })
  }

  next()
}
