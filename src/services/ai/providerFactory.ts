import { GroqProvider } from './groqProvider.js'
import { LocalProvider } from './localProvider.js'
import { getCopilotConfig } from './copilotConfigStore.js'
import type { AiProvider } from './types.js'

type ProviderName = 'groq' | 'local' | 'auto'

/**
 * Resolução de config com precedência: env var > SQLite > default.
 * Ordem em modo "auto": groq (se chave) → local (sempre).
 */
export async function resolveProvider(): Promise<AiProvider> {
  const dbConfig = getCopilotConfig()

  const configured = (process.env.COPILOT_PROVIDER ?? dbConfig.provider ?? 'auto').toLowerCase() as ProviderName
  const groqKey = (process.env.GROQ_API_KEY?.trim() || dbConfig.groqApiKey) ?? null
  const groqModel = process.env.GROQ_MODEL?.trim() || dbConfig.groqModel || 'llama-3.3-70b-versatile'

  const groq = groqKey ? new GroqProvider(groqKey, groqModel) : null
  const local = new LocalProvider()

  const chain: AiProvider[] = []
  if (configured === 'groq' && groq) chain.push(groq)
  else if (configured === 'local') chain.push(local)
  else if (groq) chain.push(groq)
  chain.push(local)

  for (const p of chain) {
    if (await p.isAvailable()) return p
  }
  return local
}
