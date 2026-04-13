import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { proxyRouter, setupReconcileAlertScheduler } from './routes/proxy.js'
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
import { jsonRequestLog } from './middleware/requestLog.js'
import { opsRouter } from './routes/ops.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

type CreateAppOptions = {
  startSchedulers?: boolean
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express()
  const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173'
  const startSchedulers = options.startSchedulers ?? true

  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(cors({
    origin: [FRONTEND_URL, 'http://localhost:5173', 'http://localhost:4173'],
    credentials: true,
  }))
  app.use(express.json({ limit: '1mb' }))
  app.use(jsonRequestLog)

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

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/ops', opsRouter)

  app.use('/api/v1/users', requireAdmin, usersRouter)
  app.use('/api/v1/datasources', dataSourceRouter)
  app.use('/api/proxy', proxyRouter)
  app.use('/dashboard', requireAuth, dashboardRouter)
  app.use('/reports', requireAuth, reportsRouter)
  app.use('/audit', requireAdmin, auditRouter)
  app.use('/erp', requireAuth, erpRouter)
  app.use('/finance', requireAuth, financeRouter)

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500
    if (status >= 500) {
      console.error('[IGA Backend] Erro interno:', err.message)
    }
    res.status(status).json({
      message: status < 500 ? err.message : 'Erro interno do servidor',
    })
  })

  seedDefaultAdmin()
  if (startSchedulers) setupReconcileAlertScheduler()

  return app
}
