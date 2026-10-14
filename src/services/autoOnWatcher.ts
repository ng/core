/**
 * Auto-On Watcher Service (experimental)
 *
 * Powers a side on once a PERSON has been in bed for `autoOnMinutes`, using the
 * same live occupancy sensor as auto-off (`src/lib/occupancy.ts`). The mirror
 * image of `autoOffWatcher`, with the guardrails inverted: auto-off must never
 * act on missing data, auto-on must never energize a bed nobody wants on.
 *
 *   - Fires only on `classification === 'person'`. A pet (single-zone load, no
 *     human vitals) never turns the bed on; see `OccupancyClassification`.
 *   - Dwell: the person must be present continuously for `autoOnMinutes`
 *     (default 5) so a sit-down or a passing cat doesn't trip it.
 *   - Window: only between `autoOnStart` and `autoOnEnd` local time (default
 *     20:00–08:00, wraps midnight; equal times mean any time), so an afternoon
 *     nap doesn't fire unless the user widens it.
 *   - Suppression: a side that goes OFF while a person is still in it — a
 *     manual power-off, a scheduled power-off, the global cap — was turned off
 *     on purpose. Auto-on stands down until the bed has read non-person for
 *     `autoOnMinutes`, so it can't bounce the bed straight back on.
 *   - Away mode, an active run-once session, and the pump-stall guard each
 *     block it, as they do the scheduler's power-on paths.
 *   - Unsensable presence (no fresh capSense2 frame / no calibration) resets
 *     the dwell and never fires.
 *
 * Setpoint: `powerOnLocked` resolves the temperature from the controller's
 * baseline (an active or upcoming schedule), falling back to the last target
 * this watcher saw while the side was powered, then 75°F. Auto-on therefore
 * behaves like an early schedule start, not a separate temperature preference.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceSettings, deviceState, runOnceSessions, sideSettings } from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { markSideMutated } from '@/src/hardware/deviceStateSync'
import { shouldBlock as pumpStallShouldBlock } from '@/src/hardware/pumpStallGuard'
import { withSideLock } from '@/src/hardware/sideLock'
import { getOccupancy } from '@/src/lib/occupancy'
import { getJobManager } from '@/src/scheduler/instance'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { getTemperatureController } from '@/src/temperature/instance'
import { cancelAutoOffTimer } from './autoOffWatcher'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000
const SIDES = ['left', 'right'] as const
type Side = (typeof SIDES)[number]

const DEFAULT_FALLBACK_TEMP_F = 75

// ---------------------------------------------------------------------------
// Per-side state
// ---------------------------------------------------------------------------

interface SideState {
  /** First poll that saw a person in an OFF side; the dwell countdown anchor. */
  personSince: number | null
  /** The side was turned off while a person was in it; hold off until the bed clears. */
  suppressed: boolean
  /** First poll that saw non-person while suppressed; clears suppression after the dwell. */
  emptySince: number | null
  /** Powered state at the previous poll, to detect ON→OFF transitions. */
  wasPowered: boolean | null
  /** Last target seen while powered — the fallback setpoint when no schedule applies. */
  lastTarget: number | null
}

const freshState = (): SideState => ({ personSince: null, suppressed: false, emptySince: null, wasPowered: null, lastTarget: null })

const state: Record<Side, SideState> = { left: freshState(), right: freshState() }

let pollHandle: ReturnType<typeof setInterval> | null = null
const pendingPowerOns = new Set<Promise<void>>()
const powerOnInFlight = new Set<Side>()

// ---------------------------------------------------------------------------
// Config / DB reads
// ---------------------------------------------------------------------------

interface SideConfig {
  enabled: boolean
  minutes: number
  start: string
  end: string
  awayMode: boolean
}

function getConfig(): Record<Side, SideConfig> {
  const defaults: SideConfig = { enabled: false, minutes: 5, start: '20:00', end: '08:00', awayMode: false }
  try {
    const rows = db.select().from(sideSettings).all()
    const pick = (side: Side): SideConfig => {
      const r = rows.find(x => x.side === side)
      if (!r) return defaults
      return { enabled: r.autoOnEnabled, minutes: r.autoOnMinutes, start: r.autoOnStart, end: r.autoOnEnd, awayMode: r.awayMode }
    }
    return { left: pick('left'), right: pick('right') }
  }
  catch {
    return { left: defaults, right: defaults }
  }
}

