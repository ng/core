'use client'

import { useMemo, useState } from 'react'
import { ChevronRight, Calendar } from 'lucide-react'
import clsx from 'clsx'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { groupDaysBySharedCurve } from '@/src/lib/scheduleGrouping'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'
import type { DayOfWeek } from './DaySelector'
import { DAYS } from './DaySelector'
import { colorForTempF } from '@/src/lib/sleepCurve/tempColor'
import { formatTime12h } from './TimeInput'

/** Short labels keyed by DayOfWeek */
const DAY_SHORT: Record<DayOfWeek, string> = {
  sunday: 'Sun',
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
}

interface ScheduleWeekOverviewProps {
  /** Called when the user taps a group to select those days for editing */
  onSelectDays?: (days: DayOfWeek[]) => void
}

/**
 * Schedule Week Overview - groups days by shared temperature curve.
 *
 * Each group shows:
 * - Day pills highlighting which days use this curve
 * - Mini SVG sparkline preview of the temperature set points
 * - Number of set points or "No schedule" label
 *
 * Tapping a group selects those days for editing.
 * The section is collapsible and hidden by default.
 */
export function ScheduleWeekOverview({ onSelectDays }: ScheduleWeekOverviewProps) {
  const { side } = useSide()
  const [expanded, setExpanded] = useState(false)

  const { data, isLoading } = trpc.schedules.getAll.useQuery({ side })

  const groups = useMemo<ScheduleGroup[]>(() => {
    if (!data?.temperature) return []
    return groupDaysBySharedCurve(data.temperature)
  }, [data?.temperature])

  // Don't render anything if there are no schedules at all
  const hasAnySetPoints = groups.some(g => g.setPoints.length > 0)
  if (!isLoading && !hasAnySetPoints) return null

  if (isLoading) {
    return (
      <div className="h-12 animate-pulse rounded-2xl bg-zinc-900" />
    )
  }

  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2"
      >
        <Calendar size={16} className="text-zinc-500" />
        <span className="text-sm font-medium text-zinc-400">Week Overview</span>
        <span className="ml-auto text-[10px] text-zinc-600">
          {groups.filter(g => g.setPoints.length > 0).length}
          {' '}
          {groups.filter(g => g.setPoints.length > 0).length === 1 ? 'curve' : 'curves'}
        </span>
        <ChevronRight
          size={14}
          className={clsx(
            'text-zinc-600 transition-transform duration-200',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-3 space-y-2">
          {groups.map(group => (
            <GroupCard
              key={group.key}
              group={group}
              onTap={onSelectDays ? () => onSelectDays(group.days) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Group Card ──────────────────────────────────────────────────────

interface GroupCardProps {
  group: ScheduleGroup
  onTap?: () => void
}

function GroupCard({ group, onTap }: GroupCardProps) {
  const hasSetPoints = group.setPoints.length > 0

  return (
    <button
      onClick={onTap}
      disabled={!onTap}
      className={clsx(
        'w-full rounded-xl border p-2.5 text-left transition-colors sm:p-3',
        hasSetPoints
          ? 'border-zinc-800 bg-zinc-800/50 active:border-sky-500/40'
          : 'border-zinc-800/50 bg-zinc-900/50',
        onTap && 'cursor-pointer',
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* Day pills */}
        <div className="flex flex-wrap gap-1">
          {DAYS.map(({ key, label }) => {
            const isInGroup = group.days.includes(key)
            return (
              <span
                key={key}
                className={clsx(
                  'inline-flex h-6 min-w-[2rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold transition-colors',
                  isInGroup
                    ? hasSetPoints
                      ? 'bg-sky-500/20 text-sky-400'
                      : 'bg-zinc-700/50 text-zinc-500'
                    : 'bg-transparent text-zinc-700',
                )}
              >
                {DAY_SHORT[key]}
              </span>
            )
          })}
        </div>

        {/* Set point count / label */}
        <span className="ml-auto shrink-0 text-[10px] text-zinc-500">
          {hasSetPoints
            ? `${group.setPoints.length} set ${group.setPoints.length === 1 ? 'point' : 'points'}`
            : 'No schedule'}
        </span>
      </div>

      {/* Mini curve sparkline */}
      {hasSetPoints && (
        <div className="mt-2">
          <MiniCurve setPoints={group.setPoints} />
        </div>
      )}
    </button>
  )
}

// ── Mini Curve Sparkline ────────────────────────────────────────────

interface MiniCurveProps {
  setPoints: Array<{ time: string, temperature: number }>
}

/**
 * Simplified SVG sparkline showing temperature set points.
 * No axes, no tooltips — just a colored polyline with dots.
 */
function MiniCurve({ setPoints }: MiniCurveProps) {
  const width = 260
  const height = 36
  const padX = 6
  const padY = 4

  const data = useMemo(() => {
    if (setPoints.length === 0) return { points: '', dots: [] as Array<{ cx: number, cy: number, color: string, label: string }> }

    // Convert times to minutes for positioning
    const withMinutes = setPoints.map(p => {
      const [h, m] = p.time.split(':').map(Number)
      return { ...p, minutes: h * 60 + m }
    })

    const minTime = Math.min(...withMinutes.map(p => p.minutes))
    const maxTime = Math.max(...withMinutes.map(p => p.minutes))
    const minTemp = Math.min(...withMinutes.map(p => p.temperature))
    const maxTemp = Math.max(...withMinutes.map(p => p.temperature))
    const timeRange = maxTime - minTime || 1
    const tempRange = maxTemp - minTemp || 1

    const innerW = width - padX * 2
    const innerH = height - padY * 2

    const mapped = withMinutes.map(p => ({
      x: padX + ((p.minutes - minTime) / timeRange) * innerW,
      y: padY + (1 - (p.temperature - minTemp) / tempRange) * innerH,
      temp: p.temperature,
      time: p.time,
    }))

    const pointsStr = mapped.map(p => `${p.x},${p.y}`).join(' ')
    const dots = mapped.map(p => ({
      cx: p.x,
      cy: p.y,
      color: colorForTempF(p.temp),
      label: `${formatTime12h(p.time)} ${p.temp}\u00B0`,
    }))

    return { points: pointsStr, dots }
  }, [setPoints])

  if (data.dots.length === 0) return null

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height: 36 }}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Polyline */}
      <polyline
        points={data.points}
        fill="none"
        stroke="#52525b"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Dots */}
      {data.dots.map((dot, i) => (
        <circle
          key={i}
          cx={dot.cx}
          cy={dot.cy}
          r={2.5}
          fill={dot.color}
        />
      ))}
    </svg>
  )
}
