import { Router } from 'express'
import { readAll } from '../storage.js'
import { fetchProxyDataForTool } from './proxy.js'
import { resolveTenantId } from '../utils/tenant.js'

export const erpRouter = Router()

/* ── Helpers ── */

function asText(v: unknown, fb = ''): string {
  if (typeof v === 'string') return v.trim() || fb
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return fb
}

function asNumber(v: unknown, fb = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return fb
}

function normalizeEndpoint(ep: string | undefined): string {
  if (!ep) return ''
  let s = ep.trim()
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q)
  return s.toLowerCase()
}

/* ── Cache para dados combinados (estoque + produzido) ── */

type CachedRows = { rows: Record<string, unknown>[]; expiresAt: number }
const estoqueCache = new Map<string, CachedRows>()
const produzidoCache = new Map<string, CachedRows>()

function findDsId(tenantId: string, hint: string): string | null {
  const all = readAll().filter((d) => d.tenantId === tenantId)
  return all.find((d) => normalizeEndpoint(d.dataEndpoint).includes(hint))?.id ?? null
}

async function loadCachedProxy(
  tenantId: string,
  hint: string,
  cache: Map<string, CachedRows>,
  extraQuery?: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const dsId = findDsId(tenantId, hint)
  if (!dsId) return []
  const key = `${tenantId}:${dsId}`
  const cached = cache.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.rows
  const result = await fetchProxyDataForTool({
    tenantId,
    dsId,
    query: { requireDsId: '1', ...extraQuery },
  })
  if (!result.ok) return []
  const rows = result.rows.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
  cache.set(key, { rows, expiresAt: Date.now() + 15 * 60_000 })
  return rows
}

/* ══════════════════════════════════════════════════════════
   GET /erp/fichas-tecnicas — Dados reais: estoque + produzido
   ══════════════════════════════════════���═══════════════════ */

erpRouter.get('/fichas-tecnicas', async (req, res) => {
  const tenantId = resolveTenantId(req)

  const [estoqueRows, produzidoRows] = await Promise.all([
    loadCachedProxy(tenantId, '/sgbrbi/estoque', estoqueCache),
    loadCachedProxy(tenantId, '/sgbrbi/produzido', produzidoCache, {
      dt_de: formatSgbrDate(sixMonthsAgo()),
      dt_ate: formatSgbrDate(new Date()),
    }),
  ])

  if (estoqueRows.length === 0) {
    return res.json([])
  }

  /* Mapa codproduto → componentes (do produzido) */
  const compMap = new Map<number, { codprodcomp: number; nomeprodutocomp: string; qtdeunitaria: number; undcomp: string }[]>()
  for (const pr of produzidoRows) {
    const cod = asNumber(pr.codproduto)
    if (!cod) continue
    const comps = Array.isArray(pr.componentes) ? pr.componentes as { codprodcomp: number; nomeprodutocomp: string; qtdeunitaria: number; undcomp: string }[] : []
    if (comps.length > 0 && !compMap.has(cod)) {
      compMap.set(cod, comps)
    }
  }

  /* Filtrar apenas produtos (PRODUTO BASE + PRODUTO FINAL) */
  const fichas = estoqueRows
    .filter((r) => {
      const grupo = asText(r.grupo).toUpperCase()
      const produto = asText(r.produto).toUpperCase()
      return grupo === 'PRODUTO BASE' || grupo === 'PRODUTO FINAL' ||
        /ESPUMA|AGLOMERADO|BLOCO|EUROPA/.test(produto)
    })
    .map((r) => {
      const cod = asNumber(r.controle)
      const produto = asText(r.produto)
      const precocusto = asNumber(r.precocusto)
      const precovenda = asNumber(r.precovenda)
      const grupo = asText(r.grupo)
      const componentes = compMap.get(cod) ?? []
      const consumoM3 = componentes.reduce((s, c) => s + asNumber(c.qtdeunitaria), 0)
      const margem = precovenda > 0 && precocusto > 0
        ? Math.round(((precovenda - precocusto) / precovenda) * 1000) / 10
        : 0

      const tipo: 'Espuma' | 'Aglomerado' = /aglomerado/i.test(produto) ? 'Aglomerado' : 'Espuma'

      return {
        id: `FT-${cod}`,
        produto,
        tipo,
        densidade: '-',
        alturaM: 0,
        larguraM: 0,
        comprimentoM: 0,
        volumeM3: consumoM3,
        pesoEstimadoKg: 0,
        consumoMateriaPrimaKg: 0,
        custoMateriaPrima: precocusto,
        custoConversao: 0,
        custoEstimado: precocusto,
        custoPorM3: consumoM3 > 0 ? Math.round(precocusto / consumoM3 * 100) / 100 : 0,
        precoSugerido: precovenda,
        margemAlvoPct: margem,
        ativo: asText(r.ativo) === 'SIM',
        /* Campos extras para o frontend novo */
        grupo,
        unidade: asText(r.unidade, 'UN'),
        precocusto,
        precovenda,
        componentes: componentes.map((c) => ({
          codigo: c.codprodcomp,
          nome: c.nomeprodutocomp,
          consumoUnitario: c.qtdeunitaria,
          unidade: c.undcomp,
        })),
      }
    })

  res.json(fichas)
})

