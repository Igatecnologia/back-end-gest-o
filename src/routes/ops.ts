import { Router } from 'express'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireAdmin } from '../middleware/auth.js'
import { getProxyOperationalSnapshot } from './proxy.js'
import { z } from 'zod'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const opsRouter = Router()

const clientErrorSchema = z.object({
  message: z.string().min(1).max(500),
  stack: z.string().max(6000).optional(),
  component: z.string().max(200).optional(),
  action: z.string().max(200).optional(),
  userId: z.string().max(120).optional(),
  tenantId: z.string().max(120).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().max(80).optional(),
  url: z.string().max(1000).optional(),
  userAgent: z.string().max(600).optional(),
})

/**
 * GET /api/v1/ops/status
 * Painel unico de saude (proxy + storage) — apenas admin autenticado.
 */
opsRouter.get('/status', requireAdmin, (_req, res) => {
  const dataDir = process.env.IGA_DATA_DIR?.trim() || join(__dirname, '..', '..', 'data')
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

/**
 * POST /api/v1/ops/client-error
 * Recebe erros de frontend para trilha de suporte e investigação.
 */
opsRouter.post('/client-error', (req, res) => {
  const parsed = clientErrorSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: 'Payload inválido' })
  }
  const logDir = join(__dirname, '..', '..', 'logs')
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const logFile = join(logDir, `client-errors-${date}.log`)
  appendFileSync(logFile, `${JSON.stringify({ ...parsed.data, serverAt: new Date().toISOString() })}\n`, 'utf8')
  return res.json({ ok: true })
})
