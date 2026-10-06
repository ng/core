import type { BedTempFrame, BedTemp2Frame } from '@/src/hooks/useSensorStream'

export type ThermalView = 'overview' | 'regions'
export const meanTemperature = (zones: Zones): number | null => {
  const values = zones.filter((value): value is number => value !== null && Number.isFinite(value))
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

export type ThermalSide = 'left' | 'right'
export type Zones = [number | null, number | null, number | null]
export interface ThermalReading {
  ts: number
  left: Zones
  right: Zones
  source: 'live' | 'stored'
}
export interface ThermalControl {
  currentTemperature: number | null
  targetTemperature: number | null
  targetLevel: number
}
export interface ThermalState {
  zones: Zones
  direction: -1 | 0 | 1
  strength: number
}
export const THERMAL_STALE_SECONDS = 90
export const finiteTemperature = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) ? value : null

interface StoredReading {
  timestamp: Date
  leftOuterTemp: number | null
  leftCenterTemp: number | null
  leftInnerTemp: number | null
  rightOuterTemp: number | null
  rightCenterTemp: number | null
  rightInnerTemp: number | null
}

/** Both transports are requested in Celsius. Newest timestamp wins, including across generations. */
export function latestThermalReading(oldFrame?: BedTempFrame, newFrame?: BedTemp2Frame, stored?: StoredReading | null): ThermalReading | null {
  const candidates: ThermalReading[] = []
  for (const frame of [oldFrame, newFrame, stored]) {
    if (!frame) continue
    const ts = 'ts' in frame ? frame.ts : frame.timestamp.getTime() / 1000
    if (!Number.isFinite(ts)) continue
    candidates.push({
      ts,
      left: [finiteTemperature(frame.leftOuterTemp), finiteTemperature(frame.leftCenterTemp), finiteTemperature(frame.leftInnerTemp)],
      right: [finiteTemperature(frame.rightOuterTemp), finiteTemperature(frame.rightCenterTemp), finiteTemperature(frame.rightInnerTemp)],
      source: 'ts' in frame ? 'live' : 'stored',
    })
  }
  return candidates.sort((a, b) => b.ts - a.ts)[0] ?? null
}

/** Direction describes the requested change, not a claim that water is flowing. */
export function thermalState(zones: Zones, control: ThermalControl | undefined, stale: boolean, blocked = false): ThermalState {
  const current = finiteTemperature(control?.currentTemperature)
  const target = finiteTemperature(control?.targetTemperature)
  const delta = !stale && !blocked && control?.targetLevel && current !== null && target !== null ? target - current : 0
  const direction = delta > 0.5 ? 1 : delta < -0.5 ? -1 : 0
  return { zones: stale ? [null, null, null] : zones, direction, strength: direction ? Math.min(Math.abs(delta) / 8, 1) : 0 }
}

/** Fixed 18–36°C scale; never recolor an unchanged sensor when its neighbour changes. */
export function thermalColor(celsius: number | null): string {
  if (finiteTemperature(celsius) === null) return '#626875'
  const t = Math.max(0, Math.min(1, ((celsius as number) - 18) / 18))
  const cool = [54, 139, 230]
  const neutral = [139, 160, 177]
  const warm = [245, 113, 92]
  const a = t < 0.5 ? cool : neutral
  const b = t < 0.5 ? neutral : warm
  const blend = t < 0.5 ? t * 2 : (t - 0.5) * 2
  return `#${a.map((value, i) => Math.round(value + (b[i] - value) * blend).toString(16).padStart(2, '0')).join('')}`
}
