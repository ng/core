'use client'

import { forwardRef } from 'react'
import type { CSSProperties } from 'react'
import { STAGE } from './stageColors'
import type { SideStatus } from './stageColors'

/**
 * Labels float on their own compositing layer; the scene sets `transform` every frame
 * from a projected 3D point, so nothing here declares one.
 */
const LAYER: CSSProperties = { position: 'absolute', left: 0, top: 0, zIndex: 5, willChange: 'transform', pointerEvents: 'none' }

export interface SideLabelProps {
  name: string
  /** The big number, already formatted. */
  temperature: string
  color: string
  status: SideStatus
  inBed: boolean
  selected: boolean
  hovered: boolean
  hidden?: boolean
  testId: string
}

/** A side's pill (presence dot, name, temperature, activity ring), its status word and a short leader down to the bed. */
export const SideLabel = forwardRef<HTMLDivElement, SideLabelProps>(function SideLabel({ name, temperature, color, status, inBed, selected, hovered, hidden, testId }, ref) {
  const busy = status.word === 'COOLING' || status.word === 'WARMING'
  const border = selected ? STAGE.text : hovered ? STAGE.text3 : STAGE.frame
  return (
    <div ref={ref} data-testid={testId} style={{ ...LAYER, display: hidden ? 'none' : 'flex', transition: 'transform 120ms var(--ease-standard)' }} className="flex-col items-center">
      <div
        className="flex items-center gap-2.5 rounded-full border px-3.5 py-2 transition-colors"
        style={{ background: 'rgba(11,11,12,0.86)', borderColor: border }}
      >
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: inBed ? STAGE.live : STAGE.dotOff }} />
        <span className="text-[13px] font-medium text-[#ececec]">{name}</span>
        <span className="font-mono text-[22px] leading-none tabular-nums" style={{ color }} data-testid={`${testId}-temp`}>{temperature}</span>
        {busy && <span aria-hidden className="stage-ring" style={{ color: status.color }} />}
      </div>
      <span className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: status.color }} data-testid={`${testId}-status`}>{status.text}</span>
      <span aria-hidden className="mt-1 block h-7 w-px" style={{ background: 'rgba(236,236,236,0.35)' }} />
    </div>
  )
})

export interface ZoneLabelProps {
  zone: string
  value: string
  color: string
  testId: string
}

/** OUTER / CENTER / INNER readout beside the bed: a dot in the reading's colour, the name and the value to a tenth. */
export const ZoneLabel = forwardRef<HTMLDivElement, ZoneLabelProps>(function ZoneLabel({ zone, value, color, testId }, ref) {
  return (
    <div ref={ref} data-testid={testId} data-stage-zone={zone} style={{ ...LAYER, opacity: 0 }} className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.1em] text-[#8b8b92]">
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
      <span>{zone}</span>
      <span className="text-[#ececec] tabular-nums">{value}</span>
    </div>
  )
})
