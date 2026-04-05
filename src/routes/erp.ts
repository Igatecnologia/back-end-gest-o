import { Router } from 'express'

export const erpRouter = Router()

// GET /erp/compras-materia-prima
erpRouter.get('/compras-materia-prima', (_req, res) => res.json([]))

// GET /erp/lotes-producao
erpRouter.get('/lotes-producao', (_req, res) => res.json([]))

// GET /erp/fichas-tecnicas
erpRouter.get('/fichas-tecnicas', (_req, res) => res.json([]))

// GET /erp/pedidos
erpRouter.get('/pedidos', (_req, res) => res.json([]))

// GET /erp/ordens-producao
erpRouter.get('/ordens-producao', (_req, res) => res.json([]))

// GET /erp/faturamentos
erpRouter.get('/faturamentos', (_req, res) => res.json([]))

// GET /erp/movimentos-estoque
erpRouter.get('/movimentos-estoque', (_req, res) => res.json([]))

// GET /erp/custo-real
erpRouter.get('/custo-real', (_req, res) => res.json([]))

// GET /erp/alertas
erpRouter.get('/alertas', (_req, res) => res.json([]))
