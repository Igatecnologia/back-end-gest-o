import type { DataSource } from '../storage.js'
import { hashPassword } from './passwordHasher.js'

type TestResult = {
  success: boolean
  latencyMs: number
  message: string
  sampleFields?: string[]
}

/**
 * Testa conexao com a API do cliente.
 * 1. Se tem loginEndpoint — faz login primeiro para pegar token
 * 2. Se tem dataEndpoint — busca dados reais com o token
 * 3. Retorna campos encontrados no primeiro registro
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

      // Credenciais no formato "usuario:senha" ou so "usuario" (senha vazia)
      const creds = (ds.authCredentials ?? '').split(':')
      const testUser = creds[0] || 'test'
      const testPass = await hashPassword(creds[1] || '', passwordMode)

      const loginBody: Record<string, string> = {
        [fieldUser]: testUser,
        [fieldPass]: testPass,
      }

      const loginRes = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginBody),
        signal: AbortSignal.timeout(10_000),
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

      const loginData = await loginRes.json()
      token = loginData.token ?? loginData.access_token ?? loginData.jwt ?? null
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start)
      return {
        success: false,
        latencyMs,
        message: `Falha no login: ${err instanceof Error ? err.message : 'erro desconhecido'}`,
      }
    }
  }

  // ── Passo 2: Buscar dados ──
  if (ds.dataEndpoint) {
    try {
      // Monta URL buscando todos os registros (periodo amplo)
      const fmt = (d: Date) =>
        `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
      const now = new Date()
      const inicio = new Date('2020-01-01')

      const sep = ds.dataEndpoint.includes('?') ? '&' : '?'
      const dataUrl = `${baseUrl}${ds.dataEndpoint}${sep}dt_de=${fmt(inicio)}&dt_ate=${fmt(now)}`

      const headers: Record<string, string> = { Accept: 'application/json' }
      if (token) headers.Authorization = `Bearer ${token}`
      if (ds.authMethod === 'bearer_token' && ds.authCredentials && !token) {
        headers.Authorization = `Bearer ${ds.authCredentials}`
      }
      if (ds.authMethod === 'api_key' && ds.authCredentials) {
        headers['X-API-Key'] = ds.authCredentials
      }

      const dataRes = await fetch(dataUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15_000),
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

      const data = await dataRes.json()
      const arr = Array.isArray(data) ? data : data?.items ?? data?.data ?? data?.rows ?? []

      if (arr.length === 0) {
        return {
          success: true,
          latencyMs,
          message: `Conectado (${latencyMs}ms) mas sem dados no periodo`,
          sampleFields: [],
        }
      }

      const sampleFields = Object.keys(arr[0])
      return {
        success: true,
        latencyMs,
        message: `${arr.length} registro${arr.length !== 1 ? 's' : ''} encontrado${arr.length !== 1 ? 's' : ''} (${latencyMs}ms)`,
        sampleFields,
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - start)
      return {
        success: false,
        latencyMs,
        message: `Falha ao buscar dados: ${err instanceof Error ? err.message : 'erro'}`,
      }
    }
  }

  // ── Sem dataEndpoint — testa so o servidor ──
  try {
    const res = await fetch(baseUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
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
