import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { getDb } from '../db/sqlite.js'
import { readAll } from '../storage.js'
import { resolveTenantId } from '../utils/tenant.js'

export const alertsRouter = Router()
alertsRouter.use(requireAuth)

type AlertLevel = 'info' | 'warning' | 'error'
type LiveClient = {
  tenantId: string
  send: (payload: unknown) => void
}

const clients = new Set<LiveClient>()
const db = getDb()

function pushAlert(tenantId: string, type: string, severity: AlertLevel, title: string, message: string) {
  const id = `alrt_${randomBytes(5).toString('hex')}`
  const createdAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO alerts (id, tenant_id, type, severity, title, message, created_at, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(id, tenantId, type, severity, title, message, createdAt)
  const payload = { id, tenantId, type, severity, title, message, createdAt, readAt: null }
  for (const client of clients) {
    if (client.tenantId === tenantId) client.send(payload)
  }
}

function mapRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    type: String(row.type),
    severity: String(row.severity),
    title: String(row.title),
    message: String(row.message),
    createdAt: String(row.created_at),
    readAt: row.read_at ? String(row.read_at) : null,
  }
}

alertsRouter.get('/', (req, res) => {
  const tenantId = resolveTenantId(req)
  let rows = db
    .prepare('SELECT * FROM alerts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(tenantId) as Record<string, unknown>[]
  if (rows.length === 0) {
    pushAlert(
      tenantId,
      'system_status',
      'info',
      'Monitoramento ativo',
      'Sem alertas críticos no momento. O acompanhamento do sistema está ativo.',
    )
    rows = db
      .prepare('SELECT * FROM alerts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(tenantId) as Record<string, unknown>[]
  }
  res.json(rows.map(mapRow))
})

alertsRouter.post('/:id/read', (req, res) => {
  const tenantId = resolveTenantId(req)
  db.prepare('UPDATE alerts SET read_at = ? WHERE id = ? AND tenant_id = ?').run(
    new Date().toISOString(),
    req.params.id,
    tenantId,
  )
  res.json({ ok: true })
})

alertsRouter.get('/stream', (req, res) => {
  const tenantId = resolveTenantId(req)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  const send = (payload: unknown) => {
    res.write(`event: alert\n`)
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n')
  }, 25_000)

  const client: LiveClient = { tenantId, send }
  clients.add(client)
  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(client)
  })
})

let alertsEngineTimer: NodeJS.Timeout | null = null
export function startAlertsEngine() {
  if (alertsEngineTimer) return
  alertsEngineTimer = setInterval(() => {
    const all = readAll()
    const checkedTenants = new Set<string>()
    for (const ds of all) {
      checkedTenants.add(ds.tenantId)
      if (ds.status === 'error' || ds.lastError) {
        pushAlert(
          ds.tenantId,
          'proxy_error',
          'error',
          'Falha em fonte de dados',
          `${ds.name}: ${ds.lastError ?? 'erro de conexão'}`,
        )
      }
    }
    for (const tenantId of checkedTenants) {
      const unread = Number(
        (
          db.prepare('SELECT COUNT(*) AS total FROM alerts WHERE tenant_id = ? AND read_at IS NULL').get(
            tenantId,
          ) as { total: number }
        ).total ?? 0,
      )
      if (unread > 12) {
        pushAlert(
          tenantId,
          'alert_volume',
          'warning',
          'Muitos alertas não lidos',
          `Existem ${unread} alertas pendentes de leitura.`,
        )
      }
    }
  }, 5 * 60_000)
}

export function createSystemAlert(
  tenantId: string,
  type: string,
  severity: AlertLevel,
  title: string,
  message: string,
) {
  pushAlert(tenantId, type, severity, title, message)
}
