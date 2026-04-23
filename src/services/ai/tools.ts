import { getDb } from '../../db/sqlite.js'
import { readAll as readAllDataSources, type DataSource } from '../../storage.js'
import { fetchProxyDataForTool, getProxyOperationalSnapshot } from '../../routes/proxy.js'
import type { ToolDefinition } from './types.js'

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_overview',
    description: 'Visão geral: totais de usuários, fontes e alertas. Use para resumos ou saudações.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_users',
    description: 'Lista usuários (nome, role, status). Use para perguntas sobre time ou acessos.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        onlyActive: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_datasources',
    description: 'Lista fontes de dados (integrações) com status.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        onlyActive: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_alerts',
    description: 'Lista alertas recentes. Use para erros, incidentes, avisos.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        onlyUnread: { type: 'boolean' },
        severity: { type: 'string', enum: ['info', 'warning', 'error', 'critical'] },
      },
    },
  },
  {
    name: 'search_entities',
    description: 'Busca global por termo em usuários, fontes e alertas.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_scheduled_reports',
    description: 'Lista relatórios agendados. Útil para saber o que é enviado automaticamente e para quem.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        onlyActive: { type: 'boolean' },
        // admin-only (ignorado para não-admin)
        userId: { type: 'string' },
      },
    },
  },
  {
    name: 'get_audit_log',
    description:
      'Lista eventos de auditoria recentes (admin). Use para rastrear ações e alterações no sistema.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        action: { type: 'string' },
        resource: { type: 'string' },
      },
    },
  },
  {
    name: 'get_proxy_status',
    description: 'Status operacional do proxy SGBR (health, contadores, últimos erros/sucessos).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_datasource_details',
    description: 'Detalhes de uma fonte de dados por id ou por nome (tenant atual).',
    parameters: {
      type: 'object',
      properties: {
        dsId: { type: 'string' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'query_proxy_data',
    description:
      'Busca dados no proxy (/api/proxy/data) para uma fonte (dsId) e período EXATO. Use somente quando o usuário informar explicitamente dtDe e dtAte (datas específicas). Para perguntas por mês/ano ("fevereiro/2026"), prefira get_faturamento_mes.',
    parameters: {
      type: 'object',
      properties: {
        dsId: { type: 'string' },
        dtDe: { type: 'string', description: 'Data inicial (YYYY.MM.DD ou YYYY-MM-DD)' },
        dtAte: { type: 'string', description: 'Data final (YYYY.MM.DD ou YYYY-MM-DD)' },
        limit: { type: 'integer', description: 'Opcional: corta o array retornado (para respostas curtas)' },
      },
      required: ['dsId', 'dtDe', 'dtAte'],
    },
  },
  {
    name: 'get_faturamento_mes',
    description:
      'Resumo de faturamento do mês (agrega fontes de vendas compatíveis no tenant). Retorna totais por fonte e total geral.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        month: { type: 'integer', description: '1-12' },
        includeNfe: { type: 'boolean', description: 'Inclui fontes vendanfe/analitico quando existirem' },
      },
      required: ['year', 'month'],
    },
  },
  {
    name: 'get_faturamento_periodo',
    description:
      'Resumo de faturamento por período explícito (dtDe e dtAte), agregando fontes de vendas compatíveis no tenant.',
    parameters: {
      type: 'object',
      properties: {
        dtDe: { type: 'string', description: 'Data inicial (YYYY.MM.DD ou YYYY-MM-DD)' },
        dtAte: { type: 'string', description: 'Data final (YYYY.MM.DD ou YYYY-MM-DD)' },
        includeNfe: { type: 'boolean', description: 'Inclui fontes vendanfe/analitico quando existirem' },
      },
      required: ['dtDe', 'dtAte'],
    },
  },
  {
    name: 'get_faturamento_comparativo_mensal',
    description:
      'Compara faturamento do mês informado com o mês anterior e retorna variação absoluta e percentual.',
    parameters: {
      type: 'object',
      properties: {
        year: { type: 'integer' },
        month: { type: 'integer', description: '1-12' },
        includeNfe: { type: 'boolean' },
      },
      required: ['year', 'month'],
    },
  },
  {
    name: 'set_monthly_revenue_goal',
    description:
      'Define a meta mensal de faturamento do usuário atual e salva em preferências.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number', description: 'Valor da meta mensal em BRL' },
      },
      required: ['value'],
    },
  },
  {
    name: 'clear_monthly_revenue_goal',
    description:
      'Remove a meta mensal de faturamento do usuário atual nas preferências.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_compras_periodo',
    description:
      'Resumo de compras/matéria-prima por período. Agrega fontes com endpoints de compras no tenant.',
    parameters: {
      type: 'object',
      properties: {
        dtDe: { type: 'string', description: 'Data inicial (YYYY-MM-DD)' },
        dtAte: { type: 'string', description: 'Data final (YYYY-MM-DD)' },
      },
      required: ['dtDe', 'dtAte'],
    },
  },
  {
    name: 'get_producao_periodo',
    description:
      'Resumo de produção/fabricação por período. Agrega fontes com endpoints de produção no tenant.',
    parameters: {
      type: 'object',
      properties: {
        dtDe: { type: 'string', description: 'Data inicial (YYYY-MM-DD)' },
        dtAte: { type: 'string', description: 'Data final (YYYY-MM-DD)' },
      },
      required: ['dtDe', 'dtAte'],
    },
  },
  {
    name: 'get_contas_pagar_periodo',
    description:
      'Resumo de contas a pagar / títulos financeiros por período. Agrega fontes com endpoints de contas no tenant.',
    parameters: {
      type: 'object',
      properties: {
        dtDe: { type: 'string', description: 'Data inicial (YYYY-MM-DD)' },
        dtAte: { type: 'string', description: 'Data final (YYYY-MM-DD)' },
      },
      required: ['dtDe', 'dtAte'],
    },
  },
]

