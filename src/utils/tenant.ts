import type { Request } from 'express'

const TENANT_HEADER = 'x-tenant-id'
const TENANT_FALLBACK = 'default'
const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

export function resolveTenantId(req: Request): string {
  const raw = req.header(TENANT_HEADER)?.trim()
  if (!raw) return TENANT_FALLBACK
  if (!TENANT_ID_PATTERN.test(raw)) return TENANT_FALLBACK
  return raw
}
