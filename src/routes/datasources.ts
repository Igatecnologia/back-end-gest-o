import { Router } from 'express'
import { z } from 'zod'
import { readAll, writeAll, genId, runWithDatasourcesLock, type DataSource } from '../storage.js'
import { testConnection } from '../services/connectionTester.js'
import { requireAuth } from '../middleware/auth.js'
import { resolveTenantId } from '../utils/tenant.js'
import { validateExternalApiUrl } from '../utils/urlSafety.js'
import rateLimit from 'express-rate-limit'

export const dataSourceRouter = Router()
dataSourceRouter.use(requireAuth)

const dataSourceTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
})

const fieldMappingSchema = z.object({
  standardField: z.string().min(1).max(80),
  sourceField: z.string().min(1).max(120),
  transform: z.string().min(1).max(40).default('none'),
})

const dataSourceBodySchema = z
  .object({
    name: z.string().min(1, 'Nome obrigatorio').max(120),
    type: z.string().min(1).max(40).optional(),
    apiUrl: z.string().min(1, 'URL obrigatoria').max(500),
    authMethod: z.enum(['none', 'bearer_token', 'api_key', 'basic_auth']).optional(),
    authCredentials: z.string().max(500).optional(),
    apiLogin: z.string().max(200).optional(),
    apiPassword: z.string().max(500).optional(),
    fieldMappings: z.array(fieldMappingSchema).max(200).optional(),
    erpEndpoints: z.array(z.string().min(1).max(80)).max(50).optional(),
    isAuthSource: z.boolean().optional(),
    loginEndpoint: z.string().max(500).optional(),
    dataEndpoint: z.string().max(500).optional(),
    passwordMode: z.enum(['plain', 'sha256', 'md5']).optional(),
    loginFieldUser: z.string().max(60).optional(),
    loginFieldPassword: z.string().max(60).optional(),
    /** Configuração de paginação genérica */
    paginationStyle: z.enum(['page', 'offset', 'cursor', 'none']).optional(),
    pageParam: z.string().max(60).optional(),
    perPageParam: z.string().max(60).optional(),
    defaultPerPage: z.number().int().min(1).max(50000).optional(),
    cursorParam: z.string().max(60).optional(),
    cursorResponseField: z.string().max(120).optional(),
  })
  /** Campos extras são descartados em vez de rejeitados — mantém compat com UI que envia `hasApiPassword`. */
  .passthrough()

type DataSourceBodyInput = z.infer<typeof dataSourceBodySchema>

function parseDataSourceBody(input: unknown, partial = false):
  | { ok: true; data: DataSourceBodyInput }
  | { ok: false; message: string } {
  const schema = partial ? dataSourceBodySchema.partial() : dataSourceBodySchema
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Dados invalidos' }
  }
  return { ok: true, data: parsed.data as DataSourceBodyInput }
}

/**
 * Sanitiza campos para evitar config errada:
 * - apiUrl: só mantém scheme + host + port (remove paths e query strings)
 * - loginEndpoint / dataEndpoint: se vier URL completa, extrai só o path
 */
/**
 * Nomes válidos de campos JSON para login.
 * Se o valor não for um nome de campo reconhecido, reseta para o padrão.
 */
const VALID_FIELD_NAMES = new Set([
  'login', 'usuario', 'username', 'user', 'email', 'usr', 'cpf', 'cnpj',
  'senha', 'password', 'pass', 'pwd', 'secret', 'key',
])

