import { Router } from 'express'

export const reportsRouter = Router()

reportsRouter.get('/', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.max(1, Number(req.query.pageSize) || 8)

  res.json({
    items: [],
    total: 0,
    page,
    pageSize,
  })
})
