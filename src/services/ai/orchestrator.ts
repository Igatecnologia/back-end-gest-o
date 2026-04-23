import { resolveProvider } from './providerFactory.js'
import { TOOL_DEFINITIONS, executeTool } from './tools.js'
import { buildDynamicSystemPrompt, resolvePromptContext } from './systemPrompt.js'
import type { AiProvider, ChatMessage, StreamEvent } from './types.js'

type OrchestratorOptions = {
  history: ChatMessage[]
  userPrompt: string
  userId: string
  userName: string
  userRole: string
  tenantId: string
  monthlyGoal?: number | null
  signal?: AbortSignal
  /** provider forçado (para testes) — default: resolve via env */
  provider?: AiProvider
}

const MAX_TOOL_ROUNDS = 4 // trava contra loop infinito de tool calls

function isRateLimitLikeError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('quota') ||
    m.includes('cota excedida') ||
    m.includes('tokens per day') ||
    m.includes('tpm') ||
    m.includes('tps')
  )
}

/**
 * Executa o ciclo chat ↔ tool calling e emite StreamEvents prontos para SSE.
 * Mantém contrato estável: consumer só precisa lidar com 'token', 'done', 'error'
 * — tool_calls são resolvidos internamente e realimentados ao modelo.
 */
export async function* runCopilot(opts: OrchestratorOptions): AsyncGenerator<StreamEvent, void, void> {
  const provider = opts.provider ?? (await resolveProvider())
  const messages: ChatMessage[] = [...opts.history, { role: 'user', content: opts.userPrompt }]

  const promptCtx = resolvePromptContext({
    userName: opts.userName || 'Usuário',
    userRole: opts.userRole,
    tenantId: opts.tenantId,
    monthlyGoal: opts.monthlyGoal,
  })
  const systemPrompt = buildDynamicSystemPrompt(promptCtx)

  console.log(`[copilot] provider=${provider.name} rounds=iniciando prompt="${opts.userPrompt.slice(0, 60)}"`)

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    console.log(`[copilot] round ${round + 1} de ${MAX_TOOL_ROUNDS}`)
    const toolCallsThisRound: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
    let assistantText = ''

    const stream = provider.stream({
      systemPrompt,
      messages,
      tools: TOOL_DEFINITIONS,
      signal: opts.signal,
    })

    for await (const evt of stream) {
      if (evt.type === 'token') {
        assistantText += evt.text
        yield evt
      } else if (evt.type === 'tool_call') {
        toolCallsThisRound.push(evt.call)
        // Não vazamos o tool_call para o cliente — é detalhe interno.
      } else if (evt.type === 'error') {
        console.error(`[copilot] erro: ${evt.message}`)
        const shouldFallbackLocal =
          provider.name !== 'local' &&
          (
            // fallback antigo (erro logo no início)
            (round === 0 && assistantText === '' && toolCallsThisRound.length === 0) ||
            // novo: fallback agressivo para cota/rate-limit em qualquer rodada
            isRateLimitLikeError(evt.message)
          )
        if (shouldFallbackLocal) {
          const { LocalProvider } = await import('./localProvider.js')
          const fallback = new LocalProvider()
          console.warn('[copilot] fallback para provider local por erro no provider remoto')
          yield* runCopilot({ ...opts, provider: fallback })
          return
        }
        yield evt
        return
      } else if (evt.type === 'done') {
        console.log(`[copilot] round ${round + 1} fim — text=${assistantText.length}ch tools=${toolCallsThisRound.length}`)
        break
      }
    }

    // Sem tool calls: resposta final
    if (toolCallsThisRound.length === 0) {
      yield { type: 'done' }
      return
    }

    // Registra a mensagem do assistente COM os tool_calls — formato OpenAI
    // exige: user → assistant{tool_calls} → tool{result} → assistant(texto).
    // Sem isso, o modelo não percebe que já pediu a tool e pede infinitamente.
    messages.push({
      role: 'assistant',
      content: assistantText,
      toolCalls: toolCallsThisRound.map((c) => ({ id: c.id, name: c.name, args: c.args })),
    })

    // Executa cada tool e anexa como mensagem role:'tool'
    for (const call of toolCallsThisRound) {
      console.log(`[copilot] executando tool: ${call.name}`, call.args)
      let result: unknown
      try {
        result = await executeTool(call.name, call.args, {
          userId: opts.userId,
          userRole: opts.userRole,
          tenantId: opts.tenantId,
        })
      } catch (err) {
        result = { error: `Falha ao executar ${call.name}: ${(err as Error).message}` }
      }
      messages.push({
        role: 'tool',
        toolName: call.name,
        toolCallId: call.id,
        content: JSON.stringify(result),
      })
    }
  }

  // Se saiu do loop por limite de rounds, emite fechamento limpo
  yield { type: 'done' }
}
