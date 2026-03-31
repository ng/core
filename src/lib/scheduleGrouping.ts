import type { DayOfWeek } from '@/src/components/Schedule/DaySelector'

export interface SetPoint {
  time: string
  temperature: number
}

export interface ScheduleGroup {
  /** Fingerprint string for this set of set points */
  key: string
  /** Days sharing this identical curve */
  days: DayOfWeek[]
  /** The shared set points (sorted by time), empty for "no schedule" */
  setPoints: SetPoint[]
}

const ALL_DAYS: DayOfWeek[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

/**
 * Build a deterministic fingerprint for a set of temperature set points.
 * Points are sorted by time then temperature so that ordering in the DB
 * doesn't affect grouping.
 */
function fingerprint(points: SetPoint[]): string {
  if (points.length === 0) return '__empty__'
  const sorted = [...points].sort((a, b) =>
    a.time.localeCompare(b.time) || a.temperature - b.temperature,
  )
  return sorted.map(p => `${p.time}@${p.temperature}`).join('|')
}

/**
 * Group the 7 days of the week by identical temperature set point lists.
 *
 * @param temperatureSchedules - all temperature schedules for one side (from getAll)
 * @returns groups sorted by number of days descending, then by earliest day
 */
export function groupDaysBySharedCurve(
  temperatureSchedules: Array<{
    dayOfWeek: string
    time: string
    temperature: number
    enabled: boolean
  }>,
): ScheduleGroup[] {
  // Collect set points per day (only enabled schedules)
  const dayMap = new Map<DayOfWeek, SetPoint[]>()
  for (const day of ALL_DAYS) {
    dayMap.set(day, [])
  }

  for (const s of temperatureSchedules) {
    if (!s.enabled) continue
    const existing = dayMap.get(s.dayOfWeek as DayOfWeek)
    if (existing) {
      existing.push({ time: s.time, temperature: s.temperature })
    }
  }

  // Group days by fingerprint
  const groups = new Map<string, { days: DayOfWeek[], setPoints: SetPoint[] }>()

  for (const day of ALL_DAYS) {
    const points = dayMap.get(day) ?? []
    const fp = fingerprint(points)
    const existing = groups.get(fp)
    if (existing) {
      existing.days.push(day)
    } else {
      // Store sorted set points for display
      const sorted = [...points].sort((a, b) => a.time.localeCompare(b.time))
      groups.set(fp, { days: [day], setPoints: sorted })
    }
  }

  // Convert to array and sort: most days first, then by earliest day index
  return Array.from(groups.entries())
    .map(([key, group]) => ({
      key,
      days: group.days,
      setPoints: group.setPoints,
    }))
    .sort((a, b) => {
      // Groups with set points before "no schedule" groups
      const aHas = a.setPoints.length > 0 ? 0 : 1
      const bHas = b.setPoints.length > 0 ? 0 : 1
      if (aHas !== bHas) return aHas - bHas
      // More days first
      if (b.days.length !== a.days.length) return b.days.length - a.days.length
      // Earliest day index as tiebreaker
      const aIdx = ALL_DAYS.indexOf(a.days[0])
      const bIdx = ALL_DAYS.indexOf(b.days[0])
      return aIdx - bIdx
    })
}
