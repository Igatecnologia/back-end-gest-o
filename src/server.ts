import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyRouter } from './routes/proxy.js'
import { dataSourceRouter } from './routes/datasources.js'
import { authRouter } from './routes/auth.js'
import { usersRouter } from './routes/users.js'
import { dashboardRouter } from './routes/dashboard.js'
import { reportsRouter } from './routes/reports.js'
import { auditRouter } from './routes/audit.js'
import { erpRouter } from './routes/erp.js'
import { financeRouter } from './routes/finance.js'
import { seedDefaultAdmin } from './seedAdmin.js'
import { requireAuth, requireAdmin } from './middleware/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = Number(process.env.PORT ?? 3000)
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173'

// Seguranca
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:5173', 'http://localhost:4173'],
  credentials: true,
}))
app.use(express.json({ limit: '1mb' }))

// Health check com verificação de integridade
app.get('/health', (_req, res) => {
  const dataDir = join(__dirname, '..', 'data')
  const usersOk = existsSync(join(dataDir, 'users.json'))
  const dsOk = existsSync(join(dataDir, 'datasources.json'))

  const healthy = usersOk && dsOk
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    storage: { users: usersOk, datasources: dsOk },
  })
})

// Rotas publicas
app.use('/api/v1/auth', authRouter)

// Rotas protegidas por autenticacao
app.use('/api/v1/users', requireAdmin, usersRouter)
app.use('/api/v1/datasources', requireAuth, dataSourceRouter)
app.use('/api/proxy', requireAuth, proxyRouter)
app.use('/dashboard', requireAuth, dashboardRouter)
app.use('/reports', requireAuth, reportsRouter)
app.use('/audit', requireAdmin, auditRouter)
app.use('/erp', requireAuth, erpRouter)
app.use('/finance', requireAuth, financeRouter)

// Error handler global — não vaza detalhes internos
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number }).status ?? 500
  if (status >= 500) {
    console.error('[IGA Backend] Erro interno:', err.message)
  }
  res.status(status).json({
    message: status < 500 ? err.message : 'Erro interno do servidor',
  })
})

// Seed admin padrao
seedDefaultAdmin()

// Iniciar servidor com graceful shutdown
const server = app.listen(PORT, () => {
  console.log(`[IGA Backend] http://localhost:${PORT}`)
})

function shutdown(signal: string) {
  console.log(`[IGA Backend] ${signal} — encerrando...`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
