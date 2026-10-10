/**
 * In-memory prime completion notification state.
 * Set when DacMonitor detects isPriming transition from true → false.
 * Cleared when iOS client dismisses via API.
 *
 * State lives on globalThis: this module is bundled into multiple chunks
 * (instrumentation runtime + every API route runtime) by Turbopack, so
 * per-chunk `let` would let the DAC monitor write to one copy while the
 * homekit prime switch / device router read from another.
 */

const G = globalThis as Record<string, unknown>
const KEYS = {
  completedAt: '__sp_prime_completedAt__',
  wasPriming: '__sp_prime_wasPriming__',
  requests: '__sp_prime_requests__',
} as const

// RAW pump motion can precede the first status poll that reports priming.
// Cover command dispatch through that poll so it cannot establish heating-run
// evidence on an otherwise idle side. This does not suppress an armed guard.
// The bound applies while dispatch is in flight too: the transport can hold a
// command in its queue across a firmware disconnect, and an unbounded intent
// would leave a real heating run unconfirmed.
const PRIME_STATUS_WAIT_MS = 90_000
interface PrimeRequest { expiresAt: number }

function requests(): Set<PrimeRequest> {
  const existing = G[KEYS.requests] as Set<PrimeRequest> | undefined
  if (existing) return existing
  const pending = new Set<PrimeRequest>()
  G[KEYS.requests] = pending
  return pending
}

/** Call before dispatch; finish only this request on ACK or failure. */
export function beginPrimingCommand(): (succeeded: boolean) => void {
  const pending = requests()
  const request: PrimeRequest = { expiresAt: performance.now() + PRIME_STATUS_WAIT_MS }
  pending.add(request)
  return (succeeded) => {
    const now = performance.now()
    if (succeeded && now < request.expiresAt) request.expiresAt = now + PRIME_STATUS_WAIT_MS
    else pending.delete(request)
  }
}

export function isPrimingRequested(): boolean {
  const pending = requests()
  for (const request of pending) {
    if (performance.now() >= request.expiresAt) pending.delete(request)
  }
  return pending.size > 0
}

export function trackPrimingState(isPriming: boolean): void {
  if (isPriming) requests().clear()
  const wasPriming = Boolean(G[KEYS.wasPriming])
  if (!wasPriming && isPriming) {
    // New priming cycle — clear stale notification
    G[KEYS.completedAt] = null
  }
  else if (wasPriming && !isPriming) {
    G[KEYS.completedAt] = new Date()
  }
  G[KEYS.wasPriming] = isPriming
}

export function getPrimeCompletedAt(): number | null {
  const d = G[KEYS.completedAt] as Date | null | undefined
  return d instanceof Date ? Math.floor(d.getTime() / 1000) : null
}

export function dismissPrimeNotification(): void {
  G[KEYS.completedAt] = null
}

export function resetPrimingState(): void {
  requests().clear()
  G[KEYS.completedAt] = null
  G[KEYS.wasPriming] = false
}
