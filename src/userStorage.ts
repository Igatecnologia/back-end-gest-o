import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_FILE = join(__dirname, '..', 'data', 'users.json')

export type UserRecord = {
  id: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'viewer'
  status: 'active' | 'inactive'
  passwordHash: string
  createdAt: string
  updatedAt: string
}

function ensureFile() {
  const dir = dirname(DATA_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(DATA_FILE)) writeFileSync(DATA_FILE, '[]', 'utf-8')
}

export function readAllUsers(): UserRecord[] {
  ensureFile()
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'))
  } catch {
    return []
  }
}

export function writeAllUsers(items: UserRecord[]) {
  ensureFile()
  writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), 'utf-8')
}

export function genUserId(): string {
  return `usr_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
}

// ─── Password hashing (scrypt, zero deps) ──────────────────────────────────

export function hashUserPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derived}`
}

export function verifyUserPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const derived = scryptSync(password, salt, 64)
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'))
}
