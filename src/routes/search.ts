import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { getDb } from '../db/sqlite.js'

export const searchRouter = Router()
searchRouter.use(requireAuth)
const db = getDb()

const APP_PAGES = [
  { id: 'pg_dashboard', category: 'pages', title: 'Dashboard', subtitle: '/dashboard', route: '/dashboard' },
  { id: 'pg_vendas', category: 'pages', title: 'Vendas Analítico', subtitle: '/dashboard/vendas-analitico', route: '/dashboard/vendas-analitico' },
  { id: 'pg_financeiro', category: 'pages', title: 'Financeiro', subtitle: '/financeiro', route: '/financeiro' },
  { id: 'pg_relatorios', category: 'pages', title: 'Relatórios', subtitle: '/relatorios', route: '/relatorios' },
  { id: 'pg_alertas', category: 'pages', title: 'Alertas', subtitle: '/alertas', route: '/alertas' },
]

searchRouter.get('/', (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase()
  if (!q) {
    return res.json(APP_PAGES.slice(0, 8))
  }

  const users = db
    .prepare(`
      SELECT id, name, email FROM users
      WHERE lower(name) LIKE ? OR lower(email) LIKE ?
      LIMIT 6
    `)
    .all(`%${q}%`, `%${q}%`) as Array<{ id: string; name: string; email: string }>

  const dataSources = db
    .prepare(`
      SELECT id, name, tenant_id FROM datasources
      WHERE lower(name) LIKE ? OR lower(tenant_id) LIKE ?
      LIMIT 6
    `)
    .all(`%${q}%`, `%${q}%`) as Array<{ id: string; name: string; tenant_id: string }>

  const alerts = db
    .prepare(`
      SELECT id, title, message FROM alerts
      WHERE lower(title) LIKE ? OR lower(message) LIKE ?
      ORDER BY created_at DESC
      LIMIT 6
    `)
    .all(`%${q}%`, `%${q}%`) as Array<{ id: string; title: string; message: string }>

  const pages = APP_PAGES.filter((item) =>
    item.title.toLowerCase().includes(q) || item.subtitle.toLowerCase().includes(q),
  )

  const payload = [
    ...pages,
    ...users.map((u) => ({
      id: `usr_${u.id}`,
      category: 'users',
      title: u.name,
      subtitle: u.email,
      route: '/usuarios',
    })),
    ...dataSources.map((d) => ({
      id: `ds_${d.id}`,
      category: 'datasources',
      title: d.name,
      subtitle: `Tenant: ${d.tenant_id}`,
      route: '/fontes-de-dados',
    })),
    ...alerts.map((a) => ({
      id: `al_${a.id}`,
      category: 'alerts',
      title: a.title,
      subtitle: a.message,
      route: '/alertas',
    })),
  ]

  return res.json(payload.slice(0, 30))
})
