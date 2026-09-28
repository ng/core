'use client'

import { Fragment, type MouseEvent } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Card, GhostIcon, StatusDot } from '@/src/components/ds'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'
import { sortChronological } from '@/src/lib/scheduleGrouping'
import { formatTime12h } from '@/src/lib/scheduleTime'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatSetpointF, setpointFToDisplay, type TempUnit } from '@/src/lib/tempUtils'
import { CurveChart, MiniCurve } from './CurveChart'
import { TONE_TEXT, formatDayRange, tempTone } from './scheduleFormat'

interface CurveCardProps {
  group: ScheduleGroup
  onEdit: () => void
  onDelete: () => void
  /** True when this curve covers today and the schedule is enabled */
  isActive?: boolean
  /** Next upcoming set point (only meaningful when isActive) */
  nextEvent?: { time: string, temperature: number } | null
  /** Large chart card (the curve running today) vs. compact list card. */
  featured?: boolean
}

/** "79–84°F" / "79–84°" — set-point range in the user's unit. */
export function formatTempRange(setPoints: Array<{ temperature: number }>, unit: TempUnit, withUnit = true): string {
  if (setPoints.length === 0) return ''
  const temps = setPoints.map(p => Math.round(setpointFToDisplay(p.temperature, unit) ?? p.temperature))
  const min = Math.min(...temps)
  const max = Math.max(...temps)
  const range = min === max ? `${min}` : `${min}–${max}`
  return `${range}°${withUnit ? unit : ''}`
}

/** "11:15 PM → 7:00 AM" from the chronologically first and last set points. */
export function formatWindow(setPoints: Array<{ time: string, temperature: number }>): string | null {
  if (setPoints.length < 2) return null
  const sorted = sortChronological(setPoints)
  return `${formatTime12h(sorted[0].time)} → ${formatTime12h(sorted[sorted.length - 1].time)}`
}

/**
 * Indexes of the set points shown in the 5-column strip: power on, three
 * in between (starting at the next upcoming point when there is one,
 * otherwise evenly spaced) and power off.
 */
export function stripIndexes(count: number, nextIndex = -1, max = 5): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i)
  const inner = max - 2
  const last = count - 1
  let middle: number[]
  if (nextIndex > 0 && nextIndex < last) {
    const start = Math.max(1, Math.min(nextIndex, last - inner))
    middle = Array.from({ length: inner }, (_, i) => start + i)
  }
  else {
    middle = Array.from({ length: inner }, (_, i) => Math.round(((i + 1) * last) / (inner + 1)))
  }
  return [0, ...middle, last]
}

function stop(fn: () => void) {
  return (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
}

export function CurveCard({ group, onEdit, onDelete, isActive = false, nextEvent = null, featured = false }: CurveCardProps) {
  const { unit } = useTemperatureUnit()
  const hasSetPoints = group.setPoints.length > 0
  const paused = !!group.allDisabled
  const label = formatDayRange(group.days)
  const sleepWindow = formatWindow(group.setPoints)
  const active = isActive && hasSetPoints && !paused

  const actions = (
    <div className="ml-auto flex items-center gap-1">
      <GhostIcon icon={Pencil} size={15} label={`Edit ${label}`} onClick={stop(onEdit)} />
      <GhostIcon icon={Trash2} size={15} label={`Delete ${label}`} className="text-fg-3" onClick={stop(onDelete)} />
    </div>
  )

  if (featured && hasSetPoints && !paused) {
    const sorted = sortChronological(group.setPoints)
    const nextIndex = active && nextEvent ? sorted.findIndex(sp => formatTime12h(sp.time) === nextEvent.time) : -1
    const strip = stripIndexes(sorted.length, nextIndex)
    const meta = [sleepWindow, formatTempRange(group.setPoints, unit)].filter(Boolean).join(' · ')
    return (
      <Card
        highlight={active}
        className="gap-2 px-4 py-3.5 min-[900px]:gap-3.5 min-[900px]:p-5"
        data-testid="curve-card-featured"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[15px] font-medium min-[900px]:text-base">{label}</span>
          {active && (
            <>
              <Badge variant="active" className="hidden min-[900px]:inline-flex" />
              <StatusDot tone="ok" size={5} mono label="ACTIVE" className="text-[10px] min-[900px]:hidden" />
            </>
          )}
          <span className="hidden font-mono text-xs text-fg-2 min-[900px]:inline">{meta}</span>
          {actions}
        </div>

        {/* Desktop: full chart + set-point strip */}
        <div className="hidden flex-col gap-3.5 min-[900px]:flex">
          <CurveChart setPoints={group.setPoints} height={220} showNow={active} />
          <div className="grid grid-cols-5 gap-2 border-t border-line pt-3.5">
            {strip.map((i) => {
              const sp = sorted[i]
              const isOff = sorted.length > 1 && i === sorted.length - 1
              const isNext = i === nextIndex
              const caption = i === 0 ? 'Power on' : isOff ? 'Power off' : isNext ? 'Next' : null
              return (
                <div key={`${sp.time}-${i}`} className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[11px] text-fg-2">{formatTime12h(sp.time)}</span>
                  <span className={cn('font-mono text-lg', isOff ? 'text-fg-2' : TONE_TEXT[tempTone(sp.temperature)])}>
                    {isOff ? 'Off' : formatSetpointF(sp.temperature, unit, { includeUnit: false })}
                  </span>
                  {caption && <span className="text-xs text-fg-2">{caption}</span>}
                </div>
              )
            })}
          </div>
        </div>

        {/* Phone: sparkline + next set point */}
        <div className="flex flex-col gap-2 min-[900px]:hidden">
          <MiniCurve setPoints={group.setPoints} height={44} />
          <span className="font-mono text-xs text-fg-2">{meta}</span>
          {active && nextEvent && (
            <span className="border-t border-line pt-2 font-mono text-xs text-fg-2">
              Next
              {' '}
              <span className="text-ok">{nextEvent.time}</span>
              {' · '}
              <span className="text-fg">{formatSetpointF(nextEvent.temperature, unit, { includeUnit: false })}</span>
            </span>
          )}
        </div>
      </Card>
    )
  }

  return (
    <Card
      flat
      dashed={paused}
      tone={paused ? 'warn' : undefined}
      onClick={onEdit}
      className="gap-2 px-4 py-3.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[15px] font-medium min-[900px]:text-sm">{label}</span>
        {paused && <Badge variant="paused" />}
        {actions}
      </div>
      {paused
        ? (
            <div className="flex items-center text-xs text-fg-3 min-[900px]:h-8">No set points active</div>
          )
        : hasSetPoints && <MiniCurve setPoints={group.setPoints} className="hidden min-[900px]:block" />}
      <span className="font-mono text-xs text-fg-2">
        {paused
          ? 'Schedule paused'
          : [sleepWindow, formatTempRange(group.setPoints, unit, false)].filter(Boolean).map((part, i) => (
              <Fragment key={i}>
                {i > 0 && ' · '}
                <span className="whitespace-nowrap">{part}</span>
              </Fragment>
            ))}
      </span>
    </Card>
  )
}
