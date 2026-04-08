import { Router } from 'express'

export const financeRouter = Router()

// GET /finance — visão geral
financeRouter.get('/', (_req, res) => {
  res.json({
    receita: 0,
    custos: 0,
    lucro: 0,
    margemPct: 0,
    monthlyFlow: [],
    entries: [],
  })
})

// GET /finance/conciliacao
financeRouter.get('/conciliacao', (_req, res) => res.json([]))

// GET /finance/contas-pagar
financeRouter.get('/contas-pagar', (_req, res) => res.json([]))

// GET /finance/contas-receber
financeRouter.get('/contas-receber', (_req, res) => res.json([]))

// GET /finance/estoque-materia-prima
financeRouter.get('/estoque-materia-prima', (_req, res) => res.json([]))

// GET /finance/estoque-espuma
financeRouter.get('/estoque-espuma', (_req, res) => res.json([]))

// GET /finance/estoque-produto-final
financeRouter.get('/estoque-produto-final', (_req, res) => res.json([]))

// GET /finance/vendas-espuma
financeRouter.get('/vendas-espuma', (_req, res) => res.json([]))
