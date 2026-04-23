import { Router, type Response, type Request } from 'express'
import rateLimit from 'express-rate-limit'
import { readAll, type DataSource } from '../storage.js'
import { hashPassword } from '../services/passwordHasher.js'
import { extractDataArray } from '../utils/extractDataArray.js'
import { resolvePaginationState, resolvePaginationStateSequential, type PaginationStyle } from '../utils/paginationMeta.js'
import { joinApiUrl } from '../utils/joinApiUrl.js'
import { requireAuth } from '../middleware/auth.js'
import { resolveTenantId } from '../utils/tenant.js'
import { applyFieldMappings } from '../utils/applyFieldMappings.js'

export const proxyRouter = Router()

/** Rate limit: máximo 60 chamadas ao proxy por IP a cada 1 min */
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { message: 'Muitas requisições. Aguarde um momento.' },
  standardHeaders: true,
  legacyHeaders: false,
})

proxyRouter.use(proxyLimiter)
proxyRouter.use((req, res, next) => {
  if (req.path === '/login') return next()
  return requireAuth(req, res, next)
})

const _upstreamEnv = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS)
const PROXY_UPSTREAM_MS =
  Number.isFinite(_upstreamEnv) && _upstreamEnv >= 10_000 ? Math.min(_upstreamEnv, 600_000) : 120_000

/**
 * Deadline cumulativo do handler de `/data` (cobre paginação multi-página).
 * Fica abaixo do timeout HTTP do axios no front (120s) para que o proxy prefira
 * responder truncado a deixar a conexão estourar sem resposta.
 */
const _deadlineEnv = Number(process.env.PROXY_DATA_GLOBAL_DEADLINE_MS)
// 110s (antes 100s) — dá folga pra paginação terminar antes do axios timeout (120s no front).
const PROXY_GLOBAL_DEADLINE_MS =
  Number.isFinite(_deadlineEnv) && _deadlineEnv >= 10_000 ? Math.min(_deadlineEnv, 600_000) : 110_000

/**
 * Máx. de requisições **extras** no modo **sequencial** (API sem `totalPages` confiável).
 * Padrão 200. Reduza (ex.: 12) se a API externa for lenta. `0` = só a 1ª página.
 */
function proxyMaxExtraPages(): number {
  const raw = process.env.PROXY_DATA_MAX_AUTO_PAGES
  const n = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 0) return 200
  return Math.min(Math.floor(n), 2000)
}

/**
 * Quando a API informa `totalPages`, buscamos da página atual até esta (teto de segurança).
 * Padrão 5000 — cobre a maioria dos casos sem truncar; aumente se necessário.
 */
function proxyMaxPageIndex(): number {
  const raw = process.env.PROXY_DATA_MAX_PAGE_INDEX
  const n = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 1) return 5000
  return Math.min(Math.floor(n), 50_000)
}

function proxyAutoPaginateEnabled(): boolean {
  const v = process.env.PROXY_DATA_AUTO_PAGINATE?.trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

function sendProxyDataJson(
  res: Response,
  rows: unknown[],
  meta?: { pagesFetched?: number; truncated?: boolean; totalPagesReported?: number },
) {
  const n = Array.isArray(rows) ? rows.length : 0
  res.setHeader('x-iga-proxy-row-count', String(n))
  if (meta?.pagesFetched != null) res.setHeader('x-iga-proxy-pages-fetched', String(meta.pagesFetched))
  if (meta?.truncated) res.setHeader('x-iga-proxy-truncated', '1')
  if (meta?.totalPagesReported != null) {
    res.setHeader('x-iga-proxy-total-pages-reported', String(meta.totalPagesReported))
  }
  return res.json(rows)
}

// ─── Cache de tokens por data source (evita login a cada request) ──────────
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const proxyStats = {
  dataCalls: 0,
  dataErrors: 0,
  compareCalls: 0,
  compareErrors: 0,
  reconcileCalls: 0,
  reconcileErrors: 0,
  lastErrorAt: null as string | null,
  lastErrorMessage: null as string | null,
}
const reconcileAlertState: {
  enabled: boolean
  thresholdPct: number
  officialEndpoint: string | null
  sourceId: string | null
  intervalMs: number
  lastCheckAt: string | null
  lastDiff: number | null
  lastDiffPct: number | null
  status: 'ok' | 'alert' | 'error' | 'idle'
  message: string | null
} = {
  enabled: false,
  thresholdPct: 1,
  officialEndpoint: null,
  sourceId: null,
  intervalMs: 15 * 60_000,
  lastCheckAt: null,
  lastDiff: null,
  lastDiffPct: null,
  status: 'idle',
  message: null,
}

let reconcileAlertTimer: NodeJS.Timeout | null = null

function markProxyError(message: string) {
  proxyStats.lastErrorAt = new Date().toISOString()
  proxyStats.lastErrorMessage = message
}

function selectDataSource(
  all: ReturnType<typeof readAll>,
  tenantId: string,
  dsId?: string,
): ReturnType<typeof readAll>[number] | null {
  const tenantDataSources = all.filter((ds) => ds.tenantId === tenantId)
  if (dsId) return tenantDataSources.find((ds) => ds.id === dsId && ds.dataEndpoint) ?? null
  return tenantDataSources.find((ds) => ds.dataEndpoint) ?? null
}

function asMoneyNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value !== 'string') return 0
  const normalized = value.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(normalized)
  return Number.isFinite(n) ? n : 0
}

function deriveDate(row: Record<string, unknown>, preferredField?: string): string {
  const candidates = [
    preferredField,
    'datafec',
    'data',
    'data_venda',
    'emissao',
    'created_at',
  ].filter(Boolean) as string[]
  for (const key of candidates) {
    const val = row[key]
    if (typeof val === 'string' && val.length >= 10) return val.slice(0, 10)
  }
  return ''
}

function deriveAmount(row: Record<string, unknown>, preferredField?: string): number {
  const candidates = [
    preferredField,
    'total',
    'total_liquido',
    'total_liquido_pedido',
    'valor_total',
    'totalprodutos',
  ].filter(Boolean) as string[]
  for (const key of candidates) {
    const val = row[key]
    if (val != null) {
      const num = asMoneyNumber(val)
      if (num !== 0 || val === 0 || val === '0' || val === '0,00') return num
    }
  }
  return 0
}

function asPercentDiff(base: number, diff: number): number {
  if (!Number.isFinite(base) || base === 0) return 0
  return Math.round((Math.abs(diff) / Math.abs(base)) * 10000) / 100
}

