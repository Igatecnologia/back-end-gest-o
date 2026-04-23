import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getProxyOperationalSnapshot, proxyRouter, setupReconcileAlertScheduler } from './routes/proxy.js'
import { dataSourceRouter } from './routes/datasources.js'
import { authRouter } from './routes/auth.js'
import { usersRouter } from './routes/users.js'
import { dashboardRouter } from './routes/dashboard.js'
import { reportsRouter } from './routes/reports.js'
import { auditRouter } from './routes/audit.js'
import { erpRouter } from './routes/erp.js'
import { financeRouter } from './routes/finance.js'
import { seedDefaultAdmin } from './seedAdmin.js'
import { readAll as ensureDataSourcesFile } from './storage.js'
import { readAllUsers as ensureUsersFile } from './userStorage.js'
import { requireAuth, requireAdmin } from './middleware/auth.js'
import { csrfProtection } from './middleware/csrf.js'
import { jsonRequestLog } from './middleware/requestLog.js'
import { opsRouter } from './routes/ops.js'
import { alertsRouter, startAlertsEngine } from './routes/alerts.js'
import { userPreferencesRouter } from './routes/userPreferences.js'
import { searchRouter } from './routes/search.js'
import { copilotRouter } from './routes/copilot.js'
import { scheduledReportsRouter } from './routes/scheduledReports.js'
import { startScheduledReportsJob } from './jobs/scheduledReports.js'
import { startBackupScheduler } from './jobs/dbBackup.js'
import { startCopilotRetentionJob } from './jobs/copilotRetention.js'
import { startWarmCacheJob } from './jobs/warmCache.js'
import { getDbPath } from './db/sqlite.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

type CreateAppOptions = {
  startSchedulers?: boolean
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express()
  const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173'
  const startSchedulers = options.startSchedulers ?? true

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://*.sgbrbi.com.br'],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }))
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    next()
  })
  /** Gzip em todas as respostas — corta JSON do proxy SGBR em ~70-80%, payload de
   *  10MB vira ~2MB. Threshold 1KB pra não comprimir respostas curtas em vão. */
  app.use(compression({ threshold: 1024 }))
  /**
   * CORS: em produção só a `FRONTEND_URL` é aceita; em dev adicionamos as portas Vite comuns.
   * Remover os hardcodes em produção evita que origens indesejadas usem credentials=true.
   */
  const isStrictlyDev = process.env.NODE_ENV === 'development'
  const allowedOrigins = isStrictlyDev
    ? [FRONTEND_URL, 'http://localhost:5173', 'http://localhost:4173']
    : [FRONTEND_URL]
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
  }))
  app.use(express.json({ limit: '1mb' }))
  app.use(csrfProtection)
  app.use(jsonRequestLog)

  app.get('/health/live', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    })
  })

  const getReadyPayload = () => {
    const sqliteOk = existsSync(getDbPath())
    const proxySnapshot = getProxyOperationalSnapshot()
    const sgbrLastErrorAt = proxySnapshot.stats.lastErrorAt
    const sgbrLastSuccessAt =
      proxySnapshot.reconcileAlert.status === 'ok' || proxySnapshot.reconcileAlert.status === 'alert'
        ? proxySnapshot.reconcileAlert.lastCheckAt
        : null

    const healthy = sqliteOk
    const mem = process.memoryUsage()
    return {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      version: process.env.APP_VERSION ?? process.env.npm_package_version ?? 'dev',
      node: process.version,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      storage: { ok: healthy, sqlite: sqliteOk },
      sgbr: {
        lastSuccessAt: sgbrLastSuccessAt,
        lastErrorAt: sgbrLastErrorAt,
      },
    }
  }

  app.get('/health/ready', (_req, res) => {
    const payload = getReadyPayload()
    res.status(payload.status === 'ok' ? 200 : 503).json(payload)
  })

  app.get('/health', (_req, res) => {
    const payload = getReadyPayload()
    res.status(payload.status === 'ok' ? 200 : 503).json(payload)
  })

  app.use('/api/v1/auth', authRouter)
  app.use('/api/v1/ops', opsRouter)
  app.use('/api/v1/users', userPreferencesRouter)
  app.use('/api/v1/alerts', alertsRouter)
  app.use('/api/v1/search', searchRouter)
  app.use('/api/v1/copilot', copilotRouter)
  app.use('/api/v1/scheduled-reports', scheduledReportsRouter)

  app.use('/api/v1/users', requireAdmin, usersRouter)
  app.use('/api/v1/datasources', dataSourceRouter)
  app.use('/api/proxy', proxyRouter)
  app.use('/dashboard', requireAuth, dashboardRouter)
  app.use('/reports', requireAuth, reportsRouter)
  app.use('/audit', requireAdmin, auditRouter)
  app.use('/erp', requireAuth, erpRouter)
  app.use('/finance', requireAuth, financeRouter)

  /**
   * Modo "tudo-em-um": quando existir uma build do frontend em `SERVE_FRONTEND_DIR`
   * (ou no default `../front-end-dist`), o Express serve os arquivos estáticos e
   * faz fallback SPA para `index.html` em qualquer rota que não seja API.
   * Permite empacotar frontend + backend como um único processo (instalador Windows).
   */
  const serveDir = process.env.SERVE_FRONTEND_DIR?.trim() || join(__dirname, '..', 'front-end-dist')
  if (existsSync(join(serveDir, 'index.html'))) {
    console.log(`[IGA Backend] Servindo frontend estático de ${serveDir}`)
    app.use(express.static(serveDir, { index: false, maxAge: '1h' }))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/dashboard') || req.path.startsWith('/reports')
        || req.path.startsWith('/audit') || req.path.startsWith('/erp') || req.path.startsWith('/finance')
        || req.path === '/health') {
        return next()
      }
      res.sendFile(join(serveDir, 'index.html'))
    })
  }

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (err as { status?: number }).status ?? 500
    if (status >= 500) {
      console.error('[IGA Backend] Erro interno:', err.message)
    }
    res.status(status).json({
      message: status < 500 ? err.message : 'Erro interno do servidor',
    })
  })

  /** Garante seed inicial após inicialização do SQLite. */
  ensureUsersFile()
  ensureDataSourcesFile()
  seedDefaultAdmin()
  if (startSchedulers) setupReconcileAlertScheduler()
  if (startSchedulers) startAlertsEngine()
  if (startSchedulers) startScheduledReportsJob()
  if (startSchedulers) startBackupScheduler()
  if (startSchedulers) startCopilotRetentionJob()
  if (startSchedulers) startWarmCacheJob()

  return app
}
