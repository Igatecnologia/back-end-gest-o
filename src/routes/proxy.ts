import { Router } from 'express'
import { readAll } from '../storage.js'
import { hashPassword } from '../services/passwordHasher.js'

export const proxyRouter = Router()

// ─── Cache de tokens por data source (evita login a cada request) ──────────
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getTokenForSource(source: ReturnType<typeof readAll>[number]): Promise<string | null> {
  const cacheKey = source.id ?? source.apiUrl

  // Se tem token em cache e não expirou
  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token
  }

  // Faz login na API para obter token
  if (!source.isAuthSource || !source.loginEndpoint) return null

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const loginEndpoint = source.loginEndpoint
  const fieldUser = source.loginFieldUser ?? 'login'
  const fieldPass = source.loginFieldPassword ?? 'senha'
  const passwordMode = source.passwordMode ?? 'plain'

  // Credenciais do datasource (formato "login:senha") ou variáveis de ambiente
  const rawCreds = source.authCredentials ?? process.env.SGBR_CREDENTIALS ?? ''
  const colonIdx = rawCreds.indexOf(':')
  const defaultLogin = colonIdx >= 0 ? rawCreds.slice(0, colonIdx) : rawCreds
  const defaultPassword = colonIdx >= 0 ? rawCreds.slice(colonIdx + 1) : ''

  if (!defaultLogin || !defaultPassword) return null

  try {
    const hashedPassword = await hashPassword(defaultPassword, passwordMode)
    const body: Record<string, string> = {
      [fieldUser]: defaultLogin,
      [fieldPass]: hashedPassword,
    }

    const apiRes = await fetch(`${baseUrl}${loginEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })

    if (!apiRes.ok) return null

    const data = await apiRes.json() as Record<string, unknown>
    const token = (data.token ?? data.access_token ?? data.jwt ?? data.bearer) as string | undefined
    if (!token) return null

    // Cache por 55 minutos (tokens geralmente duram 1h)
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 55 * 60 * 1000 })
    return token
  } catch {
    return null
  }
}

/**
 * Extrai o array de dados de uma resposta, independente do formato.
 */
function extractDataArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    for (const key of ['items', 'data', 'rows', 'results', 'records', 'content', 'list', 'entries', 'valores', 'registros']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }
    const keys = Object.keys(obj)
    if (keys.length === 1 && Array.isArray(obj[keys[0]])) {
      return obj[keys[0]] as unknown[]
    }
  }
  return []
}

/**
 * POST /api/proxy/login
 * O front envia { login, password } e o backend faz login na API do cliente.
 */
proxyRouter.post('/login', async (req, res) => {
  const { login, password } = req.body
  if (!login || !password) {
    return res.status(400).json({ message: 'Usuario e senha obrigatorios' })
  }

  const authSource = readAll().find((ds) => ds.isAuthSource)
  if (!authSource) {
    return res.status(400).json({ message: 'Nenhuma conexao configurada para login' })
  }

  const baseUrl = authSource.apiUrl.replace(/\/+$/, '')
  const loginEndpoint = authSource.loginEndpoint ?? '/sgbrbi/usuario/login'
  const fieldUser = authSource.loginFieldUser ?? 'login'
  const fieldPass = authSource.loginFieldPassword ?? 'senha'
  const passwordMode = authSource.passwordMode ?? 'plain'

  try {
    const hashedPassword = await hashPassword(password, passwordMode)
    const body: Record<string, string> = {
      [fieldUser]: login,
      [fieldPass]: hashedPassword,
    }

    const apiRes = await fetch(`${baseUrl}${loginEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })

    if (!apiRes.ok) {
      const status = apiRes.status
      return res.status(status).json({
        message: status === 401 ? 'Usuario ou senha incorretos' : `Erro do servidor (${status})`,
      })
    }

    const data = await apiRes.json()

    // Cacheia o token para uso no proxy de dados
    const cacheKey = authSource.id ?? authSource.apiUrl
    const token = data.token ?? data.access_token ?? data.jwt ?? data.bearer
    if (token) {
      tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 55 * 60 * 1000 })
    }

    res.json(data)
  } catch (err) {
    res.status(502).json({
      message: `Falha ao conectar: ${err instanceof Error ? err.message : 'erro'}`,
    })
  }
})

/**
 * GET /api/proxy/data?dt_de=...&dt_ate=... (ou qualquer query param da API)
 * Busca dados na API do cliente usando token autenticado.
 * Funciona com qualquer API — normaliza a resposta para array.
 */
proxyRouter.get('/data', async (req, res) => {
  const source = readAll().find((ds) => ds.dataEndpoint)
  if (!source) {
    return res.status(400).json({ message: 'Nenhuma conexao com caminho de dados configurado' })
  }

  // Monta headers de autenticação baseado no método configurado
  const headers: Record<string, string> = { Accept: 'application/json' }

  if (source.isAuthSource && source.loginEndpoint) {
    // Login-based auth — obtém token do cache ou faz login
    const token = await getTokenForSource(source)
    if (!token) {
      return res.status(401).json({ message: 'Nao foi possivel autenticar com a API de dados. Verifique a conexao.' })
    }
    headers.Authorization = `Bearer ${token}`
  } else if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  } else if (source.authMethod === 'api_key' && source.authCredentials) {
    headers['X-API-Key'] = source.authCredentials
  } else if (source.authMethod === 'basic_auth' && source.authCredentials) {
    headers.Authorization = `Basic ${Buffer.from(source.authCredentials).toString('base64')}`
  }

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const dataEndpoint = source.dataEndpoint!

  // Repassa todos os query params do frontend
  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string') params.set(key, val)
  }
  const sep = dataEndpoint.includes('?') ? '&' : '?'
  const fullUrl = `${baseUrl}${dataEndpoint}${params.toString() ? `${sep}${params}` : ''}`

  const fetchData = async (authHeaders: Record<string, string>) => {
    const apiRes = await fetch(fullUrl, {
      method: 'GET',
      headers: authHeaders,
      signal: AbortSignal.timeout(30_000),
    })
    return apiRes
  }

  try {
    let apiRes = await fetchData(headers)

    // Token expirou — limpa cache e tenta de novo
    if (apiRes.status === 401 && source.isAuthSource) {
      const cacheKey = source.id ?? source.apiUrl
      tokenCache.delete(cacheKey)
      const newToken = await getTokenForSource(source)
      if (!newToken) {
        return res.status(401).json({ message: 'Token expirado e nao foi possivel renovar.' })
      }
      headers.Authorization = `Bearer ${newToken}`
      apiRes = await fetchData(headers)
    }

    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ message: `Erro ao buscar dados (${apiRes.status})` })
    }

    const rawData = await apiRes.json()

    // Normaliza: sempre retorna array, independente do formato da API
    const arr = extractDataArray(rawData)
    res.json(arr)
  } catch (err) {
    res.status(502).json({
      message: `Falha: ${err instanceof Error ? err.message : 'erro'}`,
    })
  }
})
