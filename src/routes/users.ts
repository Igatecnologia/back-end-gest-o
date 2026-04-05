import { Router } from 'express'
import {
  readAllUsers,
  writeAllUsers,
  genUserId,
  hashUserPassword,
  type UserRecord,
} from '../userStorage.js'

export const usersRouter = Router()

/** Retorna usuario sem o hash da senha */
function sanitize(u: UserRecord) {
  const { passwordHash: _, ...safe } = u
  return safe
}

// GET / — lista todos
usersRouter.get('/', (_req, res) => {
  res.json(readAllUsers().map(sanitize))
})

// POST / — cria usuario
usersRouter.post('/', (req, res) => {
  const { name, email, password, role, status } = req.body

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'Nome, email e senha obrigatorios' })
  }

  const all = readAllUsers()
  if (all.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) {
    return res.status(409).json({ message: 'Ja existe um usuario com este email' })
  }

  const now = new Date().toISOString()
  const user: UserRecord = {
    id: genUserId(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    role: role ?? 'viewer',
    status: status ?? 'active',
    passwordHash: hashUserPassword(password),
    createdAt: now,
    updatedAt: now,
  }

  writeAllUsers([...all, user])
  res.status(201).json(sanitize(user))
})

// PUT /:id — atualiza usuario
usersRouter.put('/:id', (req, res) => {
  const all = readAllUsers()
  const idx = all.findIndex((u) => u.id === req.params.id)
  if (idx < 0) return res.status(404).json({ message: 'Usuario nao encontrado' })

  const { name, email, password, role, status } = req.body

  // Verifica email duplicado
  if (email) {
    const duplicate = all.find(
      (u, i) => i !== idx && u.email.toLowerCase() === email.trim().toLowerCase(),
    )
    if (duplicate) {
      return res.status(409).json({ message: 'Ja existe um usuario com este email' })
    }
  }

  all[idx] = {
    ...all[idx],
    ...(name != null && { name: name.trim() }),
    ...(email != null && { email: email.trim().toLowerCase() }),
    ...(role != null && { role }),
    ...(status != null && { status }),
    ...(password && { passwordHash: hashUserPassword(password) }),
    updatedAt: new Date().toISOString(),
  }

  writeAllUsers(all)
  res.json(sanitize(all[idx]))
})

// DELETE /:id
usersRouter.delete('/:id', (req, res) => {
  const all = readAllUsers()
  const filtered = all.filter((u) => u.id !== req.params.id)
  if (filtered.length === all.length) {
    return res.status(404).json({ message: 'Usuario nao encontrado' })
  }
  writeAllUsers(filtered)
  res.json({ ok: true })
})
