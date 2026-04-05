import { Router } from 'express'
import { readAll } from '../storage.js'
import { hashPassword } from '../services/passwordHasher.js'

export const proxyRouter = Router()

// ─── Cache do token SGBR (evita login a cada request) ───────────────────────
let sgbrTokenCache: { token: string; expiresAt: number } | null = null

async function getSgbrToken(source: ReturnType<typeof readAll>[number]): Promise<string | null> {
  // Se tem token em cache e não expirou (30 min de margem)
  if (sgbrTokenCache && Date.now() < sgbrTokenCache.expiresAt) {
    return sgbrTokenCache.token
  }

  // Faz login na SGBR para obter token
  if (!source.isAuthSource || !source.loginEndpoint) return null

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const loginEndpoint = source.loginEndpoint
  const fieldUser = source.loginFieldUser ?? 'login'
  const fieldPass = source.loginFieldPassword ?? 'senha'
  const passwordMode = source.passwordMode ?? 'plain'

  // Credenciais do datasource (formato "login:senha") ou variaveis de ambiente
  const creds = (source.authCredentials ?? process.env.SGBR_CREDENTIALS ?? '').split(':')
  const defaultLogin = creds[0] || ''
  const defaultPassword = creds[1] || ''

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

    const data = await apiRes.json() as { token?: string }
    if (!data.token) return null

    // Cache por 55 minutos (tokens geralmente duram 1h)
    sgbrTokenCache = { token: data.token, expiresAt: Date.now() + 55 * 60 * 1000 }
    return data.token
  } catch {
    return null
  }
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

    // Cacheia o token SGBR para uso no proxy de dados
    if (data.token) {
      sgbrTokenCache = { token: data.token, expiresAt: Date.now() + 55 * 60 * 1000 }
    }

    res.json(data)
  } catch (err) {
    res.status(502).json({
      message: `Falha ao conectar: ${err instanceof Error ? err.message : 'erro'}`,
    })
  }
})

/**
 * GET /api/proxy/data?dt_de=YYYY.MM.DD&dt_ate=YYYY.MM.DD
 * Busca dados na API do cliente usando token SGBR (não o token local do usuario).
 */
proxyRouter.get('/data', async (req, res) => {
  const source = readAll().find((ds) => ds.dataEndpoint)
  if (!source) {
    return res.status(400).json({ message: 'Nenhuma conexao com caminho de dados configurado' })
  }

  // Obtem token SGBR (do cache ou faz login automatico)
  const sgbrToken = await getSgbrToken(source)
  if (!sgbrToken) {
    return res.status(401).json({ message: 'Nao foi possivel autenticar com a API de dados. Verifique a conexao.' })
  }

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const dataEndpoint = source.dataEndpoint!

  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string') params.set(key, val)
  }
  const sep = dataEndpoint.includes('?') ? '&' : '?'
  const fullUrl = `${baseUrl}${dataEndpoint}${params.toString() ? `${sep}${params}` : ''}`

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${sgbrToken}`,
    }

    const apiRes = await fetch(fullUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    })

    if (apiRes.status === 401) {
      // Token expirou — limpa cache e tenta de novo uma vez
      sgbrTokenCache = null
      const newToken = await getSgbrToken(source)
      if (!newToken) {
        return res.status(401).json({ message: 'Token SGBR expirado e nao foi possivel renovar.' })
      }

      const retryRes = await fetch(fullUrl, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${newToken}` },
        signal: AbortSignal.timeout(30_000),
      })

      if (!retryRes.ok) {
        return res.status(retryRes.status).json({ message: `Erro ao buscar dados (${retryRes.status})` })
      }

      return res.json(await retryRes.json())
    }

    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ message: `Erro ao buscar dados (${apiRes.status})` })
    }

    res.json(await apiRes.json())
  } catch (err) {
    res.status(502).json({
      message: `Falha: ${err instanceof Error ? err.message : 'erro'}`,
    })
  }
})
