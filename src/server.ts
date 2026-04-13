import 'dotenv/config'
import { createApp } from './app.js'

const app = createApp()
const PORT = Number(process.env.PORT ?? 3000)

// Iniciar servidor com graceful shutdown
const server = app.listen(PORT, () => {
  console.log(`[IGA Backend] http://localhost:${PORT}`)
})

function shutdown(signal: string) {
  console.log(`[IGA Backend] ${signal} — encerrando...`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
