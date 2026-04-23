/**
 * Extrai o array de dados de uma resposta de API, independente do formato.
 * Suporta: array direto, { items: [...] }, { data: [...] }, { rows: [...] }, etc.
 */
export function extractDataArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    const preferredKeys = [
      'items',
      'data',
      'result',
      'resultado',
      'rows',
      'results',
      'records',
      'content',
      'list',
      'values',
      'value',
      'itens',
      'retorno',
      'entries',
      'valores',
      'registros',
      'dados',
      'titulos',
      'linhas',
      'contas',
      'titulosPagos',
      'payload',
    ]
    for (const key of preferredKeys) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[]
    }

    // Alguns provedores encapsulam a lista em 1-2 níveis ({ data: { items: [] } }).
    for (const value of Object.values(obj)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const nested = value as Record<string, unknown>
      for (const key of preferredKeys) {
        if (Array.isArray(nested[key])) return nested[key] as unknown[]
      }
      for (const nestedValue of Object.values(nested)) {
        if (Array.isArray(nestedValue)) return nestedValue as unknown[]
      }
    }

    const keys = Object.keys(obj)
    if (keys.length === 1 && Array.isArray(obj[keys[0]])) {
      return obj[keys[0]] as unknown[]
    }
  }
  return []
}
