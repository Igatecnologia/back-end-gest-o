/**
 * Bloqueio SSRF para URLs registradas em datasources.
 *
 * Recusa hosts que apontem para redes privadas, loopback, link-local ou
 * endpoints de metadados cloud (AWS/GCP/Azure). Admin malicioso poderia
 * apontar `apiUrl` para serviços internos se não validássemos.
 *
 * Para permitir uma faixa específica (ex.: integração LAN legítima), basta
 * listar o host em `ALLOW_PRIVATE_HOSTS` (env, CSV). Default: bloquear tudo.
 */

const PRIVATE_V4_PATTERNS = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64/10
]

function isPrivateIPv4(host: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false
  return PRIVATE_V4_PATTERNS.some((re) => re.test(host))
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  /** ::ffff:a.b.c.d (IPv4-mapped) */
  const m = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (m) return isPrivateIPv4(m[1])
  return false
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  /** Metadata endpoints comuns — mesmo que apontem para IPs públicos, bloqueamos hostnames sentinela. */
  if (h === 'metadata.google.internal' || h === 'metadata') return true
  return false
}

function hostFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return null
  }
}

function allowedOverride(host: string): boolean {
  const raw = process.env.ALLOW_PRIVATE_HOSTS?.trim()
  if (!raw) return false
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return list.includes(host.toLowerCase())
}

export type UrlSafetyReason = 'invalid_url' | 'loopback_or_private_ipv4' | 'private_ipv6' | 'blocked_hostname'

export function validateExternalApiUrl(url: string): { ok: true } | { ok: false; reason: UrlSafetyReason; message: string } {
  const host = hostFromUrl(url)
  if (!host) return { ok: false, reason: 'invalid_url', message: 'URL da API inválida.' }
  if (allowedOverride(host)) return { ok: true }
  if (isPrivateIPv4(host)) {
    return {
      ok: false,
      reason: 'loopback_or_private_ipv4',
      message: `Host "${host}" está em faixa privada/loopback. Use a URL pública da API ou libere via ALLOW_PRIVATE_HOSTS.`,
    }
  }
  if (isPrivateIPv6(host)) {
    return {
      ok: false,
      reason: 'private_ipv6',
      message: `Host IPv6 "${host}" está em faixa privada/loopback.`,
    }
  }
  if (isBlockedHostname(host)) {
    return {
      ok: false,
      reason: 'blocked_hostname',
      message: `Host "${host}" está bloqueado (loopback/metadados cloud).`,
    }
  }
  return { ok: true }
}
