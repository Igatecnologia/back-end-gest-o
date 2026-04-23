import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { readAll } from '../storage.js'
import { fetchProxyDataForTool } from './proxy.js'
import { resolveTenantId } from '../utils/tenant.js'

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

function getContasPagarDataSourceId(tenantId: string): string | null {
  const all = readAll().filter((d) => d.tenantId === tenantId)
  const match = all.find((d) => {
    const ep = normalizeDataEndpointPath(d.dataEndpoint)
    return ep.includes('/contas') || ep.includes('/pagar') || ep.includes('/pagos') || ep.includes('/titulos')
  })
  return match?.id ?? null
}

const contasPagarCache = new Map<string, { rows: Record<string, unknown>[]; expiresAt: number }>()

// GET /finance/contas-pagar — dados reais via proxy SGBR
financeRouter.get('/contas-pagar', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const dtDe = typeof req.query.dt_de === 'string' ? req.query.dt_de : ''
  const dtAte = typeof req.query.dt_ate === 'string' ? req.query.dt_ate : ''
  const dsId = getContasPagarDataSourceId(tenantId)
  if (!dsId) return res.json([])

  const cacheKey = `${tenantId}:${dsId}:${dtDe}:${dtAte}`
  const cached = contasPagarCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return res.json(cached.rows)

  const query: Record<string, string> = { requireDsId: '1' }
  if (dtDe) query.dt_de = dtDe
  if (dtAte) query.dt_ate = dtAte

  const result = await fetchProxyDataForTool({ tenantId, dsId, query })
  if (!result.ok) return res.json([])

  const rows = result.rows.filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object'))
  contasPagarCache.set(cacheKey, { rows, expiresAt: Date.now() + 15 * 60_000 })
  res.json(rows)
})

type EstoqueRawRow = Record<string, unknown>

function normalizeDataEndpointPath(ep: string | undefined): string {
  if (!ep) return ''
  let s = ep.trim()
  const q = s.indexOf('?')
  if (q >= 0) s = s.slice(0, q)
  const h = s.indexOf('#')
  if (h >= 0) s = s.slice(0, h)
  if (s.startsWith('http')) {
    try {
      s = new URL(s).pathname
    } catch {
      // mantém valor original
    }
  }
  return s.toLowerCase()
}

function getEstoqueDataSourceId(tenantId: string): string | null {
  const all = readAll().filter((d) => d.tenantId === tenantId)
  const byArea = all.find((d) => (d.erpEndpoints ?? []).includes('estoque'))
  if (byArea?.id) return byArea.id
  const byEndpoint = all.find((d) => normalizeDataEndpointPath(d.dataEndpoint).includes('/sgbrbi/estoque'))
  return byEndpoint?.id ?? null
}

function pickRaw(row: EstoqueRawRow, keys: string[]): unknown {
  for (const k of keys) {
    if (k in row && row[k] !== undefined && row[k] !== null) return row[k]
  }
  const lowerMap = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]))
  for (const k of keys) {
    const rk = lowerMap.get(k.toLowerCase())
    if (rk !== undefined && row[rk] !== undefined && row[rk] !== null) return row[rk]
  }
  return undefined
}

function asText(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v.trim() || fallback
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return fallback
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string') return fallback
  const s = v.trim()
  if (!s) return fallback
  const normalized = s.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(normalized)
  return Number.isFinite(n) ? n : fallback
}

function estoqueStatus(qtdeAtual: number, qtdeMinima: number): 'Normal' | 'Baixo' | 'Crítico' {
  if (qtdeAtual <= 0 || (qtdeMinima > 0 && qtdeAtual <= qtdeMinima * 0.5)) return 'Crítico'
  if (qtdeMinima > 0 && qtdeAtual <= qtdeMinima) return 'Baixo'
  return 'Normal'
}

function isoDateOrToday(v: unknown): string {
  const s = asText(v)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  if (/^\d{4}\.\d{2}\.\d{2}/.test(s)) return s.slice(0, 10).replace(/\./g, '-')
  return new Date().toISOString().slice(0, 10)
}

