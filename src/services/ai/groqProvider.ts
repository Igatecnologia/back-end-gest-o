import { randomUUID } from 'node:crypto'
import type { AiProvider, ChatMessage, ChatRequest, StreamEvent, ToolDefinition } from './types.js'

/**
 * Groq — API OpenAI-compatible, tier gratuito generoso (30 rpm, 14.400 rpd)
 * em modelos Llama. Endpoint: https://api.groq.com/openai/v1/chat/completions
 */

const DEFAULT_MODEL = 'llama-3.3-70b-versatile'
const BASE_URL = 'https://api.groq.com/openai/v1'

/**
 * Alguns Llamas (3.1 8B em especial) ignoram o canal nativo de tool_calls e
 * emitem `<function=NOME args_key=val ...></function>` como TEXTO no content.
 * Interceptamos esse padrão, convertemos em tool_call e removemos do texto
 * visível ao cliente.
 */
const FN_TAG = /<function=([a-zA-Z_][\w]*)\s*([^>]*)>\s*<\/function>/g

function parseInlineArgs(rawArgs: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // padrão: key=value | key="value" | key='value'
  const re = /([a-zA-Z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rawArgs)) !== null) {
    const key = m[1]
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    const num = Number(val)
    if (val === 'true') out[key] = true
    else if (val === 'false') out[key] = false
    else if (val !== '' && !Number.isNaN(num)) out[key] = num
    else out[key] = val
  }
  return out
}

type OpenAiToolCall = {
  id?: string
  index?: number
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
  name?: string
}

type OpenAiChunk = {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: OpenAiToolCall[] }
    finish_reason?: string | null
  }>
  error?: { message?: string; type?: string }
}

/**
 * Llama 3.x via Groq ocasionalmente emite tool calls com o JSON dos argumentos
 * concatenado no nome da função: `get_overview{"x":1}` em vez de `get_overview`
 * + argumentos separados. Quando detectado, cortamos no primeiro `{`, movemos
 * o sufixo para args e fazemos parse JSON.
 */
function normalizeToolCall(call: { id: string; name: string; argsJson: string }): {
  id: string
  name: string
  args: Record<string, unknown>
} {
  let name = call.name.trim()
  let argsJson = call.argsJson
  const braceIdx = name.indexOf('{')
  if (braceIdx > 0) {
    const stuffed = name.slice(braceIdx)
    name = name.slice(0, braceIdx).trim()
    if (!argsJson || argsJson.trim() === '' || argsJson.trim() === '{}') {
      argsJson = stuffed
    }
  }
  let args: Record<string, unknown> = {}
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
  } catch {
    args = {}
  }
  return { id: call.id, name, args }
}

function describeGroqError(status: number): string {
  switch (status) {
    case 400: return 'Groq 400 — requisição inválida.'
    case 401: return 'Groq 401 — chave inválida. Confira em console.groq.com/keys.'
    case 403: return 'Groq 403 — sem permissão para este modelo.'
    case 404: return 'Groq 404 — modelo não encontrado. Tente "llama-3.3-70b-versatile".'
    case 429: return 'Groq 429 — cota excedida (30/min ou 14.400/dia). Aguarde 1 min.'
    case 500:
    case 502:
    case 503: return `Groq ${status} — instabilidade do servidor. Tente novamente.`
    default: return `Groq HTTP ${status}`
  }
}

