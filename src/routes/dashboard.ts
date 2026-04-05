import { Router } from 'express'

export const dashboardRouter = Router()

dashboardRouter.get('/', (_req, res) => {
  res.json({
    kpis: [],
    sales: [],
    revenue: [],
    heatmap: [],
    latest: [],
  })
})
