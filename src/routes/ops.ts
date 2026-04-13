import { Router } from 'express'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireAdmin } from '../middleware/auth.js'
import { getProxyOperationalSnapshot } from './proxy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const opsRouter = Router()

/**
 * GET /api/v1/ops/status
 * Painel unico de saude (proxy + storage) — apenas admin autenticado.
 */
opsRouter.get('/status', requireAdmin, (_req, res) => {
  const dataDir = join(__dirname, '..', '..', 'data')
  res.json({
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    storage: {
      users: existsSync(join(dataDir, 'users.json')),
      datasources: existsSync(join(dataDir, 'datasources.json')),
    },
    proxy: getProxyOperationalSnapshot(),
  })
})
