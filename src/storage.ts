import { randomBytes } from 'node:crypto'
import { getDb } from './db/sqlite.js'
import { encryptSecret, decryptSecret, isEncryptedPayload } from './services/crypto.js'

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
  /** Configuração de paginação por datasource */
  paginationStyle?: string
  pageParam?: string
  perPageParam?: string
  defaultPerPage?: number
  cursorParam?: string
  cursorResponseField?: string
  createdAt: string
  updatedAt: string
}

const db = getDb()

/** Decripta credenciais lidas do banco. Suporta payload criptografado (JSON) e plaintext legado. */
function decryptStoredCredentials(raw: unknown): string | undefined {
  if (!raw) return undefined
  const str = String(raw)
  try {
    const parsed = JSON.parse(str) as unknown
    if (isEncryptedPayload(parsed)) return decryptSecret(parsed)
  } catch { /* não é JSON — plaintext legado */ }
  return str
}

function mapRow(row: Record<string, unknown>): DataSource {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    type: String(row.type),
    apiUrl: String(row.api_url),
    authMethod: String(row.auth_method),
    authCredentials: decryptStoredCredentials(row.auth_credentials_encrypted),
    status: String(row.status),
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    fieldMappings: JSON.parse(String(row.field_mappings_json ?? '[]')) as DataSource['fieldMappings'],
    erpEndpoints: JSON.parse(String(row.erp_endpoints_json ?? '[]')) as string[],
    isAuthSource: Number(row.is_auth_source ?? 0) === 1,
    loginEndpoint: row.login_endpoint ? String(row.login_endpoint) : undefined,
    dataEndpoint: row.data_endpoint ? String(row.data_endpoint) : undefined,
    passwordMode: row.password_mode ? String(row.password_mode) : undefined,
    loginFieldUser: row.login_field_user ? String(row.login_field_user) : undefined,
    loginFieldPassword: row.login_field_password ? String(row.login_field_password) : undefined,
    paginationStyle: row.pagination_style ? String(row.pagination_style) : undefined,
    pageParam: row.page_param ? String(row.page_param) : undefined,
    perPageParam: row.per_page_param ? String(row.per_page_param) : undefined,
    defaultPerPage: row.default_per_page ? Number(row.default_per_page) : undefined,
    cursorParam: row.cursor_param ? String(row.cursor_param) : undefined,
    cursorResponseField: row.cursor_response_field ? String(row.cursor_response_field) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export function readAll(): DataSource[] {
  const rows = db.prepare('SELECT * FROM datasources ORDER BY created_at ASC').all() as Record<string, unknown>[]
  return rows.map(mapRow)
}

export function writeAll(items: DataSource[]) {
  const clearStmt = db.prepare('DELETE FROM datasources')
  const insertStmt = db.prepare(`
    INSERT INTO datasources (
      id, tenant_id, name, type, api_url, auth_method, auth_credentials_encrypted, status, last_checked_at, last_error,
      field_mappings_json, erp_endpoints_json, is_auth_source, login_endpoint, data_endpoint, password_mode,
      login_field_user, login_field_password,
      pagination_style, page_param, per_page_param, default_per_page, cursor_param, cursor_response_field,
      created_at, updated_at
    ) VALUES (
      @id, @tenant_id, @name, @type, @api_url, @auth_method, @auth_credentials_encrypted, @status, @last_checked_at, @last_error,
      @field_mappings_json, @erp_endpoints_json, @is_auth_source, @login_endpoint, @data_endpoint, @password_mode,
      @login_field_user, @login_field_password,
      @pagination_style, @page_param, @per_page_param, @default_per_page, @cursor_param, @cursor_response_field,
      @created_at, @updated_at
    )
  `)
  const tx = db.transaction((records: DataSource[]) => {
    clearStmt.run()
    for (const item of records) {
      insertStmt.run({
        id: item.id,
        tenant_id: item.tenantId,
        name: item.name,
        type: item.type,
        api_url: item.apiUrl,
        auth_method: item.authMethod,
        auth_credentials_encrypted: item.authCredentials
          ? JSON.stringify(encryptSecret(item.authCredentials))
          : null,
        status: item.status,
        last_checked_at: item.lastCheckedAt,
        last_error: item.lastError,
        field_mappings_json: JSON.stringify(item.fieldMappings ?? []),
        erp_endpoints_json: JSON.stringify(item.erpEndpoints ?? []),
        is_auth_source: item.isAuthSource ? 1 : 0,
        login_endpoint: item.loginEndpoint ?? null,
        data_endpoint: item.dataEndpoint ?? null,
        password_mode: item.passwordMode ?? 'plain',
        login_field_user: item.loginFieldUser ?? 'login',
        login_field_password: item.loginFieldPassword ?? 'senha',
        pagination_style: item.paginationStyle ?? null,
        page_param: item.pageParam ?? null,
        per_page_param: item.perPageParam ?? null,
        default_per_page: item.defaultPerPage ?? null,
        cursor_param: item.cursorParam ?? null,
        cursor_response_field: item.cursorResponseField ?? null,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
      })
    }
  })
  tx(items)
}

/** Fila de escrita — evita perder fontes quando vários POST /test ou CRUD rodam em paralelo. */
let datasourcesWriteChain: Promise<unknown> = Promise.resolve()

export function runWithDatasourcesLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = datasourcesWriteChain.then(() => fn())
  datasourcesWriteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function genId(): string {
  return `ds_${randomBytes(6).toString('hex')}_${Date.now().toString(36)}`
}