async function getTokenForSource(source: ReturnType<typeof readAll>[number]): Promise<string | null> {
  const cacheKey = source.id ?? source.apiUrl

  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token
  }

  /** Login JWT é usado por qualquer fonte com `loginEndpoint` + credenciais — não só `isAuthSource` (essa flag é só para login de usuários no app). */
  if (!source.loginEndpoint) return null

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const loginEndpoint = source.loginEndpoint
  const fieldUser = source.loginFieldUser ?? 'login'
  const fieldPass = source.loginFieldPassword ?? 'senha'
  const passwordMode = source.passwordMode ?? 'plain'

  const rawCreds = source.authCredentials ?? process.env.SGBR_CREDENTIALS ?? ''
  const colonIdx = rawCreds.indexOf(':')
  const defaultLogin = colonIdx >= 0 ? rawCreds.slice(0, colonIdx) : rawCreds
  const defaultPassword = colonIdx >= 0 ? rawCreds.slice(colonIdx + 1) : ''

  if (!defaultLogin || !defaultPassword) return null

  const hashedPassword = await hashPassword(defaultPassword, passwordMode)
  const body: Record<string, string> = {
    [fieldUser]: defaultLogin,
    [fieldPass]: hashedPassword,
  }
  const loginUrl = joinApiUrl(baseUrl, loginEndpoint)

  // Retry com back-off: SGBR pode ser lento — timeout de 20s e até 2 tentativas
  const MAX_LOGIN_ATTEMPTS = 2
  const LOGIN_TIMEOUT_MS = 20_000
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      const apiRes = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      })

      if (!apiRes.ok) {
        if (attempt < MAX_LOGIN_ATTEMPTS) continue
        return null
      }

      const data = await apiRes.json() as Record<string, unknown>
      const token = (
        data.token ?? data.access_token ?? data.jwt ?? data.bearer ??
        data.sessionToken ?? data.session_token ?? data.apiToken ?? data.api_token ??
        data.id_token ?? data.auth_token ?? data.authToken ?? data.accessToken
      ) as string | undefined
      if (!token) return null

      // TTL 45 min — margem de segurança contra expiração server-side (tokens SGBR duram ~60 min)
      tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 45 * 60 * 1000 })
      return token
    } catch {
      if (attempt < MAX_LOGIN_ATTEMPTS) continue
      return null
    }
  }
  return null
}

/**
 * POST /api/proxy/login
 */
proxyRouter.post('/login', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const { login, password } = req.body
  if (!login || !password) {
    return res.status(400).json({ message: 'Usuario e senha obrigatorios' })
  }

  const authSource = readAll().find((ds) => ds.tenantId === tenantId && ds.isAuthSource)
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

    const apiRes = await fetch(joinApiUrl(baseUrl, loginEndpoint), {
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

    const cacheKey = authSource.id ?? authSource.apiUrl
    const token = data.token ?? data.access_token ?? data.jwt ?? data.bearer
    if (token) {
      tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 45 * 60 * 1000 })
    }

    res.json(data)
  } catch (err) {
    res.status(502).json({
      message: `Falha ao conectar: ${err instanceof Error ? err.message : 'erro'}`,
    })
  }
})

/**
 * GET /api/proxy/fields
 * Diagnóstico: retorna todos os campos que a API externa envia (nomes + tipos + amostra).
 */
proxyRouter.get('/fields', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const dsId = typeof req.query.dsId === 'string' ? req.query.dsId : undefined
  const source = selectDataSource(readAll(), tenantId, dsId)
  if (!source) {
    return res.status(400).json({ message: dsId ? 'Fonte informada não encontrada.' : 'Nenhuma conexao com caminho de dados configurado' })
  }

  const headers: Record<string, string> = { Accept: 'application/json' }

  if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  } else if (source.authMethod === 'api_key' && source.authCredentials) {
    headers['X-API-Key'] = source.authCredentials
  } else if (source.authMethod === 'basic_auth' && source.authCredentials) {
    headers.Authorization = `Basic ${Buffer.from(source.authCredentials).toString('base64')}`
  } else if (source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) {
      return res.status(401).json({ message: 'Nao foi possivel autenticar.' })
    }
    headers.Authorization = `Bearer ${token}`
  }

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const dataEndpoint = source.dataEndpoint!

  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string' && key !== 'dsId') params.set(key, val)
  }
  const sep = dataEndpoint.includes('?') ? '&' : '?'
  const fullUrl = `${joinApiUrl(baseUrl, dataEndpoint)}${params.toString() ? `${sep}${params}` : ''}`

  try {
    const apiRes = await fetch(fullUrl, { method: 'GET', headers, signal: AbortSignal.timeout(PROXY_UPSTREAM_MS) })
    if (!apiRes.ok) {
      proxyStats.dataErrors++
      markProxyError(`fields: status ${apiRes.status}`)
      return res.status(apiRes.status).json({ message: `Erro (${apiRes.status})` })
    }

    const rawData = await apiRes.json()
    const arr = extractDataArray(rawData)

    if (arr.length === 0) {
      return res.json({ totalRows: 0, fields: [], sample: [] })
    }

    const firstRow = arr[0] as Record<string, unknown>
    const fields = Object.entries(firstRow).map(([key, value]) => ({
      name: key,
      type: value === null ? 'null' : typeof value,
      sample: typeof value === 'string' && value.length > 100 ? value.slice(0, 100) + '...' : value,
    }))

    const sample = arr.slice(0, 3)

    res.json({ totalRows: arr.length, fields, sample })
  } catch (err) {
    proxyStats.dataErrors++
    markProxyError(err instanceof Error ? err.message : 'erro')
    res.status(502).json({ message: `Falha: ${err instanceof Error ? err.message : 'erro'}` })
  }
})

/**
 * GET /api/proxy/compare
 * Diagnóstico de faturamento: compara 2 endpoints no mesmo período.
 *
 * Query:
 * - endpointA (opcional): path A (default: dataEndpoint da fonte)
 * - endpointB (obrigatório): path B para comparar
 * - dt_de / dt_ate (opcional): repassados para API externa
 * - dateField (opcional): campo de data prioritário no agregado
 * - amountField (opcional): campo monetário prioritário no agregado
 */
