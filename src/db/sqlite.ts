import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from '../paths.js'
import { decryptSecret, encryptSecret, isEncryptedPayload } from '../services/crypto.js'

type LegacyUser = {
  id: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'viewer'
  status: 'active' | 'inactive'
  permissions?: string[]
  passwordHash: string
  mustChangePassword?: boolean
  createdAt: string
  updatedAt: string
}

type LegacyDataSource = {
  id: string
  tenantId: string
  name: string
  type: string
  apiUrl: string
  authMethod: string
  authCredentials?: unknown
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

const dataDir = resolveDataDir()
const dbPath = join(dataDir, 'iga.db')
const usersJsonPath = join(dataDir, 'users.json')
const datasourcesJsonPath = join(dataDir, 'datasources.json')

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  permissions_json TEXT NULL,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  preferences_json TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS datasources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  api_url TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  auth_credentials_encrypted TEXT NULL,
  status TEXT NOT NULL,
  last_checked_at TEXT NULL,
  last_error TEXT NULL,
  field_mappings_json TEXT NOT NULL,
  erp_endpoints_json TEXT NOT NULL,
  is_auth_source INTEGER NOT NULL DEFAULT 0,
  login_endpoint TEXT NULL,
  data_endpoint TEXT NULL,
  password_mode TEXT NULL,
  login_field_user TEXT NULL,
  login_field_password TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT NULL
);

