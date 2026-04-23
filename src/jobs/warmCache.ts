/**
 * Warm Cache — mantém os dados mais acessados sempre em cache.
 *
 * Estratégia:
 * - Ao iniciar o backend, busca os endpoints principais em background (preload)
 * - A cada 12 minutos, re-busca para manter cache quente (TTL é 15min)
 * - Nunca bloqueia o boot — é fire-and-forget
 */
import { readAll } from '../storage.js'
import { fetchProxyDataForTool } from '../routes/proxy.js'

const WARM_INTERVAL_MS = 12 * 60_000 // 12 min (cache TTL é 15min — renova antes de expirar)
const INITIAL_DELAY_MS = 10_000 // 10s após boot — dá tempo do backend estabilizar

type WarmTarget = {
  label: string
  endpointHint: string
  query?: Record<string, string>
}

function formatSgbrDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '.')
}

function thirtyDaysAgo(): string {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return formatSgbrDate(d)
}

function today(): string {
  return formatSgbrDate(new Date())
}

/** Endpoints a manter quentes — os mais usados pelas telas */
const TARGETS: WarmTarget[] = [
  { label: 'vendas', endpointHint: '/sgbrbi/vendas/analitico', query: { dt_de: thirtyDaysAgo(), dt_ate: today() } },
  { label: 'produzido', endpointHint: '/sgbrbi/produzido', query: { dt_de: thirtyDaysAgo(), dt_ate: today() } },
  { label: 'estoque', endpointHint: '/sgbrbi/estoque' },
  { label: 'compras', endpointHint: '/sgbrbi/compras', query: { dt_de: thirtyDaysAgo(), dt_ate: today() } },
  { label: 'contas', endpointHint: '/sgbrbi/contas', query: { dt_de: thirtyDaysAgo(), dt_ate: today() } },
]

function findDsId(tenantId: string, hint: string): string | null {
  const all = readAll().filter((d) => d.tenantId === tenantId)
  const match = all.find((d) => {
    const ep = (d.dataEndpoint ?? '').toLowerCase()
    return ep.includes(hint)
  })
  return match?.id ?? null
}

async function warmOne(target: WarmTarget, tenantId: string): Promise<{ label: string; ms: number; rows: number; ok: boolean }> {
  const start = Date.now()
  const dsId = findDsId(tenantId, target.endpointHint)
  if (!dsId) return { label: target.label, ms: 0, rows: 0, ok: false }

  try {
    const result = await fetchProxyDataForTool({
      tenantId,
      dsId,
      query: { requireDsId: '1', ...target.query },
    })
    const ms = Date.now() - start
    const rows = result.ok ? result.rows.length : 0
    return { label: target.label, ms, rows, ok: result.ok }
  } catch {
    return { label: target.label, ms: Date.now() - start, rows: 0, ok: false }
  }
}

async function warmAll() {
  const tenantId = 'default'
  const all = readAll().filter((d) => d.tenantId === tenantId)
  if (all.length === 0) return // sem datasources, nada a fazer

  const startTotal = Date.now()
  console.log(`[IGA][WARM] Aquecendo cache para ${TARGETS.length} endpoints...`)

  // Executar em paralelo — todas as chamadas SGBR de uma vez
  const results = await Promise.all(TARGETS.map((t) => warmOne(t, tenantId)))

  const totalMs = Date.now() - startTotal
  const summary = results
    .filter((r) => r.ok)
    .map((r) => `${r.label}:${r.rows}rows/${Math.round(r.ms / 1000)}s`)
    .join(', ')
  const failed = results.filter((r) => !r.ok).map((r) => r.label)

  console.log(`[IGA][WARM] Concluído em ${Math.round(totalMs / 1000)}s — ${summary}${failed.length ? ` | sem fonte: ${failed.join(', ')}` : ''}`)
}

export function startWarmCacheJob() {
  // Preload após boot
  setTimeout(() => {
    warmAll().catch((err) => {
      console.error('[IGA][WARM] Erro no preload:', err instanceof Error ? err.message : err)
    })

    // Job periódico
    setInterval(() => {
      warmAll().catch((err) => {
        console.error('[IGA][WARM] Erro no warm:', err instanceof Error ? err.message : err)
      })
    }, WARM_INTERVAL_MS).unref()
  }, INITIAL_DELAY_MS).unref()
}