proxyRouter.get('/compare', async (req, res) => {
  const tenantId = resolveTenantId(req)
  proxyStats.compareCalls++
  const all = readAll()
  const source =
    all.find((ds) => ds.tenantId === tenantId && ds.isAuthSource) ??
    all.find((ds) => ds.tenantId === tenantId && ds.dataEndpoint)
  if (!source) {
    return res.status(400).json({ message: 'Nenhuma conexao configurada' })
  }
  const endpointB = typeof req.query.endpointB === 'string' ? req.query.endpointB : ''
  if (!endpointB) {
    return res.status(400).json({ message: 'Informe endpointB para comparar' })
  }
  const endpointA = typeof req.query.endpointA === 'string' && req.query.endpointA.trim()
    ? req.query.endpointA
    : (source.dataEndpoint ?? '')
  if (!endpointA) {
    return res.status(400).json({ message: 'Nenhum endpointA disponivel na fonte configurada' })
  }

  const dateField = typeof req.query.dateField === 'string' ? req.query.dateField : undefined
  const amountField = typeof req.query.amountField === 'string' ? req.query.amountField : undefined

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  } else if (source.authMethod === 'api_key' && source.authCredentials) {
    headers['X-API-Key'] = source.authCredentials
  } else if (source.authMethod === 'basic_auth' && source.authCredentials) {
    headers.Authorization = `Basic ${Buffer.from(source.authCredentials).toString('base64')}`
  } else if (source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) return res.status(401).json({ message: 'Nao foi possivel autenticar.' })
    headers.Authorization = `Bearer ${token}`
  }

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string' && !['endpointA', 'endpointB', 'dateField', 'amountField'].includes(key)) {
      params.set(key, val)
    }
  }

  const buildUrl = (endpoint: string) => {
    const sep = endpoint.includes('?') ? '&' : '?'
    return `${joinApiUrl(baseUrl, endpoint)}${params.toString() ? `${sep}${params}` : ''}`
  }

  const fetchAndAggregate = async (label: 'A' | 'B', endpoint: string) => {
    const started = Date.now()
    const url = buildUrl(endpoint)
    const apiRes = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(60_000) })
    if (!apiRes.ok) throw new Error(`Endpoint ${label} retornou ${apiRes.status}`)
    const payload = await apiRes.json()
    const arr = extractDataArray(payload).map((row) => row as Record<string, unknown>)
    const byMonth: Record<string, { count: number; total: number }> = {}
    for (const row of arr) {
      const d = deriveDate(row, dateField)
      const month = d.length >= 7 ? d.slice(0, 7) : 'sem-data'
      byMonth[month] ??= { count: 0, total: 0 }
      byMonth[month].count += 1
      byMonth[month].total += deriveAmount(row, amountField)
    }
    return {
      endpoint,
      url,
      latencyMs: Date.now() - started,
      rows: arr.length,
      total: Math.round(arr.reduce((s, r) => s + deriveAmount(r, amountField), 0) * 100) / 100,
      byMonth,
      sample: arr.slice(0, 3),
    }
  }

  try {
    const [a, b] = await Promise.all([
      fetchAndAggregate('A', endpointA),
      fetchAndAggregate('B', endpointB),
    ])
    const diff = Math.round((a.total - b.total) * 100) / 100
    res.json({
      period: { dt_de: req.query.dt_de ?? null, dt_ate: req.query.dt_ate ?? null },
      dateField: dateField ?? 'auto(datafec,data,...)',
      amountField: amountField ?? 'auto(total,total_liquido,...)',
      endpointA: a,
      endpointB: b,
      differenceAminusB: diff,
    })
  } catch (err) {
    proxyStats.compareErrors++
    markProxyError(err instanceof Error ? err.message : 'erro')
    res.status(502).json({ message: `Falha na comparação: ${err instanceof Error ? err.message : 'erro'}` })
  }
})

/**
 * GET /api/proxy/reconcile
 * Compara o endpoint configurado da fonte com um endpoint oficial informado.
 */
proxyRouter.get('/reconcile', async (req, res) => {
  const tenantId = resolveTenantId(req)
  proxyStats.reconcileCalls++
  const dsId = typeof req.query.dsId === 'string' ? req.query.dsId : undefined
  const officialEndpoint = typeof req.query.officialEndpoint === 'string' ? req.query.officialEndpoint : ''
  if (!officialEndpoint) return res.status(400).json({ message: 'Informe officialEndpoint.' })

  const all = readAll()
  const source = selectDataSource(all, tenantId, dsId)
  if (!source || !source.dataEndpoint) {
    return res.status(400).json({ message: 'Fonte não encontrada para reconciliação.' })
  }

  const qs = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string' && !['dsId', 'officialEndpoint'].includes(key)) qs.set(key, val)
  }

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  } else if (source.authMethod === 'api_key' && source.authCredentials) {
    headers['X-API-Key'] = source.authCredentials
  } else if (source.authMethod === 'basic_auth' && source.authCredentials) {
    headers.Authorization = `Basic ${Buffer.from(source.authCredentials).toString('base64')}`
  } else if (source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) return res.status(401).json({ message: 'Não foi possível autenticar para reconciliação.' })
    headers.Authorization = `Bearer ${token}`
  }

  const mkUrl = (ep: string) =>
    `${joinApiUrl(baseUrl, ep)}${qs.toString() ? `${ep.includes('?') ? '&' : '?'}${qs}` : ''}`
  const load = async (ep: string) => {
    const started = Date.now()
    const url = mkUrl(ep)
    const apiRes = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(60_000) })
    if (!apiRes.ok) throw new Error(`Falha ${apiRes.status} em ${ep}`)
    const payload = await apiRes.json()
    const rows = extractDataArray(payload).map((r) => r as Record<string, unknown>)
    const total = Math.round(rows.reduce((s, row) => s + deriveAmount(row), 0) * 100) / 100
    return { endpoint: ep, url, latencyMs: Date.now() - started, rows: rows.length, total }
  }

  try {
    const [configured, official] = await Promise.all([load(source.dataEndpoint), load(officialEndpoint)])
    return res.json({
      sourceId: source.id,
      period: { dt_de: req.query.dt_de ?? null, dt_ate: req.query.dt_ate ?? null },
      configured,
      official,
      difference: Math.round((configured.total - official.total) * 100) / 100,
    })
  } catch (err) {
    proxyStats.reconcileErrors++
    markProxyError(err instanceof Error ? err.message : 'erro')
    return res.status(502).json({ message: `Falha ao reconciliar: ${err instanceof Error ? err.message : 'erro'}` })
  }
})

