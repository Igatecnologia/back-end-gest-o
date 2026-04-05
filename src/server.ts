import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
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

// Health check — publico
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: Math.round(process.uptime()) })
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

// Error handler global
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as any).status ?? 500
  const message = status < 500 ? err.message : 'Erro interno do servidor'
  res.status(status).json({ message })
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
