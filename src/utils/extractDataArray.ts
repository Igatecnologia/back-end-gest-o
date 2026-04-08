/**
 * Extrai o array de dados de uma resposta de API, independente do formato.
 * Suporta: array direto, { items: [...] }, { data: [...] }, { rows: [...] }, etc.
 */
export function extractDataArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    for (const key of ['items', 'data', 'rows', 'results', 'records', 'content', 'list', 'entries', 'valores', 'registros']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }
    const keys = Object.keys(obj)
    if (keys.length === 1 && Array.isArray(obj[keys[0]])) {
      return obj[keys[0]] as unknown[]
    }
  }
  return []
}
