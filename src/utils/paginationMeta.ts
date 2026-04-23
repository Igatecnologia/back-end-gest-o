/**
 * Metadados de paginação em respostas JSON.
 * Suporta: page/pagina, offset/limit, cursor — detecta metadata aninhada.
 */

export type PaginationStyle = 'page' | 'offset' | 'cursor' | 'none'

export type PaginationState = {
  style: PaginationStyle
  nextPage?: number
  totalPages?: number
  currentPage?: number
  perPage?: number
  totalRows?: number
  /** Para cursor-based pagination */
  nextCursor?: string
  /** Offset atual (para offset/limit) */
  currentOffset?: number
}

/**
 * Funde camadas da resposta para encontrar metadados de paginação.
 * Suporta metadata aninhada: meta, _meta, pagination, paging, links, paginator.
 */
function mergePayloadLayers(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>
  const metaKeys = ['meta', '_meta', 'pagination', 'paging', 'paginator', 'page_info', 'pageInfo']
  let merged: Record<string, unknown> = {}
  for (const key of metaKeys) {
    const val = obj[key]
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      merged = { ...merged, ...(val as Record<string, unknown>) }
    }
  }
  // links.next pode conter URL ou cursor
  if (obj.links && typeof obj.links === 'object' && !Array.isArray(obj.links)) {
    const links = obj.links as Record<string, unknown>
    if (typeof links.next === 'string') merged.linksNext = links.next
  }
  return { ...merged, ...obj }
}

const n = (x: unknown): number | undefined => {
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && /^\d+$/.test(x)) {
    const v = Number(x)
    return Number.isFinite(v) ? v : undefined
  }
  return undefined
}

const s = (x: unknown): string | undefined => {
  if (typeof x === 'string' && x.length > 0) return x
  return undefined
}

function detectCurrentPage(layer: Record<string, unknown>): number | undefined {
  return (
    n(layer.page) ??
    n(layer.pagina) ??
    n(layer.current_page) ??
    n(layer.currentPage) ??
    (n(layer.p) != null && (n(layer.p) as number) >= 1 && (n(layer.p) as number) <= 100_000
      ? n(layer.p)
      : undefined)
  )
}

function detectPerPage(layer: Record<string, unknown>): number | undefined {
  return (
    n(layer.per_page) ??
    n(layer.perPage) ??
    n(layer.limit) ??
    n(layer.tamanho) ??
    n(layer.page_size) ??
    n(layer.pageSize) ??
    n(layer.size) ??
    n(layer.registrosPorPagina) ??
    n(layer.registros_por_pagina) ??
    n(layer.rows_per_page) ??
    n(layer.rowsPerPage) ??
    n(layer.count)
  )
}

function detectTotalRows(layer: Record<string, unknown>): number | undefined {
  return (
    n(layer.total) ??
    n(layer.total_registros) ??
    n(layer.totalRows) ??
    n(layer.total_count) ??
    n(layer.totalCount) ??
    n(layer.total_items) ??
    n(layer.totalItems) ??
    n(layer.qt_registros) ??
    n(layer.qtd_registros) ??
    n(layer.record_count) ??
    n(layer.recordCount)
  )
}

function detectTotalPages(layer: Record<string, unknown>): number | undefined {
  return (
    n(layer.totalPages) ??
    n(layer.total_paginas) ??
    n(layer.last_page) ??
    n(layer.total_pages) ??
    n(layer.lastPage) ??
    n(layer.page_count) ??
    n(layer.pageCount) ??
    n(layer.pages)
  )
}

function detectNextCursor(layer: Record<string, unknown>): string | undefined {
  return (
    s(layer.next_cursor) ??
    s(layer.nextCursor) ??
    s(layer.cursor) ??
    s(layer.after) ??
    s(layer.end_cursor) ??
    s(layer.endCursor) ??
    s(layer.next_page_token) ??
    s(layer.nextPageToken) ??
    s(layer.continuation_token) ??
    s(layer.continuationToken)
  )
}

function detectOffset(layer: Record<string, unknown>): number | undefined {
  return n(layer.offset) ?? n(layer.skip)
}

function detectHasMore(layer: Record<string, unknown>): boolean | undefined {
  const val = layer.has_more ?? layer.hasMore ?? layer.has_next ?? layer.hasNext ?? layer.hasNextPage
  if (typeof val === 'boolean') return val
  return undefined
}

/** Extrai cursor de uma URL (links.next), se houver */
function extractCursorFromUrl(url: string, cursorParams: string[]): string | undefined {
  try {
    const u = new URL(url, 'http://dummy')
    for (const p of cursorParams) {
      const val = u.searchParams.get(p)
      if (val) return val
    }
  } catch { /* não é URL válida — pode ser o próprio cursor */ }
  return url
}

/**
 * Interpreta JSON da resposta e resolve metadata de paginação.
 * Detecta automaticamente o estilo: page, offset, cursor ou none.
 */
