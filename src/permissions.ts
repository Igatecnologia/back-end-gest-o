/** Alinhado ao front-end (`auth/permissions.ts` + `authService` ROLE_PERMISSIONS). */

export const ALL_PERMISSIONS = [
  'dashboard:view',
  'reports:view',
  'reports:export',
  'audit:view',
  'audit:export',
  'users:view',
  'users:write',
  'producao:view',
  'producao:write',
  'fichatecnica:view',
  'fichatecnica:write',
  'comercial:view',
  'comercial:write',
  'estoque:view',
  'estoque:write',
  'alertas:view',
  'support:view',
  'datasources:view',
  'operations:view',
] as const

export type PermissionString = (typeof ALL_PERMISSIONS)[number]

const SET = new Set<string>(ALL_PERMISSIONS)

export function isValidPermission(p: string): p is PermissionString {
  return SET.has(p)
}

const SUPPORT_EXCLUSIVE = new Set<string>([
  'support:view',
  'datasources:view',
  'operations:view',
])

const ROLE_PERMISSIONS: Record<'admin' | 'manager' | 'viewer', PermissionString[]> = {
  admin: [...ALL_PERMISSIONS],
  manager: ALL_PERMISSIONS.filter(
    (p) => !p.startsWith('users:') && !SUPPORT_EXCLUSIVE.has(p),
  ) as PermissionString[],
  viewer: ALL_PERMISSIONS.filter(
    (p) => p.endsWith(':view') && !SUPPORT_EXCLUSIVE.has(p),
  ) as PermissionString[],
}

/**
 * Permissões efetivas: se `custom` for array não vazio, usa (validado); senão perfil.
 */
export function resolveEffectivePermissions(
  role: 'admin' | 'manager' | 'viewer',
  custom: string[] | undefined | null,
): PermissionString[] {
  if (custom != null && custom.length > 0) {
    const uniq = [...new Set(custom.filter((p) => isValidPermission(p)))]
    if (uniq.length > 0) return uniq.sort() as PermissionString[]
  }
  return [...ROLE_PERMISSIONS[role]]
}
