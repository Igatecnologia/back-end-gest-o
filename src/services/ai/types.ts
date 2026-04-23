export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ChatMessage = {
  role: ChatRole
  content: string
  /** Nome da tool quando role === 'tool' (resposta de tool call). */
  toolName?: string
  /** id correlato quando a resposta retorna toolCalls. */
  toolCallId?: string
  /** Quando role === 'assistant' e o modelo chamou tools — precisa ir no histórico
   *  ANTES das messages role='tool' para o modelo entender o ciclo. */
  toolCalls?: ToolCall[]
}

export type ToolParameterSchema = {
  type: 'object'
  properties: Record<string, {
    type: 'string' | 'number' | 'integer' | 'boolean'
    description?: string
    enum?: string[]
  }>
  required?: string[]
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: ToolParameterSchema
}

export type ToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type ChatRequest = {
  systemPrompt: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
}

export interface AiProvider {
  readonly name: 'groq' | 'local'
  readonly displayName: string
  /**
   * Gera stream de eventos. O provider é responsável por:
   * - emitir 'token' para tokens de texto
   * - emitir 'tool_call' quando o modelo solicita uma ferramenta
   * - emitir 'done' ao finalizar
   * - emitir 'error' em falhas irrecuperáveis (caller trata fallback)
   */
  stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void>
  isAvailable(): Promise<boolean>
}
