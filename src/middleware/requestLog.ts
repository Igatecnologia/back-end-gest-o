import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

/**
 * Log JSON por request (ativar com LOG_JSON_REQUESTS=1).
 * Inclui correlacao basica para observabilidade (Sprint 7).
 *
 * SEGURANÇA: este log NUNCA inclui body/query/headers — apenas path, status e
 * duração. Se for adicionar novos campos, manter a regra: zero conteúdo de
 * request (senhas, tokens, authCredentials etc. vazariam para stdout/arquivo).
 */
export function jsonRequestLog(req: Request, res: Response, next: NextFunction) {
  if (process.env.LOG_JSON_REQUESTS !== '1') {
    return next()
  }

  const requestId =
    typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim()
      ? req.headers['x-request-id'].trim()
      : randomUUID()
  res.setHeader('x-request-id', requestId)

  const started = Date.now()
  const tenantHeader = req.headers['x-tenant-id']
  const tenantId = typeof tenantHeader === 'string' ? tenantHeader : undefined

  res.on('finish', () => {
    const line = {
      t: new Date().toISOString(),
      level: 'info',
      event: 'http.request',
      requestId,
      method: req.method,
      path: req.originalUrl?.split('?')[0] ?? req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
      tenantId: tenantId ?? null,
    }
    console.log(JSON.stringify(line))
  })

  next()
}
