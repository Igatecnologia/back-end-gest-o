/**
 * Aplica mapeamento de campos (standardField ← sourceField + transform)
 * aos registros crus retornados por uma API externa.
 *
 * - Campos mapeados são renomeados; campos sem mapeamento passam inalterados.
 * - Transforms suportados: none, uppercase, lowercase, trim, number, date_iso.
 */

type FieldMapping = {
  standardField: string
  sourceField: string
  transform: string
}

function applyTransform(value: unknown, transform: string): unknown {
  if (value == null) return value
  switch (transform) {
    case 'uppercase':
      return typeof value === 'string' ? value.toUpperCase() : value
    case 'lowercase':
      return typeof value === 'string' ? value.toLowerCase() : value
    case 'trim':
      return typeof value === 'string' ? value.trim() : value
    case 'number': {
      if (typeof value === 'number') return value
      if (typeof value !== 'string') return value
      const normalized = value.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.')
      const n = Number(normalized)
      return Number.isFinite(n) ? n : value
    }
    case 'date_iso': {
      if (typeof value !== 'string') return value
      // Formatos comuns: DD/MM/YYYY, DD.MM.YYYY, YYYY.MM.DD, YYYY-MM-DD
      const brMatch = value.match(/^(\d{2})[/.](\d{2})[/.](\d{4})/)
      if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`
      const dotIso = value.match(/^(\d{4})\.(\d{2})\.(\d{2})/)
      if (dotIso) return `${dotIso[1]}-${dotIso[2]}-${dotIso[3]}`
      return value
    }
    default:
      return value
  }
}

export function applyFieldMappings(
  rows: unknown[],
  mappings: FieldMapping[],
): unknown[] {
  if (!mappings.length) return rows

  const mapBySource = new Map<string, { standardField: string; transform: string }>()
  for (const m of mappings) {
    mapBySource.set(m.sourceField, { standardField: m.standardField, transform: m.transform })
  }

  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row
    const src = row as Record<string, unknown>
    const out: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(src)) {
      const mapping = mapBySource.get(key)
      if (mapping) {
        out[mapping.standardField] = applyTransform(value, mapping.transform)
      } else {
        out[key] = value
      }
    }

    return out
  })
}