/* ══════════════════════════════════════════════════════════
   GET /erp/producao-diaria — Produção com data real por produto
   Consulta dia a dia (max 14 dias) para saber QUANDO cada produto foi produzido.
   ══════════════════════════════════════════════════════════ */

const producaoDiariaCache = new Map<string, CachedRows>()

erpRouter.get('/producao-diaria', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const dtDe = typeof req.query.dt_de === 'string' ? req.query.dt_de : formatSgbrDate(thirtyDaysAgo())
  const dtAte = typeof req.query.dt_ate === 'string' ? req.query.dt_ate : formatSgbrDate(new Date())

  const dsId = findDsId(tenantId, '/sgbrbi/produzido')
  if (!dsId) return res.json({ rows: [], truncated: false, periodoReal: { de: dtDe, ate: dtAte } })

  const cacheKey = `${tenantId}:${dsId}:${dtDe}:${dtAte}`
  const cached = producaoDiariaCache.get(cacheKey)

  let rawRows: Record<string, unknown>[]
  let truncated = false

  if (cached && Date.now() < cached.expiresAt) {
    rawRows = cached.rows
  } else {
    const result = await fetchProxyDataForTool({
      tenantId,
      dsId,
      query: { requireDsId: '1', dt_de: dtDe, dt_ate: dtAte },
    })
    rawRows = result.ok
      ? result.rows.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
      : []
    truncated = result.ok ? result.truncated : false
    producaoDiariaCache.set(cacheKey, { rows: rawRows, expiresAt: Date.now() + 15 * 60_000 })
  }

  type ProdRow = { codproduto: number; produto: string; qtdeproduzida: number; unidade: string; componentes: unknown[]; data: string }
  const allRows: ProdRow[] = []

  for (const r of rawRows) {
    const dataRaw = asText(r.data || r.datafec || r.dataproducao || r.dt_producao || r.data_producao)
    const data = dataRaw.includes('T') ? dataRaw.slice(0, 10) : dataRaw.replace(/\./g, '-').slice(0, 10)
    allRows.push({
      codproduto: asNumber(r.codproduto),
      produto: asText(r.produto || r.nome_produto || r.nomeproduto || r.descricao),
      qtdeproduzida: asNumber(r.qtdeproduzida || r.quantidade || r.qtde || r.qtd),
      unidade: asText(r.unidade || r.und, 'UN'),
      componentes: Array.isArray(r.componentes) ? r.componentes : [],
      data: data || dtDe.replace(/\./g, '-'),
    })
  }

  res.json({
    rows: allRows,
    truncated,
    periodoReal: {
      de: dtDe.replace(/\./g, '-'),
      ate: dtAte.replace(/\./g, '-'),
    },
  })
})

/* ══════════════════════════════════════════════════════════
   GET /erp/vendas-sgbr — Vendas reais do vendas/analitico
   ══════════════════════════════════════════════════════════ */

erpRouter.get('/vendas-sgbr', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const dtDe = typeof req.query.dt_de === 'string' ? req.query.dt_de : formatSgbrDate(thirtyDaysAgo())
  const dtAte = typeof req.query.dt_ate === 'string' ? req.query.dt_ate : formatSgbrDate(new Date())

  const dsId = findDsId(tenantId, '/sgbrbi/vendas')
  if (!dsId) return res.json([])

  const result = await fetchProxyDataForTool({
    tenantId,
    dsId,
    query: { requireDsId: '1', dt_de: dtDe, dt_ate: dtAte },
  })
  if (!result.ok) return res.json([])

  const rows = result.rows
    .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
    .map((r) => ({
      data: asText(r.datafec) || asText(r.data),
      codProduto: asNumber(r.codprod),
      produto: asText(r.decprod),
      qtde: asNumber(r.qtdevendida),
      unidade: asText(r.und, 'UN'),
      valorUnit: asNumber(r.valorunit),
      total: asNumber(r.total),
      custoProduto: asNumber(r.precocustoitem),
      codCliente: asNumber(r.codcliente),
      cliente: asText(r.nomecliente),
      codVendedor: asNumber(r.codvendedor),
      vendedor: asText(r.nomevendedor),
      status: asText(r.statuspedido),
    }))

  res.json(rows)
})

