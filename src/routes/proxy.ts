import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { readAll } from '../storage.js'
import { hashPassword } from '../services/passwordHasher.js'
import { extractDataArray } from '../utils/extractDataArray.js'
import { requireAuth } from '../middleware/auth.js'
import { resolveTenantId } from '../utils/tenant.js'

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

function getPaginationInfo(payload: unknown): { nextPage?: number; totalPages?: number } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const obj = payload as Record<string, unknown>
  const page = typeof obj.page === 'number' ? obj.page : typeof obj.pagina === 'number' ? obj.pagina : undefined
  const totalPages =
    typeof obj.totalPages === 'number'
      ? obj.totalPages
      : typeof obj.total_paginas === 'number'
        ? obj.total_paginas
        : typeof obj.last_page === 'number'
          ? obj.last_page
          : undefined
  const nextPage =
    typeof obj.nextPage === 'number'
      ? obj.nextPage
      : typeof obj.next_page === 'number'
        ? obj.next_page
        : (typeof page === 'number' && typeof totalPages === 'number' && page < totalPages ? page + 1 : undefined)
  return { nextPage, totalPages }
}

async function getTokenForSource(source: ReturnType<typeof readAll>[number]): Promise<string | null> {
  const cacheKey = source.id ?? source.apiUrl

  const cached = tokenCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token
  }

  if (!source.isAuthSource || !source.loginEndpoint) return null

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

    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + 55 * 60 * 1000 })
    return token
  } catch {
    return null
  }
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

  if (source.isAuthSource && source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) {
      return res.status(401).json({ message: 'Nao foi possivel autenticar.' })
    }
    headers.Authorization = `Bearer ${token}`
  } else if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  }

  const baseUrl = source.apiUrl.replace(/\/+$/, '')
  const dataEndpoint = source.dataEndpoint!

  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string' && key !== 'dsId') params.set(key, val)
  }
  const sep = dataEndpoint.includes('?') ? '&' : '?'
  const fullUrl = `${baseUrl}${dataEndpoint}${params.toString() ? `${sep}${params}` : ''}`

  try {
    const apiRes = await fetch(fullUrl, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) })
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
  if (source.isAuthSource && source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) return res.status(401).json({ message: 'Nao foi possivel autenticar.' })
    headers.Authorization = `Bearer ${token}`
  } else if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
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
    return `${baseUrl}${endpoint}${params.toString() ? `${sep}${params}` : ''}`
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
  if (source.isAuthSource && source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) return res.status(401).json({ message: 'Não foi possível autenticar para reconciliação.' })
    headers.Authorization = `Bearer ${token}`
  } else if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  }

  const mkUrl = (ep: string) => `${baseUrl}${ep}${qs.toString() ? `${ep.includes('?') ? '&' : '?'}${qs}` : ''}`
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
  if (source.isAuthSource && source.loginEndpoint) {
    const token = await getTokenForSource(source)
    if (!token) throw new Error('Não foi possível autenticar para alerta.')
    headers.Authorization = `Bearer ${token}`
  } else if (source.authMethod === 'bearer_token' && source.authCredentials) {
    headers.Authorization = `Bearer ${source.authCredentials}`
  }

  const mkUrl = (ep: string) => `${baseUrl}${ep}${qs.toString() ? `${ep.includes('?') ? '&' : '?'}${qs}` : ''}`
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
 * GET /api/proxy/data
 */
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
  res.on('finish', () => {
    if (process.env.LOG_PROXY_DATA !== '1') return
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        level: 'info',
        event: 'proxy.data',
        tenantId,
        dsId: source.id,
        dataEndpoint: source.dataEndpoint ?? null,
        durationMs: Date.now() - proxyStartedAt,
        status: res.statusCode,
      }),
    )
  })

  const headers: Record<string, string> = { Accept: 'application/json' }

  if (source.isAuthSource && source.loginEndpoint) {
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

  const params = new URLSearchParams()
  for (const [key, val] of Object.entries(req.query)) {
    if (typeof val === 'string' && key !== 'dsId' && key !== 'requireDsId') params.set(key, val)
  }
  const sep = dataEndpoint.includes('?') ? '&' : '?'
  const fullUrl = `${baseUrl}${dataEndpoint}${params.toString() ? `${sep}${params}` : ''}`
  res.setHeader('x-iga-datasource-id', source.id)
  res.setHeader('x-iga-data-endpoint', dataEndpoint)

  const fetchData = async (authHeaders: Record<string, string>) => {
    return fetch(fullUrl, {
      method: 'GET',
      headers: authHeaders,
      signal: AbortSignal.timeout(30_000),
    })
  }

  try {
    let apiRes = await fetchData(headers)

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
      proxyStats.dataErrors++
      markProxyError(`data: status ${apiRes.status}`)
      return res.status(apiRes.status).json({ message: `Erro ao buscar dados (${apiRes.status})` })
    }

    const firstPayload = await apiRes.json()
    const firstRows = extractDataArray(firstPayload)
    const { nextPage } = getPaginationInfo(firstPayload)

    if (!nextPage) {
      return res.json(firstRows)
    }

    const merged = [...firstRows]
    const pageParam = params.has('page') ? 'page' : params.has('pagina') ? 'pagina' : 'page'
    const perPageParam = params.has('per_page') ? 'per_page' : params.has('tamanho') ? 'tamanho' : 'per_page'
    if (!params.has(perPageParam)) params.set(perPageParam, '500')

    let currentPage = nextPage
    const safetyMaxPages = 200
    for (let i = 0; i < safetyMaxPages; i++) {
      params.set(pageParam, String(currentPage))
      const pagedUrl = `${baseUrl}${dataEndpoint}${dataEndpoint.includes('?') ? '&' : '?'}${params.toString()}`
      const pagedRes = await fetch(pagedUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30_000),
      })
      if (!pagedRes.ok) {
        proxyStats.dataErrors++
        markProxyError(`data pagination: status ${pagedRes.status}`)
        break
      }
      const pagedPayload = await pagedRes.json()
      const rows = extractDataArray(pagedPayload)
      if (!rows.length) break
      merged.push(...rows)
      const info = getPaginationInfo(pagedPayload)
      if (!info.nextPage || info.nextPage === currentPage) break
      currentPage = info.nextPage
    }

    return res.json(merged)
  } catch (err) {
    proxyStats.dataErrors++
    markProxyError(err instanceof Error ? err.message : 'erro')
    res.status(502).json({
      message: `Falha: ${err instanceof Error ? err.message : 'erro'}`,
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