type ToolContext = {
  userId: string
  userRole: string
  tenantId: string
}

type ToolResult = Record<string, unknown>

function extractMonthlyRevenueGoal(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const direct = obj.monthlyRevenueGoal
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct
  const execTargets = obj.executiveTargets
  if (execTargets && typeof execTargets === 'object') {
    const monthly = (execTargets as Record<string, unknown>).monthlyRevenue
    if (typeof monthly === 'number' && Number.isFinite(monthly) && monthly >= 0) return monthly
  }
  return null
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 1
}

function boolArgWithDefault(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (!s) return fallback
    if (['false', '0', 'nao', 'não', 'off'].includes(s)) return false
    if (['true', '1', 'sim', 'on'].includes(s)) return true
  }
  return truthy(v)
}

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

function isSalesLikeDataEndpoint(ep: string | undefined, includeNfe: boolean): boolean {
  const p = normalizeDataEndpointPath(ep)
  if (!p) return false
  const isVendas = p.includes('/sgbrbi/vendas/analitico')
  const isNfe =
    p.includes('/sgbrbi/vendanfe/analitico') ||
    p.includes('/sgbrbi/vendasnfe/analitico') ||
    p.includes('/sgbrbi/notasfiscais/analitico') ||
    p.includes('/sgbrbi/notasfiscais/listagem') ||
    p.includes('/sgbrbi/notasfiscal/analitico') ||
    p.includes('/sgbrbi/notafiscal/analitico') ||
    p.includes('/sgbrbi/notasfiscais')
  if (isNfe && !includeNfe) return false
  return isVendas || isNfe
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function toSgbrDateParam(input: string): string | null {
  const s = input.trim()
  const m1 = /^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(s)
  if (m1) return `${m1[1]}.${m1[2]}.${m1[3]}`
  const m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m2) return `${m2[1]}.${m2[2]}.${m2[3]}`
  return null
}

function monthRange(year: number, month: number): { dtDe: string; dtAte: string } {
  const y = Math.floor(year)
  const m = Math.max(1, Math.min(12, Math.floor(month)))
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 0)) // último dia do mês
  const dtDe = `${start.getUTCFullYear()}.${pad2(start.getUTCMonth() + 1)}.${pad2(start.getUTCDate())}`
  const dtAte = `${end.getUTCFullYear()}.${pad2(end.getUTCMonth() + 1)}.${pad2(end.getUTCDate())}`
  return { dtDe, dtAte }
}