/* ── Date helpers ── */

function sixMonthsAgo(): Date {
  const d = new Date()
  d.setMonth(d.getMonth() - 6)
  return d
}

function thirtyDaysAgo(): Date {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d
}

function formatSgbrDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '.')
}

/* ── Endpoints ERP adicionais ── */

/* ══════════════════════════════════════════════════════════
   GET /erp/compras-materia-prima — Dados reais via proxy /sgbrbi/compras
   Query: dt_de, dt_ate (formato YYYY.MM.DD)
   ══════════════════════════════════════════════════════════ */
const comprasCache = new Map<string, CachedRows>()

erpRouter.get('/compras-materia-prima', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const dtDe = typeof req.query.dt_de === 'string' ? req.query.dt_de : formatSgbrDate(thirtyDaysAgo())
  const dtAte = typeof req.query.dt_ate === 'string' ? req.query.dt_ate : formatSgbrDate(new Date())

  const dsId = findDsId(tenantId, '/sgbrbi/compras')
  if (!dsId) {
    return res.json({ rows: [], truncated: false, periodoReal: { de: dtDe, ate: dtAte } })
  }

  const cacheKey = `${tenantId}:${dsId}:${dtDe}:${dtAte}`
  const cached = comprasCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return res.json({ rows: cached.rows, truncated: false, periodoReal: { de: dtDe, ate: dtAte } })
  }

  const result = await fetchProxyDataForTool({
    tenantId,
    dsId,
    query: { dt_de: dtDe, dt_ate: dtAte, requireDsId: '1' },
  })

  if (!result.ok) {
    return res.json({ rows: [], truncated: false, periodoReal: { de: dtDe, ate: dtAte } })
  }

  const rows = result.rows.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
  comprasCache.set(cacheKey, { rows, expiresAt: Date.now() + 15 * 60_000 })

  res.json({
    rows,
    truncated: result.truncated,
    periodoReal: { de: dtDe, ate: dtAte },
  })
})

// GET /erp/lotes-producao
erpRouter.get('/lotes-producao', (_req, res) => res.json([]))

// GET /erp/pedidos
erpRouter.get('/pedidos', (_req, res) => res.json([]))

// GET /erp/ordens-producao
erpRouter.get('/ordens-producao', (_req, res) => res.json([]))

/* GET /erp/faturamentos — Notas fiscais via proxy SGBR (vendanfe ou notasfiscais) */
const faturamentosCache = new Map<string, CachedRows>()
erpRouter.get('/faturamentos', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const dtDe = typeof req.query.dt_de === 'string' ? req.query.dt_de : formatSgbrDate(thirtyDaysAgo())
  const dtAte = typeof req.query.dt_ate === 'string' ? req.query.dt_ate : formatSgbrDate(new Date())

  // Procura fonte de notas fiscais (vendanfe, notasfiscais, etc.)
  const dsId = findDsId(tenantId, '/sgbrbi/vendanfe') ?? findDsId(tenantId, '/sgbrbi/notasfiscais') ?? findDsId(tenantId, '/sgbrbi/notafiscal')
  if (!dsId) return res.json([])

  const cacheKey = `${tenantId}:${dsId}:${dtDe}:${dtAte}`
  const cached = faturamentosCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return res.json(cached.rows)

  const result = await fetchProxyDataForTool({
    tenantId,
    dsId,
    query: { dt_de: dtDe, dt_ate: dtAte, requireDsId: '1' },
  })
  if (!result.ok) return res.json([])

  const rows = result.rows.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
  faturamentosCache.set(cacheKey, { rows, expiresAt: Date.now() + 15 * 60_000 })
  res.json(rows)
})

// GET /erp/movimentos-estoque
erpRouter.get('/movimentos-estoque', (_req, res) => res.json([]))

// GET /erp/custo-real
erpRouter.get('/custo-real', (_req, res) => res.json([]))

// GET /erp/alertas
erpRouter.get('/alertas', (_req, res) => res.json([]))
