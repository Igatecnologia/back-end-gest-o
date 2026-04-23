import { randomUUID } from 'node:crypto'
import type { AiProvider, ChatRequest, StreamEvent } from './types.js'

/**
 * Fallback 100% local, sem rede, sem dependências. Usa detecção de intenção
 * por regex e delega para tools do orquestrador (via tool_call) quando há dados
 * reais a consultar. Mantém o sistema funcional quando todos os LLMs falharem.
 */

type Intent = {
  match: RegExp
  toolName?: string
  toolArgs?: Record<string, unknown>
  reply?: string
  dynamicToolArgs?: (userText: string) => Record<string, unknown> | null
}

function parseCurrencyPtBr(input: string): number | null {
  const m = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+(?:,\d{2})?)/i.exec(input)
  if (!m) return null
  const normalized = m[1].replace(/\./g, '').replace(',', '.')
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

const INTENTS: Intent[] = [
  { match: /\b(oi|ola|bom dia|boa tarde|boa noite|e ai|salve)\b/, toolName: 'get_overview' },
  { match: /\b(grafico|gráfico)\b.*\b(faturamento|vendas|receita)\b.*\bmes(?:es)?\b/, toolName: 'get_faturamento_comparativo_mensal', dynamicToolArgs: currentMonthArgs },
  { match: /\b(compar|compare|comparativo)\b.*\b(este mes|mes atual|mes corrente)\b.*\b(mes passado|ultimo mes|mes anterior)\b/, toolName: 'get_faturamento_comparativo_mensal', dynamicToolArgs: currentMonthArgs },
  { match: /\b(meta|queda|tendencia|tendência|desvio|risco)\b.*\b(faturamento|vendas|receita)\b/, toolName: 'get_faturamento_comparativo_mensal', dynamicToolArgs: currentMonthArgs },
  { match: /\b(definir|ajustar|configurar)\b.*\bmeta\b.*\b(mensal|mes)\b/, toolName: 'set_monthly_revenue_goal', dynamicToolArgs: setMonthlyGoalArgs },
  { match: /\b(remover|excluir|apagar|zerar|limpar)\b.*\bmeta\b.*\b(mensal|mes)\b/, toolName: 'clear_monthly_revenue_goal' },
  { match: /\b(faturamento|vendas|receita|endas|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bde\b.*\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\w*\b/, toolName: 'get_faturamento_mes', dynamicToolArgs: monthYearArgsFromText },
  { match: /\b(faturamento|vendas|receita|endas|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bmes\b/, toolName: 'get_faturamento_mes', dynamicToolArgs: currentMonthArgs },
  { match: /\b(faturamento|vendas|receita|endas|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bmes passado\b/, toolName: 'get_faturamento_mes', dynamicToolArgs: lastMonthArgs },
  { match: /\b(faturamento|vendas|receita|endas|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bultimo mes\b/, toolName: 'get_faturamento_mes', dynamicToolArgs: lastMonthArgs },
  { match: /\b(faturamento|vendas|receita|endas|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bde\b.*\b(20\d{2})\b/, toolName: 'get_faturamento_mes', dynamicToolArgs: monthYearArgsFromText },
  { match: /\b(vendas|faturamento|receita|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bhoje\b/, toolName: 'get_faturamento_periodo', dynamicToolArgs: todayArgs },
  { match: /\b(vendas|faturamento|receita|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bontem\b/, toolName: 'get_faturamento_periodo', dynamicToolArgs: yesterdayArgs },
  { match: /\b(vendas|faturamento|receita|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\banteontem\b/, toolName: 'get_faturamento_periodo', dynamicToolArgs: dayBeforeYesterdayArgs },
  { match: /\b(vendas|faturamento|receita|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bultimos?\s*7\s*dias\b/, toolName: 'get_faturamento_periodo', dynamicToolArgs: last7DaysArgs },
  { match: /\b(vendas|faturamento|receita|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bultimos?\s*30\s*dias\b/, toolName: 'get_faturamento_periodo', dynamicToolArgs: last30DaysArgs },
  { match: /\b(vendas|faturamento|receita|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bultima semana\b/, toolName: 'get_faturamento_periodo', dynamicToolArgs: last7DaysArgs },
  { match: /\b(vendas|faturamento|receita|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bsemana passada\b/, toolName: 'get_faturamento_periodo', dynamicToolArgs: last7DaysArgs },
  { match: /\b(vendas|faturamento|receita|gasto|gastei|gastos|despesa|despesas|custo|custos)\b.*\bultimas 4 semanas\b/, toolName: 'get_faturamento_periodo', dynamicToolArgs: last30DaysArgs },
  { match: /\b(fonte|fontes|datasource|datasources|integracao|api)\b/, toolName: 'get_datasources' },
  { match: /\b(usuario|usuarios|user|users|acesso|permissao|permissoes)\b/, toolName: 'get_users' },
  { match: /\b(alerta|alertas|erro|falha|incidente|critico|critica)\b/, toolName: 'get_alerts', toolArgs: { onlyUnread: true } },
  { match: /\b(resumo|status|visao geral|geral|situacao|ambiente)\b/, toolName: 'get_overview' },
  { match: /\b(busca|buscar|procurar|encontre|encontrar)\b/, toolName: 'search_entities' },
]

function normalize(input: string) {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function formatToolResult(toolName: string | undefined, content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return 'Consegui processar sua solicitação, mas não foi possível formatar os dados no modo local.'
  }
  if (!parsed || typeof parsed !== 'object') {
    return 'Consegui processar sua solicitação, mas não há dados estruturados para exibir.'
  }
  const data = parsed as Record<string, unknown>
  if (typeof data.error === 'string' && data.error.trim()) {
    return data.error
  }

  if (toolName === 'get_overview') {
    const users = (data.users as Record<string, unknown> | undefined) ?? {}
    const alerts = (data.alerts as Record<string, unknown> | undefined) ?? {}
    const ds = (data.datasources as Record<string, unknown> | undefined) ?? {}
    return [
      'Resumo geral do sistema:',
      `• Usuários ativos: ${users.active ?? '-'} (total: ${users.total ?? '-'})`,
      `• Fontes de dados: ${ds.total ?? '-'}`,
      `• Alertas não lidos: ${alerts.unread ?? '-'} (total: ${alerts.total ?? '-'})`,
    ].join('\n')
  }

  if (toolName === 'get_faturamento_mes') {
    const total = typeof data.total === 'number' ? data.total : null
    const period = (data.period as Record<string, unknown> | undefined) ?? {}
    const dtDe = typeof period.dtDe === 'string' ? period.dtDe : '-'
    const dtAte = typeof period.dtAte === 'string' ? period.dtAte : '-'
    const totalFmt = total != null
      ? total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : 'não disponível'
    return [
      'Resumo de faturamento',
      `• Período: ${toBrDate(dtDe)} a ${toBrDate(dtAte)}`,
      `• Total: ${totalFmt}`,
      '',
      'Leitura rápida: resultado consolidado do período solicitado.',
    ].join('\n')
  }

  if (toolName === 'get_faturamento_periodo') {
    const total = typeof data.total === 'number' ? data.total : null
    const period = (data.period as Record<string, unknown> | undefined) ?? {}
    const dtDe = typeof period.dtDe === 'string' ? period.dtDe : '-'
    const dtAte = typeof period.dtAte === 'string' ? period.dtAte : '-'
    const totalFmt = total != null
      ? total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
      : 'não disponível'
    return [
      'Resumo de faturamento',
      `• Período: ${toBrDate(dtDe)} a ${toBrDate(dtAte)}`,
      `• Total: ${totalFmt}`,
      '',
      'Leitura rápida: valor referente ao intervalo informado.',
    ].join('\n')
  }

  if (toolName === 'get_faturamento_comparativo_mensal') {
    const current = (data.current as Record<string, unknown> | undefined) ?? {}
    const previous = (data.previous as Record<string, unknown> | undefined) ?? {}
    const curTotal = typeof current.total === 'number' ? current.total : 0
    const prevTotal = typeof previous.total === 'number' ? previous.total : 0
    const delta = typeof data.delta === 'number' ? data.delta : (curTotal - prevTotal)
    const deltaPct = typeof data.deltaPct === 'number' ? data.deltaPct : null
    const curFmt = curTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const prevFmt = prevTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const deltaFmt = Math.abs(delta).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const direction = delta > 0 ? 'acima' : delta < 0 ? 'abaixo' : 'igual'
    const pctText = deltaPct == null ? '' : ` (${Math.abs(deltaPct).toFixed(1)}%)`
    const riskLevel = delta < 0 ? 'atenção' : delta > 0 ? 'controlado' : 'estável'
    const trendText = delta > 0 ? 'alta' : delta < 0 ? 'queda' : 'estabilidade'
    const goal = (data.goal && typeof data.goal === 'object') ? data.goal as Record<string, unknown> : null
    const goalValue = goal && typeof goal.value === 'number' ? goal.value : null
    const goalDelta = goal && typeof goal.delta === 'number' ? goal.delta : null
    const goalPct = goal && typeof goal.achievedPct === 'number' ? goal.achievedPct : null
    const goalFmt = goalValue == null ? null : goalValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const goalDeltaFmt = goalDelta == null ? null : Math.abs(goalDelta).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const goalDirection = goalDelta == null ? null : goalDelta >= 0 ? 'acima' : 'abaixo'
    return [
      'Comparativo mensal',
      `• Mês atual: ${curFmt}`,
      `• Mês passado: ${prevFmt}`,
      `• Desvio: ${deltaFmt}${pctText} (${direction})`,
      `• Tendência: ${trendText}`,
      `• Risco: ${riskLevel}`,
      ...(goalFmt
        ? [
            `• Meta do mês: ${goalFmt}`,
            `• Atingimento da meta: ${goalPct == null ? '-' : `${goalPct.toFixed(1)}%`}`,
            `• Distância para meta: ${goalDeltaFmt ?? '-'} (${goalDirection ?? '-'})`,
          ]
        : ['• Meta do mês: não cadastrada']),
      '',
      `Leitura rápida: desempenho ${direction} em relação ao mês anterior.`,
    ].join('\n')
  }

  if (toolName === 'set_monthly_revenue_goal') {
    const goal = typeof data.monthlyRevenueGoal === 'number' ? data.monthlyRevenueGoal : null
    if (goal == null) return 'Não consegui salvar a meta mensal agora.'
    return `Meta mensal definida com sucesso em ${goal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`
  }

  if (toolName === 'clear_monthly_revenue_goal') {
    return 'Meta mensal removida com sucesso.'
  }

  if (toolName === 'get_datasources') {
    const rows = Array.isArray(data.datasources) ? data.datasources : []
    const names = rows.slice(0, 5).map((r) => (r && typeof r === 'object' ? String((r as Record<string, unknown>).name ?? '') : '')).filter(Boolean)
    return rows.length
      ? `Fontes disponíveis (${rows.length}): ${names.join(', ')}.`
      : 'Não encontrei fontes de dados para exibir.'
  }

  return 'Consegui consultar os dados no modo local.'
}

const HELP_REPLY = [
  'Posso ajudar com perguntas como:',
  '• "resumo geral" — visão consolidada da operação',
  '• "faturamento do mês" — total de vendas do período',
  '• "vendas de hoje", "ontem" ou "anteontem"',
  '• "vendas dos últimos 7 dias" ou "últimos 30 dias"',
  '• "faturamento do mês passado"',
  '• "quanto eu gastei em janeiro"',
  '• "explique o gráfico de faturamento por mês"',
  '• "listar fontes" — status das integrações',
  '• "alertas recentes" — pontos de atenção',
  '• "buscar <termo>" — pesquisa global',
  '',
  'Se quiser, também posso detalhar por período e por fonte.',
].join('\n')

function currentMonthArgs() {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

function lastMonthArgs() {
  const now = new Date()
  now.setMonth(now.getMonth() - 1)
  return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

function monthYearArgsFromText(userText: string): Record<string, unknown> | null {
  const t = normalize(userText)
  const yearMatch = /\b(20\d{2})\b/.exec(t)
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear()
  const squashed = t.replace(/([a-z])\1+/g, '$1')
  const monthMap: Array<{ keys: string[]; month: number }> = [
    { keys: ['janeiro', 'jan', 'janeiroo', 'janneiro'], month: 1 },
    { keys: ['fevereiro', 'fev', 'fevereiro'], month: 2 },
    { keys: ['marco', 'março', 'mar'], month: 3 },
    { keys: ['abril', 'abr'], month: 4 },
    { keys: ['maio', 'mai'], month: 5 },
    { keys: ['junho', 'jun'], month: 6 },
    { keys: ['julho', 'jul'], month: 7 },
    { keys: ['agosto', 'ago'], month: 8 },
    { keys: ['setembro', 'set'], month: 9 },
    { keys: ['outubro', 'out'], month: 10 },
    { keys: ['novembro', 'nov'], month: 11 },
    { keys: ['dezembro', 'dez'], month: 12 },
  ]
  for (const item of monthMap) {
    if (item.keys.some((k) => t.includes(k) || squashed.includes(k))) {
      return { year, month: item.month }
    }
  }
  return null
}

function setMonthlyGoalArgs(userText: string): Record<string, unknown> | null {
  const value = parseCurrencyPtBr(userText)
  if (value == null) return null
  return { value }
}

function toIsoDot(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}.${m}.${day}`
}

function toBrDate(input: string) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(input.trim())
  if (!m) return input
  return `${m[3]}/${m[2]}/${m[1]}`
}

function todayArgs() {
  const d = new Date()
  return { dtDe: toIsoDot(d), dtAte: toIsoDot(d) }
}

function yesterdayArgs() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return { dtDe: toIsoDot(d), dtAte: toIsoDot(d) }
}

function dayBeforeYesterdayArgs() {
  const d = new Date()
  d.setDate(d.getDate() - 2)
  return { dtDe: toIsoDot(d), dtAte: toIsoDot(d) }
}

function rangeLastNDaysArgs(days: number) {
  const end = new Date()
  const start = new Date()
  start.setDate(end.getDate() - (days - 1))
  return { dtDe: toIsoDot(start), dtAte: toIsoDot(end) }
}

function last7DaysArgs() {
  return rangeLastNDaysArgs(7)
}

function last30DaysArgs() {
  return rangeLastNDaysArgs(30)
}

export class LocalProvider implements AiProvider {
  readonly name = 'local' as const
  readonly displayName = 'Copiloto local (offline)'

  async isAvailable(): Promise<boolean> {
    return true
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool')
    if (lastTool && typeof lastTool.content === 'string') {
      const text = formatToolResult(lastTool.toolName, lastTool.content)
      for (const token of text.split(/(\s+)/)) {
        yield { type: 'token', text: token }
      }
      yield { type: 'done' }
      return
    }

    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
    const text = normalize(lastUser?.content ?? '')
    const intent = INTENTS.find((i) => i.match.test(text))

    if (!intent) {
      // Sem intent identificada: emite help diretamente
      for (const token of HELP_REPLY.split(/(\s+)/)) {
        yield { type: 'token', text: token }
      }
      yield { type: 'done' }
      return
    }

    if (intent.reply) {
      for (const token of intent.reply.split(/(\s+)/)) {
        yield { type: 'token', text: token }
      }
      yield { type: 'done' }
      return
    }

    // Delega para tool — orquestrador executa e re-invoca com resultado
    if (intent.toolName) {
      // Para search, extrai termo simples após "buscar/procurar"
      let args: Record<string, unknown> = intent.dynamicToolArgs ? (intent.dynamicToolArgs(lastUser?.content ?? '') ?? {}) : (intent.toolArgs ?? {})
      if (intent.toolName === 'search_entities') {
        const match = /(?:buscar|procurar|encontrar|encontre|busca)\s+(.+)/i.exec(lastUser?.content ?? '')
        args = { query: match?.[1]?.trim() ?? '' }
      }
      if (
        intent.toolName === 'get_faturamento_mes' &&
        (args.year == null || args.month == null)
      ) {
        for (const token of 'Não identifiquei o mês e o ano. Exemplo: "vendas de janeiro de 2026".'.split(/(\s+)/)) {
          yield { type: 'token', text: token }
        }
        yield { type: 'done' }
        return
      }
      if (intent.toolName === 'set_monthly_revenue_goal' && args.value == null) {
        for (const token of 'Não identifiquei o valor da meta. Exemplo: "definir meta mensal em R$ 250.000,00".'.split(/(\s+)/)) {
          yield { type: 'token', text: token }
        }
        yield { type: 'done' }
        return
      }
      yield {
        type: 'tool_call',
        call: { id: randomUUID(), name: intent.toolName, args },
      }
      yield { type: 'done' }
      return
    }

    yield { type: 'done' }
  }
}
