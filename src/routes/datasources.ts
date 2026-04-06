import { Router } from 'express'
import { readAll, writeAll, genId, type DataSource } from '../storage.js'
import { testConnection } from '../services/connectionTester.js'

export const dataSourceRouter = Router()

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

/**
 * Aceita credenciais em dois formatos:
 * - authCredentials: "login:senha"
 * - apiLogin + apiPassword (campos separados do frontend)
 */
function resolveAuthCredentials(body: DataSourceBody): string | undefined {
  const authCredentials = toOptionalString(body.authCredentials)
  if (authCredentials !== undefined) return authCredentials

  const apiLogin = toOptionalString(body.apiLogin)
  const apiPassword = toOptionalString(body.apiPassword) ?? ''

  if (apiLogin === undefined) return undefined
  return `${apiLogin}:${apiPassword}`
}

function sanitize(body: DataSourceBody) {
  // apiUrl: extrair só a origin (scheme + host + port)
  if (typeof body.apiUrl === 'string') {
    try {
      const u = new URL(body.apiUrl)
      body.apiUrl = u.origin
    } catch { /* manter */ }
  }

  // endpoints: se vier URL completa, extrair path
  const endpointKeys: Array<'loginEndpoint' | 'dataEndpoint'> = ['loginEndpoint', 'dataEndpoint']
  for (const key of endpointKeys) {
    const val = body[key]
    if (typeof val === 'string' && val.startsWith('http')) {
      try { body[key] = new URL(val).pathname } catch { /* manter */ }
    }
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
  const all = readAll().map((ds) => ({ ...ds, authCredentials: undefined }))
  res.json(all)
})

// POST /test — testa config ANTES de salvar (DEVE vir antes de /:id)
dataSourceRouter.post('/test', async (req, res) => {
  const body = req.body as DataSourceBody
  const dsForTest = {
    ...body,
    authCredentials: resolveAuthCredentials(body),
  } as DataSource

  const result = await testConnection(dsForTest)
  res.json(result)
})

// GET /:id
dataSourceRouter.get('/:id', (req, res) => {
  const ds = readAll().find((d) => d.id === req.params.id)
  if (!ds) return res.status(404).json({ message: 'Nao encontrada' })
  res.json({ ...ds, authCredentials: undefined })
})

// POST / — cria
dataSourceRouter.post('/', (req, res) => {
  const body = req.body as DataSourceBody
  sanitize(body)
  if (!body.name || !body.apiUrl) {
    return res.status(400).json({ message: 'Nome e URL da API sao obrigatorios' })
  }
  let all = readAll()
  if (body.isAuthSource) all = all.map((ds) => ({ ...ds, isAuthSource: false }))

  const now = new Date().toISOString()
  const ds: DataSource = {
    id: genId(),
    tenantId: body.tenantId ?? 'default',
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
    createdAt: now,
    updatedAt: now,
  }
  writeAll([...all, ds])
  res.status(201).json({ ...ds, authCredentials: undefined })
})

// PUT /:id — atualiza
dataSourceRouter.put('/:id', (req, res) => {
  let all = readAll()
  const idx = all.findIndex((d) => d.id === req.params.id)
  if (idx < 0) return res.status(404).json({ message: 'Nao encontrada' })

  const body = req.body as DataSourceBody
  sanitize(body)
  if (body.isAuthSource) all = all.map((ds, i) => i === idx ? ds : { ...ds, isAuthSource: false })
  const nextAuthCredentials = resolveAuthCredentials(body)

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
    updatedAt: new Date().toISOString(),
  }
  writeAll(all)
  res.json({ ...all[idx], authCredentials: undefined })
})

// DELETE /:id
dataSourceRouter.delete('/:id', (req, res) => {
  writeAll(readAll().filter((d) => d.id !== req.params.id))
  res.json({ ok: true })
})

// POST /:id/test — testa fonte salva
dataSourceRouter.post('/:id/test', async (req, res) => {
  const all = readAll()
  const ds = all.find((d) => d.id === req.params.id)
  if (!ds) return res.status(404).json({ message: 'Nao encontrada' })

  const result = await testConnection(ds)
  const idx = all.findIndex((d) => d.id === ds.id)
  if (idx >= 0) {
    all[idx] = {
      ...all[idx],
      status: result.success ? 'connected' : 'error',
      lastCheckedAt: new Date().toISOString(),
      lastError: result.success ? null : result.message,
    }
    writeAll(all)
  }
  res.json(result)
})
