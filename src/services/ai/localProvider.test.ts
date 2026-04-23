import { describe, expect, it } from 'vitest'
import { LocalProvider } from './localProvider.js'
import type { ChatRequest, StreamEvent } from './types.js'

async function collect(req: ChatRequest): Promise<StreamEvent[]> {
  const provider = new LocalProvider()
  const out: StreamEvent[] = []
  for await (const evt of provider.stream(req)) out.push(evt)
  return out
}

function reqFromText(text: string): ChatRequest {
  return {
    systemPrompt: '',
    messages: [{ role: 'user', content: text }],
    tools: [],
  }
}

describe('LocalProvider intents', () => {
  it('maps "vendas de ontem" to get_faturamento_periodo', async () => {
    const events = await collect(reqFromText('qual foi as vendas de ontem'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_periodo')
    expect(typeof tc.call.args.dtDe).toBe('string')
    expect(typeof tc.call.args.dtAte).toBe('string')
    expect(tc.call.args.dtDe).toBe(tc.call.args.dtAte)
  })

  it('maps "vendas de anteontem" to get_faturamento_periodo', async () => {
    const events = await collect(reqFromText('quero as vendas de anteontem'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_periodo')
  })

  it('maps "ultimos 7 dias" to get_faturamento_periodo', async () => {
    const events = await collect(reqFromText('vendas dos ultimos 7 dias'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_periodo')
  })

  it('maps "ultimos 30 dias" to get_faturamento_periodo', async () => {
    const events = await collect(reqFromText('faturamento dos ultimos 30 dias'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_periodo')
  })

  it('maps "mes passado" to get_faturamento_mes', async () => {
    const events = await collect(reqFromText('faturamento do mes passado'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_mes')
    expect(typeof tc.call.args.year).toBe('number')
    expect(typeof tc.call.args.month).toBe('number')
  })

  it('maps "semana passada" to get_faturamento_periodo', async () => {
    const events = await collect(reqFromText('vendas da semana passada'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_periodo')
  })

  it('maps comparativo este mes vs mes passado to get_faturamento_mes', async () => {
    const events = await collect(reqFromText('comparativo este mes vs mes passado'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_comparativo_mensal')
  })

  it('maps typo month text to get_faturamento_mes using current year', async () => {
    const events = await collect(reqFromText('faturamento do mes de janneiro'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_mes')
    expect(tc.call.args.month).toBe(1)
    expect(typeof tc.call.args.year).toBe('number')
  })

  it('maps "quanto eu gastei no mes de janeiro" to get_faturamento_mes', async () => {
    const events = await collect(reqFromText('me ajude a entender quanto eu gastei no mes de janeiro'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_mes')
    expect(tc.call.args.month).toBe(1)
  })

  it('maps "explicar grafico de faturamento por mes" to monthly comparison', async () => {
    const events = await collect(reqFromText('pode me explicar esse grafico faturamento por mes'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_comparativo_mensal')
  })

  it('maps "mes atual vs mes anterior" to monthly comparison', async () => {
    const events = await collect(reqFromText('compare mes atual vs mes anterior e a variacao percentual'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_comparativo_mensal')
  })

  it('maps executive vocabulary query to monthly comparison', async () => {
    const events = await collect(reqFromText('qual o risco e a tendencia do faturamento este mes'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('get_faturamento_comparativo_mensal')
  })

  it('maps "definir meta mensal" to set_monthly_revenue_goal', async () => {
    const events = await collect(reqFromText('definir meta mensal em R$ 250.000,00'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('set_monthly_revenue_goal')
    expect(tc.call.args.value).toBe(250000)
  })

  it('maps "remover meta mensal" to clear_monthly_revenue_goal', async () => {
    const events = await collect(reqFromText('remover meta mensal'))
    const tc = events.find((e) => e.type === 'tool_call')
    expect(tc).toBeTruthy()
    if (!tc || tc.type !== 'tool_call') return
    expect(tc.call.name).toBe('clear_monthly_revenue_goal')
  })
})

