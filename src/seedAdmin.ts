import { readAllUsers, writeAllUsers, genUserId, hashUserPassword } from './userStorage.js'

export function seedDefaultAdmin() {
  const users = readAllUsers()
  if (users.length > 0) return

  const now = new Date().toISOString()
  const admin = {
    id: genUserId(),
    name: 'Administrador',
    email: 'admin@iga.com',
    role: 'admin' as const,
    status: 'active' as const,
    passwordHash: hashUserPassword('admin123'),
    createdAt: now,
    updatedAt: now,
  }

  writeAllUsers([admin])
  console.log('[IGA Backend] Usuario admin padrao criado. Troque a senha apos o primeiro login.')
}