type DataSourceBody = Partial<DataSource> & {
  apiLogin?: string
  apiPassword?: string
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

/** Separa "login:senha" gravado em authCredentials (ou token sem ":"). */
function splitStoredCredentials(raw: string | undefined): { login: string; password: string } {
  if (!raw) return { login: '', password: '' }
  const i = raw.indexOf(':')
  if (i < 0) return { login: '', password: raw }
  return { login: raw.slice(0, i), password: raw.slice(i + 1) }
}

/** Resposta ao cliente: nunca envia senha; devolve login e se há senha salva. */
function toPublicDataSource(ds: DataSource) {
  const { authCredentials, ...rest } = ds
  const { login, password } = splitStoredCredentials(authCredentials)
  return {
    ...rest,
    apiLogin: login || undefined,
    hasApiPassword: password.length > 0,
  }
}

/**
 * Aceita credenciais em dois formatos:
 * - authCredentials: "login:senha"
 * - apiLogin + apiPassword (campos separados do frontend)
 */
function resolveAuthCredentials(body: DataSourceBody): string | undefined {
  if (typeof body.authCredentials === 'string' && body.authCredentials.trim().length > 0) {
    return body.authCredentials.trim()
  }

  const apiLogin = toOptionalString(body.apiLogin)
  const apiPassword = toOptionalString(body.apiPassword) ?? ''

  if (!apiLogin) return undefined
  return `${apiLogin}:${apiPassword}`
}

/**
 * PUT: se apiPassword vier vazio ou omitido, mantém a senha já salva em authCredentials.
 */
function resolveAuthCredentialsForUpdate(existing: string | undefined, body: DataSourceBody): string | undefined {
  if (typeof body.authCredentials === 'string' && body.authCredentials.trim().length > 0) {
    return body.authCredentials.trim()
  }

  const { login: oldL, password: oldP } = splitStoredCredentials(existing)
  const loginNew = typeof body.apiLogin === 'string' ? body.apiLogin.trim() : undefined
  const login = loginNew !== undefined && loginNew !== '' ? loginNew : oldL

  const hasPasswordKey = Object.prototype.hasOwnProperty.call(body, 'apiPassword')
  let password = oldP
  if (hasPasswordKey && typeof body.apiPassword === 'string') {
    const p = body.apiPassword.trim()
    if (p.length > 0) password = p
  }

  if (!login && !password && !existing) return undefined
  if (!login && !password) return undefined

  return `${login}:${password}`
}

/**
 * Params temporais que NÃO devem persistir no `dataEndpoint` salvo —
 * janela de datas é volátil e deve vir do caller (frontend ao filtrar)
 * ou do fallback do teste (janela de 3 meses automática).
 *
 * Usuários colavam URLs com `?dt_de=2025.02.20&dt_ate=2025.02.20` e o teste
 * retornava "sem dados no período" indefinidamente.
 */
const VOLATILE_QUERY_PARAMS = new Set([
  'dt_de', 'dt_ate',
  'start_date', 'end_date',
  'start', 'end',
  'desde', 'ate',
  'from', 'to',
  'data_de', 'data_ate',
])

function stripVolatileDateParams(endpoint: string): string {
  const qIdx = endpoint.indexOf('?')
  if (qIdx < 0) return endpoint
  const path = endpoint.slice(0, qIdx)
  const query = endpoint.slice(qIdx + 1)
  if (!query) return path
  const kept: string[] = []
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const name = (eq >= 0 ? part.slice(0, eq) : part).toLowerCase()
    if (VOLATILE_QUERY_PARAMS.has(name)) continue
    kept.push(part)
  }
  return kept.length > 0 ? `${path}?${kept.join('&')}` : path
}

function sanitize(body: DataSourceBody) {
  // apiUrl: extrair só a origin (scheme + host + port)
  if (typeof body.apiUrl === 'string') {
    try {
      const u = new URL(body.apiUrl)
      body.apiUrl = u.origin
    } catch { /* manter */ }
  }

  // endpoints: se vier URL completa, extrair path + remover params voláteis de data
  const endpointKeys: Array<'loginEndpoint' | 'dataEndpoint'> = ['loginEndpoint', 'dataEndpoint']
  for (const key of endpointKeys) {
    const val = body[key]
    if (typeof val !== 'string') continue
    let next = val
    if (next.startsWith('http')) {
      try {
        const u = new URL(next)
        next = u.pathname + (u.search ?? '')
      } catch { /* manter como veio */ }
    }
    if (key === 'dataEndpoint') {
      next = stripVolatileDateParams(next)
    }
    body[key] = next
  }

  // loginFieldUser / loginFieldPassword: devem ser nomes de campos, não valores
  if (typeof body.loginFieldUser === 'string' && !VALID_FIELD_NAMES.has(body.loginFieldUser.toLowerCase())) {
    body.loginFieldUser = 'login'
  }
  if (typeof body.loginFieldPassword === 'string' && !VALID_FIELD_NAMES.has(body.loginFieldPassword.toLowerCase())) {
    body.loginFieldPassword = 'senha'
  }
}

// GET / — lista todas
dataSourceRouter.get('/', (_req, res) => {
  const tenantId = resolveTenantId(_req)
  const all = readAll()
    .filter((ds) => ds.tenantId === tenantId)
    .map((ds) => toPublicDataSource(ds))
  res.json(all)
})

// POST /test — testa config ANTES de salvar (DEVE vir antes de /:id)
dataSourceRouter.post('/test', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const validation = parseDataSourceBody(req.body, true)
  if (!validation.ok) return res.status(400).json({ message: validation.message })
  const body = validation.data as DataSourceBody
  const dsForTest = {
    ...body,
    tenantId,
    authCredentials: resolveAuthCredentials(body),
  } as DataSource

  const result = await testConnection(dsForTest)
  res.json(result)
})

// GET /:id
dataSourceRouter.get('/:id', (req, res) => {
  const tenantId = resolveTenantId(req)
  const ds = readAll().find((d) => d.id === req.params.id && d.tenantId === tenantId)
  if (!ds) return res.status(404).json({ message: 'Nao encontrada' })
  res.json(toPublicDataSource(ds))
})

