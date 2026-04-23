import type { DataSource } from '../storage.js'
import { hashPassword } from './passwordHasher.js'
import { extractDataArray } from '../utils/extractDataArray.js'
import { joinApiUrl } from '../utils/joinApiUrl.js'

type TestResult = {
  success: boolean
  latencyMs: number
  message: string
  sampleFields?: string[]
  sampleRows?: Record<string, unknown>[]
  fieldTypes?: Record<string, string>
  /** Linhas contadas nesta resposta (geralmente 1ª página). */
  totalRows?: number
  /** Quando a API envia total de registros na raiz, pode ser > linhas da 1ª resposta. */
  apiReportedTotal?: number
}

const LOGIN_TIMEOUT_MS = 20_000
/** Deve ser ≤ timeout HTTP do frontend (axios) e suficiente para SGBR em intervalos grandes */
const DATA_TIMEOUT_MS = 120_000
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

/**
 * Compara linhas extraídas com metadados comuns de paginação / total na raiz do JSON SGBR.
 */
function describeCountVersusApiMeta(
  rawData: unknown,
  arrLen: number,
): { messageSuffix: string; apiReportedTotal?: number } {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    return { messageSuffix: '' }
  }
  const o = rawData as Record<string, unknown>
  const totalRec =
    typeof o.total === 'number'
      ? o.total
      : typeof o.total_registros === 'number'
        ? o.total_registros
        : typeof o.totalRows === 'number'
          ? o.totalRows
          : typeof o.qt_registros === 'number'
            ? o.qt_registros
            : typeof o.qtd_registros === 'number'
              ? o.qtd_registros
              : undefined
  const totalPages =
    typeof o.totalPages === 'number'
      ? o.totalPages
      : typeof o.total_paginas === 'number'
        ? o.total_paginas
        : typeof o.last_page === 'number'
          ? o.last_page
          : undefined
  const page = typeof o.page === 'number' ? o.page : typeof o.pagina === 'number' ? o.pagina : undefined

  if (typeof totalRec === 'number' && totalRec > arrLen) {
    return {
      messageSuffix: ` — total informado pela API: ${totalRec} (nesta resposta: ${arrLen} linhas)`,
      apiReportedTotal: totalRec,
    }
  }
  if (typeof totalPages === 'number' && totalPages > 1) {
    return {
      messageSuffix: ` — página ${page ?? 1}/${totalPages}: o teste só analisa a 1ª resposta; no app o proxy pode buscar as demais`,
      apiReportedTotal: typeof totalRec === 'number' ? totalRec : undefined,
    }
  }
  if (typeof totalRec === 'number' && totalRec === arrLen) {
    return {
      messageSuffix: ` — total na API coincide com esta resposta (${arrLen})`,
      apiReportedTotal: totalRec,
    }
  }
  return { messageSuffix: '' }
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

  // ── Passo 1: Login JWT (se configurado) — independente de isAuthSource (só uma fonte pode ser login do app, mas todas podem ter token para consultas)
  if (ds.loginEndpoint) {
    try {
      const loginUrl = joinApiUrl(baseUrl, ds.loginEndpoint ?? '')
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
          if (typeof val === 'string' && val.length >= 20 && /^[A-Za-z0-9._-]+$/.test(val)) {
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
      let dataUrl = joinApiUrl(baseUrl, ds.dataEndpoint ?? '')

      if (!ds.dataEndpoint.includes('dt_de') && !ds.dataEndpoint.includes('start') && !ds.dataEndpoint.includes('desde')) {
        const now = new Date()
        const inicio = new Date(now)
        /** Endpoints financeiros (contas a pagar/receber) podem trazer payload enorme: janela curta no teste. */
        const isHeavyEndpoint = /contas[/_-]?(pag|receber)/i.test(ds.dataEndpoint)
        if (isHeavyEndpoint) {
          inicio.setDate(inicio.getDate() - 30)
        } else {
          inicio.setMonth(inicio.getMonth() - 3)
        }

        const fmtDot = (d: Date) =>
          `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
        const fmtDash = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

        const sep = ds.dataEndpoint.includes('?') ? '&' : '?'

        if (ds.type === 'sgbr_bi') {
          /** `tamanho=100` limita o payload no teste — valida conectividade sem puxar base inteira. */
          dataUrl = `${dataUrl}${sep}dt_de=${fmtDot(inicio)}&dt_ate=${fmtDot(now)}&tamanho=100`
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
        const pathHint = ds.dataEndpoint?.trim() || '(sem caminho)'
        const baseHint = joinApiUrl(baseUrl, pathHint)
        return {
          success: false,
          latencyMs,
          message:
            dataRes.status === 401
              ? 'Acesso negado aos dados — token invalido ou expirado'
              : dataRes.status === 404
                ? `404 na API externa — rota inexistente. Confira "Caminho dos dados" (ex.: /sgbrbi/contas/pagas). Tentativa: ${baseHint}`
                : `Erro ao buscar dados (${dataRes.status}) — ${baseHint}`,
        }
      }

      const rawData = await dataRes.json()
      const arr = extractDataArray(rawData)
      const countMeta = describeCountVersusApiMeta(rawData, arr.length)

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
        message: `${arr.length} registro${arr.length !== 1 ? 's' : ''} nesta resposta${countMeta.messageSuffix} (${latencyMs}ms)`,
        sampleFields,
        sampleRows,
        fieldTypes,
        totalRows: arr.length,
        ...(countMeta.apiReportedTotal != null ? { apiReportedTotal: countMeta.apiReportedTotal } : {}),
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
