import { Router } from 'express'

export const auditRouter = Router()

auditRouter.get('/', (_req, res) => {
  res.json([])
})
