/**
 * Junta base da API + path relativo, evitando `//` no meio (ex.: suporte manda `//sgbrbi/...` por engano).
 */
export function joinApiUrl(baseUrl: string, path: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '')
  let p = path.trim()
  if (!p) return b
  p = p.replace(/^\/+/, '/')
  return `${b}${p}`
}