export function resolvePaginationState(
  payload: unknown,
  firstRowCount: number,
  queryParams: URLSearchParams,
  configHints?: {
    paginationStyle?: PaginationStyle
    pageParam?: string
    perPageParam?: string
    cursorParam?: string
    cursorResponseField?: string
  },
): PaginationState {
  const layer = mergePayloadLayers(payload)
  const qPer = parseInt(
    queryParams.get('tamanho') || queryParams.get('per_page') || queryParams.get('perPage') ||
    queryParams.get('limit') || queryParams.get('page_size') || queryParams.get('pageSize') ||
    queryParams.get('size') || queryParams.get('count') || '',
    10,
  )

  const hintStyle = configHints?.paginationStyle

  if (!layer) {
    const per = Number.isFinite(qPer) && qPer > 0 ? qPer : undefined
    if (per && firstRowCount > 0 && firstRowCount === per) {
      return { style: hintStyle ?? 'page', nextPage: 2, currentPage: 1, totalPages: undefined, perPage: per, totalRows: undefined }
    }
    return { style: 'none' }
  }

  // --- Cursor detection ---
  const nextCursor = configHints?.cursorResponseField
    ? s(layer[configHints.cursorResponseField])
    : detectNextCursor(layer)

  const linksNext = s(layer.linksNext)
  const hasMore = detectHasMore(layer)

  if (hintStyle === 'cursor' || (!hintStyle && (nextCursor || (linksNext && !detectCurrentPage(layer))))) {
    const cursor = nextCursor ?? (linksNext
      ? extractCursorFromUrl(linksNext, ['cursor', 'after', 'next_cursor', 'page_token', 'continuation_token'])
      : undefined)
    return {
      style: 'cursor',
      nextCursor: hasMore === false ? undefined : cursor,
      totalRows: detectTotalRows(layer),
      perPage: detectPerPage(layer) ?? (Number.isFinite(qPer) && qPer > 0 ? qPer : undefined),
    }
  }

  // --- Offset/limit detection ---
  const offset = detectOffset(layer)

  if (hintStyle === 'offset' || (!hintStyle && offset != null)) {
    const totalRows = detectTotalRows(layer)
    let perPage = detectPerPage(layer) ?? (Number.isFinite(qPer) && qPer > 0 ? qPer : undefined)
    let nextOffset: number | undefined
    if (totalRows != null && perPage != null) {
      const nextOff = (offset ?? 0) + perPage
      nextOffset = nextOff < totalRows ? nextOff : undefined
    } else if (hasMore === true && perPage) {
      nextOffset = (offset ?? 0) + perPage
    } else if (firstRowCount > 0 && perPage && firstRowCount === perPage) {
      nextOffset = (offset ?? 0) + perPage
    }
    return {
      style: 'offset',
      currentOffset: offset ?? 0,
      perPage,
      totalRows,
      nextPage: nextOffset != null ? Math.floor(nextOffset / (perPage ?? firstRowCount)) + 1 : undefined,
    }
  }

  // --- Page-based (default) ---
  const currentPage = detectCurrentPage(layer)
  let perPage = detectPerPage(layer)
  const totalRows = detectTotalRows(layer)
  let totalPages = detectTotalPages(layer)

  if (totalPages == null && totalRows != null && perPage != null && perPage > 0) {
    totalPages = Math.max(1, Math.ceil(totalRows / perPage))
  }

  if (perPage == null && Number.isFinite(qPer) && qPer > 0) perPage = qPer

  let nextPage = n(layer.nextPage) ?? n(layer.next_page)

  const cur = currentPage ?? 1
  if (nextPage == null && totalPages != null && cur < totalPages) {
    nextPage = cur + 1
  }

  if (totalRows != null && firstRowCount >= totalRows) {
    return {
      style: 'page',
      nextPage: undefined,
      totalPages: totalPages ?? 1,
      currentPage: cur,
      perPage,
      totalRows,
    }
  }

  // API não enviou metadados, mas a lista tem exatamente o tamanho de página esperado → tentar próxima
  if (nextPage == null && firstRowCount > 0) {
    const effectivePer =
      perPage ??
      (Number.isFinite(qPer) && qPer > 0 ? qPer : undefined) ??
      (firstRowCount >= 10 ? firstRowCount : undefined)

    if (
      effectivePer &&
      firstRowCount === effectivePer &&
      cur === 1 &&
      (totalPages == null || totalPages > 1)
    ) {
      nextPage = 2
      if (!perPage) perPage = effectivePer
    }
  }

  if (hasMore === true && nextPage == null) {
    nextPage = cur + 1
  }

  return {
    style: 'page',
    nextPage,
    totalPages,
    currentPage: cur,
    perPage,
    totalRows,
  }
}

/** Para respostas subsequentes no loop sequencial: só precisa do próximo índice. */
export function resolvePaginationStateSequential(
  payload: unknown,
  rowCount: number,
  queryParams: URLSearchParams,
  configHints?: Parameters<typeof resolvePaginationState>[3],
): Pick<PaginationState, 'nextPage' | 'totalPages' | 'currentPage' | 'nextCursor' | 'style'> {
  const s = resolvePaginationState(payload, rowCount, queryParams, configHints)
  return {
    style: s.style,
    nextPage: s.nextPage,
    totalPages: s.totalPages,
    currentPage: s.currentPage,
    nextCursor: s.nextCursor,
  }
}
