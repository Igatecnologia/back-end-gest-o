import { Router } from 'express'
import { getDb } from '../db/sqlite.js'

export const auditRouter = Router()

const db = getDb()

/**
 * GET /audit?limit=50&offset=0&action=login_failed
 * Lista eventos de audit log com paginação e filtro opcional por action.
 */
auditRouter.get('/', (req, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 500)
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0)
  const action = typeof req.query.action === 'string' ? req.query.action.trim() : undefined

  let rows: unknown[]
  let total: number

  if (action) {
    rows = db.prepare(
      'SELECT * FROM audit_log WHERE action = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(action, limit, offset)
    total = (db.prepare('SELECT COUNT(*) AS total FROM audit_log WHERE action = ?').get(action) as { total: number }).total
  } else {
    rows = db.prepare(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?',
    ).all(limit, offset)
    total = (db.prepare('SELECT COUNT(*) AS total FROM audit_log').get() as { total: number }).total
  }

  res.json({ total, limit, offset, rows })
})
