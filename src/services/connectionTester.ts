import type { DataSource } from '../storage.js'
import { hashPassword } from './passwordHasher.js'
import { extractDataArray } from '../utils/extractDataArray.js'

type TestResult = {
  success: boolean
  latencyMs: number
  message: string
  sampleFields?: string[]
  sampleRows?: Record<string, unknown>[]
  fieldTypes?: Record<string, string>
  totalRows?: number
}

const LOGIN_TIMEOUT_MS = 20_000
const DATA_TIMEOUT_MS = 45_000
const SERVER_TIMEOUT_MS = 15_000

function describeTimeout(err: unknown, context: string): string | null {
  if (!(err instanceof Error)) return null
  if (err.name === 'TimeoutError' || /aborted due to timeout/i.test(err.message)) {
    return `${context} demorou mais que o limite configurado (${Math.round(
      (context.includes('dados') ? DATA_TIMEOUT_MS : LOGIN_TIMEOUT_MS) / 1000,
    )}s). Tente reduzir o intervalo de datas ou validar a latencia da API externa.`
  }
  return null
}

function inferFieldType(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') {
    if (/^\d{4}[-./]\d{2}[-./]\d{2}/.test(value)) return 'date'
    if (/^\d+$/.test(value)) return 'numeric_string'
    if (/^\d+[.,]\d+$/.test(value)) return 'decimal_string'
    return 'string'
  }
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value
}

/**
 * Testa conexao com a API do cliente.
 */