async function runReconcileCheck(args: {
  tenantId?: string
  dsId?: string
  officialEndpoint: string
  dtDe?: string
  dtAte?: string
}): Promise<{
  sourceId: string
  configuredTotal: number
  officialTotal: number
  difference: number
  differencePct: number
}> {
  const all = readAll()
  const source = selectDataSource(all, args.tenantId ?? 'default', args.dsId)
  if (!source || !source.dataEndpoint) throw new Error('Fonte não encontrada para alerta de reconciliação.')

  const qs = new URLSearchParams()
  if (args.dtDe) qs.set('dt_de', args.dtDe)
  if (args.dtAte) qs.set('dt_ate', args.dtAte)

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  } else if (source.authMethod === 'api_key' && source.authCredentials) {
    headers['X-API-Key'] = source.authCredentials
  } else if (source.authMethod === 'basic_auth' && source.authCredentials) {
    headers.Authorization = `Basic ${Buffer.from(source.authCredentials).toString('base64')}`
  } else if (source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) throw new Error('Não foi possível autenticar para alerta.')
    headers.Authorization = `Bearer ${token}`
  }

  const mkUrl = (ep: string) =>
    `${joinApiUrl(baseUrl, ep)}${qs.toString() ? `${ep.includes('?') ? '&' : '?'}${qs}` : ''}`
  const loadTotal = async (ep: string) => {
    const apiRes = await fetch(mkUrl(ep), { method: 'GET', headers, signal: AbortSignal.timeout(60_000) })
    if (!apiRes.ok) throw new Error(`Falha ${apiRes.status} em ${ep}`)
    const payload = await apiRes.json()
    const rows = extractDataArray(payload).map((r) => r as Record<string, unknown>)
    return Math.round(rows.reduce((s, row) => s + deriveAmount(row), 0) * 100) / 100
  }

  const [configuredTotal, officialTotal] = await Promise.all([
    loadTotal(source.dataEndpoint),
    loadTotal(args.officialEndpoint),
  ])
  const difference = Math.round((configuredTotal - officialTotal) * 100) / 100
  const differencePct = asPercentDiff(officialTotal, difference)
  return { sourceId: source.id, configuredTotal, officialTotal, difference, differencePct }
}

export async function runScheduledReconcileAlert() {
  if (!reconcileAlertState.enabled || !reconcileAlertState.officialEndpoint) return
  try {
    const result = await runReconcileCheck({
      dsId: reconcileAlertState.sourceId ?? undefined,
      officialEndpoint: reconcileAlertState.officialEndpoint,
    })
    reconcileAlertState.lastCheckAt = new Date().toISOString()
    reconcileAlertState.lastDiff = result.difference
    reconcileAlertState.lastDiffPct = result.differencePct
    if (result.differencePct > reconcileAlertState.thresholdPct) {
      reconcileAlertState.status = 'alert'
      reconcileAlertState.message = `Divergência acima do limite (${result.differencePct}% > ${reconcileAlertState.thresholdPct}%).`
    } else {
      reconcileAlertState.status = 'ok'
      reconcileAlertState.message = `Divergência dentro do limite (${result.differencePct}% <= ${reconcileAlertState.thresholdPct}%).`
    }
  } catch (err) {
    reconcileAlertState.lastCheckAt = new Date().toISOString()
    reconcileAlertState.status = 'error'
    reconcileAlertState.message = err instanceof Error ? err.message : 'erro'
  }
}

export function setupReconcileAlertScheduler() {
  const officialEndpoint = process.env.RECONCILE_OFFICIAL_ENDPOINT?.trim()
  if (!officialEndpoint) return
  const thresholdPct = Number(process.env.RECONCILE_THRESHOLD_PCT ?? '1')
  const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS ?? `${15 * 60_000}`)
  const sourceId = process.env.RECONCILE_SOURCE_ID?.trim() || null

  reconcileAlertState.enabled = true
  reconcileAlertState.thresholdPct = Number.isFinite(thresholdPct) ? thresholdPct : 1
  reconcileAlertState.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 15 * 60_000
  reconcileAlertState.officialEndpoint = officialEndpoint
  reconcileAlertState.sourceId = sourceId

  if (reconcileAlertTimer) clearInterval(reconcileAlertTimer)
  void runScheduledReconcileAlert()
  reconcileAlertTimer = setInterval(() => {
    void runScheduledReconcileAlert()
  }, reconcileAlertState.intervalMs)
}

proxyRouter.get('/alerts/reconcile', (_req, res) => {
  res.json(reconcileAlertState)
})

proxyRouter.post('/alerts/reconcile/check', async (_req, res) => {
  await runScheduledReconcileAlert()
  res.json(reconcileAlertState)
})

/**
 * Camada de cache + dedup para /api/proxy/data.
 *
 * 1) DEDUP in-flight: requests idênticos simultâneos aguardam o primeiro e
 *    replicam a resposta (evita N paginações paralelas para o mesmo endpoint).
 * 2) CACHE TTL: responses 200 ficam em memória por PROXY_CACHE_TTL_MS (default
 *    60s). Se outro request idêntico chega dentro desse prazo, responde do
 *    cache instantaneamente — sem ir ao SGBR. Ganho típico em nav Dashboard →
 *    Finance → Operacional: 7s × 3 = 21s → ~7s.
 *
 * Escopo: só GET /data (caro, idempotente, determinístico pela URL).
 * Trade-off: dados podem estar até TTL segundos desatualizados.
 * Limite: cache LRU de até PROXY_CACHE_MAX_ENTRIES entradas para não inchar RAM.
 */
type DedupResult = { status: number; body: unknown; contentType?: string }
const inFlight = new Map<string, Promise<DedupResult>>()

type CacheEntry = { result: DedupResult; expiresAt: number }
const responseCache = new Map<string, CacheEntry>()
const _cacheTtlEnv = Number(process.env.PROXY_CACHE_TTL_MS)
const PROXY_CACHE_TTL_MS =
  Number.isFinite(_cacheTtlEnv) && _cacheTtlEnv >= 0 ? Math.min(_cacheTtlEnv, 600_000) : 300_000
const _cacheMaxEnv = Number(process.env.PROXY_CACHE_MAX_ENTRIES)
const PROXY_CACHE_MAX_ENTRIES =
  Number.isFinite(_cacheMaxEnv) && _cacheMaxEnv > 0 ? Math.min(_cacheMaxEnv, 500) : 50

function getCached(key: string): DedupResult | null {
  const entry = responseCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key)
    return null
  }
  // LRU touch: move pro final
  responseCache.delete(key)
  responseCache.set(key, entry)
  return entry.result
}

function setCached(key: string, result: DedupResult) {
  if (result.status !== 200) return
  responseCache.set(key, { result, expiresAt: Date.now() + PROXY_CACHE_TTL_MS })
  // LRU: descarta mais antigas se exceder limite
  while (responseCache.size > PROXY_CACHE_MAX_ENTRIES) {
    const firstKey = responseCache.keys().next().value
    if (!firstKey) break
    responseCache.delete(firstKey)
  }
}

function dedupKey(req: Request): string {
  const tenantId = resolveTenantId(req)
  // Inclui só os params que afetam a resposta; ignora cache-buster random.
  const keyFields = { ...req.query }
  delete (keyFields as Record<string, unknown>)._t
  return `${tenantId}|${JSON.stringify(keyFields, Object.keys(keyFields).sort())}`
}