// POST / — cria
dataSourceRouter.post('/', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const validation = parseDataSourceBody(req.body)
  if (!validation.ok) return res.status(400).json({ message: validation.message })
  const body = validation.data as DataSourceBody
  sanitize(body)
  if (!body.name || !body.apiUrl) {
    return res.status(400).json({ message: 'Nome e URL da API sao obrigatorios' })
  }
  const safety = validateExternalApiUrl(body.apiUrl)
  if (!safety.ok) {
    return res.status(400).json({ message: safety.message })
  }

  const now = new Date().toISOString()
  const ds: DataSource = {
    id: genId(),
    tenantId,
    name: body.name,
    type: body.type ?? 'rest_api',
    apiUrl: body.apiUrl,
    authMethod: body.authMethod ?? 'none',
    authCredentials: resolveAuthCredentials(body),
    status: 'pending',
    lastCheckedAt: null,
    lastError: null,
    fieldMappings: body.fieldMappings ?? [],
    erpEndpoints: body.erpEndpoints ?? [],
    isAuthSource: body.isAuthSource ?? false,
    loginEndpoint: body.loginEndpoint,
    dataEndpoint: body.dataEndpoint,
    passwordMode: body.passwordMode ?? 'plain',
    loginFieldUser: body.loginFieldUser ?? 'login',
    loginFieldPassword: body.loginFieldPassword ?? 'senha',
    paginationStyle: body.paginationStyle,
    pageParam: body.pageParam,
    perPageParam: body.perPageParam,
    defaultPerPage: body.defaultPerPage,
    cursorParam: body.cursorParam,
    cursorResponseField: body.cursorResponseField,
    createdAt: now,
    updatedAt: now,
  }
  await runWithDatasourcesLock(async () => {
    const all = readAll()
    writeAll([...all, ds])
  })
  res.status(201).json(toPublicDataSource(ds))
})

// PUT /:id — atualiza
dataSourceRouter.put('/:id', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const validation = parseDataSourceBody(req.body, true)
  if (!validation.ok) return res.status(400).json({ message: validation.message })
  const body = validation.data as DataSourceBody
  sanitize(body)
  if (body.apiUrl) {
    const safety = validateExternalApiUrl(body.apiUrl)
    if (!safety.ok) {
      return res.status(400).json({ message: safety.message })
    }
  }

  let updated: DataSource | null = null
  await runWithDatasourcesLock(async () => {
    const all = readAll()
    const idx = all.findIndex((d) => d.id === req.params.id && d.tenantId === tenantId)
    if (idx < 0) return

    const nextAuthCredentials = resolveAuthCredentialsForUpdate(all[idx].authCredentials, body)

    all[idx] = {
      ...all[idx],
      ...(body.name != null && { name: body.name }),
      ...(body.type != null && { type: body.type }),
      ...(body.apiUrl != null && { apiUrl: body.apiUrl }),
      ...(body.authMethod != null && { authMethod: body.authMethod }),
      ...(nextAuthCredentials !== undefined && { authCredentials: nextAuthCredentials }),
      ...(body.fieldMappings != null && { fieldMappings: body.fieldMappings }),
      ...(body.erpEndpoints != null && { erpEndpoints: body.erpEndpoints }),
      ...(body.isAuthSource != null && { isAuthSource: body.isAuthSource }),
      ...(body.loginEndpoint !== undefined && { loginEndpoint: body.loginEndpoint }),
      ...(body.dataEndpoint !== undefined && { dataEndpoint: body.dataEndpoint }),
      ...(body.passwordMode != null && { passwordMode: body.passwordMode }),
      ...(body.loginFieldUser != null && { loginFieldUser: body.loginFieldUser }),
      ...(body.loginFieldPassword != null && { loginFieldPassword: body.loginFieldPassword }),
      ...(body.paginationStyle !== undefined && { paginationStyle: body.paginationStyle }),
      ...(body.pageParam !== undefined && { pageParam: body.pageParam }),
      ...(body.perPageParam !== undefined && { perPageParam: body.perPageParam }),
      ...(body.defaultPerPage !== undefined && { defaultPerPage: body.defaultPerPage }),
      ...(body.cursorParam !== undefined && { cursorParam: body.cursorParam }),
      ...(body.cursorResponseField !== undefined && { cursorResponseField: body.cursorResponseField }),
      updatedAt: new Date().toISOString(),
    }
    updated = all[idx]
    writeAll(all)
  })

  if (!updated) return res.status(404).json({ message: 'Nao encontrada' })
  res.json(toPublicDataSource(updated))
})

// DELETE /:id
dataSourceRouter.delete('/:id', async (req, res) => {
  const tenantId = resolveTenantId(req)
  await runWithDatasourcesLock(async () => {
    writeAll(readAll().filter((d) => !(d.id === req.params.id && d.tenantId === tenantId)))
  })
  res.json({ ok: true })
})

// POST /:id/test — testa fonte salva
dataSourceRouter.post('/:id/test', dataSourceTestLimiter, async (req, res) => {
  const tenantId = resolveTenantId(req)
  const ds = readAll().find((d) => d.id === req.params.id && d.tenantId === tenantId)
  if (!ds) {
    return res.status(404).json({
      message: 'Nao encontrada',
      tenantId,
      requestedId: req.params.id,
    })
  }

  const result = await testConnection(ds)

  await runWithDatasourcesLock(async () => {
    const list = readAll()
    const idx = list.findIndex((d) => d.id === ds.id && d.tenantId === tenantId)
    if (idx < 0) return
    list[idx] = {
      ...list[idx],
      status: result.success ? 'connected' : 'error',
      lastCheckedAt: new Date().toISOString(),
      lastError: result.success ? null : result.message,
    }
    writeAll(list)
  })

  res.json(result)
})
