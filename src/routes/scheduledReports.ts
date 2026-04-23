import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import { requireAuth } from '../middleware/auth.js'
import { getDb } from '../db/sqlite.js'

const db = getDb()
export const scheduledReportsRouter = Router()
scheduledReportsRouter.use(requireAuth)

const schema = z.object({
  name: z.string().min(1).max(120),
  reportType: z.string().min(1).max(80),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  cronExpr: z.string().min(5).max(120),
  recipients: z.array(z.string().email()).min(1).max(30),
  format: z.enum(['pdf', 'excel']),
  active: z.boolean().optional(),
})

scheduledReportsRouter.get('/', (req, res) => {
  const authReq = req as unknown as AuthenticatedRequest
  const rows = db
    .prepare('SELECT * FROM scheduled_reports WHERE user_id = ? ORDER BY updated_at DESC')
    .all(authReq.userId) as Record<string, unknown>[]
  res.json(
    rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      reportType: String(r.report_type),
      frequency: String(r.frequency),
      cronExpr: String(r.cron_expr),
      recipients: JSON.parse(String(r.recipients_json ?? '[]')) as string[],
      format: String(r.format),
      active: Number(r.active ?? 0) === 1,
      lastSentAt: r.last_sent_at ? String(r.last_sent_at) : null,
    })),
  )
})

scheduledReportsRouter.post('/', (req, res) => {
  const authReq = req as unknown as AuthenticatedRequest
  const parsed = schema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Payload inválido' })
  }
  const now = new Date().toISOString()
  const id = `sch_${randomBytes(5).toString('hex')}`
  db.prepare(`
    INSERT INTO scheduled_reports (
      id, user_id, name, report_type, frequency, cron_expr, recipients_json, format, active, last_sent_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    authReq.userId,
    parsed.data.name,
    parsed.data.reportType,
    parsed.data.frequency,
    parsed.data.cronExpr,
    JSON.stringify(parsed.data.recipients),
    parsed.data.format,
    parsed.data.active === false ? 0 : 1,
    now,
    now,
  )
  res.status(201).json({ id, ...parsed.data, active: parsed.data.active !== false })
})

scheduledReportsRouter.delete('/:id', (req, res) => {
  const authReq = req as unknown as AuthenticatedRequest
  db.prepare('DELETE FROM scheduled_reports WHERE id = ? AND user_id = ?').run(req.params.id, authReq.userId)
  res.json({ ok: true })
})
