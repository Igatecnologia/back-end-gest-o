import { Router } from 'express'
import { z } from 'zod'
import { getDb } from '../db/sqlite.js'
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js'

const preferencesSchema = z.object({
  theme: z.enum(['light', 'dark']).optional(),
  sidebarCollapsed: z.boolean().optional(),
  defaultDateRange: z.string().max(40).optional(),
  monthlyRevenueGoal: z.number().nonnegative().optional(),
  favoriteReports: z.array(z.string().max(120)).max(50).optional(),
  alertSubscriptions: z.array(z.string().max(80)).max(50).optional(),
  dashboardLayout: z.array(z.string().max(80)).max(40).optional(),
  /** Layout de widgets por pagina: { dashboard: ['a','b'], operacional: [...] } */
  pageLayouts: z.record(z.string().max(40), z.array(z.string().max(80)).max(40)).optional(),
})

export const userPreferencesRouter = Router()
userPreferencesRouter.use(requireAuth)
const db = getDb()

userPreferencesRouter.get('/me/preferences', (req, res) => {
  const authReq = req as AuthenticatedRequest
  const row = db
    .prepare('SELECT preferences_json FROM users WHERE id = ? LIMIT 1')
    .get(authReq.userId) as { preferences_json: string | null } | undefined
  const parsed = row?.preferences_json ? JSON.parse(row.preferences_json) : {}
  res.json(parsed)
})

userPreferencesRouter.put('/me/preferences', (req, res) => {
  const authReq = req as AuthenticatedRequest
  const parsed = preferencesSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Preferências inválidas' })
  }
  // Faz MERGE com as preferências existentes (patch parcial) — antes sobrescrevia
  // tudo e perdia theme/favoriteReports/etc ao salvar só layout.
  const row = db
    .prepare('SELECT preferences_json FROM users WHERE id = ? LIMIT 1')
    .get(authReq.userId) as { preferences_json: string | null } | undefined
  const current = row?.preferences_json ? (JSON.parse(row.preferences_json) as Record<string, unknown>) : {}
  const merged = {
    ...current,
    ...parsed.data,
    pageLayouts: {
      ...((current.pageLayouts as Record<string, string[]> | undefined) ?? {}),
      ...(parsed.data.pageLayouts ?? {}),
    },
  }
  db.prepare('UPDATE users SET preferences_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(merged),
    new Date().toISOString(),
    authReq.userId,
  )
  res.json(merged)
})