CREATE TABLE IF NOT EXISTS copilot_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  report_type TEXT NOT NULL,
  frequency TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  format TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  metadata_json TEXT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_datasources_tenant ON datasources(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant_created ON alerts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_user_created ON copilot_messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_active ON scheduled_reports(active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user_created ON audit_log(user_id, created_at DESC);
`)

// Migração v2: tenant_id na sessão (idempotente)
try { db.exec("ALTER TABLE sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'") } catch { /* já existe */ }

// Migração v3: colunas de configuração de paginação por datasource (idempotente)
const paginationColumns = [
  'pagination_style TEXT NULL',
  'page_param TEXT NULL',
  'per_page_param TEXT NULL',
  'default_per_page INTEGER NULL',
  'cursor_param TEXT NULL',
  'cursor_response_field TEXT NULL',
]
for (const col of paginationColumns) {
  try { db.exec(`ALTER TABLE datasources ADD COLUMN ${col}`) } catch { /* coluna já existe */ }
}

function readLegacyFile<T>(path: string): T[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as T[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function backupLegacyJson() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (existsSync(usersJsonPath)) copyFileSync(usersJsonPath, join(dataDir, `users.backup-${stamp}.json`))
  if (existsSync(datasourcesJsonPath)) copyFileSync(datasourcesJsonPath, join(dataDir, `datasources.backup-${stamp}.json`))
}

/** Migração: converte credenciais legadas (plaintext ou encrypted antigo) para payload criptografado AES-256-GCM. */
function normalizeLegacyAuthCredentials(value: unknown): string | null {
  if (!value) return null
  let plaintext: string
  if (typeof value === 'string') {
    plaintext = value
  } else if (isEncryptedPayload(value)) {
    plaintext = decryptSecret(value)
  } else {
    return null
  }
  return JSON.stringify(encryptSecret(plaintext))
}

function migrateFromJsonIfNeeded() {
  const usersCount = Number((db.prepare('SELECT COUNT(*) AS total FROM users').get() as { total: number }).total ?? 0)
  const dsCount = Number((db.prepare('SELECT COUNT(*) AS total FROM datasources').get() as { total: number }).total ?? 0)
  if (usersCount > 0 || dsCount > 0) return

  const legacyUsers = readLegacyFile<LegacyUser>(usersJsonPath)
  const legacyDataSources = readLegacyFile<LegacyDataSource>(datasourcesJsonPath)
  if (!legacyUsers.length && !legacyDataSources.length) return

  backupLegacyJson()

  const insertUser = db.prepare(`
    INSERT INTO users (
      id, name, email, role, status, permissions_json, password_hash, must_change_password, created_at, updated_at
    ) VALUES (
      @id, @name, @email, @role, @status, @permissions_json, @password_hash, @must_change_password, @created_at, @updated_at
    )
  `)
  const insertDs = db.prepare(`
    INSERT INTO datasources (
      id, tenant_id, name, type, api_url, auth_method, auth_credentials_encrypted, status, last_checked_at, last_error,
      field_mappings_json, erp_endpoints_json, is_auth_source, login_endpoint, data_endpoint, password_mode,
      login_field_user, login_field_password, created_at, updated_at
    ) VALUES (
      @id, @tenant_id, @name, @type, @api_url, @auth_method, @auth_credentials_encrypted, @status, @last_checked_at, @last_error,
      @field_mappings_json, @erp_endpoints_json, @is_auth_source, @login_endpoint, @data_endpoint, @password_mode,
      @login_field_user, @login_field_password, @created_at, @updated_at
    )
  `)

  const tx = db.transaction(() => {
    for (const user of legacyUsers) {
      insertUser.run({
        id: user.id,
        name: user.name,
        email: user.email.toLowerCase(),
        role: user.role,
        status: user.status,
        permissions_json: user.permissions?.length ? JSON.stringify(user.permissions) : null,
        password_hash: user.passwordHash,
        must_change_password: user.mustChangePassword ? 1 : 0,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
      })
    }
    for (const ds of legacyDataSources) {
      insertDs.run({
        id: ds.id,
        tenant_id: ds.tenantId,
        name: ds.name,
        type: ds.type,
        api_url: ds.apiUrl,
        auth_method: ds.authMethod,
        auth_credentials_encrypted: normalizeLegacyAuthCredentials(ds.authCredentials),
        status: ds.status,
        last_checked_at: ds.lastCheckedAt,
        last_error: ds.lastError,
        field_mappings_json: JSON.stringify(ds.fieldMappings ?? []),
        erp_endpoints_json: JSON.stringify(ds.erpEndpoints ?? []),
        is_auth_source: ds.isAuthSource ? 1 : 0,
        login_endpoint: ds.loginEndpoint ?? null,
        data_endpoint: ds.dataEndpoint ?? null,
        password_mode: ds.passwordMode ?? 'plain',
        login_field_user: ds.loginFieldUser ?? 'login',
        login_field_password: ds.loginFieldPassword ?? 'senha',
        created_at: ds.createdAt,
        updated_at: ds.updatedAt,
      })
    }
  })
  tx()
}

migrateFromJsonIfNeeded()

/** Re-encripta credenciais plaintext existentes no SQLite (migração única, idempotente). */
function encryptPlaintextCredentials() {
  const rows = db.prepare(
    'SELECT id, auth_credentials_encrypted FROM datasources WHERE auth_credentials_encrypted IS NOT NULL',
  ).all() as Array<{ id: string; auth_credentials_encrypted: string }>

  const update = db.prepare('UPDATE datasources SET auth_credentials_encrypted = ? WHERE id = ?')

  let migrated = 0
  const tx = db.transaction(() => {
    for (const row of rows) {
      const raw = row.auth_credentials_encrypted
      try {
        const parsed = JSON.parse(raw) as unknown
        if (isEncryptedPayload(parsed)) continue
      } catch { /* não é JSON — é plaintext, precisa encriptar */ }
      update.run(JSON.stringify(encryptSecret(raw)), row.id)
      migrated++
    }
  })
  tx()
  if (migrated > 0) {
    console.log(`[IGA][SEC] ${migrated} credencial(is) migrada(s) de plaintext para AES-256-GCM.`)
  }
}

encryptPlaintextCredentials()

export function getDb(): any {
  return db
}

export function getDbPath() {
  return dbPath
}