async function replayResponse(res: Response, result: DedupResult) {
  res.status(result.status)
  if (result.contentType) res.setHeader('Content-Type', result.contentType)
  if (typeof result.body === 'string') res.send(result.body)
  else res.json(result.body)
}

/**
 * GET /api/proxy/data
 */
proxyRouter.get('/data', async (req, res, next) => {
  const key = dedupKey(req)

  // 1) Cache hit — resposta instantânea
  const cached = getCached(key)
  if (cached) {
    res.setHeader('X-Proxy-Cache', 'HIT')
    return replayResponse(res, cached)
  }

  // 2) Dedup in-flight — aguarda primeiro request idêntico
  const pending = inFlight.get(key)
  if (pending) {
    try {
      const result = await pending
      res.setHeader('X-Proxy-Cache', 'COALESCED')
      return replayResponse(res, result)
    } catch {
      // Se o primeiro falhou, segue e processa normalmente
    }
  }

  // 3) Primeiro request: cria promise, captura resposta, armazena no cache
  let resolveFn!: (r: DedupResult) => void
  let rejectFn!: (e: unknown) => void
  const promise = new Promise<DedupResult>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  // Importante: o "primeiro" request não aguarda esse promise. Se ele rejeitar
  // (ex.: client abort), o Node pode tratar como unhandled rejection e derrubar o processo.
  // Mantemos o reject para que requests coalesced caiam no catch e processem normalmente,
  // mas garantimos que SEMPRE há um handler.
  void promise.catch(() => {})
  inFlight.set(key, promise)
  res.setHeader('X-Proxy-Cache', 'MISS')

  const origJson = res.json.bind(res)
  const origSend = res.send.bind(res)
  const capture = (body: unknown) => {
    const result: DedupResult = {
      status: res.statusCode,
      body,
      contentType: res.getHeader('Content-Type') as string | undefined,
    }
    try { resolveFn(result) } catch { /* ignora */ }
    setCached(key, result)
    inFlight.delete(key)
  }
  res.json = ((body: unknown) => { capture(body); return origJson(body) }) as typeof res.json
  res.send = ((body: unknown) => { capture(body); return origSend(body) }) as typeof res.send
  res.on('close', () => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key)
      try {
        rejectFn(new Error('connection closed before response'))
      } catch {
        // noop
      }
    }
  })
  next()
})

/** Resolve hints de paginação a partir da configuração do DataSource. */
function buildPaginationHints(source: DataSource) {
  return {
    paginationStyle: (source.paginationStyle ?? undefined) as PaginationStyle | undefined,
    pageParam: source.pageParam,
    perPageParam: source.perPageParam,
    cursorParam: source.cursorParam,
    cursorResponseField: source.cursorResponseField,
  }
}

/** Resolve nome do param de página/offset/cursor considerando config, query e fallback. */
function resolvePageParam(source: DataSource, params: URLSearchParams): string {
  if (source.pageParam) return source.pageParam
  if (params.has('pagina')) return 'pagina'
  if (params.has('page')) return 'page'
  if (params.has('offset')) return 'offset'
  // Fallback: SGBR usa 'pagina', outros usam 'page'
  return source.type === 'sgbr_bi' ? 'pagina' : 'page'
}

function resolvePerPageParam(source: DataSource, params: URLSearchParams): string {
  if (source.perPageParam) return source.perPageParam
  if (params.has('tamanho')) return 'tamanho'
  if (params.has('per_page')) return 'per_page'
  if (params.has('limit')) return 'limit'
  if (params.has('page_size')) return 'page_size'
  if (params.has('size')) return 'size'
  return source.type === 'sgbr_bi' ? 'tamanho' : 'per_page'
}

function resolveDefaultPerPage(source: DataSource, dataEndpoint: string): string {
  if (source.defaultPerPage) return String(source.defaultPerPage)
  // Retrocompat SGBR
  if (source.type === 'sgbr_bi') {
    const rawTam = process.env.SGBR_PROXY_DEFAULT_TAMANHO?.trim()
    const isProduzido = dataEndpoint.toLowerCase().includes('produzido')
    return rawTam && /^\d+$/.test(rawTam) ? rawTam : isProduzido ? '5000' : '500'
  }
  return '500'
}

/** Limita o valor de per-page para evitar abuso (max 10000). */
const MAX_PER_PAGE = 10_000
function clampPerPage(params: URLSearchParams, perPageParam: string) {
  const raw = params.get(perPageParam)
  if (!raw) return
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) { params.set(perPageParam, '500'); return }
  if (n > MAX_PER_PAGE) params.set(perPageParam, String(MAX_PER_PAGE))
}

/** Aplica auth headers a partir da config do DataSource. */
async function resolveAuthHeaders(source: DataSource): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; status: number; message: string }> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  } else if (source.authMethod === 'api_key' && source.authCredentials) {
    headers['X-API-Key'] = source.authCredentials
  } else if (source.authMethod === 'basic_auth' && source.authCredentials) {
    headers.Authorization = `Basic ${Buffer.from(source.authCredentials).toString('base64')}`
  } else if (source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) return { ok: false, status: 401, message: 'Nao foi possivel autenticar com a API de dados. Verifique a conexao.' }
    headers.Authorization = `Bearer ${token}`
  }
  return { ok: true, headers }
}

