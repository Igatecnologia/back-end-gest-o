import type { Request } from 'express'
import type { AuthenticatedRequest } from '../middleware/auth.js'

const TENANT_HEADER = 'x-tenant-id'
const TENANT_FALLBACK = 'default'
const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Resolve tenantId priorizando a sessão autenticada (seguro, não spoofável).
 * Fallback para header X-Tenant-ID apenas em rotas não autenticadas (ex: proxy/login).
 */
export function resolveTenantId(req: Request): string {
  // Sessão autenticada: tenantId veio do banco, não do header
  const authReq = req as Partial<AuthenticatedRequest>
  if (authReq.tenantId) return authReq.tenantId

  // Fallback para rotas sem auth (proxy/login, health, etc.)
  const raw = req.header(TENANT_HEADER)?.trim()
  if (!raw) return TENANT_FALLBACK
  if (!TENANT_ID_PATTERN.test(raw)) return TENANT_FALLBACK
  return raw
}
