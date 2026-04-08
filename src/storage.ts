import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_FILE = join(__dirname, '..', 'data', 'datasources.json')

export type DataSource = {
  id: string
  tenantId: string
  name: string
  type: string
  apiUrl: string
  authMethod: string
  authCredentials?: string
  status: string
  lastCheckedAt: string | null
  lastError: string | null
  fieldMappings: Array<{ standardField: string; sourceField: string; transform: string }>
  erpEndpoints: string[]
  isAuthSource: boolean
  loginEndpoint?: string
  dataEndpoint?: string
  passwordMode?: string
  loginFieldUser?: string
  loginFieldPassword?: string
  createdAt: string
  updatedAt: string
}

function ensureFile() {
  const dir = dirname(DATA_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(DATA_FILE)) writeFileSync(DATA_FILE, '[]', 'utf-8')
}

/* ── Cache em memória ── */
let cachedDs: DataSource[] | null = null
let cachedMtime = 0

export function readAll(): DataSource[] {
  ensureFile()
  try {
    const mtime = statSync(DATA_FILE).mtimeMs
    if (cachedDs && mtime === cachedMtime) return cachedDs
    cachedDs = JSON.parse(readFileSync(DATA_FILE, 'utf-8'))
    cachedMtime = mtime
    return cachedDs!
  } catch {
    return []
  }
}

export function writeAll(items: DataSource[]) {
  ensureFile()
  writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), 'utf-8')
  cachedDs = null
  cachedMtime = 0
}

export function genId(): string {
  return `ds_${randomBytes(6).toString('hex')}_${Date.now().toString(36)}`
}