proxyRouter.get('/data', async (req, res) => {
  const tenantId = resolveTenantId(req)
  proxyStats.dataCalls++
  const requireDsId = req.query.requireDsId === '1'
  const dsId = typeof req.query.dsId === 'string' ? req.query.dsId : undefined
  const all = readAll()
  if (requireDsId && !dsId) {
    return res.status(422).json({ message: 'Fonte obrigatória não informada (dsId).' })
  }
  const source = selectDataSource(all, tenantId, dsId)
  if (!source) {
    return res.status(400).json({ message: dsId ? 'Fonte informada não encontrada.' : 'Nenhuma conexão com caminho de dados configurado.' })
  }

  const proxyStartedAt = Date.now()
  const timings = { authMs: 0, firstPageMs: 0, paginationMs: 0, pagesFetched: 0 }
  res.on('finish', () => {
    if (process.env.NODE_ENV === 'production' && process.env.LOG_PROXY_DATA !== '1') return
    const totalMs = Date.now() - proxyStartedAt
    const cacheHeader = (res.getHeader('X-Proxy-Cache') as string) || 'MISS'
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        level: 'info',
        event: 'proxy.data',
        tenantId,
        dsId: source.id,
        dataEndpoint: source.dataEndpoint ?? null,
        durationMs: totalMs,
        status: res.statusCode,
        cache: cacheHeader,
        timing: {
          auth: timings.authMs,
          firstPage: timings.firstPageMs,
          pagination: timings.paginationMs,
          pagesFetched: timings.pagesFetched,
        },
      }),
    )
  })

  // Auth
  const authResult = await resolveAuthHeaders(source)
  if (!authResult.ok) return res.status(authResult.status).json({ message: authResult.message })
  const headers = authResult.headers

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const dataEndpoint = source.dataEndpoint!

  // Query params
  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string' && key !== 'dsId' && key !== 'requireDsId') params.set(key, val)
  }

  // Default per-page (configurável por datasource, com retrocompat SGBR)
  const ppParam = resolvePerPageParam(source, params)
  if (!params.has(ppParam) && !params.has('tamanho') && !params.has('per_page') && !params.has('limit') && !params.has('page_size')) {
    params.set(ppParam, resolveDefaultPerPage(source, dataEndpoint))
  }
  clampPerPage(params, ppParam)

  const pgParam = resolvePageParam(source, params)
  const paginationHints = buildPaginationHints(source)

  const sep = dataEndpoint.includes('?') ? '&' : '?'
  const fullUrl = `${joinApiUrl(baseUrl, dataEndpoint)}${params.toString() ? `${sep}${params}` : ''}`
  res.setHeader('x-iga-datasource-id', source.id)
  res.setHeader('x-iga-data-endpoint', dataEndpoint)

  const fetchUrl = async (url: string, authHeaders: Record<string, string>) => {
    return fetch(url, {
      method: 'GET',
      headers: authHeaders,
      signal: AbortSignal.timeout(PROXY_UPSTREAM_MS),
    })
  }

  const deadlineAt = Date.now() + PROXY_GLOBAL_DEADLINE_MS

  /** Aplica field mappings se configurados no datasource. */
  const finalize = (rows: unknown[]) => applyFieldMappings(rows, source.fieldMappings ?? [])

  try {
    let apiRes = await fetchUrl(fullUrl, headers)

    // Retry automático em 401 com re-login (token expirado no SGBR)
    if (apiRes.status === 401 && source.loginEndpoint) {
      const cacheKey = source.id ?? source.apiUrl
      tokenCache.delete(cacheKey)
      const newToken = await getTokenForSource(source)
      if (!newToken) {
        return res.status(401).json({ message: 'Token expirado e nao foi possivel renovar.' })
      }
      headers.Authorization = `Bearer ${newToken}`
      apiRes = await fetchUrl(fullUrl, headers)
    }

    timings.authMs = Date.now() - proxyStartedAt

    if (!apiRes.ok) {
      proxyStats.dataErrors++
      markProxyError(`data: status ${apiRes.status}`)
      return res.status(apiRes.status).json({ message: `Erro ao buscar dados (${apiRes.status})` })
    }

    const firstPayload = await apiRes.json()
    timings.firstPageMs = Date.now() - proxyStartedAt
    const firstRows = extractDataArray(firstPayload)
    const pageMeta = resolvePaginationState(firstPayload, firstRows.length, params, paginationHints)
    let { nextPage } = pageMeta

    // ─── Cursor-based pagination ───
    if (pageMeta.style === 'cursor' && pageMeta.nextCursor && proxyAutoPaginateEnabled()) {
      const merged = [...firstRows]
      const maxExtra = proxyMaxExtraPages()
      let steps = 0
      let cursor: string | undefined = pageMeta.nextCursor
      const cursorP = source.cursorParam || 'cursor'
      for (let i = 0; i < maxExtra && cursor; i++) {
        if (Date.now() >= deadlineAt) { markProxyError('data pagination deadline (cursor)'); break }
        const q = new URLSearchParams(params)
        q.set(cursorP, cursor)
        const url = `${joinApiUrl(baseUrl, dataEndpoint)}${q.toString() ? `${sep}${q}` : ''}`
        try {
          const pagedRes = await fetchUrl(url, headers)
          if (!pagedRes.ok) { markProxyError(`cursor page: ${pagedRes.status}`); break }
          const pagedPayload = await pagedRes.json()
          const rows = extractDataArray(pagedPayload)
          if (!rows.length) break
          merged.push(...rows)
          steps++
          const info = resolvePaginationStateSequential(pagedPayload, rows.length, q, paginationHints)
          cursor = info.nextCursor
        } catch { markProxyError('data pagination cursor'); break }
      }
      timings.pagesFetched = 1 + steps
      timings.paginationMs = Date.now() - proxyStartedAt - timings.firstPageMs
      return sendProxyDataJson(res, finalize(merged), { pagesFetched: 1 + steps, truncated: steps >= maxExtra })
    }

    // ─── Probe: array puro sem meta de paginação (retrocompat SGBR e APIs similares) ───
    const PROBE_MIN_ROWS = 100
    let probedPage2Rows: unknown[] | null = null
    if (
      !nextPage &&
      proxyAutoPaginateEnabled() &&
      Array.isArray(firstPayload) &&
      firstRows.length >= PROBE_MIN_ROWS
    ) {
      try {
        const probeParams = new URLSearchParams(params)
        probeParams.set(pgParam, '2')
        const probeUrl = `${joinApiUrl(baseUrl, dataEndpoint)}${probeParams.toString() ? `${sep}${probeParams}` : ''}`
        const probeRes = await fetchUrl(probeUrl, headers)
        if (probeRes.ok) {
          const probePayload = await probeRes.json()
          const probeRows = extractDataArray(probePayload)
          if (probeRows.length > 0) {
            const sigFirst = JSON.stringify(firstRows[0] ?? null)
            const sigProbe = JSON.stringify(probeRows[0] ?? null)
            if (sigFirst !== sigProbe) {
              probedPage2Rows = probeRows
              nextPage = 3
            }
          }
        }
      } catch { /* probe é best-effort */ }
    }

    if (!nextPage || !proxyAutoPaginateEnabled()) {
      return sendProxyDataJson(res, finalize(firstRows), { pagesFetched: 1 })
    }

    const maxExtra = proxyMaxExtraPages()
    if (maxExtra === 0) {
      return sendProxyDataJson(res, finalize(firstRows), { pagesFetched: 1, truncated: Boolean(nextPage) })
    }

    const merged = probedPage2Rows ? [...firstRows, ...probedPage2Rows] : [...firstRows]
    const basePagesFetched = probedPage2Rows ? 2 : 1
    if (!params.has(ppParam)) params.set(ppParam, '500')

    const paramsSnapshot = params.toString()

    const fetchPageRows = async (pageNum: number): Promise<unknown[]> => {
      const q = new URLSearchParams(paramsSnapshot)
      q.set(pgParam, String(pageNum))
      const url = `${joinApiUrl(baseUrl, dataEndpoint)}${q.toString() ? `${sep}${q}` : ''}`
      const pagedRes = await fetchUrl(url, headers)
      if (!pagedRes.ok) throw new Error(String(pagedRes.status))
      const pagedPayload = await pagedRes.json()
      return extractDataArray(pagedPayload)
    }

    const cur = pageMeta.currentPage ?? 1
    const totalPg = pageMeta.totalPages

    // ─── Paginação paralela (totalPages conhecido) ───
    if (typeof totalPg === 'number' && totalPg > cur) {
      const maxIdx = proxyMaxPageIndex()
      const lastPage = Math.min(totalPg, maxIdx)
      let truncated = totalPg > maxIdx
      const pageNums: number[] = []
      for (let p = cur + 1; p <= lastPage; p++) pageNums.push(p)
      const batchSize = 3
      let pagesFetched = 1
      let deadlineHit = false
      for (let i = 0; i < pageNums.length; i += batchSize) {
        if (Date.now() >= deadlineAt) { deadlineHit = true; break }
        const chunk = pageNums.slice(i, i + batchSize)
        try {
          const batches = await Promise.all(chunk.map((p) => fetchPageRows(p)))
          for (const rows of batches) { if (rows.length) merged.push(...rows) }
          pagesFetched += chunk.length
        } catch { proxyStats.dataErrors++; markProxyError('data pagination parallel'); break }
      }
      if (deadlineHit) { truncated = true; markProxyError('data pagination deadline (parallel)') }
      timings.pagesFetched = pagesFetched
      timings.paginationMs = Date.now() - proxyStartedAt - timings.firstPageMs
      return sendProxyDataJson(res, finalize(merged), { pagesFetched, truncated, totalPagesReported: totalPg })
    }

    // ─── Paginação sequencial (sem totalPages — inferência) ───
    let seqSteps = 0
    let currentPage = nextPage
    let seqDeadlineHit = false
    for (let i = 0; i < maxExtra; i++) {
      if (Date.now() >= deadlineAt) { seqDeadlineHit = true; break }
      const q = new URLSearchParams(paramsSnapshot)
      q.set(pgParam, String(currentPage))
      const pagedUrl = `${joinApiUrl(baseUrl, dataEndpoint)}${q.toString() ? `${sep}${q}` : ''}`
      try {
        const pagedRes = await fetchUrl(pagedUrl, headers)
        if (!pagedRes.ok) { proxyStats.dataErrors++; markProxyError(`data pagination: status ${pagedRes.status}`); break }
        const pagedPayload = await pagedRes.json()
        const rows = extractDataArray(pagedPayload)
        if (!rows.length) break
        merged.push(...rows)
        seqSteps++
        const info = resolvePaginationStateSequential(pagedPayload, rows.length, new URLSearchParams(paramsSnapshot), paginationHints)
        if (!info.nextPage || info.nextPage === currentPage) break
        currentPage = info.nextPage
      } catch { proxyStats.dataErrors++; markProxyError('data pagination sequential'); break }
    }
    if (seqDeadlineHit) markProxyError('data pagination deadline (sequential)')

    timings.pagesFetched = basePagesFetched + seqSteps
    timings.paginationMs = Date.now() - proxyStartedAt - timings.firstPageMs
    return sendProxyDataJson(res, finalize(merged), {
      pagesFetched: basePagesFetched + seqSteps,
      truncated: seqSteps >= maxExtra || seqDeadlineHit,
    })
  } catch (err) {
    proxyStats.dataErrors++
    markProxyError(err instanceof Error ? err.message : 'erro')
    res.status(502).json({
      message: `Falha ao buscar dados. Tente novamente.`,
    })
  }
})

proxyRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    stats: proxyStats,
    tokenCacheSize: tokenCache.size,
    reconcileAlert: reconcileAlertState,
  })
})

/** Snapshot para painel operacional (Sprint 7) — sem credenciais. */
export function getProxyOperationalSnapshot() {
  return {
    stats: { ...proxyStats },
    reconcileAlert: { ...reconcileAlertState },
    tokenCacheSize: tokenCache.size,
  }
}

/**
 * API interna (sem HTTP): reutiliza a mesma lógica do handler `/data` para
 * ferramentas do Copiloto e jobs. Não aplica camada de dedup/cache do Express.
 *
 * IMPORTANTE: Respeita tenant e autenticação da fonte (loginEndpoint/tokenCache).
 * Não depende de cookie/session porque roda no backend.
 */
export async function fetchProxyDataForTool(opts: {
  tenantId: string
  dsId: string
  query: Record<string, string | undefined>
}): Promise<{ ok: true; rows: unknown[]; pagesFetched: number; truncated: boolean; totalPagesReported?: number } | { ok: false; status: number; message: string }> {
  const { tenantId, dsId } = opts
  proxyStats.dataCalls++
  const all = readAll()
  const source = selectDataSource(all, tenantId, dsId)
  if (!source) {
    return { ok: false, status: 400, message: 'Fonte informada não encontrada.' }
  }

  const proxyStartedAt = Date.now()
  // Auth
  const authResult = await resolveAuthHeaders(source)
  if (!authResult.ok) return { ok: false, status: authResult.status, message: authResult.message }
  const headers = authResult.headers

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const dataEndpoint = source.dataEndpoint!

  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(opts.query)) {
    if (typeof val === 'string' && val.trim() !== '' && key !== 'dsId' && key !== 'requireDsId') params.set(key, val)
  }

  const ppParam = resolvePerPageParam(source, params)
  if (!params.has(ppParam) && !params.has('tamanho') && !params.has('per_page') && !params.has('limit') && !params.has('page_size')) {
    params.set(ppParam, resolveDefaultPerPage(source, dataEndpoint))
  }
  const pgParam = resolvePageParam(source, params)
  const paginationHints = buildPaginationHints(source)

  const sep = dataEndpoint.includes('?') ? '&' : '?'
  const fullUrl = `${joinApiUrl(baseUrl, dataEndpoint)}${params.toString() ? `${sep}${params}` : ''}`

  const fetchUrl = async (url: string) => {
    return fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(PROXY_UPSTREAM_MS) })
  }

  const deadlineAt = Date.now() + PROXY_GLOBAL_DEADLINE_MS
  const finalize = (rows: unknown[]) => applyFieldMappings(rows, source.fieldMappings ?? [])

  try {
    let apiRes = await fetchUrl(fullUrl)

    if (apiRes.status === 401 && source.loginEndpoint) {
      const cacheKey = source.id ?? source.apiUrl
      tokenCache.delete(cacheKey)
      const newToken = await getTokenForSource(source)
      if (!newToken) return { ok: false, status: 401, message: 'Token expirado e nao foi possivel renovar.' }
      headers.Authorization = `Bearer ${newToken}`
      apiRes = await fetchUrl(fullUrl)
    }

    if (!apiRes.ok) {
      proxyStats.dataErrors++
      markProxyError(`data: status ${apiRes.status}`)
      return { ok: false, status: apiRes.status, message: `Erro ao buscar dados (${apiRes.status})` }
    }

    const firstPayload = await apiRes.json()
    const firstRows = extractDataArray(firstPayload)
    const pageMeta = resolvePaginationState(firstPayload, firstRows.length, params, paginationHints)
    let { nextPage } = pageMeta

    // Cursor-based pagination
    if (pageMeta.style === 'cursor' && pageMeta.nextCursor && proxyAutoPaginateEnabled()) {
      const merged = [...firstRows]
      const maxExtra = proxyMaxExtraPages()
      let steps = 0
      let cursor: string | undefined = pageMeta.nextCursor
      const cursorP = source.cursorParam || 'cursor'
      for (let i = 0; i < maxExtra && cursor; i++) {
        if (Date.now() >= deadlineAt) break
        const q = new URLSearchParams(params)
        q.set(cursorP, cursor)
        const url = `${joinApiUrl(baseUrl, dataEndpoint)}${q.toString() ? `${sep}${q}` : ''}`
        try {
          const r = await fetchUrl(url)
          if (!r.ok) break
          const p = await r.json()
          const rows = extractDataArray(p)
          if (!rows.length) break
          merged.push(...rows)
          steps++
          const info = resolvePaginationStateSequential(p, rows.length, q, paginationHints)
          cursor = info.nextCursor
        } catch { break }
      }
      return { ok: true as const, rows: finalize(merged), pagesFetched: 1 + steps, truncated: steps >= maxExtra }
    }

    // Probe para APIs sem meta de paginação
    const PROBE_MIN_ROWS = 100
    let probedPage2Rows: unknown[] | null = null
    if (!nextPage && proxyAutoPaginateEnabled() && Array.isArray(firstPayload) && firstRows.length >= PROBE_MIN_ROWS) {
      try {
        const probeParams = new URLSearchParams(params)
        probeParams.set(pgParam, '2')
        const probeUrl = `${joinApiUrl(baseUrl, dataEndpoint)}${probeParams.toString() ? `${sep}${probeParams}` : ''}`
        const probeRes = await fetchUrl(probeUrl)
        if (probeRes.ok) {
          const probePayload = await probeRes.json()
          const probeRows = extractDataArray(probePayload)
          if (probeRows.length > 0 && JSON.stringify(firstRows[0] ?? null) !== JSON.stringify(probeRows[0] ?? null)) {
            probedPage2Rows = probeRows
            nextPage = 3
          }
        }
      } catch { /* noop */ }
    }

    if (!nextPage || !proxyAutoPaginateEnabled()) {
      return { ok: true as const, rows: finalize(firstRows), pagesFetched: 1, truncated: false }
    }

    const maxExtra = proxyMaxExtraPages()
    if (maxExtra === 0) {
      return { ok: true as const, rows: finalize(firstRows), pagesFetched: 1, truncated: Boolean(nextPage) }
    }

    const merged = probedPage2Rows ? [...firstRows, ...probedPage2Rows] : [...firstRows]
    const basePagesFetched = probedPage2Rows ? 2 : 1
    if (!params.has(ppParam)) params.set(ppParam, '500')
    const paramsSnapshot = params.toString()

    const fetchPageRows = async (pageNum: number): Promise<unknown[]> => {
      const q = new URLSearchParams(paramsSnapshot)
      q.set(pgParam, String(pageNum))
      const url = `${joinApiUrl(baseUrl, dataEndpoint)}${q.toString() ? `${sep}${q}` : ''}`
      const r = await fetchUrl(url)
      if (!r.ok) throw new Error(String(r.status))
      return extractDataArray(await r.json())
    }

    const cur = pageMeta.currentPage ?? 1
    const totalPg = pageMeta.totalPages

    if (typeof totalPg === 'number' && totalPg > cur) {
      const maxIdx = proxyMaxPageIndex()
      const lastPage = Math.min(totalPg, maxIdx)
      let truncated = totalPg > maxIdx
      const pageNums: number[] = []
      for (let p = cur + 1; p <= lastPage; p++) pageNums.push(p)
      const batchSize = 3
      let pagesFetched = 1
      let deadlineHit = false
      for (let i = 0; i < pageNums.length; i += batchSize) {
        if (Date.now() >= deadlineAt) { deadlineHit = true; break }
        const chunk = pageNums.slice(i, i + batchSize)
        try {
          const batches = await Promise.all(chunk.map((p) => fetchPageRows(p)))
          for (const rows of batches) if (rows.length) merged.push(...rows)
          pagesFetched += chunk.length
        } catch { proxyStats.dataErrors++; markProxyError('data pagination parallel'); break }
      }
      if (deadlineHit) { truncated = true; markProxyError('data pagination deadline (parallel)') }
      return { ok: true as const, rows: finalize(merged), pagesFetched, truncated, totalPagesReported: totalPg }
    }

    let seqSteps = 0
    let currentPage = nextPage
    let seqDeadlineHit = false
    for (let i = 0; i < maxExtra; i++) {
      if (Date.now() >= deadlineAt) { seqDeadlineHit = true; break }
      const q = new URLSearchParams(paramsSnapshot)
      q.set(pgParam, String(currentPage))
      const pagedUrl = `${joinApiUrl(baseUrl, dataEndpoint)}${q.toString() ? `${sep}${q}` : ''}`
      try {
        const r = await fetchUrl(pagedUrl)
        if (!r.ok) { proxyStats.dataErrors++; break }
        const pagedPayload = await r.json()
        const rows = extractDataArray(pagedPayload)
        if (!rows.length) break
        merged.push(...rows)
        seqSteps++
        const info = resolvePaginationStateSequential(pagedPayload, rows.length, new URLSearchParams(paramsSnapshot), paginationHints)
        if (!info.nextPage || info.nextPage === currentPage) break
        currentPage = info.nextPage
      } catch { proxyStats.dataErrors++; break }
    }

    return {
      ok: true as const,
      rows: finalize(merged),
      pagesFetched: basePagesFetched + seqSteps,
      truncated: seqSteps >= maxExtra || seqDeadlineHit,
    }
  } catch (err) {
    proxyStats.dataErrors++
    markProxyError(err instanceof Error ? err.message : 'erro')
    return { ok: false as const, status: 502, message: 'Falha ao buscar dados. Tente novamente.' }
  }
}