function getTimezone(): string {
  try {
    const [row] = db.select({ timezone: deviceSettings.timezone }).from(deviceSettings).limit(1).all()
    return row?.timezone ?? 'America/Los_Angeles'
  }
  catch {
    return 'America/Los_Angeles'
  }
}

function readPower(side: Side): { powered: boolean, target: number | null } {
  try {
    const [row] = db
      .select({ isPowered: deviceState.isPowered, target: deviceState.targetTemperature })
      .from(deviceState)
      .where(eq(deviceState.side, side))
      .limit(1)
      .all()
    return { powered: row?.isPowered ?? false, target: row?.target ?? null }
  }
  catch {
    return { powered: false, target: null }
  }
}

function hasActiveRunOnce(side: Side): boolean {
  try {
    const [row] = db
      .select({ id: runOnceSessions.id })
      .from(runOnceSessions)
      .where(and(eq(runOnceSessions.side, side), eq(runOnceSessions.status, 'active')))
      .limit(1)
      .all()
    return !!row
  }
  catch {
    return false
  }
}

type Presence = 'person' | 'other' | 'unsensable'

/** 'person' = a person is in bed; 'other' = empty or a light load (pet); 'unsensable' = can't tell. */
function presence(side: Side): Presence {
  try {
    const occ = getOccupancy(side)
    if (!occ.available) return 'unsensable'
    return occ.classification === 'person' ? 'person' : 'other'
  }
  catch {
    return 'unsensable'
  }
}

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

function parseHm(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const minutes = Number(m[1]) * 60 + Number(m[2])
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null
}

/** Minutes since local midnight in `timezone`; falls back to UTC on a bad zone. */
export function localMinutes(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .formatToParts(now)
    const hour = Number(parts.find(p => p.type === 'hour')?.value)
    const minute = Number(parts.find(p => p.type === 'minute')?.value)
    if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute
  }
  catch {
    // fall through to UTC
  }
  return now.getUTCHours() * 60 + now.getUTCMinutes()
}

/** Half-open [start, end) window in minutes-of-day, wrapping midnight. Equal = always. */
export function inWindow(nowMinutes: number, start: string, end: string): boolean {
  const s = parseHm(start)
  const e = parseHm(end)
  if (s === null || e === null) return false
  if (s === e) return true
  return s < e ? nowMinutes >= s && nowMinutes < e : nowMinutes >= s || nowMinutes < e
}

// ---------------------------------------------------------------------------
// Power on
// ---------------------------------------------------------------------------

function isStillEligible(side: Side, cfg: SideConfig): boolean {
  if (!cfg.enabled || cfg.awayMode) return false
  if (readPower(side).powered || hasActiveRunOnce(side)) return false
  if (state[side].suppressed) return false
  if (!inWindow(localMinutes(new Date(), getTimezone()), cfg.start, cfg.end)) return false
  return presence(side) === 'person'
}

async function powerOnSide(side: Side, cfg: SideConfig): Promise<void> {
  try {
    await withSideLock(side, async () => {
      if (!isStillEligible(side, cfg)) {
        console.log(`[auto-on] ${side}: power-on skipped, no longer eligible`)
        return
      }
      if (pumpStallShouldBlock(side)) {
        console.warn(`[auto-on] ${side}: skipped, pump stall guard blocks the side`)
        return
      }
      markSideMutated(side)
      try {
        // An explicit power-on after an alarm must drop the alarm's held
        // shutdown, exactly as the scheduler's own power-on paths do.
        (await getJobManager()).releaseHeldPowerOff(side)
      }
      catch (e) {
        console.warn(`[auto-on] ${side}: could not release a held power-off:`, e instanceof Error ? e.message : e)
      }
      const client = getSharedHardwareClient()
      await client.connect()
      const fallback = state[side].lastTarget ?? DEFAULT_FALLBACK_TEMP_F
      const status = await getTemperatureController().powerOnLocked(side, fallback)
      cancelAutoOffTimer(side)
      broadcastMutationStatus(side, {})
      console.log(`[auto-on] Powered on ${side} side (person in bed ${cfg.minutes}min) → ${status.targetTemperature ?? fallback}°F`)
    })
  }
  catch (error) {
    console.error(`[auto-on] Failed to power on ${side}:`, error instanceof Error ? error.message : error)
  }
}

