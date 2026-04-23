import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve o diretório de dados persistentes (users.json, datasources.json).
 *
 * - `IGA_DATA_DIR` (env): override explícito — ideal para instalação Windows,
 *   onde os dados ficam em `C:\ProgramData\IgaGestao\data` (escrita irrestrita,
 *   sobrevive a desinstalação).
 * - Caso contrário: mantém o comportamento legado (`<backend>/data/`).
 *
 * A função é resiliente a bundling: usa `import.meta.url` quando disponível,
 * senão cai no `process.cwd()` — esta última branch só executa em ambientes
 * bem atípicos (ex.: single-file bundle sem suporte a ESM URLs).
 */
export function resolveDataDir(): string {
  const env = process.env.IGA_DATA_DIR?.trim()
  if (env) return env
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return join(here, '..', 'data')
  } catch {
    return join(process.cwd(), 'data')
  }
}
