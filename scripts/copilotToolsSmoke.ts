import { executeTool } from '../src/services/ai/tools.js'

async function main() {
  const ctxAdmin = { userId: 'u_test', userRole: 'admin', tenantId: 'default' as const }
  const ctxViewer = { userId: 'u_test', userRole: 'viewer', tenantId: 'default' as const }

  console.log('\n=== get_overview (admin) ===')
  console.log(await executeTool('get_overview', {}, ctxAdmin))

  console.log('\n=== get_datasources (admin) ===')
  console.log(await executeTool('get_datasources', { limit: 5 }, ctxAdmin))

  console.log('\n=== get_alerts (admin) ===')
  console.log(await executeTool('get_alerts', { limit: 3, onlyUnread: true }, ctxAdmin))

  console.log('\n=== get_proxy_status (admin) ===')
  console.log(await executeTool('get_proxy_status', {}, ctxAdmin))

  console.log('\n=== get_scheduled_reports (admin) ===')
  console.log(await executeTool('get_scheduled_reports', { limit: 5 }, ctxAdmin))

  console.log('\n=== get_audit_log (admin) ===')
  console.log(await executeTool('get_audit_log', { limit: 3 }, ctxAdmin))

  console.log('\n=== get_users (viewer -> should be denied) ===')
  console.log(await executeTool('get_users', { limit: 5 }, ctxViewer))

  console.log('\n=== get_audit_log (viewer -> should be denied) ===')
  console.log(await executeTool('get_audit_log', { limit: 3 }, ctxViewer))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

