/**
 * Host header allowlist against DNS rebinding.
 *
 * Every API route is unauthenticated and trusts the LAN. A page on an
 * attacker-controlled domain can rebind that domain to the pod's IP; the
 * browser then treats the pod as same-origin and sends matching Origin and
 * Host headers, so Origin === Host checks pass. The attacker's DNS name still
 * shows up in Host, so rejecting Host values that are not pod addresses
 * closes the hole.
 *
 * Allowed:
 * - IP literals (IPv4, bracketed IPv6) — rebinding needs a DNS name.
 * - Single-label names (`localhost`, `eight-pod`) — not resolvable via public DNS.
 * - Names under non-public suffixes: .local, .lan, .home.arpa, .internal, .localhost.
 * - Entries from SLEEPYPOD_ALLOWED_HOSTS (comma-separated, exact host or `*.suffix`).
 */

export const ALLOWED_HOSTS_ENV = 'SLEEPYPOD_ALLOWED_HOSTS'

const PRIVATE_SUFFIXES = ['.local', '.lan', '.home.arpa', '.internal', '.localhost']

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const IPV6_BRACKETED = /^\[[0-9a-f:.]*:[0-9a-f:.]*\]$/
const SINGLE_LABEL = /^[a-z0-9_-]+$/
const HOST_WITH_PORT = /^(\[[^\]]*\]|[^:]+)(?::(\d{1,5}))?$/

/** Splits `host[:port]` into its lowercased hostname, or null when malformed. */
export function hostnameOf(host: string): string | null {
  const match = HOST_WITH_PORT.exec(host.trim().toLowerCase())
  if (!match) return null
  // A trailing dot is the same name in absolute form (`pod.local.`).
  return match[1].endsWith('.') ? match[1].slice(0, -1) : match[1]
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
}

function matchesEntry(host: string, hostname: string, entry: string): boolean {
  if (entry.startsWith('*.')) {
    return hostname.endsWith(entry.slice(1))
  }
  return entry === hostname || entry === host
}

export function isHostAllowed(host: string, extraHosts: readonly string[] = []): boolean {
  const normalized = host.trim().toLowerCase()
  const hostname = hostnameOf(normalized)
  if (!hostname) return false

  if (IPV4.test(hostname) || IPV6_BRACKETED.test(hostname)) return true
  if (SINGLE_LABEL.test(hostname)) return true
  if (PRIVATE_SUFFIXES.some(suffix => hostname.endsWith(suffix))) return true

  return extraHosts.some(entry => matchesEntry(normalized, hostname, entry))
}

// DNS-rebinding guard for proxy.ts and routes it skips. A request without a
// Host header passes: Node rejects HTTP/1.1 requests that lack one, and the
// browsers that carry a rebinding attack always send it, so only HTTP/1.0
// tools get here without one. The Vercel demo is served from a public domain
// with no pod behind it, so it skips the check.
export function rejectUnknownHost(request: Request): Response | undefined {
  if (process.env.NEXT_PUBLIC_DEMO === '1') return
  const host = request.headers.get('host')
  if (host === null) return
  if (isHostAllowed(host, parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV]))) return
  return new Response(
    `Host not allowed. Use the pod's IP address, or add this host to ${ALLOWED_HOSTS_ENV}.\n`,
    { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  )
}