function firePowerOn(side: Side, cfg: SideConfig): void {
  powerOnInFlight.add(side)
  const p = powerOnSide(side, cfg).finally(() => {
    state[side].personSince = null
    powerOnInFlight.delete(side)
    pendingPowerOns.delete(p)
  })
  pendingPowerOns.add(p)
}

// ---------------------------------------------------------------------------
// Core poll logic
// ---------------------------------------------------------------------------

function evaluateSide(side: Side, cfg: SideConfig, timezone: string): void {
  const st = state[side]
  const now = Date.now()
  const { powered, target } = readPower(side)
  const who = presence(side)

  // Track ON→OFF transitions regardless of whether the feature is enabled, so
  // enabling it right after a manual off doesn't fire into a bed just vacated
  // on purpose.
  if (powered) {
    if (target !== null) st.lastTarget = target
    st.personSince = null
    st.emptySince = null
    if (st.suppressed) {
      st.suppressed = false
      console.log(`[auto-on] ${side}: side powered, suppression cleared`)
    }
    st.wasPowered = true
    return
  }
  if (st.wasPowered === true && who === 'person') {
    st.suppressed = true
    st.emptySince = null
    console.log(`[auto-on] ${side}: turned off with a person in bed, standing down until the bed clears`)
  }
  st.wasPowered = false

  if (!cfg.enabled || cfg.awayMode) {
    st.personSince = null
    return
  }

  if (powerOnInFlight.has(side)) return

  if (who === 'unsensable') {
    st.personSince = null
    return
  }

  if (who === 'other') {
    st.personSince = null
    if (st.suppressed) {
      st.emptySince ??= now
      if (now - st.emptySince >= cfg.minutes * 60_000) {
        st.suppressed = false
        st.emptySince = null
        console.log(`[auto-on] ${side}: bed clear for ${cfg.minutes}min, re-armed`)
      }
    }
    return
  }

  // who === 'person'
  st.emptySince = null
  if (st.suppressed) return
  if (hasActiveRunOnce(side)) {
    st.personSince = null
    return
  }
  if (!inWindow(localMinutes(new Date(now), timezone), cfg.start, cfg.end)) {
    st.personSince = null
    return
  }
  if (st.personSince === null) {
    st.personSince = now
    console.log(`[auto-on] ${side}: person in bed, auto-on in ${cfg.minutes}min if still present`)
    return
  }
  if (now - st.personSince >= cfg.minutes * 60_000) {
    console.log(`[auto-on] ${side}: person present for ${Math.round((now - st.personSince) / 1000)}s (past ${cfg.minutes}min dwell), powering on`)
    firePowerOn(side, cfg)
  }
}

function poll(): void {
  const config = getConfig()
  const timezone = getTimezone()
  for (const side of SIDES) {
    try {
      evaluateSide(side, config[side], timezone)
    }
    catch (error) {
      console.error(`[auto-on] Error evaluating ${side}:`, error instanceof Error ? error.message : error)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startAutoOnWatcher(): void {
  if (pollHandle) return
  console.log('[auto-on] Watcher started (poll every 30s)')
  poll()
  pollHandle = setInterval(poll, POLL_INTERVAL_MS)
}

export async function stopAutoOnWatcher(): Promise<void> {
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  for (const side of SIDES) state[side] = freshState()
  if (pendingPowerOns.size > 0) {
    console.log(`[auto-on] Waiting for ${pendingPowerOns.size} in-flight power-on(s)...`)
    await Promise.allSettled([...pendingPowerOns])
  }
  console.log('[auto-on] Watcher stopped')
}

/**
 * Re-evaluate after a settings change. Resets the dwell countdown (a changed
 * window or dwell starts clean) but keeps suppression and the last target.
 */
export function restartAutoOnWatcher(): void {
  if (!pollHandle) return
  for (const side of SIDES) {
    state[side].personSince = null
    state[side].emptySince = null
  }
  poll()
}