/* Campos SGBR → campos internos (inclui variantes comuns) */
const ID_KEYS = ['id', 'codigo', 'codprod', 'cod', 'controle', 'codproduto']
const MATERIAL_KEYS = ['material', 'materia_prima', 'insumo', 'item', 'produto', 'descricao', 'descprod', 'nomeproduto']
const TIPO_KEYS = ['tipo', 'categoria', 'nivel', 'classe', 'grupo', 'subgrupo', 'referencia']
const QTD_KEYS = ['qtdeatual', 'qtde_atual', 'saldo', 'quantidade', 'qtd', 'qtde', 'estoque']
const QTD_MIN_KEYS = ['qtdeminima', 'qtde_minima', 'estoque_minimo', 'minimo']
const CUSTO_UNIT_KEYS = ['custounitario', 'custo_unitario', 'valorcusto', 'preco_custo', 'precocusto', 'valor_custo']
const CUSTO_TOTAL_KEYS = ['custototal', 'custo_total', 'valor_total_custo']
const PRECO_VENDA_KEYS = ['precovenda', 'preco_venda', 'valorvenda', 'valor_venda']
const DATA_KEYS = ['ultimaentrada', 'ultima_entrada', 'dataentrada', 'dataultimacompra', 'data_ultima_compra', 'data']
const UNIDADE_KEYS = ['unidade', 'und', 'un']
const FORNECEDOR_KEYS = ['fornecedor', 'nomefornecedor', 'nome_fornecedor']

/** Custo total do estoque: qtde positiva × preço custo. Negativo = 0 (sem valor em estoque). */
function calcCustoTotal(row: EstoqueRawRow, qtde: number, custoUnit: number): number {
  const explicit = asNumber(pickRaw(row, CUSTO_TOTAL_KEYS), 0)
  if (explicit > 0) return explicit
  if (qtde <= 0) return 0
  return Math.round(qtde * custoUnit * 100) / 100
}

/**
 * Classifica item pelo campo `grupo` da API SGBR.
 * Valores reais: "MATERIA PRIMA", "INSUMO", "PRODUTO BASE", "PRODUTO FINAL", "" / null.
 */
function classifyEstoqueItem(row: EstoqueRawRow): 'materia-prima' | 'espuma' | 'aglomerado' | 'produto-final' | 'outro' {
  const grupo = asText(pickRaw(row, ['grupo'])).toUpperCase().trim()
  const produto = asText(pickRaw(row, MATERIAL_KEYS)).toUpperCase()

  if (grupo === 'MATERIA PRIMA' || grupo === 'INSUMO') return 'materia-prima'

  if (grupo === 'PRODUTO BASE') {
    if (/AGLOMERADO/i.test(produto)) return 'aglomerado'
    return 'espuma'
  }

  if (grupo === 'PRODUTO FINAL') return 'produto-final'

  /* Sem grupo — classifica pelo nome do produto */
  if (/AGLOMERADO/i.test(produto)) return 'aglomerado'
  if (/ESPUMA|EUROPA|BLOCO/i.test(produto)) return 'espuma'

  return 'outro'
}

/**
 * Cache in-memory do estoque — evita 3 chamadas SGBR idênticas (uma por aba).
 * TTL 3 min: a API SGBR leva ~20s, sem cache cada aba dispara uma nova.
 */
const estoqueCache = new Map<string, { rows: EstoqueRawRow[]; expiresAt: number }>()

async function loadEstoqueRows(tenantId: string): Promise<EstoqueRawRow[]> {
  const dsId = getEstoqueDataSourceId(tenantId)
  if (!dsId) return []

  const cacheKey = `${tenantId}:${dsId}`
  const cached = estoqueCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return cached.rows

  const result = await fetchProxyDataForTool({
    tenantId,
    dsId,
    query: { requireDsId: '1' },
  })
  if (!result.ok) return []
  const rows = result.rows.filter((r): r is EstoqueRawRow => Boolean(r && typeof r === 'object'))
  estoqueCache.set(cacheKey, { rows, expiresAt: Date.now() + 15 * 60_000 })
  return rows
}

