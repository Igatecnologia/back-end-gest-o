import { getDbPath } from '../src/db/sqlite.js'

console.log(`[IGA] SQLite pronto em: ${getDbPath()}`)
console.log('[IGA] Migração JSON -> SQLite executada automaticamente no bootstrap do banco.')
