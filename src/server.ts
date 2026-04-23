import 'dotenv/config'
import { createApp } from './app.js'

const app = createApp()
const PREFERRED_PORT = Number(process.env.PORT ?? 3000)
const MAX_PORT = Number(process.env.PORT_MAX ?? PREFERRED_PORT + 20)

function startServer(port: number) {
  const startedServer = app.listen(port, () => {
    console.log(`[IGA Backend] http://localhost:${port}`)
  })
  startedServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && port < MAX_PORT) {
      console.warn(`[IGA Backend] porta ${port} em uso, tentando ${port + 1}...`)
      server = startServer(port + 1)
      return
    }
    throw error
  })
  return startedServer
}

// Iniciar servidor com fallback de porta e graceful shutdown
let server = startServer(PREFERRED_PORT)

function shutdown(signal: string) {
  console.log(`[IGA Backend] ${signal} — encerrando...`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