// GET /finance/estoque-materia-prima
financeRouter.get('/estoque-materia-prima', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const rows = await loadEstoqueRows(tenantId)
  const mapped = rows
    .map((row) => {
      const cls = classifyEstoqueItem(row)
      if (cls !== 'materia-prima' && cls !== 'outro') return null
      const material = asText(pickRaw(row, MATERIAL_KEYS))
      if (!material) return null
      const qtdeAtual = asNumber(pickRaw(row, QTD_KEYS), 0)
      const qtdeMinima = asNumber(pickRaw(row, QTD_MIN_KEYS), 0)
      const custoUnitario = asNumber(pickRaw(row, CUSTO_UNIT_KEYS), 0)
      const custoTotal = calcCustoTotal(row, qtdeAtual, custoUnitario)
      return {
        id: asText(pickRaw(row, ID_KEYS), `mp_${randomBytes(4).toString('hex')}`),
        material,
        unidade: asText(pickRaw(row, UNIDADE_KEYS), 'UN'),
        qtdeAtual,
        qtdeMinima,
        custoUnitario,
        custoTotal,
        ultimaEntrada: isoDateOrToday(pickRaw(row, DATA_KEYS)),
        fornecedor: asText(pickRaw(row, FORNECEDOR_KEYS), 'Não informado'),
        status: estoqueStatus(qtdeAtual, qtdeMinima),
        detalhes: row,
      }
    })
    .filter(Boolean)
  res.json(mapped)
})

// GET /finance/estoque-espuma
financeRouter.get('/estoque-espuma', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const rows = await loadEstoqueRows(tenantId)
  const mapped = rows
    .map((row) => {
      const cls = classifyEstoqueItem(row)
      if (cls !== 'espuma' && cls !== 'aglomerado') return null
      const produto = asText(pickRaw(row, MATERIAL_KEYS))
      if (!produto) return null
      const tipo: 'Espuma' | 'Aglomerado' = cls === 'aglomerado' ? 'Aglomerado' : 'Espuma'
      const qtdeAtual = asNumber(pickRaw(row, QTD_KEYS), 0)
      const qtdeMinima = asNumber(pickRaw(row, QTD_MIN_KEYS), 0)
      const custoUnitario = asNumber(pickRaw(row, CUSTO_UNIT_KEYS), 0)
      const custoTotal = calcCustoTotal(row, qtdeAtual, custoUnitario)
      return {
        id: asText(pickRaw(row, ID_KEYS), `es_${randomBytes(4).toString('hex')}`),
        produto,
        tipo,
        densidade: asText(pickRaw(row, ['densidade', 'dens', 'densid']), '-'),
        unidade: asText(pickRaw(row, UNIDADE_KEYS), 'UN'),
        qtdeAtual,
        qtdeMinima,
        custoUnitario,
        custoTotal,
        ultimaEntrada: isoDateOrToday(pickRaw(row, DATA_KEYS)),
        status: estoqueStatus(qtdeAtual, qtdeMinima),
        detalhes: row,
      }
    })
    .filter(Boolean)
  res.json(mapped)
})

// GET /finance/estoque-produto-final
financeRouter.get('/estoque-produto-final', async (req, res) => {
  const tenantId = resolveTenantId(req)
  const rows = await loadEstoqueRows(tenantId)
  const mapped = rows
    .map((row) => {
      const cls = classifyEstoqueItem(row)
      if (cls !== 'produto-final') return null
      const produto = asText(pickRaw(row, MATERIAL_KEYS))
      if (!produto) return null
      const tipo: 'Espuma' | 'Aglomerado' = /aglomerado/i.test(produto) ? 'Aglomerado' : 'Espuma'
      const qtdeAtual = asNumber(pickRaw(row, QTD_KEYS), 0)
      const qtdeMinima = asNumber(pickRaw(row, QTD_MIN_KEYS), 0)
      const custoUnitario = asNumber(pickRaw(row, CUSTO_UNIT_KEYS), 0)
      const custoTotal = calcCustoTotal(row, qtdeAtual, custoUnitario)
      const precoVenda = asNumber(pickRaw(row, PRECO_VENDA_KEYS), 0)
      return {
        id: asText(pickRaw(row, ID_KEYS), `pf_${randomBytes(4).toString('hex')}`),
        produto,
        tipo,
        densidade: asText(pickRaw(row, ['densidade', 'dens', 'densid']), '-'),
        dimensoes: asText(pickRaw(row, ['dimensoes', 'dimensao', 'medidas']), '-'),
        unidade: asText(pickRaw(row, UNIDADE_KEYS), 'UN'),
        qtdeAtual,
        qtdeMinima,
        custoUnitario,
        custoTotal,
        precoVenda,
        ultimaEntrada: isoDateOrToday(pickRaw(row, DATA_KEYS)),
        status: estoqueStatus(qtdeAtual, qtdeMinima),
        detalhes: row,
      }
    })
    .filter(Boolean)
  res.json(mapped)
})