function toOpenAiMessages(systemPrompt: string, messages: ChatMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId ?? m.toolName ?? 'unknown',
        name: m.toolName,
      })
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      // Assistant que invocou tools: content pode ser string vazia, mas tool_calls
      // deve estar presente pra API saber que o próximo "tool" é resposta a ESTAS calls.
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      })
    } else if (m.role !== 'system') {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

function toOpenAiTools(tools?: ToolDefinition[]) {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

export class GroqProvider implements AiProvider {
  readonly name = 'groq' as const
  readonly displayName = 'Groq (gratuito, rápido)'
  private readonly apiKey: string
  private readonly model: string

  constructor(apiKey: string, model: string = DEFAULT_MODEL) {
    this.apiKey = apiKey
    this.model = model
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey)
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const body = {
      model: this.model,
      messages: toOpenAiMessages(req.systemPrompt, req.messages),
      tools: toOpenAiTools(req.tools),
      stream: true,
      temperature: 0.3,
      max_tokens: 800,
    }

    let response: Response
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      })
    } catch (err) {
      yield { type: 'error', message: `Falha de rede Groq: ${(err as Error).message}` }
      return
    }

    if (!response.ok || !response.body) {
      let detail = ''
      if (response.status >= 400 && response.status < 500 && response.status !== 401) {
        try {
          const txt = await response.text()
          const match = /"message":\s*"([^"]+)"/.exec(txt)
          detail = match?.[1] ?? txt.slice(0, 200)
          console.error('[groq]', response.status, detail)
        } catch {
          /* ignora */
        }
      }
      const base = describeGroqError(response.status)
      yield { type: 'error', message: detail ? `${base} Detalhe: ${detail}` : base }
      return
    }

    /**
     * Tool calls em OpenAI streaming chegam fragmentados: o `index` identifica
     * cada call, e os campos (name, arguments) vão sendo concatenados ao longo
     * dos chunks. Buferizamos até o finish_reason='tool_calls' para emitir
     * tool_call completo.
     */
    const toolBuffers = new Map<number, { id: string; name: string; argsJson: string }>()

    /**
     * Buffer do texto emitido: só liberamos ao cliente trechos seguros —
     * retemos o final enquanto pode fazer parte de uma tag `<function=...>`
     * ainda não fechada.
     */
    let textBuf = ''
    const emitText = (flush: boolean): StreamEvent[] => {
      const events: StreamEvent[] = []
      FN_TAG.lastIndex = 0
      let match: RegExpExecArray | null
      let lastEnd = 0
      const matches: Array<{ start: number; end: number; name: string; args: Record<string, unknown> }> = []
      while ((match = FN_TAG.exec(textBuf)) !== null) {
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          name: match[1],
          args: parseInlineArgs(match[2]),
        })
      }
      for (const m of matches) {
        const before = textBuf.slice(lastEnd, m.start)
        if (before) events.push({ type: 'token', text: before })
        events.push({ type: 'tool_call', call: { id: randomUUID(), name: m.name, args: m.args } })
        lastEnd = m.end
      }
      let tail = textBuf.slice(lastEnd)
      if (!flush) {
        // Segura últimos caracteres que podem ser início de tag
        const lt = tail.lastIndexOf('<')
        if (lt !== -1 && !tail.includes('</function>', lt)) {
          const held = tail.slice(lt)
          tail = tail.slice(0, lt)
          textBuf = held
        } else {
          textBuf = ''
        }
      } else {
        textBuf = ''
      }
      if (tail) events.push({ type: 'token', text: tail })
      return events
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let chunk: OpenAiChunk
        try {
          chunk = JSON.parse(payload) as OpenAiChunk
        } catch {
          continue
        }
        if (chunk.error) {
          const errMsg = chunk.error.message ?? 'Erro desconhecido Groq'
          /**
           * Groq valida tool_calls server-side. Quando o modelo emite nome
           * malformado ("get_overview{}"), o erro chega como string contendo
           * "tool 'NAME' which was not in request.tools". Recuperamos o
           * nome-base e sintetizamos um tool_call válido em vez de falhar.
           */
          const salvage = /tool '([^']+)'/.exec(errMsg)
          if (salvage) {
            const rawName = salvage[1]
            const braceIdx = rawName.indexOf('{')
            const cleanName = (braceIdx > 0 ? rawName.slice(0, braceIdx) : rawName).trim()
            const stuffedArgs = braceIdx > 0 ? rawName.slice(braceIdx) : '{}'
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(stuffedArgs) as Record<string, unknown>
            } catch {
              args = {}
            }
            console.warn('[groq] recuperando tool_call malformado:', rawName, '→', cleanName)
            yield { type: 'tool_call', call: { id: randomUUID(), name: cleanName, args } }
            yield { type: 'done' }
            return
          }
          yield { type: 'error', message: errMsg }
          return
        }
        const choice = chunk.choices?.[0]
        const text = choice?.delta?.content
        if (text) {
          textBuf += text
          for (const evt of emitText(false)) yield evt
        }

        const tcs = choice?.delta?.tool_calls ?? []
        for (const tc of tcs) {
          const idx = tc.index ?? 0
          const current = toolBuffers.get(idx) ?? { id: tc.id ?? randomUUID(), name: '', argsJson: '' }
          if (tc.id) current.id = tc.id
          if (tc.function?.name) current.name += tc.function.name
          if (tc.function?.arguments) current.argsJson += tc.function.arguments
          toolBuffers.set(idx, current)
        }

        if (choice?.finish_reason === 'tool_calls') {
          for (const call of toolBuffers.values()) {
            yield { type: 'tool_call', call: normalizeToolCall(call) }
          }
          toolBuffers.clear()
        }
      }
    }
    // Flush final: libera resíduo de texto e qualquer tool_call pendente no buffer
    for (const evt of emitText(true)) yield evt
    yield { type: 'done' }
  }
}
