import { describe, expect, it } from 'vitest'
import { resolveEffectivePermissions } from './permissions.js'

describe('permissions', () => {
  it('uses role defaults when custom is empty', () => {
    const perms = resolveEffectivePermissions('viewer', [])
    expect(perms).toContain('dashboard:view')
    expect(perms).not.toContain('users:write')
  })

  it('uses valid custom permissions', () => {
    const perms = resolveEffectivePermissions('manager', ['users:write', 'dashboard:view', 'invalid'])
    expect(perms).toContain('users:write')
    expect(perms).toContain('dashboard:view')
    expect(perms).not.toContain('invalid')
  })
})
