'use client'

import type { PointerEvent } from 'react'
import { dropHolds, stepPath } from '@/src/components/Schedule/CurveChart'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import { STAGE, STAGE_SIDES, formatStageTemp } from './stageColors'
import type { StageSide } from './stageColors'
import { clock, fractionOf, formatUntil, hourLabel, nextChange, stageRange, stageTicks, timeAtFraction } from './stageTimelineLogic'
import type { StageCurves, StageWindow } from './stageTimelineLogic'

const VB_W = 1000
const CURVE_COLOR: Record<StageSide, string> = { left: STAGE.text, right: STAGE.text2 }

export interface StageTimelineProps {
  win: StageWindow
  now: number
  curves: StageCurves
  names: Record<StageSide, string>
  unit: TempUnit
  display: TempDisplay
  /** The moment being previewed, or null while live. */
  previewAt: number | null
  onScrub: (t: number) => void
  loading?: boolean
}

function yPct(temperature: number, range: { lo: number, hi: number }): number {
  const pad = 10
  return pad + (1 - (temperature - range.lo) / (range.hi - range.lo)) * (100 - pad * 2)
}

/**
 * Tonight, 6 PM to 9 AM: both schedule curves (left white, right grey), a now marker,
 * and a scrub anywhere on the lane that previews the bed at that hour. The preview
 * stays until Back to live.
 */
export function StageTimeline({ win, now, curves, names, unit, display, previewAt, onScrub, loading }: StageTimelineProps) {
  const range = stageRange(curves)
  const ticks = stageTicks(win)
  const next = nextChange(curves, now)
  const pct = (t: number) => fractionOf(win, t) * 100
  const X = (t: number) => fractionOf(win, t) * VB_W

  const scrubFrom = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    onScrub(timeAtFraction(win, (event.clientX - rect.left) / rect.width))
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    scrubFrom(event)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons & 1) scrubFrom(event)
  }

  return (
    <div className="flex h-full flex-col gap-2 px-6 pt-3" data-testid="stage-timeline">
      <div className="flex items-baseline gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-[#8b8b92]">
        <span>Tonight</span>
        {!range && !loading && <span className="text-[#5d5d63]">no schedule</span>}
        {next && (
          <span className="ml-auto normal-case tracking-normal" data-testid="stage-next">
            {`next · ${names[next.side]} ${formatStageTemp(next.temperatureF, unit, display)} in ${formatUntil(next.at - now)}`}
          </span>
        )}
      </div>
      <div
        role="slider"
        aria-label="Preview tonight's schedule"
        aria-valuemin={win.start}
        aria-valuemax={win.end}
        aria-valuenow={previewAt ?? now}
        aria-valuetext={clock(previewAt ?? now)}
        tabIndex={-1}
        data-testid="stage-lane"
        className="relative min-h-0 flex-1 cursor-ew-resize touch-none select-none rounded-xl border"
        style={{ borderColor: STAGE.line, background: 'rgba(15,15,17,0.7)' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        <div aria-hidden className="pointer-events-none absolute inset-y-0 inset-x-0">
          {ticks.map(t => <span key={t} className="absolute inset-y-0 border-l" style={{ left: `${pct(t)}%`, borderColor: '#16161a' }} />)}
        </div>
        {range && (
          <svg viewBox={`0 0 ${VB_W} 100`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
            {STAGE_SIDES.map((side) => {
              const pts = dropHolds(curves[side])
              if (pts.length < 2) return null
              const coords = pts.map(p => ({ x: X(p.at), y: yPct(p.temperature, range) }))
              const path = stepPath(coords)
              return (
                <g key={side} data-testid={`stage-curve-${side}`}>
                  <path d={`${path} L${coords[coords.length - 1].x},100 L${coords[0].x},100 Z`} fill={CURVE_COLOR[side]} fillOpacity={side === 'left' ? 0.05 : 0.03} />
                  <path d={path} fill="none" stroke={CURVE_COLOR[side]} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeOpacity={side === 'left' ? 0.9 : 0.7} />
                </g>
              )
            })}
          </svg>
        )}
        <div aria-hidden data-testid="stage-now" className="pointer-events-none absolute inset-y-0 border-l" style={{ left: `${pct(now)}%`, borderColor: 'rgba(236,236,236,0.45)' }}>
          <span className="absolute top-1.5 left-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 font-mono text-[10px]" style={{ color: STAGE.text2, background: 'rgba(11,11,12,0.8)' }}>{`now ${clock(now)}`}</span>
        </div>
        {previewAt != null && (
          <div aria-hidden data-testid="stage-preview-marker" className="pointer-events-none absolute inset-y-0 border-l" style={{ left: `${pct(previewAt)}%`, borderColor: STAGE.preview }}>
            <span
              className={`absolute top-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 font-mono text-[10px] text-[#0b0b0c] ${pct(previewAt) > 85 ? 'right-1.5' : 'left-1.5'}`}
              style={{ background: STAGE.preview }}
            >
              {clock(previewAt)}
            </span>
          </div>
        )}
      </div>
      <div className="relative h-4 font-mono text-[10px] text-[#5d5d63]" aria-hidden>
        {ticks.map((t, i) => (
          <span
            key={t}
            className="absolute top-0 whitespace-nowrap"
            style={{ left: `${pct(t)}%`, transform: i === 0 ? undefined : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
          >
            {hourLabel(t)}
          </span>
        ))}
      </div>
    </div>
  )
}