export async function testConnection(ds: DataSource): Promise<TestResult> {
  const start = performance.now()
  const baseUrl = ds.apiUrl?.replace(/\/+$/, '')

  if (!baseUrl) {
    return { success: false, latencyMs: 0, message: 'Endereco do servidor nao informado' }
  }

  let token: string | null = null

  // ── Passo 1: Login (se configurado) ──
  if (ds.isAuthSource && ds.loginEndpoint) {
    try {
      const loginUrl = `${baseUrl}${ds.loginEndpoint}`
      const fieldUser = ds.loginFieldUser ?? 'login'
      const fieldPass = ds.loginFieldPassword ?? 'senha'
      const passwordMode = ds.passwordMode ?? 'plain'

      const apiLogin = (ds as DataSource & { apiLogin?: string }).apiLogin
      const apiPassword = (ds as DataSource & { apiPassword?: string }).apiPassword
      const rawCredentials = ds.authCredentials ?? (apiLogin ? `${apiLogin}:${apiPassword ?? ''}` : '')
      const colonIdx = rawCredentials.indexOf(':')
      const testUser = colonIdx >= 0 ? rawCredentials.slice(0, colonIdx) : rawCredentials || 'test'
      const testPass = await hashPassword(colonIdx >= 0 ? rawCredentials.slice(colonIdx + 1) : '', passwordMode)

      const loginBody: Record<string, string> = {
        [fieldUser]: testUser,
        [fieldPass]: testPass,
      }

      const loginRes = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginBody),
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      })

      if (!loginRes.ok) {
        const latencyMs = Math.round(performance.now() - start)
        return {
          success: false,
          latencyMs,
          message: loginRes.status === 401 || loginRes.status === 403
            ? `Login recusado (${loginRes.status}) — verifique usuario e senha`
            : `Erro no login (${loginRes.status})`,
        }
      }

      const loginData = await loginRes.json() as Record<string, unknown>
      token = (loginData.token ?? loginData.access_token ?? loginData.jwt ?? loginData.bearer ?? null) as string | null

      if (!token) {
        for (const [, val] of Object.entries(loginData)) {
          if (typeof val === 'string' && val.length >= 20 && /^[A-Za-z0-9._\-]+$/.test(val)) {
            token = val
            break
          }
        }
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start)
      const timeoutMessage = describeTimeout(err, 'Login')
      return {
        success: false,
        latencyMs,
        message: timeoutMessage ?? `Falha no login: ${err instanceof Error ? err.message : 'erro desconhecido'}`,
      }
    }
  }

  // ── Passo 2: Buscar dados ──
  if (ds.dataEndpoint) {
    try {
      let dataUrl = `${baseUrl}${ds.dataEndpoint}`

      if (!ds.dataEndpoint.includes('dt_de') && !ds.dataEndpoint.includes('start') && !ds.dataEndpoint.includes('desde')) {
        const now = new Date()
        const inicio = new Date('2020-01-01')

        const fmtDot = (d: Date) =>
          `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
        const fmtDash = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

        const sep = ds.dataEndpoint.includes('?') ? '&' : '?'

        if (ds.type === 'sgbr_bi') {
          dataUrl = `${dataUrl}${sep}dt_de=${fmtDot(inicio)}&dt_ate=${fmtDot(now)}`
        } else {
          dataUrl = `${dataUrl}${sep}dt_de=${fmtDot(inicio)}&dt_ate=${fmtDot(now)}&start_date=${fmtDash(inicio)}&end_date=${fmtDash(now)}`
        }
      }

      const headers: Record<string, string> = { Accept: 'application/json' }
      if (token) {
        headers.Authorization = `Bearer ${token}`
      } else if (ds.authMethod === 'bearer_token' && ds.authCredentials) {
        headers.Authorization = `Bearer ${ds.authCredentials}`
      } else if (ds.authMethod === 'api_key' && ds.authCredentials) {
        headers['X-API-Key'] = ds.authCredentials
      } else if (ds.authMethod === 'basic_auth' && ds.authCredentials) {
        headers.Authorization = `Basic ${Buffer.from(ds.authCredentials).toString('base64')}`
      }

      const dataRes = await fetch(dataUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(DATA_TIMEOUT_MS),
      })

      const latencyMs = Math.round(performance.now() - start)

      if (!dataRes.ok) {
        return {
          success: false,
          latencyMs,
          message: dataRes.status === 401
            ? 'Acesso negado aos dados — token invalido ou expirado'
            : `Erro ao buscar dados (${dataRes.status})`,
        }
      }

      const rawData = await dataRes.json()
      const arr = extractDataArray(rawData)

      if (arr.length === 0) {
        return {
          success: true,
          latencyMs,
          message: `Conectado (${latencyMs}ms) mas sem dados no periodo`,
          sampleFields: [],
          totalRows: 0,
        }
      }

      const firstRow = arr[0] as Record<string, unknown>
      const sampleFields = Object.keys(firstRow)
      const fieldTypes: Record<string, string> = {}
      for (const [key, value] of Object.entries(firstRow)) {
        fieldTypes[key] = inferFieldType(value)
      }

      const sampleRows = arr.slice(0, 3).map((row) => {
        const r = row as Record<string, unknown>
        const sanitized: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(r)) {
          if (typeof value === 'string' && value.length > 80) {
            sanitized[key] = value.slice(0, 80) + '...'
          } else {
            sanitized[key] = value
          }
        }
        return sanitized
      })

      return {
        success: true,
        latencyMs,
        message: `${arr.length} registro${arr.length !== 1 ? 's' : ''} encontrado${arr.length !== 1 ? 's' : ''} (${latencyMs}ms)`,
        sampleFields,
        sampleRows,
        fieldTypes,
        totalRows: arr.length,
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start)
      const timeoutMessage = describeTimeout(err, 'Consulta de dados')
      return {
        success: false,
        latencyMs,
        message: timeoutMessage ?? `Falha ao buscar dados: ${err instanceof Error ? err.message : 'erro'}`,
      }
    }
  }

  // ── Sem dataEndpoint — testa so o servidor ──
  try {
    const res = await fetch(baseUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
    })
    const latencyMs = Math.round(performance.now() - start)
    return {
      success: true,
      latencyMs,
      message: `Servidor alcancavel (${latencyMs}ms) — preencha o caminho dos dados`,
    }
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start)
    return {
      success: false,
      latencyMs,
      message: `Servidor nao respondeu: ${err instanceof Error ? err.message : 'erro'}`,
    }
  }
}
