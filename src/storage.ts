import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export function readAll(): DataSource[] {
  ensureFile()
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf-8'))
  } catch {
    return []
  }
}

export function writeAll(items: DataSource[]) {
  ensureFile()
  writeFileSync(DATA_FILE, JSON.stringify(items, null, 2), 'utf-8')
}

export function genId(): string {
  return `ds_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`
}