function asNumberLoose(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  // "1.234,56" -> "1234.56"
  const normalized = s.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

function pickRaw(row: Record<string, unknown>, keys: string[]): unknown {
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

function toNum(v: unknown, fallback = 0): number {
  const n = asNumberLoose(v)
  return n == null ? fallback : n
}

function lineReceitaRaw(row: Record<string, unknown>) {
  const total = toNum(pickRaw(row, ['total', 'valor_total', 'vl_total', 'vltotal', 'valor', 'totalliquido', 'vltot', 'valortotal', 'valortotalnota', 'valortotalproduto', 'valorentrada']))
  if (Math.abs(total) > 1e-9) return Math.round(total * 100) / 100
  const valorunit = toNum(pickRaw(row, ['valorunit', 'valor_unit', 'vl_unit', 'preco_unit', 'vlrunit']))
  const qtdevendida = toNum(pickRaw(row, ['qtdevendida', 'qtd', 'quantidade', 'qtde', 'qtdevenda', 'qt']))
  const vu = valorunit * qtdevendida
  if (Math.abs(vu) > 1e-9) return Math.round(vu * 100) / 100
  return 0
}

const PEDIDO_KEY_FIELDS = [
  'numdav',
  'numerodav',
  'numero_dav',
  'numpedido',
  'num_pedido',
  'codpedido',
  'cod_pedido',
  'nrpedido',
  'pedido',
  'dav',
  'nr_dav',
]

function pedidoGroupKeyRaw(row: Record<string, unknown>): string {
  for (const c of PEDIDO_KEY_FIELDS) {
    const v = pickRaw(row, [c])
    if (v != null && String(v).trim() !== '') return `p:${String(v).trim()}`
  }
  const codcliente = pickRaw(row, ['codcliente', 'cod_cliente', 'cliente', 'codcli', 'codigo_cliente']) ?? ''
  const data = pickRaw(row, ['datafec', 'data_fechamento', 'dt_fec', 'dtfechamento', 'data', 'dt_emissao']) ?? ''
  const codprod = pickRaw(row, ['codprod', 'cod_prod', 'codigo_produto', 'produto', 'sku', 'coditem', 'cod']) ?? ''
  const valorunit = pickRaw(row, ['valorunit', 'valor_unit', 'vl_unit', 'preco_unit', 'vlrunit']) ?? ''
  return `l:${String(codcliente)}|${String(data)}|${String(codprod)}|${String(valorunit)}`
}

function sumMoneyFromRows(rows: unknown[]) {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const key = pedidoGroupKeyRaw(row)
    const arr = groups.get(key) ?? []
    arr.push(row)
    groups.set(key, arr)
  }

  let sum = 0
  let hits = 0
  let usedField: string | null = null
  for (const g of groups.values()) {
    const lineSum = g.reduce((acc, row) => acc + lineReceitaRaw(row), 0)
    let maxTotalProdutos = 0
    for (const row of g) {
      const tpRaw = pickRaw(row, ['totalprodutos', 'total_produtos', 'vl_produtos'])
      const tp = toNum(tpRaw, 0)
      if (tp > maxTotalProdutos) {
        maxTotalProdutos = tp
        usedField = usedField ?? 'totalprodutos'
      }
    }
    if (maxTotalProdutos <= 0 && lineSum > 0 && !usedField) usedField = 'total|valorunit*qtdevendida'
    const receitaGrupo = Math.round(Math.max(lineSum, maxTotalProdutos) * 100) / 100
    sum += receitaGrupo
    if (receitaGrupo > 0) hits += 1
  }
  return { sum: Math.round(sum * 100) / 100, usedField, hits }
}

function isComprasLikeEndpoint(ep: string | undefined): boolean {
  const p = normalizeDataEndpointPath(ep)
  if (!p) return false
  return p.includes('/compras') || p.includes('/materia-prima') || p.includes('/materiaprima') || p.includes('/compra')
}

function isProducaoLikeEndpoint(ep: string | undefined): boolean {
  const p = normalizeDataEndpointPath(ep)
  if (!p) return false
  return p.includes('/produzido') || p.includes('/producao') || p.includes('/produção') || p.includes('/fabricacao') || p.includes('/lotes')
}

function isContasPagarLikeEndpoint(ep: string | undefined): boolean {
  const p = normalizeDataEndpointPath(ep)
  if (!p) return false
  return p.includes('/contas') || p.includes('/titulos') || p.includes('/financeiro') || p.includes('/pagar') || p.includes('/pagos')
}

function isAdmin(ctx: ToolContext): boolean {
  return ctx.userRole === 'admin'
}

function byTenant(all: DataSource[], tenantId: string): DataSource[] {
  return all.filter((d) => d.tenantId === tenantId)
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const db = getDb()
  switch (name) {
    case 'get_overview': {
      const usersTotal = Number((db.prepare('SELECT COUNT(*) as t FROM users').get() as { t: number }).t ?? 0)
      const usersActive = Number(
        (db.prepare("SELECT COUNT(*) as t FROM users WHERE status = 'active'").get() as { t: number }).t ?? 0,
      )
      const alertsTotal = Number(
        (
          db.prepare('SELECT COUNT(*) as t FROM alerts WHERE tenant_id = ?').get(ctx.tenantId) as { t: number }
        ).t ?? 0,
      )
      const alertsUnread = Number(
        (
          db
            .prepare('SELECT COUNT(*) as t FROM alerts WHERE tenant_id = ? AND read_at IS NULL')
            .get(ctx.tenantId) as { t: number }
        ).t ?? 0,
      )
      const dataSources = byTenant(readAllDataSources(), ctx.tenantId)
      const dsByStatus: Record<string, number> = {}
      for (const d of dataSources) dsByStatus[d.status] = (dsByStatus[d.status] ?? 0) + 1
      return {
        users: { total: usersTotal, active: usersActive },
        datasources: { total: dataSources.length, byStatus: dsByStatus },
        alerts: { total: alertsTotal, unread: alertsUnread },
        tenantId: ctx.tenantId,
      }
    }

    case 'get_users': {
      if (!isAdmin(ctx)) {
        return { error: 'Acesso restrito: listagem de usuários é apenas para administradores.' }
      }
      const limit = clamp(args.limit, 1, 50, 10)
      const where = truthy(args.onlyActive) ? "WHERE status = 'active'" : ''
      const rows = db
        .prepare(`SELECT name, email, role, status FROM users ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Array<{ name: string; email: string; role: string; status: string }>
      const masked = rows.map((r) => ({
        name: r.name,
        email: r.email.replace(/^[^@]+/, '***'),
        role: r.role,
        status: r.status,
      }))
      return { users: masked, returned: masked.length }
    }

    case 'get_datasources': {
      const limit = clamp(args.limit, 1, 50, 10)
      const all = byTenant(readAllDataSources(), ctx.tenantId)
      const filtered = truthy(args.onlyActive) ? all.filter((d) => d.status === 'active' || d.status === 'connected') : all
      const slim = filtered.slice(0, limit).map((d) => ({
        name: d.name,
        type: d.type,
        status: d.status,
        lastCheckedAt: d.lastCheckedAt,
        lastError: d.lastError,
      }))
      return { datasources: slim, returned: slim.length, totalAvailable: filtered.length, tenantId: ctx.tenantId }
    }

    case 'get_alerts': {
      const limit = clamp(args.limit, 1, 50, 10)
      const clauses: string[] = []
      const params: unknown[] = []
      clauses.push('tenant_id = ?')
      params.push(ctx.tenantId)
      if (truthy(args.onlyUnread)) clauses.push('read_at IS NULL')
      if (typeof args.severity === 'string') {
        clauses.push('severity = ?')
        params.push(args.severity)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      params.push(limit)
      const rows = db
        .prepare(`SELECT title, severity, created_at, read_at FROM alerts ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params) as Array<{ title: string; severity: string; created_at: string; read_at: string | null }>
      return { alerts: rows, returned: rows.length, tenantId: ctx.tenantId }
    }

    case 'search_entities': {
      const rawQuery = typeof args.query === 'string' ? args.query.trim() : ''
      if (rawQuery.length < 2) return { error: 'Query deve ter pelo menos 2 caracteres.', results: [] }
      const safe = rawQuery.replace(/[_%]/g, '\\$&')
      const likeTerm = `%${safe}%`
      const users = isAdmin(ctx)
        ? (db
            .prepare("SELECT name, role FROM users WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' LIMIT 5")
            .all(likeTerm, likeTerm) as Array<{ name: string; role: string }>)
        : []
      const ds = byTenant(readAllDataSources(), ctx.tenantId)
        .filter((d) => d.name.toLowerCase().includes(rawQuery.toLowerCase()))
        .slice(0, 5)
        .map((d) => ({ name: d.name, status: d.status }))
      const alerts = db
        .prepare("SELECT title, severity FROM alerts WHERE tenant_id = ? AND title LIKE ? ESCAPE '\\' LIMIT 5")
        .all(ctx.tenantId, likeTerm) as Array<{ title: string; severity: string }>
      return { query: rawQuery, users, datasources: ds, alerts, tenantId: ctx.tenantId }
    }

    case 'get_scheduled_reports': {
      const limit = clamp(args.limit, 1, 50, 10)
      const onlyActive = truthy(args.onlyActive)
      const requestedUserId = typeof args.userId === 'string' ? args.userId.trim() : ''
      const userId = isAdmin(ctx) && requestedUserId ? requestedUserId : ctx.userId

      const clauses: string[] = ['user_id = ?']
      const params: unknown[] = [userId]
      if (onlyActive) clauses.push('active = 1')
      params.push(limit)
      const where = `WHERE ${clauses.join(' AND ')}`
      const rows = db
        .prepare(
          `SELECT id, name, report_type, frequency, cron_expr, format, active, last_sent_at, created_at, updated_at
           FROM scheduled_reports ${where} ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...params) as Array<Record<string, unknown>>
      return { scheduledReports: rows, returned: rows.length, forUserId: userId }
    }

    case 'get_audit_log': {
      if (!isAdmin(ctx)) {
        return { error: 'Acesso restrito: auditoria é apenas para administradores.' }
      }
      const limit = clamp(args.limit, 1, 50, 20)
      const clauses: string[] = []
      const params: unknown[] = []
      if (typeof args.action === 'string' && args.action.trim()) {
        clauses.push('action = ?')
        params.push(args.action.trim())
      }
      if (typeof args.resource === 'string' && args.resource.trim()) {
        clauses.push('resource = ?')
        params.push(args.resource.trim())
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      params.push(limit)
      const rows = db
        .prepare(
          `SELECT id, user_id, action, resource, metadata_json, created_at
           FROM audit_log ${where} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...params) as Array<Record<string, unknown>>
      // metadata_json pode conter info sensível; retornamos só tamanho + preview pequeno
      const slim = rows.map((r) => {
        const raw = typeof r.metadata_json === 'string' ? r.metadata_json : null
        const preview = raw ? raw.slice(0, 300) : null
        return { ...r, metadata_json: preview, metadata_truncated: raw ? raw.length > 300 : false }
      })
      return { audit: slim, returned: slim.length }
    }

    case 'get_proxy_status': {
      const snap = getProxyOperationalSnapshot()
      return { proxy: snap }
    }

    case 'get_datasource_details': {
      const all = byTenant(readAllDataSources(), ctx.tenantId)
      const dsId = typeof args.dsId === 'string' ? args.dsId.trim() : ''
      const name = typeof args.name === 'string' ? args.name.trim().toLowerCase() : ''
      const dsIdAsName = dsId ? dsId.toLowerCase() : ''
      const match =
        (dsId && all.find((d) => d.id === dsId)) ||
        (name && all.find((d) => d.name.toLowerCase() === name)) ||
        (name && all.find((d) => d.name.toLowerCase().includes(name))) ||
        (dsIdAsName && all.find((d) => d.name.toLowerCase() === dsIdAsName)) ||
        (dsIdAsName && all.find((d) => d.name.toLowerCase().includes(dsIdAsName)))
      if (!match) return { error: 'Fonte não encontrada neste tenant.', tenantId: ctx.tenantId }
      return {
        datasource: {
          id: match.id,
          name: match.name,
          type: match.type,
          status: match.status,
          apiUrl: match.apiUrl,
          authMethod: match.authMethod,
          lastCheckedAt: match.lastCheckedAt,
          lastError: match.lastError,
          loginEndpoint: match.loginEndpoint ?? null,
          dataEndpoint: match.dataEndpoint ?? null,
          erpEndpoints: match.erpEndpoints ?? [],
          isAuthSource: match.isAuthSource,
        },
        tenantId: ctx.tenantId,
      }
    }

    case 'query_proxy_data': {
      const dsId = typeof args.dsId === 'string' ? args.dsId.trim() : ''
      const dtDeRaw = typeof args.dtDe === 'string' ? args.dtDe : ''
      const dtAteRaw = typeof args.dtAte === 'string' ? args.dtAte : ''
      const dtDe = toSgbrDateParam(dtDeRaw)
      const dtAte = toSgbrDateParam(dtAteRaw)
      if (!dsId) return { error: 'dsId obrigatório.' }
      if (!dtDe || !dtAte) return { error: 'dtDe/dtAte inválidos. Use YYYY.MM.DD ou YYYY-MM-DD.' }

      const result = await fetchProxyDataForTool({
        tenantId: ctx.tenantId,
        dsId,
        query: { dt_de: dtDe, dt_ate: dtAte, requireDsId: '1' },
      })

      if (!result.ok) {
        return { ok: false, status: result.status, error: result.message }
      }

      const array = result.rows
      const limit = clamp(args.limit, 1, 2000, 200)
      const truncated = result.truncated

      const summary = sumMoneyFromRows(array)
      return {
        ok: true,
        dsId,
        tenantId: ctx.tenantId,
        period: { dtDe, dtAte },
        meta: {
          rowCount: array.length,
          pagesFetched: result.pagesFetched,
          truncated,
          sum: summary.sum,
        },
        sample: array.slice(0, limit),
      }
    }

    case 'get_faturamento_mes': {
      const year = typeof args.year === 'number' ? args.year : Number(args.year)
      const month = typeof args.month === 'number' ? args.month : Number(args.month)
      if (!Number.isFinite(year) || !Number.isFinite(month)) return { error: 'year e month são obrigatórios.' }
      const includeNfe = boolArgWithDefault(args.includeNfe, true)
      const { dtDe, dtAte } = monthRange(year, month)

      const all = byTenant(readAllDataSources(), ctx.tenantId)
      const sources = all.filter((d) => isSalesLikeDataEndpoint(d.dataEndpoint, includeNfe))

      if (sources.length === 0) {
        return { ok: false, error: 'Nenhuma fonte compatível com vendas/analítico foi encontrada neste tenant.', tenantId: ctx.tenantId }
      }

      const perSource: Array<Record<string, unknown>> = []
      let total = 0
      let anyTruncated = false
      let usedField: string | null = null

      for (const s of sources) {
        let status = 0
        let rows: unknown[] = []
        let truncated = false
        let sum = 0
        let hits = 0
        let field: string | null = null
        try {
          const r = await fetchProxyDataForTool({
            tenantId: ctx.tenantId,
            dsId: s.id,
            query: { dt_de: dtDe, dt_ate: dtAte, requireDsId: '1' },
          })
          status = r.ok ? 200 : r.status
          if (r.ok) {
            rows = r.rows
            truncated = r.truncated
            const summary = sumMoneyFromRows(rows)
            sum = summary.sum
            hits = summary.hits
            field = summary.usedField
          }
        } catch (e) {
          status = 0
        }

        if (field) usedField = usedField ?? field
        if (truncated) anyTruncated = true
        total += sum

        perSource.push({
          id: s.id,
          name: s.name,
          endpoint: s.dataEndpoint ?? null,
          status,
          rowCount: rows.length,
          sum,
          usedField: field,
          valueHits: hits,
          truncated,
        })
      }

      return {
        ok: true,
        tenantId: ctx.tenantId,
        period: { dtDe, dtAte },
        includeNfe,
        sources: perSource,
        total,
        truncated: anyTruncated,
        note: anyTruncated
          ? 'O total pode estar parcial por limite de paginação no período consultado.'
          : null,
      }
    }

    case 'get_faturamento_periodo': {
      const dtDeRaw = typeof args.dtDe === 'string' ? args.dtDe : ''
      const dtAteRaw = typeof args.dtAte === 'string' ? args.dtAte : ''
      const dtDe = toSgbrDateParam(dtDeRaw)
      const dtAte = toSgbrDateParam(dtAteRaw)
      if (!dtDe || !dtAte) return { error: 'dtDe/dtAte inválidos. Use YYYY.MM.DD ou YYYY-MM-DD.' }
      const includeNfe = boolArgWithDefault(args.includeNfe, true)

      const all = byTenant(readAllDataSources(), ctx.tenantId)
      const sources = all.filter((d) => isSalesLikeDataEndpoint(d.dataEndpoint, includeNfe))
      if (sources.length === 0) {
        return { ok: false, error: 'Nenhuma fonte compatível com vendas/analítico foi encontrada neste tenant.', tenantId: ctx.tenantId }
      }

      const perSource: Array<Record<string, unknown>> = []
      let total = 0
      let anyTruncated = false
      for (const s of sources) {
        let status = 0
        let rows: unknown[] = []
        let truncated = false
        let sum = 0
        try {
          const r = await fetchProxyDataForTool({
            tenantId: ctx.tenantId,
            dsId: s.id,
            query: { dt_de: dtDe, dt_ate: dtAte, requireDsId: '1' },
          })
          status = r.ok ? 200 : r.status
          if (r.ok) {
            rows = r.rows
            truncated = r.truncated
            sum = sumMoneyFromRows(rows).sum
          }
        } catch {
          status = 0
        }
        if (truncated) anyTruncated = true
        total += sum
        perSource.push({
          id: s.id,
          name: s.name,
          endpoint: s.dataEndpoint ?? null,
          status,
          rowCount: rows.length,
          sum,
          truncated,
        })
      }

      return {
        ok: true,
        tenantId: ctx.tenantId,
        period: { dtDe, dtAte },
        includeNfe,
        sources: perSource,
        total,
        truncated: anyTruncated,
        note: anyTruncated
          ? 'O total pode estar parcial por limite de paginação no período consultado.'
          : null,
      }
    }

    case 'get_faturamento_comparativo_mensal': {
      const year = typeof args.year === 'number' ? args.year : Number(args.year)
      const month = typeof args.month === 'number' ? args.month : Number(args.month)
      if (!Number.isFinite(year) || !Number.isFinite(month)) return { error: 'year e month são obrigatórios.' }
      const includeNfe = boolArgWithDefault(args.includeNfe, true)

      const current = monthRange(year, month)
      const prevMonthDate = new Date(Date.UTC(year, month - 1, 1))
      prevMonthDate.setUTCMonth(prevMonthDate.getUTCMonth() - 1)
      const prev = monthRange(prevMonthDate.getUTCFullYear(), prevMonthDate.getUTCMonth() + 1)

      const curRes = await executeTool('get_faturamento_periodo', { dtDe: current.dtDe, dtAte: current.dtAte, includeNfe }, ctx)
      const prevRes = await executeTool('get_faturamento_periodo', { dtDe: prev.dtDe, dtAte: prev.dtAte, includeNfe }, ctx)
      const curTotal = typeof curRes.total === 'number' ? curRes.total : 0
      const prevTotal = typeof prevRes.total === 'number' ? prevRes.total : 0
      const delta = curTotal - prevTotal
      const deltaPct = prevTotal > 0 ? (delta / prevTotal) * 100 : null
      const prefRow = db
        .prepare('SELECT preferences_json FROM users WHERE id = ? LIMIT 1')
        .get(ctx.userId) as { preferences_json: string | null } | undefined
      const parsedPrefs = prefRow?.preferences_json ? JSON.parse(prefRow.preferences_json) : null
      const monthlyGoal = extractMonthlyRevenueGoal(parsedPrefs)
      const goalDelta = monthlyGoal != null ? curTotal - monthlyGoal : null
      const goalPct = monthlyGoal != null && monthlyGoal > 0 ? (curTotal / monthlyGoal) * 100 : null

      return {
        ok: true,
        reference: { year, month },
        current: { period: current, total: curTotal },
        previous: { period: prev, total: prevTotal },
        delta,
        deltaPct,
        trend: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
        goal: monthlyGoal == null ? null : { value: monthlyGoal, delta: goalDelta, achievedPct: goalPct },
      }
    }

    case 'set_monthly_revenue_goal': {
      const value = typeof args.value === 'number' ? args.value : Number(args.value)
      if (!Number.isFinite(value) || value < 0) {
        return { ok: false, error: 'Valor de meta inválido. Informe um número maior ou igual a zero.' }
      }
      const rounded = Math.round(value * 100) / 100
      const prefRow = db
        .prepare('SELECT preferences_json FROM users WHERE id = ? LIMIT 1')
        .get(ctx.userId) as { preferences_json: string | null } | undefined
      const current = prefRow?.preferences_json
        ? (JSON.parse(prefRow.preferences_json) as Record<string, unknown>)
        : {}
      const merged = { ...current, monthlyRevenueGoal: rounded }
      db.prepare('UPDATE users SET preferences_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(merged),
        new Date().toISOString(),
        ctx.userId,
      )
      return {
        ok: true,
        monthlyRevenueGoal: rounded,
      }
    }

    case 'clear_monthly_revenue_goal': {
      const prefRow = db
        .prepare('SELECT preferences_json FROM users WHERE id = ? LIMIT 1')
        .get(ctx.userId) as { preferences_json: string | null } | undefined
      const current = prefRow?.preferences_json
        ? (JSON.parse(prefRow.preferences_json) as Record<string, unknown>)
        : {}
      const merged = { ...current }
      delete merged.monthlyRevenueGoal
      db.prepare('UPDATE users SET preferences_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(merged),
        new Date().toISOString(),
        ctx.userId,
      )
      return {
        ok: true,
        monthlyRevenueGoal: null,
      }
    }

    case 'get_compras_periodo': {
      const dtDe = toSgbrDateParam(typeof args.dtDe === 'string' ? args.dtDe : '')
      const dtAte = toSgbrDateParam(typeof args.dtAte === 'string' ? args.dtAte : '')
      if (!dtDe || !dtAte) return { error: 'Datas inválidas. Use YYYY-MM-DD.' }

      const all = byTenant(readAllDataSources(), ctx.tenantId)
      const sources = all.filter((d) => isComprasLikeEndpoint(d.dataEndpoint))
      if (sources.length === 0) {
        return { ok: false, error: 'Nenhuma fonte de compras encontrada neste tenant.', tenantId: ctx.tenantId }
      }

      const perSource: Array<Record<string, unknown>> = []
      let totalGeral = 0
      let anyTruncated = false
      for (const s of sources) {
        try {
          const r = await fetchProxyDataForTool({ tenantId: ctx.tenantId, dsId: s.id, query: { dt_de: dtDe, dt_ate: dtAte, requireDsId: '1' } })
          const rows = r.ok ? r.rows : []
          const sum = sumMoneyFromRows(rows).sum
          totalGeral += sum
          if (r.ok && r.truncated) anyTruncated = true
          perSource.push({ name: s.name, rowCount: rows.length, sum, truncated: r.ok ? r.truncated : false, status: r.ok ? 200 : r.status })
        } catch { perSource.push({ name: s.name, rowCount: 0, sum: 0, status: 0 }) }
      }
      return { ok: true, tenantId: ctx.tenantId, period: { dtDe, dtAte }, sources: perSource, total: totalGeral, truncated: anyTruncated }
    }

    case 'get_producao_periodo': {
      const dtDe = toSgbrDateParam(typeof args.dtDe === 'string' ? args.dtDe : '')
      const dtAte = toSgbrDateParam(typeof args.dtAte === 'string' ? args.dtAte : '')
      if (!dtDe || !dtAte) return { error: 'Datas inválidas. Use YYYY-MM-DD.' }

      const all = byTenant(readAllDataSources(), ctx.tenantId)
      const sources = all.filter((d) => isProducaoLikeEndpoint(d.dataEndpoint))
      if (sources.length === 0) {
        return { ok: false, error: 'Nenhuma fonte de produção encontrada neste tenant.', tenantId: ctx.tenantId }
      }

      const perSource: Array<Record<string, unknown>> = []
      let totalRows = 0
      let anyTruncated = false
      for (const s of sources) {
        try {
          const r = await fetchProxyDataForTool({ tenantId: ctx.tenantId, dsId: s.id, query: { dt_de: dtDe, dt_ate: dtAte, requireDsId: '1' } })
          const rows = r.ok ? r.rows : []
          totalRows += rows.length
          if (r.ok && r.truncated) anyTruncated = true
          // Produção: contamos registros e extraímos quantidade total se disponível
          let qtdTotal = 0
          for (const row of rows) {
            if (!row || typeof row !== 'object') continue
            const r = row as Record<string, unknown>
            qtdTotal += toNum(pickRaw(r, ['quantidade', 'qtde', 'qtd', 'qt', 'qtde_produzida', 'qtdeproduzida', 'peso', 'peso_liquido']), 0)
          }
          perSource.push({ name: s.name, rowCount: rows.length, qtdTotal: Math.round(qtdTotal * 100) / 100, truncated: r.ok ? r.truncated : false })
        } catch { perSource.push({ name: s.name, rowCount: 0, qtdTotal: 0 }) }
      }
      return { ok: true, tenantId: ctx.tenantId, period: { dtDe, dtAte }, sources: perSource, totalRows, truncated: anyTruncated }
    }

    case 'get_contas_pagar_periodo': {
      const dtDe = toSgbrDateParam(typeof args.dtDe === 'string' ? args.dtDe : '')
      const dtAte = toSgbrDateParam(typeof args.dtAte === 'string' ? args.dtAte : '')
      if (!dtDe || !dtAte) return { error: 'Datas inválidas. Use YYYY-MM-DD.' }

      const all = byTenant(readAllDataSources(), ctx.tenantId)
      const sources = all.filter((d) => isContasPagarLikeEndpoint(d.dataEndpoint))
      if (sources.length === 0) {
        return { ok: false, error: 'Nenhuma fonte de contas a pagar encontrada neste tenant.', tenantId: ctx.tenantId }
      }

      const perSource: Array<Record<string, unknown>> = []
      let totalGeral = 0
      let anyTruncated = false
      for (const s of sources) {
        try {
          const r = await fetchProxyDataForTool({ tenantId: ctx.tenantId, dsId: s.id, query: { dt_de: dtDe, dt_ate: dtAte, requireDsId: '1' } })
          const rows = r.ok ? r.rows : []
          const sum = sumMoneyFromRows(rows).sum
          totalGeral += sum
          if (r.ok && r.truncated) anyTruncated = true
          perSource.push({ name: s.name, rowCount: rows.length, sum, truncated: r.ok ? r.truncated : false })
        } catch { perSource.push({ name: s.name, rowCount: 0, sum: 0 }) }
      }
      return { ok: true, tenantId: ctx.tenantId, period: { dtDe, dtAte }, sources: perSource, total: totalGeral, truncated: anyTruncated }
    }

    default:
      return { error: `Ferramenta desconhecida: ${name}` }
  }
}
